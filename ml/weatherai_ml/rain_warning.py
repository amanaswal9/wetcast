"""Rain warnings from the ensemble's own forecast, with thresholds chosen on 2025 and scored on 2026.

    python -m weatherai_ml.rain_warning --region india

A warning looks at a whole forecast (the next 24 hours) and asks two questions, each with a fixed
amount of rain over those 24 hours, in IMD's terms for a day's rain:
- "rain": at least 2.5 mm (IMD's threshold for a rainy day);
- "moderate": at least 15.6 mm (IMD's moderate rain or more; IMD calls 64.5 mm "heavy").

Each is triggered by one number the live forecast already carries, whichever of the two did better
on the 2025 validation year: the expected number of wet hours (the sum of the hourly chances of rain)
or the expected total (the sum of the hourly rain amounts). The rule, set before looking at the
results: the lowest threshold at which, on 2025 at the training cities, at least 3 in 5 "rain"
warnings and at least 1 in 2 "moderate" warnings were followed by that much rain. Among the triggers
meeting the bar, the one that caught more of the rainy days wins. The 2026 test period (training
cities and the unseen cities) then gives the scores shown on the site: how often a warning was
followed by the rain, and how much of the rain was warned of.

Forecasts are taken every third hour (as the public site publishes them). On 2025 the chance
classifier is scored on the year it was fitted on, so the thresholds may be a little optimistic
there; the 2026 scores are not.

Order after retraining: recalibrate, rain_chance, chance_model, rain_amount, then this.
Writes ensemble/rain_warning.json, which predict.EnsemblePredictor reads when present.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

import numpy as np

from .config import REGION_NAMES, artifacts_dir

STEP = 3  # one forecast every third hour
LEVELS = {
    # level: (24-hour rain in mm, share of warnings that must be followed by it on 2025)
    "rain": (2.5, 0.6),
    "moderate": (15.6, 0.5),
}
TRIGGERS = {
    "wet_hours": np.round(np.arange(0.5, 24.01, 0.25), 2),  # sum of the hourly chances
    "total_mm": np.round(np.concatenate([np.arange(0.5, 10, 0.25), np.arange(10, 60.1, 1.0)]), 2),  # sum of the amounts
}


def warn(info: dict, chance: np.ndarray | None, amount: np.ndarray) -> dict | None:
    """The warning for one forecast: the strongest level whose trigger is reached, or None.
    `chance` and `amount` are (24,) the hourly chance of rain and expected rain, mm."""
    if chance is None:
        return None
    triggers = {"wet_hours": float(np.sum(chance)), "total_mm": float(np.sum(np.clip(amount, 0, None)))}
    found = None
    for level, rule in info["levels"].items():  # weakest first, so a stronger level that is reached wins
        if triggers[rule["trigger"]] >= rule["threshold"]:
            test = rule["test"]
            found = {
                "level": level,
                "event_mm": rule["event_mm"],
                "wet_hours": round(triggers["wet_hours"], 1),
                "total_mm": round(triggers["total_mm"], 1),
                "peak_hour": int(np.argmax(chance)),
                "followed_by_rain": test["followed_by_rain"],
                "caught": test["caught"],
            }
    return found


def score(trigger: np.ndarray, observed_mm: np.ndarray, threshold: float, event_mm: float) -> dict:
    """How a rule "warn when trigger >= threshold" did against "at least event_mm fell"."""
    warned = trigger >= threshold
    happened = observed_mm >= event_mm
    hits = int((warned & happened).sum())
    return {
        "forecasts": int(len(trigger)),
        "warnings": int(warned.sum()),
        "events": int(happened.sum()),
        "hits": hits,
        # Of the warnings, the share followed by the rain; of the rainy spells, the share warned of.
        "followed_by_rain": round(hits / warned.sum(), 3) if warned.any() else None,
        "caught": round(hits / happened.sum(), 3) if happened.any() else None,
        "warned_share": round(float(warned.mean()), 4),
        "event_share": round(float(happened.mean()), 4),
    }


def choose(triggers: dict[str, np.ndarray], observed_mm: np.ndarray, event_mm: float, bar: float) -> dict | None:
    """The trigger and threshold that meet the bar on validation and catch the most, or None."""
    best = None
    for name, values in triggers.items():
        for t in TRIGGERS[name]:
            s = score(values, observed_mm, float(t), event_mm)
            if s["followed_by_rain"] is None or s["followed_by_rain"] < bar or s["warnings"] < 50:
                continue
            # The lowest passing threshold for this trigger catches the most; stop there.
            if best is None or s["caught"] > best["validation"]["caught"]:
                best = {"trigger": name, "threshold": float(t), "validation": s}
            break
    return best


def main() -> None:
    """Rebuild the ensemble's chances and amounts for every cached window, choose thresholds, score them."""
    import lightgbm as lgb

    from .dataset import load_dataset
    from .outlook import load_for_dataset
    from .rain_amount import P, RECENT_HOURS, design
    from .rain_chance import chance
    from .train import future_index

    parser = argparse.ArgumentParser()
    parser.add_argument("--region", choices=REGION_NAMES, default="north_india")
    args = parser.parse_args()
    root = artifacts_dir(args.region)
    out = root / "ensemble"
    cache = root / "calibration"
    team = json.loads((out / "ensemble.json").read_text())["members"]
    chance_info = json.loads((out / "rain_chance.json").read_text())
    leads = chance_info["leads"]
    amount_info = json.loads((out / "rain_amount.json").read_text())
    chance_booster = lgb.Booster(model_file=str(out / chance_info["model"]["file"]))
    amount_booster = lgb.Booster(model_file=str(out / "rain_amount.txt"))
    ds = load_dataset(args.region)
    months, hours = np.asarray(ds.times.month), np.asarray(ds.times.hour)
    om = load_for_dataset(ds, args.region)

    def slice_of(s: str) -> tuple[dict[str, np.ndarray], np.ndarray]:
        """The two triggers and the observed 24-hour rain for every third cached window of one slice."""
        ends = np.load(cache / f"ensemble__{s}.npz")["ends"][::STEP]
        rain = []
        for m in team:
            md = np.load(cache / f"{m}__{s}.npz")
            idx = np.searchsorted(md["ends"], ends)
            if not np.array_equal(md["ends"][np.minimum(idx, len(md["ends"]) - 1)], ends):
                raise SystemExit(f"{m} has no cached prediction for some ensemble windows ({s}).")
            rain.append(np.clip(md["pred"][idx][..., P].astype(float), 0, None))
        rain = np.stack(rain, -1)
        n, H = rain.shape[:2]
        recent = np.stack([ds.targets[ends - k, P] for k in range(RECENT_HOURS - 1, -1, -1)], -1)
        fut = future_index(ends)
        mean = rain.mean(-1)
        X_chance = design(mean, rain, months[ends], hours[ends], recent, leads, om[fut])
        p = np.clip(chance_booster.predict(X_chance), 0, 1).reshape(n, H)
        extra = om[fut] if amount_info.get("outlook") else None
        X_amount = design(mean, rain, months[ends], hours[ends], recent, leads, extra)
        mm = np.clip(amount_booster.predict(X_amount, num_iteration=amount_info["trees"]), 0, None).reshape(n, H)
        observed = np.clip(ds.targets[fut][..., P], 0, None).sum(1)
        return {"wet_hours": p.sum(1), "total_mm": mm.sum(1)}, observed

    v_trig, v_obs = slice_of("val_train")
    t_trig, t_obs = slice_of("test_train")
    try:
        h_trig, h_obs = slice_of("test_hold")
    except FileNotFoundError:
        h_trig = h_obs = None

    levels = {}
    for level, (event_mm, bar) in LEVELS.items():
        picked = choose(v_trig, v_obs, event_mm, bar)
        if picked is None:
            print(f"{level}: no threshold met the bar on 2025, left out", flush=True)
            continue
        name, t = picked["trigger"], picked["threshold"]
        picked |= {"event_mm": event_mm, "bar": bar, "test": score(t_trig[name], t_obs, t, event_mm)}
        if h_trig is not None:
            picked["test_unseen"] = score(h_trig[name], h_obs, t, event_mm)
        levels[level] = picked
        s = picked["test"]
        print(f"{level} (>= {event_mm} mm in 24 h): warn when {name} >= {t}; 2025 followed {picked['validation']['followed_by_rain']}, "
              f"caught {picked['validation']['caught']}; 2026 followed {s['followed_by_rain']}, caught {s['caught']}, "
              f"warned on {s['warned_share']:.1%} of forecasts (event on {s['event_share']:.1%}); "
              f"unseen {picked.get('test_unseen', {}).get('followed_by_rain')}/{picked.get('test_unseen', {}).get('caught')}", flush=True)

    info = {
        "method": "Thresholds on the next 24 hours' expected wet hours or expected total, chosen on the 2025 validation year at the "
                  "training cities and scored on the 2026 test period, one forecast every third hour",
        "hours": 24,
        "levels": levels,
        "fitted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (out / "rain_warning.json").write_text(json.dumps(info, indent=1))


if __name__ == "__main__":
    main()
