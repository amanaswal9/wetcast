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
    """One forecast: a value and an 80% range for every target at each hour ahead."""

    issued_at: pd.Timestamp  # last observed input hour (UTC)
    times: list[pd.Timestamp]  # valid times, UTC
    values: np.ndarray  # (horizon, n_targets)
    lower: np.ndarray
    upper: np.ndarray
    rain_chance: np.ndarray | None = None  # (horizon,) chance of >= 0.1 mm in each hour; ensemble only


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points, in kilometres."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = pow(math.sin(dp / 2), 2) + math.cos(p1) * math.cos(p2) * pow(math.sin(dl / 2), 2)
    return 2 * r * math.asin(math.sqrt(a))


def nearest_city(latitude: float, longitude: float, max_km: float = 30.0) -> City | None:
    """The trained city within `max_km`, or None. Models only cover trained cities."""
    best = min(CITIES, key=lambda c: haversine_km(latitude, longitude, c.latitude, c.longitude))
    return best if haversine_km(latitude, longitude, best.latitude, best.longitude) <= max_km else None


RECENT_RAIN_HOURS = 24  # rain_amount.RECENT_HOURS (kept here so serving doesn't import it eagerly)


class Ranges:
    """A model's 80% error-range half-widths: per calendar month when the metrics have them
    (see train.interval_block), otherwise one set for the whole year (older artifacts)."""

    def __init__(self, interval: dict):
        self.flat = np.array([interval["halfwidth_by_horizon"][t] for t in TARGETS], dtype=float).T  # (horizon, targets)
        monthly = interval.get("halfwidth_by_month")
        # (12, horizon, targets), or None
        self.monthly = np.stack([np.asarray(monthly[t], dtype=float) for t in TARGETS], axis=-1) if monthly else None

    def at(self, issued) -> np.ndarray:
        """(horizon, targets) half-widths for a forecast issued at `issued` (its UTC month)."""
        if self.monthly is None:
            return self.flat
        ts = pd.Timestamp(issued)
        return self.monthly[(ts.tz_convert("UTC") if ts.tzinfo else ts).month - 1]


class Predictor:
    """Live inference for one saved Keras network, using its own preprocessor.json."""

    def __init__(self, model_dir: Path):
        self.model_dir = model_dir
        self.name = model_dir.name
        self.preprocessor = Preprocessor.load(model_dir / "preprocessor.json")
        self.metrics = json.loads((model_dir / "metrics.json").read_text())
        self.ranges = Ranges(self.metrics["interval"])
        self._model = None

    @property
    def model(self):
        """The Keras model, loaded on first use."""
        if self._model is None:
            import keras  # deferred: TensorFlow import is slow

            from . import models  # noqa: F401 - registers the Transformer's custom layers for loading
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
        """The scaled (1, lookback, features) input, after checking the hours are complete and contiguous."""
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
        """Forecast the next `horizon` hours from recent features (built by features.build_frames)."""
        x = self.input_window(features)
        scaled = np.asarray(self.model(x, training=False))[0]
        values = self.preprocessor.inverse_targets(scaled, self.yesterday(features))
        issued = self.usable(features).index[-1]
        lower, upper = apply_ranges(values, self.ranges.at(issued))
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
        self.ranges = Ranges(self.metrics["interval"])
        self.preprocessor = InputSpec(lookback=self.forecaster.lookback, horizon=len(self.ranges.flat))

    def predict(self, features: pd.DataFrame) -> Prediction:
        """Forecast the next `horizon` hours, with the same checks as Predictor.predict."""
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
        lower, upper = apply_ranges(values, self.ranges.at(issued))
        times = [issued + pd.Timedelta(hours=i) for i in range(1, horizon + 1)]
        return Prediction(issued_at=issued, times=times, values=values, lower=lower, upper=upper)


def apply_ranges(values: np.ndarray, halfwidth: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Lower and upper ends of the range, kept within physical limits (no negative rain, humidity 0 to 100)."""
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
        self.ranges = Ranges(self.metrics["interval"])
        chance_file = model_dir / "rain_chance.json"  # see rain_chance.py
        self.rain_chance = json.loads(chance_file.read_text()) if chance_file.exists() else None
        if self.rain_chance is not None:  # its scores travel with the metrics (the lookup table stays here)
            self.metrics = self.metrics | {"rain_chance": {k: v for k, v in self.rain_chance.items() if k != "leads"}}
        self.rain_amount = None  # expected rain amounts (rain_amount.py); needs the chance-of-rain table
        if (model_dir / "rain_amount.txt").exists() and self.rain_chance is not None:
            from .rain_amount import RainAmount

            self.rain_amount = RainAmount(model_dir, self.rain_chance["leads"])
        self.chance_model = None  # chance of rain with Open-Meteo's forecast as a hint (chance_model.py)
        model_info = (self.rain_chance or {}).get("model")
        if model_info and (model_dir / model_info["file"]).exists():
            import lightgbm as lgb

            self.chance_model = (lgb.Booster(model_file=str(model_dir / model_info["file"])), model_info)
        # The longest member lookback decides how much history the API must fetch.
        self.preprocessor = max((m.preprocessor for m in members), key=lambda p: p.lookback)

    @property
    def wants_outlook(self) -> bool:
        """True when the rain correction uses Open-Meteo's day-old rain forecast (outlook.py)."""
        return (self.rain_amount is not None and self.rain_amount.uses_outlook) or (
            self.chance_model is not None and bool(self.chance_model[1].get("outlook"))
        )

    def predict(self, features: pd.DataFrame, outlook: np.ndarray | None = None) -> Prediction:
        """Run every member, then combine them."""
        return self.combine([m.predict(features) for m in self.members], features, outlook)

    def combine(self, preds: list[Prediction], features: pd.DataFrame | None = None, outlook: np.ndarray | None = None) -> Prediction:
        """The ensemble from member predictions already made (in member order), so a
        caller that ran the members anyway doesn't run them twice. `features` (the members'
        input) supplies the recent observed rain for the rain-amount correction; `outlook`, (H,) mm,
        Open-Meteo's forecast for the same hours (NaN or None where unknown: the correction then does
        without it)."""
        if len(preds) != len(self.members):
            raise ValueError(f"expected {len(self.members)} member predictions, got {len(preds)}")
        issued = {p.issued_at for p in preds}
        if len(issued) != 1:
            raise InsufficientHistoryError("Ensemble members disagree on the last complete hour.")
        values = np.mean([p.values for p in preds], axis=0)
        rain = TARGETS.index("precipitation")
        chance = None
        if self.rain_chance is not None:  # from the members' plain average, as it was fitted
            from .rain_chance import chance as rain_chance

            chance = rain_chance(self.rain_chance["leads"], values[:, rain])
        recent = None
        if features is not None:
            recent = np.expm1(Predictor.usable(features)["c_precip_log1p"].to_numpy(dtype=float)[-RECENT_RAIN_HOURS:])
        by_name = {m.name: p.values[:, rain] for m, p in zip(self.members, preds)}
        if self.chance_model is not None and recent is not None:  # without the inputs, the isotonic chance stays
            from .rain_amount import design

            booster, info = self.chance_model
            member_rain = np.clip(np.stack([np.asarray(by_name[m], dtype=float) for m in info["members"]], -1)[None], 0, None)
            ts = pd.Timestamp(preds[0].issued_at)
            ts = ts.tz_convert("UTC") if ts.tzinfo else ts
            hint = np.full(member_rain.shape[:2], np.nan) if outlook is None else np.asarray(outlook, dtype=float).reshape(member_rain.shape[:2])
            X = design(member_rain.mean(-1), member_rain, np.array([ts.month]), np.array([ts.hour]), recent[None], self.rain_chance["leads"], hint)
            chance = booster.predict(X, num_iteration=info["trees"])
        if self.rain_amount is not None:
            if recent is None:
                raise ValueError("The ensemble's rain correction needs the input features.")
            values[:, rain] = self.rain_amount.predict(by_name, preds[0].issued_at, recent, outlook)
        lower, upper = apply_ranges(values, self.ranges.at(preds[0].issued_at))
        return Prediction(issued_at=preds[0].issued_at, times=preds[0].times, values=values, lower=lower, upper=upper, rain_chance=chance)
