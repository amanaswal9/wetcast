"""Settings from environment variables (and backend/.env in development)."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_prefix="WEATHERAI_", extra="ignore")

    database_url: str = "sqlite:///./weatherai-dev.db"
    artifacts_dir: Path = BACKEND_DIR.parent / "ml" / "artifacts"
    cors_origins: list[str] = ["http://localhost:5173"]
    prediction_cache_seconds: int = 900
    log_level: str = "INFO"
    # Track record: issue forecasts for every trained city and score past ones this often. 0 turns it off.
    track_record_interval_hours: int = 3
    # Official alerts: read India's NDMA Sachet CAP feed this often. 0 turns polling off.
    alerts_poll_minutes: int = 10
    # Open-Meteo needs no key. Keys for any future paid source go here, never in code.


@lru_cache
def get_settings() -> Settings:
    return Settings()
