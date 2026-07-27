from httpx import AsyncClient

PASSWORD = "correct-horse-battery"


async def register(client: AsyncClient, unique: str, *, username: str | None = None, email: str | None = None):
    return await client.post(
        "/auth/register",
        json={
            "email": email or f"user_{unique}@example.com",
            "username": username or f"user_{unique}",
            "password": PASSWORD,
        },
    )


def refresh_cookie_value(response) -> str:
    assert "refresh_token" in response.cookies, "expected a refresh_token cookie"
    return response.cookies["refresh_token"]


class TestHappyPath:
    async def test_register_login_refresh_logout(self, client: AsyncClient, unique: str):
        # register
        r = await client.post(
            "/auth/register",
            json={"email": f"user_{unique}@example.com", "username": f"user_{unique}", "password": PASSWORD},
        )
        assert r.status_code == 201
        body = r.json()
        assert body["access_token"]
        assert body["user"]["username"] == f"user_{unique}"
        set_cookie = r.headers["set-cookie"]
        assert "HttpOnly" in set_cookie and "Path=/auth" in set_cookie

        # bearer works
        me = await client.get("/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
        assert me.status_code == 200
        assert me.json()["email"] == f"user_{unique}@example.com"

        # login
        r = await client.post(
            "/auth/login", json={"email": f"user_{unique}@example.com", "password": PASSWORD}
        )
        assert r.status_code == 200

        # refresh rotates the cookie
        old_cookie = client.cookies.get("refresh_token")
        r = await client.post("/auth/refresh")
        assert r.status_code == 200
        assert r.json()["access_token"]
        assert client.cookies.get("refresh_token") != old_cookie

        # logout kills the session
        r = await client.post("/auth/logout")
        assert r.status_code == 204
        r = await client.post("/auth/refresh")
        assert r.status_code == 401

    async def test_login_wrong_password_same_message_as_unknown_email(
        self, client: AsyncClient, unique: str
    ):
        await register(client, unique)
        wrong_pw = await client.post(
            "/auth/login", json={"email": f"user_{unique}@example.com", "password": "wrong-password-1"}
        )
        no_user = await client.post(
            "/auth/login", json={"email": f"ghost_{unique}@example.com", "password": "wrong-password-1"}
        )
        assert wrong_pw.status_code == no_user.status_code == 401
        assert wrong_pw.json()["detail"] == no_user.json()["detail"]


class TestRefreshRotation:
    # Contract since Stage 3: reuse INSIDE the 30s grace window (with a
    # recorded successor) is the multi-tab race → converge, don't nuke.
    # Reuse OUTSIDE the window is theft → nuke the family. Both directions
    # are pinned in tests/test_refresh_grace.py.
    async def test_rotation_happens_on_every_refresh(self, client: AsyncClient, unique: str):
        r = await register(client, unique)
        first = refresh_cookie_value(r)

        r = await client.post("/auth/refresh")
        assert r.status_code == 200
        second = client.cookies.get("refresh_token")
        assert second != first, "every refresh must rotate the token"


class TestForgotPassword:
    async def test_returns_200_for_unknown_email(self, client: AsyncClient, unique: str):
        r = await client.post(
            "/auth/forgot-password", json={"email": f"nobody_{unique}@example.com"}
        )
        assert r.status_code == 200


class TestUsernames:
    async def test_uniqueness_is_case_insensitive(self, client: AsyncClient, unique: str):
        r = await register(client, unique, username=f"bohdan_{unique}")
        assert r.status_code == 201

        r = await register(
            client, unique, username=f"Bohdan_{unique}", email=f"other_{unique}@example.com"
        )
        assert r.status_code == 409

        r = await client.get("/users/check-username", params={"username": f"BOHDAN_{unique}"})
        assert r.json() == {"available": False}

    async def test_change_blocked_inside_30_day_window(self, client: AsyncClient, unique: str):
        r = await register(client, unique)
        token = r.json()["access_token"]
        auth = {"Authorization": f"Bearer {token}"}

        # first change: free (username_changed_at is NULL)
        r = await client.patch("/users/me", json={"username": f"newname_{unique}"}, headers=auth)
        assert r.status_code == 200
        assert r.json()["username"] == f"newname_{unique}"

        # second change inside 30 days: blocked
        r = await client.patch("/users/me", json={"username": f"again_{unique}"}, headers=auth)
        assert r.status_code == 429
        assert "30 days" in r.json()["detail"]

    async def test_check_username_available_and_invalid(self, client: AsyncClient, unique: str):
        r = await client.get("/users/check-username", params={"username": f"free_{unique}"})
        assert r.json() == {"available": True}
        r = await client.get("/users/check-username", params={"username": "Ім'я!"})
        assert r.json() == {"available": False}
