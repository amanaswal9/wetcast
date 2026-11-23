"""NASA's satellite rainfall (GPM IMERG Late Run, version 07) at Wetcast's cities, hour by hour.

    python -m weatherai_ml.imerg --region india            # download 2023-01 to 2026-10 (resumable)

Why: Wetcast learns rain from Open-Meteo's archived weather, which is itself model output. IMERG is
an independent estimate from satellites (0.1 degree, every half hour), so it is a second view of how
much rain fell. The Late Run is used because it covers every year Wetcast uses (the gauge-adjusted
Final Run stopped at 2025-09-30 when this was written); it is satellite-only, so it is an estimate,
not a gauge reading.

Access: free, but needs a NASA Earthdata account that has approved the "NASA GESDISC DATA ARCHIVE"
application and its licence, and an Earthdata token as EARTHDATA_TOKEN in backend/.secrets.local
(never printed or logged). Each half-hour file is cut to India on NASA's OPeNDAP server, and only the
cells at the cities are kept: hourly totals (mm) at the city's own 0.1 degree cell and the mean of the
3x3 cells around it.

Hours follow Open-Meteo's convention: the value at 01:00 is the rain from 00:00 to 01:00 (the two
half-hours starting 00:00 and 00:30). Output: <raw_dir>/imerg/<YYYY-MM>.parquet, one per month, with
columns time (UTC), city, cell_mm, box_mm, half_hours (how many of the two half-hours were found).
"""

from __future__ import annotations

import argparse
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import httpx
import numpy as np
import pandas as pd

from .config import DATA_END, DATA_START, REGION_NAMES, ML_ROOT, City, raw_dir, region_cities

CMR_URL = "https://cmr.earthdata.nasa.gov/search/granules.json"
SHORT_NAME = "GPM_3IMERGHHL"
VERSION = "07"
SECRETS = ML_ROOT.parent / "backend" / ".secrets.local"
# India box on IMERG's 0.1 degree grid: cell k is centred on -179.95 + 0.1 k (longitude), -89.95 + 0.1 k (latitude).
LON_CELLS = (2481, 2780)  # 68.15 to 98.05 E
LAT_CELLS = (961, 1274)  # 6.15 to 37.45 N
WORKERS = 4
FILL = -9999.0


def token() -> str:
    """The Earthdata token from backend/.secrets.local (never printed)."""
    try:
        text = SECRETS.read_text(encoding="utf-8-sig")
    except FileNotFoundError as exc:
        raise SystemExit(f"{SECRETS} is missing") from exc
    match = re.search(r"^\s*EARTHDATA_TOKEN\s*=\s*\"?([^\"\r\n]+)\"?\s*$", text, re.M)
    if not match:
        raise SystemExit(f"No EARTHDATA_TOKEN line in {SECRETS}")
    return match.group(1).strip()


def cell_of(latitude: float, longitude: float) -> tuple[int, int]:
    """(row, column) of the cell containing a point, inside the India box as downloaded (lon, lat order)."""
    lon = int(np.floor((longitude + 180) * 10)) - LON_CELLS[0]
    lat = int(np.floor((latitude + 90) * 10)) - LAT_CELLS[0]
    if not (0 <= lon <= LON_CELLS[1] - LON_CELLS[0] and 0 <= lat <= LAT_CELLS[1] - LAT_CELLS[0]):
        raise ValueError(f"({latitude}, {longitude}) is outside the India box")
    return lon, lat


def granules(start: str, end: str) -> list[tuple[pd.Timestamp, str]]:
    """(half-hour start, OPeNDAP URL) for every Late Run file between two UTC times, oldest first."""
    out: list[tuple[pd.Timestamp, str]] = []
    headers: dict[str, str] = {}
    with httpx.Client(timeout=120) as client:
        while True:
            r = client.get(CMR_URL, params={"short_name": SHORT_NAME, "version": VERSION, "temporal": f"{start},{end}",
                                            "page_size": 2000, "sort_key": "start_date"}, headers=headers)
            r.raise_for_status()
            entries = r.json()["feed"]["entry"]
            for e in entries:
                link = next((l["href"] for l in e["links"] if l["href"].startswith("https://opendap.earthdata.nasa.gov/")), None)
                if link:
                    out.append((pd.Timestamp(e["time_start"]).tz_convert("UTC"), link))
            after = r.headers.get("CMR-Search-After")
            if not entries or not after:
                return out
            headers = {"CMR-Search-After": after}


def subset(client: httpx.Client, url: str) -> np.ndarray:
    """Rain rate (mm/h) over the India box for one half-hour: (lon, lat) cells, NaN where missing."""
    import h5py

    ce = f"/Grid/precipitation[0][{LON_CELLS[0]}:{LON_CELLS[1]}][{LAT_CELLS[0]}:{LAT_CELLS[1]}]"
    for attempt in range(6):
        try:
            r = client.get(url + ".dap.nc4", params={"dap4.ce": ce})
        except httpx.TransportError:
            time.sleep(20 * (attempt + 1))
            continue
        if r.status_code == 200:
            import io

            with h5py.File(io.BytesIO(r.content)) as f:
                grid = f["Grid/precipitation"][0].astype(float)
            grid[grid <= FILL + 1] = np.nan
            return grid
        if r.status_code in (401, 403):
            raise SystemExit(f"NASA refused the download ({r.status_code}): check the token and the GES DISC approval.")
        time.sleep(20 * (attempt + 1))  # 429 or a passing server error
    raise RuntimeError(f"gave up on {url.rsplit('/', 1)[-1]}")


def city_values(grid: np.ndarray, cells: dict[str, tuple[int, int]]) -> dict[str, tuple[float, float]]:
    """(own cell, 3x3 mean) rain rate for each city."""
    out = {}
    for cid, (i, j) in cells.items():
        box = grid[max(i - 1, 0): i + 2, max(j - 1, 0): j + 2]
        out[cid] = (float(grid[i, j]), float(np.nanmean(box)) if np.isfinite(box).any() else np.nan)
    return out


def to_hours(rows: list[tuple[pd.Timestamp, str, float, float]]) -> pd.DataFrame:
    """Half-hourly rates -> hourly totals stamped at the end of the hour (Open-Meteo's convention)."""
    df = pd.DataFrame(rows, columns=["start", "city", "cell", "box"])
    df["time"] = df["start"].dt.floor("h") + pd.Timedelta(hours=1)
    hourly = df.groupby(["time", "city"]).agg(cell_mm=("cell", lambda v: 0.5 * v.sum(min_count=1)),
                                              box_mm=("box", lambda v: 0.5 * v.sum(min_count=1)),
                                              half_hours=("cell", lambda v: int(v.notna().sum())))
    # An hour with only one half-hour found counts that half twice: a whole-hour estimate.
    one = hourly["half_hours"] == 1
    hourly.loc[one, ["cell_mm", "box_mm"]] *= 2
    return hourly.reset_index()


def folder(region: str) -> Path:
    """Where a region's monthly IMERG files are kept."""
    return raw_dir(region) / "imerg"


def main() -> None:
    """Download every month not on disk yet, then write the manifest (safe to rerun after a break)."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", choices=REGION_NAMES, default="north_india")
    parser.add_argument("--start", default=DATA_START)
    parser.add_argument("--end", default=DATA_END)
    args = parser.parse_args()
    cities: tuple[City, ...] = region_cities(args.region)
    cells = {c.id: cell_of(c.latitude, c.longitude) for c in cities}
    target = folder(args.region)
    target.mkdir(parents=True, exist_ok=True)
    auth = {"Authorization": f"Bearer {token()}"}
    months = pd.period_range(args.start[:7], args.end[:7], freq="M")
    lock = threading.Lock()
    for month in months:
        path = target / f"{month}.parquet"
        if path.exists():
            continue
        # The hour ending at 00:00 on the 1st needs the last half-hours of the month before.
        first = (month.start_time - pd.Timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        last = (month.end_time.floor("h") - pd.Timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        files = granules(first, last)
        rows: list[tuple[pd.Timestamp, str, float, float]] = []
        started = time.perf_counter()
        with httpx.Client(follow_redirects=True, timeout=180, headers=auth) as client, ThreadPoolExecutor(WORKERS) as pool:
            jobs = {pool.submit(subset, client, url): t for t, url in files}
            for job in as_completed(jobs):
                values = city_values(job.result(), cells)
                with lock:
                    rows += [(jobs[job], cid, a, b) for cid, (a, b) in values.items()]
        hourly = to_hours(rows)
        lo, hi = month.start_time.tz_localize("UTC"), (month.end_time.floor("h")).tz_localize("UTC")
        hourly = hourly[(hourly["time"] >= lo) & (hourly["time"] <= hi)]
        hourly.to_parquet(path)
        print(f"[{datetime.now(timezone.utc):%Y-%m-%d %H:%M}] {month}: {len(files)} half-hours, {len(hourly)} city-hours, "
              f"{(hourly['half_hours'] < 2).mean():.1%} incomplete, {time.perf_counter() - started:.0f} s", flush=True)
    manifest = {"product": f"{SHORT_NAME} v{VERSION} (IMERG Late Run)", "box_cells": {"lon": LON_CELLS, "lat": LAT_CELLS},
                "cities": {cid: list(map(int, ij)) for cid, ij in cells.items()},
                "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    (target / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print("IMERG DOWNLOAD DONE", flush=True)


if __name__ == "__main__":
    main()
