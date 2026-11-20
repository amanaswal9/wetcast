"""Database models and session handling (SQLAlchemy 2)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

from .config import get_settings


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class PredictionRun(Base):
    """One 24-hour forecast issued by one model for one city. Kept so predictions
    can later be scored against what actually happened."""

    __tablename__ = "prediction_runs"
    __table_args__ = (UniqueConstraint("model_set", "model", "city_id", "issued_at", name="uq_run"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    model: Mapped[str] = mapped_column(String(32), index=True)
    city_id: Mapped[str] = mapped_column(String(32), index=True)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    # Region the models were trained on ("north_india", "india"): model names repeat across sets.
    model_set: Mapped[str] = mapped_column(String(32), index=True, default="north_india", server_default="north_india")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    points: Mapped[list["PredictionPoint"]] = relationship(back_populates="run", cascade="all, delete-orphan")


class PredictionPoint(Base):
    __tablename__ = "prediction_points"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("prediction_runs.id", ondelete="CASCADE"), index=True)
    valid_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    lead_hours: Mapped[int] = mapped_column(Integer)
    target: Mapped[str] = mapped_column(String(16))
    value: Mapped[float] = mapped_column(Float)
    lower: Mapped[float] = mapped_column(Float)
    upper: Mapped[float] = mapped_column(Float)
    # Filled in by the track-record job once what happened is known (app/track_record.py).
    observed: Mapped[float | None] = mapped_column(Float, nullable=True)
    persistence: Mapped[float | None] = mapped_column(Float, nullable=True)  # same hour one day earlier
    scored_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    run: Mapped[PredictionRun] = relationship(back_populates="points")


class Observation(Base):
    """What happened at a city centre, hour by hour, used to score stored forecasts.

    Source: Open-Meteo's record of past hours (the same kind of data the models
    were trained and tested on), saved only once it is several hours old so that
    later model runs no longer change it. It is not a weather-station reading."""

    __tablename__ = "observations"
    __table_args__ = (UniqueConstraint("city_id", "valid_at", name="uq_observation"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    city_id: Mapped[str] = mapped_column(String(32), index=True)
    valid_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    temperature: Mapped[float | None] = mapped_column(Float, nullable=True)
    humidity: Mapped[float | None] = mapped_column(Float, nullable=True)
    precipitation: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[str] = mapped_column(String(32), default="open-meteo")
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SavedPlace(Base):
    """Saved places per anonymous client id (no accounts yet)."""

    __tablename__ = "saved_places"
    __table_args__ = (UniqueConstraint("client_id", "place_id", name="uq_saved_place"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    client_id: Mapped[str] = mapped_column(String(64), index=True)
    place_id: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(120))
    admin1: Mapped[str | None] = mapped_column(String(120), nullable=True)
    country: Mapped[str | None] = mapped_column(String(120), nullable=True)
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    is_home: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Alert(Base):
    """An official warning read from a public CAP feed (see app/alerts.py).

    Kept until shortly after it expires, because the source feed only lists its
    latest items and an active warning can scroll off it."""

    __tablename__ = "alerts"
    __table_args__ = (UniqueConstraint("source", "guid", name="uq_alert_guid"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source: Mapped[str] = mapped_column(String(16), index=True)
    guid: Mapped[str] = mapped_column(String(64))
    identifier: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)
    status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    msg_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    sender_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    event: Mapped[str | None] = mapped_column(String(200), nullable=True)
    severity: Mapped[str | None] = mapped_column(String(16), nullable=True)
    urgency: Mapped[str | None] = mapped_column(String(16), nullable=True)
    certainty: Mapped[str | None] = mapped_column(String(16), nullable=True)
    headline: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    instruction: Mapped[str | None] = mapped_column(Text, nullable=True)
    area_desc: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    onset: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True, nullable=True)
    # Rings as "lat,lon lat,lon ...", several rings separated by "|"; plus a bounding box for a quick filter.
    polygons: Mapped[str | None] = mapped_column(Text, nullable=True)
    min_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    min_lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    link: Mapped[str | None] = mapped_column(String(300), nullable=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


_engine = None
_SessionLocal: sessionmaker[Session] | None = None


def init_engine(url: str | None = None) -> None:
    global _engine, _SessionLocal
    url = url or get_settings().database_url
    kwargs = {"connect_args": {"check_same_thread": False}} if url.startswith("sqlite") else {"pool_pre_ping": True}
    _engine = create_engine(url, **kwargs)
    _SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False)


def engine():
    if _engine is None:
        init_engine()
    return _engine


def new_session() -> Session:
    """A session for background jobs (close it, e.g. `with new_session() as s:`)."""
    if _SessionLocal is None:
        init_engine()
    assert _SessionLocal is not None
    return _SessionLocal()


def get_session() -> Iterator[Session]:
    if _SessionLocal is None:
        init_engine()
    assert _SessionLocal is not None
    with _SessionLocal() as session:
        yield session
