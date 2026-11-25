"""Tag each stored forecast with the model set (training region) that made it.

The all-India models reuse the North India model names, so without this the track record would mix
two different models under one name. Existing rows were all made by the North India set.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-20
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add the model_set column to prediction runs and make it part of the unique key."""
    # batch: SQLite can't change constraints in place (PostgreSQL just runs the statements).
    with op.batch_alter_table("prediction_runs") as batch:
        batch.add_column(sa.Column("model_set", sa.String(length=32), nullable=False, server_default="north_india"))
        batch.drop_constraint("uq_run", type_="unique")
        batch.create_unique_constraint("uq_run", ["model_set", "model", "city_id", "issued_at"])
        batch.create_index("ix_prediction_runs_model_set", ["model_set"])


def downgrade() -> None:
    """Remove the model_set column and restore the old unique key on prediction runs."""
    # Only safe while just one model set has stored forecasts (the old key can't tell sets apart).
    with op.batch_alter_table("prediction_runs") as batch:
        batch.drop_index("ix_prediction_runs_model_set")
        batch.drop_constraint("uq_run", type_="unique")
        batch.create_unique_constraint("uq_run", ["model", "city_id", "issued_at"])
        batch.drop_column("model_set")
