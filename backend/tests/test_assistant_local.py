"""Local-model assistant tests. Ollama is replaced by a scripted fake HTTP transport, so these
run offline and never need a model installed."""

from __future__ import annotations

import json

import httpx
import pytest

from app import assistant, assistant_data, assistant_local
from app.registry import get_registry

PLACE = {"name": "Jaipur", "latitude": 26.9196, "longitude": 75.7878, "country_code": "IN"}
CLIENT = {"X-Client-Id": "test-client-0002"}
FAKE_WEATHER = {"source": "Open-Meteo forecast (test data)", "now": {"temperature_c": 24.0, "sky": "clear sky"}}


def chat(content="", tool_calls=None):
    message = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {"message": message, "prompt_eval_count": 500, "eval_count": 40}


def call(name, **args):
    return {"function": {"name": name, "arguments": args}}


class FakeOllama:
    """Plays back scripted /api/chat replies and records each request body."""

    def __init__(self, *replies, status=200):
        self.replies, self.status, self.requests = list(replies), status, []

    def client(self) -> httpx.Client:
        def handle(request: httpx.Request) -> httpx.Response:
            self.requests.append(json.loads(request.content))
            if self.status != 200:
                return httpx.Response(self.status, text="boom")
            return httpx.Response(200, json=self.replies.pop(0))

        return httpx.Client(transport=httpx.MockTransport(handle))


@pytest.fixture()
def stub_weather(monkeypatch):
    monkeypatch.setattr(assistant_data, "weather", lambda lat, lon: FAKE_WEATHER)


def ask(fake: FakeOllama, question="How warm is it?"):
    from app import db

    with db.new_session() as session:
        return assistant_local.answer([{"role": "user", "content": question}], PLACE, session, get_registry(), http=fake.client())


def test_looks_up_then_answers(stub_weather):
    fake = FakeOllama(
        chat(tool_calls=[call("get_weather", latitude=26.9, longitude=75.8)]),
        chat("<think>scratch</think>It's about 24 °C and clear, says Open-Meteo's forecast."),
    )
    reply = ask(fake)
    assert reply.text == "It's about 24 °C and clear, says Open-Meteo's forecast."  # reasoning stripped
    assert reply.sources == ["Open-Meteo forecast"] and reply.tools_used == ["get_weather"]
    first, second = fake.requests
    assert first["model"] == "qwen3:4b" and first["think"] is False and first["stream"] is False
    assert {t["function"]["name"] for t in first["tools"]} == {t["name"] for t in assistant.TOOLS}
    assert first["messages"][0]["role"] == "system" and "call a tool" in first["messages"][0]["content"]
    assert "[App context]" in first["messages"][1]["content"]
    tool_msg = second["messages"][-1]
    assert tool_msg["role"] == "tool" and tool_msg["tool_name"] == "get_weather"
    assert json.loads(tool_msg["content"]) == FAKE_WEATHER


def test_numbers_without_lookup_are_sent_back_once(stub_weather):
    fake = FakeOllama(
        chat("Jaipur is usually 30 °C."),  # from memory
        chat(tool_calls=[call("get_weather", latitude=26.9, longitude=75.8)]),
        chat("Open-Meteo's forecast says 24 °C now."),
    )
    reply = ask(fake)
    assert reply.text == "Open-Meteo's forecast says 24 °C now."
    assert "Look the data up" in fake.requests[1]["messages"][-1]["content"]


def test_plain_answers_without_numbers_pass(stub_weather):
    reply = ask(FakeOllama(chat("I can answer questions about the weather.")), "What can you do?")
    assert reply.text == "I can answer questions about the weather." and reply.tools_used == []


def test_string_arguments_and_failed_lookups(monkeypatch):
    def broken(lat, lon):
        raise RuntimeError("Open-Meteo down")

    monkeypatch.setattr(assistant_data, "weather", broken)
    fake = FakeOllama(
        chat(tool_calls=[{"function": {"name": "get_weather", "arguments": '{"latitude": 26.9, "longitude": 75.8}'}}]),
        chat("I couldn't get the forecast just now."),
    )
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
    monkeypatch.setattr(assistant, "api_key", lambda: None)
    monkeypatch.setattr(assistant_local, "is_available", lambda: True)
    body = client.get("/api/assistant/status").json()
    assert body == {**body, "configured": True, "provider": "local", "model": "qwen3:4b"}


def test_hosted_wins_when_a_key_is_set(client, monkeypatch):
    monkeypatch.setattr(assistant, "api_key", lambda: "test-key-not-real")
    monkeypatch.setattr(assistant_local, "is_available", lambda: True)
    assert client.get("/api/assistant/status").json()["provider"] == "hosted"


def test_off_when_nothing_is_available(client, monkeypatch):
    monkeypatch.setattr(assistant, "api_key", lambda: None)
    assistant_local._status = None  # forget any cached check
    body = client.get("/api/assistant/status").json()  # Ollama URL points nowhere in tests
    assert body["configured"] is False and body["provider"] is None


def test_endpoint_reports_local_failures(client, monkeypatch):
    monkeypatch.setattr(assistant, "api_key", lambda: None)
    monkeypatch.setattr(assistant_local, "is_available", lambda: True)
    monkeypatch.setattr(assistant, "LIMITS", assistant.DailyLimits())

    def down(*args, **kwargs):
        raise assistant.AssistantUnavailable("upstream", "The local model isn't running. Start Ollama and try again.", 502)

    monkeypatch.setattr(assistant_local, "answer", down)
    r = client.post("/api/assistant", json={"messages": [{"role": "user", "content": "Hi"}], "place": PLACE}, headers=CLIENT)
    assert r.status_code == 502 and "Start Ollama" in r.json()["detail"]
