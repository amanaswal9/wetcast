"""Download training data: python -m weatherai_ml.fetch

Saves one parquet file per city to ml/data/raw/. Re-running skips cities that
are already downloaded. Waits between cities to stay inside Open-Meteo's free
per-minute limit.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import httpx

from .config import CITIES, DATA_END, DATA_START, RAW_DIR
from .openmeteo import fetch_history


def main() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = RAW_DIR / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

    with httpx.Client(timeout=180) as client:
        for i, city in enumerate(CITIES):
            target = RAW_DIR / f"{city.id}.parquet"
            if target.exists():
                print(f"{city.name}: already downloaded")
                continue
            print(f"{city.name}: downloading {DATA_START} to {DATA_END}")
            frame, elevation = fetch_history(client, city, DATA_START, DATA_END)
            frame.to_parquet(target, index=False)
            manifest[city.id] = {
                "rows": len(frame),
                "elevation_m": elevation,
                "start": DATA_START,
                "end": DATA_END,
                "source": "Open-Meteo Historical Forecast API (best_match)",
                "downloaded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            manifest_path.write_text(json.dumps(manifest, indent=2))
            print(f"  saved {len(frame):,} rows, centre elevation {elevation} m")
            if i < len(CITIES) - 1:
                time.sleep(62)


if __name__ == "__main__":
    main()
