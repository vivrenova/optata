# syntax=docker/dockerfile:1
#
# Why Docker and not Render's native Python runtime:
#   - uv + uv.lock give a byte-identical dependency set; the native runtime
#     would need uv bootstrapped in the build command anyway.
#   - Python is pinned here, not chosen by the platform's default.
#   - Pillow pulls prebuilt wheels for this exact interpreter/arch.
#   - The same image runs locally, so "works on Render" is reproducible.

FROM python:3.13-slim-bookworm

# uv is copied from its own distroless image — no curl|sh bootstrap
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /uvx /bin/

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

# Dependencies first: this layer is cached until the lockfile changes.
# --frozen fails the build if uv.lock and pyproject.toml disagree, so a
# deploy can never silently resolve a different dependency set.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
COPY scripts ./scripts
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && uv sync --frozen --no-dev

# Non-root. Done after the copies so the app tree isn't writable by the
# runtime user — nothing in this image should be modifying its own code.
RUN useradd --create-home --uid 10001 optata
USER optata

EXPOSE 8000

# The entrypoint runs migrations and only then execs uvicorn — see the
# script for why the ordering is a hard guarantee, not a convention.
ENTRYPOINT ["./docker-entrypoint.sh"]
