import uuid
from datetime import datetime, timezone

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.deps import CurrentUser, DbSession
from app.emails import send_password_reset_email
from app.models import PasswordResetToken, RefreshToken, User
from app.rate_limit import identifier_key, limiter
from app.schemas import (
    ForgotPasswordIn,
    LoginIn,
    RegisterIn,
    ResetPasswordIn,
    TokenOut,
    UserPrivate,
)
from app.security import (
    DUMMY_PASSWORD_HASH,
    REFRESH_REUSE_GRACE,
    REFRESH_TOKEN_TTL,
    RESET_TOKEN_TTL,
    create_access_token,
    generate_opaque_token,
    hash_opaque_token,
    hash_password,
    verify_password,
)

log = structlog.get_logger()

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "refresh_token"

LOGIN_FAILED = "Invalid email or password."  # identical for unknown email and wrong password


def _set_refresh_cookie(response: Response, raw_token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        REFRESH_COOKIE,
        raw_token,
        max_age=int(REFRESH_TOKEN_TTL.total_seconds()),
        path="/auth",
        domain=settings.cookie_domain or None,
        secure=settings.cookie_secure,
        httponly=True,
        samesite=settings.cookie_samesite,  # type: ignore[arg-type]
    )


def _clear_refresh_cookie(response: Response) -> None:
    settings = get_settings()
    response.delete_cookie(
        REFRESH_COOKIE,
        path="/auth",
        domain=settings.cookie_domain or None,
        secure=settings.cookie_secure,
        httponly=True,
        samesite=settings.cookie_samesite,  # type: ignore[arg-type]
    )


async def _issue_refresh_token(db: AsyncSession, user_id: uuid.UUID) -> tuple[str, RefreshToken]:
    raw, token_hash = generate_opaque_token()
    token = RefreshToken(
        user_id=user_id,
        token_hash=token_hash,
        expires_at=datetime.now(timezone.utc) + REFRESH_TOKEN_TTL,
    )
    db.add(token)
    return raw, token


async def _revoke_successor_chain(db: AsyncSession, token: RefreshToken) -> None:
    """Kill every token that descended from this one via rotation."""
    now = datetime.now(timezone.utc)
    current = token
    for _ in range(32):  # cycle guard
        if current.replaced_by_id is None:
            return
        successor = await db.get(RefreshToken, current.replaced_by_id)
        if successor is None:
            return
        if successor.revoked_at is None:
            successor.revoked_at = now
        current = successor


async def revoke_all_refresh_tokens(db: AsyncSession, user_id: uuid.UUID) -> None:
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )


# Stash the submitted email for the per-identifier rate-limit dimension.
# FastAPI reads the body once — declaring the same model here and in the
# endpoint does not consume it twice.
async def _stash_login_identifier(request: Request, body: LoginIn) -> None:
    request.state.rate_limit_identifier = body.email.lower()


async def _stash_forgot_identifier(request: Request, body: ForgotPasswordIn) -> None:
    request.state.rate_limit_identifier = body.email.lower()


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=TokenOut)
@limiter.limit("5/hour")
async def register(request: Request, body: RegisterIn, response: Response, db: DbSession) -> TokenOut:
    email_taken = await db.scalar(select(User.id).where(User.email == body.email))
    if email_taken:
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists.")
    username_taken = await db.scalar(select(User.id).where(User.username == body.username))
    if username_taken:
        raise HTTPException(status.HTTP_409_CONFLICT, "This username is taken.")

    user = User(email=body.email, username=body.username, password_hash=hash_password(body.password))
    db.add(user)
    try:
        await db.flush()
    except IntegrityError:
        # Lost a race with a concurrent registration on a unique column
        raise HTTPException(status.HTTP_409_CONFLICT, "This email or username is taken.")

    raw_refresh, _ = await _issue_refresh_token(db, user.id)
    await db.commit()

    _set_refresh_cookie(response, raw_refresh)
    log.info("user_registered")
    return TokenOut(access_token=create_access_token(user.id), user=UserPrivate.model_validate(user))


@router.post("/login", response_model=TokenOut, dependencies=[Depends(_stash_login_identifier)])
@limiter.limit("10/minute")  # per resolved client IP
@limiter.limit("10/minute", key_func=identifier_key)  # per submitted email
async def login(request: Request, body: LoginIn, response: Response, db: DbSession) -> TokenOut:
    user = await db.scalar(select(User).where(User.email == body.email))
    if user is None:
        verify_password(body.password, DUMMY_PASSWORD_HASH)  # keep timing identical
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, LOGIN_FAILED)
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, LOGIN_FAILED)

    raw_refresh, _ = await _issue_refresh_token(db, user.id)
    await db.commit()

    _set_refresh_cookie(response, raw_refresh)
    return TokenOut(access_token=create_access_token(user.id), user=UserPrivate.model_validate(user))


@router.post("/refresh", response_model=TokenOut)
async def refresh(request: Request, response: Response, db: DbSession) -> TokenOut:
    raw = request.cookies.get(REFRESH_COOKIE)
    if raw is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated.")

    token = await db.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_opaque_token(raw))
    )
    if token is None:
        _clear_refresh_cookie(response)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired. Log in again.")

    now = datetime.now(timezone.utc)

    if token.revoked_at is not None:
        # Reuse of a rotated token. Browsers share one cookie jar, so two
        # tabs mounting together both send the same token — if it was
        # rotated seconds ago and HAS a recorded successor, that's the
        # benign race (rotation leeway, same tradeoff Auth0 makes), not theft.
        is_benign_race = (
            token.replaced_by_id is not None
            and now - token.revoked_at < REFRESH_REUSE_GRACE
        )
        if not is_benign_race:
            await revoke_all_refresh_tokens(db, token.user_id)
            await db.commit()
            _clear_refresh_cookie(response)
            log.warning("refresh_token_reuse_detected")
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired. Log in again.")

        user = await db.get(User, token.user_id)
        if user is None:
            _clear_refresh_cookie(response)
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired. Log in again.")

        # Converge both racers onto one fresh token: kill the successor
        # chain, issue a replacement, keep the family alive.
        await _revoke_successor_chain(db, token)
        raw_refresh, new_token = await _issue_refresh_token(db, user.id)
        await db.flush()
        token.replaced_by_id = new_token.id
        await db.commit()
        log.info("refresh_reuse_grace_applied")

        _set_refresh_cookie(response, raw_refresh)
        return TokenOut(
            access_token=create_access_token(user.id), user=UserPrivate.model_validate(user)
        )

    if token.expires_at <= now:
        _clear_refresh_cookie(response)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired. Log in again.")

    user = await db.get(User, token.user_id)
    if user is None:
        _clear_refresh_cookie(response)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired. Log in again.")

    # Rotation: the old token dies, the successor is recorded
    token.revoked_at = now
    raw_refresh, new_token = await _issue_refresh_token(db, user.id)
    await db.flush()
    token.replaced_by_id = new_token.id
    await db.commit()

    _set_refresh_cookie(response, raw_refresh)
    return TokenOut(access_token=create_access_token(user.id), user=UserPrivate.model_validate(user))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response, db: DbSession) -> None:
    raw = request.cookies.get(REFRESH_COOKIE)
    if raw is not None:
        await db.execute(
            update(RefreshToken)
            .where(RefreshToken.token_hash == hash_opaque_token(raw), RefreshToken.revoked_at.is_(None))
            .values(revoked_at=datetime.now(timezone.utc))
        )
        await db.commit()
    _clear_refresh_cookie(response)


@router.post("/forgot-password", dependencies=[Depends(_stash_forgot_identifier)])
@limiter.limit("3/hour")  # per resolved client IP
@limiter.limit("3/hour", key_func=identifier_key)  # per submitted email
async def forgot_password(
    request: Request, body: ForgotPasswordIn, background_tasks: BackgroundTasks, db: DbSession
) -> dict[str, str]:
    # Always 200 — never an account-existence oracle
    user = await db.scalar(select(User).where(User.email == body.email))
    if user is not None:
        raw, token_hash = generate_opaque_token()
        db.add(
            PasswordResetToken(
                user_id=user.id,
                token_hash=token_hash,
                expires_at=datetime.now(timezone.utc) + RESET_TOKEN_TTL,
            )
        )
        await db.commit()
        reset_url = f"{get_settings().primary_frontend_origin}/reset-password?token={raw}"
        background_tasks.add_task(send_password_reset_email, user.email, reset_url)
    return {"detail": "If that email is registered, a reset link is on its way."}


@router.post("/reset-password", status_code=status.HTTP_204_NO_CONTENT)
async def reset_password(request: Request, body: ResetPasswordIn, db: DbSession) -> None:
    token = await db.scalar(
        select(PasswordResetToken).where(
            PasswordResetToken.token_hash == hash_opaque_token(body.token)
        )
    )
    if token is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This reset link is invalid. Request a new one.")
    if token.used_at is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This reset link was already used. Request a new one.")
    if token.expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This reset link has expired. Request a new one.")

    user = await db.get(User, token.user_id)
    if user is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This reset link is invalid. Request a new one.")

    token.used_at = datetime.now(timezone.utc)
    user.password_hash = hash_password(body.new_password)
    await revoke_all_refresh_tokens(db, user.id)
    await db.commit()
    log.info("password_reset_completed")


@router.get("/me", response_model=UserPrivate)
async def me(current_user: CurrentUser) -> UserPrivate:
    return UserPrivate.model_validate(current_user)
