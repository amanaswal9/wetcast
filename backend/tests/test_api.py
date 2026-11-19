"""API tests. The Open-Meteo call is replaced with synthetic data so tests are
offline and deterministic; the models and pipeline are the real ones."""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import func, select

from app import db, predictions
from app.registry import get_registry
from weatherai_ml.synthetic import synthetic_long_frame

HAS_MODELS = bool(get_registry().names)
CLIENT = {"X-Client-Id": "test-client-0001"}


def fake_fetch(client, city, past_hours):
    return synthetic_long_frame(past_hours), 0.0


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["database"] == "ok"


def test_coverage_lists_ten_cities(client):
    r = client.get("/api/coverage")
    assert r.status_code == 200
    assert {c["id"] for c in r.json()} >= {"delhi", "jaipur", "lucknow"}
    assert len(r.json()) == 10


def test_predictions_reject_bad_coordinates(client):
    assert client.get("/api/predictions", params={"latitude": 200, "longitude": 0}).status_code == 422


def test_predictions_outside_region_says_unsupported(client):
    r = client.get("/api/predictions", params={"latitude": 51.5, "longitude": -0.12})
    assert r.status_code == 404
    body = r.json()
    assert body["code"] == "unsupported_location"
    assert len(body["supported"]) == 10


@pytest.mark.skipif(not HAS_MODELS, reason="no trained models yet")
def test_predictions_for_delhi(client, monkeypatch):
    monkeypatch.setattr(predictions, "fetch_recent", fake_fetch)
    r = client.get("/api/predictions", params={"latitude": 28.61, "longitude": 77.21})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["city"]["id"] == "delhi"
    assert len(body["models"]) == len(get_registry().names)
    for model in body["models"]:
        assert len(model["points"]) == 24
        for p in model["points"]:
            assert p["temperature_lower"] <= p["temperature"] <= p["temperature_upper"]
            assert p["precipitation"] >= 0

    # The run is stored once, even if requested again.
    client.get("/api/predictions", params={"latitude": 28.61, "longitude": 77.21})
    with next(db.get_session()) as session:
        runs = session.scalar(select(func.count()).select_from(db.PredictionRun))
    assert runs == len(get_registry().names)


@pytest.mark.skipif("ensemble" not in get_registry().names, reason="ensemble not built")
def test_ensemble_prediction_is_mean_of_members(client, monkeypatch):
    monkeypatch.setattr(predictions, "fetch_recent", fake_fetch)
    r = client.get("/api/predictions", params={"latitude": 28.61, "longitude": 77.21})
    assert r.status_code == 200
    by_model = {m["model"]: m["points"] for m in r.json()["models"]}
    members = get_registry().metrics("ensemble")["members"]
    assert set(members) <= set(by_model)
    for i in (0, 11, 23):
        mean = sum(by_model[m][i]["temperature"] for m in members) / len(members)
        assert abs(by_model["ensemble"][i]["temperature"] - mean) < 0.02  # values are rounded to 0.01


def test_registry_refuses_ensemble_with_missing_member(tmp_path):
    import shutil

    from app.config import get_settings
    from app.registry import ModelRegistry

    real = get_settings().artifacts_dir
    if not (real / "ensemble" / "ensemble.json").exists():
        pytest.skip("ensemble not built")
    shutil.copytree(real / "ensemble", tmp_path / "ensemble")
    shutil.copytree(real / "lstm", tmp_path / "lstm")  # the other members deliberately missing
    registry = ModelRegistry(tmp_path)
    assert registry.names == ["lstm"]


@pytest.mark.skipif("lightgbm" not in get_registry().names, reason="LightGBM not trained")
def test_lightgbm_is_served(client, monkeypatch):
    monkeypatch.setattr(predictions, "fetch_recent", fake_fetch)
    r = client.get("/api/predictions", params={"latitude": 28.61, "longitude": 77.21, "models": "lightgbm"})
    assert r.status_code == 200
    points = r.json()["models"][0]["points"]
    assert len(points) == 24 and all(p["precipitation"] >= 0 for p in points)
    assert client.get("/api/models/lightgbm").json()["kind"] == "gbm"


@pytest.mark.skipif(not HAS_MODELS, reason="no trained models yet")
def test_unknown_model_is_rejected(client, monkeypatch):
    monkeypatch.setattr(predictions, "fetch_recent", fake_fetch)
    r = client.get("/api/predictions", params={"latitude": 28.61, "longitude": 77.21, "models": "no_such_model"})
    assert r.status_code == 400


@pytest.mark.skipif("transformer" not in get_registry().names, reason="transformer not trained")
def test_transformer_is_served(client, monkeypatch):
    monkeypatch.setattr(predictions, "fetch_recent", fake_fetch)
    r = client.get("/api/predictions", params={"latitude": 28.61, "longitude": 77.21, "models": "transformer"})
    assert r.status_code == 200, r.text
    model = r.json()["models"][0]
    assert model["display_name"] == "ST-Transformer" and len(model["points"]) == 24


@pytest.mark.skipif(not HAS_MODELS, reason="no trained models yet")
def test_upstream_failure_is_502(client, monkeypatch):
    def broken(*_args, **_kwargs):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(predictions, "fetch_recent", broken)
    r = client.get("/api/predictions", params={"latitude": 26.91, "longitude": 75.79})
    assert r.status_code == 502


@pytest.mark.skipif(not HAS_MODELS, reason="no trained models yet")
def test_models_and_evaluation(client):
    r = client.get("/api/models")
    assert r.status_code == 200
    first = r.json()["models"][0]
    assert {"mae", "rmse", "r2"} <= set(first["test"]["temperature"])
    assert client.get(f"/api/models/{first['model']}/evaluation").status_code == 200
    assert client.get("/api/models/unknown").status_code == 404


def test_places_crud(client):
    place = {"place_id": "1273294", "name": "Delhi", "country": "India", "latitude": 28.65, "longitude": 77.23}
    assert client.get("/api/places", headers={"X-Client-Id": "bad id!"}).status_code == 400
    assert client.post("/api/places", json=place, headers=CLIENT).status_code == 201
    assert client.post("/api/places", json=place, headers=CLIENT).status_code == 201  # idempotent
    assert len(client.get("/api/places", headers=CLIENT).json()) == 1
    assert client.put("/api/places/1273294/home", headers=CLIENT).json()["is_home"] is True
    assert client.get("/api/places", headers={"X-Client-Id": "another-client-01"}).json() == []
    assert client.delete("/api/places/1273294", headers=CLIENT).status_code == 204
    assert client.get("/api/places", headers=CLIENT).json() == []


def test_places_limit(client):
    for i in range(8):
        body = {"place_id": f"p{i}", "name": f"Place {i}", "latitude": 10 + i, "longitude": 10}
        assert client.post("/api/places", json=body, headers=CLIENT).status_code == 201
    extra = {"place_id": "p9", "name": "One too many", "latitude": 1, "longitude": 1}
    assert client.post("/api/places", json=extra, headers=CLIENT).status_code == 409
    # Regression: re-saving a place that is already saved must still succeed at the limit.
    again = {"place_id": "p0", "name": "Place 0", "latitude": 10, "longitude": 10}
    assert client.post("/api/places", json=again, headers=CLIENT).status_code == 201


def test_places_replace_and_unset_home(client):
    places = [
        {"place_id": "a1", "name": "Delhi", "country": "India", "latitude": 28.6, "longitude": 77.2},
        {"place_id": "b2", "name": "Jaipur", "country": "India", "latitude": 26.9, "longitude": 75.8},
    ]
    r = client.put("/api/places", json={"places": places, "home_place_id": "b2"}, headers=CLIENT)
    assert r.status_code == 200
    assert [p["place_id"] for p in r.json()] == ["a1", "b2"]
    assert [p["is_home"] for p in r.json()] == [False, True]

    # Replacing again is a full overwrite, not a merge.
    r = client.put("/api/places", json={"places": places[:1], "home_place_id": None}, headers=CLIENT)
    assert [p["place_id"] for p in client.get("/api/places", headers=CLIENT).json()] == ["a1"]

    client.put("/api/places/a1/home", headers=CLIENT)
    assert client.delete("/api/places/a1/home", headers=CLIENT).status_code == 204
    assert client.get("/api/places", headers=CLIENT).json()[0]["is_home"] is False


def test_places_replace_validates(client):
    one = {"place_id": "a1", "name": "Delhi", "latitude": 28.6, "longitude": 77.2}
    assert client.put("/api/places", json={"places": [one, one]}, headers=CLIENT).status_code == 422
    assert client.put("/api/places", json={"places": [one], "home_place_id": "zz"}, headers=CLIENT).status_code == 422
    nine = [{**one, "place_id": f"p{i}"} for i in range(9)]
    assert client.put("/api/places", json={"places": nine}, headers=CLIENT).status_code == 422


def test_places_validate_coordinates(client):
    bad = {"place_id": "x", "name": "Nowhere", "latitude": 95, "longitude": 0}
    assert client.post("/api/places", json=bad, headers=CLIENT).status_code == 422
