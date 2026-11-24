"""The export behind the public copy (scripts/export_public_data.py): every file the website reads,
built from the API's own answers, with no server or database."""

from __future__ import annotations

import json

import pytest

from app import predictions
from app.registry import get_registry
from scripts import export_public_data
from weatherai_ml.synthetic import synthetic_long_frame

pytestmark = pytest.mark.skipif(not get_registry().names, reason="no trained models in ml/artifacts")


def test_export_writes_every_file_and_skips_a_failed_city(tmp_path, monkeypatch):
    def fetch(client, city, past_hours):
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
    assert "leh" not in index["cities"] and len(index["cities"]) == len(cities) - 1
    assert not (tmp_path / "predictions" / "leh.json").exists()

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
        asked.append(city.id)
        raise RuntimeError("Open-Meteo kept rate-limiting the request")

    monkeypatch.setattr(predictions, "fetch_recent", refuse)
    monkeypatch.setattr(export_public_data.time, "sleep", lambda s: None)
    predictions._cache.clear()

    missing = export_public_data.export(tmp_path)

    # Five refusals in a row and the rest aren't asked; with nothing published before, none has a forecast.
    assert len(asked) == export_public_data.GIVE_UP_AFTER
    assert missing == len(json.loads((tmp_path / "coverage.json").read_text(encoding="utf-8")))
    assert json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))["cities"] == []
