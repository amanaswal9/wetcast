"""Live track record: issue forecasts on a schedule and score them once the
weather they predicted has happened.

Every cycle, for each trained city:
1. fetch the last 72 hours for the city and its four neighbour points (one request),
2. issue and store a forecast from every model (the same code path as /api/predictions),
3. save the city centre's settled past hours as observations,
4. score stored forecast points whose hour, and the same hour a day earlier, are now known.

"What happened" is Open-Meteo's record of past hours at the city centre, the same kind
of data the models were trained and tested on. An hour is saved only once it is
SETTLE_HOURS old, so later model runs no longer change it, and it is never overwritten.
It is not a weather-station reading.

Run one cycle by hand from backend/:  python -m app.track_record
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import httpx
import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from weatherai_ml.config import TARGETS, City
from weatherai_ml.features import build_frames
from weatherai_ml.openmeteo import fetch_centre_recent, fetch_recent
from weatherai_ml.predict import InsufficientHistoryError

from .db import Observation, PredictionPoint, PredictionRun, new_session
from .predictions import city_elevation, predict_models, store_run, tracked_cities
from .registry import ModelRegistry, get_registry

log = logging.getLogger("weatherai.track_record")

SETTLE_HOURS = 6
FETCH_HOURS = 72
MAX_AGE_DAYS = 90  # older unscored points are left alone (Open-Meteo keeps 92 days of past hours)
SOURCE = "open-meteo"
RAW_COLUMNS = {"temperature": "temperature_2m", "humidity": "relative_humidity_2m", "precipitation": "precipitation"}

# Replaced in tests with offline data.
fetch_inputs = fetch_recent
fetch_centre = fetch_centre_recent


def utc_naive(value: datetime | pd.Timestamp) -> datetime:
    """Comparable UTC key: SQLite returns naive datetimes, PostgreSQL aware ones."""
    ts = pd.Timestamp(value)
    if ts.tzinfo is not None:
        ts = ts.tz_convert("UTC").tz_localize(None)
    return ts.to_pydatetime()


@dataclass
class CycleSummary:
    cities: int = 0
    runs_stored: int = 0
    observations_saved: int = 0
    points_scored: int = 0
    failures: list[str] = field(default_factory=list)


def save_observations(session: Session, city: City, centre: pd.DataFrame, now: datetime) -> int:
    """Insert settled hours not stored yet. `centre` has UTC times and the RAW_COLUMNS."""
    cutoff = utc_naive(now) - timedelta(hours=SETTLE_HOURS)
    frame = centre.copy()
    frame["key"] = [utc_naive(t) for t in frame["time"]]
    frame = frame[frame["key"] <= cutoff].drop_duplicates("key", keep="last")
    if frame.empty:
        return 0
    existing = {
        utc_naive(t)
        for t in session.scalars(
            select(Observation.valid_at).where(
                Observation.city_id == city.id,
                Observation.valid_at >= frame["key"].min().replace(tzinfo=timezone.utc),
            )
        )
    }
    added = 0
    for row in frame.itertuples(index=False):
        if row.key in existing:
            continue
        values = {t: getattr(row, col) for t, col in RAW_COLUMNS.items()}
        values = {t: (None if pd.isna(v) else float(v)) for t, v in values.items()}
        if all(v is None for v in values.values()):
            continue
        if values["precipitation"] is not None:
            values["precipitation"] = max(values["precipitation"], 0.0)
        session.add(Observation(city_id=city.id, valid_at=row.key.replace(tzinfo=timezone.utc), source=SOURCE, **values))
        added += 1
    session.commit()
    return added


def oldest_unscored(session: Session, city: City, now: datetime) -> datetime | None:
    cutoff = utc_naive(now) - timedelta(hours=SETTLE_HOURS)
    floor = utc_naive(now) - timedelta(days=MAX_AGE_DAYS)
    value = session.scalar(
        select(PredictionPoint.valid_at)
        .join(PredictionRun)
        .where(
            PredictionRun.city_id == city.id,
            PredictionPoint.scored_at.is_(None),
            PredictionPoint.valid_at <= cutoff.replace(tzinfo=timezone.utc),
            PredictionPoint.valid_at >= floor.replace(tzinfo=timezone.utc),
        )
        .order_by(PredictionPoint.valid_at)
        .limit(1)
    )
    return utc_naive(value) if value is not None else None


def needs_backfill(session: Session, city: City, now: datetime) -> int:
    """Past hours to fetch for older unscored points, or 0 if the regular fetch covers them."""
    oldest = oldest_unscored(session, city, now)
    if oldest is None:
        return 0
    start = oldest - timedelta(hours=24)  # persistence needs the same hour a day earlier
    hours = int((utc_naive(now) - start).total_seconds() // 3600) + 2
    if hours <= FETCH_HOURS:
        return 0
    have = {
        utc_naive(t)
        for t in session.scalars(
            select(Observation.valid_at).where(
                Observation.city_id == city.id,
                Observation.valid_at.in_([start.replace(tzinfo=timezone.utc), oldest.replace(tzinfo=timezone.utc)]),
            )
        )
    }
    return 0 if have == {start, oldest} else hours


def score_city(session: Session, city: City, now: datetime) -> int:
    """Fill observed/persistence on stored points whose hours are now known."""
    cutoff = utc_naive(now) - timedelta(hours=SETTLE_HOURS)
    floor = utc_naive(now) - timedelta(days=MAX_AGE_DAYS)
    points = session.scalars(
        select(PredictionPoint)
        .join(PredictionRun)
        .where(
            PredictionRun.city_id == city.id,
            PredictionPoint.scored_at.is_(None),
            PredictionPoint.valid_at <= cutoff.replace(tzinfo=timezone.utc),
            PredictionPoint.valid_at >= floor.replace(tzinfo=timezone.utc),
        )
    ).all()
    if not points:
        return 0
    first = min(utc_naive(p.valid_at) for p in points) - timedelta(hours=24)
    obs = {
        utc_naive(o.valid_at): o
        for o in session.scalars(
            select(Observation).where(
                Observation.city_id == city.id, Observation.valid_at >= first.replace(tzinfo=timezone.utc)
            )
        )
    }
    stamp = datetime.now(timezone.utc)
    scored = 0
    for p in points:
        key = utc_naive(p.valid_at)
        now_obs, prev_obs = obs.get(key), obs.get(key - timedelta(hours=24))
        if now_obs is None or prev_obs is None:
            continue
        observed, previous = getattr(now_obs, p.target), getattr(prev_obs, p.target)
        if observed is None or previous is None:
            continue
        p.observed, p.persistence, p.scored_at = observed, previous, stamp
        scored += 1
    session.commit()
    return scored


def issue_forecasts(session: Session, registry: ModelRegistry, city: City, features: pd.DataFrame) -> int:
    try:
        # Shared with /api/predictions, so these also answer the next visitor for this city instantly.
        forecasts = predict_models(registry, city, registry.names, features)
    except InsufficientHistoryError as exc:
        log.warning("%s: forecasts skipped (%s)", city.id, exc)
        return 0
    return sum(int(store_run(session, name, city, prediction, registry.region_id)) for name, prediction in forecasts.items())


def run_city(session: Session, registry: ModelRegistry, city: City, now: datetime, summary: CycleSummary) -> None:
    with httpx.Client(timeout=30) as client:
        long_df, elevation = fetch_inputs(client, city, past_hours=FETCH_HOURS)
        backfill = needs_backfill(session, city, now)
        older = fetch_centre(client, city, past_hours=backfill) if backfill else None

    if registry.names:
        features, _ = build_frames(long_df, city, city_elevation(registry, city, elevation))
        summary.runs_stored += issue_forecasts(session, registry, city, features)

    centre = long_df[long_df["point"] == "c"]
    if older is not None:
        centre = pd.concat([older, centre], ignore_index=True)
    summary.observations_saved += save_observations(session, city, centre, now)
    summary.points_scored += score_city(session, city, now)


def run_cycle(registry: ModelRegistry | None = None, now: datetime | None = None, cities: list[City] | None = None) -> CycleSummary:
    registry = registry or get_registry()
    now = now or datetime.now(timezone.utc)
    summary = CycleSummary()
    started = time.perf_counter()
    for city in cities or tracked_cities(registry.region_id):
        with new_session() as session:
            try:
                run_city(session, registry, city, now, summary)
                summary.cities += 1
            except Exception as exc:  # noqa: BLE001 - one city failing must not stop the others
                session.rollback()
                summary.failures.append(f"{city.id}: {exc}")
                log.warning("track record: %s failed: %s", city.id, exc)
    log.info(
        "track record cycle: %d cities, %d runs stored, %d hours observed, %d points scored, %d failed, %.1f s",
        summary.cities, summary.runs_stored, summary.observations_saved, summary.points_scored,
        len(summary.failures), time.perf_counter() - started,
    )
    return summary


def seconds_until_next(interval_hours: int, now: datetime, offset_minutes: int = 10) -> float:
    """Seconds until the next UTC multiple of `interval_hours`, plus an offset so the
    newest hour has been published."""
    base = now.replace(minute=0, second=0, microsecond=0)
    nxt = base + timedelta(hours=interval_hours - base.hour % interval_hours, minutes=offset_minutes)
    if nxt - timedelta(hours=interval_hours) > now:
        nxt -= timedelta(hours=interval_hours)
    return max((nxt - now).total_seconds(), 1.0)


async def scheduler(interval_hours: int, first_delay_seconds: float = 30) -> None:
    """Run a cycle shortly after startup, then every `interval_hours`, aligned to UTC hours."""
    await asyncio.sleep(first_delay_seconds)
    while True:
        try:
            await asyncio.to_thread(run_cycle)
        except Exception as exc:  # noqa: BLE001 - keep the schedule alive
            log.exception("track record cycle crashed: %s", exc)
        await asyncio.sleep(seconds_until_next(interval_hours, datetime.now(timezone.utc)))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from .db import engine
    from .migrations import migrate

    migrate(engine())
    result = run_cycle()
    for failure in result.failures:
        print("failed:", failure)
