"""Database models and session handling (SQLAlchemy 2)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, UniqueConstraint, create_engine
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
    __table_args__ = (UniqueConstraint("model", "city_id", "issued_at", name="uq_run"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    model: Mapped[str] = mapped_column(String(32), index=True)
    city_id: Mapped[str] = mapped_column(String(32), index=True)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    points: Mapped[list["PredictionPoint"]] = relationship(back_populates="run", cascade="all, delete-orphan")


class PredictionPoint(Base):
    __tablename__ = "prediction_points"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("prediction_runs.id", ondelete="CASCADE"), index=True)
    valid_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    lead_hours: Mapped[int] = mapped_column(Integer)
    target: Mapped[str] = mapped_column(String(16))
    value: Mapped[float] = mapped_column(Float)
    lower: Mapped[float] = mapped_column(Float)
    upper: Mapped[float] = mapped_column(Float)
    run: Mapped[PredictionRun] = relationship(back_populates="points")


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


def create_tables() -> None:
    Base.metadata.create_all(engine())


def get_session() -> Iterator[Session]:
    if _SessionLocal is None:
        init_engine()
    assert _SessionLocal is not None
    with _SessionLocal() as session:
        yield session
