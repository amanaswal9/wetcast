"""Check test-period predictions against real weather-station measurements (Meteostat).

The models are trained and tested on Open-Meteo model data. This adds a second,
independent check against what thermometers and hygrometers actually recorded.
It also scores Open-Meteo's own data against the stations, so you can see how
much of the error comes from the data source itself.
"""

from __future__ import annotations

import warnings
from datetime import datetime

import numpy as np
import pandas as pd

from .config import CITIES, DATA_DIR, SPLITS, TARGETS
from .metrics import summary

STATION_DIR = DATA_DIR / "stations"
MAX_STATION_KM = 30
COLUMNS = {"temperature": "temp", "humidity": "rhum"}


def station_observations(city) -> tuple[pd.DataFrame | None, dict | None]:
    """Hourly observations (UTC) from the nearest station with data, cached to disk."""
    STATION_DIR.mkdir(parents=True, exist_ok=True)
    cache = STATION_DIR / f"{city.id}.parquet"
    meta_cache = STATION_DIR / f"{city.id}.meta.json"
    if cache.exists() and meta_cache.exists():
        return pd.read_parquet(cache), pd.read_json(meta_cache, typ="series").to_dict()

    warnings.filterwarnings("ignore")
    import meteostat as ms

    start = datetime.fromisoformat(SPLITS["test"][0])
    end = datetime.fromisoformat(SPLITS["test"][1])
    nearby = ms.stations.nearby(ms.Point(city.latitude, city.longitude), radius=MAX_STATION_KM * 1000, limit=5)
    for sid, row in nearby.iterrows():
        df = ms.hourly(sid, start, end).fetch()
        if df is None or df.empty or df["temp"].notna().sum() < 1000:
            continue
        obs = df[["temp", "rhum"]].copy()
        obs.index = pd.to_datetime(obs.index).tz_localize("UTC")
        meta = {"id": str(sid), "name": str(row["name"]), "distance_km": round(float(row["distance"]) / 1000, 1)}
        obs.to_parquet(cache)
        pd.Series(meta).to_json(meta_cache)
        return obs, meta
    return None, None


def station_check(ds, ends: np.ndarray, lead6: np.ndarray, lead24: np.ndarray) -> dict:
    """Metrics vs stations for temperature and humidity, at 6 h and 24 h lead.
    Training cities and held-out cities are pooled separately."""
    def empty():
        return {t: {"lead6": ([], []), "lead24": ([], []), "open_meteo": ([], [])} for t in COLUMNS}

    per_city, groups = {}, {"train": empty(), "holdout": empty()}
    end_city = ds.city_of_row[ends]
    for c, city in enumerate(ds.cities or CITIES):
        mask = end_city == c
        if not mask.any():
            continue
        pooled = groups.get(city.role, groups["train"])
        try:
            obs, meta = station_observations(city)
        except Exception as exc:  # noqa: BLE001 - network or provider issue: record and continue
            per_city[city.id] = {"available": False, "reason": f"station data unavailable ({type(exc).__name__})"}
            continue
        if obs is None:
            per_city[city.id] = {"available": False, "reason": f"no station with hourly data within {MAX_STATION_KM} km"}
            continue
        entry = {"available": True, "station": meta, "role": city.role}
        for target, col in COLUMNS.items():
            k = TARGETS.index(target)
            for lead, pred in (("lead6", lead6), ("lead24", lead24)):
                valid = pd.DatetimeIndex(ds.times[ends[mask] + int(lead[4:])])
                observed = obs[col].reindex(valid).to_numpy(dtype=float)
                pooled[target][lead][0].append(observed)
                pooled[target][lead][1].append(pred[mask, k])
                entry[f"{target}_{lead}"] = summary(observed, pred[mask, k])
            rows = np.where((ds.city_of_row == c))[0]
            rows = rows[(ds.times[rows] >= pd.Timestamp(SPLITS["test"][0], tz="UTC"))]
            observed = obs[col].reindex(pd.DatetimeIndex(ds.times[rows])).to_numpy(dtype=float)
            pooled[target]["open_meteo"][0].append(observed)
            pooled[target]["open_meteo"][1].append(ds.targets[rows, k])
            entry[f"{target}_open_meteo"] = summary(observed, ds.targets[rows, k])
        per_city[city.id] = entry

    def pool(group: dict) -> dict:
        out = {}
        for target, parts in group.items():
            out[target] = {key: summary(np.concatenate(ys), np.concatenate(ps)) for key, (ys, ps) in parts.items() if ys}
        return out

    result = {
        "source": "Meteostat hourly station observations (nearest station within 30 km)",
        "note": "open_meteo = Open-Meteo's own data vs the station: the error floor of the training data.",
        "overall": pool(groups["train"]),
        "per_city": per_city,
    }
    unseen = pool(groups["holdout"])
    if any(unseen.values()):
        result["overall_unseen"] = unseen
    return result
