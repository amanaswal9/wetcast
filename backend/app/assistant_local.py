"""The WeatherAI assistant on a free local model, run by Ollama on this computer.

Same rules, tools and data as the Hosted version (assistant.py): the model may only answer
from what the read-only tools return. Nothing leaves the machine except the tools' own
lookups (Open-Meteo, the official feeds), and nothing is billed. A small local model follows
instructions less reliably than Hosted, so the instructions are firmer and the Ask page says
which model answered.
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

STATUS_TTL_SECONDS = 30
CALL_TIMEOUT_SECONDS = 180  # a 4B model on a small graphics card can take a while on a long tool result

# Extra instructions for small models, which tend to answer from memory unless told firmly.
LOCAL_RULES = """

Rules for this conversation (follow them exactly):
- Before giving any number about weather, call a tool. If you have not called a tool in this conversation, call one now.
- If the question is about a place other than the one in [App context], call find_place first, then use its latitude and longitude.
- After the tools answer, reply in plain English sentences. Do not show JSON, tool names or your reasoning."""

_status_lock = threading.Lock()
_status: tuple[float, bool, bool] | None = None  # (checked at, reachable, model installed)


def _base() -> str:
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
    reachable, installed = status()
    return reachable and installed


def ollama_tools() -> list[dict]:
    """The same tools as the Hosted version, in Ollama's (OpenAI-style) function format."""
    from .assistant import TOOLS

    return [
        {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}}
        for t in TOOLS
    ]


_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)


def _clean(text: str) -> str:
    """Drop any reasoning a model prints despite think=false."""
    return _THINK.sub("", text or "").strip()


def answer(conversation: list[dict], place: dict, session: Session, registry: ModelRegistry, http: httpx.Client | None = None):
    from .assistant import MAX_ROUNDS, SOURCE_LABELS, SYSTEM_PROMPT, AssistantUnavailable, Reply, context_message, run_tool

    settings = get_settings()
    model = settings.ollama_model
    messages: list[dict] = [
        {"role": "system", "content": SYSTEM_PROMPT + LOCAL_RULES},
        {"role": "user", "content": context_message(place)},
        *({"role": m["role"], "content": m["content"]} for m in conversation),
    ]
    tools = ollama_tools()
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
                        "tools": tools,
                        "stream": False,
                        "think": False,
                        "options": {"temperature": 0.2, "num_ctx": 8192},
                    },
                )
            except httpx.TimeoutException as exc:
                raise AssistantUnavailable("upstream", "The local model took too long to answer. Try a shorter question.", 504) from exc
            except httpx.HTTPError as exc:
                raise AssistantUnavailable("upstream", "The local model isn't running. Start Ollama and try again.", 502) from exc
            if response.status_code != 200:
                log.warning("ollama returned %s: %s", response.status_code, response.text[:300])
                raise AssistantUnavailable("upstream", "The local model couldn't answer right now. Try again.", 502)
            body = response.json()
            reply.input_tokens += int(body.get("prompt_eval_count") or 0)
            reply.output_tokens += int(body.get("eval_count") or 0)
            message = body.get("message") or {}
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
                    content = json.dumps(data.nan_safe(run_tool(name, dict(args), session, registry)), ensure_ascii=False)
                except Exception as exc:  # noqa: BLE001 - tell the model, don't crash
                    log.warning("local assistant tool %s failed: %s", name, exc)
                    content = f"The lookup failed: {exc}"
                messages.append({"role": "tool", "tool_name": name, "content": content})
    finally:
        if own_client:
            http.close()

    reply.text = "Sorry, that question needed more lookups than I'm allowed for one answer. Try asking about one thing at a time."
    return reply
