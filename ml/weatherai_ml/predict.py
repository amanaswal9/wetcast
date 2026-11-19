"""Live inference with a trained model. Used by the FastAPI backend.

Applies exactly the training transformations: `features.build_frames` for
feature engineering and the saved `preprocessor.json` for scaling, with a
hard check on feature order.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from .config import CITIES, POINTS, TARGETS, City
from .preprocess import Preprocessor


class InsufficientHistoryError(ValueError):
    """Not enough complete recent hours to build an input window."""


@dataclass
class Prediction:
    issued_at: pd.Timestamp  # last observed input hour (UTC)
    times: list[pd.Timestamp]  # valid times, UTC
    values: np.ndarray  # (horizon, n_targets)
    lower: np.ndarray
    upper: np.ndarray


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def nearest_city(latitude: float, longitude: float, max_km: float = 30.0) -> City | None:
    """The trained city within `max_km`, or None. Models only cover trained cities."""
    best = min(CITIES, key=lambda c: haversine_km(latitude, longitude, c.latitude, c.longitude))
    return best if haversine_km(latitude, longitude, best.latitude, best.longitude) <= max_km else None


class Predictor:
    def __init__(self, model_dir: Path):
        self.model_dir = model_dir
        self.name = model_dir.name
        self.preprocessor = Preprocessor.load(model_dir / "preprocessor.json")
        self.metrics = json.loads((model_dir / "metrics.json").read_text())
        self.halfwidth = np.array(
            [self.metrics["interval"]["halfwidth_by_horizon"][t] for t in TARGETS], dtype=float
        ).T  # (horizon, n_targets)
        self._model = None

    @property
    def model(self):
        if self._model is None:
            import keras  # deferred: TensorFlow import is slow

            self._model = keras.saving.load_model(self.model_dir / "model.keras", compile=False)
        return self._model

    @staticmethod
    def usable(features: pd.DataFrame) -> pd.DataFrame:
        """Drop trailing hours whose weather values are incomplete (e.g. the newest hour
        not yet published for one neighbour point). Time and location columns are always
        filled, so completeness is judged on the weather columns only. The forecast is
        then issued from the last complete hour."""
        weather = [c for c in features.columns if c.split("_", 1)[0] in {p for p, _, _ in POINTS}]
        complete = features[weather].notna().all(axis=1).to_numpy()
        if not complete.any():
            raise InsufficientHistoryError("No complete recent hours in the data.")
        last = int(np.flatnonzero(complete)[-1])
        return features.iloc[: last + 1]

    def input_window(self, features: pd.DataFrame) -> np.ndarray:
        self.preprocessor.check_columns(features)
        lookback = self.preprocessor.lookback
        window = self.usable(features).iloc[-lookback:]
        if len(window) < lookback or window.isna().any().any():
            raise InsufficientHistoryError(f"Need {lookback} complete recent hours; the data has gaps.")
        expected = pd.date_range(window.index[0], periods=lookback, freq="h")
        if not window.index.equals(expected):
            raise InsufficientHistoryError("Recent hours are not contiguous.")
        return self.preprocessor.transform_frame(window)[None, ...]

    def yesterday(self, features: pd.DataFrame) -> np.ndarray:
        """Targets for the 24 hours before each predicted hour: the last 24 input hours.
        Centre temperature and humidity are exactly the target series (see features.build_frames)."""
        window = self.usable(features).iloc[-self.preprocessor.horizon :]
        out = np.zeros((self.preprocessor.horizon, len(TARGETS)))
        out[:, TARGETS.index("temperature")] = window["c_temp"].to_numpy(dtype=float)
        out[:, TARGETS.index("humidity")] = window["c_rh"].to_numpy(dtype=float)
        out[:, TARGETS.index("precipitation")] = np.expm1(window["c_precip_log1p"].to_numpy(dtype=float))
        return out

    def predict(self, features: pd.DataFrame) -> Prediction:
        x = self.input_window(features)
        scaled = np.asarray(self.model(x, training=False))[0]
        values = self.preprocessor.inverse_targets(scaled, self.yesterday(features))
        lower = values - self.halfwidth
        upper = values + self.halfwidth
        p, h = TARGETS.index("precipitation"), TARGETS.index("humidity")
        lower[:, p] = np.clip(lower[:, p], 0, None)
        lower[:, h], upper[:, h] = np.clip(lower[:, h], 0, 100), np.clip(upper[:, h], 0, 100)
        issued = self.usable(features).index[-1]
        times = [issued + pd.Timedelta(hours=i) for i in range(1, self.preprocessor.horizon + 1)]
        return Prediction(issued_at=issued, times=times, values=values, lower=lower, upper=upper)


@dataclass
class InputSpec:
    """What the API needs to know to fetch enough history for a model."""

    lookback: int
    horizon: int


class GBMPredictor:
    """Live inference for the LightGBM model, using gbm.build_matrix exactly as in training."""

    def __init__(self, model_dir: Path):
        from .gbm import GBMForecaster

        self.model_dir = model_dir
        self.name = model_dir.name
        self.forecaster = GBMForecaster(model_dir)
        self.metrics = json.loads((model_dir / "metrics.json").read_text())
        self.halfwidth = np.array([self.metrics["interval"]["halfwidth_by_horizon"][t] for t in TARGETS], dtype=float).T
        self.preprocessor = InputSpec(lookback=self.forecaster.lookback, horizon=len(self.halfwidth))

    def predict(self, features: pd.DataFrame) -> Prediction:
        from .config import FEATURE_ORDER
        from .gbm import build_matrix
        from .preprocess import FeatureOrderError

        if list(features.columns) != list(FEATURE_ORDER):
            raise FeatureOrderError("Feature columns or their order differ from the trained pipeline.")
        lookback, horizon = self.preprocessor.lookback, self.preprocessor.horizon
        window = Predictor.usable(features).iloc[-lookback:]
        if len(window) < lookback or window.isna().any().any():
            raise InsufficientHistoryError(f"Need {lookback} complete recent hours; the data has gaps.")
        if not window.index.equals(pd.date_range(window.index[0], periods=lookback, freq="h")):
            raise InsufficientHistoryError("Recent hours are not contiguous.")
        F = window.to_numpy(dtype=np.float32)
        last = window.iloc[-horizon:]
        prev = np.zeros((1, horizon, len(TARGETS)))
        prev[0, :, TARGETS.index("temperature")] = last["c_temp"].to_numpy(dtype=float)
        prev[0, :, TARGETS.index("humidity")] = last["c_rh"].to_numpy(dtype=float)
        prev[0, :, TARGETS.index("precipitation")] = np.expm1(last["c_precip_log1p"].to_numpy(dtype=float))
        issued = window.index[-1]
        X = build_matrix(F, np.array([issued.hour]), np.array([len(F) - 1]), prev)
        values = self.forecaster.predict_matrix(X, prev)[0]
        lower, upper = apply_ranges(values, self.halfwidth)
        times = [issued + pd.Timedelta(hours=i) for i in range(1, horizon + 1)]
        return Prediction(issued_at=issued, times=times, values=values, lower=lower, upper=upper)


def apply_ranges(values: np.ndarray, halfwidth: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lower = values - halfwidth
    upper = values + halfwidth
    p, h = TARGETS.index("precipitation"), TARGETS.index("humidity")
    lower[:, p] = np.clip(lower[:, p], 0, None)
    lower[:, h], upper[:, h] = np.clip(lower[:, h], 0, 100), np.clip(upper[:, h], 0, 100)
    return lower, upper


class EnsemblePredictor:
    """Average of member predictors, with its own validation-calibrated error ranges."""

    def __init__(self, model_dir: Path, members: list[Predictor]):
        self.model_dir = model_dir
        self.name = model_dir.name
        self.members = members
        self.metrics = json.loads((model_dir / "metrics.json").read_text())
        self.halfwidth = np.array([self.metrics["interval"]["halfwidth_by_horizon"][t] for t in TARGETS], dtype=float).T
        # The longest member lookback decides how much history the API must fetch.
        self.preprocessor = max((m.preprocessor for m in members), key=lambda p: p.lookback)

    def predict(self, features: pd.DataFrame) -> Prediction:
        preds = [m.predict(features) for m in self.members]
        issued = {p.issued_at for p in preds}
        if len(issued) != 1:
            raise InsufficientHistoryError("Ensemble members disagree on the last complete hour.")
        values = np.mean([p.values for p in preds], axis=0)
        lower, upper = apply_ranges(values, self.halfwidth)
        return Prediction(issued_at=preds[0].issued_at, times=preds[0].times, values=values, lower=lower, upper=upper)
