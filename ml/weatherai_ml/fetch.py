"""Download training data: python -m weatherai_ml.fetch [--region north_india|india]

Saves one parquet file per city. Re-running skips cities already downloaded,
so the download can be stopped and resumed at any time. It waits between
cities and waits out Open-Meteo's free per-minute, hourly and daily limits,
so a large region can run unattended over several days.
"""

from __future__ import annotations

import argparse
import json
import shutil
import time
from datetime import datetime, timezone

import httpx

from .config import DATA_END, DATA_START, RAW_DIR, region_cities, raw_dir
from .openmeteo import fetch_history


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def reuse_north_india(target_dir, manifest: dict) -> None:
    """The ten North India cities were already downloaded for the same dates and
    points; copy them instead of spending the API quota again."""
    source_manifest = RAW_DIR / "manifest.json"
    if target_dir == RAW_DIR or not source_manifest.exists():
        return
    source = json.loads(source_manifest.read_text())
    for city_id, meta in source.items():
        src, dst = RAW_DIR / f"{city_id}.parquet", target_dir / f"{city_id}.parquet"
        if src.exists() and not dst.exists() and meta["start"] == DATA_START and meta["end"] == DATA_END:
            shutil.copy2(src, dst)
            manifest[city_id] = {**meta, "reused_from": "north_india"}
            print(f"{city_id}: reused existing North India download")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default="north_india")
    args = parser.parse_args()

    cities = region_cities(args.region)
    target_dir = raw_dir(args.region)
    target_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = target_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    reuse_north_india(target_dir, manifest)
    manifest_path.write_text(json.dumps(manifest, indent=2))

    todo = [c for c in cities if not (target_dir / f"{c.id}.parquet").exists()]
    print(f"[{now()}] region {args.region}: {len(cities) - len(todo)} of {len(cities)} cities ready, {len(todo)} to download", flush=True)

    with httpx.Client(timeout=300) as client:
        for i, city in enumerate(todo, start=1):
            print(f"[{now()}] ({i}/{len(todo)}) {city.name}: downloading {DATA_START} to {DATA_END}", flush=True)
            frame, elevation = fetch_history(client, city, DATA_START, DATA_END)
            frame.to_parquet(target_dir / f"{city.id}.parquet", index=False)
            manifest[city.id] = {
                "rows": len(frame),
                "elevation_m": elevation,
                "start": DATA_START,
                "end": DATA_END,
                "source": "Open-Meteo Historical Forecast API (best_match)",
                "downloaded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            manifest_path.write_text(json.dumps(manifest, indent=2))
            print(f"[{now()}]   saved {len(frame):,} rows, centre elevation {elevation} m", flush=True)
            if i < len(todo):
                time.sleep(62)  # one city is close to the free per-minute quota

    print(f"[{now()}] done: all {len(cities)} cities downloaded", flush=True)


if __name__ == "__main__":
    main()
