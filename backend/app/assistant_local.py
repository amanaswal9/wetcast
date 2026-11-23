"""Javed, the Wetcast assistant, on a free local model, run by Ollama on this computer.

The rules and tools live in assistant.py: the model may only answer from what the read-only
tools return. Nothing leaves the machine except the tools' own lookups (Open-Meteo, the
official feeds), and nothing is billed. A small model follows instructions less reliably than
a large one, so the instructions here are firmer and the Ask page says which model answered.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time

import httpx
from sqlalchemy.orm import Session

from . import assistant_data as data
from .config import get_settings
from .registry import ModelRegistry

log = logging.getLogger("weatherai.assistant.local")

STATUS_TTL_SECONDS = 30  # how long a check that Ollama is up is trusted
CALL_TIMEOUT_SECONDS = 180  # a 4B model on a small graphics card can take a while on a long tool result

# Extra instructions for small models, which tend to answer from memory unless told firmly.
LOCAL_RULES = """

Rules for this conversation (follow them exactly):
- Before giving any number about weather, call a tool. If you have not called a tool in this conversation, call one now.
- If the question is about a place other than the one in [App context], call find_place first, then use its latitude and longitude.
- Use only figures that appear in the tool results. If the figure asked for is not there, say Wetcast doesn't have it. Never estimate or round into a range of your own.
- Answer the question asked; don't repeat earlier answers.
- After the tools answer, reply in plain English sentences. Do not show JSON, tool names or your reasoning.
- Never use asterisks or markdown. For a list, put each item on its own line starting with "- "."""

_status_lock = threading.Lock()
_status: tuple[float, bool, bool] | None = None  # (checked at, reachable, model installed)


def _base() -> str:
    """Ollama's address without a trailing slash."""
    return get_settings().ollama_url.rstrip("/")


def status(force: bool = False) -> tuple[bool, bool]:
    """(Ollama reachable, the configured model installed), cached for a few seconds."""
    global _status
    with _status_lock:
        now = time.monotonic()
        if not force and _status and now - _status[0] < STATUS_TTL_SECONDS:
            return _status[1], _status[2]
        reachable = installed = False
        try:
            response = httpx.get(f"{_base()}/api/tags", timeout=2)
            response.raise_for_status()
            reachable = True
            wanted = get_settings().ollama_model
            names = {m.get("name", "") for m in response.json().get("models", [])}
            installed = wanted in names or f"{wanted}:latest" in names
        except (httpx.HTTPError, ValueError):
            pass
        _status = (now, reachable, installed)
        return reachable, installed


def is_available() -> bool:
    """True when Ollama is running and has the configured model."""
    reachable, installed = status()
    return reachable and installed


_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)


def _clean(text: str) -> str:
    """Drop any reasoning a model prints despite think=false, then any markdown."""
    from .assistant import plain_text

    return plain_text(_THINK.sub("", text or ""))


def weather_text(out: dict) -> str:
    """The forecast lookup as short plain lines with the days named ("today", "tomorrow").
    Small models misread large JSON tables (they quoted figures that weren't there); plain
    lines with nothing to work out are read reliably."""
    from datetime import date

    today = str(out.get("local_time_now", ""))[:10]
    try:
        base = date.fromisoformat(today)
    except ValueError:
        base = None

    def day_name(d: str) -> str:
        if base is None:
            return d
        day = date.fromisoformat(d)
        weekday = day.strftime("%A")  # so "this weekend" can be matched to dates
        prefix = {0: "today, ", 1: "tomorrow, "}.get((day - base).days, "")
        return f"{prefix}{weekday} ({d})"

    def v(x, unit=""):
        # A value with its unit, or "unknown" so the model never fills a gap itself.
        return "unknown" if x is None else f"{x}{unit}"

    now = out.get("now", {})
    lines = [
        f"Source: {out.get('source')}. Local time now: {out.get('local_time_now')} ({out.get('timezone')}).",
        f"Now: {v(now.get('temperature_c'), ' °C')}, feels like {v(now.get('feels_like_c'), ' °C')}, humidity {v(now.get('humidity_pct'), '%')}, "
        f"{now.get('sky')}, wind {v(now.get('wind_kmh'), ' km/h')}, rain in the last hour {v(now.get('rain_last_hour_mm'), ' mm')}.",
        "Days:",
    ]
    for d in out.get("next_7_days", []):
        lines.append(
            f"- {day_name(d['date'])}: {d['sky']}, high {v(d['high_c'], ' °C')}, low {v(d['low_c'], ' °C')}, "
            f"humidity {v(d.get('humidity_low_pct'))} to {v(d.get('humidity_high_pct'), '%')}, chance of rain {v(d['chance_of_rain_pct'], '%')}, "
            f"rain {v(d['rain_mm'], ' mm')}, wind up to {v(d['max_wind_kmh'], ' km/h')}."
        )
    lines.append("Next 48 hours, every 3 hours:")
    for h in out.get("next_48_hours_every_3_hours", []):
        lines.append(
            f"- {day_name(h['time'][:10]).split(' (')[0].split(',')[0]} {h['time'][11:16]}: {v(h['temperature_c'], ' °C')}, humidity {v(h.get('humidity_pct'), '%')}, "
            f"chance of rain {v(h['chance_of_rain_pct'], '%')}, {h['sky']}, wind {v(h['wind_kmh'], ' km/h')}."
        )
    return "\n".join(lines)


def answer(conversation: list[dict], place: dict, session: Session, registry: ModelRegistry, http: httpx.Client | None = None):
    """Answer the last user message with the local model: it asks for lookups, gets their
    results, and answers from them."""
    from .assistant import MAX_ROUNDS, SOURCE_LABELS, SYSTEM_PROMPT, TOOLS, AssistantUnavailable, Reply, context_message, run_tool

    settings = get_settings()
    model = settings.ollama_model
    messages: list[dict] = [
        {"role": "system", "content": SYSTEM_PROMPT + LOCAL_RULES},
        {"role": "user", "content": context_message(place)},
    ]
    messages += [{"role": m["role"], "content": m["content"]} for m in conversation]
    reply = Reply(text="", sources=[], model=model)
    own_client = http is None
    http = http or httpx.Client(timeout=CALL_TIMEOUT_SECONDS)
    try:
        for round_no in range(1, MAX_ROUNDS + 1):
            reply.rounds = round_no
            try:
                response = http.post(
                    f"{_base()}/api/chat",
                    json={
                        "model": model,
                        "messages": messages,
                        "tools": TOOLS,
                        "stream": False,
                        # Stay loaded between questions, so a follow-up doesn't wait for the model to load.
                        "keep_alive": "15m",
                        "options": {"temperature": 0.2, "num_ctx": settings.ollama_context},
                    },
                )
            except httpx.TimeoutException as exc:
                raise AssistantUnavailable("upstream", "The local model took too long to answer. Try a shorter question.", 504) from exc
            except httpx.HTTPError as exc:
                raise AssistantUnavailable("upstream", "The local model isn't running. Start Ollama and try again.", 502) from exc
            if response.status_code != 200:
                log.warning("ollama returned %s: %s", response.status_code, response.text[:300])
                raise AssistantUnavailable("upstream", "The local model couldn't answer right now. Try again.", 502)
            try:
                body = response.json()
            except ValueError:
                body = None
            if not isinstance(body, dict):
                # Something other than Ollama answered, or it broke off mid-reply.
                log.warning("ollama sent a reply that isn't a JSON object: %s", response.text[:300])
                raise AssistantUnavailable("upstream", "The local model couldn't answer right now. Try again.", 502)
            reply.input_tokens += int(body.get("prompt_eval_count") or 0)
            reply.output_tokens += int(body.get("eval_count") or 0)
            message = body.get("message") if isinstance(body.get("message"), dict) else {}
            calls = message.get("tool_calls") or []
            if not calls:
                text = _clean(message.get("content", ""))
                # Numbers without any lookup are likely from memory: send it back once to look them up.
                if not reply.tools_used and re.search(r"\d", text) and round_no < MAX_ROUNDS:
                    messages.append({"role": "assistant", "content": text})
                    messages.append({"role": "user", "content": "Look the data up with your tools first, then answer from what they return."})
                    continue
                reply.text = text or "Sorry, I couldn't put an answer together. Please try asking another way."
                return reply

            messages.append({"role": "assistant", "content": message.get("content", ""), "tool_calls": calls})
            for call in calls:
                fn = call.get("function") or {}
                name = str(fn.get("name", ""))
                args = fn.get("arguments") or {}
                if isinstance(args, str):  # some models send the arguments as a JSON string
                    try:
                        args = json.loads(args)
                    except ValueError:
                        args = {}
                reply.tools_used.append(name)
                label = SOURCE_LABELS.get(name)
                if label and label not in reply.sources:
                    reply.sources.append(label)
                try:
                    result = data.nan_safe(run_tool(name, dict(args), session, registry))
                    content = weather_text(result) if name == "get_weather" else json.dumps(result, ensure_ascii=False)
                except Exception as exc:  # noqa: BLE001 - tell the model, don't crash
                    log.warning("local assistant tool %s failed: %s", name, exc)
                    content = f"The lookup failed: {exc}"
                messages.append({"role": "tool", "tool_name": name, "content": content})
    finally:
        if own_client:
            http.close()

    reply.text = "Sorry, that question needed more lookups than I'm allowed for one answer. Try asking about one thing at a time."
    return reply
