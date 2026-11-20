"""Assistant tests. Hosted is replaced by a scripted fake client and Open-Meteo by
fixed data, so these run offline and never call (or bill) the Hosted API."""

from __future__ import annotations

import json
from datetime import date
from types import SimpleNamespace

import pytest

from app import assistant, assistant_data
from app.registry import get_registry

PLACE = {"name": "Jaipur", "latitude": 26.9196, "longitude": 75.7878, "country_code": "IN"}
CLIENT = {"X-Client-Id": "test-client-0001"}


def text(t):
    return SimpleNamespace(type="text", text=t)


def tool_use(id_, name, args):
    return SimpleNamespace(type="tool_use", id=id_, name=name, input=args)


def response(stop_reason, *content, model="hosted-opus-5-5"):
    return SimpleNamespace(stop_reason=stop_reason, content=list(content), model=model, usage=SimpleNamespace(input_tokens=1000, output_tokens=100))


class FakeClient:
    """Plays back scripted responses and records every request."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests: list[dict] = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    def create(self, **kwargs):
        self.requests.append(json.loads(json.dumps(kwargs, default=lambda o: o.__dict__)))
        return self.responses.pop(0)


FAKE_WEATHER = {"source": "Open-Meteo forecast (test data)", "now": {"temperature_c": 24.0, "sky": "clear sky"}}


@pytest.fixture()
def stub_weather(monkeypatch):
    monkeypatch.setattr(assistant_data, "weather", lambda lat, lon: FAKE_WEATHER)


def ask(client, question="Will it rain tomorrow?", place=PLACE):
    from app import db

    with db.new_session() as session:
        return assistant.answer([{"role": "user", "content": question}], place, session, get_registry(), client=client)


# ---- the loop -------------------------------------------------------------------------


def test_looks_up_data_then_answers(client, stub_weather):
    fake = FakeClient(
        response("tool_use", tool_use("t1", "get_weather", {"latitude": 26.92, "longitude": 75.79})),
        response("end_turn", text("Open-Meteo's forecast shows 24 °C and clear skies now.")),
    )
    reply = ask(fake)
    assert reply.text.startswith("Open-Meteo's forecast")
    assert reply.sources == ["Open-Meteo forecast"] and reply.rounds == 2
    second = fake.requests[1]["messages"]
    result = second[-1]["content"][0]
    assert result["type"] == "tool_result" and result["tool_use_id"] == "t1"
    assert json.loads(result["content"]) == FAKE_WEATHER


def test_request_shape(client, stub_weather):
    fake = FakeClient(response("end_turn", text("Hello.")))
    ask(fake)
    req = fake.requests[0]
    assert req["model"] == "hosted-opus-5-5"
    assert req["output_config"] == {"effort": "low"}
    assert req["fallbacks"] == "default" and req["betas"] == ["server-side-fallback-2026-07-01"]
    assert all(t["strict"] and t["input_schema"]["additionalProperties"] is False for t in req["tools"])
    assert req["tools"][-1]["cache_control"] == {"type": "ephemeral"}
    assert "Answer only from data you looked up" in req["system"][0]["text"]
    assert "Jaipur" in req["messages"][0]["content"] and req["messages"][-1]["content"] == "Will it rain tomorrow?"
    assert "tool_choice" not in req  # forcing a tool is rejected by current models


def test_no_fallback_for_models_without_it(client, monkeypatch, stub_weather):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "assistant_model", "hosted-haiku-5-5")
    fake = FakeClient(response("end_turn", text("Hi."), model="hosted-haiku-5-5"))
    ask(fake)
    assert "fallbacks" not in fake.requests[0] and fake.requests[0]["model"] == "hosted-haiku-5-5"


def test_refusal_gets_a_polite_reply(client):
    reply = ask(FakeClient(response("refusal")))
    assert "weather" in reply.text


def test_failed_lookup_is_reported_to_the_model(client, monkeypatch):
    def broken(lat, lon):
        raise RuntimeError("Open-Meteo couldn't be reached.")

    monkeypatch.setattr(assistant_data, "weather", broken)
    fake = FakeClient(
        response("tool_use", tool_use("t1", "get_weather", {"latitude": 1.0, "longitude": 2.0})),
        response("end_turn", text("I couldn't get the forecast right now.")),
    )
    reply = ask(fake)
    result = fake.requests[1]["messages"][-1]["content"][0]
    assert result["is_error"] is True and "couldn't be reached" in result["content"]
    assert reply.text.startswith("I couldn't")


def test_out_of_range_coordinates_are_refused(client):
    fake = FakeClient(
        response("tool_use", tool_use("t1", "get_weather", {"latitude": 123.0, "longitude": 2.0})),
        response("end_turn", text("That place isn't valid.")),
    )
    ask(fake)
    assert fake.requests[1]["messages"][-1]["content"][0]["is_error"] is True


def test_rounds_are_capped(client, stub_weather):
    loop = [response("tool_use", tool_use(f"t{i}", "get_weather", {"latitude": 1.0, "longitude": 2.0})) for i in range(assistant.MAX_ROUNDS)]
    fake = FakeClient(*loop)
    reply = ask(fake)
    assert len(fake.requests) == assistant.MAX_ROUNDS
    assert "more lookups" in reply.text


def test_prediction_outside_coverage_says_so():
    out = assistant_data.weatherai_prediction(get_registry(), 51.5, -0.12)
    assert out["available"] is False and "Jaipur" in out["covered_cities"]


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
    assert out["next_7_days"][0]["sky"] == "overcast" and "not WeatherAI" in out["source"]
    assert (out["next_7_days"][0]["humidity_low_pct"], out["next_7_days"][0]["humidity_high_pct"]) == (22, 68)


def test_nan_becomes_null():
    assert assistant_data.nan_safe({"a": [1.0, float("nan")]}) == {"a": [1.0, None]}


# ---- limits ---------------------------------------------------------------------------


def test_daily_limits(monkeypatch):
    limits = assistant.DailyLimits()
    limits.take("a", per_client=2, total=3)
    limits.take("a", per_client=2, total=3)
    with pytest.raises(assistant.AssistantUnavailable) as e:
        limits.take("a", per_client=2, total=3)
    assert e.value.code == "client_limit"
    limits.take("b", per_client=2, total=3)
    with pytest.raises(assistant.AssistantUnavailable) as e:
        limits.take("c", per_client=2, total=3)
    assert e.value.code == "daily_limit"
    limits.give_back("b")
    limits.take("c", per_client=2, total=3)  # a refunded question frees a slot
    limits._day = date(2000, 1, 1)  # a new day resets everything
    limits.take("a", per_client=2, total=3)


# ---- endpoint -------------------------------------------------------------------------


def body(question="Will it rain?"):
    return {"messages": [{"role": "user", "content": question}], "place": PLACE}


def test_status_and_unconfigured(client, monkeypatch):
    monkeypatch.setattr(assistant, "api_key", lambda: None)
    status = client.get("/api/assistant/status").json()
    assert status["configured"] is False and status["model"] == "hosted-opus-5-5"
    r = client.post("/api/assistant", json=body(), headers=CLIENT)
    assert r.status_code == 503 and r.json()["code"] == "assistant_not_configured"


def test_endpoint_answers_and_enforces_limits(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(assistant, "api_key", lambda: "test-key-not-real")
    monkeypatch.setattr(assistant, "LIMITS", assistant.DailyLimits())
    monkeypatch.setattr(get_settings(), "assistant_daily_limit_per_client", 2)
    monkeypatch.setattr(
        assistant, "answer",
        lambda conv, place, session, registry: assistant.Reply(text=f"About {place['name']}.", sources=["Open-Meteo forecast"], model="hosted-opus-5-5"),
    )
    r = client.post("/api/assistant", json=body(), headers=CLIENT)
    assert r.status_code == 200, r.text
    assert r.json() == {"reply": "About Jaipur.", "sources": ["Open-Meteo forecast"], "model": "hosted-opus-5-5"}
    assert client.post("/api/assistant", json=body(), headers=CLIENT).status_code == 200
    limited = client.post("/api/assistant", json=body(), headers=CLIENT)
    assert limited.status_code == 429 and limited.json()["code"] == "client_limit"


def test_endpoint_validation(client, monkeypatch):
    monkeypatch.setattr(assistant, "api_key", lambda: "test-key-not-real")
    last_is_answer = {"messages": [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}], "place": PLACE}
    assert client.post("/api/assistant", json=last_is_answer, headers=CLIENT).status_code == 422
    too_long = body("x" * 2001)
    assert client.post("/api/assistant", json=too_long, headers=CLIENT).status_code == 422
    bad_place = {**body(), "place": {**PLACE, "latitude": 95}}
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
