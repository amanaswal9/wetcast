"""Javed, the Wetcast assistant: answers weather questions using only data it looks up
through the read-only tools in assistant_data.py.

Two providers (WEATHERAI_ASSISTANT_PROVIDER, default "auto"):
- Hosted, when an Hosted API key is set (WEATHERAI_HOSTED_API_KEY or HOSTED_API_KEY).
  Every answer costs money.
- A free local model run by Ollama on this computer (assistant_local.py), used when there is no
  key and Ollama is running with the model installed.
Either way there are per-visitor and daily limits, and each answer may use at most MAX_ROUNDS
model calls.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from dataclasses import dataclass, field
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone

import hosted
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from . import assistant_data as data
from .config import get_settings
from . import db
from .db import AssistantUsage
from .registry import ModelRegistry

log = logging.getLogger("weatherai.assistant")

MAX_ROUNDS = 5
MAX_TOKENS = 16000
# Models that accept Hosted's server-side refusal fallback.
FALLBACK_MODELS = {"hosted-opus-5-5", "hosted-opus-5", "hosted-sonnet-5-5", "hosted-fable-5-1", "hosted-fable-5-2"}
FALLBACK_BETA = "server-side-fallback-2026-07-01"

SYSTEM_PROMPT = """You are Javed, the AI weather assistant inside the Wetcast app. You answer questions about the weather. If asked who you are, say you are Javed, Wetcast's AI assistant; you are not a person.

How to answer:
- Answer only from data you looked up with your tools in this conversation. If the tools don't have it, say so plainly. Never guess, invent numbers, or rely on general knowledge about a place's climate as if it were a forecast.
- Say where each number comes from in plain words: "Open-Meteo's forecast", "Wetcast's own model", or "an official warning from ...". Never present Wetcast's model output as an official forecast.
- Forecasts are uncertain. Use ranges and chances rather than certainties ("about 24 °C, likely between 22 and 26"), and never promise what the weather will do.
- If someone asks about danger, safety, or what to do in severe weather, look up official warnings, repeat any that apply as issued, and tell them to follow their national weather service or local authorities. Don't give your own safety rulings.
- Use the place's local time. Use °C, km/h, mm and %.
- Keep answers short: two to five sentences, or a short list when comparing days. Plain words, no jargon, no emoji.
- Write plain text only. The app shows your reply exactly as written, so do not use markdown: no asterisks, no bold or italics, no headings, no tables.
- For a list, start each item on its own line with "- " (a hyphen and a space).
- Only weather, this app, and how its models work. Politely decline anything else.

Tools:
- The app tells you the place the person is looking at. To answer about a different place, use find_place first.
- get_weather: current conditions and forecast from Open-Meteo, for anywhere.
- get_weatherai_prediction: Wetcast's own 24-hour forecast with ranges, for places in India; it says how accurate to expect it there.
- get_official_alerts: official warnings (India and the United States only).
- get_model_accuracy: how accurate Wetcast's models were on unseen data."""

LAT_LON = {
    "latitude": {"type": "number", "description": "Latitude in degrees, -90 to 90"},
    "longitude": {"type": "number", "description": "Longitude in degrees, -180 to 180"},
}


def _tool(name: str, description: str, properties: dict, required: list[str]) -> dict:
    """One tool definition in the Messages API format, with strict argument checking."""
    return {
        "name": name,
        "description": description,
        "strict": True,
        "input_schema": {"type": "object", "properties": properties, "required": required, "additionalProperties": False},
    }


TOOLS = [
    _tool(
        "find_place",
        "Find a place by name and get its coordinates and country code. Returns up to three matches.",
        {"name": {"type": "string", "description": "Place name, e.g. 'Jaipur' or 'Pune, India'"}},
        ["name"],
    ),
    _tool(
        "get_weather",
        "Open-Meteo's current conditions, the next 48 hours (every 3 hours) and the next 7 days for a point, in its local time.",
        LAT_LON,
        ["latitude", "longitude"],
    ),
    _tool(
        "get_weatherai_prediction",
        "Wetcast's own machine-learning forecast for the next 24 hours, with 80% error ranges, and how accurate it has been at this kind of place. Available in India (near the cities its models were trained on); elsewhere it says so.",
        LAT_LON | {"country_code": {"type": "string", "description": "Two-letter country code, e.g. IN; empty string if unknown"}},
        ["latitude", "longitude", "country_code"],
    ),
    _tool(
        "get_official_alerts",
        "Official weather warnings in effect at a point: India (NDMA Sachet, from IMD and state authorities) and the United States (National Weather Service).",
        LAT_LON | {"country_code": {"type": "string", "description": "Two-letter country code, e.g. IN or US; empty string if unknown"}},
        ["latitude", "longitude", "country_code"],
    ),
    _tool(
        "get_model_accuracy",
        "How accurate Wetcast's models were on 2026 data they never saw, compared with a simple baseline, plus the live track record.",
        {},
        [],
    ),
]
TOOLS[-1]["cache_control"] = {"type": "ephemeral"}  # instructions and tools are the same every time, so cache them

# The source names shown under an answer, one per tool that was used.
SOURCE_LABELS = {
    "find_place": "Open-Meteo geocoding",
    "get_weather": "Open-Meteo forecast",
    "get_weatherai_prediction": "Wetcast models",
    "get_official_alerts": "Official warnings",
    "get_model_accuracy": "Wetcast evaluation",
}


class AssistantUnavailable(RuntimeError):
    """The assistant is not configured, over its limits, or the API failed."""

    def __init__(self, code: str, message: str, status: int):
        super().__init__(message)
        self.code, self.status = code, status


@dataclass
class Reply:
    """An answer for the Ask page, with what it cost and which lookups it used."""

    text: str
    sources: list[str]
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    rounds: int = 0
    tools_used: list[str] = field(default_factory=list)


# Markdown the models sometimes write even when told not to. The Ask page shows text as it is,
# so a stray asterisk would appear on screen.
_STAR_BULLET = re.compile(r"^([ \t]*)[*•][ \t]+", re.MULTILINE)
_EXTRA_SPACES = re.compile(r"(?<=\S)[ \t]{2,}(?=\S)")


def plain_text(text: str | None) -> str:
    """Clean a model's reply for the Ask page: bullet lines become "- " items,
    bold and italic markers are dropped, and any other asterisk is removed. The words stay."""
    text = _STAR_BULLET.sub(r"\1- ", text or "")
    text = text.replace("*", "")
    lines = [_EXTRA_SPACES.sub(" ", line).rstrip() for line in text.split("\n")]
    return "\n".join(lines).strip()


def api_key() -> str | None:
    """The Hosted key from settings, or from the SDK's usual HOSTED_API_KEY."""
    key = get_settings().hosted_api_key
    return key.get_secret_value() if key else os.environ.get("HOSTED_API_KEY") or None


def provider() -> str | None:
    """"hosted", "local", or None when the assistant is off."""
    choice = get_settings().assistant_provider
    if choice == "off":
        return None
    if choice in ("auto", "hosted") and api_key():
        return "hosted"
    if choice in ("auto", "local"):
        from . import assistant_local

        return "local" if assistant_local.is_available() else None
    return None


def is_configured() -> bool:
    """True when some provider can answer questions right now."""
    return provider() is not None


def model_name(which: str | None) -> str:
    """The model that answers for a provider, as shown on the Ask page."""
    settings = get_settings()
    return settings.ollama_model if which == "local" else settings.assistant_model


class DailyLimits:
    """Questions per visitor and in total for each UTC day. They cap spending even if someone
    hammers the endpoint; a spending limit in the Hosted Console is the second line of defence.

    The counts live in the database (table assistant_usage), so restarting the API doesn't reset
    them. The lock keeps one API process's threads from both taking the last question; the API runs
    as a single process."""

    KEEP_DAYS = 7  # older counts are deleted

    def __init__(self, sessions: Callable[[], Session] | None = None):
        self._lock = threading.Lock()
        self._sessions = sessions
        self._pruned: date | None = None

    def _session(self) -> Session:
        return self._sessions() if self._sessions is not None else db.new_session()

    @staticmethod
    def today() -> date:
        return datetime.now(timezone.utc).date()

    def take(self, client_id: str, per_client: int, total: int) -> date:
        """Count one question, or raise AssistantUnavailable (429) when a limit is reached.
        Returns the day it was counted on, for give_back."""
        today = self.today()
        with self._lock, self._session() as s:
            if self._pruned != today:
                s.execute(delete(AssistantUsage).where(AssistantUsage.day < today - timedelta(days=self.KEEP_DAYS)))
                s.commit()
                self._pruned = today
            used = s.scalar(select(func.coalesce(func.sum(AssistantUsage.questions), 0)).where(AssistantUsage.day == today))
            if used >= total:
                raise AssistantUnavailable("daily_limit", "The assistant has answered all the questions it can today. Try again tomorrow.", 429)
            row = s.get(AssistantUsage, (today, client_id))
            if row is not None and row.questions >= per_client:
                raise AssistantUnavailable("client_limit", f"You've asked {per_client} questions today, the daily limit. Try again tomorrow.", 429)
            if row is None:
                s.add(AssistantUsage(day=today, client_id=client_id, questions=1))
            else:
                row.questions += 1
            s.commit()
        return today

    def give_back(self, client_id: str, day: date | None = None) -> None:
        """Don't count a question that failed before it was answered."""
        with self._lock, self._session() as s:
            row = s.get(AssistantUsage, (day or self.today(), client_id))
            if row is not None and row.questions > 0:
                row.questions -= 1
                s.commit()

    def used(self, client_id: str) -> int:
        """Questions this visitor has asked today."""
        with self._session() as s:
            row = s.get(AssistantUsage, (self.today(), client_id))
            return row.questions if row is not None else 0


LIMITS = DailyLimits()


def make_client() -> hosted.Hosted:
    """A Hosted client: two retries, and at most 60 seconds per attempt."""
    return hosted.Hosted(api_key=api_key(), max_retries=2, timeout=60)


def run_tool(name: str, args: dict, session: Session, registry: ModelRegistry) -> dict:
    """Run one tool the model asked for. Bad coordinates or an unknown tool raise ValueError,
    which the caller passes back to the model as a failed lookup."""
    if name == "find_place":
        return data.find_place(str(args["name"])[:100])
    if name == "get_model_accuracy":
        return data.model_accuracy(session, registry)
    lat, lon = float(args["latitude"]), float(args["longitude"])
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("latitude or longitude out of range")
    if name == "get_weather":
        return data.weather(lat, lon)
    if name == "get_weatherai_prediction":
        return data.weatherai_prediction(registry, lat, lon, (args.get("country_code") or "").strip() or None)
    if name == "get_official_alerts":
        return data.official_alerts_at(session, lat, lon, (args.get("country_code") or "").strip() or None)
    raise ValueError(f"unknown tool {name!r}")


def context_message(place: dict) -> str:
    """The first user turn: which place is on screen, and the time now."""
    country = place.get("country_code") or "unknown"
    return (
        f"[App context] The person is looking at {place['name']} "
        f"(latitude {place['latitude']:.4f}, longitude {place['longitude']:.4f}, country code {country}). "
        f"Current UTC time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')}."
    )


def answer(conversation: list[dict], place: dict, session: Session, registry: ModelRegistry, client=None) -> Reply:
    """Answer the last user message. `conversation` is the visible chat so far
    (plain text turns, oldest first, ending with the user's question). Calls Hosted, or hands
    over to the local model when that is the provider."""
    if client is None and provider() == "local":
        from . import assistant_local

        return assistant_local.answer(conversation, place, session, registry)
    settings = get_settings()
    model = settings.assistant_model
    client = client or make_client()
    # The app context goes first; the API joins it with the first question into one user turn.
    messages: list[dict] = [{"role": "user", "content": context_message(place)}]
    messages += [{"role": m["role"], "content": m["content"]} for m in conversation]

    # Models that support it get Hosted's refusal fallback; for the rest these stay unset.
    use_fallback = model in FALLBACK_MODELS
    betas = [FALLBACK_BETA] if use_fallback else hosted.omit
    fallbacks = "default" if use_fallback else hosted.omit

    reply = Reply(text="", sources=[], model=model)
    for round_no in range(1, MAX_ROUNDS + 1):
        reply.rounds = round_no
        response = client.beta.messages.create(
            model=model,
            max_tokens=MAX_TOKENS,
            system=[{"type": "text", "text": SYSTEM_PROMPT}],
            tools=TOOLS,
            messages=messages,
            output_config={"effort": settings.assistant_effort},
            betas=betas,
            fallbacks=fallbacks,
        )
        usage = getattr(response, "usage", None)
        reply.input_tokens += getattr(usage, "input_tokens", 0) or 0
        reply.output_tokens += getattr(usage, "output_tokens", 0) or 0
        reply.model = getattr(response, "model", model) or model

        if response.stop_reason == "refusal":
            reply.text = "I can't help with that one. I can answer questions about the weather and how Wetcast's forecasts work."
            return reply
        if response.stop_reason != "tool_use":
            reply.text = plain_text("\n\n".join(b.text for b in response.content if b.type == "text"))
            if response.stop_reason == "max_tokens":
                reply.text += "\n\n(The answer was cut short.)"
            if not reply.text:
                reply.text = "Sorry, I couldn't put an answer together. Please try asking another way."
            return reply

        messages.append({"role": "assistant", "content": response.content})
        results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            reply.tools_used.append(block.name)
            label = SOURCE_LABELS.get(block.name)
            if label and label not in reply.sources:
                reply.sources.append(label)
            try:
                result = data.nan_safe(run_tool(block.name, dict(block.input), session, registry))
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(result, ensure_ascii=False)})
            except Exception as exc:  # noqa: BLE001 - report the failure to the model instead of crashing
                log.warning("assistant tool %s failed: %s", block.name, exc)
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": f"The lookup failed: {exc}", "is_error": True})
        messages.append({"role": "user", "content": results})

    reply.text = "Sorry, that question needed more lookups than I'm allowed for one answer. Try asking about one thing at a time."
    return reply
