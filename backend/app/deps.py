from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import User
from app.security import AccessTokenExpired, AccessTokenInvalid, decode_access_token

DbSession = Annotated[AsyncSession, Depends(get_db)]

_bearer = HTTPBearer(auto_error=False)


def _unauthorized(detail: str, *, invalid_token: bool) -> HTTPException:
    """RFC 6750: a presented-but-unacceptable token carries
    error="invalid_token", a missing one carries plain Bearer. The client
    keys on this — refresh-and-retry vs log-out."""
    challenge = 'Bearer error="invalid_token"' if invalid_token else "Bearer"
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": challenge},
    )


async def _resolve_bearer(db: AsyncSession, token: str) -> User:
    try:
        user_id = decode_access_token(token)
    except AccessTokenExpired:
        raise _unauthorized("Access token expired. Refresh and retry.", invalid_token=True)
    except AccessTokenInvalid:
        raise _unauthorized("Invalid access token. Log in again.", invalid_token=True)
    user = await db.get(User, user_id)
    if user is None:
        raise _unauthorized("Invalid access token. Log in again.", invalid_token=True)
    return user


async def get_current_user(
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> User:
    if credentials is None:
        raise _unauthorized("Not authenticated. Log in and try again.", invalid_token=False)
    return await _resolve_bearer(db, credentials.credentials)


async def get_optional_user(
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> User | None:
    """No credentials → anonymous. A PRESENTED but bad token → 401, never a
    silent downgrade to anonymous: an owner with an expired token would
    otherwise receive the GUEST payload of their own profile — with
    is_reserved on it. That is the §4.1 leak through the front door."""
    if credentials is None:
        return None
    return await _resolve_bearer(db, credentials.credentials)


CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]
