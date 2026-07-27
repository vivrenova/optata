from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str
    jwt_secret: str

    supabase_url: str = ""
    supabase_service_key: str = ""  # backend-only, never exposed to the client

    resend_api_key: str = ""
    email_from: str = "onboarding@resend.dev"

    # Comma-separated list of allowed origins. The FIRST one is canonical —
    # it's the origin used in password-reset links.
    frontend_origin: str = "http://localhost:5173"

    # Refresh-cookie flags come from config, not from environment branching.
    # Local: false / lax / "". Prod: true / lax / .<domain>
    cookie_secure: bool = False
    cookie_samesite: str = "lax"
    cookie_domain: str = ""

    # Socket peers allowed to set X-Forwarded-For (the reverse proxy in prod).
    # Never "*" unless the platform provably strips client-supplied XFF —
    # with "*" uvicorn's middleware takes the LEFTMOST (attacker-controlled)
    # chain entry instead of the rightmost untrusted one.
    forwarded_allow_ips: str = "127.0.0.1"

    # GET /debug/whoami — proxy-resolution truth endpoint for the Stage 6
    # audit on Render. Off everywhere by default.
    debug_whoami: bool = False

    @property
    def frontend_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.frontend_origin.split(",") if origin.strip()]

    @property
    def primary_frontend_origin(self) -> str:
        return self.frontend_origin_list[0]


@lru_cache
def get_settings() -> Settings:
    return Settings()
