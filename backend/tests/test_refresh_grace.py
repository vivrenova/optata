"""Rotation leeway: the shared-cookie-jar race must not log users out,
while real token replay outside the window still nukes the family."""

import uuid
from datetime import datetime, timedelta, timezone

import jwt
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import RefreshToken
from app.security import hash_opaque_token
from tests.helpers import register


async def refresh_with(client: AsyncClient, raw_token: str):
    client.cookies.clear()
    return await client.post("/auth/refresh", headers={"Cookie": f"refresh_token={raw_token}"})


class TestGraceWindow:
    async def test_double_refresh_with_same_cookie_keeps_the_user_logged_in(
        self, client: AsyncClient, unique: str
    ):
        await register(client, f"tabs_{unique}")
        first = client.cookies.get("refresh_token")

        # Tab A refreshes: R1 → R2
        r_a = await refresh_with(client, first)
        assert r_a.status_code == 200
        second = r_a.cookies.get("refresh_token")

        # Tab B mounted at the same time and still holds R1 → benign race,
        # NOT theft: it gets a fresh pair
        r_b = await refresh_with(client, first)
        assert r_b.status_code == 200, "the multi-tab race must not log the user out"
        third = r_b.cookies.get("refresh_token")
        assert third not in (first, second)

        # the family is alive: the converged token keeps working
        r = await refresh_with(client, third)
        assert r.status_code == 200

        # the raced-away successor (R2) died with the chain — replaying it
        # within the window is also benign-handled or dead, but the session
        # of the final winner survives either way
        assert r.cookies.get("refresh_token")

    async def test_replay_after_the_window_still_nukes_the_family(
        self, client: AsyncClient, unique: str, db_session: AsyncSession
    ):
        await register(client, f"thief_{unique}")
        first = client.cookies.get("refresh_token")

        r = await refresh_with(client, first)
        assert r.status_code == 200
        second = r.cookies.get("refresh_token")

        # age the rotation beyond the 30s grace window
        await db_session.execute(
            update(RefreshToken)
            .where(RefreshToken.token_hash == hash_opaque_token(first))
            .values(revoked_at=datetime.now(timezone.utc) - timedelta(seconds=31))
        )
        await db_session.commit()

        # replaying R1 now is theft: 401 and the WHOLE family dies
        r = await refresh_with(client, first)
        assert r.status_code == 401
        r = await refresh_with(client, second)
        assert r.status_code == 401, "the stolen family must be dead, including the live token"


class TestRfc6750Challenges:
    def _expired_jwt(self, user_id: uuid.UUID) -> str:
        past = datetime.now(timezone.utc) - timedelta(minutes=30)
        return jwt.encode(
            {"sub": str(user_id), "iat": past, "exp": past + timedelta(minutes=15)},
            get_settings().jwt_secret,
            algorithm="HS256",
        )

    async def test_challenge_headers(self, client: AsyncClient, unique: str):
        r = await client.post(
            "/auth/register",
            json={
                "email": f"rfc_{unique}@example.com",
                "username": f"rfc_{unique}",
                "password": "correct-horse-battery",
            },
        )
        user_id = uuid.UUID(r.json()["user"]["id"])

        # missing token → plain Bearer challenge
        r = await client.get("/auth/me")
        assert r.status_code == 401
        assert r.headers["www-authenticate"] == "Bearer"

        # expired token → error="invalid_token", distinct detail
        r = await client.get(
            "/auth/me", headers={"Authorization": f"Bearer {self._expired_jwt(user_id)}"}
        )
        assert r.status_code == 401
        assert 'error="invalid_token"' in r.headers["www-authenticate"]
        assert "expired" in r.json()["detail"].lower()

        # garbage token → error="invalid_token" as well
        r = await client.get("/auth/me", headers={"Authorization": "Bearer not-a-jwt"})
        assert r.status_code == 401
        assert 'error="invalid_token"' in r.headers["www-authenticate"]

    async def test_optional_auth_never_silently_downgrades_to_guest(
        self, client: AsyncClient, unique: str
    ):
        # An owner with an EXPIRED token fetching their own profile must get
        # a 401 (so the client refreshes), NEVER the guest payload — the
        # guest payload carries is_reserved, and that is the §4.1 leak.
        r = await client.post(
            "/auth/register",
            json={
                "email": f"opt_{unique}@example.com",
                "username": f"opt_{unique}",
                "password": "correct-horse-battery",
            },
        )
        user_id = uuid.UUID(r.json()["user"]["id"])

        r = await client.get(
            f"/users/opt_{unique}",
            headers={"Authorization": f"Bearer {self._expired_jwt(user_id)}"},
        )
        assert r.status_code == 401
        assert 'error="invalid_token"' in r.headers["www-authenticate"]

        # no credentials at all → still a perfectly public page
        r = await client.get(f"/users/opt_{unique}")
        assert r.status_code == 200
        assert r.json()["is_owner"] is False
