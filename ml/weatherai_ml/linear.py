"""Ridge regression, a linear baseline (scikit-learn): python -m weatherai_ml.linear [--region north_india|india]

A linear model on exactly the table LightGBM uses (`gbm.build_matrix`): the 42 features at the issue
hour, the city centre's recent history, the hour ahead, and the same hour the day before. It learns the
same targets: temperature and humidity as the change from the same hour yesterday, rain in mm. Its job
is to show how much the non-linear models add over a straight line through the same inputs.

Training uses scikit-learn: StandardScaler, then Ridge, one model per target. The penalty (alpha) for
each target is chosen on the 2025 validation year from a fixed list, by mean absolute error for
temperature and humidity and by R² for rain (the same rule LightGBM's rain loss was chosen by). The test
year is only used by `train.evaluate`, after every choice is made.

The model is saved as plain numbers in linear.json (feature means and scales, weights and intercepts),
not as a pickle file: loading it runs no code, and serving it needs only NumPy.
"""

from __future__ import annotations

import argparse
import json
import platform
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import PIPELINE_VERSION
from .config import FEATURE_ORDER, HORIZON_HOURS, LOOKBACK_HOURS, REGION_NAMES, SPLITS, TARGETS, artifacts_dir, raw_dir
from .gbm import build_matrix, feature_names, to_physical, training_targets

LINEAR_NAME = "ridge"
H = HORIZON_HOURS
ALPHAS = (0.1, 1.0, 10.0, 100.0, 1000.0)
RAIN_TARGET = "mm"
CHUNK = 20_000  # forecasts per batch when predicting, so the table never needs gigabytes at once


@dataclass
class LinearForecaster:
    """The saved Ridge weights (one set per target), loaded from `folder` without scikit-learn."""

    folder: Path

    def __post_init__(self):
        self.config = json.loads((self.folder / "linear.json").read_text())
        if self.config["feature_names"] != feature_names():
            from .preprocess import FeatureOrderError

            raise FeatureOrderError(f"{self.folder} was trained with different features than this code.")
        self.mean = np.asarray(self.config["mean"], dtype=np.float64)
        self.scale = np.asarray(self.config["scale"], dtype=np.float64)
        self.weights = np.asarray([self.config["targets"][t]["coef"] for t in TARGETS], dtype=np.float64).T  # (features, 3)
        self.intercepts = np.asarray([self.config["targets"][t]["intercept"] for t in TARGETS], dtype=np.float64)

    @property
    def lookback(self) -> int:
        """Hours of history the features reach back (the longest lag)."""
        return int(self.config["lookback_hours"])

    def predict_matrix(self, X: np.ndarray, prev: np.ndarray) -> np.ndarray:
        """(n, H, 3) forecasts in physical units from a `build_matrix` matrix and its `prev` values."""
        n = prev.shape[0]
        raw = ((X.astype(np.float64) - self.mean) / self.scale) @ self.weights + self.intercepts
        return to_physical(raw.reshape(n, H, len(TARGETS)), prev, RAIN_TARGET)

    def predict_ends(self, ds, ends: np.ndarray) -> np.ndarray:
        """Forecasts for the windows ending at rows `ends` of a loaded dataset, in batches."""
        out = []
        for start in range(0, len(ends), CHUNK):
            part = ends[start : start + CHUNK]
            prev = ds.targets[part[:, None] + np.arange(1, H + 1)[None, :] - 24]
            X = build_matrix(ds.features, ds.times[part].hour.to_numpy(), part, prev)
            out.append(self.predict_matrix(X, prev))
        return np.concatenate(out) if out else np.empty((0, H, len(TARGETS)))


def main() -> None:
    # Imported here so that serving, which only needs LinearForecaster, never loads scikit-learn.
    import sklearn
    from sklearn.linear_model import Ridge
    from sklearn.metrics import mean_absolute_error, r2_score
    from sklearn.preprocessing import StandardScaler

    from .dataset import load_dataset, residual_targets, window_ends
    from .preprocess import RESIDUAL_INDICES
    from .train import REGION_LABELS, evaluate, future_index

    parser = argparse.ArgumentParser()
    parser.add_argument("--region", choices=REGION_NAMES, default="north_india")
    parser.add_argument("--train-stride", type=int, default=12, help="hours between training windows")
    args = parser.parse_args()
    out = artifacts_dir(args.region) / LINEAR_NAME

    ds = load_dataset(args.region)
    train_cities = ds.city_indices("train")
    # Same valid windows as LightGBM and the residual networks, so the comparison is like for like.
    extra_bad = np.isnan(residual_targets(ds, RESIDUAL_INDICES)).any(axis=1)
    L = LOOKBACK_HOURS

    def matrices(ends):
        """Table rows and targets for the windows ending at `ends`, without rows that have gaps."""
        prev = ds.targets[future_index(ends) - 24]
        X = build_matrix(ds.features, ds.times[ends].hour.to_numpy(), ends, prev)
        Y = training_targets(ds.targets[future_index(ends)], prev, RAIN_TARGET).reshape(len(ends) * H, len(TARGETS))
        keep = np.isfinite(X).all(axis=1) & np.isfinite(Y).all(axis=1)
        return X[keep], Y[keep], int((~keep).sum())

    train_ends = window_ends(ds, "train", stride=args.train_stride, lookback=L, extra_bad=extra_bad, cities=train_cities)
    val_ends = window_ends(ds, "val", stride=6, lookback=L, extra_bad=extra_bad, cities=train_cities)
    Xtr, Ytr, dropped_tr = matrices(train_ends)
    Xva, Yva, dropped_va = matrices(val_ends)
    names = feature_names()
    print(f"train rows {len(Xtr):,} ({dropped_tr} with gaps left out) | validation rows {len(Xva):,} | features {len(names)}")

    started = time.perf_counter()
    scaler = StandardScaler(copy=False).fit(Xtr)
    scaler.scale_[scaler.scale_ == 0] = 1.0  # a constant column (never in practice) must not divide by zero
    Xtr = scaler.transform(Xtr)
    Xva_scaled = scaler.transform(Xva.copy())
    targets, choice = {}, {}
    for k, target in enumerate(TARGETS):
        scores = {}
        for alpha in ALPHAS:
            model = Ridge(alpha=alpha).fit(Xtr, Ytr[:, k])
            pred = model.predict(Xva_scaled)
            if target == "precipitation":
                scores[alpha] = (r2_score(Yva[:, k], np.clip(pred, 0, None)), model)  # higher is better
            else:
                scores[alpha] = (-mean_absolute_error(Yva[:, k], pred), model)  # negated, so higher is better
        best = max(scores, key=lambda a: scores[a][0])
        model = scores[best][1]
        targets[target] = {"alpha": best, "coef": [float(c) for c in model.coef_], "intercept": float(model.intercept_)}
        choice[target] = {str(a): round(float(s), 5) for a, (s, _) in scores.items()}
        print(f"  {target}: alpha {best} (validation scores by alpha: {choice[target]})")
    train_seconds = time.perf_counter() - started

    out.mkdir(parents=True, exist_ok=True)
    config = {
        "feature_names": names, "lookback_hours": L, "target_mode": "residual24", "rain_target": RAIN_TARGET,
        "mean": [float(m) for m in scaler.mean_], "scale": [float(s) for s in scaler.scale_], "targets": targets,
    }
    (out / "linear.json").write_text(json.dumps(config))
    forecaster = LinearForecaster(out)

    def timing(ends):
        """Median time of a single forecast, and the time per forecast in a batch of 256."""
        one = ends[:1]
        forecaster.predict_ends(ds, one)
        runs = []
        for _ in range(30):
            start = time.perf_counter()
            forecaster.predict_ends(ds, one)
            runs.append((time.perf_counter() - start) * 1000)
        batch = ends[:256]
        start = time.perf_counter()
        forecaster.predict_ends(ds, batch)
        return {
            "single_ms_median": float(np.median(runs)),
            "batch256_ms_per_forecast": (time.perf_counter() - start) * 1000 / len(batch),
            "device": "CPU",
            "cpu": platform.machine(),  # the architecture only, not the exact processor
        }

    print("Evaluating…")
    metrics, evaluation = evaluate(LINEAR_NAME, lambda ends: forecaster.predict_ends(ds, ends), timing, L, ds, extra_bad, out)
    manifest = json.loads((raw_dir(args.region) / "manifest.json").read_text())
    metrics.update(
        {
            "kind": "linear",
            "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "pipeline_version": PIPELINE_VERSION,
            "framework": {"scikit-learn": sklearn.__version__},
            "parameters": int(len(TARGETS) * (len(names) + 1)),
            "alphas": {t: targets[t]["alpha"] for t in TARGETS},
            "alpha_choice": {"rule": "validation MAE (temperature, humidity), validation R² (rain)", "scores": choice},
            "config": {"lookback_hours": L, "target_mode": "residual24", "loss": "ridge (squared error + L2)",
                       "train_stride_hours": args.train_stride, "rain_target": "mm"},
            "training": {
                "epochs_run": None,
                "best_epoch": None,
                "best_val_loss": None,
                "seconds": round(train_seconds, 1),
                "train_windows": int(len(train_ends)),
                "train_stride_hours": args.train_stride,
            },
            "data": {
                "source": "Open-Meteo Historical Forecast API (best_match), hourly",
                "region": REGION_LABELS[args.region],
                "region_id": args.region,
                "cities": [
                    {"id": c.id, "name": c.name, "state": c.state, "role": c.role, "latitude": c.latitude,
                     "longitude": c.longitude, "elevation_m": manifest[c.id]["elevation_m"]}
                    for c in ds.cities
                ],
                "splits": SPLITS,
                "lookback_hours": L,
                "horizon_hours": H,
                "n_features": len(FEATURE_ORDER),
                "targets": list(TARGETS),
            },
        }
    )
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2))
    (out / "evaluation.json").write_text(json.dumps(evaluation))
    t = metrics["test"]
    print(
        f"Ridge test: temp MAE {t['temperature']['mae']:.3f} °C, RH MAE {t['humidity']['mae']:.3f} %, "
        f"rain MAE {t['precipitation']['mae']:.4f} mm (train {train_seconds:.0f} s)"
    )


if __name__ == "__main__":
    main()
