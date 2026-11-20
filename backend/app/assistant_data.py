"""Read-only data the assistant can look up. Every function returns a small,
plain dict labelled with its source, so the model can only repeat real data
and say where it came from. Nothing here writes to the database."""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import httpx
import numpy as np
from sqlalchemy.orm import Session

from weatherai_ml.config import TARGET_UNITS, TARGETS
from weatherai_ml.predict import InsufficientHistoryError

from . import alerts as official_alerts
from .accuracy import track_record_summary
from . import coverage as model_coverage
from .predictions import UpstreamError, recent_features
from .registry import ModelRegistry

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
CACHE_SECONDS = 600
IST = ZoneInfo("Asia/Kolkata")  # every city WeatherAI's models cover is in India

# WMO weather codes, as Open-Meteo reports them.
WEATHER_CODES = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "heavy freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers",
    82: "violent showers", 85: "snow showers", 86: "heavy snow showers", 95: "thunderstorm",
    96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
}

_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def _cached(key: str, fetch) -> dict:
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
    value = fetch()
    with _lock:
        _cache[key] = (time.monotonic() + CACHE_SECONDS, value)
    return value


def _get(url: str, params: dict) -> dict:
    try:
        response = httpx.get(url, params=params, timeout=15)
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise UpstreamError("Open-Meteo couldn't be reached.") from exc


def _r(value, digits: int = 1):
    return None if value is None else round(float(value), digits)


def find_place(name: str) -> dict:
    data = _cached(f"geo:{name.lower()}", lambda: _get(GEOCODING_URL, {"name": name, "count": 3, "language": "en", "format": "json"}))
    results = [
        {
            "name": r.get("name"),
            "region": r.get("admin1"),
            "country": r.get("country"),
            "country_code": r.get("country_code"),
            "latitude": _r(r.get("latitude"), 4),
            "longitude": _r(r.get("longitude"), 4),
        }
        for r in data.get("results", []) or []
    ]
    return {"source": "Open-Meteo geocoding", "matches": results}


def weather(latitude: float, longitude: float) -> dict:
    """Current conditions, the next 48 hours every 3 hours, and 7 days, in the place's local time."""
    params = {
        "latitude": round(latitude, 3),
        "longitude": round(longitude, 3),
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
        "hourly": "temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,relative_humidity_2m_min,relative_humidity_2m_max,precipitation_probability_max,precipitation_sum,wind_speed_10m_max",
        "timezone": "auto",
        "forecast_days": 7,
    }
    data = _cached(f"wx:{params['latitude']},{params['longitude']}", lambda: _get(FORECAST_URL, params))
    cur = data.get("current", {})
    hourly = data.get("hourly", {})
    now_local = cur.get("time", "")
    hours = []
    for i, t in enumerate(hourly.get("time", [])):
        if t < now_local[:13] or len(hours) >= 16:
            continue
        if int(t[11:13]) % 3:
            continue
        hours.append(
            {
                "time": t,
                "temperature_c": _r(hourly["temperature_2m"][i]),
                "humidity_pct": hourly["relative_humidity_2m"][i],
                "chance_of_rain_pct": hourly["precipitation_probability"][i],
                "rain_mm": _r(hourly["precipitation"][i]),
                "sky": WEATHER_CODES.get(hourly["weather_code"][i], "unknown"),
                "wind_kmh": _r(hourly["wind_speed_10m"][i], 0),
            }
        )
    daily = data.get("daily", {})
    days = [
        {
            "date": d,
            "sky": WEATHER_CODES.get(daily["weather_code"][i], "unknown"),
            "high_c": _r(daily["temperature_2m_max"][i]),
            "low_c": _r(daily["temperature_2m_min"][i]),
            "humidity_low_pct": (daily.get("relative_humidity_2m_min") or [None] * (i + 1))[i],
            "humidity_high_pct": (daily.get("relative_humidity_2m_max") or [None] * (i + 1))[i],
            "chance_of_rain_pct": daily["precipitation_probability_max"][i],
            "rain_mm": _r(daily["precipitation_sum"][i]),
            "max_wind_kmh": _r(daily["wind_speed_10m_max"][i], 0),
        }
        for i, d in enumerate(daily.get("time", []))
    ]
    return {
        "source": "Open-Meteo forecast (weather-model data from national weather services, not WeatherAI's own models)",
        "timezone": data.get("timezone"),
        "local_time_now": now_local,
        "now": {
            "temperature_c": _r(cur.get("temperature_2m")),
            "feels_like_c": _r(cur.get("apparent_temperature")),
            "humidity_pct": cur.get("relative_humidity_2m"),
            "rain_last_hour_mm": _r(cur.get("precipitation")),
            "sky": WEATHER_CODES.get(cur.get("weather_code"), "unknown"),
            "wind_kmh": _r(cur.get("wind_speed_10m"), 0),
            "wind_from_degrees": cur.get("wind_direction_10m"),
            "gusts_kmh": _r(cur.get("wind_gusts_10m"), 0),
        },
        "next_48_hours_every_3_hours": hours,
        "next_7_days": days,
    }


def weatherai_prediction(registry: ModelRegistry, latitude: float, longitude: float, country: str | None = None) -> dict:
    """WeatherAI's own 24-hour forecast (the ensemble), where its models cover the place."""
    region = registry.region_id
    located = model_coverage.locate(region, latitude, longitude, country)
    if located is None:
        return {"available": False, "reason": model_coverage.unsupported_detail(region)}
    city = located.city
    name = "ensemble" if registry.get("ensemble") else (registry.names[0] if registry.names else None)
    if name is None:
        return {"available": False, "reason": "No trained models are loaded on this server."}
    predictor = registry.get(name)
    try:
        features = recent_features(registry, city, predictor.preprocessor.lookback)
        pred = predictor.predict(features)
    except (UpstreamError, InsufficientHistoryError) as exc:
        return {"available": False, "reason": str(exc)}
    metrics = registry.metrics(name)
    rows = []
    for i, t in enumerate(pred.times):
        if (i + 1) % 3:
            continue
        row = {"time": t.tz_convert(IST).strftime("%Y-%m-%dT%H:%M"), "hours_ahead": i + 1}
        for k, target in enumerate(TARGETS):
            unit = {"°C": "c", "%": "pct", "mm": "mm"}[TARGET_UNITS[target]]
            row[f"{target}_{unit}"] = _r(pred.values[i, k])
            row[f"{target}_range_{unit}"] = [_r(pred.lower[i, k]), _r(pred.upper[i, k])]
        rows.append(row)
    level = metrics["interval"]["level"]
    label, detail = model_coverage.describe(region, located)
    expected = model_coverage.expected_error(registry, name, located)
    return {
        "available": True,
        "place_kind": f"{label}. {detail}",
        "source": f"WeatherAI's own {registry.display_name(name)} model (machine-learning forecast, not an official forecast)",
        "city": city.name,
        "times": "India Standard Time",
        "issued_from_data_up_to": pred.issued_at.tz_convert(IST).strftime("%Y-%m-%dT%H:%M"),
        "ranges": f"Each range is sized to hold {round(level * 100)}% of past errors; on the 2026 test period they held about "
        f"{round(min(metrics['interval']['test_coverage'].values()) * 100)}-{round(max(metrics['interval']['test_coverage'].values()) * 100)}% of the time.",
        "expected_error_here": {
            t: f"{v:.2f} {TARGET_UNITS[t]} average error ({expected['basis']})" for t, v in expected["mae"].items() if v is not None
        },
        "forecast_every_3_hours": rows,
    }


def official_alerts_at(session: Session, latitude: float, longitude: float, country_code: str | None) -> dict:
    coverage = official_alerts.coverage_for(latitude, longitude, country_code)
    if coverage == "none":
        return {"covered": False, "note": "WeatherAI has no official warning feed for this country. Point people to their national weather service."}
    if coverage == "india":
        rows = official_alerts.active_sachet_alerts(session, latitude, longitude)
        found = official_alerts.sort_alerts([official_alerts.alert_out(a) for a in rows])
        poll = official_alerts.POLL
        source = "NDMA Sachet (India Meteorological Department and state authorities)"
        note = "The feed is not a complete archive: no alert here does not rule out a local warning."
        checked = poll.last_ok.isoformat() if poll.last_ok else None
    else:
        try:
            found = official_alerts.sort_alerts(official_alerts.fetch_nws(latitude, longitude))
        except official_alerts.AlertSourceError as exc:
            return {"covered": True, "error": str(exc)}
        source, note, checked = "US National Weather Service", "", datetime.now(timezone.utc).isoformat()
    keep = ("event", "severity", "headline", "area", "onset", "expires", "sender", "instruction")
    return {
        "covered": True,
        "source": source,
        "feed_checked_at_utc": checked,
        "note": note,
        "alerts": [{k: a.get(k) for k in keep} for a in found[:5]],
    }


def model_accuracy(session: Session, registry: ModelRegistry) -> dict:
    """How well each model did on unseen 2026 data, plus the live track record."""
    models = {}
    baseline = None
    for name in registry.names:
        m = registry.metrics(name)
        models[registry.display_name(name)] = {t: round(m["test"][t]["mae"], 3) for t in TARGETS}
        baseline = {t: round(m["persistence_baseline"][t]["mae"], 3) for t in TARGETS}
    record = track_record_summary(session, registry, days=30, city=None)
    # Sorted best first, with display names, and the winners stated outright: a small model should
    # not have to work out which number is lowest.
    totals = sorted((t for t in record["totals"] if t["target"] == "temperature"), key=lambda t: t["mae"])
    live = [
        {"model": registry.display_name(t["model"]), "mae_c": t["mae"], "persistence_mae_c": t["persistence_mae"], "hours_scored": t["n"]}
        for t in totals
    ]
    best_on_test = {
        t: {"model": name, "mean_absolute_error": scores[t], "units": TARGET_UNITS[t]}
        for t in TARGETS
        for name, scores in [min(models.items(), key=lambda kv: kv[1][t])]
    }
    days_live = 0.0
    if record["first_valid_at"] and record["last_valid_at"]:
        days_live = (datetime.fromisoformat(record["last_valid_at"]) - datetime.fromisoformat(record["first_valid_at"])).total_seconds() / 86400
    return {
        "source": "WeatherAI's evaluation (test period Jan-Oct 2026, never used in training) and its live track record",
        "most_accurate_on_test_period": best_on_test,
        "test_mean_absolute_error": {"units": {t: TARGET_UNITS[t] for t in TARGETS}, **models},
        "persistence_baseline": baseline,
        "persistence_means": "predicting the same hour as the day before; a useful model should beat it",
        "live_track_record_last_30_days_temperature_best_first": live or "Nothing scored yet.",
        "most_accurate_live": live[0]["model"] if live else None,
        "live_record_days": round(days_live, 1),
        "live_record_note": (
            "Under two weeks of live scores: too early to judge; say so and rely on the test period."
            if days_live < 14
            else "Several weeks of live scores."
        ),
    }


def nan_safe(obj):
    """JSON can't hold NaN; replace it with null."""
    if isinstance(obj, dict):
        return {k: nan_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [nan_safe(v) for v in obj]
    if isinstance(obj, float) and not np.isfinite(obj):
        return None
    return obj
