"""Chance of rain for each forecast hour, from the ensemble's rain forecast.

    python -m weatherai_ml.rain_chance --region india

The models' rain amounts are poor guides on their own: they learn log1p(mm) with an average-error
loss, so they forecast small amounts (0.08 mm/h on average for India's 2026 test period, when 0.18
fell), and by mean absolute error an always-dry forecast scores almost as well. Whether it rains is
what they get right more often. So for each lead hour this fits an isotonic (never decreasing) map
from the ensemble's forecast amount to the share of hours with at least WET_MM of rain, on the
2025 validation year at the training cities, and scores it on the 2026 test period with the Brier
score against always forecasting 2025's rain frequency.

It reads the ensemble's predictions cached by `weatherai_ml.recalibrate` (run that first) and writes
<artifacts>/ensemble/rain_chance.json, which predict.EnsemblePredictor uses when present. A
LightGBM classifier on all five members was only about 1.5% better and was not worth a sixth model.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

import numpy as np

from .config import REGION_NAMES, TARGETS, artifacts_dir

WET_MM = 0.1  # rain in the hour that counts as "rain"
P = TARGETS.index("precipitation")


def fit(forecast: np.ndarray, observed: np.ndarray, wet_mm: float = WET_MM) -> list[dict]:
    """Per lead hour, the isotonic map forecast mm -> chance of >= wet_mm, as breakpoints for np.interp.
    `forecast` and `observed` are (n, horizon) rain amounts in mm."""
    from sklearn.isotonic import IsotonicRegression

    leads = []
    for h in range(forecast.shape[1]):
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        iso.fit(forecast[:, h], (observed[:, h] >= wet_mm).astype(float))
        leads.append({"x": [round(float(v), 4) for v in iso.X_thresholds_], "p": [round(float(v), 4) for v in iso.y_thresholds_]})
    return leads


def chance(leads: list[dict], forecast: np.ndarray) -> np.ndarray:
    """Chance of rain for forecast amounts shaped (n, horizon) or (horizon,)."""
    f = np.asarray(forecast, dtype=float)
    out = np.empty_like(f)
    for h, lead in enumerate(leads):
        out[..., h] = np.interp(f[..., h], lead["x"], lead["p"])
    return out


def brier(observed_wet: np.ndarray, prob) -> float:
    return round(float(np.mean((np.asarray(prob, dtype=float) - observed_wet) ** 2)), 5)


def reliability(observed_wet: np.ndarray, prob: np.ndarray) -> list[dict]:
    """When it said about x, how often it rained."""
    edges = [0.0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0001]
    out = []
    p, o = prob.ravel(), observed_wet.ravel()
    for lo, hi in zip(edges, edges[1:]):
        m = (p >= lo) & (p < hi)
        if m.any():
            out.append({"from": lo, "to": min(hi, 1.0), "said": round(float(p[m].mean()), 3), "rained": round(float(o[m].mean()), 3), "n": int(m.sum())})
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", choices=REGION_NAMES, default="north_india")
    args = parser.parse_args()
    root = artifacts_dir(args.region)
    cache = root / "calibration"

    from .dataset import load_dataset
    from .train import future_index

    ds = load_dataset(args.region)

    def load(s: str):
        d = np.load(cache / f"ensemble__{s}.npz")
        forecast = d["pred"][..., P].astype(float)
        # The real observations: rebuilding them from the cached float32 forecast and error turned some exact
        # 0.1 mm hours into 0.0999999 mm, i.e. dry, at random.
        observed = np.clip(ds.targets[future_index(d["ends"])][..., P], 0, None)
        return forecast, observed

    try:
        vf, vo = load("val_train")
        tf, to = load("test_train")
    except FileNotFoundError as exc:
        raise SystemExit(f"{exc.filename} is missing: run `python -m weatherai_ml.recalibrate --region {args.region}` first.") from exc
    leads = fit(vf, vo)
    base = float(np.mean(vo >= WET_MM))
    tw = (to >= WET_MM).astype(float)
    tp = chance(leads, tf)
    scores = {
        "test": {"brier": brier(tw, tp), "climatology_brier": brier(tw, base), "rain_share": round(float(tw.mean()), 4)},
        "by_lead": {str(h): {"brier": brier(tw[:, h - 1], tp[:, h - 1]), "climatology_brier": brier(tw[:, h - 1], base)} for h in (1, 6, 12, 24)},
        "reliability_test": reliability(tw, tp),
    }
    try:
        hf, ho = load("test_hold")
        hw = (ho >= WET_MM).astype(float)
        scores["test_unseen"] = {"brier": brier(hw, chance(leads, hf)), "climatology_brier": brier(hw, base), "rain_share": round(float(hw.mean()), 4)}
    except FileNotFoundError:
        pass
    out = {
        "wet_mm": WET_MM,
        "method": "isotonic map per lead hour from the ensemble's rain forecast, fitted on the validation year at the training cities",
        "validation_rain_share": round(base, 4),
        "scores": scores,
        "leads": leads,
        "fitted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (root / "ensemble" / "rain_chance.json").write_text(json.dumps(out, indent=1))
    s = scores["test"]
    print(f"chance of rain: Brier {s['brier']} vs {s['climatology_brier']} always {base:.0%}; held-out {scores.get('test_unseen')}")


if __name__ == "__main__":
    main()
