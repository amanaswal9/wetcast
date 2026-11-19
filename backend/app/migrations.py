"""Bring the database schema up to date at startup with Alembic.

Three cases:
- empty database: run every migration;
- database made by the old create_all (app tables, no alembic_version):
  record it as the baseline revision without touching data, then upgrade;
- already migrated: apply any newer migrations (usually none).
"""

from __future__ import annotations

import logging
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import inspect
from sqlalchemy.engine import Engine

from .db import Base

BACKEND_DIR = Path(__file__).resolve().parent.parent
BASELINE = "0001"
# Tables create_all made before migrations existed (revision 0001).
BASELINE_TABLES = frozenset({"prediction_runs", "prediction_points", "saved_places"})
log = logging.getLogger("weatherai.migrations")
# Alembic logs "Context impl ..." for every step; migrate() logs what changed instead.
logging.getLogger("alembic.runtime.migration").setLevel(logging.WARNING)


def alembic_config() -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    return cfg


def head_revision() -> str:
    head = ScriptDirectory.from_config(alembic_config()).get_current_head()
    assert head is not None
    return head


def current_revision(engine: Engine) -> str | None:
    with engine.connect() as conn:
        return MigrationContext.configure(conn).get_current_revision()


def migrate(engine: Engine) -> str:
    """Upgrade the database behind `engine` to the latest revision; return it."""
    cfg = alembic_config()
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        revision = MigrationContext.configure(conn).get_current_revision()
        if revision is None:
            existing = set(inspect(conn).get_table_names()) & set(Base.metadata.tables)
            if existing == BASELINE_TABLES:
                log.info("database was created before migrations; stamping baseline %s", BASELINE)
                command.stamp(cfg, BASELINE)
            elif existing:
                raise RuntimeError(
                    f"database has only some app tables ({', '.join(sorted(existing))}) and no "
                    "migration record; fix it by hand before starting the API"
                )
            revision = MigrationContext.configure(conn).get_current_revision()
        command.upgrade(cfg, "head")
    head = current_revision(engine) or ""
    if head != revision:
        log.info("database upgraded from %s to %s", revision or "empty", head)
    log.info("database schema at revision %s", head)
    return head
