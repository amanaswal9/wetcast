"""The content security policy in deploy/security-headers.conf must allow every outside address
the app talks to. The browser tests serve the app without these headers, so this check stands in
for them: a missing host would only show up as a blocked request on a real deployment."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def csp() -> dict[str, set[str]]:
    """The policy in deploy/security-headers.conf as {directive: set of sources}."""
    text = (ROOT / "deploy" / "security-headers.conf").read_text(encoding="utf-8")
    policy = re.search(r'Content-Security-Policy "([^"]+)"', text).group(1)
    return {part.split()[0]: set(part.split()[1:]) for part in policy.split(";") if part.strip()}


def test_every_api_the_app_fetches_from_is_allowed():
    # Open-Meteo addresses the frontend calls directly.
    sources = "".join(p.read_text(encoding="utf-8") for p in (ROOT / "src").rglob("*.ts"))
    hosts = set(re.findall(r"https://([a-z-]+\.open-meteo\.com)/v1", sources))
    assert hosts, "expected the frontend to call Open-Meteo"
    allowed = csp()["connect-src"]
    for host in hosts:
        assert f"https://{host}" in allowed, f"{host} is fetched but not in connect-src"


def test_map_tiles_are_allowed_as_images_and_for_the_offline_cache():
    # The page shows tiles as images; the service worker fetches them itself to keep them offline.
    config = (ROOT / "vite.config.ts").read_text(encoding="utf-8")
    cached = set(re.findall(r"url\.hostname === '([^']+)'", config))
    policy = csp()
    for host in cached:
        assert f"https://{host}" in policy["connect-src"], f"the service worker fetches {host} but connect-src blocks it"
    assert "https://tile.openstreetmap.org" in policy["img-src"]


def test_scripts_are_limited_to_the_app_itself():
    policy = csp()
    assert policy["script-src"] == {"'self'"}
    assert policy["frame-ancestors"] == {"'none'"}
    assert policy["object-src"] == {"'none'"}
