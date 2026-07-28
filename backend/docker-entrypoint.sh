#!/bin/sh
# Migrate, then serve. Never the other way round, and never one without the
# other.
#
# `set -e` is the whole safety property: if `alembic upgrade head` exits
# non-zero, this script exits non-zero, the container dies, and Render marks
# the deploy failed and keeps routing to the previous healthy instance. The
# new code therefore CANNOT boot against an un-migrated database — the
# failure is loud (deploy goes red, logs carry the alembic traceback)
# instead of a service that starts and 500s on the first request touching a
# missing column.
#
# On Render's paid tiers this belongs in a Pre-Deploy Command, which runs
# once per deploy rather than once per container start. Free instances have
# no pre-deploy hook, so it lives here. Both give the same guarantee; the
# pre-deploy version just avoids re-running on every restart. Alembic is
# idempotent — a second `upgrade head` is a no-op — so running it at start
# is safe either way.
set -e

echo "[entrypoint] applying database migrations…"
alembic upgrade head
echo "[entrypoint] migrations at head"

# Render injects $PORT. Bind 0.0.0.0 so the platform's proxy can reach us.
# No --proxy-headers flag: ProxyHeadersMiddleware is installed in the app
# (app/main.py) so the XFF trust list comes from FORWARDED_ALLOW_IPS config
# and behaves identically however the server is launched.
echo "[entrypoint] starting uvicorn on 0.0.0.0:${PORT:-8000}"
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers 1
