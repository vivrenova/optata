import io
import re
import struct
import uuid
import zlib

import piexif
import pytest
from httpx import AsyncClient
from PIL import Image, ImageFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.images import reencode_webp
from app.models import Item
from app.rate_limit import limiter
from app.routers.items import MAX_IMAGE_BYTES
from tests.helpers import create_item, image_bytes, register


def stored_path(body: dict) -> str:
    """Extract the storage key from an item payload's public URL."""
    return body["image_url"].split("/object/public/items/", 1)[1]


def _png_chunk(typ: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + typ
        + data
        + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
    )


def bomb_png(width: int, height: int) -> bytes:
    """A tiny, VALID png header declaring enormous dimensions — the payload
    is a few hundred bytes, the decode would be gigabytes."""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(b"\x00" * 16))
        + _png_chunk(b"IEND", b"")
    )


class TestCreate:
    async def test_create_returns_owner_payload_and_uploads_webp(
        self, client: AsyncClient, unique: str, fake_storage
    ):
        user_id, auth = await register(client, f"maker_{unique}")
        body = await create_item(
            client, auth, title="Kettle", price="49.99", currency="uah", accent_color="#aB12cD"
        )

        assert body["title"] == "Kettle"
        assert body["currency"] == "UAH"
        assert body["accent_color"] == "#aB12cD"
        assert body["view_count"] == 0
        assert "is_reserved" not in body and "reserved_by_me" not in body

        # immutable keys: {user_id}/{item_id}/{uuid4}.webp
        path = stored_path(body)
        assert re.fullmatch(rf"{user_id}/{body['id']}/[0-9a-f-]{{36}}\.webp", path)
        stored = fake_storage.uploads[path]
        assert Image.open(io.BytesIO(stored)).format == "WEBP"

    async def test_41st_item_is_rejected(
        self, client: AsyncClient, unique: str, db_session: AsyncSession
    ):
        user_id, auth = await register(client, f"hoarder_{unique}")
        db_session.add_all(
            Item(
                user_id=user_id,
                title=f"Item {i}",
                image_url="https://example.com/x.webp",
                image_path=f"{user_id}/{uuid.uuid4()}.webp",
                order_index=i,
            )
            for i in range(40)
        )
        await db_session.commit()

        r = await client.post(
            "/items",
            headers=auth,
            files={"image": ("x.png", image_bytes(), "image/png")},
            data={"title": "One too many"},
        )
        assert r.status_code == 409
        assert r.json()["detail"] == "That's 40 of 40 — your list is full. Delete one to add another."

    async def test_image_over_limit_rejected(self, client: AsyncClient, unique: str):
        _, auth = await register(client, f"big_{unique}")
        r = await client.post(
            "/items",
            headers=auth,
            files={
                "image": ("big.png", b"\x89PNG" + b"\x00" * MAX_IMAGE_BYTES, "image/png")
            },
            data={"title": "Too big"},
        )
        assert r.status_code == 413
        assert "1024KB" in r.json()["detail"]

    async def test_image_between_old_and_new_limit_passes_the_size_gate(
        self, client: AsyncClient, unique: str
    ):
        """The limit was raised 500KB -> 1MB because browsers with no WebP
        encoder send JPEG. A 600KB upload must get past the size check; it
        still fails as junk bytes, but with 415, not 413."""
        _, auth = await register(client, f"mid_{unique}")
        r = await client.post(
            "/items",
            headers=auth,
            files={"image": ("mid.png", b"\x89PNG" + b"\x00" * (600 * 1024), "image/png")},
            data={"title": "Middling"},
        )
        assert r.status_code == 415

    async def test_wrong_content_type_and_polyglot_rejected(
        self, client: AsyncClient, unique: str
    ):
        _, auth = await register(client, f"poly_{unique}")
        r = await client.post(
            "/items",
            headers=auth,
            files={"image": ("x.txt", b"hello", "text/plain")},
            data={"title": "Nope"},
        )
        assert r.status_code == 415

        # right content-type, garbage bytes — Pillow must refuse it
        r = await client.post(
            "/items",
            headers=auth,
            files={"image": ("x.jpg", b"definitely not a jpeg", "image/jpeg")},
            data={"title": "Nope"},
        )
        assert r.status_code == 415

    async def test_invalid_accent_color_falls_back_to_default(
        self, client: AsyncClient, unique: str
    ):
        _, auth = await register(client, f"tint_{unique}")
        body = await create_item(client, auth, accent_color="magenta")
        assert body["accent_color"] == "#D6D6D1"

    async def test_price_without_currency_rejected(self, client: AsyncClient, unique: str):
        _, auth = await register(client, f"price_{unique}")
        r = await client.post(
            "/items",
            headers=auth,
            files={"image": ("x.png", image_bytes(), "image/png")},
            data={"title": "Half a price", "price": "10"},
        )
        assert r.status_code == 422

    async def test_upload_failure_does_not_leave_an_orphaned_row(
        self, client: AsyncClient, unique: str, fake_storage
    ):
        _, auth = await register(client, f"fail_{unique}")
        fake_storage.fail_uploads = True
        r = await client.post(
            "/items",
            headers=auth,
            files={"image": ("x.png", image_bytes(), "image/png")},
            data={"title": "Doomed"},
        )
        assert r.status_code == 502
        fake_storage.fail_uploads = False

        r = await client.get(f"/users/fail_{unique}", headers=auth)
        assert r.json()["items"] == []


class TestDecompressionBomb:
    def test_oversized_dimensions_rejected_before_any_decode(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        decoded: list[bool] = []
        original_load = ImageFile.ImageFile.load

        def spying_load(self):
            decoded.append(True)
            return original_load(self)

        monkeypatch.setattr(ImageFile.ImageFile, "load", spying_load)

        # 36MP: inside Pillow's warning band, above our 25MP budget —
        # must die on the explicit header check
        with pytest.raises(ValueError):
            reencode_webp(bomb_png(6000, 6000))
        # 400MP: Pillow's own backstop raises inside open()
        with pytest.raises(ValueError):
            reencode_webp(bomb_png(20000, 20000))

        assert not decoded, "a rejected bomb must never reach pixel decoding"

    async def test_bomb_via_api_is_415_not_500(self, client: AsyncClient, unique: str):
        _, auth = await register(client, f"bomb_{unique}")
        r = await client.post(
            "/items",
            headers=auth,
            files={"image": ("bomb.png", bomb_png(20000, 20000), "image/png")},
            data={"title": "Boom"},
        )
        assert r.status_code == 415


class TestExoticModes:
    """CMYK JPEGs, palette PNGs with transparency and 16-bit inputs must
    re-encode cleanly — a Pillow save error must never surface as a 500."""

    def _roundtrip(self, img: Image.Image, fmt: str, **save_kwargs) -> None:
        buf = io.BytesIO()
        img.save(buf, fmt, **save_kwargs)
        out = reencode_webp(buf.getvalue())
        assert Image.open(io.BytesIO(out)).format == "WEBP"

    def test_cmyk_jpeg(self):
        self._roundtrip(Image.new("CMYK", (32, 32), (10, 20, 30, 40)), "JPEG")

    def test_palette_png_with_transparency(self):
        img = Image.new("P", (32, 32), 3)
        img.putpalette([i % 256 for i in range(768)])
        self._roundtrip(img, "PNG", transparency=3)

    def test_16bit_grayscale_png(self):
        self._roundtrip(Image.new("I;16", (32, 32), 12000), "PNG")


class TestRateLimitWiring:
    def test_60_per_hour_is_attached_to_post_items(self):
        # Stage 1 pinned that the mechanism works; this pins that the
        # decorator is actually present on the endpoint. 60 > the 40-item
        # cap, so the 409 branch stays reachable within an hour.
        limits = limiter._route_limits["app.routers.items.create_item"]
        assert any("60 per 1 hour" in str(lim.limit) for lim in limits)


class TestExifStripping:
    async def test_jpeg_with_gps_comes_out_as_webp_with_no_exif(
        self, client: AsyncClient, unique: str, fake_storage
    ):
        # Build a JPEG that REALLY carries GPS EXIF
        gps = {
            piexif.GPSIFD.GPSLatitudeRef: b"N",
            piexif.GPSIFD.GPSLatitude: ((50, 1), (27, 1), (0, 1)),
            piexif.GPSIFD.GPSLongitudeRef: b"E",
            piexif.GPSIFD.GPSLongitude: ((30, 1), (31, 1), (0, 1)),
        }
        exif_bytes = piexif.dump({"GPS": gps})
        buf = io.BytesIO()
        Image.new("RGB", (64, 64), "#334455").save(buf, "JPEG", exif=exif_bytes)
        jpeg_with_gps = buf.getvalue()

        # sanity: the input actually contains GPS — otherwise this test proves nothing
        assert piexif.load(jpeg_with_gps)["GPS"], "test input must carry GPS EXIF"

        user_id, auth = await register(client, f"gps_{unique}")
        r = await client.post(
            "/items",
            headers=auth,
            files={"image": ("home.jpg", jpeg_with_gps, "image/jpeg")},
            data={"title": "Shot at home"},
        )
        assert r.status_code == 201

        stored = fake_storage.uploads[stored_path(r.json())]
        out = Image.open(io.BytesIO(stored))
        assert out.format == "WEBP"
        assert dict(out.getexif()) == {}, "EXIF must be gone"
        assert "exif" not in out.info, "no raw EXIF blob either"


class TestUpdateDelete:
    async def test_patch_updates_fields_and_clears_note(self, client: AsyncClient, unique: str):
        _, auth = await register(client, f"edit_{unique}")
        item = await create_item(client, auth, note="temporary note")

        r = await client.patch(
            f"/items/{item['id']}",
            headers=auth,
            data={"title": "Renamed", "note": "", "price": "5", "currency": "EUR"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["title"] == "Renamed"
        assert body["note"] is None
        assert body["currency"] == "EUR"

    async def test_patch_someone_elses_item_forbidden(self, client: AsyncClient, unique: str):
        _, owner_auth = await register(client, f"powner_{unique}")
        item = await create_item(client, owner_auth)
        _, intruder_auth = await register(client, f"pintr_{unique}")

        r = await client.patch(
            f"/items/{item['id']}", headers=intruder_auth, data={"title": "Mine now"}
        )
        assert r.status_code == 403

    async def test_delete_removes_storage_object_then_row(
        self, client: AsyncClient, unique: str, fake_storage
    ):
        user_id, auth = await register(client, f"del_{unique}")
        item = await create_item(client, auth)

        r = await client.delete(f"/items/{item['id']}", headers=auth)
        assert r.status_code == 204
        assert stored_path(item) in fake_storage.deletes

        r = await client.get(f"/users/del_{unique}", headers=auth)
        assert r.json()["items"] == []

    async def test_replacing_the_image_rotates_the_storage_key(
        self, client: AsyncClient, unique: str, fake_storage
    ):
        _, auth = await register(client, f"swap_{unique}")
        item = await create_item(client, auth)
        old_path = stored_path(item)

        r = await client.patch(
            f"/items/{item['id']}",
            headers=auth,
            files={"image": ("new.png", image_bytes(color="#112233"), "image/png")},
        )
        assert r.status_code == 200, r.text
        new_path = stored_path(r.json())

        # new key uploaded, row repointed, old object deleted — nothing stale
        assert new_path != old_path
        assert new_path in fake_storage.uploads
        assert old_path in fake_storage.deletes
        assert r.json()["image_url"].endswith(new_path)

    async def test_delete_survives_storage_failure(
        self, client: AsyncClient, unique: str, fake_storage
    ):
        _, auth = await register(client, f"delf_{unique}")
        item = await create_item(client, auth)

        fake_storage.fail_deletes = True
        r = await client.delete(f"/items/{item['id']}", headers=auth)
        assert r.status_code == 204, "an orphaned file is harmless, an orphaned row is not"

        r = await client.get(f"/users/delf_{unique}", headers=auth)
        assert r.json()["items"] == []


class TestReorder:
    async def test_full_reorder_persists(self, client: AsyncClient, unique: str):
        _, auth = await register(client, f"sort_{unique}")
        ids = [(await create_item(client, auth, title=f"Item {i}"))["id"] for i in range(3)]

        new_order = [ids[2], ids[0], ids[1]]
        r = await client.put("/items/reorder", headers=auth, json={"ordered_ids": new_order})
        assert r.status_code == 204

        r = await client.get(f"/users/sort_{unique}", headers=auth)
        assert [i["id"] for i in r.json()["items"]] == new_order

    async def test_partial_and_foreign_lists_rejected(self, client: AsyncClient, unique: str):
        _, auth = await register(client, f"badsort_{unique}")
        ids = [(await create_item(client, auth, title=f"Item {i}"))["id"] for i in range(2)]

        r = await client.put("/items/reorder", headers=auth, json={"ordered_ids": ids[:1]})
        assert r.status_code == 422

        foreign = [ids[0], str(uuid.uuid4())]
        r = await client.put("/items/reorder", headers=auth, json={"ordered_ids": foreign})
        assert r.status_code == 422

        duplicated = [ids[0], ids[0]]
        r = await client.put("/items/reorder", headers=auth, json={"ordered_ids": duplicated})
        assert r.status_code == 422
