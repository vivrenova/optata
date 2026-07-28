from contextlib import asynccontextmanager

import structlog
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.base import BaseHTTPMiddleware
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.config import get_settings
from app.db import engine, get_db
from app.logging_config import configure_logging
from app.rate_limit import client_ip, limiter
from app.routers import auth, items, reservations, users

configure_logging()
log = structlog.get_logger()

# Error reporting is opt-in via env: no DSN, no Sentry, no network calls.
# Initialised before the app object so import-time failures are captured.
if get_settings().sentry_dsn:
    import sentry_sdk

    sentry_sdk.init(
        dsn=get_settings().sentry_dsn,
        # No tracing: the free tier's quota is better spent on errors, and
        # traces on a single free instance tell us little.
        traces_sample_rate=0.0,
        # Never ship request bodies or headers — they carry passwords,
        # bearer tokens and the refresh cookie.
        send_default_pii=False,
    )
    log.info("sentry_enabled")


@asynccontextmanager
async def lifespan(_: FastAPI):
    log.info("startup")
    yield
    await engine.dispose()
    log.info("shutdown")


app = FastAPI(title="OPTATA API", lifespan=lifespan)

app.state.limiter = limiter


async def _rate_limit_handler(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={"detail": "Too many requests. Wait a bit and try again."},
    )


app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Headers for the API's own responses.

    The CSP that matters for the product is served by Vercel with the HTML
    (see vercel.json) — this API returns JSON and images-by-redirect, never
    a document. What it still needs: HSTS (so a stray http:// call can't be
    downgraded), nosniff (so a JSON error body can't be coerced into being
    executed), a frame ban, and a referrer policy that stops the API URL
    leaking into third-party logs.
    """

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"
        )
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        # An API response is never a document; lock it down completely.
        response.headers.setdefault("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        return response


app.add_middleware(SecurityHeadersMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().frontend_origin_list,
    allow_credentials=True,  # refresh token is an httpOnly cookie
    allow_headers=["*"],
    allow_methods=["*"],
    # The client reads the RFC 6750 challenge to pick refresh-and-retry
    # vs log-out; without this the browser hides the header cross-origin.
    expose_headers=["WWW-Authenticate"],
)

# Added last = outermost: X-Forwarded-For from a trusted proxy is resolved
# into request.client before anything (rate limiting) reads the client IP.
# In-app, not a uvicorn flag, so it works regardless of how the server is
# launched — and so tests can exercise it.
app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=get_settings().forwarded_allow_ips)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(items.router)
app.include_router(reservations.router)


@app.get("/debug/whoami")
async def debug_whoami(request: Request) -> dict[str, str | None]:
    """Proxy-resolution truth for the Stage 6 audit. 404 unless DEBUG_WHOAMI=true."""
    if not get_settings().debug_whoami:
        raise HTTPException(status_code=404, detail="Not Found")
    return {
        "resolved_client_host": request.client.host if request.client else None,
        "x_forwarded_for": request.headers.get("x-forwarded-for"),
        "rate_limit_key": client_ip(request),
    }


@app.get("/health")
async def health(db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    # Must touch the DB: the uptime pinger relies on this to keep Supabase from pausing.
    try:
        await db.execute(text("SELECT 1"))
    except Exception:
        log.exception("health_db_unreachable")
        raise HTTPException(status_code=503, detail="Database unreachable")
    return {"status": "ok"}
