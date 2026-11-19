"""Live predictions: fetch recent hours, build features exactly as in training, run models."""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

import httpx
import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from weatherai_ml.config import CITIES, TARGETS, City
from weatherai_ml.features import build_frames
from weatherai_ml.openmeteo import fetch_recent
from weatherai_ml.predict import Prediction

from .config import get_settings
from .db import PredictionPoint, PredictionRun
from .registry import ModelRegistry

log = logging.getLogger("weatherai.predictions")

# Extra hours requested so short gaps don't leave us without a full window.
HISTORY_MARGIN_HOURS = 6


class UpstreamError(RuntimeError):
    """The weather data provider failed."""


@dataclass
class CacheEntry:
    expires: float
    features: pd.DataFrame


_cache: dict[str, CacheEntry] = {}
_lock = threading.Lock()


def city_elevation(registry: ModelRegistry, city: City) -> float:
    """Use the same centre elevation recorded at training time."""
    for name in registry.names:
        for c in registry.metrics(name)["data"]["cities"]:
            if c["id"] == city.id:
                return float(c["elevation_m"])
    raise KeyError(city.id)


def recent_features(registry: ModelRegistry, city: City, lookback: int) -> pd.DataFrame:
    ttl = get_settings().prediction_cache_seconds
    with _lock:
        hit = _cache.get(city.id)
        if hit and hit.expires > time.monotonic():
            return hit.features
    try:
        with httpx.Client(timeout=20) as client:
            long_df, _ = fetch_recent(client, city, past_hours=lookback + HISTORY_MARGIN_HOURS)
    except (httpx.HTTPError, ValueError, KeyError, RuntimeError) as exc:
        log.warning("open-meteo fetch failed for %s: %s", city.id, exc)
        raise UpstreamError("Couldn't get recent weather data from Open-Meteo.") from exc
    features, _ = build_frames(long_df, city, city_elevation(registry, city))
    with _lock:
        _cache[city.id] = CacheEntry(time.monotonic() + ttl, features)
    return features


def store_run(session: Session, model: str, city: City, prediction: Prediction) -> None:
    issued = prediction.issued_at.to_pydatetime()
    exists = session.scalar(
        select(PredictionRun.id).where(
            PredictionRun.model == model, PredictionRun.city_id == city.id, PredictionRun.issued_at == issued
        )
    )
    if exists:
        return
    run = PredictionRun(model=model, city_id=city.id, issued_at=issued)
    for lead, valid in enumerate(prediction.times, start=1):
        for k, target in enumerate(TARGETS):
            run.points.append(
                PredictionPoint(
                    valid_at=valid.to_pydatetime(),
                    lead_hours=lead,
                    target=target,
                    value=float(prediction.values[lead - 1, k]),
                    lower=float(prediction.lower[lead - 1, k]),
                    upper=float(prediction.upper[lead - 1, k]),
                )
            )
    session.add(run)
    session.commit()


def supported_cities() -> list[City]:
    return list(CITIES)
