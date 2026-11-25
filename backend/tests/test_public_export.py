"""The export behind the public copy (scripts/export_public_data.py): every file the website reads,
built from the API's own answers, with no server or database."""

from __future__ import annotations

import json

import pytest

from app import coverage, predictions
from app.registry import get_registry
from scripts import export_public_data
from weatherai_ml.synthetic import synthetic_long_frame

pytestmark = pytest.mark.skipif(not get_registry().names, reason="no trained models in ml/artifacts")


def test_export_writes_every_file_and_skips_a_failed_city(tmp_path, monkeypatch):
    def fetch(client, city, past_hours):
        """Fake Open-Meteo: synthetic history for every city except Leh, which fails."""
        if city.id == "leh":
            raise RuntimeError("Open-Meteo is down for this one")
        return synthetic_long_frame(past_hours), 0.0

    monkeypatch.setattr(predictions, "fetch_recent", fetch)
    monkeypatch.setattr(export_public_data, "PAUSE_SECONDS", 0)
    monkeypatch.setattr(export_public_data.time, "sleep", lambda s: None)
    predictions._cache.clear()

    failed = export_public_data.export(tmp_path)

    read = lambda *parts: json.loads(tmp_path.joinpath(*parts).read_text(encoding="utf-8"))  # noqa: E731
    cities = read("coverage.json")
    assert failed == 1
    assert {m["model"] for m in read("models.json")["models"]} == set(get_registry().names)

    index = read("index.json")
    more = read("more_cities.json")
    assert "leh" not in index["cities"] and len(index["cities"]) == len(cities) - 1 + len(more)
    assert not (tmp_path / "predictions" / "leh.json").exists()

    # The extra cities: every one listed, none among the models' own, each forecast under its own name.
    assert len(more) == len(coverage.extra_cities("india")) > 0
    assert not {c["id"] for c in more} & {c["id"] for c in cities}
    pune = read("predictions", "pune.json")
    assert pune["city"] == {"id": "pune", "name": "Pune", "latitude": 18.5196, "longitude": 73.8554, "role": None}
    assert pune["coverage"]["kind"] == "untrained"

    delhi = read("predictions", "delhi.json")
    assert delhi["city"]["id"] == "delhi" and delhi["coverage"]["kind"] == "trained"
    assert {m["model"] for m in delhi["models"]} == set(get_registry().names)
    assert len(delhi["models"][0]["points"]) == 24

    # The summary has no samples; each city's file has that city's samples only.
    assert "samples" not in read("evaluation", "lstm.json")
    assert list(read("evaluation", "lstm", "delhi.json")["samples"]) == ["delhi"]


def test_export_stops_asking_when_open_meteo_keeps_refusing(tmp_path, monkeypatch):
    asked = []

    def refuse(client, city, past_hours):
        """Fake Open-Meteo that records each city asked for and always refuses."""
        asked.append(city.id)
        raise RuntimeError("Open-Meteo kept rate-limiting the request")

    monkeypatch.setattr(predictions, "fetch_recent", refuse)
    monkeypatch.setattr(export_public_data.time, "sleep", lambda s: None)
    predictions._cache.clear()

    missing = export_public_data.export(tmp_path)

    # Five refusals in a row and the rest aren't asked, the extra cities included; with nothing
    # published before, none has a forecast.
    assert len(asked) == export_public_data.GIVE_UP_AFTER
    assert json.loads((tmp_path / "more_cities.json").read_text(encoding="utf-8")) == []
    assert missing == len(json.loads((tmp_path / "coverage.json").read_text(encoding="utf-8")))
    assert json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))["cities"] == []


def test_export_uses_one_batched_fetch_for_every_city(tmp_path, monkeypatch):
    def batched(client, cities, past_hours):
        """Fake batched fetch: synthetic history for every city at once."""
        return {c.id: (synthetic_long_frame(past_hours), 0.0) for c in cities}

    def single(client, city, past_hours):
        """Fail the test if a city is fetched on its own."""
        raise AssertionError(f"{city.id} was fetched on its own")

    monkeypatch.setattr(predictions, "fetch_recent_many", batched)
    monkeypatch.setattr(predictions, "fetch_recent", single)
    monkeypatch.setattr(export_public_data.time, "sleep", lambda s: None)
    predictions._cache.clear()

    assert export_public_data.export(tmp_path) == 0
    index = json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))
    assert len(index["fresh"]) == len(json.loads((tmp_path / "coverage.json").read_text(encoding="utf-8"))) + len(coverage.extra_cities("india"))
