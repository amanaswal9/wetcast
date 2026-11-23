"""Settings from environment variables (and backend/.env in development)."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, SecretStr
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
    # Assistant (Hosted). Off until a key is set; every answer costs money.
    hosted_api_key: SecretStr | None = Field(
        default=None, validation_alias=AliasChoices("WEATHERAI_HOSTED_API_KEY", "HOSTED_API_KEY")
    )
    # Who answers on the Ask page. "auto": Hosted when an Hosted key is set, otherwise the free
    # local model when Ollama is running with it installed, otherwise the assistant is off.
    assistant_provider: Literal["auto", "hosted", "local", "off"] = "auto"
    assistant_model: str = "hosted-opus-5-5"
    ollama_url: str = "http://127.0.0.1:11434"
    # The Instruct edition answers directly; the plain "qwen3:4b" tag is the thinking edition, which
    # reasons at length before every answer (far too slow on a small graphics card).
    ollama_model: str = "qwen3:4b-instruct"
    # Context window in tokens. 4096 holds the instructions, tools and a couple of lookups, and keeps
    # the model small enough to sit (mostly) on a 4 GB graphics card; 8192 spilled onto the CPU.
    ollama_context: int = 4096
    assistant_effort: Literal["low", "medium", "high", "xhigh", "max"] = "low"
    assistant_daily_limit_per_client: int = 20
    assistant_daily_limit_total: int = 200
    # Open-Meteo needs no key. Keys for any future paid source go here, never in code.


@lru_cache
def get_settings() -> Settings:
    """The settings, read once per process."""
    return Settings()
