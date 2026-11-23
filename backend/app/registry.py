"""Finds trained models on disk. Only models with complete artifacts are served."""

from __future__ import annotations

import json
import logging
import time
from functools import lru_cache
from pathlib import Path

from weatherai_ml.gbm import GBM_NAME
from weatherai_ml.models import DISPLAY_NAMES, ENSEMBLE_NAME, MODEL_NAMES
from weatherai_ml.predict import EnsemblePredictor, GBMPredictor, Predictor

from .config import get_settings

log = logging.getLogger("weatherai.registry")
# Files a model folder must have before the model is served.
REQUIRED = ("model.keras", "preprocessor.json", "metrics.json", "evaluation.json")
REQUIRED_ENSEMBLE = ("ensemble.json", "metrics.json", "evaluation.json")
REQUIRED_GBM = ("gbm_config.json", "metrics.json", "evaluation.json", "model_temperature.txt", "model_humidity.txt", "model_precipitation.txt")


class ModelRegistry:
    """The served models, loaded once from the artifacts folder. A model with missing files is
    skipped with a warning instead of stopping the API."""

    def __init__(self, artifacts_dir: Path):
        self.artifacts_dir = artifacts_dir
        self._predictors: dict[str, Predictor | GBMPredictor | EnsemblePredictor] = {}
        self.ensemble_members: list[str] = []
        for name in MODEL_NAMES:
            folder = artifacts_dir / name
            missing = [f for f in REQUIRED if not (folder / f).exists()]
            if missing:
                log.warning("model %s not available, missing %s", name, ", ".join(missing))
                continue
            self._predictors[name] = Predictor(folder)
            log.info("model %s registered", name)
        gbm_folder = artifacts_dir / GBM_NAME
        if all((gbm_folder / f).exists() for f in REQUIRED_GBM):
            self._predictors[GBM_NAME] = GBMPredictor(gbm_folder)
            log.info("model %s registered", GBM_NAME)
        self._register_ensemble()
        self._summaries: dict[str, dict] = {}

    @property
    def region_id(self) -> str:
        """Which region's cities the served models were trained on ("india" or "north_india")."""
        for predictor in self._predictors.values():
            return predictor.metrics["data"].get("region_id", "north_india")
        return "north_india"

    def _register_ensemble(self) -> None:
        folder = self.artifacts_dir / ENSEMBLE_NAME
        if any(not (folder / f).exists() for f in REQUIRED_ENSEMBLE):
            return
        members = json.loads((folder / "ensemble.json").read_text())["members"]
        missing = [m for m in members if m not in self._predictors]
        if missing:
            # Never serve an ensemble that would silently average fewer models than it was evaluated with.
            log.warning("ensemble not available, member models missing: %s", ", ".join(missing))
            return
        self._predictors[ENSEMBLE_NAME] = EnsemblePredictor(folder, [self._predictors[m] for m in members])
        self.ensemble_members = list(members)
        log.info("ensemble registered (%s)", ", ".join(members))

    def warm_up(self) -> None:
        """Load every network and run it once, so the first real forecast doesn't pay
        TensorFlow's start-up cost (loading weights, building the graph)."""
        import numpy as np

        started = time.perf_counter()
        for name, predictor in self._predictors.items():
            if isinstance(predictor, Predictor):
                shape = (1, predictor.preprocessor.lookback, len(predictor.preprocessor.feature_order))
                predictor.model(np.zeros(shape, dtype="float32"), training=False)
        log.info("models warmed up in %.1f s", time.perf_counter() - started)

    @property
    def names(self) -> list[str]:
        """Served model names: the neural networks, then the boosted trees, then the ensemble."""
        return list(self._predictors)

    def get(self, name: str) -> Predictor | GBMPredictor | EnsemblePredictor | None:
        """The predictor called `name`, or None if it isn't served."""
        return self._predictors.get(name)

    def metrics(self, name: str) -> dict:
        """The model's metrics.json (test-period errors, interval coverage, training data)."""
        return self._predictors[name].metrics

    def evaluation(self, name: str) -> dict:
        """The model's evaluation.json, read from disk each time because it is large."""
        return json.loads((self.artifacts_dir / name / "evaluation.json").read_text())

    def evaluation_summary(self, name: str) -> dict:
        """The evaluation without its sample series (per-city and per-horizon errors), kept in memory."""
        if name not in self._summaries:
            self._summaries[name] = {k: v for k, v in self.evaluation(name).items() if k != "samples"}
        return self._summaries[name]

    @staticmethod
    def display_name(name: str) -> str:
        """The name shown to people, such as "ST-Transformer"."""
        return DISPLAY_NAMES.get(name, name)


@lru_cache
def get_registry() -> ModelRegistry:
    """The registry for the configured artifacts folder, built once per process."""
    return ModelRegistry(get_settings().artifacts_dir)
