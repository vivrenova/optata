"""Pin tech-spec §4.1: the owner must never learn an item is reserved —
not logged in, and NOT LOGGED OUT either. A logged-out owner is
indistinguishable from a stranger, so anonymous viewers get no
reservation fields at all (three-way schema split).

The single most important tests in this codebase. Everything goes through
the real endpoints — item created via POST /items, reserved via
POST /items/{id}/reserve — and every assertion is on KEY ABSENCE, not on
values, so it fails loudly the moment someone unifies the schemas.
"""

from httpx import AsyncClient

from tests.helpers import create_item, register


class TestReservationNeverLeaksToOwner:
    async def test_payload_shapes_for_owner_guest_and_anonymous(
        self, client: AsyncClient, unique: str
    ):
        owner_name = f"owner_{unique}"
        _, owner_auth = await register(client, owner_name)
        item = await create_item(client, owner_auth, title="Film camera")
        _, guest_auth = await register(client, f"guest_{unique}")

        r = await client.post(f"/items/{item['id']}/reserve", headers=guest_auth)
        assert r.status_code == 201

        profile_url = f"/users/{owner_name}"

        # the reserving guest: reservation state, never view_count
        r = await client.get(profile_url, headers=guest_auth)
        assert r.status_code == 200
        guest_item = r.json()["items"][0]
        assert "view_count" not in guest_item
        assert guest_item["is_reserved"] is True
        assert guest_item["reserved_by_me"] is True

        # anonymous: item facts ONLY — no reservation keys, no view_count.
        # An anonymous viewer can't reserve anyway; the field would only
        # ever spoil an owner browsing logged-out.
        r = await client.get(profile_url)
        anon_item = r.json()["items"][0]
        assert "view_count" not in anon_item
        assert "is_reserved" not in anon_item
        assert "reserved_by_me" not in anon_item

        # THE OWNER OF A RESERVED ITEM: no reservation key exists at all
        r = await client.get(profile_url, headers=owner_auth)
        assert r.status_code == 200
        body = r.json()
        assert body["is_owner"] is True
        owner_item = body["items"][0]
        assert "is_reserved" not in owner_item
        assert "reserved_by_me" not in owner_item
        assert owner_item["view_count"] == 0

    async def test_logged_out_owner_learns_nothing_about_reservations(
        self, client: AsyncClient, unique: str
    ):
        # THE product invariant. "Let me see how my wishlist looks to other
        # people" is the most natural thing an owner will ever do — they log
        # out or open an incognito window and load their own profile. The
        # server cannot tell them from a stranger, so the anonymous payload
        # must carry nothing a stranger shouldn't have and nothing the owner
        # must not see.
        owner_name = f"peek_{unique}"
        _, owner_auth = await register(client, owner_name)
        item = await create_item(client, owner_auth, title="Surprise gift")
        _, guest_auth = await register(client, f"gifter_{unique}")

        r = await client.post(f"/items/{item['id']}/reserve", headers=guest_auth)
        assert r.status_code == 201

        # the owner, with NO token at all, on their own profile
        r = await client.get(f"/users/{owner_name}")
        assert r.status_code == 200
        body = r.json()
        assert body["is_owner"] is False
        assert len(body["items"]) == 1
        for item_payload in body["items"]:
            assert "is_reserved" not in item_payload
            assert "reserved_by_me" not in item_payload
            assert "view_count" not in item_payload

    async def test_create_and_patch_responses_carry_no_reservation_keys(
        self, client: AsyncClient, unique: str
    ):
        # The owner's OTHER windows into an item — create and edit responses —
        # must be equally blind, even while the item is reserved.
        _, owner_auth = await register(client, f"owner2_{unique}")
        created = await create_item(client, owner_auth)
        assert "is_reserved" not in created and "reserved_by_me" not in created

        _, guest_auth = await register(client, f"guest2_{unique}")
        await client.post(f"/items/{created['id']}/reserve", headers=guest_auth)

        r = await client.patch(
            f"/items/{created['id']}", headers=owner_auth, data={"title": "Still blind"}
        )
        patched = r.json()
        assert "is_reserved" not in patched
        assert "reserved_by_me" not in patched
        assert "view_count" in patched
