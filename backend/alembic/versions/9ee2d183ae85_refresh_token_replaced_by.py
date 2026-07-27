"""refresh_token_replaced_by

Rotation leeway: browsers share one cookie jar across tabs, so two tabs
mounting at once both present the same refresh token — a benign race that
strict reuse detection misreads as theft and nukes the whole family.
replaced_by_id records which token superseded which; presenting a token
revoked <30s ago that HAS a successor is treated as the race, not theft.

Revision ID: 9ee2d183ae85
Revises: 607e6c76464f
Create Date: 2026-07-13 01:40:19.483325

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = '9ee2d183ae85'
down_revision: str | None = '607e6c76464f'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "refresh_tokens",
        sa.Column(
            "replaced_by_id",
            UUID(as_uuid=True),
            sa.ForeignKey("refresh_tokens.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("refresh_tokens", "replaced_by_id")
