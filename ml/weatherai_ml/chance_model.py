"""Chance of rain with Open-Meteo's own forecast as a hint: a small LightGBM classifier.

    python -m weatherai_ml.chance_model --region india

Inputs: the same as the rain-amount correction (each member's rain, the isotonic chance from
rain_chance.py, lead, month, hour, the last 1/6/24 h of observed rain) plus Open-Meteo's day-old rain
forecast for the hour (outlook.py). Fitted on the 2025 validation year at the training cities
(January-September, early-stopped on October-December, then refitted on the whole year), with the
forecast hidden for a tenth of the windows so it also knows what to do when the live forecast can't
be fetched. Chosen by a rule set before looking: its out-of-fold 2025 Brier score had to be at least 3%
below the isotonic map's (0.0886 against 0.0938, 5.5%). Scored on the 2026 test period here.

Order after retraining: recalibrate, rain_chance, this, rain_amount. Re-running rain_chance drops this
model's block from rain_chance.json, so run this again after it. Writes ensemble/rain_chance_model.txt
and adds a "model" block and its scores to ensemble/rain_chance.json (the isotonic scores are kept
under "scores_isotonic").
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

import numpy as np

from .config import REGION_NAMES, artifacts_dir
from .rain_amount import HIDE_OUTLOOK, P, PARAMS, RECENT_HOURS, STRIDE, design
from .rain_chance import WET_MM, brier, chance, reliability

CLASSIFIER = {k: v for k, v in PARAMS.items() if k != "tweedie_variance_power"} | {"objective": "binary"}
MODEL_FILE = "rain_chance_model.txt"


def main() -> None:
    import lightgbm as lgb

    from .dataset import load_dataset
    from .outlook import load_for_dataset
    from .train import future_index

    parser = argparse.ArgumentParser()
    parser.add_argument("--region", choices=REGION_NAMES, default="north_india")
    args = parser.parse_args()
    root = artifacts_dir(args.region)
    out = root / "ensemble"
    cache = root / "calibration"
    team = json.loads((out / "ensemble.json").read_text())["members"]
    info_path = out / "rain_chance.json"
    info = json.loads(info_path.read_text())
    leads = info["leads"]
    ds = load_dataset(args.region)
    months, hours = np.asarray(ds.times.month), np.asarray(ds.times.hour)
    om = load_for_dataset(ds, args.region)
    if np.isnan(om).all():
        raise SystemExit("No day-old forecasts downloaded: run python -m weatherai_ml.outlook first.")

    def slice_of(s: str):
        """Inputs, observed wet/dry and the isotonic chance for one cached slice."""
        try:
            ends = np.load(cache / f"ensemble__{s}.npz")["ends"]
        except FileNotFoundError as exc:
            raise SystemExit(f"{exc.filename} is missing: run recalibrate and rain_chance first.") from exc
        rain = []
        for m in team:
            md = np.load(cache / f"{m}__{s}.npz")
            idx = np.searchsorted(md["ends"], ends)
            if not np.array_equal(md["ends"][np.minimum(idx, len(md["ends"]) - 1)], ends):
                raise SystemExit(f"{m} has no cached prediction for some ensemble windows ({s}).")
            rain.append(np.clip(md["pred"][idx][..., P].astype(float), 0, None))
        rain = np.stack(rain, -1)
        recent = np.stack([ds.targets[ends - k, P] for k in range(RECENT_HOURS - 1, -1, -1)], -1)
        fut = future_index(ends)
        X = design(rain.mean(-1), rain, months[ends], hours[ends], recent, leads, om[fut])
        wet = (np.clip(ds.targets[fut][..., P], 0, None) >= WET_MM).astype(float)
        return ends, X, wet, chance(leads, rain.mean(-1))

    v_ends, v_X, v_wet, _ = slice_of("val_train")
    H = v_wet.shape[1]
    v_y = v_wet.ravel()
    v_month = np.repeat(months[v_ends], H)
    keep = np.repeat(np.arange(len(v_ends)) % STRIDE == 0, H)
    v_fit = v_X.copy()
    v_fit[np.repeat(np.random.default_rng(7).random(len(v_ends)) < HIDE_OUTLOOK, H), -1] = np.nan

    first = lgb.train(
        CLASSIFIER, lgb.Dataset(v_fit[keep & (v_month <= 9)], v_y[keep & (v_month <= 9)]), 3000,
        valid_sets=[lgb.Dataset(v_X[v_month >= 10], v_y[v_month >= 10])], callbacks=[lgb.early_stopping(50, verbose=False)],
    )
    trees = int(first.best_iteration)
    final = lgb.train(CLASSIFIER, lgb.Dataset(v_fit[keep], v_y[keep]), trees)
    final.save_model(str(out / MODEL_FILE), num_iteration=trees)
    print(f"trees: {trees}", flush=True)

    base = float(info["validation_rain_share"])
    _, t_X, tw, t_iso = slice_of("test_train")
    tp = final.predict(t_X).reshape(tw.shape)
    t_blind = t_X.copy()
    t_blind[:, -1] = np.nan
    tp_blind = final.predict(t_blind).reshape(tw.shape)
    scores = {
        "test": {"brier": brier(tw, tp), "climatology_brier": brier(tw, base), "rain_share": round(float(tw.mean()), 4),
                 "isotonic_brier": brier(tw, t_iso), "without_forecast_brier": brier(tw, tp_blind)},
        "by_lead": {str(h): {"brier": brier(tw[:, h - 1], tp[:, h - 1]), "climatology_brier": brier(tw[:, h - 1], base)} for h in (1, 6, 12, 24)},
        "reliability_test": reliability(tw, tp),
    }
    try:
        _, h_X, hw, h_iso = slice_of("test_hold")
        scores["test_unseen"] = {"brier": brier(hw, final.predict(h_X).reshape(hw.shape)), "climatology_brier": brier(hw, base),
                                 "rain_share": round(float(hw.mean()), 4), "isotonic_brier": brier(hw, h_iso)}
    except SystemExit:
        pass

    info["scores_isotonic"] = info.get("scores_isotonic") or info["scores"]
    info["scores"] = scores
    info["method"] = (
        "LightGBM classifier on the members' rain, the isotonic chance, time of day and year, recent rain and "
        "Open-Meteo's day-old rain forecast, fitted on the validation year at the training cities"
    )
    info["model"] = {"file": MODEL_FILE, "trees": trees, "members": team, "outlook": True, "recent_hours": RECENT_HOURS,
                     "fitted_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    info_path.write_text(json.dumps(info, indent=1))
    t = scores["test"]
    print(f"chance of rain on test: Brier {t['brier']} (isotonic {t['isotonic_brier']}, without the forecast {t['without_forecast_brier']}, "
          f"always {base:.0%} {t['climatology_brier']}); held-out {scores.get('test_unseen')}", flush=True)


if __name__ == "__main__":
    main()
