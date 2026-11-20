"""Recompute the 80% error ranges of already-trained models, without retraining them.

    python -m weatherai_ml.recalibrate --region india [--fresh]

Runs each saved model on the validation year and the test period (training and held-out cities),
then rewrites the `interval` block of its metrics.json with train.interval_block, the same code
training uses. Everything else in metrics.json is left alone. Predictions are cached in
<artifacts>/calibration/ (not committed); `--fresh` recomputes them, which is needed after a
model is retrained. LightGBM is slow here (about 35 minutes for India on an ordinary CPU).
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

import numpy as np

from .config import REGION_NAMES, artifacts_dir
from .dataset import load_dataset, residual_targets, window_ends
from .ensemble import Member
from .gbm import GBM_NAME
from .models import ENSEMBLE_NAME, MODEL_NAMES
from .preprocess import RESIDUAL_INDICES
from .train import future_index, interval_block

SLICES = {"val_train": ("val", "train"), "val_hold": ("val", "holdout"), "test_train": ("test", "train"), "test_hold": ("test", "holdout")}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", choices=REGION_NAMES, default="north_india")
    parser.add_argument("--fresh", action="store_true", help="ignore cached predictions")
    args = parser.parse_args()

    root = artifacts_dir(args.region)
    cache = root / "calibration"
    cache.mkdir(exist_ok=True)
    ds = load_dataset(args.region)
    resid_bad = np.isnan(residual_targets(ds, RESIDUAL_INDICES)).any(axis=1)
    direct_bad = np.isnan(ds.targets).any(axis=1)

    names = [n for n in MODEL_NAMES if (root / n / "model.keras").exists()]
    if (root / GBM_NAME / "gbm_config.json").exists():
        names.append(GBM_NAME)
    members = {n: Member(n, root, ds) for n in names}

    def slice_preds(name: str, member_names: list[str], lookback: int, bad: np.ndarray) -> dict:
        out = {}
        for s, (split, role) in SLICES.items():
            ends = window_ends(ds, split, lookback=lookback, extra_bad=bad, cities=ds.city_indices(role))
            path = cache / f"{name}__{s}.npz"
            if not args.fresh and path.exists():
                saved = np.load(path)
                if np.array_equal(saved["ends"], ends):
                    out[s] = (ends, saved["pred"].astype(float))
                    continue
            if len(member_names) == 1:
                pred = members[name].predict_ends(ends)
            else:  # the ensemble: mean of its members' cached predictions on its own windows
                parts = []
                for m in member_names:
                    e, p = member_preds[m][s]
                    idx = np.searchsorted(e, ends)
                    if not np.array_equal(e[np.minimum(idx, len(e) - 1)], ends):
                        raise RuntimeError(f"{m} has no prediction for some {name} windows ({s})")
                    parts.append(p[idx])
                pred = np.mean(parts, axis=0)
            true = ds.targets[future_index(ends)]
            np.savez(path, ends=ends.astype(np.int64), resid=(true - pred).astype(np.float32), pred=pred.astype(np.float32))
            out[s] = (ends, pred)
            print(f"{name} {s}: {len(ends):,} windows", flush=True)
        return out

    def rewrite(name: str, preds: dict) -> None:
        def part(s):
            ends, pred = preds[s]
            return ends, ds.targets[future_index(ends)], pred

        block = interval_block(ds, *part("val_train"), *part("test_train"), *(part("test_hold") if len(preds["test_hold"][0]) else (None, None, None)))
        path = root / name / "metrics.json"
        metrics = json.loads(path.read_text())
        before = metrics["interval"].get("test_coverage", {})
        block["recalibrated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        metrics["interval"] = block
        path.write_text(json.dumps(metrics, indent=2))
        print(f"{name}: test coverage {before} -> {block['test_coverage']}, held-out {block.get('test_coverage_unseen')}", flush=True)

    member_preds = {}
    for n, m in members.items():
        bad = resid_bad if m.target_mode == "residual24" else direct_bad
        member_preds[n] = slice_preds(n, [n], m.lookback, bad)
        rewrite(n, member_preds[n])

    ens_file = root / ENSEMBLE_NAME / "ensemble.json"
    if ens_file.exists():
        team = json.loads(ens_file.read_text())["members"]
        lookback = max(members[n].lookback for n in team)
        bad = direct_bad | (resid_bad if any(members[n].target_mode == "residual24" for n in team) else False)
        preds = slice_preds(ENSEMBLE_NAME, team, lookback, bad)  # cached either way, for rain_chance and rain_amount
        if (root / ENSEMBLE_NAME / "rain_amount.txt").exists():
            # The ensemble's rain is corrected; rain_amount re-scores it and recalibrates its ranges.
            print("ensemble: run `python -m weatherai_ml.rain_chance` and then `python -m weatherai_ml.rain_amount` to refresh it", flush=True)
        else:
            rewrite(ENSEMBLE_NAME, preds)


if __name__ == "__main__":
    main()
