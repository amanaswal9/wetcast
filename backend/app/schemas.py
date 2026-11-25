"""API request and response shapes."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class CityOut(BaseModel):
    """A city the models know."""

    id: str
    name: str
    latitude: float
    longitude: float
    # "train": the models trained on it; "holdout": kept out to measure accuracy at new places.
    role: Literal["train", "holdout"] | None = None


class ExpectedErrorOut(BaseModel):
    """How accurate the forecast has been at this kind of place."""

    mae: dict[str, float | None] = Field(description="Mean absolute error per target, in its unit")
    basis: str
    temperature_range: list[float] | None = Field(
        default=None, description="Lowest and highest temperature error among the held-out cities"
    )


class CoverageOut(BaseModel):
    """Which kind of place was asked about, and the accuracy that goes with it."""

    kind: Literal["trained", "held_out", "untrained"]
    label: str
    detail: str
    nearest_city: CityOut
    nearest_km: float
    model: str = Field(description="The model whose measured accuracy is given (the ensemble when served)")
    expected_error: ExpectedErrorOut


class PredictionPointOut(BaseModel):
    """One forecast hour: each target with the lower and upper end of its range."""

    time: datetime
    lead_hours: int
    temperature: float
    temperature_lower: float
    temperature_upper: float
    humidity: float
    humidity_lower: float
    humidity_upper: float
    precipitation: float
    precipitation_lower: float
    precipitation_upper: float
    # Chance (0-1) of at least 0.1 mm of rain in the hour; only models with a calibrated table (the ensemble).
    rain_chance: float | None = None


class ModelPredictionOut(BaseModel):
    """The 24 forecast hours from one model."""

    model: str
    display_name: str
    points: list[PredictionPointOut]


class PredictionsOut(BaseModel):
    """The response of /api/predictions."""

    city: CityOut
    issued_at: datetime = Field(description="Last input hour (UTC). Predictions start one hour later.")
    interval_level: float
    source: str
    note: str
    coverage: CoverageOut
    models: list[ModelPredictionOut]


class UnsupportedLocation(BaseModel):
    """The 404 body for a place outside the models' reach, listing the nearest cities they cover."""

    code: str = "unsupported_location"
    detail: str
    supported: list[CityOut]


class PlaceIn(BaseModel):
    """A place to save, as the app's place search describes it."""

    place_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    admin1: str | None = Field(default=None, max_length=120)
    country: str | None = Field(default=None, max_length=120)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class PlaceOut(PlaceIn):
    """A saved place, with whether it is the home place."""

    is_home: bool


class PlacesReplace(BaseModel):
    """The browser's full saved-places state, replacing what the server holds."""

    places: list[PlaceIn] = Field(max_length=8)
    home_place_id: str | None = Field(default=None, max_length=64)


class HealthOut(BaseModel):
    """The response of /api/health."""

    status: str
    database: str
    models: list[str]


class AssistantTurn(BaseModel):
    """One message in the visible chat."""

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=2000)


class AssistantPlace(BaseModel):
    """The place on screen when the question was asked."""

    name: str = Field(min_length=1, max_length=120)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    country_code: str | None = Field(default=None, pattern="^[A-Za-z]{2}$")


class AssistantIn(BaseModel):
    """The visible chat (oldest first, ending with the new question) and the place on screen."""

    messages: list[AssistantTurn] = Field(min_length=1, max_length=12)
    place: AssistantPlace


class AssistantOut(BaseModel):
    """Javed's answer in plain text, with the sources it looked up."""

    reply: str
    sources: list[str]
    model: str


class AssistantStatus(BaseModel):
    """Whether the Ask page works, and who answers."""

    configured: bool
    # "local" (the free model on the server's computer) or None when off.
    provider: str | None = None
    model: str
    daily_limit_per_visitor: int
