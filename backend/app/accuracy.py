"""Summaries of the live track record (scored prediction points)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from .db import PredictionPoint, PredictionRun
from .config import get_settings
from .registry import ModelRegistry
from .track_record import SETTLE_HOURS

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
    return case(
        *[(PredictionPoint.lead_hours <= hi, f"{lo}-{hi}") for lo, hi in LEAD_BUCKETS],
        else_="other",
    )


def _stats():
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
    return {
        "n": int(r.n),
        "mae": round(float(r.mae), 4),
        "persistence_mae": round(float(r.persistence_mae), 4),
        "coverage": round(float(r.coverage), 4),
    }


def track_record_summary(session: Session, registry: ModelRegistry, days: int, city: str | None) -> dict:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    scored = [PredictionPoint.scored_at.is_not(None), PredictionPoint.valid_at >= since]
    if city is not None:
        scored.append(PredictionRun.city_id == city)

    def grouped(*columns):
        return session.execute(
            select(PredictionRun.model, PredictionPoint.target, *columns, *_stats())
            .join(PredictionRun)
            .where(*scored)
            .group_by(PredictionRun.model, PredictionPoint.target, *columns)
        ).all()

    day = _day(session).label("day")
    lead = _lead_bucket().label("lead")
    totals = [{"model": r.model, "target": r.target, **_row(r)} for r in grouped()]
    daily = [{"model": r.model, "target": r.target, "date": str(r.day), **_row(r)} for r in grouped(day)]
    by_lead = [{"model": r.model, "target": r.target, "lead": r.lead, **_row(r)} for r in grouped(lead)]
    by_city = [{"model": r.model, "target": r.target, "city": r.city_id, **_row(r)} for r in grouped(PredictionRun.city_id)]
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
    pending_filters = [PredictionPoint.scored_at.is_(None), PredictionRun.issued_at >= since]
    if city is not None:
        pending_filters.append(PredictionRun.city_id == city)
    pending = session.scalar(select(func.count()).select_from(PredictionPoint).join(PredictionRun).where(*pending_filters))

    names = sorted({r["model"] for r in totals}, key=lambda m: (m not in registry.names, registry.names.index(m) if m in registry.names else 0, m))
    return {
        "days": days,
        "city": city,
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
