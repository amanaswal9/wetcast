"""Does NASA's satellite rain (imerg.py) help Wetcast's rain forecasts? A one-off check, kept to rerun.

    python -m weatherai_ml.imerg_check          # from ml/, after imerg.py and rain_amount; about 30 minutes

Rule written before any fit (2026-11-23 12:28 UTC):
A. Satellite rain as an input to the rain correction, using only hours ending 14 h or more before the
   issue time (the Late Run's delay). Keep it if the 2025 out-of-fold R2 against Open-Meteo rises by at
   least 0.01 and the error in hours that rained does not get worse. A no-delay run shows the ceiling.
B. Score the forecasts on the 2026 test period against NASA rain, next to Open-Meteo's own day-old
   forecast. Report only.
Result: A not kept (R2 0.139 -> 0.136; even the no-delay ceiling 0.138). B: see ensemble/imerg_check.json.
Writes artifacts/india/ensemble/imerg_check.json and changes no model.
"""

import glob
import json

import lightgbm as lgb
import numpy as np
import pandas as pd

from weatherai_ml.config import artifacts_dir
from weatherai_ml.dataset import load_dataset
from weatherai_ml.outlook import load_for_dataset
from weatherai_ml.rain_amount import FOLDS, P, PARAMS, RECENT_HOURS, STRIDE, design
from weatherai_ml.train import future_index

REGION = "india"
RULE_WRITTEN = "2026-11-23 12:28 UTC"
IMERG_FILES = "data/raw_india/imerg/*.parquet"  # relative to ml/, where the check is run from
WET_MM = 0.1


def imerg_per_row(ds) -> np.ndarray:
    """NASA's 3x3-cell rain (mm) for every dataset row, NaN where IMERG has no value."""
    files = sorted(glob.glob(IMERG_FILES))
    box_mm = pd.concat(pd.read_parquet(f) for f in files).set_index(["city", "time"])["box_mm"]
    im = np.full(len(ds.times), np.nan)
    for k, city in enumerate(ds.cities):
        rows = np.flatnonzero(ds.city_of_row == k)
        im[rows] = box_mm.xs(city.id).reindex(ds.times[rows]).to_numpy()
    return im


def load_slice(cache, team: list[str], s: str) -> tuple[np.ndarray, np.ndarray]:
    """Ensemble windows of one cached slice and each member's predictions on them, (n, H, targets, members)."""
    ends = np.load(cache / f"ensemble__{s}.npz")["ends"]
    preds = []
    for m in team:
        md = np.load(cache / f"{m}__{s}.npz")
        idx = np.searchsorted(md["ends"], ends)
        preds.append(md["pred"][idx].astype(float))
    return ends, np.stack(preds, -1)


def recent_rain(ds, ends: np.ndarray) -> np.ndarray:
    """(n, RECENT_HOURS) observed rain up to each issue hour, newest last."""
    return np.stack([ds.targets[ends - k, P] for k in range(RECENT_HOURS - 1, -1, -1)], -1)


def satellite_features(im: np.ndarray, ends: np.ndarray, lag: int, H: int) -> np.ndarray:
    """log1p of NASA rain over the last 1, 6 and 24 hours, ending `lag` hours before each issue time.

    The same three values are repeated for every lead hour of a window."""
    last = im[ends - lag]
    sum6 = sum(im[ends - lag - k] for k in range(6))
    sum24 = sum(im[ends - lag - k] for k in range(24))
    f = np.stack([np.log1p(last), np.log1p(sum6), np.log1p(sum24)], -1)
    return np.repeat(f, H, 0)


def score(p: np.ndarray, y: np.ndarray) -> dict:
    """R2, RMSE, RMSE over hours that rained, and MAE, each rounded to four places."""
    wet = y >= WET_MM
    error = p - y
    return dict(
        r2=round(1 - np.square(error).sum() / np.square(y - y.mean()).sum(), 4),
        rmse=round(float(np.sqrt(np.square(error).mean())), 4),
        wet_rmse=round(float(np.sqrt(np.square(error[wet]).mean())), 4),
        mae=round(float(np.abs(error).mean()), 4),
    )


def main() -> None:
    root = artifacts_dir(REGION)
    out = root / "ensemble"
    cache = root / "calibration"
    team = json.loads((out / "ensemble.json").read_text())["members"]
    leads = json.loads((out / "rain_chance.json").read_text())["leads"]
    ds = load_dataset(REGION)
    months, hours = np.asarray(ds.times.month), np.asarray(ds.times.hour)
    im = imerg_per_row(ds)
    print("imerg missing", np.isnan(im).mean())

    def inputs(ends: np.ndarray, members: np.ndarray, lag: int | None = None) -> np.ndarray:
        """Rain-correction inputs as served; with a `lag`, the satellite features are added at the end."""
        rain = np.clip(members[:, :, P, :], 0, None)
        X = design(rain.mean(-1), rain, months[ends], hours[ends], recent_rain(ds, ends), leads)
        if lag is None:
            return X
        sat = satellite_features(im, ends, lag, members.shape[1]).astype(np.float32)
        return np.hstack([X, sat])

    # A: fit the correction with and without satellite rain on the 2025 validation year, the same way
    # rain_amount.py does: trees chosen on October-December, then out-of-fold scores by thirds of the year.
    val_ends, val_members = load_slice(cache, team, "val_train")
    H = val_members.shape[1]
    val_y = np.clip(ds.targets[future_index(val_ends)][..., P], 0, None).ravel()
    val_month = np.repeat(months[val_ends], H)
    keep = np.repeat(np.arange(len(val_ends)) % STRIDE == 0, H)
    early_part = keep & (val_month <= 9)
    late_part = val_month >= 10

    validation = {}
    finals = {}
    for name, lag in [("base", None), ("sat_lag14", 14), ("sat_nodelay_ceiling", 0)]:
        X = inputs(val_ends, val_members, lag)
        first = lgb.train(
            PARAMS,
            lgb.Dataset(X[early_part], val_y[early_part]),
            3000,
            valid_sets=[lgb.Dataset(X[late_part], val_y[late_part])],
            callbacks=[lgb.early_stopping(50, verbose=False)],
        )
        trees = first.best_iteration
        oof = np.zeros_like(val_y)
        for fold in FOLDS:
            inside = np.isin(val_month, fold)
            fold_model = lgb.train(PARAMS, lgb.Dataset(X[keep & ~inside], val_y[keep & ~inside]), trees)
            oof[inside] = fold_model.predict(X[inside])
        validation[name] = dict(trees=trees, val_oof=score(np.clip(oof, 0, None), val_y))
        print(name, validation[name], flush=True)
        finals[name] = (lgb.train(PARAMS, lgb.Dataset(X[keep], val_y[keep]), trees), lag)

    # B: the 2026 test period, scored against Open-Meteo's archive (the training target) and against NASA.
    test_ends, test_members = load_slice(cache, team, "test_train")
    future = future_index(test_ends)
    y_openmeteo = np.clip(ds.targets[future][..., P], 0, None).ravel()
    y_nasa = im[future].ravel()
    outlook = load_for_dataset(ds, REGION)[future].ravel()
    forecasts = {
        "ours_corrected": np.clip(finals["base"][0].predict(inputs(test_ends, test_members)), 0, None),
        "ours_with_sat_lag14": np.clip(finals["sat_lag14"][0].predict(inputs(test_ends, test_members, 14)), 0, None),
        "openmeteo_dayold_forecast": outlook,
        "members_plain_mean": np.clip(test_members[:, :, P, :], 0, None).mean(-1).ravel(),
        "persistence_last_hour": np.repeat(np.clip(ds.targets[test_ends, P], 0, None), H),
    }
    ok = np.isfinite(y_nasa) & np.isfinite(outlook)

    test = {}
    for name, p in forecasts.items():
        test[name] = {
            "vs_openmeteo": score(p[ok], y_openmeteo[ok]),
            "vs_nasa": score(p[ok], y_nasa[ok]),
            "corr_nasa": round(float(np.corrcoef(p[ok], y_nasa[ok])[0, 1]), 4),
        }
        print(name, test[name], flush=True)
    test["openmeteo_archive_itself"] = {
        "vs_nasa": score(y_openmeteo[ok], y_nasa[ok]),
        "corr_nasa": round(float(np.corrcoef(y_openmeteo[ok], y_nasa[ok])[0, 1]), 4),
    }
    print("archive", test["openmeteo_archive_itself"])

    report = {
        "rule_written": RULE_WRITTEN,
        "A_validation_2025": validation,
        "B_test_2026": test,
        "rows_test": int(ok.sum()),
    }
    (out / "imerg_check.json").write_text(json.dumps(report, indent=1, default=float))
    print("EXPERIMENT DONE")


if __name__ == "__main__":
    main()
