import httpx
import structlog

from app.config import get_settings

log = structlog.get_logger()

RESEND_ENDPOINT = "https://api.resend.com/emails"


async def send_password_reset_email(to_email: str, reset_url: str) -> None:
    """Runs as a background task — must never raise into the request path."""
    settings = get_settings()
    if not settings.resend_api_key:
        log.warning("password_reset_email_skipped", reason="RESEND_API_KEY not set")
        return

    body = (
        "You asked to reset your OPTATA password.\n"
        "\n"
        f"Set a new one here (the link works for 1 hour):\n{reset_url}\n"
        "\n"
        "If this wasn't you, ignore this email — your password stays the same.\n"
    )
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                RESEND_ENDPOINT,
                headers={"Authorization": f"Bearer {settings.resend_api_key}"},
                json={
                    "from": f"OPTATA <{settings.email_from}>",
                    "to": [to_email],
                    "subject": "Reset your OPTATA password",
                    "text": body,
                },
            )
            response.raise_for_status()
        log.info("password_reset_email_sent")
    except httpx.HTTPError:
        log.exception("password_reset_email_failed")
