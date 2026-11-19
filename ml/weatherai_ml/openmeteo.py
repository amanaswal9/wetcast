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


def _get(client: httpx.Client, url: str, params: dict, retries: int = 5) -> list[dict] | dict:
    for attempt in range(retries):
        response = client.get(url, params=params)
        if response.status_code == 429:
            wait = 65 * (attempt + 1)
            print(f"  rate limited, waiting {wait}s")
            time.sleep(wait)
            continue
        response.raise_for_status()
        return response.json()
    raise RuntimeError("Open-Meteo kept rate-limiting the request")


def fetch_history(client: httpx.Client, city: City, start: str, end: str) -> tuple[pd.DataFrame, float]:
    coords = point_coords(city)
    params = {
        "latitude": ",".join(str(lat) for _, lat, _ in coords),
        "longitude": ",".join(str(lon) for _, _, lon in coords),
        "start_date": start,
        "end_date": end,
        "hourly": ",".join(API_VARIABLES),
        "timezone": "GMT",
    }
    return _to_frame(_get(client, HISTORICAL_URL, params), [name for name, _, _ in coords])


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
