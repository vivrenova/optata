/**
 * The §4.1 three-way split, encoded so the COMPILER enforces it.
 *
 * The payload variant is a discriminated union tagged at parse time —
 * never one interface with optional fields. `is_reserved?: boolean`
 * invites `item.is_reserved ?? false`, and the invariant dies in a shrug.
 * Here, reading reservation state on a payload that cannot carry it is a
 * type error.
 */

interface ItemCore {
  id: string;
  title: string;
  image_url: string;
  accent_color: string;
  link: string | null;
  price: string | null;
  currency: string | null;
  note: string | null;
  order_index: number;
}

export interface AnonymousItem extends ItemCore {
  readonly view: "anonymous";
}

export interface GuestItem extends ItemCore {
  readonly view: "guest";
  is_reserved: boolean;
  reserved_by_me: boolean;
}

export interface OwnerItem extends ItemCore {
  readonly view: "owner";
  view_count: number;
}

export type WishlistItem = AnonymousItem | GuestItem | OwnerItem;

interface ProfileCore {
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
}

export type Profile =
  | (ProfileCore & { readonly view: "anonymous"; items: AnonymousItem[] })
  | (ProfileCore & { readonly view: "guest"; items: GuestItem[] })
  | (ProfileCore & { readonly view: "owner"; items: OwnerItem[] });

interface RawProfile extends ProfileCore {
  is_owner: boolean;
  items: Array<Record<string, unknown>>;
}

function core(raw: Record<string, unknown>): ItemCore {
  return {
    id: String(raw.id),
    title: String(raw.title),
    image_url: String(raw.image_url),
    accent_color: String(raw.accent_color),
    link: raw.link == null ? null : String(raw.link),
    // pydantic may serialize Decimal as number or string depending on
    // config — normalize to string once, here
    price: raw.price == null ? null : String(raw.price),
    currency: raw.currency == null ? null : String(raw.currency),
    note: raw.note == null ? null : String(raw.note),
    order_index: Number(raw.order_index),
  };
}

/**
 * `authenticated` comes from the caller (did we hold a session when the
 * request was made) — the server decides owner vs guest via is_owner.
 */
export function parseProfile(json: unknown, authenticated: boolean): Profile {
  const raw = json as RawProfile;
  const base: ProfileCore = {
    username: raw.username,
    display_name: raw.display_name,
    bio: raw.bio,
    avatar_url: raw.avatar_url,
  };
  if (raw.is_owner) {
    return {
      ...base,
      view: "owner",
      items: raw.items.map((i) => ({ ...core(i), view: "owner", view_count: Number(i.view_count) })),
    };
  }
  if (authenticated) {
    return {
      ...base,
      view: "guest",
      items: raw.items.map((i) => ({
        ...core(i),
        view: "guest",
        is_reserved: Boolean(i.is_reserved),
        reserved_by_me: Boolean(i.reserved_by_me),
      })),
    };
  }
  return {
    ...base,
    view: "anonymous",
    items: raw.items.map((i) => ({ ...core(i), view: "anonymous" })),
  };
}

export function formatPrice(price: string | null, currency: string | null): string | null {
  if (price == null || currency == null) return null;
  const trimmed = price.replace(/\.00$/, "");
  return `${trimmed} ${currency}`;
}

// --- users/search ---

export interface PublicUser {
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
}

// --- reservations ---

export interface ReservedItem {
  id: string;
  title: string;
  image_url: string;
  accent_color: string;
  link: string | null;
  price: string | null;
  currency: string | null;
  owner_username: string;
}

export interface ReservationEntry {
  id: string;
  /** null → the owner deleted the item; the tombstone snapshot fills in */
  item: ReservedItem | null;
  tombstone: { title: string; owner_username: string } | null;
  created_at: string;
}
