"""Local-model assistant tests. Ollama is replaced by a scripted fake HTTP transport, so these
run offline and never need a model installed."""

from __future__ import annotations

import pytest

from app import assistant, assistant_data, assistant_local
from app.registry import get_registry
from fake_ollama import FakeOllama, call, chat

PLACE = {"name": "Jaipur", "latitude": 26.9196, "longitude": 75.7878, "country_code": "IN"}
CLIENT = {"X-Client-Id": "test-client-0002"}
FAKE_WEATHER = {
    "source": "Open-Meteo forecast (test data)",
    "timezone": "Asia/Kolkata",
    "local_time_now": "2026-11-20T13:30",
    "now": {"temperature_c": 24.0, "feels_like_c": 25.0, "humidity_pct": 49, "sky": "clear sky", "wind_kmh": 4, "rain_last_hour_mm": 0.0},
    "next_7_days": [
        {"date": "2026-11-20", "sky": "clear sky", "high_c": 31.0, "low_c": 20.0, "humidity_low_pct": 23, "humidity_high_pct": 52,
         "chance_of_rain_pct": 0, "rain_mm": 0.0, "max_wind_kmh": 9},
        {"date": "2026-11-21", "sky": "clear sky", "high_c": 30.3, "low_c": 19.5, "humidity_low_pct": 22, "humidity_high_pct": 68,
         "chance_of_rain_pct": 0, "rain_mm": 0.0, "max_wind_kmh": 11},
    ],
    "next_48_hours_every_3_hours": [
        {"time": "2026-11-21T00:00", "temperature_c": 22.0, "humidity_pct": 50, "chance_of_rain_pct": 0, "sky": "clear sky", "wind_kmh": 3},
    ],
}


@pytest.fixture()
def stub_weather(monkeypatch):
    monkeypatch.setattr(assistant_data, "weather", lambda lat, lon: FAKE_WEATHER)


def ask(fake: FakeOllama, question="How warm is it?"):
    """Ask one question through the local path with a fake Ollama."""
    from app import db

    with db.new_session() as session:
        return assistant_local.answer([{"role": "user", "content": question}], PLACE, session, get_registry(), http=fake.client())


def test_looks_up_then_answers(stub_weather):
    fake = FakeOllama([
        chat(tool_calls=[call("get_weather", {"latitude": 26.9, "longitude": 75.8})]),
        chat("<think>scratch</think>It's about 24 °C and clear, says Open-Meteo's forecast."),
    ])
    reply = ask(fake)
    assert reply.text == "It's about 24 °C and clear, says Open-Meteo's forecast."  # reasoning stripped
    assert reply.sources == ["Open-Meteo forecast"] and reply.tools_used == ["get_weather"]
    first, second = fake.requests
    assert first["model"] == "qwen3:4b-instruct" and first["stream"] is False and "think" not in first
    assert first["options"]["num_ctx"] == 4096
    assert first["tools"] == assistant.TOOLS
    assert first["messages"][0]["role"] == "system" and "call a tool" in first["messages"][0]["content"]
    assert "[App context]" in first["messages"][1]["content"]
    tool_msg = second["messages"][-1]
    assert tool_msg["role"] == "tool" and tool_msg["tool_name"] == "get_weather"
    # The forecast reaches the small model as plain lines with the days named.
    text = tool_msg["content"]
    assert "- tomorrow, Saturday (2026-11-21): clear sky, high 30.3 °C, low 19.5 °C, humidity 22 to 68%" in text
    assert "- today, Friday (2026-11-20):" in text and "- tomorrow 00:00: 22.0 °C, humidity 50%" in text


def test_numbers_without_lookup_are_sent_back_once(stub_weather):
    fake = FakeOllama([
        chat("Jaipur is usually 30 °C."),  # from memory
        chat(tool_calls=[call("get_weather", {"latitude": 26.9, "longitude": 75.8})]),
        chat("Open-Meteo's forecast says 24 °C now."),
    ])
    reply = ask(fake)
    assert reply.text == "Open-Meteo's forecast says 24 °C now."
    assert "Look the data up" in fake.requests[1]["messages"][-1]["content"]


def test_plain_answers_without_numbers_pass(stub_weather):
    reply = ask(FakeOllama([chat("I can answer questions about the weather.")]), "What can you do?")
    assert reply.text == "I can answer questions about the weather." and reply.tools_used == []


def test_string_arguments_and_failed_lookups(monkeypatch):
    def broken(lat, lon):
        raise RuntimeError("Open-Meteo down")

    monkeypatch.setattr(assistant_data, "weather", broken)
    fake = FakeOllama([
        chat(tool_calls=[{"function": {"name": "get_weather", "arguments": '{"latitude": 26.9, "longitude": 75.8}'}}]),
        chat("I couldn't get the forecast just now."),
    ])
    reply = ask(fake)
    assert reply.text == "I couldn't get the forecast just now."
    assert fake.requests[1]["messages"][-1]["content"].startswith("The lookup failed")


def test_ollama_errors_become_clear_messages():
    with pytest.raises(assistant.AssistantUnavailable) as err:
        ask(FakeOllama(status=500))
    assert err.value.status == 502
    with pytest.raises(assistant.AssistantUnavailable) as err:
        assistant_local.answer([{"role": "user", "content": "Hi"}], PLACE, None, get_registry())  # nothing listening
    assert "isn't running" in str(err.value)


def test_status_reports_local_provider(client, monkeypatch):
    monkeypatch.setattr(assistant_local, "is_available", lambda: True)
    body = client.get("/api/assistant/status").json()
    assert body == body | {"configured": True, "provider": "local", "model": "qwen3:4b-instruct"}


def test_off_setting_turns_it_off(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(assistant_local, "is_available", lambda: True)
    monkeypatch.setattr(get_settings(), "assistant_provider", "off")
    body = client.get("/api/assistant/status").json()
    assert body["configured"] is False and body["provider"] is None and body["model"] == "qwen3:4b-instruct"


def test_off_when_nothing_is_available(client, monkeypatch):
    assistant_local._status = None  # forget any cached check
    body = client.get("/api/assistant/status").json()  # Ollama URL points nowhere in tests
    assert body["configured"] is False and body["provider"] is None


def test_endpoint_reports_local_failures(client, monkeypatch):
    monkeypatch.setattr(assistant_local, "is_available", lambda: True)
    monkeypatch.setattr(assistant, "LIMITS", assistant.DailyLimits())

    def down(conversation, place, session, registry):
        raise assistant.AssistantUnavailable("upstream", "The local model isn't running. Start Ollama and try again.", 502)

    monkeypatch.setattr(assistant_local, "answer", down)
    r = client.post("/api/assistant", json={"messages": [{"role": "user", "content": "Hi"}], "place": PLACE}, headers=CLIENT)
    assert r.status_code == 502 and "Start Ollama" in r.json()["detail"]
    assert assistant.LIMITS.used(CLIENT["X-Client-Id"]) == 0  # the failed question isn't counted


@pytest.mark.parametrize("body", ["<html>not Ollama</html>", '{"message": ', "[1, 2, 3]"])
def test_a_reply_that_isnt_a_json_object_is_a_clear_error(body):
    # Something else on the port, or a reply cut off mid-way: a clear 502, never a crash.
    import httpx

    broken = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, text=body)))
    with pytest.raises(assistant.AssistantUnavailable) as err:
        assistant_local.answer([{"role": "user", "content": "Hi"}], PLACE, None, get_registry(), http=broken)
    assert err.value.status == 502


def test_an_old_env_that_chose_hosted_still_starts(monkeypatch):
    # The paid option is gone; an old .env saying "hosted" falls back to the local model.
    from app.config import Settings

    monkeypatch.setenv("WEATHERAI_ASSISTANT_PROVIDER", "hosted")
    assert Settings().assistant_provider == "auto"
