"""API request and response shapes."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class CityOut(BaseModel):
    id: str
    name: str
    latitude: float
    longitude: float


class PredictionPointOut(BaseModel):
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


class ModelPredictionOut(BaseModel):
    model: str
    display_name: str
    points: list[PredictionPointOut]


class PredictionsOut(BaseModel):
    city: CityOut
    issued_at: datetime = Field(description="Last input hour (UTC). Predictions start one hour later.")
    interval_level: float
    source: str
    note: str
    models: list[ModelPredictionOut]


class UnsupportedLocation(BaseModel):
    code: str = "unsupported_location"
    detail: str
    supported: list[CityOut]


class PlaceIn(BaseModel):
    place_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    admin1: str | None = Field(default=None, max_length=120)
    country: str | None = Field(default=None, max_length=120)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class PlaceOut(PlaceIn):
    is_home: bool


class PlacesReplace(BaseModel):
    """The browser's full saved-places state, replacing what the server holds."""

    places: list[PlaceIn] = Field(max_length=8)
    home_place_id: str | None = Field(default=None, max_length=64)


class HealthOut(BaseModel):
    status: str
    database: str
    models: list[str]
