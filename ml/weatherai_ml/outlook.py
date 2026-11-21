"""Open-Meteo's own rain forecast from a day earlier, as an input for the ensemble's rain correction.

    python -m weatherai_ml.outlook --region india     # download 2025-2026 for every city (resumable)

WeatherAI's targets are Open-Meteo's archived hourly weather, so the best outside hint about the next
24 hours' rain is what Open-Meteo itself forecast for those hours. The Previous Runs API keeps that
forecast as `precipitation_previous_day1`: the value for an hour as forecast about a day before it.
For every hour of a 24-hour forecast that run already exists at issue time, so training and live use
see the same kind of input (live, Open-Meteo may answer the coming hours from a run up to a day newer,
which can only help). Free, no key, the same non-commercial terms as the rest of Open-Meteo.

Only the city centre is downloaded, from the start of the validation year (2025) to the end of the
data: the correction is fitted on 2025 and scored on 2026.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone

import httpx
import numpy as np
import pandas as pd

from .config import DATA_END, REGION_NAMES, City, raw_dir, region_cities
from .openmeteo import _get

PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast"
VARIABLE = "precipitation_previous_day1"
START = "2024-12-30"  # a little before the validation year, so its first windows have the forecast


def folder(region: str):
    return raw_dir(region) / "outlook"


def fetch_history(client: httpx.Client, city: City, start: str, end: str) -> pd.Series:
    """Hourly day-old rain forecast (mm) at the city centre, indexed by UTC time."""
    params = {
        "latitude": round(city.latitude, 4),
        "longitude": round(city.longitude, 4),
        "hourly": VARIABLE,
        "start_date": start,
        "end_date": end,
        "timezone": "GMT",
    }
    hourly = _get(client, PREVIOUS_RUNS_URL, params, patient=True)["hourly"]
    return pd.Series(hourly[VARIABLE], index=pd.to_datetime(hourly["time"], utc=True), dtype=float, name="rain_day1")


def fetch_live(client: httpx.Client, city: City, issued: pd.Timestamp, hours: int = 24) -> np.ndarray:
    """(hours,) forecast rain for the hours after `issued`, NaN where Open-Meteo has none."""
    params = {
        "latitude": round(city.latitude, 4),
        "longitude": round(city.longitude, 4),
        "hourly": VARIABLE,
        "timezone": "GMT",
        "past_hours": 2,
        "forecast_hours": hours + 2,
    }
    hourly = _get(client, PREVIOUS_RUNS_URL, params, retries=2)["hourly"]
    series = pd.Series(hourly[VARIABLE], index=pd.to_datetime(hourly["time"], utc=True), dtype=float)
    ts = pd.Timestamp(issued)
    ts = ts.tz_convert("UTC") if ts.tzinfo else ts.tz_localize("UTC")
    wanted = pd.date_range(ts + pd.Timedelta(hours=1), periods=hours, freq="h")
    return series.reindex(wanted).to_numpy(dtype=float)


def load_for_dataset(ds, region: str) -> np.ndarray:
    """(rows,) the day-old forecast for each dataset row's hour and city; NaN where not downloaded."""
    out = np.full(len(ds.times), np.nan)
    for k, city in enumerate(ds.cities):
        path = folder(region) / f"{city.id}.parquet"
        if not path.exists():
            continue
        series = pd.read_parquet(path)["rain_day1"]
        rows = np.flatnonzero(ds.city_of_row == k)
        times = ds.times[rows]
        times = times.tz_localize("UTC") if times.tz is None else times.tz_convert("UTC")
        out[rows] = series.reindex(times).to_numpy(dtype=float)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", choices=REGION_NAMES, default="north_india")
    args = parser.parse_args()
    target = folder(args.region)
    target.mkdir(parents=True, exist_ok=True)
    manifest_path = target / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    cities = region_cities(args.region)
    with httpx.Client(timeout=120) as client:
        for i, city in enumerate(cities, start=1):
            path = target / f"{city.id}.parquet"
            if path.exists():
                continue
            series = fetch_history(client, city, START, DATA_END)
            series.to_frame().to_parquet(path)
            manifest[city.id] = {
                "rows": int(series.size),
                "missing": int(series.isna().sum()),
                "start": START,
                "end": DATA_END,
                "source": f"Open-Meteo Previous Runs API ({VARIABLE})",
                "downloaded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            manifest_path.write_text(json.dumps(manifest, indent=2))
            print(f"[{i}/{len(cities)}] {city.id}: {series.size} hours, {int(series.isna().sum())} missing", flush=True)
            time.sleep(2)
    print("OUTLOOK DOWNLOAD DONE", flush=True)


if __name__ == "__main__":
    main()
