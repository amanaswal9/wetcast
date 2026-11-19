"""WeatherAI API. Run: uvicorn app.main:app --reload --port 8000 (from backend/)."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import delete, select, text, update
from sqlalchemy.orm import Session

from weatherai_ml.config import TARGETS
from weatherai_ml.predict import InsufficientHistoryError, nearest_city
from weatherai_ml.preprocess import FeatureOrderError

from .config import get_settings
from .db import SavedPlace, engine, get_session
from .migrations import migrate
from .accuracy import track_record_summary
from .predictions import UpstreamError, recent_features, store_run, supported_cities
from .registry import ModelRegistry, get_registry
from .track_record import scheduler
from .schemas import (
    CityOut,
    HealthOut,
    ModelPredictionOut,
    PlaceIn,
    PlaceOut,
    PlacesReplace,
    PredictionPointOut,
    PredictionsOut,
    UnsupportedLocation,
)

settings = get_settings()
logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("weatherai.api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    migrate(engine())
    registry = get_registry()
    log.info("startup complete; models available: %s", ", ".join(registry.names) or "none")
    task = None
    if settings.track_record_interval_hours > 0:
        task = asyncio.create_task(scheduler(settings.track_record_interval_hours))
        log.info("track record: forecasts issued and scored every %d h", settings.track_record_interval_hours)
    yield
    if task is not None:
        task.cancel()


app = FastAPI(title="WeatherAI API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "X-Client-Id"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    log.info("%s %s -> %s in %.0f ms", request.method, request.url.path, response.status_code, (time.perf_counter() - started) * 1000)
    return response


@app.exception_handler(Exception)
async def unhandled(_: Request, exc: Exception):
    log.exception("unhandled error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": "Something went wrong on the server. Try again."})


SessionDep = Annotated[Session, Depends(get_session)]
RegistryDep = Annotated[ModelRegistry, Depends(get_registry)]

CLIENT_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")


def client_id(x_client_id: Annotated[str, Header()]) -> str:
    if not CLIENT_ID.match(x_client_id):
        raise HTTPException(status_code=400, detail="X-Client-Id must be 8 to 64 letters, digits or dashes.")
    return x_client_id


ClientDep = Annotated[str, Depends(client_id)]


def city_out(city) -> CityOut:
    return CityOut(id=city.id, name=city.name, latitude=city.latitude, longitude=city.longitude)


# ---- health and models --------------------------------------------------------------


@app.get("/api/health", response_model=HealthOut)
def health(session: SessionDep, registry: RegistryDep) -> HealthOut:
    try:
        session.execute(text("SELECT 1"))
        database = "ok"
    except Exception as exc:  # noqa: BLE001 - report, don't crash the health check
        log.warning("database check failed: %s", exc)
        database = "unavailable"
    return HealthOut(status="ok" if database == "ok" else "degraded", database=database, models=registry.names)


@app.get("/api/coverage", response_model=list[CityOut])
def coverage() -> list[CityOut]:
    """Cities WeatherAI's models were trained on. Predictions are only offered here."""
    return [city_out(c) for c in supported_cities()]


@app.get("/api/models")
def list_models(registry: RegistryDep) -> dict:
    return {"models": [registry.metrics(name) for name in registry.names]}


@app.get("/api/models/{name}")
def model_detail(name: str, registry: RegistryDep) -> dict:
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


# ---- predictions ----------------------------------------------------------------------


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
):
    city = nearest_city(latitude, longitude)
    if city is None:
        body = UnsupportedLocation(
            detail="WeatherAI's models only cover the North India cities they were trained on.",
            supported=[city_out(c) for c in supported_cities()],
        )
        return JSONResponse(status_code=404, content=body.model_dump())

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

    results, issued = [], None
    for name in names:
        predictor = registry.get(name)
        try:
            pred = predictor.predict(features)
        except InsufficientHistoryError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except FeatureOrderError as exc:
            log.error("feature order mismatch for %s: %s", name, exc)
            raise HTTPException(status_code=500, detail="The model and the data pipeline are out of sync.") from exc
        issued = pred.issued_at
        try:
            store_run(session, name, city, pred)
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
            points.append(PredictionPointOut(**row))
        results.append(ModelPredictionOut(model=name, display_name=registry.display_name(name), points=points))

    level = registry.metrics(names[0])["interval"]["level"]
    return PredictionsOut(
        city=city_out(city),
        issued_at=issued.to_pydatetime(),
        interval_level=level,
        source="Inputs: last 48 hours of Open-Meteo data for the city and four points ~55 km around it.",
        note=(
            f"Model predictions, not certainties. Ranges are sized to hold {round(level * 100)}% of past errors; "
            "on the 2026 test period they held between "
            f"{round(min(min(registry.metrics(n)['interval']['test_coverage'].values()) for n in names) * 100)}% and "
            f"{round(max(max(registry.metrics(n)['interval']['test_coverage'].values()) for n in names) * 100)}%."
        ),
        models=results,
    )


# ---- live track record ---------------------------------------------------------------


@app.get("/api/track-record")
def track_record(
    session: SessionDep,
    registry: RegistryDep,
    days: Annotated[int, Query(ge=1, le=365)] = 30,
    city: Annotated[str | None, Query(max_length=32)] = None,
) -> dict:
    """How stored forecasts did once the weather they predicted had happened."""
    if city is not None and city not in {c.id for c in supported_cities()}:
        raise HTTPException(status_code=404, detail=f"No trained city called {city!r}.")
    return track_record_summary(session, registry, days=days, city=city)


# ---- saved places ---------------------------------------------------------------------


def place_out(p: SavedPlace) -> PlaceOut:
    return PlaceOut(
        place_id=p.place_id, name=p.name, admin1=p.admin1, country=p.country,
        latitude=p.latitude, longitude=p.longitude, is_home=p.is_home,
    )


@app.get("/api/places", response_model=list[PlaceOut])
def list_places(session: SessionDep, client: ClientDep) -> list[PlaceOut]:
    rows = session.scalars(select(SavedPlace).where(SavedPlace.client_id == client).order_by(SavedPlace.id))
    return [place_out(p) for p in rows]


@app.post("/api/places", response_model=PlaceOut, status_code=201)
def add_place(body: PlaceIn, session: SessionDep, client: ClientDep) -> PlaceOut:
    existing = session.scalar(select(SavedPlace).where(SavedPlace.client_id == client, SavedPlace.place_id == body.place_id))
    if existing:
        return place_out(existing)
    count = len(session.scalars(select(SavedPlace.id).where(SavedPlace.client_id == client)).all())
    if count >= 8:
        raise HTTPException(status_code=409, detail="You can save up to 8 places. Remove one first.")
    place = SavedPlace(client_id=client, **body.model_dump())
    session.add(place)
    session.commit()
    return place_out(place)


@app.put("/api/places/{place_id}/home", response_model=PlaceOut)
def set_home(place_id: str, session: SessionDep, client: ClientDep) -> PlaceOut:
    place = session.scalar(select(SavedPlace).where(SavedPlace.client_id == client, SavedPlace.place_id == place_id))
    if place is None:
        raise HTTPException(status_code=404, detail="That place isn't saved.")
    session.execute(update(SavedPlace).where(SavedPlace.client_id == client).values(is_home=False))
    place.is_home = True
    session.commit()
    return place_out(place)


@app.delete("/api/places/{place_id}/home", status_code=204)
def unset_home(place_id: str, session: SessionDep, client: ClientDep) -> None:
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
    rows = [
        SavedPlace(client_id=client, is_home=p.place_id == body.home_place_id, **p.model_dump())
        for p in body.places
    ]
    session.add_all(rows)
    session.commit()
    return [place_out(p) for p in rows]


@app.delete("/api/places/{place_id}", status_code=204)
def remove_place(place_id: str, session: SessionDep, client: ClientDep) -> None:
    session.execute(delete(SavedPlace).where(SavedPlace.client_id == client, SavedPlace.place_id == place_id))
    session.commit()
