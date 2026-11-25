"""Browser journey tests: the production build in real Chromium, with every network call
answered from recorded files, so runs are offline, free and repeatable.

Run (after `npm run build`), from the repository root:
    & "$HOME\\.venvs\\weatherai\\Scripts\\python.exe" -m pytest e2e -q

Environment switches:
    E2E_RECORD=1   fetch and save any response not recorded yet (needs internet and the API on :8000)
    E2E_UPDATE=1   rewrite the reference screenshots for this operating system
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import pytest
from playwright.sync_api import Browser, Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "e2e" / "fixtures"
SHOTS = ROOT / "e2e" / "screenshots" / sys.platform
FAILED_SHOTS = ROOT / "e2e" / "screenshots-failed" / sys.platform  # git-ignored
PORT = 4173
BASE = f"http://127.0.0.1:{PORT}"
API = "http://127.0.0.1:8000"
RECORD = os.environ.get("E2E_RECORD") == "1"
UPDATE = os.environ.get("E2E_UPDATE") == "1"

# The moment every test runs at (20:30 in India), matching when the fixtures were recorded.
FIXED_TIME = "2026-11-20T15:00:00Z"
DELHI = {"id": "1273294", "name": "New Delhi", "admin1": "Delhi", "country": "India", "countryCode": "IN", "latitude": 28.63576, "longitude": 77.22445}

DESKTOP = {"viewport": {"width": 1280, "height": 800}}
PHONE = {"viewport": {"width": 375, "height": 812}, "is_mobile": True, "has_touch": True, "device_scale_factor": 2}

WEATHER_HOSTS = ("open-meteo.com",)
BLOCKED_HOSTS = ("tile.openstreetmap.org",)


# The app server


def _port_open(port: int) -> bool:
    """True when something is listening on this local port."""
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


# Serves the production build with vite preview for the whole test run.
@pytest.fixture(scope="session")
def server():
    if not (ROOT / "dist" / "index.html").exists():
        pytest.exit("Build the app first: npm run build", returncode=2)
    vite = ROOT / "node_modules" / "vite" / "bin" / "vite.js"
    proc = subprocess.Popen(
        ["node", str(vite), "preview", "--port", str(PORT), "--strictPort", "--host", "127.0.0.1"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(100):
        if _port_open(PORT):
            break
        time.sleep(0.1)
    else:
        proc.kill()
        pytest.exit("vite preview did not start", returncode=2)
    yield BASE
    proc.terminate()
    proc.wait(timeout=10)


# One Chromium for the whole test run; each test opens its own page in it.
@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


# Recorded network


def fixture_key(method: str, url: str, body: bytes | None) -> str:
    """Stable name for a request: host, path, sorted query, and the body for POSTs."""
    parts = urlsplit(url)
    host = parts.hostname if parts.hostname not in ("127.0.0.1", "localhost") else "app"
    query = "&".join(f"{k}={v}" for k, v in sorted(parse_qsl(parts.query, keep_blank_values=True)))
    raw = f"{method} {host}{parts.path}?{query}".encode() + (body or b"")
    return hashlib.sha1(raw).hexdigest()[:16]


class Network:
    """Answers the page's requests from e2e/fixtures; records new ones when E2E_RECORD=1."""

    def __init__(self):
        """Start with no unanswered requests."""
        self.missing: list[str] = []

    def handle(self, route: Route) -> None:
        """Block map tiles, pass the app's files through, answer API and weather requests from fixtures."""
        request = route.request
        url = request.url
        host = urlsplit(url).hostname or ""
        if host.endswith(BLOCKED_HOSTS):
            route.fulfill(status=204, body="")  # no map tiles: keeps screenshots stable
            return
        is_api = urlsplit(url).path.startswith("/api/") and host in ("127.0.0.1", "localhost")
        if not (is_api or host.endswith(WEATHER_HOSTS)):
            route.continue_()  # the app's own files
            return
        body = request.post_data_buffer
        path = FIXTURES / f"{fixture_key(request.method, url, body)}.json"
        if path.exists():
            saved = json.loads(path.read_text(encoding="utf-8"))
            route.fulfill(status=saved["status"], content_type=saved["content_type"], body=saved["body"])
            return
        if RECORD:
            target = url.replace(BASE, API) if is_api else url
            response = route.fetch(url=target)
            saved = {
                "url": url,
                "status": response.status,
                "content_type": response.headers.get("content-type", "application/json"),
                "body": response.text(),
            }
            FIXTURES.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(saved, ensure_ascii=False, indent=1), encoding="utf-8")
            route.fulfill(status=saved["status"], content_type=saved["content_type"], body=saved["body"])
            return
        self.missing.append(url)
        route.fulfill(status=503, content_type="application/json", body='{"detail": "not recorded"}')


def open_app(browser: Browser, server: str, device: dict, theme: str = "light", place: dict = DELHI, units: str = "metric"):
    """A fresh page of the app with fixed time, place, theme and units, and recorded network."""
    context = browser.new_context(
        viewport=device["viewport"],
        is_mobile=device.get("is_mobile", False),
        has_touch=device.get("has_touch", False),
        device_scale_factor=device.get("device_scale_factor", 1),
        locale="en-GB",
        timezone_id="Asia/Kolkata",
        reduced_motion="reduce",
        service_workers="block",  # the offline cache would bypass the recorded network
    )
    unit_json = json.dumps({"temp": "c", "speed": "kmh", "clock": "24"} if units == "metric" else {"temp": "f", "speed": "mph", "clock": "12"})
    context.add_init_script(
        "try {"
        f"localStorage.setItem('weatherai.theme', {json.dumps(theme)});"
        f"localStorage.setItem('weatherai.place', {json.dumps(json.dumps(place))});"
        f"localStorage.setItem('weatherai.units', {json.dumps(unit_json)});"
        "localStorage.setItem('weatherai.clientId', 'e2e-test-client-0001');"
        "} catch (e) {}"
    )
    network = Network()
    context.route(lambda url: True, network.handle)  # every request goes through the recorder
    page = context.new_page()
    page.clock.set_fixed_time(FIXED_TIME)
    page.network = network  # type: ignore[attr-defined]
    return page


def close(page: Page) -> None:
    """Close a test's browser, letting requests still in flight (background prefetches) end quietly."""
    page.context.unroute_all(behavior="ignoreErrors")
    page.context.close()


# A fresh desktop-sized page; afterwards, fails the test if it asked for anything not recorded.
@pytest.fixture()
def desktop(browser, server):
    page = open_app(browser, server, DESKTOP)
    yield page
    close(page)
    _check_network(page)


# The same on a phone-sized touch screen.
@pytest.fixture()
def phone(browser, server):
    page = open_app(browser, server, PHONE)
    yield page
    close(page)
    _check_network(page)


def _check_network(page: Page) -> None:
    """Fail the test if the page made requests with no recorded answer."""
    missing = page.network.missing  # type: ignore[attr-defined]
    if missing:
        pytest.fail("Requests with no recorded answer (run once with E2E_RECORD=1):\n" + "\n".join(sorted(set(missing))))


# Opens a page of the app (by its hash, e.g. "forecast") and waits until the network is quiet.
def goto(page: Page, hash_path: str = "") -> None:
    page.goto(f"{BASE}/#/{hash_path}" if hash_path else BASE)
    page.wait_for_load_state("networkidle")


# Screenshots

COMPARE_JS = """async ([a, b]) => {
  const load = (src) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src })
  const [x, y] = await Promise.all([load(a), load(b)])
  if (x.width !== y.width || x.height !== y.height) return { size: false, diff: 1 }
  const pixels = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data }
  const p = pixels(x), q = pixels(y)
  let diff = 0
  for (let i = 0; i < p.length; i += 4) {
    if (Math.abs(p[i] - q[i]) > 24 || Math.abs(p[i + 1] - q[i + 1]) > 24 || Math.abs(p[i + 2] - q[i + 2]) > 24) diff++
  }
  return { size: true, diff: diff / (p.length / 4) }
}"""

MAX_DIFF = 0.003  # share of pixels allowed to differ (anti-aliasing noise)


def expect_screenshot(page: Page, name: str) -> None:
    """Compare with the reference image for this operating system (fonts render differently
    on Windows and Linux). With no reference yet, or E2E_UPDATE=1, save one instead."""
    # The personal desktop picture (src/local, not in git) is hidden, so screenshots match on every computer.
    shot = page.screenshot(animations="disabled", caret="hide", style=".r-desktop-art { display: none; }")
    reference = SHOTS / f"{name}.png"
    if UPDATE or not reference.exists():
        SHOTS.mkdir(parents=True, exist_ok=True)
        reference.write_bytes(shot)
        print(f"saved reference screenshot {reference.relative_to(ROOT)}")
        return
    uri = lambda data: "data:image/png;base64," + base64.b64encode(data).decode()  # noqa: E731
    result = page.evaluate(COMPARE_JS, [uri(reference.read_bytes()), uri(shot)])
    if not result["size"] or result["diff"] > MAX_DIFF:
        FAILED_SHOTS.mkdir(parents=True, exist_ok=True)
        actual = FAILED_SHOTS / f"{name}.png"
        actual.write_bytes(shot)
        pytest.fail(
            f"Screenshot {name} changed ({result['diff']:.2%} of pixels"
            f"{'' if result['size'] else ', different size'}). New image: {actual.relative_to(ROOT)}. "
            "If the change is intended, rerun with E2E_UPDATE=1."
        )


# Accessibility

AXE = (ROOT / "node_modules" / "axe-core" / "axe.min.js").read_text(encoding="utf-8")


def axe_violations(page: Page, impacts=("serious", "critical")) -> list[dict]:
    """WCAG 2.2 A/AA checks by axe-core on the current page; returns the serious ones.

    Off-screen group boxes skip layout (content-visibility: auto) until scrolled near, which would
    make axe measure their contents against the wrong background, so everything is laid out first."""
    page.add_style_tag(content=".r-group { content-visibility: visible !important; }")
    page.add_script_tag(content=AXE)
    result = page.evaluate(
        """async () => (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations
            .map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map(n => n.target.join(' ')) }))"""
    )
    return [v for v in result if v["impact"] in impacts]
