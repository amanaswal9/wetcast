"""LightGBM forecaster: python -m weatherai_ml.gbm [--region north_india|india]

Gradient-boosted trees work on tables, not sequences, so each forecast issued
at hour t becomes 24 rows, one per hour ahead h, built by `build_matrix`:

  - the 42 model features at t (raw physical units; trees don't need scaling),
  - recent history of the city centre (temperature, humidity, rain, pressure,
    cloud and wind 1, 3, 6, 12 and 24 hours before t),
  - h itself and the hour of day being predicted,
  - the observed value 24 hours before the predicted hour.

Like the version 2 neural networks, temperature and humidity are predicted as
the change from the same hour the day before. Rain is predicted directly in mm
with a Tweedie loss (since 2026-11-21; it gives the expected amount, where the
older squared error on log1p(mm) pulled amounts towards dry). Older artifacts
say "log1p" in gbm_config.json and keep working. One model per target,
early-stopped on the validation year. `--only precipitation` retrains just the
rain model and keeps the other targets' trees.
`build_matrix` is used unchanged by training and by live inference.
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
from .config import FEATURE_ORDER, HORIZON_HOURS, LOOKBACK_HOURS, REGION_NAMES, SEED, SPLITS, TARGETS, artifacts_dir, raw_dir

GBM_NAME = "lightgbm"
H = HORIZON_HOURS
LAGS = (1, 3, 6, 12, 24)
LAG_VARS = ("c_temp", "c_rh", "c_precip_log1p", "c_pressure", "c_cloud", "c_wind_u", "c_wind_v")
TI, HI, PI = TARGETS.index("temperature"), TARGETS.index("humidity"), TARGETS.index("precipitation")
_IDX = {name: i for i, name in enumerate(FEATURE_ORDER)}

PARAMS = {
    "objective": "regression",
    "learning_rate": 0.05,
    "num_leaves": 63,
    "min_data_in_leaf": 200,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
    "seed": SEED,
    "verbose": -1,
    "num_threads": 0,
}


# Rain: chosen on the 2025 validation year among squared error on log1p(mm) (R² 0.127), Tweedie 1.3 (0.146),
# Tweedie 1.5 (0.142) and squared error on mm (0.144).
RAIN_TARGET = "mm_tweedie"
RAIN_PARAMS = {"objective": "tweedie", "tweedie_variance_power": 1.3}


def feature_names() -> list[str]:
    lags = [f"{v}_lag{lag}" for v in LAG_VARS for lag in LAGS]
    extra = ["hours_ahead", "target_hour_sin", "target_hour_cos", "prev_temperature", "prev_humidity", "prev_precipitation"]
    return list(FEATURE_ORDER) + lags + extra


def build_matrix(F: np.ndarray, hour_of_t: np.ndarray, ends: np.ndarray, prev: np.ndarray) -> np.ndarray:
    """Rows for every (forecast, hour ahead) pair.

    F: (rows, 42) physical features in FEATURE_ORDER. hour_of_t: (n,) UTC hour at each t.
    ends: (n,) row index of t in F. prev: (n, H, 3) observed targets 24 h before each predicted hour.
    Returns (n * H, n_features) float32, ordered forecast-major.
    """
    n = len(ends)
    base = F[ends].astype(np.float32)  # (n, 42)
    lags = np.stack([F[ends - lag, _IDX[v]] for v in LAG_VARS for lag in LAGS], axis=1).astype(np.float32)  # (n, 35)
    per_forecast = np.concatenate([base, lags], axis=1)
    per_forecast = np.repeat(per_forecast[:, None, :], H, axis=1)  # (n, H, 77)
    h = np.arange(1, H + 1, dtype=np.float32)[None, :].repeat(n, axis=0)  # (n, H)
    target_hour = (hour_of_t[:, None] + h) % 24
    extra = np.stack(
        [
            h,
            np.sin(2 * np.pi * target_hour / 24),
            np.cos(2 * np.pi * target_hour / 24),
            prev[..., TI],
            prev[..., HI],
            prev[..., PI],
        ],
        axis=2,
    ).astype(np.float32)
    return np.concatenate([per_forecast, extra], axis=2).reshape(n * H, -1)


def training_targets(y: np.ndarray, prev: np.ndarray, rain_target: str = RAIN_TARGET) -> np.ndarray:
    """(n, H, 3) physical targets -> what the trees learn: changes for temp/RH; rain in mm, or log1p(mm)
    for older models (rain_target "log1p")."""
    out = np.empty_like(y, dtype=np.float64)
    out[..., TI] = y[..., TI] - prev[..., TI]
    out[..., HI] = y[..., HI] - prev[..., HI]
    rain = np.clip(y[..., PI], 0, None)
    out[..., PI] = np.log1p(rain) if rain_target == "log1p" else rain
    return out


def to_physical(raw: np.ndarray, prev: np.ndarray, rain_target: str = RAIN_TARGET) -> np.ndarray:
    """Inverse of training_targets, with physical limits."""
    out = np.empty_like(raw, dtype=np.float64)
    out[..., TI] = raw[..., TI] + prev[..., TI]
    out[..., HI] = np.clip(raw[..., HI] + prev[..., HI], 0, 100)
    out[..., PI] = np.clip(np.expm1(raw[..., PI]) if rain_target == "log1p" else raw[..., PI], 0, None)
    return out


@dataclass
class GBMForecaster:
    folder: Path

    def __post_init__(self):
        import lightgbm as lgb

        self.config = json.loads((self.folder / "gbm_config.json").read_text())
        if self.config["feature_names"] != feature_names():
            from .preprocess import FeatureOrderError

            raise FeatureOrderError(f"{self.folder} was trained with different LightGBM features than this code.")
        self.boosters = {t: lgb.Booster(model_file=str(self.folder / f"model_{t}.txt")) for t in TARGETS}

    @property
    def lookback(self) -> int:
        return int(self.config["lookback_hours"])

    @property
    def rain_target(self) -> str:
        return self.config.get("rain_target", "log1p")  # artifacts from before the Tweedie rain model

    def predict_matrix(self, X: np.ndarray, prev: np.ndarray) -> np.ndarray:
        n = prev.shape[0]
        raw = np.stack([self.boosters[t].predict(X, num_threads=0).reshape(n, H) for t in TARGETS], axis=2)
        return to_physical(raw, prev, self.rain_target)

    def predict_ends(self, ds, ends: np.ndarray) -> np.ndarray:
        prev = ds.targets[ends[:, None] + np.arange(1, H + 1)[None, :] - 24]
        X = build_matrix(ds.features, ds.times[ends].hour.to_numpy(), ends, prev)
        return self.predict_matrix(X, prev)


def main() -> None:
    import lightgbm as lgb

    from .dataset import load_dataset, residual_targets, window_ends
    from .preprocess import RESIDUAL_INDICES
    from .train import REGION_LABELS, evaluate, future_index

    parser = argparse.ArgumentParser()
    parser.add_argument("--region", choices=REGION_NAMES, default="north_india")
    parser.add_argument("--train-stride", type=int, default=4)
    parser.add_argument("--only", nargs="+", choices=TARGETS, help="retrain these targets, keep the others' saved trees")
    args = parser.parse_args()
    out = artifacts_dir(args.region) / GBM_NAME
    previous = {}
    if args.only:
        previous = {"config": json.loads((out / "gbm_config.json").read_text()), "metrics": json.loads((out / "metrics.json").read_text())}
        if previous["config"]["feature_names"] != feature_names():
            raise SystemExit("The saved LightGBM model uses different features; retrain all targets.")
    retrain = list(args.only or TARGETS)

    ds = load_dataset(args.region)
    train_cities = ds.city_indices("train")
    # Same valid windows as the residual neural networks, so the comparison is like for like.
    extra_bad = np.isnan(residual_targets(ds, RESIDUAL_INDICES)).any(axis=1)
    L = LOOKBACK_HOURS

    def matrices(ends):
        prev = ds.targets[future_index(ends) - 24]
        X = build_matrix(ds.features, ds.times[ends].hour.to_numpy(), ends, prev)
        Y = training_targets(ds.targets[future_index(ends)], prev).reshape(len(ends) * H, len(TARGETS))  # rain in mm
        return X, Y

    train_ends = window_ends(ds, "train", stride=args.train_stride, lookback=L, extra_bad=extra_bad, cities=train_cities)
    val_ends = window_ends(ds, "val", stride=6, lookback=L, extra_bad=extra_bad, cities=train_cities)
    Xtr, Ytr = matrices(train_ends)
    Xva, Yva = matrices(val_ends)
    names = feature_names()
    print(f"train rows {len(Xtr):,} | validation rows {len(Xva):,} | features {len(names)}")

    out.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    rounds = dict(previous.get("metrics", {}).get("trees", {}))
    importance = dict(previous.get("metrics", {}).get("feature_importance", {}))
    for k, target in enumerate(TARGETS):
        if target not in retrain:
            continue
        dtrain = lgb.Dataset(Xtr, Ytr[:, k], feature_name=names, free_raw_data=False)
        dval = lgb.Dataset(Xva, Yva[:, k], reference=dtrain)
        booster = lgb.train(
            {**PARAMS, **(RAIN_PARAMS if target == "precipitation" else {})},
            dtrain,
            num_boost_round=3000,
            valid_sets=[dval],
            callbacks=[lgb.early_stopping(100, verbose=False), lgb.log_evaluation(0)],
        )
        booster.save_model(str(out / f"model_{target}.txt"), num_iteration=booster.best_iteration)
        rounds[target] = int(booster.best_iteration)
        gain = booster.feature_importance("gain", iteration=booster.best_iteration)
        top = np.argsort(gain)[::-1][:10]
        importance[target] = [{"feature": names[i], "share": round(float(gain[i] / gain.sum()), 4)} for i in top]
        print(f"  {target}: {rounds[target]} trees")
    train_seconds = time.perf_counter() - started

    rain_target = RAIN_TARGET if "precipitation" in retrain else previous["config"].get("rain_target", "log1p")
    config = {"feature_names": names, "lookback_hours": L, "target_mode": "residual24", "lags": list(LAGS), "params": PARAMS,
              "rain_target": rain_target, "rain_params": RAIN_PARAMS if rain_target == RAIN_TARGET else None}
    (out / "gbm_config.json").write_text(json.dumps(config, indent=2))
    forecaster = GBMForecaster(out)

    def timing(ends):
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
            "cpu": platform.processor() or platform.machine(),
        }

    print("Evaluating…")
    metrics, evaluation = evaluate(GBM_NAME, lambda ends: forecaster.predict_ends(ds, ends), timing, L, ds, extra_bad, out, "LightGBM")
    manifest = json.loads((raw_dir(args.region) / "manifest.json").read_text())
    metrics.update(
        {
            "kind": "gbm",
            "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "pipeline_version": PIPELINE_VERSION,
            "framework": {"lightgbm": lgb.__version__},
            "parameters": int(sum(rounds.values())),
            "trees": rounds,
            "feature_importance": importance,
            "config": {"lookback_hours": L, "target_mode": "residual24", "loss": "mse", "train_stride_hours": args.train_stride,
                       "rain_loss": "tweedie 1.3 on mm" if rain_target == RAIN_TARGET else "mse on log1p(mm)",
                       "retrained_targets": retrain},
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
        f"LightGBM test: temp MAE {t['temperature']['mae']:.3f} °C, RH MAE {t['humidity']['mae']:.3f} %, "
        f"rain MAE {t['precipitation']['mae']:.4f} mm (train {train_seconds:.0f} s)"
    )


if __name__ == "__main__":
    main()
