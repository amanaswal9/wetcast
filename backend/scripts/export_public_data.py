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
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from app.db import get_session
from app.main import app

log = logging.getLogger("weatherai.export")
PAUSE_SECONDS = 2.0  # between cities, to stay gentle with Open-Meteo's free API (shared by everyone on the same machine)
GIVE_UP_AFTER = 5  # cities refused in a row before the rest keep their last forecast
CARRY_HOURS = 12  # a kept forecast older than this is mostly in the past, so it is dropped
TIME_BUDGET_SECONDS = 15 * 60  # after this, the remaining cities keep their last forecast (Open-Meteo waits can add up)


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


def export(out: Path, previous: str | None = None) -> int:
    """Write every file; return how many cities have no forecast at all this time.
    `previous` is the published site's address: a city whose new forecast fails keeps its last one."""
    app.dependency_overrides[get_session] = no_database
    try:
        return _export(TestClient(app), out, previous)  # not started as a context manager: no database setup or background jobs
    finally:
        app.dependency_overrides.pop(get_session, None)


def last_published(previous: str | None, city_id: str) -> dict | None:
    """The city's forecast as published last time, if it is still less than a day old."""
    if not previous:
        return None
    try:
        res = httpx.get(f"{previous.rstrip('/')}/data/predictions/{city_id}.json", timeout=15)
        body = res.json() if res.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None
    if not body:
        return None
    issued = datetime.fromisoformat(body["issued_at"].replace("Z", "+00:00"))
    return body if datetime.now(timezone.utc) - issued < timedelta(hours=CARRY_HOURS) else None


def _export(client: TestClient, out: Path, previous: str | None) -> int:
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

    fresh, carried, missing = [], [], []
    failures_in_a_row = 0
    deadline = time.monotonic() + TIME_BUDGET_SECONDS
    for city in cities:
        cid = city["id"]
        res = None
        # Once Open-Meteo has refused several cities in a row it is limiting this machine; asking about
        # the rest would only wait out more limits, so they keep their last forecast instead.
        if failures_in_a_row < GIVE_UP_AFTER and time.monotonic() < deadline:
            started = time.monotonic()
            res = client.get("/api/predictions", params={"latitude": city["latitude"], "longitude": city["longitude"]})
            seconds = time.monotonic() - started
            if res.status_code == 200:
                write(out / "predictions" / f"{cid}.json", res.json())
                fresh.append(cid)
                failures_in_a_row = 0
                log.info("%s: new forecast (%.1f s)", cid, seconds)
                time.sleep(PAUSE_SECONDS)
                continue
            failures_in_a_row += 1
            log.warning("%s: no new forecast (%s after %.1f s): %s", cid, res.status_code, seconds, res.text[:200])
        old = last_published(previous, cid)
        if old is not None:
            write(out / "predictions" / f"{cid}.json", old)
            carried.append(cid)
            log.info("%s: kept the forecast issued %s", cid, old["issued_at"])
        else:
            missing.append(cid)
        if res is not None:
            time.sleep(PAUSE_SECONDS)

    write(out / "index.json", {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "cities": fresh + carried,
        "fresh": fresh,
        "carried_over": carried,
    })
    log.info("%d new forecasts, %d kept from last time, %d cities without one", len(fresh), len(carried), len(missing))
    return len(missing)


def main() -> None:
    """Command line: the output folder, then optionally the published site's address."""
    if len(sys.argv) not in (2, 3):
        sys.exit("usage: python -m scripts.export_public_data <output folder> [published site address]")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    # Every forecast tries to store itself and is refused; that's expected here, so keep it out of the log.
    logging.getLogger("weatherai.api").setLevel(logging.ERROR)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    out = Path(sys.argv[1]).resolve()
    missing = export(out, sys.argv[2] if len(sys.argv) == 3 else None)
    total = len(json.loads((out / "coverage.json").read_text(encoding="utf-8")))
    # Publish if most cities have a forecast (one missing city shouldn't take the whole site down), else fail the job.
    if missing > total // 2:
        sys.exit(f"{missing} of {total} cities have no forecast; not publishing.")


if __name__ == "__main__":
    main()
