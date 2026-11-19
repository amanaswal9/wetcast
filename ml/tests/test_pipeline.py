"""Tests for the shared feature pipeline, leakage guards and prediction function."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from weatherai_ml.config import (
    ARTIFACTS_DIR,
    CITIES,
    FEATURE_ORDER,
    HORIZON_HOURS,
    LOOKBACK_HOURS,
    SPLITS,
    TARGETS,
    City,
)
from weatherai_ml.dataset import Dataset, residual_targets, window_ends
from weatherai_ml.features import build_frames
from weatherai_ml.metrics import conformal_halfwidth, r2, summary
from weatherai_ml.predict import InsufficientHistoryError, Predictor, nearest_city
from weatherai_ml.preprocess import FeatureOrderError, Preprocessor
from weatherai_ml.synthetic import synthetic_long_frame

DELHI = CITIES[0]


def test_feature_order_is_unique_and_complete():
    assert len(FEATURE_ORDER) == len(set(FEATURE_ORDER)) == 42


def test_build_frames_columns_and_order():
    features, targets = build_frames(synthetic_long_frame(72), DELHI, 216.0)
    assert list(features.columns) == list(FEATURE_ORDER)
    assert list(targets.columns) == list(TARGETS)
    assert len(features) == 72
    assert (targets["precipitation"] >= 0).all()


def test_short_gaps_are_filled_long_gaps_are_not():
    raw = synthetic_long_frame(48)
    times = sorted(raw["time"].unique())
    short_gap = times[10:12]  # 2 hours
    long_gap = times[20:25]  # 5 hours
    raw.loc[raw["time"].isin(short_gap), "temperature_2m"] = np.nan
    raw.loc[raw["time"].isin(long_gap), "temperature_2m"] = np.nan
    features, _ = build_frames(raw, DELHI, 216.0)
    assert features["c_temp"].iloc[10:12].notna().all()
    assert features["c_temp"].iloc[20:25].isna().all()


def test_wind_components_follow_meteorological_convention():
    raw = synthetic_long_frame(24)
    raw["wind_speed_10m"] = 10.0
    raw["wind_direction_10m"] = 0.0  # wind from the north blows southwards
    features, _ = build_frames(raw, DELHI, 216.0)
    assert np.allclose(features["c_wind_v"], -10.0)
    assert np.allclose(features["c_wind_u"], 0.0, atol=1e-9)


def test_preprocessor_round_trip_and_limits():
    features, targets = build_frames(synthetic_long_frame(200), DELHI, 216.0)
    pre = Preprocessor.fit(features.to_numpy(), targets.to_numpy())
    restored = pre.inverse_targets(pre.transform_targets(targets.to_numpy()))
    assert np.allclose(restored, targets.to_numpy(), atol=1e-3)
    extreme = pre.inverse_targets(np.full((5, 3), -50.0))
    assert (extreme[:, TARGETS.index("precipitation")] >= 0).all()
    assert (extreme[:, TARGETS.index("humidity")] >= 0).all()


def test_preprocessor_rejects_reordered_features():
    features, targets = build_frames(synthetic_long_frame(100), DELHI, 216.0)
    pre = Preprocessor.fit(features.to_numpy(), targets.to_numpy())
    swapped = features[list(reversed(features.columns))]
    with pytest.raises(FeatureOrderError):
        pre.transform_frame(swapped)


def test_scaler_uses_only_rows_it_is_given():
    rng = np.random.default_rng(1)
    train = rng.normal(0, 1, (500, len(FEATURE_ORDER)))
    future = rng.normal(100, 1, (500, len(FEATURE_ORDER)))  # very different "test" data
    targets = np.abs(rng.normal(10, 2, (500, 3)))
    pre = Preprocessor.fit(train, targets)
    assert abs(np.mean(pre.feature_mean)) < 0.5  # not pulled towards the future rows
    assert np.mean(pre.transform_features(future)) > 50


def _toy_dataset() -> Dataset:
    """Two cities, each covering the train/val boundary, with one missing hour."""
    start = pd.Timestamp(SPLITS["train"][1], tz="UTC") - pd.Timedelta(hours=200)
    times = pd.date_range(start, periods=400, freq="h", tz="UTC")
    n = len(times)
    nan_rows = np.zeros(2 * n, dtype=bool)
    nan_rows[50] = True
    return Dataset(
        features=np.zeros((2 * n, len(FEATURE_ORDER))),
        targets=np.zeros((2 * n, 3)),
        times=times.append(times),
        city_of_row=np.repeat([0, 1], n),
        city_offsets=[0, n],
        nan_rows=nan_rows,
    )


@pytest.mark.parametrize("split", ["train", "val"])
def test_windows_stay_inside_split_city_and_clean_rows(split):
    ds = _toy_dataset()
    start, end = (pd.Timestamp(s, tz="UTC") for s in SPLITS[split])
    ends = window_ends(ds, split)
    assert len(ends) > 0
    for t in ends:
        span = np.arange(t - LOOKBACK_HOURS + 1, t + HORIZON_HOURS + 1)
        assert ds.city_of_row[span].min() == ds.city_of_row[span].max()
        assert ds.times[span[0]] >= start and ds.times[span[-1]] <= end
        assert not ds.nan_rows[span].any()


def test_held_out_cities_never_enter_training_windows():
    ds = _toy_dataset()
    ds.cities = (City("a", "A", 20.0, 75.0), City("b", "B", 25.0, 80.0, role="holdout"))
    train_cities = ds.city_indices("train")
    assert train_cities == {0}
    for split in ("train", "val"):
        ends = window_ends(ds, split, cities=train_cities)
        assert len(ends) > 0 and set(ds.city_of_row[ends]) == {0}
    unseen = window_ends(ds, "val", cities=ds.city_indices("holdout"))
    assert set(ds.city_of_row[unseen]) == {1}


def test_india_region_list_is_complete_and_separated():
    from weatherai_ml.config import region_cities
    from weatherai_ml.predict import haversine_km

    cities = region_cities("india")
    train = [c for c in cities if c.role == "train"]
    holdout = [c for c in cities if c.role == "holdout"]
    assert len(train) == 40 and len(holdout) == 8
    assert len({c.id for c in cities}) == len(cities)
    for h in holdout:
        assert min(haversine_km(h.latitude, h.longitude, t.latitude, t.longitude) for t in train) >= 150


def test_residual_targets_are_day_on_day_changes_within_a_city():
    ds = _toy_dataset()
    rng = np.random.default_rng(5)
    ds.targets = rng.normal(20, 5, ds.targets.shape)
    res = residual_targets(ds, (0, 1))
    n = ds.city_offsets[1]
    assert np.allclose(res[30, 0], ds.targets[30, 0] - ds.targets[6, 0])
    assert np.isnan(res[n + 5, 0])  # would reach back into the previous city
    assert np.allclose(res[:, 2], ds.targets[:, 2])  # precipitation stays direct


def test_residual_preprocessor_reconstructs_values():
    rng = np.random.default_rng(6)
    targets = np.column_stack([rng.normal(20, 5, 300), rng.uniform(20, 90, 300), rng.gamma(0.3, 1, 300)])
    yesterday = targets + rng.normal(0, 2, targets.shape)
    changes = targets.copy()
    changes[:, :2] = targets[:, :2] - yesterday[:, :2]
    pre = Preprocessor.fit(np.zeros((300, len(FEATURE_ORDER))), changes, lookback=72, target_mode="residual24")
    restored = pre.inverse_targets(pre.transform_targets(changes), yesterday)
    assert np.allclose(restored, targets, atol=1e-3)
    with pytest.raises(ValueError):
        pre.inverse_targets(pre.transform_targets(changes))


def test_centre_features_match_targets_for_inference_baseline():
    features, targets = build_frames(synthetic_long_frame(72), DELHI, 216.0)
    assert np.allclose(features["c_temp"], targets["temperature"])
    assert np.allclose(features["c_rh"], targets["humidity"])


def test_conformal_halfwidth_reaches_level():
    residuals = np.abs(np.random.default_rng(3).normal(0, 1, 2000))
    hw = conformal_halfwidth(residuals, 0.8)
    assert np.mean(residuals <= hw) >= 0.8


def test_metrics_summary():
    y = np.array([1.0, 2.0, 3.0, 4.0])
    assert summary(y, y)["mae"] == 0
    assert r2(y, y) == 1.0


def test_nearest_city_only_within_range():
    assert nearest_city(28.61, 77.21).id == "delhi"
    assert nearest_city(51.5, -0.12) is None  # London is not covered


TRAINED = [p for p in ("lstm", "gru", "cnn_lstm") if (ARTIFACTS_DIR / p / "model.keras").exists()]


@pytest.mark.skipif(not TRAINED, reason="no trained models yet")
@pytest.mark.parametrize("name", TRAINED)
def test_predictor_outputs_valid_forecast(name):
    predictor = Predictor(ARTIFACTS_DIR / name)
    features, _ = build_frames(synthetic_long_frame(predictor.preprocessor.lookback + 6), DELHI, 216.0)
    pred = predictor.predict(features)
    assert pred.values.shape == (HORIZON_HOURS, len(TARGETS))
    assert np.all(pred.lower <= pred.values + 1e-9) and np.all(pred.values <= pred.upper + 1e-9)
    assert (pred.values[:, TARGETS.index("precipitation")] >= 0).all()
    assert pred.times[0] == pred.issued_at + pd.Timedelta(hours=1)


@pytest.mark.skipif(not TRAINED, reason="no trained models yet")
def test_predictor_uses_last_complete_hour_when_newest_is_incomplete():
    # Regression: one missing neighbour value in the newest hour used to fail the whole forecast.
    predictor = Predictor(ARTIFACTS_DIR / TRAINED[0])
    features, _ = build_frames(synthetic_long_frame(predictor.preprocessor.lookback + 6), DELHI, 216.0)
    features.iloc[-1, features.columns.get_loc("n_temp")] = np.nan
    pred = predictor.predict(features)
    assert pred.issued_at == features.index[-2]
    assert np.isfinite(pred.values).all()


@pytest.mark.skipif(not TRAINED, reason="no trained models yet")
def test_predictor_refuses_gappy_history():
    predictor = Predictor(ARTIFACTS_DIR / TRAINED[0])
    features, _ = build_frames(synthetic_long_frame(predictor.preprocessor.lookback + 6), DELHI, 216.0)
    features.iloc[-10, 0] = np.nan
    with pytest.raises(InsufficientHistoryError):
        predictor.predict(features)
