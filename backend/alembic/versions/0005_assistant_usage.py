"""Count the assistant's questions per visitor and day in the database, so the daily limits hold
across API restarts (they were kept in memory before).

Only adds a table; nothing existing changes.

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-20
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "assistant_usage",
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("client_id", sa.String(length=64), nullable=False),
        sa.Column("questions", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("day", "client_id"),
    )


def downgrade() -> None:
    op.drop_table("assistant_usage")
