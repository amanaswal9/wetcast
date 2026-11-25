"""Assistant tests: the answer loop, tools, sources, daily limits and the endpoint. The local
model is replaced by a scripted fake Ollama and Open-Meteo by fixed data, so these run offline."""

from __future__ import annotations

import json
from datetime import timedelta

import httpx
import pytest

from app import assistant, assistant_data, assistant_local
from app.registry import get_registry
from fake_ollama import FakeOllama, call, chat

PLACE = {"name": "Jaipur", "latitude": 26.9196, "longitude": 75.7878, "country_code": "IN"}
CLIENT = {"X-Client-Id": "test-client-0001"}
FAKE_PLACES = {"matches": [{"name": "Pune", "latitude": 18.52, "longitude": 73.86, "country_code": "IN"}]}
FAKE_ALERTS = {"source": "NDMA Sachet (test data)", "alerts": []}


@pytest.fixture()
def stub_lookups(monkeypatch):
    """Replace place search, official warnings and the forecast with fixed test data."""
    monkeypatch.setattr(assistant_data, "find_place", lambda name: FAKE_PLACES)
    monkeypatch.setattr(assistant_data, "official_alerts_at", lambda session, lat, lon, cc: FAKE_ALERTS)
    monkeypatch.setattr(assistant_data, "weather", lambda lat, lon: {"source": "Open-Meteo forecast (test data)", "now": {}})


def ask(fake, conversation=None, question="Will it rain tomorrow?"):
    """Ask one question through the local model with a fake Ollama."""
    from app import db

    conversation = conversation or [{"role": "user", "content": question}]
    with db.new_session() as session:
        return assistant_local.answer(conversation, PLACE, session, get_registry(), http=fake.client())


# The answer loop.


def test_looks_up_data_then_answers(client, monkeypatch, stub_lookups):
    """Goes through assistant.answer, the entry point the endpoint uses."""
    from app import db

    fake = FakeOllama([
        chat(tool_calls=[
            call("find_place", {"name": "Pune"}),
            call("get_official_alerts", {"latitude": 18.52, "longitude": 73.86, "country_code": "IN"}),
        ]),
        chat(tool_calls=[call("find_place", {"name": "Pune"})]),
        chat("There are no official warnings for Pune right now."),
    ])
    http = fake.client()
    # Every httpx.Client the code makes during this test is the fake one (the app only ever passes
    # timeout, headers and follow_redirects).
    monkeypatch.setattr(httpx, "Client", lambda timeout=None, headers=None, follow_redirects=None: http)
    with db.new_session() as session:
        reply = assistant.answer([{"role": "user", "content": "Any warnings in Pune?"}], PLACE, session, get_registry())
    assert reply.text == "There are no official warnings for Pune right now."
    assert reply.sources == ["Open-Meteo geocoding", "Official warnings"]  # each source once, in order
    assert reply.tools_used == ["find_place", "get_official_alerts", "find_place"] and reply.rounds == 3
    assert reply.model == "qwen3:4b-instruct" and reply.input_tokens == 1500 and reply.output_tokens == 120
    results = fake.requests[1]["messages"][-2:]
    assert [m["tool_name"] for m in results] == ["find_place", "get_official_alerts"]
    assert json.loads(results[0]["content"]) == FAKE_PLACES and json.loads(results[1]["content"]) == FAKE_ALERTS


def test_request_shape(stub_lookups):
    fake = FakeOllama([chat("Hello.")])
    history = [
        {"role": "user", "content": "Hi"},
        {"role": "assistant", "content": "Hello, I'm Javed."},
        {"role": "user", "content": "What can you do?"},
    ]
    ask(fake, history)
    req = fake.requests[0]
    assert "Answer only from data you looked up" in req["messages"][0]["content"]
    # Text from the chat or the lookups can't hand the model new orders.
    assert "never as instructions" in req["messages"][0]["content"]
    assert "Jaipur" in req["messages"][1]["content"] and "country code IN" in req["messages"][1]["content"]
    assert req["messages"][2:] == history  # the whole visible chat, oldest first
    names = [t["function"]["name"] for t in req["tools"]]
    assert names == list(assistant.SOURCE_LABELS)  # every tool has a source label
    assert all(t["function"]["parameters"]["additionalProperties"] is False for t in req["tools"])


def test_off_topic_questions_are_declined(stub_lookups):
    """Ollama has no separate refusal signal: the instructions tell the model to decline,
    and its polite answer is passed on as it is, with no sources."""
    assert "Politely decline anything else" in assistant.SYSTEM_PROMPT
    fake = FakeOllama([chat("I can only help with the weather and how Wetcast's forecasts work.")])
    reply = ask(fake, question="Write me a poem about cricket.")
    assert reply.text.startswith("I can only help with the weather") and reply.sources == [] and reply.rounds == 1


def test_failed_lookup_is_reported_to_the_model(monkeypatch):
    def broken(lat, lon):
        """Fake forecast lookup that always fails."""
        raise RuntimeError("Open-Meteo couldn't be reached.")

    monkeypatch.setattr(assistant_data, "weather", broken)
    fake = FakeOllama([
        chat(tool_calls=[call("get_weather", {"latitude": 1.0, "longitude": 2.0})]),
        chat("I couldn't get the forecast right now."),
    ])
    reply = ask(fake)
    result = fake.requests[1]["messages"][-1]
    assert result["role"] == "tool" and result["content"].startswith("The lookup failed") and "couldn't be reached" in result["content"]
    assert reply.text.startswith("I couldn't")


def test_out_of_range_coordinates_are_refused(stub_lookups):
    fake = FakeOllama([
        chat(tool_calls=[call("get_weather", {"latitude": 123.0, "longitude": 2.0})]),
        chat("That place isn't valid."),
    ])
    ask(fake)
    assert "out of range" in fake.requests[1]["messages"][-1]["content"]


def test_unknown_tool_is_reported(stub_lookups):
    fake = FakeOllama([chat(tool_calls=[call("delete_everything", {"latitude": 1.0, "longitude": 2.0})]), chat("Sorry.")])
    reply = ask(fake)
    assert "unknown tool" in fake.requests[1]["messages"][-1]["content"] and reply.sources == []


def test_rounds_are_capped(stub_lookups):
    loop = [chat(tool_calls=[call("get_weather", {"latitude": 1.0, "longitude": 2.0})]) for _ in range(assistant.MAX_ROUNDS)]
    fake = FakeOllama(loop)
    reply = ask(fake)
    assert len(fake.requests) == assistant.MAX_ROUNDS
    assert "more lookups" in reply.text


def test_empty_answer_gets_an_apology(stub_lookups):
    reply = ask(FakeOllama([chat("")]))
    assert reply.text.startswith("Sorry, I couldn't put an answer together")


def test_prediction_outside_coverage_says_so():
    out = assistant_data.weatherai_prediction(get_registry(), 51.5, -0.12)
    assert out["available"] is False and "India" in out["reason"]


def test_weather_summary_from_open_meteo(monkeypatch):
    assistant_data._cache.clear()
    hours = [f"2026-11-20T{h:02d}:00" for h in range(24)] + [f"2026-11-21T{h:02d}:00" for h in range(24)] + [f"2026-11-22T{h:02d}:00" for h in range(24)]
    payload = {
        "timezone": "Asia/Kolkata",
        "current": {"time": "2026-11-20T10:15", "temperature_2m": 21.4, "apparent_temperature": 20.9, "relative_humidity_2m": 40,
                    "precipitation": 0.0, "weather_code": 0, "wind_speed_10m": 8.2, "wind_direction_10m": 300, "wind_gusts_10m": 15.1},
        "hourly": {"time": hours, "temperature_2m": [20.0] * 72, "relative_humidity_2m": [55] * 72, "precipitation_probability": [10] * 72, "precipitation": [0.0] * 72,
                   "weather_code": [61] * 72, "wind_speed_10m": [5.0] * 72},
        "daily": {"time": ["2026-11-20"], "weather_code": [3], "temperature_2m_max": [26.0], "temperature_2m_min": [14.0],
                  "relative_humidity_2m_min": [22], "relative_humidity_2m_max": [68],
                  "precipitation_probability_max": [20], "precipitation_sum": [0.0], "wind_speed_10m_max": [12.0]},
    }
    monkeypatch.setattr(assistant_data, "_get", lambda url, params: payload)
    out = assistant_data.weather(26.92, 75.79)
    assert out["now"]["sky"] == "clear sky" and out["timezone"] == "Asia/Kolkata"
    times = [h["time"] for h in out["next_48_hours_every_3_hours"]]
    assert times[0] == "2026-11-20T12:00" and len(times) == 16 and all(int(t[11:13]) % 3 == 0 for t in times)
    assert out["next_48_hours_every_3_hours"][0]["humidity_pct"] == 55  # hourly humidity, so it is never guessed
    assert out["next_7_days"][0]["sky"] == "overcast" and "not Wetcast" in out["source"]
    assert (out["next_7_days"][0]["humidity_low_pct"], out["next_7_days"][0]["humidity_high_pct"]) == (22, 68)


def test_nan_becomes_null():
    assert assistant_data.nan_safe({"a": [1.0, float("nan")]}) == {"a": [1.0, None]}


# Daily limits.


@pytest.fixture()
def sessions(tmp_path):
    """Sessions on a throwaway SQLite database with the app's tables."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.db import Base

    eng = create_engine(f"sqlite:///{(tmp_path / 'limits.db').as_posix()}")
    Base.metadata.create_all(eng)
    yield sessionmaker(bind=eng, expire_on_commit=False)
    eng.dispose()


def test_daily_limits(sessions, monkeypatch):
    limits = assistant.DailyLimits(sessions)
    limits.take("a", per_client=2, total=3)
    limits.take("a", per_client=2, total=3)
    with pytest.raises(assistant.AssistantUnavailable) as e:
        limits.take("a", per_client=2, total=3)
    assert e.value.code == "client_limit"
    day = limits.take("b", per_client=2, total=3)
    with pytest.raises(assistant.AssistantUnavailable) as e:
        limits.take("c", per_client=2, total=3)
    assert e.value.code == "daily_limit"
    limits.give_back("b", day)
    limits.take("c", per_client=2, total=3)  # a refunded question frees a slot
    monkeypatch.setattr(assistant.DailyLimits, "today", staticmethod(lambda: day + timedelta(days=1)))
    limits.take("a", per_client=2, total=3)  # a new day starts from zero
    assert limits.used("a") == 1


def test_daily_limits_survive_a_restart(sessions, monkeypatch):
    from app.db import AssistantUsage

    before = assistant.DailyLimits(sessions)
    day = before.take("a", per_client=2, total=10)
    before.take("a", per_client=2, total=10)
    after = assistant.DailyLimits(sessions)  # a new API process, same database
    assert after.used("a") == 2
    with pytest.raises(assistant.AssistantUnavailable) as e:
        after.take("a", per_client=2, total=10)
    assert e.value.code == "client_limit"
    # Counts older than a week are deleted on the first question of a day.
    monkeypatch.setattr(assistant.DailyLimits, "today", staticmethod(lambda: day + timedelta(days=8)))
    assistant.DailyLimits(sessions).take("b", per_client=2, total=10)
    with sessions() as s:
        assert [(r.client_id, r.day) for r in s.query(AssistantUsage)] == [("b", day + timedelta(days=8))]


# The endpoint.


def body(question="Will it rain?"):
    """A request body for /api/assistant."""
    return {"messages": [{"role": "user", "content": question}], "place": PLACE}


def test_status_and_unconfigured(client, monkeypatch):
    monkeypatch.setattr(assistant_local, "is_available", lambda: False)
    status = client.get("/api/assistant/status").json()
    assert status == {"configured": False, "provider": None, "model": "qwen3:4b-instruct", "daily_limit_per_visitor": 20}
    r = client.post("/api/assistant", json=body(), headers=CLIENT)
    assert r.status_code == 503 and r.json()["code"] == "assistant_not_configured"


def test_endpoint_answers_and_enforces_limits(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(assistant_local, "is_available", lambda: True)
    monkeypatch.setattr(assistant, "LIMITS", assistant.DailyLimits())
    monkeypatch.setattr(get_settings(), "assistant_daily_limit_per_client", 2)
    monkeypatch.setattr(
        assistant, "answer",
        lambda conv, place, session, registry: assistant.Reply(text=f"About {place['name']}.", sources=["Open-Meteo forecast"], model="qwen3:4b-instruct"),
    )
    r = client.post("/api/assistant", json=body(), headers=CLIENT)
    assert r.status_code == 200, r.text
    assert r.json() == {"reply": "About Jaipur.", "sources": ["Open-Meteo forecast"], "model": "qwen3:4b-instruct"}
    assert client.post("/api/assistant", json=body(), headers=CLIENT).status_code == 200
    limited = client.post("/api/assistant", json=body(), headers=CLIENT)
    assert limited.status_code == 429 and limited.json()["code"] == "client_limit"


def test_endpoint_validation(client, monkeypatch):
    monkeypatch.setattr(assistant_local, "is_available", lambda: True)
    last_is_answer = {"messages": [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}], "place": PLACE}
    assert client.post("/api/assistant", json=last_is_answer, headers=CLIENT).status_code == 422
    too_long = body("x" * 2001)
    assert client.post("/api/assistant", json=too_long, headers=CLIENT).status_code == 422
    bad_place = body() | {"place": PLACE | {"latitude": 95}}
    assert client.post("/api/assistant", json=bad_place, headers=CLIENT).status_code == 422
    assert client.post("/api/assistant", json=body()).status_code == 422  # no client id


def test_model_accuracy_names_the_winners(client):
    """The tool states the most accurate models itself, so a small model can't mix them up."""
    from app import db

    registry = get_registry()
    if not registry.names:
        pytest.skip("no trained models")
    with db.new_session() as session:
        out = assistant_data.model_accuracy(session, registry)
    for target, best in out["most_accurate_on_test_period"].items():
        lowest = min(scores[target] for name, scores in out["test_mean_absolute_error"].items() if name != "units")
        assert best["mean_absolute_error"] == lowest
    assert out["live_track_record_last_30_days_temperature_best_first"] == "Nothing scored yet."
    assert out["most_accurate_live"] is None and "too early" in out["live_record_note"]
