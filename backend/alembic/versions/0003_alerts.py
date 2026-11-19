"""Official weather alerts read from public CAP feeds.

Only adds a table; nothing existing changes.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-20
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "alerts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("guid", sa.String(length=64), nullable=False),
        sa.Column("identifier", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=True),
        sa.Column("msg_type", sa.String(length=16), nullable=True),
        sa.Column("sender_name", sa.String(length=200), nullable=True),
        sa.Column("event", sa.String(length=200), nullable=True),
        sa.Column("severity", sa.String(length=16), nullable=True),
        sa.Column("urgency", sa.String(length=16), nullable=True),
        sa.Column("certainty", sa.String(length=16), nullable=True),
        sa.Column("headline", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("instruction", sa.Text(), nullable=True),
        sa.Column("area_desc", sa.Text(), nullable=True),
        sa.Column("sent", sa.DateTime(timezone=True), nullable=True),
        sa.Column("onset", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires", sa.DateTime(timezone=True), nullable=True),
        sa.Column("polygons", sa.Text(), nullable=True),
        sa.Column("min_lat", sa.Float(), nullable=True),
        sa.Column("max_lat", sa.Float(), nullable=True),
        sa.Column("min_lon", sa.Float(), nullable=True),
        sa.Column("max_lon", sa.Float(), nullable=True),
        sa.Column("superseded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("link", sa.String(length=300), nullable=True),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source", "guid", name="uq_alert_guid"),
    )
    op.create_index("ix_alerts_source", "alerts", ["source"])
    op.create_index("ix_alerts_identifier", "alerts", ["identifier"])
    op.create_index("ix_alerts_expires", "alerts", ["expires"])


def downgrade() -> None:
    op.drop_index("ix_alerts_expires", table_name="alerts")
    op.drop_index("ix_alerts_identifier", table_name="alerts")
    op.drop_index("ix_alerts_source", table_name="alerts")
    op.drop_table("alerts")
