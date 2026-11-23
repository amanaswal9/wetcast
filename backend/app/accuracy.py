"""Summaries of the live track record (scored prediction points)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, case, func, literal, select
from sqlalchemy.orm import Session

from .db import PredictionPoint, PredictionRun
from .config import get_settings
from .registry import ModelRegistry
from .track_record import SETTLE_HOURS

# Hours ahead, grouped into four bands for the "by lead time" view.
LEAD_BUCKETS = ((1, 6), (7, 12), (13, 18), (19, 24))

# A city's own accuracy is only shown once it has this many different days scored. A few days
# of one season say little about a model; the frontend shows progress until then.
MIN_DAYS_PER_CITY = 14


def _day(session: Session):
    """Calendar day (UTC) of a point's valid time, on PostgreSQL or SQLite."""
    if session.get_bind().dialect.name == "postgresql":
        return func.date(func.timezone("UTC", PredictionPoint.valid_at))
    return func.date(PredictionPoint.valid_at)


def _lead_bucket():
    """SQL expression naming the lead-time band of a point, such as "1-6"."""
    return case(
        *[(PredictionPoint.lead_hours <= hi, f"{lo}-{hi}") for lo, hi in LEAD_BUCKETS],
        else_="other",
    )


def _stats():
    """SQL aggregates for a group of scored points: count, model error, persistence error and
    the share of hours that fell inside the predicted range."""
    error = func.abs(PredictionPoint.value - PredictionPoint.observed)
    baseline = func.abs(PredictionPoint.persistence - PredictionPoint.observed)
    inside = case(
        (and_(PredictionPoint.observed >= PredictionPoint.lower, PredictionPoint.observed <= PredictionPoint.upper), 1.0),
        else_=0.0,
    )
    return (
        func.count().label("n"),
        func.avg(error).label("mae"),
        func.avg(baseline).label("persistence_mae"),
        func.avg(inside).label("coverage"),
    )


def _iso(value: datetime | None) -> str | None:
    """ISO time with an explicit UTC offset (SQLite hands back naive UTC datetimes)."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _row(r) -> dict:
    """The aggregates from _stats as plain, rounded numbers."""
    return {
        "n": int(r.n),
        "mae": round(float(r.mae), 4),
        "persistence_mae": round(float(r.persistence_mae), 4),
        "coverage": round(float(r.coverage), 4),
    }


# Bands for the reliability table: (upper limit, label). Chances of 0.9 and above go in "90-100%".
CHANCE_BINS = ((0.1, "0-10%"), (0.3, "10-30%"), (0.5, "30-50%"), (0.7, "50-70%"), (0.9, "70-90%"))


def rain_chance_summary(session: Session, registry: ModelRegistry, scored: list) -> dict | None:
    """Brier score of the ensemble's stored chances of rain, against two simple forecasts on the same
    hours: always the validation year's rain frequency, and "rain if it rained at this hour yesterday"."""
    ensemble = registry.get("ensemble")
    table = getattr(ensemble, "rain_chance", None) if ensemble is not None else None
    if table is None:
        return None
    wet_mm, usual = float(table["wet_mm"]), float(table["validation_rain_share"])
    chance = PredictionPoint.rain_chance
    wet = case((PredictionPoint.observed >= wet_mm, 1.0), else_=0.0)
    yesterday = case((PredictionPoint.persistence.is_(None), None), (PredictionPoint.persistence >= wet_mm, 1.0), else_=0.0)
    where = scored + [PredictionPoint.target == "precipitation", chance.is_not(None), PredictionRun.model == "ensemble"]
    # Brier score: the mean squared gap between the stated chance and what happened (1 wet, 0 dry).
    row = session.execute(
        select(
            func.count(),
            func.avg((chance - wet) * (chance - wet)),
            func.avg((literal(usual) - wet) * (literal(usual) - wet)),
            func.avg((yesterday - wet) * (yesterday - wet)),
            func.avg(wet),
            func.min(PredictionPoint.valid_at),
        )
        .join(PredictionRun)
        .where(*where)
    ).one()
    n = int(row[0] or 0)
    out = {
        "wet_mm": wet_mm,
        "usual_share": round(usual, 4),
        "test_brier": table["scores"]["test"]["brier"],
        "n": n,
        "first_valid_at": _iso(row[5]),
    }
    if n == 0:
        return out
    band = case(*[(chance < hi, label) for hi, label in CHANCE_BINS], else_="90-100%").label("band")
    bins = session.execute(
        select(band, func.count(), func.avg(chance), func.avg(wet)).join(PredictionRun).where(*where).group_by(band)
    ).all()
    order = [label for _, label in CHANCE_BINS] + ["90-100%"]
    return out | {
        "brier": round(float(row[1]), 5),
        "usual_brier": round(float(row[2]), 5),
        "yesterday_brier": round(float(row[3]), 5) if row[3] is not None else None,
        "rain_share": round(float(row[4]), 4),
        "reliability": sorted(
            ({"band": b, "n": int(c), "said": round(float(s), 3), "rained": round(float(w), 3)} for b, c, s, w in bins),
            key=lambda r: order.index(r["band"]),
        ),
    }


def track_record_summary(session: Session, registry: ModelRegistry, days: int, city: str | None) -> dict:
    """Everything the Track record page shows for the last `days` days, for all cities or one."""
    since = datetime.now(timezone.utc) - timedelta(days=days)
    # Only the served model set: older sets reuse the same model names.
    current = PredictionRun.model_set == registry.region_id
    scored = [PredictionPoint.scored_at.is_not(None), PredictionPoint.valid_at >= since, current]
    if city is not None:
        scored.append(PredictionRun.city_id == city)

    def grouped(split=None):
        # Error statistics per model and target, and per value of `split` when one is given.
        keys = [PredictionRun.model, PredictionPoint.target] + ([split] if split is not None else [])
        return session.execute(
            select(*keys, *_stats()).join(PredictionRun).where(*scored).group_by(*keys)
        ).all()

    day = _day(session).label("day")
    lead = _lead_bucket().label("lead")
    totals = [{"model": r.model, "target": r.target} | _row(r) for r in grouped()]
    daily = [{"model": r.model, "target": r.target, "date": str(r.day)} | _row(r) for r in grouped(day)]
    by_lead = [{"model": r.model, "target": r.target, "lead": r.lead} | _row(r) for r in grouped(lead)]
    by_city = [{"model": r.model, "target": r.target, "city": r.city_id} | _row(r) for r in grouped(PredictionRun.city_id)]
    # How many different days each city has scores for (any model, any target).
    days_per_city = dict(
        session.execute(
            select(PredictionRun.city_id, func.count(func.distinct(day)))
            .select_from(PredictionPoint)
            .join(PredictionRun)
            .where(*scored)
            .group_by(PredictionRun.city_id)
        ).all()
    )

    span = session.execute(
        select(
            func.min(PredictionPoint.valid_at),
            func.max(PredictionPoint.valid_at),
            func.count(func.distinct(PredictionPoint.run_id)),
            func.count(func.distinct(PredictionRun.city_id)),
        )
        .join(PredictionRun)
        .where(*scored)
    ).one()
    pending_filters = [PredictionPoint.scored_at.is_(None), PredictionRun.issued_at >= since, current]
    if city is not None:
        pending_filters.append(PredictionRun.city_id == city)
    pending = session.scalar(select(func.count()).select_from(PredictionPoint).join(PredictionRun).where(*pending_filters))

    # Served models in the registry's order, then any older names still in the record.
    names = sorted({r["model"] for r in totals}, key=lambda m: (m not in registry.names, registry.names.index(m) if m in registry.names else 0, m))
    return {
        "days": days,
        "city": city,
        "model_set": registry.region_id,
        "first_valid_at": _iso(span[0]),
        "last_valid_at": _iso(span[1]),
        "runs": int(span[2]),
        "cities": int(span[3]),
        "pending_points": int(pending or 0),
        "models": [{"model": m, "display_name": registry.display_name(m)} for m in names],
        "totals": totals,
        "daily": sorted(daily, key=lambda r: r["date"]),
        "by_lead": by_lead,
        "by_city": sorted(by_city, key=lambda r: r["city"]),
        "city_days": {c: int(n) for c, n in sorted(days_per_city.items())},
        "rain_chance": rain_chance_summary(session, registry, scored),
        "min_days_per_city": MIN_DAYS_PER_CITY,
        "settle_hours": SETTLE_HOURS,
        "interval_hours": get_settings().track_record_interval_hours,
        "source": (
            "Forecasts are compared with Open-Meteo's record of the same hours at the city centre, saved once it is "
            f"{SETTLE_HOURS} hours old. This is the kind of data the models were trained and tested on, not a "
            "weather-station reading."
        ),
        "baseline": "Persistence: the same hour one day earlier, scored on exactly the same hours.",
    }
