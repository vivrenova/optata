# OPTATA

**One link. Everything you actually want.**

A wishlist that hands your friends a deck of cards instead of a spreadsheet. You add
what you want; you share one link. Friends swipe through, open what catches their eye,
and quietly call dibs — and **you never find out what's taken**. The surprise survives.

Live: **https://optata.app**

<!-- Replace with a real screenshot of /u/<you> mid-shuffle before sharing this repo. -->
![OPTATA — the shuffle deck](docs/screenshot.png)

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 19 · Vite · TypeScript (strict) · Tailwind v4 · Framer Motion → **Vercel** |
| Backend | FastAPI · SQLAlchemy 2.0 (async) · Alembic · Pydantic v2 · uv → **Render** (Docker) |
| Data | **Supabase** Postgres + Supabase Storage |
| Email | **Resend** (password reset only) |
| Errors | Sentry (both ends, env-gated) |

App and API share one registrable domain — `optata.app` and `api.optata.app` — which is
load-bearing, not cosmetic. See [Why the domain matters](#4-why-one-domain-and-not-vercelapp--onrendercom).

---

## Local setup

**Prerequisites:** Python 3.13+, Node 20+, [uv](https://docs.astral.sh/uv/), and a Supabase
project (Postgres + a public Storage bucket named `items`).

```bash
# backend
cd backend
cp .env.example .env          # fill DATABASE_URL, JWT_SECRET, SUPABASE_*, RESEND_API_KEY
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8000

# frontend (second terminal)
cd frontend
cp .env.example .env          # VITE_API_BASE_URL=http://localhost:8000
npm install
npm run dev
```

Tests — the backend suite runs against a **real Postgres**, each test inside a transaction
that is rolled back, so it never leaves rows behind:

```bash
cd backend && uv run pytest        # 55 tests
cd frontend && npm test            # 62 tests
```

### Environment variables

**Backend** (`backend/.env`, or the Render dashboard in production)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase Postgres, session pooler, `postgresql+asyncpg://…` |
| `JWT_SECRET` | Signs 15-minute access tokens. `openssl rand -hex 32`; a *different* one per environment |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | service_role key. **Backend only** — never a `VITE_` var, never in a response |
| `RESEND_API_KEY` | Password-reset email |
| `EMAIL_FROM` | Must be on the Resend-verified domain or sends bounce |
| `FRONTEND_ORIGIN` | Comma-separated CORS allow-list; the **first** is canonical and used in reset links |
| `COOKIE_SECURE` / `COOKIE_SAMESITE` / `COOKIE_DOMAIN` | Refresh-cookie flags. Config, never `if env == "prod"` |
| `FORWARDED_ALLOW_IPS` | Proxy peers trusted for `X-Forwarded-For`. **Never `*`** — see below |
| `DEBUG_WHOAMI` | `true` exposes `GET /debug/whoami` for the proxy audit. Off by default |
| `SENTRY_DSN` | Empty disables Sentry entirely |

**Frontend** (`frontend/.env`, or the Vercel dashboard)

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | API origin. **Baked in at build time** — changing it needs a redeploy |
| `VITE_SENTRY_DSN` | Empty disables Sentry entirely |

---

## Architecture decisions, and why

### 1. The three-way serialization split — the invariant the product is built on

The owner of a wishlist must **never** learn that an item is reserved. That is the entire
product: it protects the surprise. It is enforced with three separate Pydantic classes,
not one class with optional fields:

```
ItemAnonymousOut   id, title, image_url, accent_color, link, price, currency, note, order_index
ItemGuestOut     = ItemAnonymousOut + is_reserved + reserved_by_me
ItemOwnerOut     = ItemAnonymousOut + view_count
```

Three, not two, because **a logged-out owner is indistinguishable from a stranger**.
"Let me see how my wishlist looks to other people" is the most natural thing an owner will
ever do — they open an incognito window, and if anonymous responses carried `is_reserved`,
every owner would spoil their own surprise in week one. An anonymous viewer can't reserve
anything anyway, so the field buys them nothing and costs everything.

Why separate classes rather than `exclude=` or a conditional: a schema with escape hatches
is a schema that eventually leaks. Here, the field *does not exist on the class* — there is
no code path that can serialize it. There is also **no endpoint anywhere** that returns
reservations on items the caller owns; that route simply doesn't exist.

Pinned by tests that assert **key absence**, not values — including one that logs the owner
out and checks their own profile:

```python
assert "is_reserved" not in item_payload
assert "reserved_by_me" not in item_payload
```

A related trap, closed the same way: an *expired* owner token used to degrade silently to
anonymous, which would have served the owner the guest payload. Presenting a stale token now
returns `401` with `WWW-Authenticate: Bearer error="invalid_token"` so the client refreshes
and retries, rather than being quietly downgraded.

### 2. Refresh tokens: rotation with a 30-second grace window

Refresh tokens are opaque 32-byte values; only their SHA-256 is stored. Every `/auth/refresh`
rotates the token and revokes the old one. Presenting an **already-revoked** token is treated
as theft: the entire token family is revoked.

That's correct, and on its own it breaks real users. Browsers share one cookie jar across
tabs, so two tabs mounting at once both present the same token — and React StrictMode
double-invokes effects in development, doing it on every page load. Strict reuse detection
reads this benign race as theft and logs you out constantly.

So each token records `replaced_by_id`. Reuse of a token that was rotated **less than 30
seconds ago and has a recorded successor** is the race, not an attack: both callers converge
on one fresh token and the session survives. Outside that window, reuse still nukes the
family. This is the standard rotation-leeway tradeoff (Auth0 does the same) and it is a real
tradeoff, stated plainly: an attacker who steals a cookie and uses it within those 30 seconds
gets a valid pair instead of tripping the alarm. The alternative — logging out every user with
two tabs open — is worse.

The client half matters too: the refresh promise is **module-level and single-flight**, so
concurrent 401s, StrictMode double-mounts and parallel tabs produce exactly one network call,
coordinated across tabs with the Web Locks API.

### 3. The image pipeline runs on the client *and* the server

The client resizes to 1200px on the long edge, encodes WebP stepping quality down toward
≤800KB, and extracts the accent colour from a 32×32 downsample of the same canvas.

**Why the codec is chosen by inspecting the output, not the user agent:** `canvas.toBlob`
does not return `null` for a format it cannot encode — it silently returns a **PNG**. iOS
Safari does exactly that for WebP, and PNG is lossless, so every "step the quality down"
retry returns a byte-identical 2.5MB file. Checking `blob === null` therefore detects
nothing. The pipeline compares `blob.type` to the type it asked for, and falls back to
JPEG — never PNG — the moment they differ. That is also why the server limit is 1MB and
not 500KB: a browser with no WebP encoder legitimately sends a larger JPEG.

**Why client-side at all:** Supabase's free tier is 1GB. What lands in storage is the
server's re-encoded WebP — around 300KB — so 40 items is ~12MB/user (~80 users);
uncompressed it's ~20 users. Render's free instance also has no CPU budget to spare for
image processing.

**Why the server still re-encodes anyway** — this is the important half. The client pipeline
is an *optimisation*, never a security boundary: anything a browser does can be skipped by a
`curl`. So the server independently opens every upload with Pillow and re-saves it, which:

1. proves the bytes are a real image and not a polyglot,
2. **strips all EXIF, including GPS** — people photograph wishes at home, and without this
   their address ships inside the file,
3. enforces a hard pixel budget. A ~300KB PNG can declare 12000×12000 in its header: ~576MB
   of RGBA once decoded, on a 512MB instance. `Image.open()` is lazy, so dimensions are
   checked *before* any decode, and `MAX_IMAGE_PIXELS` is pinned to the same budget (Pillow's
   default is calibrated for a desktop, not a small container). Any Pillow failure on user
   input returns 415, never a 500.

Storage keys are immutable: `{user_id}/{item_id}/{uuid4}.webp`. Replacing a photo writes a
**new** key and deletes the old object, so a CDN can never serve a stale or deleted image from
a recycled URL. Deleting an item removes the storage object *first*, then the row — an orphaned
file is harmless, an orphaned row is not.

### 4. Why one domain, and not `*.vercel.app` + `*.onrender.com`

The refresh token lives in an httpOnly cookie. If the frontend were on `vercel.app` and the
API on `onrender.com`, that cookie would be **third-party**: Safari's ITP blocks it outright,
Brave blocks it, Chrome is narrowing it. The failure mode is nasty — it works perfectly in
desktop Chrome while every iPhone user is silently logged out after the first refresh.

`optata.app` + `api.optata.app` share a registrable domain, so `SameSite=Lax` with
`COOKIE_DOMAIN=.optata.app` is first-party everywhere. `.app` is HSTS-preloaded, so the whole
thing is HTTPS-only by construction.

### 5. No RLS, no Supabase Auth — the backend is the only door

Supabase's Data API (PostgREST) is **disabled**, and the `anon`/`authenticated` roles are
stripped of privileges on `public`. Auth is ours: argon2id + our own JWTs. The API connects
as the `postgres` role and is the only path to the data.

Why not RLS: the §4.1 invariant isn't row-level, it's **field-level and viewer-dependent** —
the same row must serialize differently for three kinds of viewer. RLS decides which *rows*
you may read; it cannot express "this column does not exist for you". Enforcing it in one
serialization layer, pinned by key-absence tests, is both truthful to the requirement and
far easier to audit than policies split across two systems.

The Storage bucket is public-read (anonymous visitors must load photos by URL), but
**listing is denied**: RLS is enabled on `storage.objects` with zero policies, so `anon` and
`authenticated` both read zero rows. Verified by impersonating the roles in the database —
`storage.search()` and `list_objects_with_delimiter()` return nothing — and over HTTP, where
the list endpoint 400s without credentials while a direct object URL still serves. The
unguessable `{uuid4}` in every key is what keeps objects private in practice.

### 6. Rate limiting keys on the *real* client IP

Limits: login 10/min, register 5/hour, forgot-password 3/hour, `POST /items` 60/hour.

Two dimensions, not one: login and forgot-password are limited **per IP and per submitted
email**. Behind a proxy or CGNAT (most mobile users in Poland and Ukraine share public IPs),
IP-only limiting either lumps everyone together or is trivially evaded. Stated tradeoff:
per-email limiting enables a targeted lockout against a known account — acceptable at these
thresholds and this scale, but a real cost, not a free win.

The client IP comes from `ProxyHeadersMiddleware` with an explicit trust list. **Never set
`FORWARDED_ALLOW_IPS=*`**: with `*`, uvicorn takes the *leftmost* — attacker-controlled —
`X-Forwarded-For` entry, which turns rate limiting into a formality. With an explicit list it
takes the rightmost untrusted entry, which is the real client. Pinned by tests asserting the
parse direction and that spoofing from an untrusted peer changes nothing.

### 7. The tag is drawn with zero measured dimensions

Every surface in the app is a *price tag*: 2px ink outline, 18px radius, offset shadow with
no blur, an angled top-left corner and a real punched hole. It's one SVG that sizes itself
via CSS percentages and a drop-shadow filter — no `ResizeObserver`, no measure-then-paint.
An earlier version measured its container first, which meant it rendered blank until layout
settled and could be starved entirely (`content-visibility` did exactly that). Now it is
correct on first paint, before any photo or layout arrives — guarded by a test that mounts it
in jsdom, where there is no layout engine at all.

---

## Operations

- **Keep-alive:** Render free sleeps after 15 minutes (~50s cold start) and Supabase pauses
  after 7 days idle. An external cron pings `GET /health` every 10 minutes; `/health` runs
  `SELECT 1`, so one ping keeps both awake. The frontend also shows an honest
  "Waking the server up…" state for any request over 3 seconds instead of a dead spinner.
- **Deleting a user** (abuse reports, GDPR-style requests):

  ```bash
  cd backend
  uv run python scripts/delete_user.py <username> --dry-run   # show, change nothing
  uv run python scripts/delete_user.py <username>             # asks for confirmation
  ```

  DB cascades handle items, reservations and tokens. Storage does **not** cascade, so the
  script deletes every object under the user's prefix first and aborts without touching the
  row if any object survives.
- **Migrations** run from the container entrypoint before uvicorn starts. If a migration
  fails the container exits non-zero, the deploy goes red, and the previous version keeps
  serving — the app never boots against an un-migrated database.
