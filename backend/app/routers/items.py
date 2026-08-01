import hashlib
import re
import secrets
import uuid
from decimal import Decimal, InvalidOperation

import anyio
import structlog
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from starlette.datastructures import UploadFile as StarletteUploadFile
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.config import get_settings
from app.deps import CurrentUser, DbSession, OptionalUser
from app.images import reencode_webp
from app.models import Item, ItemViewSession
from app.rate_limit import identifier_key, limiter
from app.schemas import ItemOwnerOut, ReorderIn, ViewsIn
from app.storage import StorageError, storage

log = structlog.get_logger()

router = APIRouter(prefix="/items", tags=["items"])

MAX_ITEMS = 40
# Must match SERVER_LIMIT_BYTES in frontend/src/lib/imagePipeline.ts.
# 1MB, not 500KB: browsers without a WebP encoder (iOS Safari) send JPEG,
# which is bigger for the same picture. The pixel budget in reencode_webp —
# not this number — is what stops a decompression bomb, so raising it costs
# storage, never safety.
MAX_IMAGE_BYTES = 1024 * 1024
ALLOWED_CONTENT_TYPES = {"image/webp", "image/jpeg", "image/png"}
ACCENT_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
DEFAULT_ACCENT = "#D6D6D1"  # --paper-deep
CURRENCIES = {"UAH", "USD", "EUR", "PLN"}
MAX_PRICE = Decimal("9999999999.99")  # NUMERIC(12,2)

ANON_COOKIE = "anon_id"
ANON_COOKIE_MAX_AGE = 365 * 24 * 3600
VIEWS_BATCH_CAP = 200  # a legit batch is ≤40; never error the caller, just cap


async def _stash_user_identifier(request: Request, current_user: CurrentUser) -> None:
    request.state.rate_limit_identifier = str(current_user.id)


# --- field validation (multipart forms, so no Pydantic body model) ---


def _clean_title(raw: str) -> str:
    title = raw.strip()
    if not title:
        raise HTTPException(422, "Give it a name — even “those boots” works.")
    if len(title) > 80:
        raise HTTPException(422, "Title is limited to 80 characters.")
    return title


def _clean_link(raw: str) -> str | None:
    link = raw.strip()
    if not link:
        return None
    if not (link.startswith("http://") or link.startswith("https://")):
        raise HTTPException(422, "Link must start with http:// or https://.")
    if len(link) > 2048:
        raise HTTPException(422, "Link is limited to 2048 characters.")
    return link


def _clean_note(raw: str) -> str | None:
    note = raw.strip()
    if not note:
        return None
    if len(note) > 280:
        raise HTTPException(422, "Note is limited to 280 characters.")
    return note


def _clean_price_currency(price_raw: str | None, currency_raw: str | None) -> tuple[Decimal | None, str | None]:
    price_raw = (price_raw or "").strip()
    currency_raw = (currency_raw or "").strip().upper()
    if not price_raw and not currency_raw:
        return None, None
    if not price_raw or not currency_raw:
        raise HTTPException(422, "Price and currency travel together — set both or neither.")
    if currency_raw not in CURRENCIES:
        raise HTTPException(422, "Currency must be one of UAH, USD, EUR, PLN.")
    try:
        price = Decimal(price_raw).quantize(Decimal("0.01"))
    except InvalidOperation:
        raise HTTPException(422, "Prices look like 1200 or 49.99 — digits only.")
    if price < 0:
        raise HTTPException(422, "A negative price would make it a gift to them.")
    if price > MAX_PRICE:
        raise HTTPException(422, "That price is too big for us to store.")
    return price, currency_raw


def _clean_accent(raw: str | None) -> str:
    accent = (raw or "").strip()
    return accent if ACCENT_RE.fullmatch(accent) else DEFAULT_ACCENT


async def _process_upload(image: StarletteUploadFile) -> bytes:
    if image.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "That format won't work here. Use a JPEG, PNG or WebP.",
        )
    data = await image.read()
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"That image is over {MAX_IMAGE_BYTES // 1024}KB. Shrink it and try again.",
        )
    try:
        return await anyio.to_thread.run_sync(reencode_webp, data)
    except ValueError:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "That file isn't an image we can read."
        )


def _new_image_path(user_id: uuid.UUID, item_id: uuid.UUID) -> str:
    """Random component per upload → every stored object is immutable.
    A replaced image gets a NEW key (and URL), so the CDN can never serve
    a stale or deleted photo from cache."""
    return f"{user_id}/{item_id}/{uuid.uuid4()}.webp"


async def _get_owned_item(db: DbSession, item_id: uuid.UUID, current_user: CurrentUser) -> Item:
    item = await db.get(Item, item_id)
    if item is None:
        raise HTTPException(404, "That item is gone.")
    if item.user_id != current_user.id:
        raise HTTPException(403, "That's not yours to change.")
    return item


# --- endpoints (static paths before /{item_id}) ---


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=ItemOwnerOut,
    dependencies=[Depends(_stash_user_identifier)],
)
# 60 > the 40-item cap, so the 409 stays reachable in one sitting and a new
# user can fill their wishlist without hitting 429 at item 31; the limit's
# only real job is bounding upload churn (create/delete/create).
@limiter.limit("60/hour", key_func=identifier_key)  # per user id, not per IP
async def create_item(
    request: Request,
    db: DbSession,
    current_user: CurrentUser,
    image: UploadFile = File(),
    title: str = Form(),
    link: str = Form(default=""),
    price: str = Form(default=""),
    currency: str = Form(default=""),
    note: str = Form(default=""),
    accent_color: str = Form(default=""),
) -> ItemOwnerOut:
    count = await db.scalar(
        select(func.count()).select_from(Item).where(Item.user_id == current_user.id)
    )
    if count is not None and count >= MAX_ITEMS:
        raise HTTPException(409, "That's 40 of 40 — your list is full. Delete one to add another.")

    clean_title = _clean_title(title)
    clean_link = _clean_link(link)
    clean_note = _clean_note(note)
    clean_price, clean_currency = _clean_price_currency(price, currency)
    webp = await _process_upload(image)

    item_id = uuid.uuid4()
    image_path = _new_image_path(current_user.id, item_id)
    next_index = await db.scalar(
        select(func.coalesce(func.max(Item.order_index) + 1, 0)).where(
            Item.user_id == current_user.id
        )
    )

    item = Item(
        id=item_id,
        user_id=current_user.id,
        title=clean_title,
        image_url=storage.public_url(image_path),
        image_path=image_path,
        accent_color=_clean_accent(accent_color),
        link=clean_link,
        price=clean_price,
        currency=clean_currency,
        note=clean_note,
        order_index=next_index if next_index is not None else 0,
    )
    db.add(item)
    await db.flush()

    try:
        await storage.upload_item_image(image_path, webp)
    except StorageError:
        raise HTTPException(502, "Couldn't store the image. Try again in a moment.")

    await db.commit()
    await db.refresh(item)
    return ItemOwnerOut.model_validate(item)


@router.put("/reorder", status_code=status.HTTP_204_NO_CONTENT)
async def reorder_items(body: ReorderIn, db: DbSession, current_user: CurrentUser) -> None:
    items = (await db.scalars(select(Item).where(Item.user_id == current_user.id))).all()
    if len(body.ordered_ids) != len(set(body.ordered_ids)) or set(body.ordered_ids) != {
        i.id for i in items
    }:
        raise HTTPException(422, "ordered_ids must contain exactly all of your items, each once.")
    position = {item_id: index for index, item_id in enumerate(body.ordered_ids)}
    for item in items:
        item.order_index = position[item.id]
    await db.commit()


@router.post("/views", status_code=status.HTTP_204_NO_CONTENT)
async def record_views(
    request: Request,
    response: Response,
    body: ViewsIn,
    db: DbSession,
    viewer: OptionalUser,
) -> None:
    """Idempotent by (item, session); must never error the caller."""
    try:
        item_ids = list(dict.fromkeys(body.item_ids))[:VIEWS_BATCH_CAP]
        if not item_ids:
            return

        if viewer is not None:
            # The server knows who owns what — an owner's own views never
            # count, no matter which client sends them.
            identity = f"user:{viewer.id}"
        else:
            anon = request.cookies.get(ANON_COOKIE)
            if anon is None:
                anon = secrets.token_urlsafe(16)
                settings = get_settings()
                response.set_cookie(
                    ANON_COOKIE,
                    anon,
                    max_age=ANON_COOKIE_MAX_AGE,
                    httponly=True,
                    secure=settings.cookie_secure,
                    samesite=settings.cookie_samesite,  # type: ignore[arg-type]
                    domain=settings.cookie_domain or None,
                )
            identity = f"anon:{anon}"
        session_hash = hashlib.sha256(identity.encode()).hexdigest()

        countable = select(Item.id).where(Item.id.in_(item_ids))
        if viewer is not None:
            countable = countable.where(Item.user_id != viewer.id)
        existing_ids = (await db.scalars(countable)).all()
        if not existing_ids:
            return

        inserted = (
            await db.execute(
                pg_insert(ItemViewSession)
                .values([{"item_id": i, "session_hash": session_hash} for i in existing_ids])
                .on_conflict_do_nothing()
                .returning(ItemViewSession.item_id)
            )
        ).scalars().all()
        if inserted:
            await db.execute(
                update(Item).where(Item.id.in_(inserted)).values(view_count=Item.view_count + 1)
            )
        await db.commit()
    except Exception:
        log.exception("views_recording_failed")


@router.patch(
    "/{item_id}",
    response_model=ItemOwnerOut,
    # The form is parsed by hand (see below), so document it by hand —
    # /docs is the manual-acceptance surface and must stay usable.
    openapi_extra={
        "requestBody": {
            "content": {
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string", "maxLength": 80},
                            "link": {"type": "string", "description": "Empty string clears it."},
                            "price": {"type": "string", "description": "Send with currency; both empty clears both."},
                            "currency": {"type": "string", "enum": ["UAH", "USD", "EUR", "PLN", ""]},
                            "note": {"type": "string", "maxLength": 280, "description": "Empty string clears it."},
                            "accent_color": {"type": "string", "pattern": "^#[0-9A-Fa-f]{6}$"},
                            "image": {"type": "string", "format": "binary"},
                        },
                    }
                }
            }
        }
    },
)
async def update_item(
    item_id: uuid.UUID,
    request: Request,
    db: DbSession,
    current_user: CurrentUser,
) -> ItemOwnerOut:
    # Field absent → untouched; sent empty → cleared (title can't be cleared,
    # price/currency travel together). The form is read raw because FastAPI's
    # Form(...) collapses empty strings into the default, which makes
    # "absent" and "sent empty" indistinguishable.
    item = await _get_owned_item(db, item_id, current_user)
    form = await request.form()

    if "title" in form:
        item.title = _clean_title(str(form["title"]))
    if "link" in form:
        item.link = _clean_link(str(form["link"]))
    if "note" in form:
        item.note = _clean_note(str(form["note"]))
    if "price" in form or "currency" in form:
        price_raw = (
            str(form["price"])
            if "price" in form
            else (str(item.price) if item.price is not None else "")
        )
        currency_raw = str(form["currency"]) if "currency" in form else (item.currency or "")
        item.price, item.currency = _clean_price_currency(price_raw, currency_raw)
    if "accent_color" in form:
        item.accent_color = _clean_accent(str(form["accent_color"]))

    image = form.get("image")
    old_image_path: str | None = None
    if image is not None:
        if not isinstance(image, StarletteUploadFile):
            raise HTTPException(
                status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "image must be a file upload."
            )
        webp = await _process_upload(image)
        # Immutable objects: upload under a NEW key, point the row at it,
        # delete the old object last. The URL changes, so no CDN staleness.
        new_path = _new_image_path(current_user.id, item.id)
        try:
            await storage.upload_item_image(new_path, webp)
        except StorageError:
            raise HTTPException(502, "Couldn't store the image. Try again in a moment.")
        old_image_path = item.image_path
        item.image_path = new_path
        item.image_url = storage.public_url(new_path)

    await db.commit()
    if old_image_path is not None:
        await storage.delete_item_image(old_image_path)  # best-effort, after commit
    await db.refresh(item)
    return ItemOwnerOut.model_validate(item)


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_item(item_id: uuid.UUID, db: DbSession, current_user: CurrentUser) -> None:
    item = await _get_owned_item(db, item_id, current_user)
    # Storage first; on failure it logs and we delete the row anyway —
    # an orphaned file is harmless, an orphaned row is not.
    await storage.delete_item_image(item.image_path)
    await db.delete(item)
    await db.commit()
