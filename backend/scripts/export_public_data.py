"""Writes the files the public copy reads in place of a server: every covered city's latest forecast
from Wetcast's own models, the models' test scores and evaluations, and the list of cities.

Run from backend/ after the site is built, with the folder to write into:
    python -m scripts.export_public_data ../dist/data

It asks the API's own endpoints in-process, with no server and no database, so each file holds exactly
what the full setup would send. The public copy keeps no forecast history, so the live track record,
official warnings, saved places and Javed stay on the full setup.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from app.db import get_session
from app.main import app

log = logging.getLogger("weatherai.export")
PAUSE_SECONDS = 0.5  # between cities, to stay gentle with Open-Meteo's free API


class NoDatabase:
    """Stands in for the database session. Storing a forecast fails here, and the endpoint already
    carries on without it (it only logs), which is what the public copy needs."""

    def scalar(self, *args):
        """Refuse every query."""
        raise RuntimeError("the public export has no database")

    execute = scalar

    def rollback(self) -> None:
        """Nothing to undo."""


def no_database():
    """FastAPI dependency in place of get_session."""
    yield NoDatabase()


def write(path: Path, body: object) -> None:
    """Save one JSON file, compact, creating its folder."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")


def get(client: TestClient, url: str, params: dict | None = None) -> dict | list:
    """One API call that must succeed."""
    res = client.get(url, params=params)
    if res.status_code != 200:
        raise RuntimeError(f"{url} returned {res.status_code}: {res.text[:200]}")
    return res.json()


def export(out: Path) -> int:
    """Write every file; return how many cities have no forecast this time."""
    app.dependency_overrides[get_session] = no_database
    try:
        return _export(TestClient(app), out)  # not started as a context manager: no database setup or background jobs
    finally:
        app.dependency_overrides.pop(get_session, None)


def _export(client: TestClient, out: Path) -> int:
    """The files themselves, asked of `client`."""
    models = get(client, "/api/models")
    write(out / "models.json", models)
    cities = get(client, "/api/coverage")
    write(out / "coverage.json", cities)

    for name in [m["model"] for m in models["models"]]:
        write(out / "evaluation" / f"{name}.json", get(client, f"/api/models/{name}/evaluation", {"include_samples": "false"}))
        full = get(client, f"/api/models/{name}/evaluation")
        for city, samples in full.get("samples", {}).items():
            write(out / "evaluation" / name / f"{city}.json", dict(full, samples={city: samples}))

    done, failed = [], []
    for city in cities:
        params = {"latitude": city["latitude"], "longitude": city["longitude"]}
        res = client.get("/api/predictions", params=params)
        if res.status_code == 502:  # Open-Meteo hiccup: try once more
            time.sleep(5)
            res = client.get("/api/predictions", params=params)
        if res.status_code == 200:
            write(out / "predictions" / f"{city['id']}.json", res.json())
            done.append(city["id"])
        else:
            log.warning("no forecast for %s: %s %s", city["id"], res.status_code, res.text[:200])
            failed.append(city["id"])
        time.sleep(PAUSE_SECONDS)

    write(out / "index.json", {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "cities": done})
    log.info("wrote forecasts for %d cities (%d failed) to %s", len(done), len(failed), out)
    return len(failed)


def main() -> None:
    """Command line: the output folder is the only argument."""
    if len(sys.argv) != 2:
        sys.exit("usage: python -m scripts.export_public_data <output folder>")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    # Every forecast tries to store itself and is refused; that's expected here, so keep it out of the log.
    logging.getLogger("weatherai.api").setLevel(logging.ERROR)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    failed = export(Path(sys.argv[1]).resolve())
    total = len(json.loads((Path(sys.argv[1]) / "coverage.json").read_text(encoding="utf-8")))
    # Publish if most cities worked (one missing city shouldn't take the whole site down), else fail the job.
    if failed > total // 2:
        sys.exit(f"{failed} of {total} cities have no forecast; not publishing.")


if __name__ == "__main__":
    main()
