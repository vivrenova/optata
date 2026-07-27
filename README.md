# OPTATA

Твої хотілки як колода карток, а не як таблиця в Google Docs.

Один вішліст на людину: додаєш хотілки (фото + назва), кидаєш лінк — друзі гортають
колоду карток і тихо бронюють подарунки. Власник ніколи не бачить броні.

**Статус:** Stage 0 (скелет). Специфікація: `01-concept-v1.md`, `02-tech-spec.md`.

## Стек

- **Frontend:** React 19 · Vite · TypeScript (strict) · Tailwind v4 · Framer Motion → Vercel
- **Backend:** FastAPI · SQLAlchemy 2.0 (async) · Alembic · Pydantic v2 → Render
- **Data:** Supabase Postgres + Storage · Resend (email)

## Локальний запуск

### Backend

```sh
cd backend
cp .env.example .env   # заповнити DATABASE_URL (Supabase Postgres) і JWT_SECRET
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8000
```

`GET /health` → `{"status":"ok"}` (робить `SELECT 1` у БД).

### Frontend

```sh
cd frontend
cp .env.example .env   # VITE_API_URL, за замовчуванням localhost:8000
npm install
npm run dev
```

## Структура

```
backend/    FastAPI застосунок, Alembic міграції
frontend/   Vite SPA, дизайн-токени в src/index.css (@theme)
```
