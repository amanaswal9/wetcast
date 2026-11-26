"""Wetcast API: forecasts from Wetcast's own models, their track record, official alerts,
the Javed assistant and saved places.

Run from backend/ with: uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import delete, select, text, update
from sqlalchemy.orm import Session

from weatherai_ml.config import TARGETS
from weatherai_ml.predict import InsufficientHistoryError, haversine_km
from weatherai_ml.preprocess import FeatureOrderError
from weatherai_ml.rain_warning import warn as rain_warning_for

from .config import get_settings
from .db import SavedPlace, engine, get_session
from .migrations import migrate
from . import alerts as official_alerts
from . import assistant as weather_assistant
from .accuracy import track_record_summary
from . import coverage as model_coverage
from .predictions import UpstreamError, predict_models, recent_features, store_run, tracked_cities
from .registry import ModelRegistry, get_registry
from .track_record import scheduler
from .schemas import (
    AssistantIn,
    AssistantOut,
    AssistantStatus,
    CityOut,
    CoverageOut,
    HealthOut,
    ModelPredictionOut,
    PlaceIn,
    PlaceOut,
    PlacesReplace,
    PredictionPointOut,
    PredictionsOut,
    RainWarningOut,
    UnsupportedLocation,
)

settings = get_settings()
logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("weatherai.api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Migrate the database, load the models, and start the background jobs; stop them on shutdown."""
    migrate(engine())
    registry = get_registry()
    log.info("startup complete; models available: %s", ", ".join(registry.names) or "none")
    tasks = [asyncio.create_task(asyncio.to_thread(registry.warm_up))]  # in the background, so requests aren't held up
    if settings.track_record_interval_hours > 0:
        tasks.append(asyncio.create_task(scheduler(settings.track_record_interval_hours)))
        log.info("track record: forecasts issued and scored every %d h", settings.track_record_interval_hours)
    if settings.alerts_poll_minutes > 0:
        tasks.append(asyncio.create_task(official_alerts.scheduler(settings.alerts_poll_minutes)))
        log.info("alerts: NDMA Sachet feed read every %d min", settings.alerts_poll_minutes)
    yield
    for task in tasks:
        task.cancel()


app = FastAPI(title="Wetcast API", version="0.1.0", lifespan=lifespan)
# Compress larger JSON (model metrics are ~75 KB as plain text, ~10 KB compressed).
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "X-Client-Id"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log each request with its status and how long it took."""
    started = time.perf_counter()
    response = await call_next(request)
    log.info("%s %s -> %s in %.0f ms", request.method, request.url.path, response.status_code, (time.perf_counter() - started) * 1000)
    return response


@app.exception_handler(Exception)
async def unhandled(_: Request, exc: Exception):
    """Log the full error, but give the visitor a short message with no internals."""
    log.exception("unhandled error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": "Something went wrong on the server. Try again."})


SessionDep = Annotated[Session, Depends(get_session)]
RegistryDep = Annotated[ModelRegistry, Depends(get_registry)]

CLIENT_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")


def client_id(x_client_id: Annotated[str, Header()]) -> str:
    """The anonymous browser id from the X-Client-Id header. There are no accounts; this id
    keeps one visitor's saved places and question count apart from another's."""
    if not CLIENT_ID.match(x_client_id):
        raise HTTPException(status_code=400, detail="X-Client-Id must be 8 to 64 letters, digits or dashes.")
    return x_client_id


ClientDep = Annotated[str, Depends(client_id)]


def city_out(city) -> CityOut:
    """A city for the API. Grid points (ids starting "pt") get no training role."""
    role = city.role if city.role in ("train", "holdout") and not city.id.startswith("pt") else None
    return CityOut(id=city.id, name=city.name, latitude=city.latitude, longitude=city.longitude, role=role)


# Health and model information.


@app.get("/api/health", response_model=HealthOut)
def health(session: SessionDep, registry: RegistryDep) -> HealthOut:
    """Whether the database answers and which models are loaded."""
    try:
        session.execute(text("SELECT 1"))
        database = "ok"
    except Exception as exc:  # noqa: BLE001 - report, don't crash the health check
        log.warning("database check failed: %s", exc)
        database = "unavailable"
    return HealthOut(status="ok" if database == "ok" else "degraded", database=database, models=registry.names)


@app.get("/api/coverage", response_model=list[CityOut])
def coverage(registry: RegistryDep) -> list[CityOut]:
    """The cities behind Wetcast's models: those they trained on and those held out to test them.
    Predictions are offered at these and, for the all-India models, anywhere in India near them."""
    return [city_out(c) for c in model_coverage.cities(registry.region_id)]


@app.get("/api/models")
def list_models(registry: RegistryDep) -> dict:
    """Test-period metrics for every served model."""
    return {"models": [registry.metrics(name) for name in registry.names]}


@app.get("/api/models/{name}")
def model_detail(name: str, registry: RegistryDep) -> dict:
    """Test-period metrics for one model."""
    if registry.get(name) is None:
        raise HTTPException(status_code=404, detail=f"No trained model called {name!r}.")
    return registry.metrics(name)


@app.get("/api/models/{name}/evaluation")
def model_evaluation(
    name: str,
    registry: RegistryDep,
    include_samples: Annotated[bool, Query(description="Include actual-vs-predicted series")] = True,
    city: Annotated[str | None, Query(max_length=32)] = None,
) -> dict:
    """The full evaluation of one model, optionally with the actual-vs-predicted series for one city."""
    if registry.get(name) is None:
        raise HTTPException(status_code=404, detail=f"No trained model called {name!r}.")
    evaluation = dict(registry.evaluation(name))
    if not include_samples:
        evaluation.pop("samples", None)
    elif city is not None:
        if city not in evaluation["samples"]:
            raise HTTPException(status_code=404, detail=f"No evaluation samples for city {city!r}.")
        evaluation["samples"] = {city: evaluation["samples"][city]}
    return evaluation


# Forecasts from Wetcast's own models.


@app.get(
    "/api/predictions",
    response_model=PredictionsOut,
    responses={404: {"model": UnsupportedLocation}, 502: {"description": "Upstream data unavailable"}},
)
def predictions(
    session: SessionDep,
    registry: RegistryDep,
    latitude: Annotated[float, Query(ge=-90, le=90)],
    longitude: Annotated[float, Query(ge=-180, le=180)],
    models: Annotated[list[str] | None, Query()] = None,
    country: Annotated[str | None, Query(min_length=2, max_length=2, pattern="^[A-Za-z]{2}$")] = None,
):
    """The next 24 hours from each requested model, with error ranges and how accurate to expect
    them at this place. Places the models don't cover get a 404 listing the cities they do."""
    region = registry.region_id
    located = model_coverage.locate(region, latitude, longitude, country)
    if located is None:
        nearby = sorted(
            model_coverage.training_cities(region), key=lambda c: haversine_km(latitude, longitude, c.latitude, c.longitude)
        )
        body = UnsupportedLocation(detail=model_coverage.unsupported_detail(region), supported=[city_out(c) for c in nearby])
        return JSONResponse(status_code=404, content=body.model_dump())
    city = located.city

    names = models or registry.names
    unknown = [n for n in names if registry.get(n) is None]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown or untrained model: {', '.join(unknown)}.")
    if not names:
        raise HTTPException(status_code=503, detail="No trained models are available yet.")

    lookback = max(registry.get(n).preprocessor.lookback for n in names)
    try:
        features = recent_features(registry, city, lookback)
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    try:
        forecasts = predict_models(registry, city, names, features)
    except InsufficientHistoryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except FeatureOrderError as exc:
        log.error("feature order mismatch: %s", exc)
        raise HTTPException(status_code=500, detail="The model and the data pipeline are out of sync.") from exc

    results, issued = [], None
    for name in names:
        pred = forecasts[name]
        issued = pred.issued_at
        try:
            # Only named cities build a track record; other points are forecast but not kept.
            if located.kind != "untrained":
                store_run(session, name, city, pred, region)
        except Exception as exc:  # noqa: BLE001 - storing history must not block a forecast
            session.rollback()
            log.warning("couldn't store prediction run: %s", exc)
        points = []
        for i, t in enumerate(pred.times):
            row = {"time": t.to_pydatetime(), "lead_hours": i + 1}
            for k, target in enumerate(TARGETS):
                row[target] = round(float(pred.values[i, k]), 2)
                row[f"{target}_lower"] = round(float(pred.lower[i, k]), 2)
                row[f"{target}_upper"] = round(float(pred.upper[i, k]), 2)
            if pred.rain_chance is not None:
                row["rain_chance"] = round(float(pred.rain_chance[i]), 3)
            points.append(PredictionPointOut.model_validate(row))
        results.append(ModelPredictionOut(model=name, display_name=registry.display_name(name), points=points))

    warning = None
    ensemble = registry.get("ensemble") if "ensemble" in names else None
    if ensemble is not None and getattr(ensemble, "rain_warning", None):
        pred = forecasts["ensemble"]
        found = rain_warning_for(ensemble.rain_warning, pred.rain_chance, pred.values[:, TARGETS.index("precipitation")])
        if found:
            peak = found.pop("peak_hour")
            warning = RainWarningOut(**found, peak_time=pred.times[peak].to_pydatetime(), until=pred.times[-1].to_pydatetime())

    level = registry.metrics(names[0])["interval"]["level"]
    basis_model = "ensemble" if "ensemble" in names else names[0]
    label, detail = model_coverage.describe(region, located)
    where = CoverageOut(
        kind=located.kind,
        label=label,
        detail=detail,
        nearest_city=city_out(located.nearest),
        nearest_km=round(located.nearest_km, 1),
        model=basis_model,
        expected_error=model_coverage.expected_error(registry, basis_model, located),
    )
    return PredictionsOut(
        city=city_out(city),
        issued_at=issued.to_pydatetime(),
        interval_level=level,
        source="Inputs: last 48 hours of Open-Meteo data for the place and four points ~55 km around it.",
        note=(
            f"Model predictions, not certainties. Ranges are sized to hold {round(level * 100)}% of past errors; "
            "on the 2026 test period they held between "
            f"{round(min(min(registry.metrics(n)['interval']['test_coverage'].values()) for n in names) * 100)}% and "
            f"{round(max(max(registry.metrics(n)['interval']['test_coverage'].values()) for n in names) * 100)}%."
        ),
        coverage=where,
        models=results,
        rain_warning=warning,
    )


# Live track record.


@app.get("/api/track-record")
def track_record(
    session: SessionDep,
    registry: RegistryDep,
    days: Annotated[int, Query(ge=1, le=365)] = 30,
    city: Annotated[str | None, Query(max_length=32)] = None,
) -> dict:
    """How stored forecasts did once the weather they predicted had happened."""
    if city is not None and city not in {c.id for c in tracked_cities(registry.region_id)}:
        raise HTTPException(status_code=404, detail=f"No trained city called {city!r}.")
    return track_record_summary(session, registry, days=days, city=city)


# Official alerts. These notes are shown under the alerts list.

SACHET_NOTE = (
    "Official alerts for India from NDMA's Sachet portal, which carries warnings from the India Meteorological "
    "Department and state disaster management authorities. Only alerts whose mapped area includes this point are "
    "shown. The feed is not a complete archive, so no alert here does not rule out a local warning: check IMD "
    "(mausam.imd.gov.in) or your state authority when the weather looks dangerous."
)
NWS_NOTE = "Official alerts from the US National Weather Service for this point."
NONE_NOTE = (
    "Wetcast doesn't have an official warning feed for this country yet. It reads India's NDMA Sachet portal "
    "(IMD and state authorities) and the US National Weather Service. Check your national weather service for warnings."
)


@app.get("/api/alerts")
def alerts(
    session: SessionDep,
    latitude: Annotated[float, Query(ge=-90, le=90)],
    longitude: Annotated[float, Query(ge=-180, le=180)],
    country: Annotated[str | None, Query(min_length=2, max_length=2, pattern="^[A-Za-z]{2}$")] = None,
) -> dict:
    """Official severe-weather alerts in effect at a point, from the source that covers it."""
    coverage = official_alerts.coverage_for(latitude, longitude, country)
    checked = datetime.now(timezone.utc)
    body: dict = {"coverage": coverage, "checked_at": checked.isoformat(), "alerts": [], "stale": False}
    if coverage == "india":
        rows = official_alerts.active_sachet_alerts(session, latitude, longitude, checked)
        poll = official_alerts.POLL
        interval = max(settings.alerts_poll_minutes, 1)
        body.update(
            source={"name": "NDMA Sachet (IMD and state authorities)", "url": official_alerts.SACHET_HOME},
            note=SACHET_NOTE,
            alerts=official_alerts.sort_alerts([official_alerts.alert_out(a) for a in rows]),
            feed_checked_at=poll.last_ok.isoformat() if poll.last_ok else None,
            stale=poll.last_ok is None or checked - poll.last_ok > timedelta(minutes=3 * interval),
        )
    elif coverage == "us":
        body.update(source={"name": "US National Weather Service", "url": official_alerts.NWS_HOME}, note=NWS_NOTE)
        try:
            body["alerts"] = official_alerts.sort_alerts(official_alerts.fetch_nws(latitude, longitude))
            body["feed_checked_at"] = checked.isoformat()
        except official_alerts.AlertSourceError as exc:
            body.update(stale=True, feed_checked_at=None, error=str(exc))
    else:
        body.update(source=None, note=NONE_NOTE)
    return body


# The Javed assistant, on a free local model.


@app.get("/api/assistant/status", response_model=AssistantStatus)
def assistant_status() -> AssistantStatus:
    """Whether the Ask page can be used, who answers, and the daily question limit."""
    which = weather_assistant.provider()
    return AssistantStatus(
        configured=which is not None,
        provider=which,
        model=weather_assistant.model_name(),
        daily_limit_per_visitor=settings.assistant_daily_limit_per_client,
    )


@app.post("/api/assistant", response_model=AssistantOut, responses={429: {}, 502: {}, 503: {}, 504: {}})
def ask_assistant(body: AssistantIn, session: SessionDep, registry: RegistryDep, client: ClientDep):
    """Answer a weather question with the local model, using only data looked up through read-only tools.
    A question that fails before it is answered does not count towards the visitor's daily limit."""
    if body.messages[-1].role != "user":
        raise HTTPException(status_code=422, detail="The last message must be the question.")
    if not weather_assistant.is_configured():
        return JSONResponse(
            status_code=503,
            content={
                "code": "assistant_not_configured",
                "detail": "The assistant isn't set up on this server (Ollama isn't running with the model installed).",
            },
        )
    try:
        day = weather_assistant.LIMITS.take(client, settings.assistant_daily_limit_per_client, settings.assistant_daily_limit_total)
    except weather_assistant.AssistantUnavailable as exc:
        return JSONResponse(status_code=exc.status, content={"code": exc.code, "detail": str(exc)})
    try:
        reply = weather_assistant.answer(
            [m.model_dump() for m in body.messages], body.place.model_dump(), session, registry
        )
    except weather_assistant.AssistantUnavailable as exc:
        weather_assistant.LIMITS.give_back(client, day)
        log.warning("assistant unavailable: %s", exc)
        return JSONResponse(status_code=exc.status, content={"code": exc.code, "detail": str(exc)})
    log.info(
        "assistant answered with %s in %d round(s), tools %s, %d in / %d out tokens",
        reply.model, reply.rounds, ",".join(reply.tools_used) or "none", reply.input_tokens, reply.output_tokens,
    )
    return AssistantOut(reply=reply.text, sources=reply.sources, model=reply.model)


# Saved places, kept per anonymous client id.


def saved_place(client: str, place: PlaceIn, is_home: bool = False) -> SavedPlace:
    """A database row for one of this client's saved places."""
    return SavedPlace(
        client_id=client, place_id=place.place_id, name=place.name, admin1=place.admin1,
        country=place.country, latitude=place.latitude, longitude=place.longitude, is_home=is_home,
    )


def place_out(p: SavedPlace) -> PlaceOut:
    """A saved place for the API."""
    return PlaceOut(
        place_id=p.place_id, name=p.name, admin1=p.admin1, country=p.country,
        latitude=p.latitude, longitude=p.longitude, is_home=p.is_home,
    )


@app.get("/api/places", response_model=list[PlaceOut])
def list_places(session: SessionDep, client: ClientDep) -> list[PlaceOut]:
    """This client's saved places, oldest first."""
    rows = session.scalars(select(SavedPlace).where(SavedPlace.client_id == client).order_by(SavedPlace.id))
    return [place_out(p) for p in rows]


@app.post("/api/places", response_model=PlaceOut, status_code=201)
def add_place(body: PlaceIn, session: SessionDep, client: ClientDep) -> PlaceOut:
    """Save a place. Saving one that is already saved returns it unchanged."""
    existing = session.scalar(select(SavedPlace).where(SavedPlace.client_id == client, SavedPlace.place_id == body.place_id))
    if existing:
        return place_out(existing)
    count = len(session.scalars(select(SavedPlace.id).where(SavedPlace.client_id == client)).all())
    if count >= 8:
        raise HTTPException(status_code=409, detail="You can save up to 8 places. Remove one first.")
    place = saved_place(client, body)
    session.add(place)
    session.commit()
    return place_out(place)


@app.put("/api/places/{place_id}/home", response_model=PlaceOut)
def set_home(place_id: str, session: SessionDep, client: ClientDep) -> PlaceOut:
    """Make a saved place the home place; any other place loses that mark."""
    place = session.scalar(select(SavedPlace).where(SavedPlace.client_id == client, SavedPlace.place_id == place_id))
    if place is None:
        raise HTTPException(status_code=404, detail="That place isn't saved.")
    session.execute(update(SavedPlace).where(SavedPlace.client_id == client).values(is_home=False))
    place.is_home = True
    session.commit()
    return place_out(place)


@app.delete("/api/places/{place_id}/home", status_code=204)
def unset_home(place_id: str, session: SessionDep, client: ClientDep) -> None:
    """Clear the home mark from a place. Doing it twice is harmless."""
    session.execute(
        update(SavedPlace)
        .where(SavedPlace.client_id == client, SavedPlace.place_id == place_id)
        .values(is_home=False)
    )
    session.commit()


@app.put("/api/places", response_model=list[PlaceOut])
def replace_places(body: PlacesReplace, session: SessionDep, client: ClientDep) -> list[PlaceOut]:
    """Replace this client's saved places in one transaction (used by browser sync)."""
    ids = [p.place_id for p in body.places]
    if len(ids) != len(set(ids)):
        raise HTTPException(status_code=422, detail="Each saved place can appear only once.")
    if body.home_place_id is not None and body.home_place_id not in ids:
        raise HTTPException(status_code=422, detail="The home place must be one of the saved places.")
    session.execute(delete(SavedPlace).where(SavedPlace.client_id == client))
    rows = [saved_place(client, p, is_home=p.place_id == body.home_place_id) for p in body.places]
    session.add_all(rows)
    session.commit()
    return [place_out(p) for p in rows]


@app.delete("/api/places/{place_id}", status_code=204)
def remove_place(place_id: str, session: SessionDep, client: ClientDep) -> None:
    """Remove a saved place. Removing one that isn't saved is not an error."""
    session.execute(delete(SavedPlace).where(SavedPlace.client_id == client, SavedPlace.place_id == place_id))
    session.commit()
