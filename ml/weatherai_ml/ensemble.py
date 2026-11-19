"""Build and evaluate the ensemble: python -m weatherai_ml.ensemble [--region north_india|india]

The ensemble is the plain average of the trained LSTM, GRU and CNN-LSTM
predictions (in physical units). Equal weights are deliberate: there is
nothing to tune, so nothing can be fitted to the test set. It is evaluated
by exactly the same code as the single models (train.evaluate): same
windows, same baseline, its own validation-calibrated error ranges and
the same station check.

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
from .dataset import load_dataset, residual_targets
from .models import DISPLAY_NAMES, ENSEMBLE_NAME, MODEL_NAMES
from .preprocess import RESIDUAL_INDICES, Preprocessor
from .train import REGION_LABELS, evaluate, predict


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", choices=REGION_NAMES, default="north_india")
    parser.add_argument("--members", nargs="+", default=list(MODEL_NAMES), choices=MODEL_NAMES)
    args = parser.parse_args()

    root = artifacts_dir(args.region)
    members = []
    for name in args.members:
        folder = root / name
        pre = Preprocessor.load(folder / "preprocessor.json")
        model = keras.saving.load_model(folder / "model.keras", compile=False)
        members.append((name, model, pre, json.loads((folder / "metrics.json").read_text())))
    lookbacks = {pre.lookback for _, _, pre, _ in members}
    modes = {pre.target_mode for _, _, pre, _ in members}
    print(f"members: {', '.join(n for n, *_ in members)} | lookbacks {lookbacks} | target modes {modes}")

    ds = load_dataset(args.region)
    # Windows must be valid for every member, so take the union of their invalid rows.
    extra_bad = np.zeros(len(ds.times), dtype=bool)
    if "residual24" in modes:
        extra_bad |= np.isnan(residual_targets(ds, RESIDUAL_INDICES)).any(axis=1)
    inputs = [np.nan_to_num(pre.transform_features(ds.features), nan=0.0) for _, _, pre, _ in members]
    lookback = max(lookbacks)

    def predict_ends(ends: np.ndarray) -> np.ndarray:
        preds = [predict(model, pre, ds, X, ends) for (_, model, pre, _), X in zip(members, inputs)]
        return np.mean(preds, axis=0)

    def timing(ends: np.ndarray) -> dict:
        # One forecast = one call to each member, as the API does it.
        windows = [X[ends[0] - pre.lookback + 1 : ends[0] + 1][None, ...] for (_, _, pre, _), X in zip(members, inputs)]
        for (_, model, _, _), w in zip(members, windows):
            model(w, training=False)
        runs = []
        for _ in range(30):
            start = time.perf_counter()
            for (_, model, _, _), w in zip(members, windows):
                model(w, training=False)
            runs.append((time.perf_counter() - start) * 1000)
        per_member_batch = sum(m["inference"]["batch256_ms_per_forecast"] for *_, m in members)
        return {
            "single_ms_median": float(np.median(runs)),
            "batch256_ms_per_forecast": float(per_member_batch),
            "device": "CPU",
            "cpu": platform.processor() or platform.machine(),
        }

    out = root / ENSEMBLE_NAME
    out.mkdir(parents=True, exist_ok=True)
    print("Evaluating…")
    started = time.perf_counter()
    metrics, evaluation = evaluate(ENSEMBLE_NAME, predict_ends, timing, lookback, ds, extra_bad, out, DISPLAY_NAMES[ENSEMBLE_NAME])
    first = members[0][3]
    manifest = json.loads((raw_dir(args.region) / "manifest.json").read_text())
    metrics.update(
        {
            "kind": "ensemble",
            "members": [n for n, *_ in members],
            "method": "equal-weight mean of member predictions",
            "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "pipeline_version": PIPELINE_VERSION,
            "framework": {"tensorflow": tf.__version__, "keras": keras.__version__},
            "parameters": int(sum(m["parameters"] for *_, m in members)),
            "config": first.get("config"),
            "training": {
                "epochs_run": None,
                "best_epoch": None,
                "best_val_loss": None,
                "seconds": round(time.perf_counter() - started, 1),
                "note": "no training of its own; averages the members",
            },
            "data": {
                **first["data"],
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
    (out / "ensemble.json").write_text(json.dumps({"members": metrics["members"], "method": "mean"}, indent=2))
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2))
    (out / "evaluation.json").write_text(json.dumps(evaluation))
    t = metrics["test"]
    print(
        f"Ensemble test: temp MAE {t['temperature']['mae']:.3f} °C, RH MAE {t['humidity']['mae']:.3f} %, "
        f"rain MAE {t['precipitation']['mae']:.4f} mm"
    )
    for name, *_, m in members:
        mt = m["test"]
        print(f"  {DISPLAY_NAMES[name]:8s} test: temp {mt['temperature']['mae']:.3f}, RH {mt['humidity']['mae']:.3f}, rain {mt['precipitation']['mae']:.4f}")


if __name__ == "__main__":
    main()
