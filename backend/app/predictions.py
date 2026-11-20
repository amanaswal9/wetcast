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

from weatherai_ml.config import TARGETS, City, region_cities
from weatherai_ml.features import build_frames
from weatherai_ml.openmeteo import fetch_recent
from weatherai_ml.models import ENSEMBLE_NAME
from weatherai_ml.predict import Prediction, Predictor

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
    hours: int  # how many past hours were requested


_cache: dict[str, CacheEntry] = {}
_lock = threading.Lock()


def city_elevation(registry: ModelRegistry, city: City, fetched: float | None = None) -> float:
    """A known city uses the centre elevation recorded at training time; any other point uses the
    elevation Open-Meteo reports for it with the live data (the same source the recorded ones came from)."""
    for name in registry.names:
        for c in registry.metrics(name)["data"]["cities"]:
            if c["id"] == city.id:
                return float(c["elevation_m"])
        break  # every model was trained on the same cities
    if fetched is None:
        raise KeyError(city.id)
    return float(fetched)


def recent_features(registry: ModelRegistry, city: City, lookback: int) -> pd.DataFrame:
    """Recent features for a city, long enough for `lookback` (the largest lookback
    among the requested models). A cached frame is reused only if it is long enough."""
    ttl = get_settings().prediction_cache_seconds
    hours = lookback + HISTORY_MARGIN_HOURS
    with _lock:
        hit = _cache.get(city.id)
        if hit and hit.expires > time.monotonic() and hit.hours >= hours:
            return hit.features
    try:
        with httpx.Client(timeout=20) as client:
            long_df, elevation = fetch_recent(client, city, past_hours=hours)
    except (httpx.HTTPError, ValueError, KeyError, RuntimeError) as exc:
        log.warning("open-meteo fetch failed for %s: %s", city.id, exc)
        raise UpstreamError("Couldn't get recent weather data from Open-Meteo.") from exc
    features, _ = build_frames(long_df, city, city_elevation(registry, city, elevation))
    with _lock:
        _cache[city.id] = CacheEntry(time.monotonic() + ttl, features, hours)
    return features


_predictions: dict[tuple[str, str], Prediction] = {}
_predictions_lock = threading.Lock()


def predict_models(registry: ModelRegistry, city: City, names: list[str], features: pd.DataFrame) -> dict[str, Prediction]:
    """Forecasts from the requested models, computing each model at most once.

    Results are kept per city and model until a newer hour of data arrives (they can't
    change before then), and the ensemble is averaged from its members' results
    instead of running the members a second time."""
    issued = Predictor.usable(features).index[-1]
    wanted = list(dict.fromkeys(names))
    needed = set(wanted)
    if ENSEMBLE_NAME in needed:
        needed |= set(registry.ensemble_members)
    out: dict[str, Prediction] = {}

    def cached(name: str) -> Prediction | None:
        with _predictions_lock:
            hit = _predictions.get((city.id, name))
        return hit if hit is not None and hit.issued_at == issued else None

    def keep(name: str, prediction: Prediction) -> Prediction:
        with _predictions_lock:
            _predictions[(city.id, name)] = prediction
        return prediction

    for name in registry.names:
        if name in needed and name != ENSEMBLE_NAME:
            out[name] = cached(name) or keep(name, registry.get(name).predict(features))
    if ENSEMBLE_NAME in needed:
        out[ENSEMBLE_NAME] = cached(ENSEMBLE_NAME) or keep(
            ENSEMBLE_NAME, registry.get(ENSEMBLE_NAME).combine([out[m] for m in registry.ensemble_members])
        )
    return {name: out[name] for name in wanted}


def store_run(session: Session, model: str, city: City, prediction: Prediction, model_set: str) -> bool:
    """Store a forecast once; return False if this model already stored one for that hour.
    `model_set` is the region the models were trained on, so the track record never mixes model sets
    that share names (the North India and all-India LSTM are different models)."""
    issued = prediction.issued_at.to_pydatetime()
    exists = session.scalar(
        select(PredictionRun.id).where(
            PredictionRun.model == model,
            PredictionRun.city_id == city.id,
            PredictionRun.issued_at == issued,
            PredictionRun.model_set == model_set,
        )
    )
    if exists:
        return False
    run = PredictionRun(model=model, city_id=city.id, issued_at=issued, model_set=model_set)
    chance = prediction.rain_chance
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
                    rain_chance=float(chance[lead - 1]) if chance is not None and target == "precipitation" else None,
                )
            )
    session.add(run)
    session.commit()
    return True


def tracked_cities(region: str) -> list[City]:
    """Cities whose forecasts are stored and scored: every training and held-out city."""
    return list(region_cities(region))
