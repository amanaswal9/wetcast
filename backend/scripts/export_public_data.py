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

from app import coverage, predictions
from app.db import get_session
from app.main import app
from app.registry import get_registry

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

    # Fetch every city's recent weather in a few batched requests first; the forecasts below then
    # reuse it instead of opening 48 separate connections to Open-Meteo.
    registry = get_registry()
    wanted = {c["id"] for c in cities}
    city_objects = [c for c in coverage.cities(registry.region_id) if c.id in wanted]
    lookback = max(registry.get(n).preprocessor.lookback for n in registry.names)
    started = time.monotonic()
    primed = predictions.prime_many(registry, city_objects, lookback)
    log.info("recent weather for %d of %d cities in batched requests (%.1f s)", len(primed), len(city_objects), time.monotonic() - started)

    run = Run(client, out, previous, time.monotonic() + TIME_BUDGET_SECONDS)
    for city in cities:
        run.forecast(city["id"], city["latitude"], city["longitude"], city["id"] in primed)
    missing = len(run.missing)

    # Then the extra cities, forecast as ordinary places in India. Their recent weather is batched the
    # same way, for the grid point each one snaps to. They come last, so if Open-Meteo starts refusing
    # or time runs out, the cities the models know are already done.
    extra = coverage.extra_cities(registry.region_id)
    located = {c.id: coverage.locate(registry.region_id, c.latitude, c.longitude, "IN") for c in extra}
    points = {loc.city.id: loc.city for loc in located.values() if loc is not None}
    primed = predictions.prime_many(registry, list(points.values()), lookback) if points and run.going() else set()
    for c in extra:
        loc = located[c.id]
        if loc is None:
            log.warning("%s: outside the models' reach, skipped", c.id)
            continue
        label = {"id": c.id, "name": c.name, "latitude": c.latitude, "longitude": c.longitude, "role": None}
        run.forecast(c.id, c.latitude, c.longitude, loc.city.id in primed, label)
    shown = set(run.fresh + run.carried)
    write(out / "more_cities.json", [
        {"id": c.id, "name": c.name, "latitude": c.latitude, "longitude": c.longitude, "role": None} for c in extra if c.id in shown
    ])

    write(out / "index.json", {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "cities": run.fresh + run.carried,
        "fresh": run.fresh,
        "carried_over": run.carried,
    })
    log.info("%d new forecasts, %d kept from last time, %d cities without one", len(run.fresh), len(run.carried), len(run.missing))
    return missing


class Run:
    """Asks for one city's forecast after another, keeping count of Open-Meteo's refusals and the time."""

    def __init__(self, client: TestClient, out: Path, previous: str | None, deadline: float):
        self.client, self.out, self.previous, self.deadline = client, out, previous, deadline
        self.failures_in_a_row = 0
        self.fresh: list[str] = []
        self.carried: list[str] = []
        self.missing: list[str] = []

    def going(self) -> bool:
        """Whether to keep asking. Once Open-Meteo has refused several cities in a row it is limiting
        this machine; asking about the rest would only wait out more limits, so they keep their last
        forecast instead. The same happens when the time budget runs out."""
        return self.failures_in_a_row < GIVE_UP_AFTER and time.monotonic() < self.deadline

    def forecast(self, cid: str, latitude: float, longitude: float, primed: bool, label: dict | None = None) -> None:
        """Write the city's new forecast, or its last one if no new one comes. `label` replaces the
        place the server names (a grid point, for an extra city) with the city itself."""
        res = None
        if self.going():
            started = time.monotonic()
            res = self.client.get("/api/predictions", params={"latitude": latitude, "longitude": longitude, "country": "IN"})
            seconds = time.monotonic() - started
            if res.status_code == 200:
                body = res.json()
                if label is not None:
                    body["city"] = label
                write(self.out / "predictions" / f"{cid}.json", body)
                self.fresh.append(cid)
                self.failures_in_a_row = 0
                log.info("%s: new forecast (%.1f s)", cid, seconds)
                if not primed:  # it went to Open-Meteo on its own
                    time.sleep(PAUSE_SECONDS)
                return
            self.failures_in_a_row += 1
            log.warning("%s: no new forecast (%s after %.1f s): %s", cid, res.status_code, seconds, res.text[:200])
        old = last_published(self.previous, cid)
        if old is not None:
            write(self.out / "predictions" / f"{cid}.json", old)
            self.carried.append(cid)
            log.info("%s: kept the forecast issued %s", cid, old["issued_at"])
        else:
            self.missing.append(cid)
        if res is not None:
            time.sleep(PAUSE_SECONDS)


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
