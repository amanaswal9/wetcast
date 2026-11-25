"""Track record: an observations table and score columns on prediction points.

Only adds a table, nullable columns and indexes; existing rows are untouched.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-19
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add the observations table and the observed, persistence and scored_at columns to prediction points."""
    op.create_table(
        "observations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("city_id", sa.String(length=32), nullable=False),
        sa.Column("valid_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("temperature", sa.Float(), nullable=True),
        sa.Column("humidity", sa.Float(), nullable=True),
        sa.Column("precipitation", sa.Float(), nullable=True),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("city_id", "valid_at", name="uq_observation"),
    )
    op.create_index("ix_observations_city_id", "observations", ["city_id"])
    op.create_index("ix_observations_valid_at", "observations", ["valid_at"])

    op.add_column("prediction_points", sa.Column("observed", sa.Float(), nullable=True))
    op.add_column("prediction_points", sa.Column("persistence", sa.Float(), nullable=True))
    op.add_column("prediction_points", sa.Column("scored_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_prediction_points_scored_at", "prediction_points", ["scored_at"])
    op.create_index("ix_prediction_points_valid_at", "prediction_points", ["valid_at"])


def downgrade() -> None:
    """Remove the observations table and the scoring columns from prediction points."""
    op.drop_index("ix_prediction_points_valid_at", table_name="prediction_points")
    op.drop_index("ix_prediction_points_scored_at", table_name="prediction_points")
    with op.batch_alter_table("prediction_points") as batch:  # SQLite can't drop columns directly
        batch.drop_column("scored_at")
        batch.drop_column("persistence")
        batch.drop_column("observed")
    op.drop_index("ix_observations_valid_at", table_name="observations")
    op.drop_index("ix_observations_city_id", table_name="observations")
    op.drop_table("observations")
