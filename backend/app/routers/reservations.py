import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.deps import CurrentUser, DbSession
from app.models import Item, Reservation, User
from app.schemas import ReservationCreatedOut, ReservationOut, ReservedItemOut, TombstoneOut

router = APIRouter(tags=["reservations"])


@router.post(
    "/items/{item_id}/reserve",
    status_code=status.HTTP_201_CREATED,
    response_model=ReservationCreatedOut,
)
async def reserve_item(
    item_id: uuid.UUID, db: DbSession, current_user: CurrentUser
) -> ReservationCreatedOut:
    item = await db.get(Item, item_id)
    if item is None:
        raise HTTPException(404, "That item is gone.")
    if item.user_id == current_user.id:
        raise HTTPException(403, "You can't gift something to yourself.")

    already = await db.scalar(select(Reservation.id).where(Reservation.item_id == item_id))
    if already is not None:
        raise HTTPException(409, "Someone already called dibs on this one.")

    owner_username = await db.scalar(select(User.username).where(User.id == item.user_id))
    db.add(
        Reservation(
            item_id=item_id,
            reserver_id=current_user.id,
            item_title_snapshot=item.title,
            owner_username_snapshot=owner_username or "",
        )
    )
    try:
        await db.commit()
    except IntegrityError:
        # Lost the race — the DB unique constraint on item_id is the authority
        await db.rollback()
        raise HTTPException(409, "Someone already called dibs on this one.")
    return ReservationCreatedOut(item_id=item_id)


@router.delete("/items/{item_id}/reserve", status_code=status.HTTP_204_NO_CONTENT)
async def unreserve_item(item_id: uuid.UUID, db: DbSession, current_user: CurrentUser) -> None:
    result = await db.execute(
        sa_delete(Reservation).where(
            Reservation.item_id == item_id, Reservation.reserver_id == current_user.id
        )
    )
    if result.rowcount == 0:
        raise HTTPException(404, "You haven't called dibs on this one.")
    await db.commit()


@router.get("/reservations", response_model=list[ReservationOut])
async def my_reservations(db: DbSession, current_user: CurrentUser) -> list[ReservationOut]:
    rows = (
        await db.execute(
            select(Reservation, Item, User.username)
            .outerjoin(Item, Reservation.item_id == Item.id)
            .outerjoin(User, Item.user_id == User.id)
            .where(Reservation.reserver_id == current_user.id)
            .order_by(Reservation.created_at.desc())
        )
    ).all()

    result: list[ReservationOut] = []
    for reservation, item, owner_username in rows:
        if item is None:
            # Tombstone: the owner deleted the item (item_id went NULL).
            # The snapshots show the promise as it was made.
            result.append(
                ReservationOut(
                    id=reservation.id,
                    item=None,
                    tombstone=TombstoneOut(
                        title=reservation.item_title_snapshot,
                        owner_username=reservation.owner_username_snapshot,
                    ),
                    created_at=reservation.created_at,
                )
            )
        else:
            result.append(
                ReservationOut(
                    id=reservation.id,
                    item=ReservedItemOut(
                        id=item.id,
                        title=item.title,
                        image_url=item.image_url,
                        accent_color=item.accent_color,
                        link=item.link,
                        price=item.price,
                        currency=item.currency,
                        owner_username=owner_username,
                    ),
                    tombstone=None,
                    created_at=reservation.created_at,
                )
            )
    return result


@router.delete("/reservations/{reservation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def dismiss_reservation(
    reservation_id: uuid.UUID, db: DbSession, current_user: CurrentUser
) -> None:
    """Dismiss by reservation id — the only handle a tombstone has left.
    Works on live reservations too (same semantics as unreserving)."""
    result = await db.execute(
        sa_delete(Reservation).where(
            Reservation.id == reservation_id, Reservation.reserver_id == current_user.id
        )
    )
    if result.rowcount == 0:
        raise HTTPException(404, "That isn't on your list.")
    await db.commit()
