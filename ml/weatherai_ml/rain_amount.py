"""True-average rain amounts for the ensemble: a small LightGBM correction on top of its members.

    python -m weatherai_ml.rain_amount --region india

Why: the models learn log1p(mm) with an average-error loss, which pulls their rain amounts towards
"almost dry" (the ensemble forecast 0.08 mm/h on average for India's 2026 test period, when 0.18 fell).
This model maps the members' rain forecasts, the ensemble's chance of rain, the time of day and year,
and the rain of the last 24 observed hours to the expected amount, with a Tweedie loss (made for
amounts that are often exactly zero). It is fitted on the 2025 validation year at the training cities
only, early-stopped on October-December. The trade-off, chosen on purpose: expected amounts score
better on RMSE, R² and the hours that rained, and worse on mean absolute error, which rewards
forecasting almost no rain (an always-dry forecast beats it on that measure).

Scoring: the error ranges for rain are calibrated on out-of-fold 2025 predictions (each third
of the year corrected by a model that never saw it), and the ensemble is then re-scored on the 2026
test period with train.evaluate, rewriting its metrics.json and evaluation.json.

Order after retraining any model: recalibrate, rain_chance, chance_model, then this.
Reads the prediction cache that `weatherai_ml.recalibrate` writes. Writes ensemble/rain_amount.txt
(the trees) and ensemble/rain_amount.json (settings and scores).
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from .config import REGION_NAMES, TARGETS, artifacts_dir

P = TARGETS.index("precipitation")
RECENT_HOURS = 24
PARAMS = {
    "objective": "tweedie", "tweedie_variance_power": 1.3, "learning_rate": 0.05, "num_leaves": 63,
    "min_data_in_leaf": 500, "feature_fraction": 0.9, "bagging_fraction": 0.8, "bagging_freq": 1,
    "verbose": -1, "seed": 7, "num_threads": 0,
}
FOLDS = ((1, 2, 3, 4), (5, 6, 7, 8), (9, 10, 11, 12))  # calendar months of the validation year
STRIDE = 3  # fit on every third window: neighbouring windows overlap almost completely
HIDE_OUTLOOK = 0.1  # share of training windows fitted without the day-old forecast


def design(
    ensemble: np.ndarray,
    members: np.ndarray,
    months: np.ndarray,
    hours: np.ndarray,
    recent: np.ndarray,
    chance_leads: list[dict],
    outlook: np.ndarray | None = None,
) -> np.ndarray:
    """Inputs for the correction, one row per window and lead hour.

    ensemble (n, H) mean rain of the members, mm; members (n, H, M) each member's rain, mm;
    months, hours (n,) UTC month and hour of the issue time; recent (n, RECENT_HOURS) observed rain at
    the centre, newest last (the issue hour itself is the last column), mm; outlook (n, H) Open-Meteo's
    day-old rain forecast for each hour (outlook.py), NaN where unknown, or None for a correction
    fitted without it."""
    from .rain_chance import chance

    n, H = ensemble.shape
    lead = np.broadcast_to(np.arange(1, H + 1), (n, H))
    month = np.broadcast_to(np.asarray(months)[:, None], (n, H))
    hour = (np.asarray(hours)[:, None] + lead) % 24
    recent = np.clip(np.asarray(recent, dtype=float), 0, None)
    # Column order matters: the saved trees expect exactly this layout.
    cols = [np.log1p(np.clip(ensemble, 0, None))]
    cols += [np.log1p(np.clip(members[..., i], 0, None)) for i in range(members.shape[-1])]
    cols += [
        chance(chance_leads, ensemble),
        lead,
        np.sin(2 * np.pi * month / 12), np.cos(2 * np.pi * month / 12),
        np.sin(2 * np.pi * hour / 24), np.cos(2 * np.pi * hour / 24),
        np.log1p(recent[:, -1:]), np.log1p(recent[:, -6:].sum(1, keepdims=True)), np.log1p(recent.sum(1, keepdims=True)),
    ]
    if outlook is not None:
        # NaN stays NaN: LightGBM sends unknown values down the branch learned for them.
        cols.append(np.log1p(np.clip(np.asarray(outlook, dtype=float), 0, None)))
    return np.stack([np.broadcast_to(c, (n, H)).ravel() for c in cols], -1).astype(np.float32)


class RainAmount:
    """The saved correction, used by predict.EnsemblePredictor."""

    def __init__(self, folder: Path, chance_leads: list[dict]):
        """Load the correction's settings and trees; chance_leads is the chance-of-rain table per lead hour."""
        import lightgbm as lgb

        self.meta = json.loads((folder / "rain_amount.json").read_text())
        self.booster = lgb.Booster(model_file=str(folder / "rain_amount.txt"))
        self.members: list[str] = self.meta["members"]
        self.chance_leads = chance_leads
        self.uses_outlook = bool(self.meta.get("outlook"))  # corrections from before outlook.py: False

    def predict(self, member_rain: dict[str, np.ndarray], issued: pd.Timestamp, recent: np.ndarray, outlook: np.ndarray | None = None) -> np.ndarray:
        """(H,) expected rain for one forecast. member_rain: name -> (H,) mm; recent: last RECENT_HOURS observed, mm;
        outlook: (H,) Open-Meteo's forecast for the same hours, mm (None or NaN where unknown)."""
        members = np.stack([np.asarray(member_rain[m], dtype=float) for m in self.members], -1)[None]
        ensemble = members.mean(-1)
        ts = pd.Timestamp(issued)
        ts = ts.tz_convert("UTC") if ts.tzinfo else ts
        extra = None
        if self.uses_outlook:
            extra = np.full(ensemble.shape, np.nan) if outlook is None else np.asarray(outlook, dtype=float).reshape(ensemble.shape)
        X = design(ensemble, members, np.array([ts.month]), np.array([ts.hour]), np.asarray(recent, dtype=float)[None], self.chance_leads, extra)
        return np.clip(self.booster.predict(X, num_iteration=self.meta["trees"]), 0, None)


def main() -> None:
    """Fit the rain correction on 2025, then recalibrate and re-score the ensemble on the 2026 test period."""
    # Training-only imports live here so that serving can import RainAmount cheaply.
    import lightgbm as lgb

    from . import train
    from .dataset import load_dataset, residual_targets, window_ends
    from .preprocess import RESIDUAL_INDICES
    from .train import future_index

    parser = argparse.ArgumentParser()
    parser.add_argument("--region", choices=REGION_NAMES, default="north_india")
    # Off by default: on the 2025 validation year it raised out-of-fold R² only from 0.139 to 0.145 (the bar
    # set beforehand was +0.01) and made the error in hours that rained slightly worse.
    parser.add_argument("--outlook", action="store_true", help="also use Open-Meteo's day-old rain forecast (outlook.py)")
    args = parser.parse_args()
    root = artifacts_dir(args.region)
    out = root / "ensemble"
    cache = root / "calibration"
    team = json.loads((out / "ensemble.json").read_text())["members"]
    chance_leads = json.loads((out / "rain_chance.json").read_text())["leads"]
    ds = load_dataset(args.region)
    months, hours = np.asarray(ds.times.month), np.asarray(ds.times.hour)
    om = None
    if args.outlook:
        from .outlook import load_for_dataset

        om = load_for_dataset(ds, args.region)
        if np.isnan(om).all():
            raise SystemExit("No day-old forecasts downloaded: run python -m weatherai_ml.outlook first.")

    def load(s: str):
        """Ensemble windows of one slice with every member's predictions on them (all targets)."""
        try:
            d = np.load(cache / f"ensemble__{s}.npz")
        except FileNotFoundError as exc:
            raise SystemExit(f"{exc.filename} is missing: run recalibrate (and rain_chance) first.") from exc
        ends = d["ends"]
        preds = []
        for m in team:
            md = np.load(cache / f"{m}__{s}.npz")
            idx = np.searchsorted(md["ends"], ends)
            if not np.array_equal(md["ends"][np.minimum(idx, len(md["ends"]) - 1)], ends):
                raise SystemExit(f"{m} has no cached prediction for some ensemble windows ({s}).")
            preds.append(md["pred"][idx].astype(float))
        members = np.stack(preds, -1)  # (n, H, targets, M)
        return ends, members

    def recent_rain(ends: np.ndarray) -> np.ndarray:
        """(n, RECENT_HOURS) observed rain at the centre up to each issue hour, newest last."""
        return np.stack([ds.targets[ends - k, P] for k in range(RECENT_HOURS - 1, -1, -1)], -1)

    def X_of(ends, members):
        """Correction inputs for the given windows and member forecasts."""
        rain = np.clip(members[:, :, P, :], 0, None)
        outlook = None if om is None else om[future_index(ends)]
        return design(rain.mean(-1), rain, months[ends], hours[ends], recent_rain(ends), chance_leads, outlook)

    v_ends, v_mem = load("val_train")
    v_X = X_of(v_ends, v_mem)
    v_y = np.clip(ds.targets[future_index(v_ends)][..., P], 0, None).ravel()
    H = v_mem.shape[1]
    v_month = np.repeat(months[v_ends], H)
    keep = np.repeat(np.arange(len(v_ends)) % STRIDE == 0, H)
    # The trees learn from a copy with the forecast hidden for a tenth of the windows, so they also
    # know what to do when the live forecast can't be fetched.
    v_X_fit = v_X
    if om is not None:
        v_X_fit = v_X.copy()
        v_X_fit[np.repeat(np.random.default_rng(7).random(len(v_ends)) < HIDE_OUTLOOK, H), -1] = np.nan
        print(f"day-old forecast missing for {np.isnan(v_X[:, -1]).mean():.2%} of validation hours", flush=True)

    def fit(rows: np.ndarray, trees: int | None = None, stop: np.ndarray | None = None):
        """Fit on `rows`: a fixed number of trees, or early-stopped on the `stop` rows."""
        data = lgb.Dataset(v_X_fit[rows], v_y[rows])
        if trees is not None:
            return lgb.train(PARAMS, data, trees)
        check = lgb.Dataset(v_X[stop], v_y[stop], reference=data)
        return lgb.train(PARAMS, data, 3000, valid_sets=[check], callbacks=[lgb.early_stopping(50, verbose=False)])

    # 1. How many trees: fit January-September, stop early on October-December.
    first = fit(keep & (v_month <= 9), stop=v_month >= 10)
    trees = int(first.best_iteration)
    print(f"trees: {trees}", flush=True)
    # 2. Out-of-fold 2025 amounts, so the error ranges are set on hours each model never saw.
    oof = np.zeros_like(v_y)
    for fold in FOLDS:
        inside = np.isin(v_month, fold)
        oof[inside] = fit(keep & ~inside, trees).predict(v_X[inside])
        print(f"out-of-fold months {fold[0]}-{fold[-1]} done", flush=True)
    oof = np.clip(oof, 0, None).reshape(len(v_ends), H)
    # 3. The served model: the whole validation year.
    final = fit(keep, trees)
    final.save_model(str(out / "rain_amount.txt"), num_iteration=trees)

    # Ensemble predictions per window: members' mean, with the corrected rain.
    lookup: dict[int, np.ndarray] = {}
    for i, e in enumerate(v_ends):
        row = v_mem[i].mean(-1)
        row[:, P] = oof[i]
        lookup[int(e)] = row
    for s in ("test_train", "test_hold"):
        ends, mem = load(s)
        rain = np.clip(final.predict(X_of(ends, mem)), 0, None).reshape(len(ends), H)
        mean = mem.mean(-1)
        mean[:, :, P] = rain
        lookup.update({int(e): mean[i] for i, e in enumerate(ends)})

    def predict_ends(ends: np.ndarray) -> np.ndarray:
        """Cached ensemble forecasts (with corrected rain) for the given windows."""
        missing = [int(e) for e in ends if int(e) not in lookup]
        if missing:
            raise SystemExit(f"{len(missing)} ensemble windows have no cached predictions; rerun recalibrate.")
        return np.stack([lookup[int(e)] for e in ends])

    old = json.loads((out / "metrics.json").read_text())
    lookback = int(old["data"]["lookback_hours"])
    bad = np.isnan(ds.targets).any(axis=1) | np.isnan(residual_targets(ds, RESIDUAL_INDICES)).any(axis=1)
    if not np.array_equal(window_ends(ds, "test", lookback=lookback, extra_bad=bad, cities=ds.city_indices("train")), np.load(cache / "ensemble__test_train.npz")["ends"]):
        raise SystemExit("The ensemble's windows changed; rerun recalibrate first.")
    metrics, evaluation = train.evaluate("ensemble", predict_ends, lambda ends: old["inference"], lookback, ds, bad, out, old["display_name"])

    # "Before" means the members' plain average, uncorrected: keep it from an earlier run of this script.
    earlier = old.get("rain_amount") or {}
    before = earlier.get("test_before") or old["test"]["precipitation"]
    before_unseen = earlier.get("test_unseen_before") or old.get("test_unseen", {}).get("precipitation")
    after = metrics["test"]["precipitation"]
    info = {
        "method": "LightGBM Tweedie correction of the members' rain (expected amount), fitted on the validation year"
        + (", with Open-Meteo's day-old rain forecast as an input" if om is not None else ""),
        "params": PARAMS,
        "trees": trees,
        "members": team,
        "recent_hours": RECENT_HOURS,
        "outlook": om is not None,
        "fitted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "test_before": before,
        "test_unseen_before": before_unseen,
        # The ensemble's scores just before this run (e.g. the correction without the day-old forecast).
        "test_previous": old["test"]["precipitation"],
        "test_unseen_previous": old.get("test_unseen", {}).get("precipitation"),
    }
    (out / "rain_amount.json").write_text(json.dumps(info, indent=2))
    keep_keys = {k: v for k, v in old.items() if k not in metrics}
    merged = keep_keys | metrics | {"rain_amount": {k: v for k, v in info.items() if k != "params"}}
    merged["method"] = "equal-weight mean of member predictions; rain amounts corrected to the expected amount (rain_amount.py)"
    (out / "metrics.json").write_text(json.dumps(merged, indent=2))
    (out / "evaluation.json").write_text(json.dumps(evaluation))
    print(f"rain on test: MAE {before['mae']:.4f} -> {after['mae']:.4f}, RMSE {before['rmse']:.4f} -> {after['rmse']:.4f}, "
          f"R2 {before['r2']:.3f} -> {after['r2']:.3f}; rain range coverage {metrics['interval']['test_coverage']['precipitation']}", flush=True)


if __name__ == "__main__":
    main()
