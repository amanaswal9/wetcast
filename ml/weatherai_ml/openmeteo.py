"""Open-Meteo access shared by training (historical forecast archive) and inference (live forecast API).

Training uses the Historical Forecast API, which stitches together the same
weather models the live Forecast API serves. Using the same source family for
training and inference avoids a train/serve mismatch.
"""

from __future__ import annotations

import time

import httpx
import pandas as pd

from .config import API_VARIABLES, POINTS, City

HISTORICAL_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"


def point_coords(city: City) -> list[tuple[str, float, float]]:
    """(name, latitude, longitude) of the city centre and its four neighbour points."""
    return [(name, round(city.latitude + dlat, 4), round(city.longitude + dlon, 4)) for name, dlat, dlon in POINTS]


def _to_frame(payload: list[dict] | dict, names: list[str]) -> tuple[pd.DataFrame, float]:
    """Long frame (time, point, variables...) plus the centre point's elevation."""
    items = payload if isinstance(payload, list) else [payload]
    if len(items) != len(names):
        raise ValueError(f"expected {len(names)} locations, got {len(items)}")
    frames = []
    for name, item in zip(names, items):
        hourly = item["hourly"]
        df = pd.DataFrame({var: hourly[var] for var in API_VARIABLES})
        df["time"] = pd.to_datetime(hourly["time"], utc=True)
        df["point"] = name
        frames.append(df)
    elevation = float(items[0].get("elevation", 0.0))
    return pd.concat(frames, ignore_index=True), elevation


def _rate_limit_wait(response: httpx.Response) -> tuple[int, str]:
    """How long to wait after a 429, based on which free-tier limit was hit."""
    try:
        reason = str(response.json().get("reason", ""))
    except ValueError:
        reason = ""
    lower = reason.lower()
    now = time.time()
    if "daily" in lower:
        return 3600, reason  # check again every hour until the daily quota resets
    if "hourly" in lower:
        return int(3600 - now % 3600) + 90, reason  # just past the top of the next hour
    return 65, reason or "rate limited"


def _get(client: httpx.Client, url: str, params: dict, retries: int = 5, patient: bool = False) -> list[dict] | dict:
    """GET with retries. `patient=True` (bulk downloads) waits out hourly and
    daily limits indefinitely instead of giving up."""
    attempt = 0
    while True:
        try:
            response = client.get(url, params=params)
        except httpx.TransportError as exc:
            attempt += 1
            if attempt >= retries and not patient:
                raise
            print(f"  network error ({exc}); retrying in 120 s", flush=True)
            time.sleep(120)
            continue
        if response.status_code == 429:
            attempt += 1
            wait, reason = _rate_limit_wait(response)
            # Live callers (a web request, the track-record job) must not sleep for an hour.
            if not patient and (attempt >= retries or wait > 120):
                raise RuntimeError(f"Open-Meteo kept rate-limiting the request: {reason}")
            stamp = time.strftime("%Y-%m-%d %H:%M:%S")
            print(f"  [{stamp}] {reason}; waiting {wait // 60} min {wait % 60} s", flush=True)
            time.sleep(wait)
            continue
        response.raise_for_status()
        return response.json()


def fetch_history(client: httpx.Client, city: City, start: str, end: str) -> tuple[pd.DataFrame, float]:
    """Archived hourly weather at all five points between two dates, for training."""
    coords = point_coords(city)
    params = {
        "latitude": ",".join(str(lat) for _, lat, _ in coords),
        "longitude": ",".join(str(lon) for _, _, lon in coords),
        "start_date": start,
        "end_date": end,
        "hourly": ",".join(API_VARIABLES),
        "timezone": "GMT",
    }
    return _to_frame(_get(client, HISTORICAL_URL, params, patient=True), [name for name, _, _ in coords])


def fetch_centre_recent(client: httpx.Client, city: City, past_hours: int) -> pd.DataFrame:
    """The city centre's last `past_hours` hours (up to 92 days), one location only.
    Used to look up what happened when scoring older stored forecasts."""
    params = {
        "latitude": round(city.latitude, 4),
        "longitude": round(city.longitude, 4),
        "hourly": ",".join(API_VARIABLES),
        "timezone": "GMT",
        "past_hours": min(past_hours, 92 * 24),
        "forecast_hours": 1,
    }
    frame, _ = _to_frame(_get(client, FORECAST_URL, params, retries=2), ["c"])
    return frame


def fetch_recent(client: httpx.Client, city: City, past_hours: int) -> tuple[pd.DataFrame, float]:
    """The most recent `past_hours` hours for all points, for live inference."""
    coords = point_coords(city)
    params = {
        "latitude": ",".join(str(lat) for _, lat, _ in coords),
        "longitude": ",".join(str(lon) for _, _, lon in coords),
        "hourly": ",".join(API_VARIABLES),
        "timezone": "GMT",
        "past_hours": past_hours,
        "forecast_hours": 1,
    }
    return _to_frame(_get(client, FORECAST_URL, params, retries=2), [name for name, _, _ in coords])
