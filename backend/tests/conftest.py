import os
import sys
from pathlib import Path

import pytest

# Tests run against a throwaway SQLite file, never the real PostgreSQL database.
TEST_DB = Path(__file__).parent / "test.db"
os.environ["WEATHERAI_DATABASE_URL"] = f"sqlite:///{TEST_DB.as_posix()}"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from app import db, predictions
    from app.main import app

    if TEST_DB.exists():
        TEST_DB.unlink()
    db.init_engine(os.environ["WEATHERAI_DATABASE_URL"])
    predictions._cache.clear()
    with TestClient(app) as c:
        yield c
    db.engine().dispose()
    if TEST_DB.exists():
        TEST_DB.unlink()
