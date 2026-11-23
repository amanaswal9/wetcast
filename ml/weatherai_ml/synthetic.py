"""Synthetic raw data in Open-Meteo's long format. FOR TESTS ONLY: never used
for training, evaluation or anything shown in the app."""

from __future__ import annotations

import numpy as np
import pandas as pd

from .config import POINTS


def synthetic_long_frame(hours: int, end: pd.Timestamp | None = None, seed: int = 0) -> pd.DataFrame:
    """`hours` hours of made-up weather at all five points, ending at `end` (default: now)."""
    rng = np.random.default_rng(seed)
    end = (end or pd.Timestamp.now(tz="UTC")).floor("h")
    times = pd.date_range(end=end, periods=hours, freq="h", tz="UTC")
    diurnal = np.sin(2 * np.pi * (times.hour.to_numpy() - 9) / 24)
    frames = []
    for name, _, _ in POINTS:
        frames.append(
            pd.DataFrame(
                {
                    "time": times,
                    "point": name,
                    "temperature_2m": 22 + 6 * diurnal + rng.normal(0, 0.5, hours),
                    "relative_humidity_2m": np.clip(55 - 15 * diurnal + rng.normal(0, 2, hours), 5, 100),
                    "precipitation": np.where(rng.random(hours) < 0.05, rng.gamma(1.0, 1.5, hours), 0.0),
                    "pressure_msl": 1008 + rng.normal(0, 1, hours),
                    "wind_speed_10m": np.abs(rng.normal(8, 3, hours)),
                    "wind_direction_10m": rng.uniform(0, 360, hours),
                    "cloud_cover": rng.uniform(0, 100, hours),
                }
            )
        )
    return pd.concat(frames, ignore_index=True)
