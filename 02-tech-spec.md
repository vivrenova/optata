# Wishlist v1.0 — Tech Spec

**Стек:** React + Vite + TS + Tailwind v4 + Framer Motion (Vercel) · FastAPI + SQLAlchemy 2.0 + Alembic (Render) · Supabase Postgres + Supabase Storage · Resend (email).

---

## 0. Три інфраструктурні міни. Прочитай перед тим, як писати код.

### 0.1. Cross-site cookie — вб'є твій auth на Safari/iOS

Ти обрав refresh token у httpOnly cookie. Правильно. Але: фронт на `*.vercel.app`, бек на `*.onrender.com` — це **різні registrable domains**. Cookie, яку ставить `onrender.com`, коли сторінка на `vercel.app`, — це **third-party cookie**. Safari ITP блокує їх повністю. Brave блокує. Chrome ріже.

Результат: ти протестуєш у Chrome на десктопі, все запрацює, ти зрадієш, кинеш лінк другу з iPhone — і в нього логін розвалиться після першого рефрешу.

**Два виходи:**

| Варіант | Як | Ціна |
|---|---|---|
| **A (правильний)** | Купити домен. `wishlist.xyz` → Vercel, `api.wishlist.xyz` → Render. Один site → `SameSite=Lax`, нуль third-party проблем. | ~$10/рік |
| **B (безкоштовний)** | Vercel rewrite: `vercel.json` → `/api/:path*` проксює на Render. Cookie стає first-party для `vercel.app`. | +50–150ms latency |

**Рішення: A.** Купуй домен зараз, не на 20-й день. Він все одно потрібен для портфоліо. B — тільки якщо домен затримується.

### 0.2. Render free tier засинає

Free instance спить після 15 хв без трафіку. Перший запит після сну = **~50 секунд** холодного старту. Ти кидаєш лінк другу, він відкриває — і 50 секунд дивиться на спіннер. Він закриє вкладку.

**Рішення:** або $7/міс за Starter, або зовнішній cron-пінгер (`/health` кожні 10 хв). Для v1.0 — пінгер, але **фронт мусить показати чесний стан**: якщо запит іде >3с, показуємо «Будимо сервер…», а не мертвий спіннер.

### 0.3. Supabase free пауза

Проєкт паузиться після 7 днів нульової активності. Пінгер з п.0.2 закриває і це, якщо `/health` реально торкається БД (`SELECT 1`).

---

## 1. Схема БД

```sql
-- users
id                    UUID PK        DEFAULT gen_random_uuid()
email                 CITEXT         UNIQUE NOT NULL
password_hash         TEXT           NOT NULL          -- argon2id
username              CITEXT         UNIQUE NOT NULL   -- ^[a-z0-9_]{3,20}$
username_changed_at   TIMESTAMPTZ    NULL              -- зміна не частіше 1/30 днів
display_name          VARCHAR(40)    NULL
bio                   VARCHAR(160)   NULL
avatar_url            TEXT           NULL
avatar_path           TEXT           NULL
is_discoverable       BOOLEAN        NOT NULL DEFAULT FALSE   -- заділ на Explore (v1.1), у v1.0 не використовується
created_at            TIMESTAMPTZ    NOT NULL DEFAULT now()
updated_at            TIMESTAMPTZ    NOT NULL DEFAULT now()

-- items
id            UUID PK
user_id       UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE
title         VARCHAR(80)    NOT NULL
image_url     TEXT           NOT NULL
image_path    TEXT           NOT NULL   -- ключ у Supabase Storage, потрібен для видалення
accent_color  CHAR(7)        NOT NULL DEFAULT '#D6D6D1'   -- #RRGGBB
link          VARCHAR(2048)  NULL       -- тільки http/https
price         NUMERIC(12,2)  NULL
currency      CHAR(3)        NULL       -- UAH | USD | EUR | PLN
note          VARCHAR(280)   NULL
order_index   INTEGER        NOT NULL
view_count    INTEGER        NOT NULL DEFAULT 0
created_at    TIMESTAMPTZ    NOT NULL DEFAULT now()
updated_at    TIMESTAMPTZ    NOT NULL DEFAULT now()

CHECK ((price IS NULL) = (currency IS NULL))
CHECK (price IS NULL OR price >= 0)
INDEX ix_items_user_order ON items(user_id, order_index)

-- reservations
id           UUID PK
item_id      UUID  NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE  -- UNIQUE = одна бронь на айтем
reserver_id  UUID  NOT NULL REFERENCES users(id) ON DELETE CASCADE
created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
INDEX ix_reservations_reserver ON reservations(reserver_id)
-- Заборона бронювати свій айтем — на рівні застосунку (перевірка item.user_id != current_user.id).

-- refresh_tokens  (ротація + відкликання)
id          UUID PK
user_id     UUID  NOT NULL REFERENCES users(id) ON DELETE CASCADE
token_hash  TEXT  NOT NULL UNIQUE     -- sha256 від сирого токена, сирий не зберігаємо
expires_at  TIMESTAMPTZ NOT NULL
revoked_at  TIMESTAMPTZ NULL
created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
INDEX ix_refresh_user ON refresh_tokens(user_id)

-- password_reset_tokens
id          UUID PK
user_id     UUID  NOT NULL REFERENCES users(id) ON DELETE CASCADE
token_hash  TEXT  NOT NULL UNIQUE
expires_at  TIMESTAMPTZ NOT NULL      -- now() + 1 година
used_at     TIMESTAMPTZ NULL
created_at  TIMESTAMPTZ NOT NULL DEFAULT now()

-- item_view_sessions  (унікальність переглядів)
item_id       UUID  NOT NULL REFERENCES items(id) ON DELETE CASCADE
session_hash  TEXT  NOT NULL          -- sha256(anon_id cookie | user_id)
created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
PRIMARY KEY (item_id, session_hash)
-- INSERT ... ON CONFLICT DO NOTHING; якщо вставилось → UPDATE items SET view_count = view_count + 1
-- Чистити рядки старші 90 днів (руками або cron).
```

**Ліміт 40 айтемів:** перевірка в сервісному шарі перед `INSERT` (`SELECT COUNT(*) ... FOR UPDATE` на юзері, або просто count + унікальний constraint на `(user_id, order_index)` як страховка від гонок).

---

## 2. Auth-модель

- **Хеш пароля:** argon2id (`passlib[argon2]`). Не bcrypt.
- **Access token:** JWT, TTL **15 хв**, живе **тільки в пам'яті JS** (React context). Ніколи не в `localStorage`.
- **Refresh token:** випадкові 32 байти → httpOnly, `Secure`, `SameSite=Lax` (за умови п.0.1 варіант A), TTL **30 днів**, path `/auth`.
- **Ротація:** кожен `/auth/refresh` відкликає стару і видає нову. Якщо прийшов уже відкликаний токен → **відкликаємо всі токени юзера** (виявлено крадіжку).
- **Bootstrap при завантаженні сторінки:** фронт одразу б'є `/auth/refresh`. Є cookie → отримав access, юзер залогінений. Немає → гість. Ніяких «мигань» логіну.
- **Reset password:** `/auth/forgot-password` **завжди повертає 200**, незалежно від того, чи існує email (інакше це enumeration-оракул). Токен — 32 випадкові байти, у БД зберігається `sha256`, TTL 1 год, одноразовий. Успішний reset → відкликати всі refresh-токени юзера.
- **Помилки логіну:** завжди «Невірний email або пароль». Ніколи не «такого юзера немає».
- **Rate limit** (slowapi, in-memory — Render single instance, цього досить):
  - `/auth/login` — 10/хв на IP
  - `/auth/register` — 5/год на IP
  - `/auth/forgot-password` — 3/год на IP
  - `POST /items` — 60/год на юзера (більше за ліміт 40, інакше 409 недосяжний і новий юзер ловить 429 на 31-му айтемі; задача ліміту — тільки обмежити churn create/delete/create)

---

## 3. Робота із зображеннями

**Клієнт:**
1. Читає файл, рендерить у `<canvas>`, ресайзить до max 1200px по довшій стороні.
2. Експорт → **WebP**, quality 0.82. Ціль ≤300KB.
3. Витягує акцентний колір з того ж canvas (даунсемпл до 32×32 → квантизація → домінантний колір, відкидаючи майже-білі/майже-чорні). Шле готовий hex.
4. Показує превʼю до аплоаду.

**Чому клієнт:** Supabase free = 1GB storage. 40 айтемів × 300KB = 12MB/юзер → ~80 юзерів. Без стиснення — 20. Плюс Render free не має ресурсу молотити зображення.

**Сервер:**
1. Приймає multipart. Ліміт **500KB**. Content-type whitelist: `image/webp`, `image/jpeg`, `image/png`.
2. **Відкриває через Pillow і перезберігає у WebP.** Це не косметика: перезбереження (а) валідує, що це реальне зображення, а не полігліт, (б) **зриває EXIF, включно з GPS-координатами**. Юзер зафоткав хотілку вдома — і без цього в metadata поїде його адреса.
3. Кладе в Supabase Storage, bucket `items` (public), шлях `{user_id}/{item_id}.webp`.
4. Валідує `accent_color` регуляркою `^#[0-9A-Fa-f]{6}$`, інакше — дефолт.

**Видалення айтема:** спершу файл зі Storage за `image_path`, потім рядок. Якщо файл не видалився — логуємо і все одно видаляємо рядок (осиротілий файл не страшний, осиротілий рядок — страшний).

---

## 4. API

Усі відповіді — JSON. Помилки — `{"detail": "..."}`.

### Auth
```
POST   /auth/register           {email, username, password}  → 201, access + set-cookie
POST   /auth/login              {email, password}            → 200, access + set-cookie
POST   /auth/refresh            (cookie)                     → 200, access + rotate cookie
POST   /auth/logout             (cookie)                     → 204, revoke + clear cookie
POST   /auth/forgot-password    {email}                      → 200 ЗАВЖДИ
POST   /auth/reset-password     {token, new_password}        → 204
GET    /auth/me                 (bearer)                     → 200 UserPrivate
```

### Users
```
GET    /users/check-username?username=  → {available: bool}
GET    /users/search?q=                 → [UserPublic]  (prefix, limit 10)
GET    /users/{username}                → ProfileResponse    ← публічний, auth опційний
PATCH  /users/me                        {display_name?, bio?, username?}
POST   /users/me/avatar                 multipart
PATCH  /users/me/password               {current_password, new_password}
```

### Items
```
POST   /items                  multipart: image, title, link?, price?, currency?, note?, accent_color
PATCH  /items/{id}             (власник) — поля + опційно нове image
DELETE /items/{id}             (власник)
PUT    /items/reorder          {ordered_ids: [uuid]}   ← має містити РІВНО всі айтеми юзера
POST   /items/views            {item_ids: [uuid]}      ← батч, auth опційний, ідемпотентно
```

### Reservations
```
POST   /items/{id}/reserve     (bearer) → 201 | 409 якщо вже заброньовано | 403 якщо свій
DELETE /items/{id}/reserve     (bearer) → 204, тільки свою бронь
GET    /reservations           (bearer) → [ReservationResponse]
```

### 4.1. Найважливіше правило серіалізації

**Три погляди на айтем — ТРИ окремі Pydantic-схеми.** Це не косметика — це вся суть продукту. Один недогляд, і власник бачить свої броні.

Чому три, а не дві: розлогінений власник (або власник в інкогніто — «подивлюсь, як мій вішліст виглядає для інших» зробить кожен) для сервера невідрізнимий від незнайомця. Якби анонім бачив `is_reserved`, кожен власник побачив би свої броні в перший же тиждень. Анонім і так не може бронювати — стан броні йому нічого не дає.

```
ItemAnonymousOut (неавторизований — база):
  id, title, image_url, accent_color, link, price, currency, note, order_index
  is_reserved / reserved_by_me    ← НІ. Полів не існує на класі.
  view_count                      ← НІ.

ItemGuestOut (авторизований, НЕ власник) = ItemAnonymousOut +
  is_reserved: bool
  reserved_by_me: bool

ItemOwnerOut (власник) = ItemAnonymousOut +
  view_count: int
```

Робиться **трьома окремими схемами** (успадкування від `ItemAnonymousOut`), а не одною з `if`-ами і `exclude`. Схема-з-екскейпами — це та, з якої колись витече поле.

UX для аноніма: стану «Уже дарують» не видно; клік «Я це дарую» веде на логін, і вже після логіну підвантажується справжній стан броні.

Плюс: власник ніколи не має ендпоінта, що повертає броні на його айтеми. Такого роута просто не існує.

---

## 5. Екрани і стани

| # | Route | Що | Стани |
|---|---|---|---|
| 1 | `/` | Лендінг: заголовок + **живе демо shuffle на фейкових даних** (працює без реєстрації) + CTA | залогінений → редірект на свій профіль |
| 2 | `/login` | | idle · loading · помилка · «сервер прокидається» (>3с) |
| 3 | `/register` | username з live-перевіркою доступності (debounce 400ms) | idle · перевірка · зайнято · вільно · loading |
| 4 | `/forgot-password` | | idle · відправлено (завжди успіх) |
| 5 | `/reset-password?token=` | | валідний · токен протух · токен використаний |
| 6 | `/u/{username}` | **Ядро.** Shuffle overlay → grid | skeleton · shuffle · grid · 0 айтемів · 1 айтем · 404 юзера |
| 7 | `/u/{username}` (модалка) | Деталі айтема: фото, ціна, нотатка, лінк, кнопка броні / edit | гість · власник · заброньовано іншим · заброньовано мною |
| 8 | `/settings` | display name, bio, avatar, username (з локом 30 днів), зміна пароля, тумблер «показувати shuffle на моєму профілі» | |
| 9 | `/reservations` | Що я забронював | порожньо · список · «предмет видалено» |
| 10 | `/search?q=` | Пошук по username | порожньо · нічого не знайдено · результати |
| 11 | `*` | 404 | |

**Порожній стан профілю (0 айтемів):**
- Свій: «Тут порожньо. Додай першу хотілку» + велика кнопка.
- Чужий: «{username} ще нічого не додав.» І все. Без жалю, без емодзі.

**Ліміт 40:** кнопка «Додати» → disabled + підпис «40 з 40. Видали щось, щоб додати нове.»

---

## 6. Design system

**Метафора:** цінник / подарунковий ярлик. Картка — це **тег**, не «картка застосунку».

### Токени

```css
--paper:        #E4E3DE;   /* холодний бетон, не крем */
--paper-deep:   #D5D4CE;   /* поглиблення, скелетони */
--ink:          #131311;   /* контур, текст */
--ink-soft:     #6B6A64;   /* вторинний текст */
--electric:     #2E22E0;   /* ЄДИНИЙ статичний акцент. Тільки primary actions. Не terracotta. */
--danger:       #C7300B;
--accent:       (динамічний, з фото — фон картки)

--border:       2px solid var(--ink);
--radius:       18px;
--shadow:       5px 5px 0 var(--ink);       /* зсув, БЕЗ блюру */
--shadow-lift:  8px 8px 0 var(--ink);       /* hover/drag */
```

Чому не крем `#F4F1EA` + terracotta: це дефолтна AI-палітра, її видно за версту. Холодний бетон дає ще й практичну перевагу — витягнуті з фото акцентні кольори на ньому б'ють сильніше, ніж на теплому кремі.

### Шрифти

- **Display:** `Bricolage Grotesque` (variable) — заголовки, назви айтемів. Кремезний, з характером.
- **Body:** `Inter` — усе інше.
- **Utility:** `JetBrains Mono` — **ціни, лічильники переглядів, валюта, username**. Моно для цін — це не примха, це прив'язка до вернакуляру цінника/чека.

### Signature element — тег

Кожен айтем: жорсткий контур 2px, радіус 18px, зсунута тінь 5px без блюру, **пробитий отвір угорі** (маленьке коло контуром) — як на паперовому ярлику. **Фото — герой; accent — trim, не заливка** (рішення 18.07.2026): фон тега — папір; `accent_color` з'являється лише у grommet-смузі та як 2px внутрішня рамка фото, і ПЕРЕД використанням приглушується (сатурація ×0.5 з капом 40%, lightness підтягується до paper у смугу 62–80%) — неоново-малинове фото дає запилено-бузковий trim. Поки фото вантажиться або якщо не завантажилось — приглушений accent заливає тіло як fallback (картка ніколи не порожня, ніяких broken-icon). Без blur/backdrop фото — дешево виглядає і роняє fps на середньому Android.

- **Shuffle-картка:** фіксований портрет 3:4. Фото заповнює кадр (`object-fit: cover`).
- **Grid:** masonry, картки зберігають пропорції фото.

### Motion (Framer Motion)

- **Роздача картки:** з-під низу, `scale 0.94 → 1`, легкий rotate `-2deg → 0`. Spring `{ stiffness: 260, damping: 26 }`.
- **Свайп:** drag по X, rotate пропорційно зсуву (макс ±12°). Fling при velocity > 400 або зсуві > 35% ширини.
- **Клік/стрілка на десктопі:** картка вилітає вбік з тим самим rotate.
- **Перехід shuffle → grid:** колода їде вгору і зменшується, grid проступає під нею стаггером (30ms на картку, макс 10 карток анімовано — далі просто фейд).
- **Reduced motion:** `prefers-reduced-motion` → усі трансформи вимикаються, лишається fade 120ms. Без варіантів.

### Продуктивність

- Рендеримо **тільки 3 верхні картки** колоди. Решта — не в DOM.
- Preload зображення наступної картки.
- `will-change: transform` тільки на активній картці.
- Grid — `content-visibility: auto` на картках нижче фолда.
- Цільові 60fps на середньому Android. Якщо лагає — ріжемо тіні на анімації, не motion.

### Копірайтинг (тон)

Активний стан, sentence case, без вибачень. «Створити свій вішліст», не «Submit». Помилка каже, **що зламалось і що робити**, а не «Something went wrong». Порожній екран — це запрошення до дії, а не настрій.
