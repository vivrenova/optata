"""Delete a user and everything they own — DB rows AND storage objects.

Run by hand, from backend/:

    uv run python scripts/delete_user.py <username>
    uv run python scripts/delete_user.py <username> --yes      # skip the prompt
    uv run python scripts/delete_user.py <username> --dry-run  # show, touch nothing

Why this script exists at all: the DB cascades (items, reservations,
refresh/reset tokens, view sessions all hang off users.id ON DELETE
CASCADE), but Supabase Storage is a separate service and knows nothing
about Postgres. Deleting the row alone leaves every photo of theirs
publicly readable forever at its original URL. So: storage first, row
second — and if storage deletion fails we stop, because an orphaned row is
recoverable while an orphaned public photo is the actual harm.

Idempotent: re-running on an already-deleted user reports nothing to do and
exits 0. Safe to run twice if you lose the connection mid-way.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# Allow `python scripts/delete_user.py` from the backend/ directory
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import get_settings
from app.models import Item, Reservation, User
from app.storage import BUCKET

settings = get_settings()


def _auth_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.supabase_service_key}",
        "apikey": settings.supabase_service_key,
    }


async def list_storage_prefix(client: httpx.AsyncClient, prefix: str) -> list[str]:
    """Every object key under a prefix, walking sub-'folders'.

    Supabase's list endpoint is one level deep: real objects come back with
    an id, while pseudo-directories come back with id=None. Item photos live
    at {user_id}/{item_id}/{uuid}.webp and avatars at {user_id}/avatar/{uuid}
    .webp, so a single-level list would only ever see directories. This
    recurses so nothing is missed.
    """
    found: list[str] = []
    offset = 0
    while True:
        response = await client.post(
            f"{settings.supabase_url}/storage/v1/object/list/{BUCKET}",
            headers=_auth_headers(),
            json={"prefix": prefix, "limit": 100, "offset": offset},
            timeout=30,
        )
        response.raise_for_status()
        page = response.json()
        if not page:
            break
        for entry in page:
            name = entry.get("name")
            if not name:
                continue
            child = f"{prefix}/{name}" if prefix else name
            if entry.get("id") is None:
                found.extend(await list_storage_prefix(client, child))
            else:
                found.append(child)
        if len(page) < 100:
            break
        offset += 100
    return found


async def delete_storage_objects(client: httpx.AsyncClient, keys: list[str]) -> None:
    """Bulk delete. Supabase caps the payload, so send it in chunks."""
    for start in range(0, len(keys), 100):
        chunk = keys[start : start + 100]
        response = await client.request(
            "DELETE",
            f"{settings.supabase_url}/storage/v1/object/{BUCKET}",
            headers={**_auth_headers(), "Content-Type": "application/json"},
            json={"prefixes": chunk},
            timeout=60,
        )
        response.raise_for_status()


async def main() -> int:
    parser = argparse.ArgumentParser(description="Delete a user, their data and their photos.")
    parser.add_argument("username")
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    parser.add_argument("--dry-run", action="store_true", help="report only, change nothing")
    args = parser.parse_args()
    username = args.username.strip().lower()

    engine = create_async_engine(settings.database_url)
    try:
        async with engine.connect() as conn:
            user = (await conn.execute(select(User).where(User.username == username))).one_or_none()
            if user is None:
                print(f"No user named {username!r}. Nothing to do.")
                return 0

            user_id = user.id
            item_rows = (
                await conn.execute(
                    select(Item.id, Item.title, Item.image_path).where(Item.user_id == user_id)
                )
            ).all()
            # Reservations THEY made on other people's items (cascade removes
            # these, freeing those items for someone else to claim).
            made = (
                await conn.execute(
                    select(text("count(*)"))
                    .select_from(Reservation.__table__)
                    .where(Reservation.reserver_id == user_id)
                )
            ).scalar()
            # Reservations OTHERS made on this user's items. Those rows survive
            # as tombstones (item_id ON DELETE SET NULL) so the gift-giver still
            # sees what they promised — deliberate, see migration c5ea05a99ba6.
            received = (
                await conn.execute(
                    text(
                        "SELECT count(*) FROM reservations r "
                        "JOIN items i ON i.id = r.item_id WHERE i.user_id = :uid"
                    ),
                    {"uid": user_id},
                )
            ).scalar()

        async with httpx.AsyncClient() as client:
            # The DB is authoritative for paths, but also sweep the whole
            # {user_id}/ prefix so orphans from failed uploads go too.
            db_keys = {row.image_path for row in item_rows if row.image_path}
            if user.avatar_path:
                db_keys.add(user.avatar_path)
            swept = set(await list_storage_prefix(client, str(user_id)))
            all_keys = sorted(db_keys | swept)

            print(f"\nUser:          {user.username}  <{user.email}>")
            print(f"  id:          {user_id}")
            print(f"  created:     {user.created_at}")
            print(f"  items:       {len(item_rows)}")
            for row in item_rows[:10]:
                print(f"     - {row.title}")
            if len(item_rows) > 10:
                print(f"     … and {len(item_rows) - 10} more")
            print(f"  dibs they called on others:  {made}  (deleted, frees those items)")
            print(f"  dibs others called on them:  {received}  (kept as tombstones)")
            print(f"  storage objects:             {len(all_keys)}")
            for key in all_keys[:10]:
                print(f"     - {key}")
            if len(all_keys) > 10:
                print(f"     … and {len(all_keys) - 10} more")
            print("\nAlso removed by cascade: refresh tokens, password-reset tokens, view sessions.")

            if args.dry_run:
                print("\n--dry-run: nothing was changed.")
                return 0

            if not args.yes:
                print("\nThis cannot be undone.")
                if input(f'Type the username ("{user.username}") to confirm: ').strip() != user.username:
                    print("Confirmation did not match. Aborted; nothing was changed.")
                    return 1

            # Storage FIRST: a failure here must stop us before the row (and
            # with it, our record of which paths to delete) disappears.
            if all_keys:
                print(f"Deleting {len(all_keys)} storage object(s)…")
                await delete_storage_objects(client, all_keys)
                remaining = await list_storage_prefix(client, str(user_id))
                if remaining:
                    print(f"ABORTED: {len(remaining)} object(s) still present, e.g. {remaining[:3]}")
                    print("The database row was NOT touched. Fix storage access and re-run.")
                    return 2
                print("Storage clear.")
            else:
                print("No storage objects to delete.")

        async with engine.begin() as conn:
            await conn.execute(text("DELETE FROM users WHERE id = :uid"), {"uid": user_id})
        print(f"Deleted user {user.username!r} and all cascaded rows.")
        return 0
    finally:
        await engine.dispose()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
