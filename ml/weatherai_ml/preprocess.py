"""The fitted preprocessing pipeline, saved as JSON next to every model.

Fitted on training-period rows only. Inference loads the same JSON and refuses
to run if the incoming feature columns differ from the saved order.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from . import PIPELINE_VERSION
from .config import FEATURE_ORDER, HORIZON_HOURS, LOOKBACK_HOURS, TARGETS

PRECIP_INDEX = TARGETS.index("precipitation")
HUMIDITY_INDEX = TARGETS.index("humidity")
RESIDUAL_INDICES = (TARGETS.index("temperature"), HUMIDITY_INDEX)


class FeatureOrderError(ValueError):
    """Incoming features don't match the order the model was trained with."""


@dataclass
class Preprocessor:
    feature_order: list[str]
    feature_mean: list[float]
    feature_std: list[float]
    target_names: list[str]
    target_mean: list[float]
    target_std: list[float]
    lookback: int
    horizon: int
    pipeline_version: str
    # "direct": the model predicts each target value.
    # "residual24": for temperature and humidity it predicts the change from the
    # same hour on the previous day; precipitation stays direct.
    target_mode: str = "direct"

    @property
    def residual_indices(self) -> tuple[int, ...]:
        return RESIDUAL_INDICES if self.target_mode == "residual24" else ()

    # ---- fitting -----------------------------------------------------------------
    @classmethod
    def fit(
        cls, features: np.ndarray, targets: np.ndarray, lookback: int = LOOKBACK_HOURS, target_mode: str = "direct"
    ) -> "Preprocessor":
        """`features`/`targets` are training-period rows only (physical units).
        In residual24 mode `targets` must already hold the day-on-day changes."""
        f_mean = np.nanmean(features, axis=0)
        f_std = np.nanstd(features, axis=0)
        f_std[~np.isfinite(f_std) | (f_std < 1e-6)] = 1.0
        t = _forward_targets(targets)
        t_mean = np.nanmean(t, axis=0)
        t_std = np.nanstd(t, axis=0)
        t_std[t_std < 1e-6] = 1.0
        return cls(
            feature_order=list(FEATURE_ORDER),
            feature_mean=f_mean.astype(float).tolist(),
            feature_std=f_std.astype(float).tolist(),
            target_names=list(TARGETS),
            target_mean=t_mean.astype(float).tolist(),
            target_std=t_std.astype(float).tolist(),
            lookback=lookback,
            horizon=HORIZON_HOURS,
            pipeline_version=PIPELINE_VERSION,
            target_mode=target_mode,
        )

    # ---- transforms --------------------------------------------------------------
    def check_columns(self, frame: pd.DataFrame) -> None:
        if list(frame.columns) != self.feature_order:
            raise FeatureOrderError("Feature columns or their order differ from the trained pipeline.")

    def transform_features(self, features: np.ndarray) -> np.ndarray:
        return ((features - np.asarray(self.feature_mean)) / np.asarray(self.feature_std)).astype(np.float32)

    def transform_frame(self, frame: pd.DataFrame) -> np.ndarray:
        self.check_columns(frame)
        return self.transform_features(frame.to_numpy(dtype=float))

    def transform_targets(self, targets: np.ndarray) -> np.ndarray:
        t = _forward_targets(targets)
        return ((t - np.asarray(self.target_mean)) / np.asarray(self.target_std)).astype(np.float32)

    def inverse_targets(self, scaled: np.ndarray, yesterday: np.ndarray | None = None) -> np.ndarray:
        """Model output (..., horizon, n_targets) -> physical units with physical limits applied.

        `yesterday` holds the observed targets 24 h before each predicted hour,
        shape (..., horizon, n_targets); required in residual24 mode."""
        t = scaled * np.asarray(self.target_std) + np.asarray(self.target_mean)
        t = t.astype(float)
        if self.residual_indices:
            if yesterday is None:
                raise ValueError("residual24 models need the previous day's values to reconstruct predictions")
            for k in self.residual_indices:
                t[..., k] = t[..., k] + yesterday[..., k]
        t[..., PRECIP_INDEX] = np.clip(np.expm1(t[..., PRECIP_INDEX]), 0, None)
        t[..., HUMIDITY_INDEX] = np.clip(t[..., HUMIDITY_INDEX], 0, 100)
        return t

    # ---- persistence -------------------------------------------------------------
    def save(self, path: Path) -> None:
        path.write_text(json.dumps(asdict(self), indent=2))

    @classmethod
    def load(cls, path: Path) -> "Preprocessor":
        data = json.loads(path.read_text())
        pre = cls(**data)
        if pre.feature_order != list(FEATURE_ORDER):
            raise FeatureOrderError(f"{path} was trained with a different feature order than this code.")
        return pre


def _forward_targets(targets: np.ndarray) -> np.ndarray:
    """Precipitation is heavily skewed, so the model learns log1p(mm)."""
    t = np.array(targets, dtype=float, copy=True)
    t[..., PRECIP_INDEX] = np.log1p(np.clip(t[..., PRECIP_INDEX], 0, None))
    return t
