"""Migration tests on throwaway SQLite files (never the real database)."""

from __future__ import annotations

import pytest
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from sqlalchemy import create_engine, inspect, text

from app.db import Base
from alembic import command

from app.migrations import BASELINE, alembic_config, current_revision, head_revision, migrate


@pytest.fixture()
def sqlite_engine(tmp_path):
    eng = create_engine(f"sqlite:///{(tmp_path / 'm.db').as_posix()}")
    yield eng
    eng.dispose()


def test_empty_database_is_migrated_to_head(sqlite_engine):
    assert migrate(sqlite_engine) == head_revision()
    tables = set(inspect(sqlite_engine).get_table_names())
    assert set(Base.metadata.tables) <= tables


def test_models_match_migrations(sqlite_engine):
    """Fails if a model changed without a new migration (alembic revision --autogenerate)."""
    migrate(sqlite_engine)
    with sqlite_engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn, opts={"compare_type": True}), Base.metadata)
    assert diff == []


def make_legacy(engine) -> None:
    """A database as the old create_all left it: the baseline tables, no migration record."""
    cfg = alembic_config()
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, BASELINE)
        conn.execute(text("DROP TABLE alembic_version"))


def test_legacy_create_all_database_is_stamped_and_keeps_data(sqlite_engine):
    make_legacy(sqlite_engine)
    with sqlite_engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO saved_places (client_id, place_id, name, latitude, longitude, is_home, created_at) "
                "VALUES ('c1', 'p1', 'Delhi', 28.6, 77.2, 1, '2026-11-19 00:00:00')"
            )
        )
    assert current_revision(sqlite_engine) is None

    assert migrate(sqlite_engine) == head_revision()
    with sqlite_engine.connect() as conn:
        assert conn.execute(text("SELECT name FROM saved_places")).scalar_one() == "Delhi"
    assert set(Base.metadata.tables) <= set(inspect(sqlite_engine).get_table_names())  # later migrations ran


def test_running_twice_is_harmless(sqlite_engine):
    first = migrate(sqlite_engine)
    assert migrate(sqlite_engine) == first


def test_partial_database_is_refused(sqlite_engine):
    Base.metadata.tables["saved_places"].create(sqlite_engine)
    with pytest.raises(RuntimeError, match="only some app tables"):
        migrate(sqlite_engine)
