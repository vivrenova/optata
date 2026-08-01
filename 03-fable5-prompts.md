# Fable 5 — Staged Build Prompts

## Як цим користуватися

**Промпти англійською навмисно.** Специфікація для моделі — це не спілкування, це технічне завдання: англійською вона точніша, і немає ризику, що якийсь термін перекладеться криво.

**Шість етапів. Один етап = одна сесія.** Не давай усе разом — отримаєш 4000 рядків, з яких половина не збирається, і ти будеш дебажити чуже, замість писати своє.

**Перед кожним етапом:** прикріпи `01-concept-v1.md` і `02-tech-spec.md`.

**Після кожного етапу — ТИ запускаєш і перевіряєш acceptance criteria руками.** Не «виглядає ок». Реально клікаєш. Якщо не проходить — не йдеш далі.

---

## Stage 0 — Repo scaffold

```
You are building a wishlist web app. I've attached the concept doc and tech spec — read
both fully before writing anything.

TASK: Set up the monorepo skeleton only. No features.

Structure:
  /backend   FastAPI + SQLAlchemy 2.0 (async) + Alembic + Pydantic v2 + uv
  /frontend  React 19 + Vite + TypeScript (strict) + Tailwind v4 + Framer Motion

Backend must include:
- pydantic-settings config reading from env: DATABASE_URL, JWT_SECRET, SUPABASE_URL,
  SUPABASE_SERVICE_KEY, RESEND_API_KEY, FRONTEND_ORIGIN, COOKIE_DOMAIN
- async SQLAlchemy engine + session dependency
- Alembic wired to the async engine
- CORS configured for FRONTEND_ORIGIN with allow_credentials=True (this matters — the
  refresh token is an httpOnly cookie)
- GET /health that runs SELECT 1 against the DB and returns {"status":"ok"}
- Structured logging, no print()

Frontend must include:
- Tailwind v4 with the design tokens from tech-spec §6 defined as CSS custom properties
  in a single @theme block
- Fonts: Bricolage Grotesque (display), Inter (body), JetBrains Mono (utility) — loaded
  via fontsource, self-hosted, not Google CDN
- React Router with the routes from tech-spec §5, all rendering placeholder components
- An api client module (fetch wrapper) with credentials:'include' and a place for the
  in-memory access token — no implementation yet, just the shape
- .env.example

ACCEPTANCE:
- `uv run alembic upgrade head` succeeds against a fresh Postgres
- GET /health returns ok
- `npm run build` passes with zero TS errors
- Every route renders without crashing

DO NOT: write any models, any auth, any UI beyond placeholders. Do not install a UI
component library. Do not add state management beyond React context.
```

---

## Stage 1 — Backend: models + auth

```
Continue the wishlist app. Attached: concept doc, tech spec.

TASK: All database models and the complete auth system.

Implement exactly the schema in tech-spec §1 (users, items, reservations,
refresh_tokens, password_reset_tokens, item_view_sessions) as SQLAlchemy 2.0 models
with mapped_column typing, plus one Alembic migration. Enable the citext extension.

Auth per tech-spec §2. The non-obvious parts, do not improvise on these:
- argon2id via passlib, not bcrypt
- Access JWT, 15 min TTL, returned in the response BODY (never a cookie)
- Refresh token: 32 random bytes, sha256 stored in DB, raw value in an httpOnly +
  Secure + SameSite=Lax cookie scoped to path /auth, 30 day TTL
- Rotation on every /auth/refresh. If a token that is already revoked is presented,
  revoke ALL refresh tokens for that user — that's a theft signal, not an error
- /auth/forgot-password returns 200 unconditionally, whether or not the email exists.
  Never leak account existence.
- Login failure message is identical for "no such user" and "wrong password"
- Password reset token: 32 random bytes, sha256 in DB, 1 hour TTL, single-use.
  Successful reset revokes all of that user's refresh tokens.
- Send the reset email via Resend. Plain, short, one link.
- Rate limits via slowapi, exactly the numbers in tech-spec §2

Endpoints: the full /auth/* and /users/* blocks from tech-spec §4, except avatar upload
(that comes in Stage 2 with the image pipeline).

Username rules: ^[a-z0-9_]{3,20}$, case-insensitive unique, changeable at most once
per 30 days (enforce using username_changed_at, return 429 with a clear message).

Tests (pytest + httpx AsyncClient, real Postgres via testcontainers or a test DB):
- register → login → refresh → logout happy path
- reused refresh token nukes the whole token family
- forgot-password returns 200 for an email that does not exist
- username uniqueness is case-insensitive ("Bohdan" collides with "bohdan")
- username change is blocked inside the 30-day window

ACCEPTANCE: all tests green; migration applies cleanly to an empty DB.

DO NOT: add email verification. Do not add OAuth. Do not put the access token in a
cookie. Do not store any raw token in the database.
```

---

## Stage 2 — Backend: items, images, reservations, views

```
Continue the wishlist app. Attached: concept doc, tech spec.

TASK: Items CRUD, the image pipeline, reservations, view counting.

=== THE ONE THING THAT MUST NOT BREAK ===
Read tech-spec §4.1. The owner of a wishlist MUST NEVER learn that an item is reserved.
That is the entire point of the product — it protects the surprise.

Implement this with TWO SEPARATE Pydantic schemas:
  ItemOwnerOut  → has view_count. Has NO is_reserved, NO reserved_by_me. The fields do
                  not exist on the class.
  ItemGuestOut  → has is_reserved and reserved_by_me. Has NO view_count.

Do NOT use a single schema with conditional exclude/model_dump(exclude=...). A schema
with escape hatches is a schema that eventually leaks. There must also be no endpoint
anywhere that returns reservations on items the caller owns.
=========================================

Items:
- Hard limit 40 per user. Enforce in the service layer before insert. 41st returns 409
  with a message the UI can show directly.
- POST /items is multipart. Server pipeline:
    1. reject > 1MB; content-type whitelist webp/jpeg/png. (1MB, not 500KB: a browser
       with no WebP encoder sends JPEG, which is bigger. The decompression-bomb guard is
       the pixel budget below, not this limit.)
    2. open with Pillow, re-encode to WebP q=82 — this validates it is a real image AND
       strips EXIF including GPS. Non-negotiable: users photograph things at home.
    3. upload to Supabase Storage bucket "items", key {user_id}/{item_id}.webp
    4. store both image_url and image_path (path is needed to delete later)
- accent_color comes from the client. Validate ^#[0-9A-Fa-f]{6}$, else fall back to
  the --paper-deep default.
- DELETE /items/{id}: delete the storage object first, then the row. If storage deletion
  fails, log it and delete the row anyway — an orphaned file is harmless, an orphaned
  row is not.
- PUT /items/reorder takes the full ordered id list and must reject any list that is not
  exactly the set of that user's items (no partial reorders, no foreign ids).

Reservations:
- Authenticated users only
- One reservation per item (DB unique constraint on item_id, not just app logic)
- 403 if reserving your own item
- 409 if already reserved
- GET /reservations returns the caller's reservations. Items deleted by their owner must
  surface as a tombstone entry, not vanish silently.

Views:
- POST /items/views takes a batch of item ids, auth optional
- Identity = sha256 of an anonymous session cookie (set it if absent, 1 year, httpOnly),
  or of the user id when logged in
- INSERT INTO item_view_sessions ... ON CONFLICT DO NOTHING; increment items.view_count
  only when a row was actually inserted
- Idempotent, no bot protection, must never error the caller

Tests:
- 41st item is rejected
- guest payload for an item contains no view_count key at all
- owner payload for a reserved item contains no is_reserved key at all
- reserving twice → 409; reserving own item → 403
- posting the same view batch twice increments view_count exactly once
- uploaded JPEG with EXIF GPS comes back out as WebP with no EXIF

ACCEPTANCE: all tests green. Manually confirm in the DB that a reserved item, fetched by
its owner, produces JSON with no reservation-related key.

DO NOT: fetch or parse the item's link URL. No OG tags, no scraping. Out of scope.
```

---

## Stage 3 — Frontend: design system + shell + auth

```
Continue the wishlist app. Attached: concept doc, tech spec (read §6 Design system in
full — it is prescriptive, follow it exactly, do not substitute your own palette).

TASK: The visual foundation and every auth screen.

Design system, built as primitives in /components/ui:
- The signature element is a TAG — a price tag / gift tag. Hard 2px ink border, 18px
  radius, 5px 5px 0 offset shadow with NO blur, and a punched hole (small outlined
  circle) at the top. Everything in this app is a variation of that tag.
- Palette exactly as specified: cold concrete paper #E4E3DE, ink #131311, one static
  electric accent #2E22E0 used ONLY for primary actions. The chrome is a stage, not an
  actor — the color comes from users' photos.
- Bricolage Grotesque for display, Inter for body, JetBrains Mono for prices/counters/
  usernames.
- Primitives: Tag (the base surface), Button (primary/secondary/ghost/danger), Input,
  TextArea, Select, Modal, Toast, Skeleton, EmptyState.

Auth layer:
- AuthContext holding the access token IN MEMORY ONLY. Never localStorage, never
  sessionStorage.
- On app mount, immediately call POST /auth/refresh. Cookie present → we're logged in.
  Absent → guest. The user must never see a flash of the logged-out UI.
- The api client: on 401, attempt one refresh, retry once, then hard logout.
  Concurrent 401s must share a single refresh promise, not fire N refreshes.
- Render's free tier sleeps and cold-starts in ~50 seconds. If any request exceeds 3s,
  show "Waking the server up…" instead of a spinner that looks broken. This is a real UX
  requirement, not a nicety.

Screens: /login, /register, /forgot-password, /reset-password?token=
- Register does live username availability checking, debounced 400ms, with clear
  available / taken / checking states
- Every screen has explicit loading, error, and success states. Errors say what broke and
  what to do about it. Never "Something went wrong."
- Copy is sentence case, active voice, no apologies, no emoji.

Quality floor, no exceptions: responsive to 360px, visible keyboard focus rings,
prefers-reduced-motion respected, all form fields properly labelled.

ACCEPTANCE:
- Register → logout → login → hard refresh of the page keeps you logged in
- Every auth screen looks correct at 360px wide
- Tab through every form with the keyboard; focus is always visible

DO NOT: build the profile, the shuffle, or item management yet. Do not add a component
library. Do not use a cream background or a terracotta accent.
```

---

## Stage 4 — Frontend: the shuffle deck + grid

```
Continue the wishlist app. Attached: concept doc, tech spec.

TASK: /u/{username} — the core of the product. This screen is the reason the app exists.
Spend your effort here.

Flow:
1. Land on a profile → a single random item appears immediately as a full-screen tag card
2. Advance → next item. The deck is SHUFFLED WITHOUT REPEATS (Fisher-Yates on the client
   at mount — the client already has all ≤40 items, the server does nothing here)
3. Exhaust the deck, OR press "Show everything" → the deck lifts away and the full
   profile grid is revealed underneath
4. Deck state is NOT persisted between sessions. Every visit is a fresh shuffle.

Rules:
- 0 items → no shuffle at all, straight to the profile with an empty state
- 1 item → no shuffle at all (a one-card deck is absurd), straight to the profile
- Own profile → shuffle runs too, but the owner gets a "Don't show me shuffle on my own
  profile" toggle persisted in localStorage

Controls:
- Mobile: drag to swipe. Rotation proportional to horizontal offset, max ±12°. Flings on
  velocity > 400 or offset > 35% of width. It must feel like throwing a card, not
  dismissing a modal.
- Desktop: click the card, or arrow keys, or space
- Either: tap/click the card body → item detail modal

Card (the tag):
- Fixed 3:4 portrait frame. Photo object-fit: contain. The letterbox area is filled with
  that item's accent_color. This is why one photo works in both the deck and the grid.
- Title in Bricolage Grotesque. Price in JetBrains Mono.
- If reserved and the viewer is NOT the owner: an ink diagonal hatch overlay plus the
  label "Already being gifted". No name, ever.
- If the viewer IS the owner: a small view counter in mono. And absolutely no reservation
  indicator — the API doesn't even send the field.

Grid:
- Masonry. Cards keep their photo's aspect ratio. Each is a tag.
- Owner: drag & drop reorder, optimistic, PUT /items/reorder on drop, revert on failure.

Motion (Framer Motion, tech-spec §6):
- Deal: from below, scale 0.94→1, rotate -2°→0. Spring stiffness 260, damping 26.
- Deck → grid: the deck lifts and shrinks; grid staggers in beneath, 30ms per card,
  animate at most 10 cards then just fade the rest.
- prefers-reduced-motion → all transforms off, 120ms fade only.

Performance — this is a hard requirement, not advice:
- Only the top 3 cards of the deck are in the DOM. Not 40.
- Preload the next card's image.
- will-change: transform ONLY on the actively dragged card.
- Target 60fps on a mid-range Android. If it drops, cut shadow rendering during the
  animation — never cut the motion itself.

Views: as cards are shown in the deck and as detail modals open, collect item ids and
POST /items/views in a debounced batch. Grid impressions do not count as views.

ACCEPTANCE:
- Swipe 40 cards on a real phone with zero jank and zero repeats before the deck ends
- Reload the page → a different order
- Log in as the owner → no reservation state visible anywhere, and Network tab confirms
  the API never sent it
- Turn on prefers-reduced-motion → still fully usable

DO NOT: fetch the deck order from the server. Do not persist deck progress. Do not use a
carousel library.
```

---

## Stage 5 — Frontend: items, settings, reservations, search, landing

```
Continue the wishlist app. Attached: concept doc, tech spec. Final feature stage.

TASK: Everything that remains.

Item create/edit modal:
- Fields: photo (required), title (required), link, price + currency (UAH/USD/EUR/PLN),
  note. Optional fields are visually secondary — the photo is the hero.
- Client-side image pipeline, all before upload:
    1. resize to max 1200px on the long edge via canvas
    2. export WebP, stepping quality down toward ≤800KB. Where the browser cannot encode
       WebP (iOS Safari), fall back to JPEG — never PNG, which is lossless and ignores the
       quality argument. Detect support from the produced blob's own type: toBlob returns
       a PNG, not null, for a format it cannot write. Never sniff the user agent.
    3. extract the accent colour from the same canvas: downsample to 32×32, quantize,
       pick the dominant colour, discarding near-white and near-black. Send the hex.
    4. show a live preview, with the extracted colour already applied as the tag
       background, before the user hits save
- At 40 items the add button is disabled with "40 of 40. Delete something to add more."
- Delete asks for confirmation. Deletion is permanent.

/settings: display name, bio, avatar, username (show the 30-day lock clearly when it
applies), change password, and the "show shuffle on my own profile" toggle.

/reservations: what I've reserved. Items their owner deleted appear as a tombstone —
"This item was removed" — not silently missing.

/search: username prefix search in the header. Empty, no-results, and results states.

/ (landing): one screen. A headline, a LIVE working shuffle demo running on hardcoded
fake items — a stranger must be able to feel the core interaction in three seconds
without signing up — and one call to action. Logged-in users get redirected to their own
profile. Keep it simple; the demo IS the pitch, so nothing should compete with it.

ACCEPTANCE:
- Upload a 6MB JPEG → what lands in storage is a WebP under 300KB
- The extracted accent colour looks right for at least 10 varied photos
- Reorder items, hard refresh, order persists
- The landing shuffle demo works with JavaScript-only, no network calls

DO NOT: add categories, tags, sorting, or filtering. The unsorted mess is the product.
```

---

## Stage 6 — Ship

```
Continue the wishlist app. Final stage: production readiness.

1. DEPLOY
   - Backend → Render (Dockerfile, alembic upgrade head on release)
   - Frontend → Vercel
   - Postgres + Storage → Supabase
   - Custom domain: app on the apex, API on api.<domain>. This is REQUIRED, not
     cosmetic: with the frontend on *.vercel.app and the API on *.onrender.com the
     refresh cookie is a third-party cookie, and Safari/iOS blocks it outright — auth
     will silently break for every iPhone user. Same registrable domain → SameSite=Lax
     works. Configure COOKIE_DOMAIN and CORS accordingly.
   - Render's free tier sleeps after 15 minutes. Add an external cron pinging /health
     every 10 minutes — /health must touch the DB, which also keeps Supabase from
     auto-pausing after 7 days idle.

2. HARDENING
   - Security headers: CSP, HSTS, X-Content-Type-Options, Referrer-Policy
   - Confirm rate limits are live in production
   - Set FORWARDED_ALLOW_IPS for Render's proxy. Never "*" — with "*" uvicorn's
     middleware takes the LEFTMOST (attacker-controlled) X-Forwarded-For entry.
     Verify the value with audit item f) before trusting it.
   - Confirm the Supabase service key is never exposed to the client
   - Sentry (free tier) on both ends

3. FINAL AUDIT — go through these by hand, in a real browser, and report the result of
   each one:
   a) Log in as a wishlist owner whose items are reserved. Open DevTools → Network.
      Confirm no response body anywhere contains is_reserved or reserved_by_me.
   b) Log in on a real iPhone (Safari). Log in, close the tab, reopen. Still logged in?
   c) Upload a photo taken on a phone with location services on. Download the stored
      file. Confirm zero EXIF, zero GPS.
   d) Full flow on a mid-range Android at 360px: register, add 5 items, share the link,
      open it in a private window, shuffle, reserve.
   e) Turn on prefers-reduced-motion. The whole app remains usable.
   f) Set DEBUG_WHOAMI=true on Render. From a phone on MOBILE DATA hit
      GET /debug/whoami: resolved_client_host must equal the phone's real
      public IP (compare with a what-is-my-ip service). Then curl the same
      URL with a spoofed X-Forwarded-For — the resolved host must NOT become
      the spoofed value. Set DEBUG_WHOAMI=false when done.

4. README: what it is, one screenshot, the stack, local setup, env vars, architecture
   decisions and why (write this one properly — it is what a recruiter actually reads).
```

---

## Правила гри з моделлю

1. **Не приймай перший результат мовчки.** Прочитай код. Якщо не розумієш рядок — питай, що він робить. Це твій портфоліо-проєкт, на співбесіді питатимуть тебе, а не Fable.
2. **Кожен етап — окремий PR.** Мержиш тільки коли acceptance criteria пройдені руками.
3. **Якщо модель додала фічу, якої немає в спеці — видаляй.** Без обговорення. Scope creep від моделі — це той самий scope creep.
4. **Stage 4 — найважливіший.** Якщо там вийшло погано, весь проєкт нікчемний, бо це єдине, що відрізняє його від 500 інших вішлістів на GitHub. Не жалій на нього часу і не бійся переробити двічі.
