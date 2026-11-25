"""Store the ensemble's chance of rain with each stored rain forecast, so the track record can score it.

Only adds a nullable column; rows stored before it stay NULL and are not scored for chance.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-21
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add the rain_chance column to prediction points."""
    op.add_column("prediction_points", sa.Column("rain_chance", sa.Float(), nullable=True))


def downgrade() -> None:
    """Remove the rain_chance column from prediction points."""
    with op.batch_alter_table("prediction_points") as batch:
        batch.drop_column("rain_chance")
