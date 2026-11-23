"""A stand-in for Ollama's /api/chat, so the assistant tests run offline without a model."""

from __future__ import annotations

import json

import httpx


def chat(content="", tool_calls=None):
    """A fake /api/chat reply."""
    message = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {"message": message, "prompt_eval_count": 500, "eval_count": 40}


def call(name, args):
    """A tool call as Ollama sends it."""
    return {"function": {"name": name, "arguments": args}}


class FakeOllama:
    """Plays back scripted /api/chat replies and records each request body."""

    def __init__(self, replies=(), status=200):
        self.replies, self.status, self.requests = list(replies), status, []

    def client(self) -> httpx.Client:
        def handle(request: httpx.Request) -> httpx.Response:
            self.requests.append(json.loads(request.content))
            if self.status != 200:
                return httpx.Response(self.status, text="boom")
            return httpx.Response(200, json=self.replies.pop(0))

        return httpx.Client(transport=httpx.MockTransport(handle))
