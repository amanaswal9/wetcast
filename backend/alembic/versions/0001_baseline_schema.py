"""Baseline schema: the three tables the API created with create_all before
migrations existed. Databases made that way are stamped at this revision
instead of running it (see app/migrations.py).

Revision ID: 0001
Revises:
Create Date: 2026-11-19
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "prediction_runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("model", sa.String(length=32), nullable=False),
        sa.Column("city_id", sa.String(length=32), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("model", "city_id", "issued_at", name="uq_run"),
    )
    op.create_index("ix_prediction_runs_model", "prediction_runs", ["model"])
    op.create_index("ix_prediction_runs_city_id", "prediction_runs", ["city_id"])
    op.create_index("ix_prediction_runs_issued_at", "prediction_runs", ["issued_at"])

    op.create_table(
        "prediction_points",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.Integer(), nullable=False),
        sa.Column("valid_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lead_hours", sa.Integer(), nullable=False),
        sa.Column("target", sa.String(length=16), nullable=False),
        sa.Column("value", sa.Float(), nullable=False),
        sa.Column("lower", sa.Float(), nullable=False),
        sa.Column("upper", sa.Float(), nullable=False),
        sa.ForeignKeyConstraint(["run_id"], ["prediction_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_prediction_points_run_id", "prediction_points", ["run_id"])

    op.create_table(
        "saved_places",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("client_id", sa.String(length=64), nullable=False),
        sa.Column("place_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("admin1", sa.String(length=120), nullable=True),
        sa.Column("country", sa.String(length=120), nullable=True),
        sa.Column("latitude", sa.Float(), nullable=False),
        sa.Column("longitude", sa.Float(), nullable=False),
        sa.Column("is_home", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("client_id", "place_id", name="uq_saved_place"),
    )
    op.create_index("ix_saved_places_client_id", "saved_places", ["client_id"])


def downgrade() -> None:
    op.drop_index("ix_saved_places_client_id", table_name="saved_places")
    op.drop_table("saved_places")
    op.drop_index("ix_prediction_points_run_id", table_name="prediction_points")
    op.drop_table("prediction_points")
    op.drop_index("ix_prediction_runs_issued_at", table_name="prediction_runs")
    op.drop_index("ix_prediction_runs_city_id", table_name="prediction_runs")
    op.drop_index("ix_prediction_runs_model", table_name="prediction_runs")
    op.drop_table("prediction_runs")
