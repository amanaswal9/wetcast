"""Settings from environment variables (and backend/.env in development)."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """Every setting can be overridden with an environment variable named WEATHERAI_ plus the field
    name in capitals, for example WEATHERAI_DATABASE_URL."""

    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_prefix="WEATHERAI_", extra="ignore")

    database_url: str = "sqlite:///./weatherai-dev.db"
    # The served models. The all-India set (2026-11-20) covers any point in India and beats the older
    # North India set on its own cities; that set is still in ml/artifacts (point here to serve it).
    artifacts_dir: Path = BACKEND_DIR.parent / "ml" / "artifacts" / "india"
    cors_origins: list[str] = ["http://localhost:5173"]
    prediction_cache_seconds: int = 900
    log_level: str = "INFO"
    # Track record: issue forecasts for every trained city and score past ones this often. 0 turns it off.
    track_record_interval_hours: int = 3
    # Official alerts: read India's NDMA Sachet CAP feed this often. 0 turns polling off.
    alerts_poll_minutes: int = 10
    # The Ask page. "auto" and "local" both mean the free local model, used when Ollama is running
    # with it installed ("auto" is kept so older .env files still load). "off" turns the page off.
    assistant_provider: Literal["auto", "local", "off"] = "auto"

    @field_validator("assistant_provider", mode="before")
    @classmethod
    def _old_provider(cls, value: object) -> object:
        # "hosted" was a choice before the paid option was removed; an old .env still starts.
        return "auto" if isinstance(value, str) and value.strip().lower() == "hosted" else value
    ollama_url: str = "http://127.0.0.1:11434"
    # The Instruct edition answers directly; the plain "qwen3:4b" tag is the thinking edition, which
    # reasons at length before every answer (far too slow on a small graphics card).
    ollama_model: str = "qwen3:4b-instruct"
    # Context window in tokens. 4096 holds the instructions, tools and a couple of lookups, and keeps
    # the model small enough to sit (mostly) on a 4 GB graphics card; 8192 spilled onto the CPU.
    ollama_context: int = 4096
    assistant_daily_limit_per_client: int = 20
    assistant_daily_limit_total: int = 200
    # Open-Meteo needs no key. Keys for any future paid source go here, never in code.


@lru_cache
def get_settings() -> Settings:
    """The settings, read once per process."""
    return Settings()
