"""Track-record job and endpoint, offline: Open-Meteo is replaced with synthetic
data (tests only) and the database is a throwaway SQLite file."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pandas as pd
import pytest
from sqlalchemy import func, select

from app import db, track_record
from app.registry import get_registry
from weatherai_ml.config import CITIES
from weatherai_ml.synthetic import synthetic_long_frame

HAS_MODELS = bool(get_registry().names)
DELHI = next(c for c in CITIES if c.id == "delhi")
# A fixed hour two days ago, so the endpoint's "last N days" window includes it.
T0 = pd.Timestamp.now(tz="UTC").floor("h") - pd.Timedelta(hours=48)


def fake_inputs(end: pd.Timestamp, seed: int = 0):
    def fetch(client, city, past_hours):
        return synthetic_long_frame(past_hours, end=end, seed=seed), 0.0

    return fetch


def fake_centre(end: pd.Timestamp):
    def fetch(client, city, past_hours):
        frame = synthetic_long_frame(past_hours, end=end, seed=7)
        return frame[frame["point"] == "c"]

    return fetch


def at(ts: pd.Timestamp) -> datetime:
    return ts.to_pydatetime()


def count(model) -> int:
    with db.new_session() as s:
        return s.scalar(select(func.count()).select_from(model))


@pytest.mark.skipif(not HAS_MODELS, reason="no trained models yet")
def test_issue_then_score(client, monkeypatch):
    names = get_registry().names
    monkeypatch.setattr(track_record, "fetch_inputs", fake_inputs(T0))
    first = track_record.run_cycle(now=at(T0), cities=[DELHI])
    assert first.failures == []
    assert first.runs_stored == len(names)
    assert first.points_scored == 0  # nothing it predicted has happened yet
    assert first.observations_saved > 0

    later = T0 + pd.Timedelta(hours=30)
    monkeypatch.setattr(track_record, "fetch_inputs", fake_inputs(later, seed=1))
    second = track_record.run_cycle(now=at(later), cities=[DELHI])
    assert second.points_scored == len(names) * 24 * 3  # first cycle's 24 h are now known
    assert second.runs_stored == len(names)  # and new forecasts were issued

    again = track_record.run_cycle(now=at(later), cities=[DELHI])
    assert again.runs_stored == 0 and again.points_scored == 0 and again.observations_saved == 0

    body = client.get("/api/track-record", params={"days": 7}).json()
    assert {m["model"] for m in body["models"]} == set(names)
    assert body["cities"] == 1
    assert body["first_valid_at"].endswith("+00:00")  # explicit UTC, even on SQLite
    totals = [t for t in body["totals"] if t["target"] == "temperature"]
    assert {t["n"] for t in totals} == {24}
    assert len({t["persistence_mae"] for t in totals}) == 1  # same hours for every model
    for t in body["totals"]:
        assert 0 <= t["coverage"] <= 1 and t["mae"] >= 0
    assert sum(r["n"] for r in body["daily"] if r["model"] == names[0] and r["target"] == "humidity") == 24
    assert {r["lead"] for r in body["by_lead"]} == {"1-6", "7-12", "13-18", "19-24"}
    by_city = [r for r in body["by_city"] if r["target"] == "temperature"]
    assert {r["city"] for r in by_city} == {"delhi"} and {r["n"] for r in by_city} == {24}
    assert set(body["city_days"]) == {"delhi"} and body["city_days"]["delhi"] in (1, 2)  # 24 h: one or two UTC days
    assert body["min_days_per_city"] == 14
    assert body["pending_points"] == len(names) * 24 * 3  # the second cycle's forecasts
    chance = body["rain_chance"]
    if "ensemble" in names and get_registry().get("ensemble").rain_chance is not None:
        assert chance["n"] == 24 and 0 <= chance["brier"] <= 1 and 0 <= chance["usual_brier"] <= 1
        assert sum(r["n"] for r in chance["reliability"]) == 24


def test_observations_are_settled_and_never_overwritten(client):
    centre = synthetic_long_frame(30, end=T0)
    centre = centre[centre["point"] == "c"]
    with db.new_session() as s:
        saved = track_record.save_observations(s, DELHI, centre, at(T0))
        assert saved == 30 - track_record.SETTLE_HOURS
        changed = centre.assign(temperature_2m=centre["temperature_2m"] + 10)
        assert track_record.save_observations(s, DELHI, changed, at(T0)) == 0
        newest = s.scalar(select(func.max(db.Observation.valid_at)))
    assert track_record.utc_naive(newest) == track_record.utc_naive(T0 - pd.Timedelta(hours=track_record.SETTLE_HOURS))


def test_old_unscored_points_are_backfilled(client, monkeypatch):
    issued = T0 - pd.Timedelta(days=5)
    with db.new_session() as s:
        run = db.PredictionRun(model="lstm", city_id="delhi", issued_at=at(issued), model_set="india")
        run.points.append(
            db.PredictionPoint(valid_at=at(issued + pd.Timedelta(hours=1)), lead_hours=1, target="temperature", value=20, lower=18, upper=22)
        )
        s.add(run)
        s.commit()
        assert track_record.needs_backfill(s, DELHI, at(T0)) > track_record.FETCH_HOURS

    monkeypatch.setattr(track_record, "fetch_inputs", fake_inputs(T0))
    monkeypatch.setattr(track_record, "fetch_centre", fake_centre(T0))
    summary = track_record.run_cycle(registry=_NoModels(), now=at(T0), cities=[DELHI])
    assert summary.failures == []
    with db.new_session() as s:
        point = s.scalars(select(db.PredictionPoint)).one()
        assert point.observed is not None and point.persistence is not None and point.scored_at is not None


def test_one_city_failing_does_not_stop_the_others(client, monkeypatch):
    def flaky(client_, city, past_hours):
        if city.id == "delhi":
            raise RuntimeError("Open-Meteo kept rate-limiting the request")
        return synthetic_long_frame(past_hours, end=T0), 0.0

    monkeypatch.setattr(track_record, "fetch_inputs", flaky)
    jaipur = next(c for c in CITIES if c.id == "jaipur")
    summary = track_record.run_cycle(registry=_NoModels(), now=at(T0), cities=[DELHI, jaipur])
    assert summary.cities == 1
    assert len(summary.failures) == 1 and summary.failures[0].startswith("delhi")
    assert count(db.Observation) > 0


def test_empty_track_record(client):
    body = client.get("/api/track-record").json()
    assert body["totals"] == [] and body["daily"] == [] and body["runs"] == 0
    assert body["by_city"] == [] and body["city_days"] == {}
    assert "not a weather-station reading" in body["source"]


def test_unknown_city_is_rejected(client):
    assert client.get("/api/track-record", params={"city": "london"}).status_code == 404


@pytest.mark.parametrize(
    ("now", "expected"),
    [
        (datetime(2026, 11, 19, 10, 5, tzinfo=timezone.utc), datetime(2026, 11, 19, 12, 10, tzinfo=timezone.utc)),
        (datetime(2026, 11, 19, 9, 5, tzinfo=timezone.utc), datetime(2026, 11, 19, 9, 10, tzinfo=timezone.utc)),
        (datetime(2026, 11, 19, 23, 30, tzinfo=timezone.utc), datetime(2026, 11, 20, 0, 10, tzinfo=timezone.utc)),
    ],
)
def test_schedule_is_aligned_to_utc_hours(now, expected):
    assert track_record.seconds_until_next(3, now) == (expected - now).total_seconds()


class _NoModels:
    """A registry with no models: the job then only saves observations and scores."""

    names: list[str] = []


def test_bad_days_value_is_rejected(client):
    assert client.get("/api/track-record", params={"days": 0}).status_code == 422
    assert client.get("/api/track-record", params={"days": 400}).status_code == 422


def test_window_excludes_old_points(client, monkeypatch):
    with db.new_session() as s:
        old = T0 - pd.Timedelta(days=40)
        run = db.PredictionRun(model="lstm", city_id="delhi", issued_at=at(old), model_set="india")
        run.points.append(
            db.PredictionPoint(
                valid_at=at(old + timedelta(hours=1)), lead_hours=1, target="temperature",
                value=20, lower=18, upper=22, observed=21, persistence=19, scored_at=at(T0),
            )
        )
        s.add(run)
        s.commit()
    assert client.get("/api/track-record", params={"days": 30}).json()["totals"] == []
    assert client.get("/api/track-record", params={"days": 60}).json()["totals"][0]["mae"] == 1.0


def test_older_model_sets_stay_out_of_the_record(client):
    """The North India and all-India sets share model names; only the served set is summarised."""
    with db.new_session() as s:
        for model_set, observed in (("north_india", 25.0), ("india", 21.0)):
            run = db.PredictionRun(model="lstm", city_id="delhi", issued_at=at(T0), model_set=model_set)
            run.points.append(
                db.PredictionPoint(
                    valid_at=at(T0 + timedelta(hours=1)), lead_hours=1, target="temperature",
                    value=20, lower=18, upper=22, observed=observed, persistence=19, scored_at=at(T0),
                )
            )
            s.add(run)
        s.commit()
    body = client.get("/api/track-record", params={"days": 30}).json()
    assert body["model_set"] == "india"
    assert [t["mae"] for t in body["totals"]] == [1.0]


@pytest.mark.skipif(
    "ensemble" not in get_registry().names or get_registry().get("ensemble").rain_chance is None,
    reason="no chance-of-rain table",
)
def test_chance_of_rain_is_scored(client):
    usual = get_registry().get("ensemble").rain_chance["validation_rain_share"]
    with db.new_session() as s:
        run = db.PredictionRun(model="ensemble", city_id="delhi", issued_at=at(T0), model_set="india")
        for lead, (chance, observed, yesterday) in enumerate([(0.8, 1.2, 0.0), (0.2, 0.0, 0.0), (0.95, 0.4, 2.0), (None, 3.0, 0.0)], start=1):
            run.points.append(
                db.PredictionPoint(
                    valid_at=at(T0 + timedelta(hours=lead)), lead_hours=lead, target="precipitation", value=0.1,
                    lower=0, upper=1, rain_chance=chance, observed=observed, persistence=yesterday, scored_at=at(T0),
                )
            )
        s.add(run)
        s.commit()
    rc = client.get("/api/track-record", params={"days": 30}).json()["rain_chance"]
    assert rc["n"] == 3  # the point without a stored chance is left out
    assert rc["brier"] == pytest.approx((pow(0.2, 2) + pow(0.2, 2) + pow(0.05, 2)) / 3, abs=1e-5)
    assert rc["usual_brier"] == pytest.approx((pow(1 - usual, 2) * 2 + pow(usual, 2)) / 3, abs=1e-5)
    assert rc["yesterday_brier"] == pytest.approx(1 / 3, abs=1e-5)  # yesterday dry, dry, wet; today wet, dry, wet: one miss
    assert rc["rain_share"] == pytest.approx(2 / 3, abs=1e-4)
    assert [r["band"] for r in rc["reliability"]] == ["10-30%", "70-90%", "90-100%"]
