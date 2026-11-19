"""Finds trained models on disk. Only models with complete artifacts are served."""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path

from weatherai_ml.gbm import GBM_NAME
from weatherai_ml.models import DISPLAY_NAMES, ENSEMBLE_NAME, MODEL_NAMES
from weatherai_ml.predict import EnsemblePredictor, GBMPredictor, Predictor

from .config import get_settings

log = logging.getLogger("weatherai.registry")
REQUIRED = ("model.keras", "preprocessor.json", "metrics.json", "evaluation.json")
REQUIRED_ENSEMBLE = ("ensemble.json", "metrics.json", "evaluation.json")
REQUIRED_GBM = ("gbm_config.json", "metrics.json", "evaluation.json", "model_temperature.txt", "model_humidity.txt", "model_precipitation.txt")


class ModelRegistry:
    def __init__(self, artifacts_dir: Path):
        self.artifacts_dir = artifacts_dir
        self._predictors: dict[str, Predictor | GBMPredictor | EnsemblePredictor] = {}
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
        log.info("ensemble registered (%s)", ", ".join(members))

    @property
    def names(self) -> list[str]:
        return list(self._predictors)

    def get(self, name: str) -> Predictor | GBMPredictor | EnsemblePredictor | None:
        return self._predictors.get(name)

    def metrics(self, name: str) -> dict:
        return self._predictors[name].metrics

    def evaluation(self, name: str) -> dict:
        return json.loads((self.artifacts_dir / name / "evaluation.json").read_text())

    @staticmethod
    def display_name(name: str) -> str:
        return DISPLAY_NAMES.get(name, name)


@lru_cache
def get_registry() -> ModelRegistry:
    return ModelRegistry(get_settings().artifacts_dir)
