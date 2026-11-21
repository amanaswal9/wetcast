import os
import sys
from pathlib import Path

import pytest

# Tests run against a throwaway SQLite file, never the real PostgreSQL database.
TEST_DB = Path(__file__).parent / "test.db"
os.environ["WEATHERAI_DATABASE_URL"] = f"sqlite:///{TEST_DB.as_posix()}"
os.environ["WEATHERAI_TRACK_RECORD_INTERVAL_HOURS"] = "0"  # no background jobs in tests
os.environ["WEATHERAI_ALERTS_POLL_MINUTES"] = "0"
os.environ["WEATHERAI_OLLAMA_URL"] = "http://127.0.0.1:9"  # tests never reach a real local model
os.environ.pop("HOSTED_API_KEY", None)  # nor the real Hosted API
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture(autouse=True)
def no_rain_outlook(monkeypatch):
    """Tests never reach Open-Meteo's live rain forecast; the ensemble then does without it."""
    from app import predictions

    def offline(*args, **kwargs):
        raise RuntimeError("offline in tests")

    monkeypatch.setattr(predictions, "fetch_outlook", offline)
    predictions._outlooks.clear()


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
