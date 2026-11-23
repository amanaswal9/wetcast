"""Assemble all cities into arrays and find leak-free window positions per split."""

from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .config import HORIZON_HOURS, LOOKBACK_HOURS, SPLITS, City, raw_dir, region_cities
from .features import build_frames


@dataclass
class Dataset:
    """Every city's hourly rows stacked one after another, with enough bookkeeping to find each city."""

    features: np.ndarray  # (rows, n_features) physical units, NaN where missing
    targets: np.ndarray  # (rows, n_targets) physical units
    times: pd.DatetimeIndex  # time of each row
    city_of_row: np.ndarray  # index into `cities`
    city_offsets: list[int]  # first row of each city
    nan_rows: np.ndarray  # True where any feature or target is missing
    cities: tuple[City, ...] = ()

    def city_indices(self, role: str) -> set[int]:
        """Indexes of the cities with this role ("train" or "holdout")."""
        return {i for i, c in enumerate(self.cities) if c.role == role}

    def rows_of(self, cities: set[int]) -> np.ndarray:
        """Boolean mask of the rows that belong to the given cities."""
        return np.isin(self.city_of_row, list(cities))


def load_dataset(region: str = "north_india", allow_missing: bool = False) -> Dataset:
    """All cities of a region, training and held-out alike. Which rows a split
    may use is decided later (window_ends), never here."""
    folder = raw_dir(region)
    manifest = json.loads((folder / "manifest.json").read_text())
    cities = region_cities(region)
    if allow_missing:  # smoke tests only: work with whatever has downloaded so far
        cities = tuple(c for c in cities if (folder / f"{c.id}.parquet").exists())
    missing = [c.name for c in cities if not (folder / f"{c.id}.parquet").exists()]
    if missing:
        raise FileNotFoundError(f"{len(missing)} cities not downloaded yet: {', '.join(missing)}")
    feats, targs, times, city_idx, offsets = [], [], [], [], []
    offset = 0
    for i, city in enumerate(cities):
        long_df = pd.read_parquet(folder / f"{city.id}.parquet")
        f, t = build_frames(long_df, city, manifest[city.id]["elevation_m"])
        feats.append(f.to_numpy(dtype=np.float32))
        targs.append(t.to_numpy(dtype=float))
        times.append(f.index)
        city_idx.append(np.full(len(f), i))
        offsets.append(offset)
        offset += len(f)
    features = np.concatenate(feats)
    targets = np.concatenate(targs)
    nan_rows = np.isnan(features).any(axis=1) | np.isnan(targets).any(axis=1)
    return Dataset(
        features=features,
        targets=targets,
        times=pd.DatetimeIndex(np.concatenate([t.tz_convert("UTC").tz_localize(None).to_numpy() for t in times])).tz_localize("UTC"),
        city_of_row=np.concatenate(city_idx),
        city_offsets=offsets,
        nan_rows=nan_rows,
        cities=cities,
    )


def split_rows(ds: Dataset, split: str) -> np.ndarray:
    """Boolean mask of rows whose timestamp is inside the split period."""
    start, end = (pd.Timestamp(s, tz="UTC") for s in SPLITS[split])
    return (ds.times >= start) & (ds.times <= end)


def residual_targets(ds: Dataset, columns: tuple[int, ...]) -> np.ndarray:
    """Row-level targets with `columns` replaced by the change since the same hour
    the day before (y[r] - y[r-24]). NaN where r-24 is in another city or missing."""
    out = ds.targets.copy()
    prev = np.full_like(ds.targets, np.nan)
    prev[24:] = ds.targets[:-24]
    same_city = np.zeros(len(ds.targets), dtype=bool)
    same_city[24:] = ds.city_of_row[24:] == ds.city_of_row[:-24]
    prev[~same_city] = np.nan
    for k in columns:
        out[:, k] = ds.targets[:, k] - prev[:, k]
    return out


def window_ends(
    ds: Dataset,
    split: str,
    stride: int = 1,
    lookback: int = LOOKBACK_HOURS,
    extra_bad: np.ndarray | None = None,
    cities: set[int] | None = None,
) -> np.ndarray:
    """Global row indices t such that rows t-lookback+1 .. t+HORIZON are all
    inside `split`, inside the same city, and free of missing values.
    `cities` restricts windows to those city indices (e.g. training cities only)."""
    in_split = split_rows(ds, split)
    bad = (~in_split) | ds.nan_rows
    if extra_bad is not None:
        bad = bad | extra_bad
    bad_cum = np.concatenate([[0], np.cumsum(bad)])
    ends: list[np.ndarray] = []
    bounds = ds.city_offsets + [len(ds.times)]
    for c in range(len(ds.city_offsets)):
        if cities is not None and c not in cities:
            continue
        lo, hi = bounds[c], bounds[c + 1]
        t = np.arange(lo + lookback - 1, hi - HORIZON_HOURS)
        first = t - lookback + 1
        last = t + HORIZON_HOURS
        clean = (bad_cum[last + 1] - bad_cum[first]) == 0
        ends.append(t[clean][::stride])
    return np.concatenate(ends) if ends else np.array([], dtype=np.int64)
