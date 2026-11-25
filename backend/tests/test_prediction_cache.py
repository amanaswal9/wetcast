"""The shared prediction cache: each model runs at most once per city and hour of
data, and the ensemble reuses its members' results. Synthetic inputs (tests only)."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app import predictions
from app.registry import get_registry
from weatherai_ml.config import CITIES
from weatherai_ml.features import build_frames
from weatherai_ml.synthetic import synthetic_long_frame

REGISTRY = get_registry()
DELHI = next(c for c in CITIES if c.id == "delhi")
pytestmark = pytest.mark.skipif("ensemble" not in REGISTRY.names, reason="ensemble not trained")


def features(end: pd.Timestamp):
    """Model inputs for Delhi from a synthetic history ending at end."""
    frame, _ = build_frames(synthetic_long_frame(60, end=end), DELHI, 216.0)
    return frame


@pytest.fixture()
def counted(monkeypatch):
    """Count how often each model's predict runs, with the forecast cache cleared before and after."""
    predictions._predictions.clear()
    calls: dict[str, int] = {}
    for name in REGISTRY.names:
        predictor = REGISTRY.get(name)
        if name == "ensemble":
            continue
        original = predictor.predict

        def wrapped(f, _name=name, _original=original):
            """Count this call, then run the model's own predict."""
            calls[_name] = calls.get(_name, 0) + 1
            return _original(f)

        monkeypatch.setattr(predictor, "predict", wrapped)
    yield calls
    predictions._predictions.clear()


def test_each_model_runs_once_and_the_ensemble_reuses_members(counted):
    end = pd.Timestamp("2026-11-18 12:00", tz="UTC")
    out = predictions.predict_models(REGISTRY, DELHI, REGISTRY.names, features(end))
    assert set(out) == set(REGISTRY.names)
    assert all(n == 1 for n in counted.values()), counted
    expected = np.mean([out[m].values for m in REGISTRY.ensemble_members], axis=0)
    # Temperature and humidity are the members' mean; rain may be corrected to the expected amount (rain_amount.py).
    assert np.allclose(out["ensemble"].values[:, :2], expected[:, :2])
    assert (out["ensemble"].values[:, 2] >= 0).all()


def test_results_are_reused_until_a_new_hour_of_data(counted):
    end = pd.Timestamp("2026-11-18 12:00", tz="UTC")
    first = predictions.predict_models(REGISTRY, DELHI, ["ensemble"], features(end))
    runs = dict(counted)
    again = predictions.predict_models(REGISTRY, DELHI, ["ensemble", "lstm"], features(end))
    assert counted == runs  # nothing ran again
    assert again["ensemble"] is first["ensemble"]
    predictions.predict_models(REGISTRY, DELHI, ["lstm"], features(end + pd.Timedelta(hours=1)))
    assert counted["lstm"] == runs["lstm"] + 1  # newer data: forecast again


def test_only_requested_models_are_returned(counted):
    out = predictions.predict_models(REGISTRY, DELHI, ["gru"], features(pd.Timestamp("2026-11-18 12:00", tz="UTC")))
    assert list(out) == ["gru"] and set(counted) == {"gru"}


def test_rain_outlook_is_fetched_once_and_optional(monkeypatch):
    """The ensemble's chance of rain uses Open-Meteo's forecast when it arrives, once per city and
    hour, and still forecasts when it doesn't."""
    ensemble = REGISTRY.get("ensemble")
    if not getattr(ensemble, "wants_outlook", False):
        pytest.skip("this ensemble doesn't use Open-Meteo's forecast")
    end = pd.Timestamp("2026-07-15T06:00", tz="UTC")
    f = features(end)
    names = ["ensemble"]

    def run(outlook_values):
        """Forecast twice with a given rain outlook (None: Open-Meteo down) and return the chance of rain."""
        calls = []

        def fake(client, city, issued, hours):
            """Fake outlook fetch that records each call and returns outlook_values for every hour, or fails."""
            calls.append(issued)
            if outlook_values is None:
                raise RuntimeError("Open-Meteo is down")
            return np.full(hours, outlook_values)

        monkeypatch.setattr(predictions, "fetch_outlook", fake)
        predictions._predictions.clear()
        predictions._outlooks.clear()
        first = predictions.predict_models(REGISTRY, DELHI, names, f)["ensemble"]
        predictions._predictions.clear()  # the outlook cache alone must spare a second fetch
        second = predictions.predict_models(REGISTRY, DELHI, names, f)["ensemble"]
        assert len(calls) == 1 and np.allclose(first.rain_chance, second.rain_chance)
        return first.rain_chance

    wet, dry, down = run(8.0), run(0.0), run(None)
    assert wet.mean() > dry.mean()
    assert down.shape == (24,) and ((down >= 0) & (down <= 1)).all()
