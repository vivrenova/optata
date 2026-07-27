import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext

from app.config import get_settings

ACCESS_TOKEN_TTL = timedelta(minutes=15)
REFRESH_TOKEN_TTL = timedelta(days=30)
RESET_TOKEN_TTL = timedelta(hours=1)
# Reuse of a rotated refresh token inside this window (with a recorded
# successor) is the shared-cookie-jar race between tabs, not theft.
REFRESH_REUSE_GRACE = timedelta(seconds=30)


class AccessTokenExpired(Exception):
    """The JWT was valid once — the client should refresh and retry."""


class AccessTokenInvalid(Exception):
    """The JWT never was valid — the client should log out."""

pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")

# Verified when login hits an unknown email, so both failure paths cost one argon2 pass
DUMMY_PASSWORD_HASH = pwd_context.hash(secrets.token_urlsafe(16))


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def create_access_token(user_id: uuid.UUID) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user_id), "iat": now, "exp": now + ACCESS_TOKEN_TTL}
    return jwt.encode(payload, get_settings().jwt_secret, algorithm="HS256")


def decode_access_token(token: str) -> uuid.UUID:
    """Raises AccessTokenExpired / AccessTokenInvalid — the two cases get
    different 401s (RFC 6750) so the client knows whether to refresh."""
    try:
        payload = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
        return uuid.UUID(payload["sub"])
    except jwt.ExpiredSignatureError as exc:
        raise AccessTokenExpired from exc
    except (jwt.InvalidTokenError, KeyError, ValueError) as exc:
        raise AccessTokenInvalid from exc


def generate_opaque_token() -> tuple[str, str]:
    """Return (raw, sha256 hex). Only the hash is ever stored."""
    raw = secrets.token_urlsafe(32)
    return raw, hash_opaque_token(raw)


def hash_opaque_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()
