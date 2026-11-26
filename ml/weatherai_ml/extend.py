"""Extend a region's saved history to DATA_END without downloading it all again:
python -m weatherai_ml.extend --region india

For every city already saved, asks Open-Meteo only for the days after the saved end (the hourly
weather at all five points, and the day-old rain forecast that outlook.py keeps) and appends them.
A full download takes days on the free tier; a few weeks of extra days take minutes.
"""

from __future__ import annotations

import argparse
import json
from datetime import date, timedelta

import httpx
import pandas as pd

from . import outlook
from .config import DATA_END, raw_dir, region_cities
from .openmeteo import fetch_history


def next_day(day: str) -> str:
    """The date after `day` (YYYY-MM-DD)."""
    return (date.fromisoformat(day) + timedelta(days=1)).isoformat()


def extend_weather(client: httpx.Client, region: str) -> None:
    """Append the missing days to each city's weather file and update its manifest entry."""
    folder = raw_dir(region)
    manifest_path = folder / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    for city in region_cities(region):
        meta = manifest.get(city.id)
        path = folder / f"{city.id}.parquet"
        if meta is None or not path.exists() or meta["end"] >= DATA_END:
            continue
        start = next_day(meta["end"])
        new, _ = fetch_history(client, city, start, DATA_END)
        old = pd.read_parquet(path)
        both = pd.concat([old, new[old.columns]], ignore_index=True).drop_duplicates(["point", "time"], keep="first")
        # Same order as a fresh download: point by point (in the saved order), then by time.
        order = {p: i for i, p in enumerate(old["point"].unique())}
        both = both.assign(_order=both["point"].map(order)).sort_values(["_order", "time"]).drop(columns="_order")
        partial = path.with_suffix(".parquet.partial")
        both.to_parquet(partial, index=False)
        partial.replace(path)
        manifest[city.id] = meta | {"rows": len(both), "end": DATA_END, "extended_from": meta["end"]}
        manifest_path.write_text(json.dumps(manifest, indent=2))
        print(f"{city.id}: {len(both) - len(old):,} rows added ({start} to {DATA_END})", flush=True)


def extend_outlook(client: httpx.Client, region: str) -> None:
    """Append the missing days to each city's day-old rain forecast file."""
    folder = outlook.folder(region)
    manifest_path = folder / "manifest.json"
    if not manifest_path.exists():
        return
    manifest = json.loads(manifest_path.read_text())
    for city in region_cities(region):
        meta = manifest.get(city.id)
        path = folder / f"{city.id}.parquet"
        if meta is None or not path.exists() or meta["end"] >= DATA_END:
            continue
        start = next_day(meta["end"])
        new = outlook.fetch_history(client, city, start, DATA_END)
        old = pd.read_parquet(path)
        both = pd.concat([old, new.to_frame()])
        both = both[~both.index.duplicated(keep="first")].sort_index()
        both.to_parquet(path)
        manifest[city.id] = meta | {"end": DATA_END, "extended_from": meta["end"]}
        manifest_path.write_text(json.dumps(manifest, indent=2))
        print(f"{city.id} outlook: {len(both) - len(old):,} hours added", flush=True)


def main() -> None:
    """Command line."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default="india")
    args = parser.parse_args()
    with httpx.Client(timeout=300) as client:
        extend_weather(client, args.region)
        extend_outlook(client, args.region)
    print("done", flush=True)


if __name__ == "__main__":
    main()
