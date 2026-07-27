from httpx import AsyncClient

from tests.helpers import image_bytes, register


class TestAvatar:
    async def test_upload_sets_avatar_and_replace_deletes_old(
        self, client: AsyncClient, unique: str, fake_storage
    ):
        user_id, auth = await register(client, f"ava_{unique}")

        r = await client.post(
            "/users/me/avatar",
            headers=auth,
            files={"image": ("me.png", image_bytes(), "image/png")},
        )
        assert r.status_code == 200, r.text
        first_url = r.json()["avatar_url"]
        assert f"{user_id}/avatar/" in first_url
        first_path = first_url.split("/object/public/items/", 1)[1]
        assert first_path in fake_storage.uploads

        # replacing rotates the key and deletes the old object
        r = await client.post(
            "/users/me/avatar",
            headers=auth,
            files={"image": ("me2.png", image_bytes(color="#224466"), "image/png")},
        )
        assert r.status_code == 200
        second_url = r.json()["avatar_url"]
        assert second_url != first_url
        assert first_path in fake_storage.deletes

        # the profile shows it publicly
        r = await client.get(f"/users/ava_{unique}")
        assert r.json()["avatar_url"] == second_url

    async def test_rejects_non_images_and_anonymous(self, client: AsyncClient, unique: str):
        _, auth = await register(client, f"avab_{unique}")
        r = await client.post(
            "/users/me/avatar",
            headers=auth,
            files={"image": ("x.txt", b"not an image", "text/plain")},
        )
        assert r.status_code == 415

        r = await client.post(
            "/users/me/avatar", files={"image": ("me.png", image_bytes(), "image/png")}
        )
        assert r.status_code == 401
