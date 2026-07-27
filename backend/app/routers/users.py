import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, File, HTTPException, Query, UploadFile, status
from sqlalchemy import select

from app.deps import CurrentUser, DbSession, OptionalUser
from app.models import Item, Reservation, User
from app.routers.auth import revoke_all_refresh_tokens
from app.routers.items import _process_upload
from app.storage import StorageError, storage
from app.schemas import (
    ItemAnonymousOut,
    ItemGuestOut,
    ItemOwnerOut,
    PasswordChangeIn,
    ProfileAnonymousOut,
    ProfileGuestOut,
    ProfileOwnerOut,
    USERNAME_RE,
    UserPrivate,
    UserPublic,
    UserUpdateIn,
    UsernameAvailability,
)
from app.security import hash_password, verify_password

router = APIRouter(prefix="/users", tags=["users"])

USERNAME_CHANGE_WINDOW = timedelta(days=30)


@router.get("/check-username", response_model=UsernameAvailability)
async def check_username(db: DbSession, username: str = Query()) -> UsernameAvailability:
    candidate = username.strip().lower()
    if not USERNAME_RE.fullmatch(candidate):
        return UsernameAvailability(available=False)
    taken = await db.scalar(select(User.id).where(User.username == candidate))
    return UsernameAvailability(available=taken is None)


@router.get("/search", response_model=list[UserPublic])
async def search_users(db: DbSession, q: str = Query(default="")) -> list[UserPublic]:
    # Usernames are [a-z0-9_], so strip everything else; escape _ (a LIKE wildcard)
    sanitized = re.sub(r"[^a-z0-9_]", "", q.strip().lower())[:20]
    if not sanitized:
        return []
    pattern = sanitized.replace("_", r"\_") + "%"
    users = await db.scalars(
        select(User).where(User.username.like(pattern, escape="\\")).order_by(User.username).limit(10)
    )
    return [UserPublic.model_validate(u) for u in users]


@router.get("/me", include_in_schema=False)
async def users_me_guard() -> None:
    # /users/{username} must never swallow "me"
    raise HTTPException(status.HTTP_404_NOT_FOUND, "Nobody owns that username.")


@router.get(
    "/{username}",
    response_model=ProfileOwnerOut | ProfileGuestOut | ProfileAnonymousOut,
)
async def get_profile(
    username: str, db: DbSession, viewer: OptionalUser
) -> ProfileOwnerOut | ProfileGuestOut | ProfileAnonymousOut:
    """Three views, three schemas (tech-spec §4.1). Anonymous gets item
    facts only: a logged-out owner is indistinguishable from a stranger,
    so reservation state for anonymous viewers would hand every owner
    their own spoilers the first time they open an incognito window."""
    user = await db.scalar(select(User).where(User.username == username.strip().lower()))
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nobody owns that username.")

    items = (
        await db.scalars(select(Item).where(Item.user_id == user.id).order_by(Item.order_index))
    ).all()

    profile_fields = {
        "username": user.username,
        "display_name": user.display_name,
        "bio": user.bio,
        "avatar_url": user.avatar_url,
    }

    if viewer is None:
        # Reservations aren't even queried on this path
        return ProfileAnonymousOut(
            **profile_fields, items=[ItemAnonymousOut.model_validate(i) for i in items]
        )

    if viewer.id == user.id:
        # Owner sees view_count and NEVER any reservation data — the guest
        # fields do not exist on ItemOwnerOut at all.
        return ProfileOwnerOut(
            **profile_fields, items=[ItemOwnerOut.model_validate(i) for i in items]
        )

    item_ids = [i.id for i in items]
    reserved_ids: set = set()
    my_reserved_ids: set = set()
    if item_ids:
        reservations = (
            await db.execute(
                select(Reservation.item_id, Reservation.reserver_id).where(
                    Reservation.item_id.in_(item_ids)
                )
            )
        ).all()
        reserved_ids = {r.item_id for r in reservations}
        my_reserved_ids = {r.item_id for r in reservations if r.reserver_id == viewer.id}

    return ProfileGuestOut(
        **profile_fields,
        items=[
            ItemGuestOut(
                id=i.id,
                title=i.title,
                image_url=i.image_url,
                accent_color=i.accent_color,
                link=i.link,
                price=i.price,
                currency=i.currency,
                note=i.note,
                order_index=i.order_index,
                is_reserved=i.id in reserved_ids,
                reserved_by_me=i.id in my_reserved_ids,
            )
            for i in items
        ],
    )


@router.patch("/me", response_model=UserPrivate)
async def update_me(body: UserUpdateIn, db: DbSession, current_user: CurrentUser) -> UserPrivate:
    fields_set = body.model_fields_set

    if "display_name" in fields_set:
        current_user.display_name = body.display_name
    if "bio" in fields_set:
        current_user.bio = body.bio

    if "username" in fields_set and body.username is not None and body.username != current_user.username:
        now = datetime.now(timezone.utc)
        if current_user.username_changed_at is not None:
            allowed_at = current_user.username_changed_at + USERNAME_CHANGE_WINDOW
            if now < allowed_at:
                raise HTTPException(
                    status.HTTP_429_TOO_MANY_REQUESTS,
                    f"You can change your username once every 30 days. "
                    f"Next change available {allowed_at.date().isoformat()}.",
                )
        taken = await db.scalar(select(User.id).where(User.username == body.username))
        if taken:
            raise HTTPException(status.HTTP_409_CONFLICT, "Someone got there first. Pick another username.")
        current_user.username = body.username
        current_user.username_changed_at = now

    await db.commit()
    await db.refresh(current_user)
    return UserPrivate.model_validate(current_user)


@router.patch("/me/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(body: PasswordChangeIn, db: DbSession, current_user: CurrentUser) -> None:
    if not verify_password(body.current_password, current_user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That current password isn't right.")
    current_user.password_hash = hash_password(body.new_password)
    # Other sessions die; this one lives until its access token expires
    await revoke_all_refresh_tokens(db, current_user.id)
    await db.commit()


@router.post("/me/avatar", response_model=UserPrivate)
async def upload_avatar(
    db: DbSession,
    current_user: CurrentUser,
    image: UploadFile = File(),
) -> UserPrivate:
    """Same pipeline as item photos: Pillow re-encode (validates the bytes,
    strips EXIF/GPS), immutable storage key, old object deleted after the
    row points at the new one."""
    webp = await _process_upload(image)
    new_path = f"{current_user.id}/avatar/{uuid.uuid4()}.webp"
    try:
        await storage.upload_item_image(new_path, webp)
    except StorageError:
        raise HTTPException(502, "Couldn't store the avatar. Try again in a moment.")

    old_path = current_user.avatar_path
    current_user.avatar_path = new_path
    current_user.avatar_url = storage.public_url(new_path)
    await db.commit()
    if old_path:
        await storage.delete_item_image(old_path)  # best-effort, after commit
    await db.refresh(current_user)
    return UserPrivate.model_validate(current_user)
