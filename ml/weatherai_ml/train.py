"""Train and evaluate the models.

Final training (writes ml/artifacts/<model>/ and evaluates on the test set):
    python -m weatherai_ml.train --models lstm gru cnn_lstm [--target-mode residual24 --lookback 72 ...]

Experiments (validation set ONLY; the test set is never touched, nothing is saved as an artifact):
    python -m weatherai_ml.train --experiment NAME --models cnn_lstm --target-mode residual24

Artifacts per model:
  model.keras         trained weights
  preprocessor.json   fitted scaler, exact feature order, lookback and target mode (training rows only)
  metrics.json        test-set metrics, persistence baseline, error ranges, timing, station check
  evaluation.json     per-horizon and per-city errors plus actual-vs-predicted samples
  history.json        training curves
"""

from __future__ import annotations

import argparse
import json
import platform
import time
from datetime import datetime, timezone
from pathlib import Path

import keras
import numpy as np
import tensorflow as tf

from . import PIPELINE_VERSION
from .config import (
    FEATURE_ORDER,
    HORIZON_HOURS,
    INTERVAL_LEVEL,
    LOOKBACK_HOURS,
    ML_ROOT,
    REGION_NAMES,
    SEED,
    SPLITS,
    TARGET_UNITS,
    TARGETS,
    artifacts_dir,
    raw_dir,
)

REGION_LABELS = {"north_india": "North India", "india": "India"}
from .dataset import Dataset, load_dataset, residual_targets, split_rows, window_ends
from .metrics import conformal_halfwidth, mae, summary
from .models import DISPLAY_NAMES, MODEL_NAMES, TRANSFORMER_DEFAULTS, TRANSFORMER_NAME, build_model
from .preprocess import RESIDUAL_INDICES, Preprocessor
from .stations import station_check

H = HORIZON_HOURS
SAMPLE_DAYS = 14
EXPERIMENTS_DIR = ML_ROOT / "experiments"


def windows(X: np.ndarray, ends: np.ndarray, Y: np.ndarray | None, lookback: int, batch: int, shuffle: bool) -> tf.data.Dataset:
    Xt = tf.constant(X)
    Yt = tf.constant(Y) if Y is not None else None

    def take(t):
        x = Xt[t - lookback + 1 : t + 1]
        return (x, Yt[t + 1 : t + 1 + H]) if Yt is not None else x

    ds = tf.data.Dataset.from_tensor_slices(ends.astype(np.int64))
    if shuffle:
        ds = ds.shuffle(len(ends), seed=SEED, reshuffle_each_iteration=True)
    return ds.map(take, num_parallel_calls=tf.data.AUTOTUNE).batch(batch).prefetch(tf.data.AUTOTUNE)


def future_index(ends: np.ndarray) -> np.ndarray:
    return ends[:, None] + np.arange(1, H + 1)[None, :]


def predict(model: keras.Model, pre: Preprocessor, ds: Dataset, X: np.ndarray, ends: np.ndarray) -> np.ndarray:
    scaled = model.predict(windows(X, ends, None, pre.lookback, 1024, False), verbose=0)
    # The same hour on the previous day lies inside the input window, so this uses no future data.
    yesterday = ds.targets[future_index(ends) - 24]
    return pre.inverse_targets(scaled, yesterday)


def inference_timing(model: keras.Model, X: np.ndarray, ends: np.ndarray, lookback: int) -> dict[str, float]:
    one = X[ends[0] - lookback + 1 : ends[0] + 1][None, ...]
    batch = np.stack([X[e - lookback + 1 : e + 1] for e in ends[:256]])
    model(one, training=False)
    model(batch, training=False)
    singles = []
    for _ in range(50):
        start = time.perf_counter()
        model(one, training=False)
        singles.append((time.perf_counter() - start) * 1000)
    batched = []
    for _ in range(10):
        start = time.perf_counter()
        model(batch, training=False)
        batched.append((time.perf_counter() - start) * 1000 / len(batch))
    return {
        "single_ms_median": float(np.median(singles)),
        "batch256_ms_per_forecast": float(np.median(batched)),
        "device": "CPU",
        "cpu": platform.processor() or platform.machine(),
    }


def samples_for_analytics(ds: Dataset, ends: np.ndarray, pred: np.ndarray) -> dict:
    """Last SAMPLE_DAYS of the test period per city: actual vs prediction issued 6 h and 24 h earlier."""
    position = {int(e): i for i, e in enumerate(ends)}
    test_mask = split_rows(ds, "test")
    out = {}
    for c, city in enumerate(ds.cities):
        rows = np.where((ds.city_of_row == c) & test_mask)[0][-SAMPLE_DAYS * 24 :]
        series: dict[str, list] = {"time": [ds.times[r].strftime("%Y-%m-%dT%H:%MZ") for r in rows], "role": city.role}
        for k, target in enumerate(TARGETS):
            series[f"{target}_actual"] = [None if np.isnan(ds.targets[r, k]) else round(float(ds.targets[r, k]), 2) for r in rows]
            for lead in (6, 24):
                vals = []
                for r in rows:
                    i = position.get(int(r - lead))
                    vals.append(None if i is None else round(float(pred[i, lead - 1, k]), 2))
                series[f"{target}_lead{lead}"] = vals
        out[city.id] = series
    return out


def split_metrics(ds: Dataset, ends: np.ndarray, pred: np.ndarray) -> tuple[dict, dict]:
    true = ds.targets[future_index(ends)]
    persistence = ds.targets[future_index(ends) - 24]
    model_m, base_m = {}, {}
    for k, target in enumerate(TARGETS):
        model_m[target] = {**summary(true[..., k], pred[..., k]), "unit": TARGET_UNITS[target]}
        base_m[target] = {**summary(true[..., k], persistence[..., k]), "unit": TARGET_UNITS[target]}
    return model_m, base_m


def coverage_of(true: np.ndarray, pred: np.ndarray, hw: list[float], target: str) -> float:
    lower = pred - np.asarray(hw)
    upper = pred + np.asarray(hw)
    if target == "precipitation":
        lower = np.clip(lower, 0, None)
    if target == "humidity":
        lower, upper = np.clip(lower, 0, 100), np.clip(upper, 0, 100)
    return round(float(np.mean((true >= lower) & (true <= upper))), 4)


def evaluate(
    name: str,
    predict_ends,
    timing_fn,
    lookback: int,
    ds: Dataset,
    extra_bad: np.ndarray,
    out_dir,
    display_name: str | None = None,
) -> tuple[dict, dict]:
    """Score any forecaster the same way. `predict_ends(ends)` returns physical-unit
    predictions (n, horizon, targets); `timing_fn(ends)` returns inference timings."""
    L = lookback
    train_cities, holdout_cities = ds.city_indices("train"), ds.city_indices("holdout")
    val_ends = window_ends(ds, "val", lookback=L, extra_bad=extra_bad, cities=train_cities)
    test_ends = window_ends(ds, "test", lookback=L, extra_bad=extra_bad, cities=train_cities)
    unseen_ends = window_ends(ds, "test", lookback=L, extra_bad=extra_bad, cities=holdout_cities)

    val_pred = predict_ends(val_ends)
    val_true = ds.targets[future_index(val_ends)]
    test_pred = predict_ends(test_ends)
    test_true = ds.targets[future_index(test_ends)]
    test_metrics, baseline = split_metrics(ds, test_ends, test_pred)
    val_metrics, _ = split_metrics(ds, val_ends, val_pred)

    unseen: dict | None = None
    if len(unseen_ends):
        unseen_pred = predict_ends(unseen_ends)
        unseen_true = ds.targets[future_index(unseen_ends)]
        u_metrics, u_base = split_metrics(ds, unseen_ends, unseen_pred)
        unseen = {"test": u_metrics, "persistence_baseline": u_base, "pred": unseen_pred, "true": unseen_true}

    per_horizon, halfwidth, coverage, coverage_unseen, per_city = {}, {}, {}, {}, {}
    all_ends = np.concatenate([test_ends, unseen_ends]) if unseen else test_ends
    all_pred = np.concatenate([test_pred, unseen["pred"]]) if unseen else test_pred
    all_true = ds.targets[future_index(all_ends)]
    all_city = ds.city_of_row[all_ends]
    for k, target in enumerate(TARGETS):
        per_horizon[target] = [round(mae(test_true[:, h, k], test_pred[:, h, k]), 4) for h in range(H)]
        # Split-conformal error range calibrated on the validation year, checked on the test period.
        hw = [conformal_halfwidth(np.abs(val_true[:, h, k] - val_pred[:, h, k]), INTERVAL_LEVEL) for h in range(H)]
        halfwidth[target] = [round(v, 4) for v in hw]
        coverage[target] = coverage_of(test_true[..., k], test_pred[..., k], hw, target)
        if unseen:
            coverage_unseen[target] = coverage_of(unseen["true"][..., k], unseen["pred"][..., k], hw, target)
        per_city[target] = {
            city.id: round(mae(all_true[all_city == c, :, k], all_pred[all_city == c, :, k]), 4)
            for c, city in enumerate(ds.cities)
            if np.any(all_city == c)
        }

    metrics = {
        "model": name,
        "display_name": display_name or DISPLAY_NAMES[name],
        "test": test_metrics,
        "persistence_baseline": baseline,
        "validation": val_metrics,
        "interval": {
            "level": INTERVAL_LEVEL,
            "method": "split conformal, calibrated on the validation year",
            "halfwidth_by_horizon": halfwidth,
            "test_coverage": coverage,
        },
        "inference": timing_fn(test_ends),
        "windows": {"val": int(len(val_ends)), "test": int(len(test_ends))},
    }
    if unseen:
        # Held-out cities: never seen in training or validation, scored on the same test period.
        metrics["test_unseen"] = unseen["test"]
        metrics["persistence_baseline_unseen"] = unseen["persistence_baseline"]
        metrics["interval"]["test_coverage_unseen"] = coverage_unseen
        metrics["windows"]["test_unseen"] = int(len(unseen_ends))
    evaluation = {
        "model": name,
        "per_horizon_mae": per_horizon,
        "per_city_mae": per_city,
        "samples": samples_for_analytics(ds, all_ends, all_pred),
    }
    np.savez_compressed(out_dir / "test_predictions.npz", ends=all_ends, lead6=all_pred[:, 5, :], lead24=all_pred[:, 23, :])
    try:
        metrics["station_check"] = station_check(ds, all_ends, all_pred[:, 5, :], all_pred[:, 23, :])
    except Exception as exc:  # noqa: BLE001 - the station check is extra; never lose a trained model over it
        print(f"station check skipped: {exc}")
        metrics["station_check"] = {"available": False, "reason": str(exc)}
    return metrics, evaluation


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", nargs="+", default=list(MODEL_NAMES), choices=MODEL_NAMES)
    parser.add_argument("--epochs", type=int, default=25)
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--train-stride", type=int, default=3)
    parser.add_argument("--lookback", type=int, default=LOOKBACK_HOURS)
    parser.add_argument("--target-mode", choices=["direct", "residual24"], default="direct")
    parser.add_argument("--loss", choices=["mse", "huber"], default="mse")
    parser.add_argument("--tf-patch", type=int, default=TRANSFORMER_DEFAULTS["patch"], help="transformer: hours per patch")
    parser.add_argument("--tf-dim", type=int, default=TRANSFORMER_DEFAULTS["dim"], help="transformer: token width")
    parser.add_argument("--tf-layers", type=int, default=TRANSFORMER_DEFAULTS["layers"], help="transformer: encoder blocks")
    parser.add_argument("--tf-heads", type=int, default=TRANSFORMER_DEFAULTS["heads"], help="transformer: attention heads")
    parser.add_argument("--tf-dropout", type=float, default=TRANSFORMER_DEFAULTS["dropout"], help="transformer: dropout")
    parser.add_argument("--experiment", help="validation-only run; results go to ml/experiments/NAME.json")
    parser.add_argument("--region", choices=REGION_NAMES, default="north_india")
    parser.add_argument("--artifacts-dir", help="override the output folder (smoke tests)")
    parser.add_argument("--allow-missing", action="store_true", help="smoke tests: use only cities downloaded so far")
    args = parser.parse_args()
    L = args.lookback
    region_out = artifacts_dir(args.region) if not args.artifacts_dir else Path(args.artifacts_dir)

    print(f"Loading {args.region}… lookback={L} target_mode={args.target_mode} loss={args.loss} stride={args.train_stride}")
    ds = load_dataset(args.region, allow_missing=args.allow_missing)
    train_cities = ds.city_indices("train")
    print(f"cities: {len(train_cities)} training, {len(ds.city_indices('holdout'))} held out")
    residual_cols = RESIDUAL_INDICES if args.target_mode == "residual24" else ()
    model_targets = residual_targets(ds, residual_cols) if residual_cols else ds.targets
    extra_bad = np.isnan(model_targets).any(axis=1)

    # The scaler sees only training-period rows of training cities: held-out cities never touch fitting.
    train_mask = split_rows(ds, "train") & ~ds.nan_rows & ~extra_bad & ds.rows_of(train_cities)
    pre = Preprocessor.fit(ds.features[train_mask], model_targets[train_mask], lookback=L, target_mode=args.target_mode)
    X = np.nan_to_num(pre.transform_features(ds.features), nan=0.0)
    Y = np.nan_to_num(pre.transform_targets(model_targets), nan=0.0)
    train_ends = window_ends(ds, "train", stride=args.train_stride, lookback=L, extra_bad=extra_bad, cities=train_cities)
    val_ends = window_ends(ds, "val", stride=6, lookback=L, extra_bad=extra_bad, cities=train_cities)
    print(f"rows={len(ds.times):,} features={X.shape[1]} train windows={len(train_ends):,} val windows={len(val_ends):,}")

    manifest = json.loads((raw_dir(args.region) / "manifest.json").read_text())
    tf_options = {"patch": args.tf_patch, "dim": args.tf_dim, "layers": args.tf_layers, "heads": args.tf_heads, "dropout": args.tf_dropout}
    for name in args.models:
        keras.utils.set_random_seed(SEED)
        options = tf_options if name == TRANSFORMER_NAME else None
        model = build_model(name, L, X.shape[1], H, len(TARGETS), loss=args.loss, options=options)
        print(f"\n=== {DISPLAY_NAMES[name]}: {model.count_params():,} parameters ===")
        started = time.perf_counter()
        history = model.fit(
            windows(X, train_ends, Y, L, args.batch, True),
            validation_data=windows(X, val_ends, Y, L, 1024, False),
            epochs=args.epochs,
            callbacks=[
                keras.callbacks.EarlyStopping(monitor="val_loss", patience=4, restore_best_weights=True),
                keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=2),
            ],
            verbose=2,
        )
        train_seconds = time.perf_counter() - started
        val_losses = history.history["val_loss"]
        config = {
            "lookback_hours": L,
            "target_mode": args.target_mode,
            "loss": args.loss,
            "train_stride_hours": args.train_stride,
        }
        if options:
            config["architecture"] = options

        if args.experiment:
            # Model selection uses the full validation year only. The test set is not touched.
            full_val = window_ends(ds, "val", lookback=L, extra_bad=extra_bad, cities=train_cities)
            val_metrics, val_base = split_metrics(ds, full_val, predict(model, pre, ds, X, full_val))
            EXPERIMENTS_DIR.mkdir(exist_ok=True)
            out = EXPERIMENTS_DIR / f"{args.experiment}__{name}.json"
            out.write_text(
                json.dumps(
                    {
                        "experiment": args.experiment,
                        "model": name,
                        "config": config,
                        "validation": val_metrics,
                        "validation_persistence": val_base,
                        "epochs_run": len(val_losses),
                        "best_epoch": int(np.argmin(val_losses)) + 1,
                        "seconds": round(train_seconds, 1),
                    },
                    indent=2,
                )
            )
            v = val_metrics
            print(
                f"[{args.experiment}] {DISPLAY_NAMES[name]} VALIDATION: temp MAE {v['temperature']['mae']:.3f}, "
                f"RH MAE {v['humidity']['mae']:.3f}, rain MAE {v['precipitation']['mae']:.4f} "
                f"(persistence temp {val_base['temperature']['mae']:.3f}, RH {val_base['humidity']['mae']:.3f}) "
                f"in {train_seconds/60:.1f} min"
            )
            continue

        out = region_out / name
        out.mkdir(parents=True, exist_ok=True)
        model.save(out / "model.keras")
        pre.save(out / "preprocessor.json")
        (out / "history.json").write_text(json.dumps({k: [float(v) for v in vals] for k, vals in history.history.items()}))

        print("Evaluating…")
        metrics, evaluation = evaluate(
            name,
            lambda ends: predict(model, pre, ds, X, ends),
            lambda ends: inference_timing(model, X, ends, L),
            L,
            ds,
            extra_bad,
            out,
        )
        metrics.update(
            {
                "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "pipeline_version": PIPELINE_VERSION,
                "framework": {"tensorflow": tf.__version__, "keras": keras.__version__},
                "parameters": int(model.count_params()),
                "config": config,
                "training": {
                    "epochs_run": len(val_losses),
                    "best_epoch": int(np.argmin(val_losses)) + 1,
                    "best_val_loss": float(np.min(val_losses)),
                    "seconds": round(train_seconds, 1),
                    "train_windows": int(len(train_ends)),
                    "train_stride_hours": args.train_stride,
                },
                "data": {
                    "source": "Open-Meteo Historical Forecast API (best_match), hourly",
                    "region": REGION_LABELS[args.region],
                    "region_id": args.region,
                    "cities": [
                        {
                            "id": c.id,
                            "name": c.name,
                            "state": c.state,
                            "role": c.role,
                            "latitude": c.latitude,
                            "longitude": c.longitude,
                            "elevation_m": manifest[c.id]["elevation_m"],
                        }
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
            f"{DISPLAY_NAMES[name]} test (training cities): temp MAE {t['temperature']['mae']:.3f} °C, "
            f"RH MAE {t['humidity']['mae']:.3f} %, rain MAE {t['precipitation']['mae']:.4f} mm "
            f"(train {train_seconds/60:.1f} min)"
        )
        if "test_unseen" in metrics:
            u = metrics["test_unseen"]
            print(
                f"{DISPLAY_NAMES[name]} test (held-out cities): temp MAE {u['temperature']['mae']:.3f} °C, "
                f"RH MAE {u['humidity']['mae']:.3f} %, rain MAE {u['precipitation']['mae']:.4f} mm"
            )


if __name__ == "__main__":
    main()
