"""Raw Open-Meteo data -> model features and targets.

Used unchanged by training and by live inference, so both see identical
transformations in the identical column order (config.FEATURE_ORDER).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .config import API_VARIABLES, FEATURE_ORDER, POINTS, TARGETS, City

MAX_GAP_HOURS = 3


def _point_features(df: pd.DataFrame) -> pd.DataFrame:
    """The seven model inputs for one grid point, from its raw Open-Meteo columns."""
    direction = np.deg2rad(df["wind_direction_10m"].astype(float))
    speed = df["wind_speed_10m"].astype(float)
    return pd.DataFrame(
        {
            "temp": df["temperature_2m"].astype(float),
            "rh": df["relative_humidity_2m"].astype(float),
            "precip_log1p": np.log1p(df["precipitation"].astype(float).clip(lower=0)),
            "pressure": df["pressure_msl"].astype(float),
            # Wind as u/v components (meteorological convention: direction the wind comes from).
            "wind_u": -speed * np.sin(direction),
            "wind_v": -speed * np.cos(direction),
            "cloud": df["cloud_cover"].astype(float),
        },
        index=df.index,
    )


def _fill_short_gaps(frame: pd.DataFrame, max_gap: int) -> pd.DataFrame:
    """Linearly interpolate runs of missing values no longer than `max_gap`.
    Longer runs stay entirely missing (pandas' `limit` would half-fill them)."""
    filled = frame.interpolate(limit_area="inside")
    for col in frame.columns:
        missing = frame[col].isna()
        run_id = (missing != missing.shift()).cumsum()
        run_len = missing.groupby(run_id).transform("sum")
        too_long = missing & (run_len > max_gap)
        filled.loc[too_long, col] = np.nan
    return filled


def _hourly_index(long_df: pd.DataFrame) -> pd.DatetimeIndex:
    """Every hour from the first to the last timestamp, so missing hours show up as NaN rows."""
    times = pd.to_datetime(long_df["time"], utc=True)
    return pd.date_range(times.min(), times.max(), freq="h", tz="UTC")


def build_frames(long_df: pd.DataFrame, city: City, elevation: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return (features, targets), both indexed by hourly UTC time.

    Gaps of up to MAX_GAP_HOURS are linearly interpolated; longer gaps stay
    NaN and any window touching them is dropped later. Nothing is extrapolated.
    """
    index = _hourly_index(long_df)
    parts: list[pd.DataFrame] = []
    centre_raw: pd.DataFrame | None = None

    for name, _, _ in POINTS:
        raw = long_df[long_df["point"] == name].set_index("time").sort_index()[list(API_VARIABLES)].astype(float)
        raw = raw[~raw.index.duplicated(keep="last")].reindex(index)
        raw = _fill_short_gaps(raw, MAX_GAP_HOURS)
        if name == "c":
            centre_raw = raw
        feats = _point_features(raw)
        feats.columns = [f"{name}_{col}" for col in feats.columns]
        parts.append(feats)

    hours = index.hour + index.minute / 60
    day = index.day_of_year
    time_feats = pd.DataFrame(
        {
            "hour_sin": np.sin(2 * np.pi * hours / 24),
            "hour_cos": np.cos(2 * np.pi * hours / 24),
            "doy_sin": np.sin(2 * np.pi * day / 365.25),
            "doy_cos": np.cos(2 * np.pi * day / 365.25),
        },
        index=index,
    )
    static = pd.DataFrame(
        {"lat": city.latitude, "lon": city.longitude, "elevation": float(elevation)},
        index=index,
    )

    features = pd.concat(parts + [time_feats, static], axis=1)[list(FEATURE_ORDER)]

    assert centre_raw is not None
    targets = pd.DataFrame(
        {
            "temperature": centre_raw["temperature_2m"].astype(float),
            "humidity": centre_raw["relative_humidity_2m"].astype(float),
            "precipitation": centre_raw["precipitation"].astype(float).clip(lower=0),
        },
        index=index,
    )[list(TARGETS)]
    return features, targets
