import re
import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

USERNAME_RE = re.compile(r"^[a-z0-9_]{3,20}$")


def normalize_username(value: str) -> str:
    """Lowercase, then validate — 'Bohdan' becomes 'bohdan' before the format check."""
    value = value.strip().lower()
    if not USERNAME_RE.fullmatch(value):
        raise ValueError("Username must be 3-20 characters: lowercase letters, digits, underscore.")
    return value


# --- auth ---


class RegisterIn(BaseModel):
    email: EmailStr
    username: str
    password: str = Field(min_length=8, max_length=128)

    @field_validator("username")
    @classmethod
    def _username(cls, v: str) -> str:
        return normalize_username(v)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class ForgotPasswordIn(BaseModel):
    email: EmailStr


class ResetPasswordIn(BaseModel):
    token: str
    new_password: str = Field(min_length=8, max_length=128)


class UserPrivate(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    username: str
    display_name: str | None
    bio: str | None
    avatar_url: str | None
    username_changed_at: datetime | None
    created_at: datetime


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPrivate


# --- users ---


class UserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    username: str
    display_name: str | None
    bio: str | None
    avatar_url: str | None


class UsernameAvailability(BaseModel):
    available: bool


class UserUpdateIn(BaseModel):
    display_name: str | None = Field(default=None, max_length=40)
    bio: str | None = Field(default=None, max_length=160)
    username: str | None = None

    @field_validator("username")
    @classmethod
    def _username(cls, v: str | None) -> str | None:
        return None if v is None else normalize_username(v)


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


# --- items on a profile (tech-spec §4.1) ---
# THREE separate schemas, no conditional excludes. Anonymous viewers get
# item facts only: an owner who logs out or opens an incognito window is
# indistinguishable from a stranger, so showing reservation state to
# anonymous viewers would hand every owner their own spoilers. An anonymous
# viewer can't reserve anyway — the field buys them nothing.


class ItemAnonymousOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    image_url: str
    accent_color: str
    link: str | None
    price: Decimal | None
    currency: str | None
    note: str | None
    order_index: int


class ItemOwnerOut(ItemAnonymousOut):
    view_count: int


class ItemGuestOut(ItemAnonymousOut):
    is_reserved: bool
    reserved_by_me: bool


class ProfileOwnerOut(BaseModel):
    username: str
    display_name: str | None
    bio: str | None
    avatar_url: str | None
    is_owner: bool = True
    items: list[ItemOwnerOut]


class ProfileGuestOut(BaseModel):
    username: str
    display_name: str | None
    bio: str | None
    avatar_url: str | None
    is_owner: bool = False
    items: list[ItemGuestOut]


class ProfileAnonymousOut(BaseModel):
    username: str
    display_name: str | None
    bio: str | None
    avatar_url: str | None
    is_owner: bool = False
    items: list[ItemAnonymousOut]


# --- items: mutations ---


class ReorderIn(BaseModel):
    ordered_ids: list[uuid.UUID]


class ViewsIn(BaseModel):
    item_ids: list[uuid.UUID]


# --- reservations ---


class ReservedItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    image_url: str
    accent_color: str
    link: str | None
    price: Decimal | None
    currency: str | None
    owner_username: str


class TombstoneOut(BaseModel):
    """Snapshot taken at reserve time — what was promised, and to whom."""

    title: str
    owner_username: str


class ReservationOut(BaseModel):
    id: uuid.UUID  # needed to dismiss via DELETE /reservations/{id}
    # item is None → the owner deleted it; tombstone carries the snapshot
    item: ReservedItemOut | None
    tombstone: TombstoneOut | None
    created_at: datetime


class ReservationCreatedOut(BaseModel):
    item_id: uuid.UUID
