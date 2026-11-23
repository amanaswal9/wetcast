"""Build and evaluate the ensemble: python -m weatherai_ml.ensemble [--region north_india|india]

The ensemble is the plain average of member predictions (in physical units).
Equal weights are deliberate: there is nothing to tune, so nothing can be
fitted to the test set.

Which members to include is decided on the validation year only, between
candidate sets fixed in advance: the three recurrent networks, plus every
combination of the later additions that are trained (LightGBM; the
ST-Transformer, added 2026-11-20 before its test results were seen). The score is the mean, over temperature,
humidity and rain, of validation MAE divided by the persistence baseline's MAE.
The chosen ensemble is then evaluated by exactly the same code as the single
models (train.evaluate).

Writes ml/artifacts/[region/]ensemble/: ensemble.json (members), metrics.json, evaluation.json.
"""

from __future__ import annotations

import argparse
import json
import platform
import time
from datetime import datetime, timezone

import keras
import numpy as np
import tensorflow as tf

from . import PIPELINE_VERSION
from .config import FEATURE_ORDER, HORIZON_HOURS, REGION_NAMES, SPLITS, TARGETS, artifacts_dir, raw_dir
from .dataset import load_dataset, residual_targets, window_ends
from .gbm import GBM_NAME, GBMForecaster
from .models import DISPLAY_NAMES, ENSEMBLE_NAME, MODEL_NAMES, RNN_NAMES, TRANSFORMER_NAME
from .preprocess import RESIDUAL_INDICES, Preprocessor
from .train import REGION_LABELS, evaluate, predict, split_metrics


class Member:
    """One trained model loaded for ensemble selection: a Keras network or the LightGBM forecaster."""

    def __init__(self, name: str, root, ds):
        self.name = name
        folder = root / name
        self.metrics = json.loads((folder / "metrics.json").read_text())
        if name == GBM_NAME:
            self.gbm = GBMForecaster(folder)
            self.lookback = self.gbm.lookback
            self.target_mode = "residual24"
        else:
            self.pre = Preprocessor.load(folder / "preprocessor.json")
            self.model = keras.saving.load_model(folder / "model.keras", compile=False)
            self.X = np.nan_to_num(self.pre.transform_features(ds.features), nan=0.0)
            self.lookback = self.pre.lookback
            self.target_mode = self.pre.target_mode
        self.ds = ds

    def predict_ends(self, ends: np.ndarray) -> np.ndarray:
        """Forecasts in physical units for the windows ending at the given rows."""
        if self.name == GBM_NAME:
            return self.gbm.predict_ends(self.ds, ends)
        return predict(self.model, self.pre, self.ds, self.X, ends)

    def forecast_once(self, end: int) -> None:
        """Run a single forecast and throw it away; used only to time the model."""
        if self.name == GBM_NAME:
            self.gbm.predict_ends(self.ds, np.array([end]))
        else:
            self.model(self.X[end - self.lookback + 1 : end + 1][None, ...], training=False)


def selection_score(metrics: dict, baseline: dict) -> float:
    """Mean over the targets of MAE relative to persistence. Lower is better; below 1 beats persistence."""
    return float(np.mean([metrics[t]["mae"] / baseline[t]["mae"] for t in TARGETS]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", choices=REGION_NAMES, default="north_india")
    args = parser.parse_args()

    root = artifacts_dir(args.region)
    ds = load_dataset(args.region)
    available = [n for n in MODEL_NAMES if (root / n / "model.keras").exists()]
    if (root / GBM_NAME / "gbm_config.json").exists():
        available.append(GBM_NAME)
    members = {n: Member(n, root, ds) for n in available}
    base = [n for n in RNN_NAMES if n in members]
    extras = [n for n in (GBM_NAME, TRANSFORMER_NAME) if n in members]
    # The recurrent networks always, plus every subset of the extras (each bit of `mask` picks one).
    candidates = [base + [e for i, e in enumerate(extras) if mask >> i & 1] for mask in range(1 << len(extras))]

    extra_bad = np.zeros(len(ds.times), dtype=bool)
    if any(m.target_mode == "residual24" for m in members.values()):
        extra_bad |= np.isnan(residual_targets(ds, RESIDUAL_INDICES)).any(axis=1)
    lookback = max(m.lookback for m in members.values())

    # Choose the members on the validation year only, never on the test period.
    val_ends = window_ends(ds, "val", lookback=lookback, extra_bad=extra_bad, cities=ds.city_indices("train"))
    val_preds = {n: m.predict_ends(val_ends) for n, m in members.items()}
    selection = []
    for names in candidates:
        val_metrics, val_base = split_metrics(ds, val_ends, np.mean([val_preds[n] for n in names], axis=0))
        score = selection_score(val_metrics, val_base)
        selection.append({"members": names, "validation_score": round(score, 4),
                          "validation_mae": {t: round(val_metrics[t]["mae"], 4) for t in TARGETS}})
        print(f"candidate {'+'.join(names)}: validation score {score:.4f}")
    chosen = min(selection, key=lambda s: s["validation_score"])["members"]
    print(f"chosen on validation: {', '.join(chosen)}")
    team = [members[n] for n in chosen]

    def predict_ends(ends: np.ndarray) -> np.ndarray:
        return np.mean([m.predict_ends(ends) for m in team], axis=0)

    def timing(ends: np.ndarray) -> dict:
        end = int(ends[0])
        for m in team:
            m.forecast_once(end)
        runs = []
        for _ in range(30):
            start = time.perf_counter()
            for m in team:
                m.forecast_once(end)
            runs.append((time.perf_counter() - start) * 1000)
        return {
            "single_ms_median": float(np.median(runs)),
            "batch256_ms_per_forecast": float(sum(m.metrics["inference"]["batch256_ms_per_forecast"] for m in team)),
            "device": "CPU",
            "cpu": platform.processor() or platform.machine(),
        }

    out = root / ENSEMBLE_NAME
    out.mkdir(parents=True, exist_ok=True)
    print("Evaluating…")
    started = time.perf_counter()
    metrics, evaluation = evaluate(ENSEMBLE_NAME, predict_ends, timing, lookback, ds, extra_bad, out, DISPLAY_NAMES[ENSEMBLE_NAME])
    first = team[0].metrics
    manifest = json.loads((raw_dir(args.region) / "manifest.json").read_text())
    metrics.update(
        {
            "kind": "ensemble",
            "members": chosen,
            "method": "equal-weight mean of member predictions",
            "member_selection": {
                "rule": "lowest mean of validation MAE / persistence MAE over the three targets",
                "candidates": selection,
            },
            "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "pipeline_version": PIPELINE_VERSION,
            "framework": {"tensorflow": tf.__version__, "keras": keras.__version__},
            "parameters": int(sum(m.metrics["parameters"] for m in team)),
            "config": first.get("config"),
            "training": {
                "epochs_run": None,
                "best_epoch": None,
                "best_val_loss": None,
                "seconds": round(time.perf_counter() - started, 1),
                "note": "no training of its own; averages the members",
            },
            "data": first["data"] | {
                "region": REGION_LABELS[args.region],
                "region_id": args.region,
                "splits": SPLITS,
                "lookback_hours": lookback,
                "horizon_hours": HORIZON_HOURS,
                "n_features": len(FEATURE_ORDER),
                "targets": list(TARGETS),
                "cities": [
                    {"id": c.id, "name": c.name, "state": c.state, "role": c.role, "latitude": c.latitude,
                     "longitude": c.longitude, "elevation_m": manifest[c.id]["elevation_m"]}
                    for c in ds.cities
                ],
            },
        }
    )
    (out / "ensemble.json").write_text(json.dumps({"members": chosen, "method": "mean"}, indent=2))
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2))
    (out / "evaluation.json").write_text(json.dumps(evaluation))
    t = metrics["test"]
    print(f"Ensemble test: temp MAE {t['temperature']['mae']:.3f} °C, RH MAE {t['humidity']['mae']:.3f} %, rain MAE {t['precipitation']['mae']:.4f} mm")


if __name__ == "__main__":
    main()
