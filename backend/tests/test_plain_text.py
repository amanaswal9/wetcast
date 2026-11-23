"""The reply cleaner: Javed's answers reach the Ask page as plain text, without markdown asterisks.
No network is used; Ollama is replaced by a fake transport."""

from __future__ import annotations

import httpx

from app import assistant, assistant_local
from app.assistant import plain_text
from app.registry import get_registry

PLACE = {"name": "Jaipur", "latitude": 26.9196, "longitude": 75.7878, "country_code": "IN"}

# The markdown under test is built from single characters, so the source files themselves
# never contain a double asterisk.
STAR = "*"
BOLD = STAR + STAR


def test_bold_and_italics_are_dropped():
    assert plain_text(f"It will be {BOLD}warm{BOLD} and {STAR}dry{STAR} tomorrow.") == "It will be warm and dry tomorrow."
    assert plain_text(f"{BOLD}{STAR}Heavy rain{BOLD}{STAR} is likely.") == "Heavy rain is likely."
    assert plain_text(f"{BOLD}Tomorrow:{BOLD} 24 °C, clear.") == "Tomorrow: 24 °C, clear."


def test_star_bullets_become_hyphens():
    reply = f"Next three days:\n{STAR} Friday: 31 °C\n{STAR} Saturday: 30 °C\n  {STAR} night: 19 °C"
    assert plain_text(reply) == "Next three days:\n- Friday: 31 °C\n- Saturday: 30 °C\n  - night: 19 °C"


def test_round_bullets_become_hyphens():
    assert plain_text("• Friday: dry\n• Saturday: dry") == "- Friday: dry\n- Saturday: dry"


def test_stray_asterisks_are_removed_and_the_words_kept():
    assert plain_text(f"About 24 °C{STAR} (Open-Meteo)") == "About 24 °C (Open-Meteo)"
    assert plain_text(f"Rain {STAR} then sun") == "Rain then sun"
    assert STAR not in plain_text(f"{STAR} {STAR} {STAR}\n{BOLD}\n{STAR}a{STAR}b{BOLD}c{BOLD}{STAR}")


def test_clean_text_is_left_alone():
    reply = "Open-Meteo's forecast shows 24 °C now.\n\n- Friday: dry\n- Saturday: 10% chance of rain"
    assert plain_text(reply) == reply
    assert plain_text("") == ""
    assert plain_text(None) == ""


def test_system_prompt_asks_for_plain_text():
    assert "no asterisks" in assistant.SYSTEM_PROMPT and '"- "' in assistant.SYSTEM_PROMPT
    assert "Never use asterisks" in assistant_local.LOCAL_RULES


def test_local_replies_are_cleaned():
    def handle(request: httpx.Request) -> httpx.Response:
        message = {"role": "assistant", "content": f"I can help with:\n{STAR} the forecast\n{STAR} {BOLD}official{BOLD} warnings"}
        return httpx.Response(200, json={"message": message, "prompt_eval_count": 10, "eval_count": 5})

    http = httpx.Client(transport=httpx.MockTransport(handle))
    reply = assistant_local.answer([{"role": "user", "content": "What can you do?"}], PLACE, None, get_registry(), http=http)
    assert reply.text == "I can help with:\n- the forecast\n- official warnings"
