"""Record the README demo from the real, running app (no mock-ups).

Needs the dev servers running (Vite, default :5173, and the API on :8000), Playwright with
Chromium, and ffmpeg. From the repository root:

    python docs/demo/record_demo.py --ffmpeg PATH_TO_FFMPEG [--base http://localhost:5175]

Writes docs/demo/weatherai-demo.mp4 (1280x720) and docs/demo/weatherai-demo.gif.
Everything on screen is live: Open-Meteo data, WeatherAI's model predictions and the
committed test results. Only the title card, end card, captions and the mouse pointer
are drawn on top (Playwright's recordings don't show the pointer).
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE = "http://localhost:5173"  # replaced by --base
W, H = 1280, 720
OUT = Path(__file__).resolve().parent
START_PLACE = (
    '{"id":"1273294","name":"Delhi","admin1":"Delhi","country":"India","countryCode":"IN",'
    '"latitude":28.65195,"longitude":77.23149}'
)

# Pointer, caption bar and full-screen cards, in the app's own retro style.
OVERLAY_JS = """
(() => {
  if (!localStorage.getItem('demo.started')) {
    localStorage.setItem('demo.started', '1');
    localStorage.setItem('weatherai.place', %s);
    localStorage.setItem('weatherai.theme', 'light');
  }
  const add = () => {
    if (document.getElementById('demo-cursor')) return;
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML = '<svg width="20" height="30" viewBox="0 0 12 19"><path d="M0.5 0.5v15.5l4-4 3 6.5 2.3-1-3-6.5h5.7z" fill="#fff" stroke="#000" stroke-width="1"/></svg>';
    Object.assign(cursor.style, {position: 'fixed', left: 0, top: 0, zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(-60px,-60px)'});
    document.documentElement.appendChild(cursor);
    document.addEventListener('mousemove', (e) => { cursor.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);

    const caption = document.createElement('div');
    caption.id = 'demo-caption';
    Object.assign(caption.style, {
      position: 'fixed', left: '50%%', bottom: '58px', transform: 'translateX(-50%%)', zIndex: 2147483646,
      background: '#ffffe1', color: '#000', border: '1px solid #000', boxShadow: '3px 3px 0 #000',
      font: "600 22px Tahoma, Verdana, sans-serif", padding: '8px 18px', display: 'none', whiteSpace: 'nowrap',
    });
    document.documentElement.appendChild(caption);

    const card = document.createElement('div');
    card.id = 'demo-card';
    Object.assign(card.style, {
      position: 'fixed', inset: 0, zIndex: 2147483645, background: '#008080', display: 'none',
      alignItems: 'center', justifyContent: 'center', font: '18px Tahoma, Verdana, sans-serif', color: '#000',
    });
    document.documentElement.appendChild(card);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
  else add();
})();
""" % repr(START_PLACE)

CARD_HTML = """
<div style="width:760px;background:#c0c0c0;box-shadow:inset -1px -1px #000,inset 1px 1px #fff,inset -2px -2px #808080,inset 2px 2px #dfdfdf;padding:3px">
  <div style="background:#000080;color:#fff;font:700 15px Tahoma;padding:4px 8px">{title}</div>
  <div style="padding:28px 32px 30px">{body}</div>
</div>
"""

TITLE_BODY = """
<div style="font:700 56px 'Pixelify Sans',monospace;line-height:1">WeatherAI</div>
<div style="font:22px Tahoma;margin-top:16px;line-height:1.35">Weather forecasts from its own trained models,<br>shown next to a professional forecast, and checked honestly.</div>
<div style="font:16px Tahoma;margin-top:18px;color:#3b3b3b">LSTM · GRU · CNN-LSTM · ST-Transformer · LightGBM · Ensemble</div>
"""

END_BODY = """
<div style="font:700 44px 'Pixelify Sans',monospace;line-height:1">WeatherAI</div>
<div style="font:20px Tahoma;margin-top:14px;line-height:1.4">React · FastAPI · TensorFlow · LightGBM · PostgreSQL · Ollama</div>
<div style="font:16px Tahoma;margin-top:14px;color:#3b3b3b;line-height:1.45">Weather data: Open-Meteo. Map: © OpenStreetMap contributors.<br>Warnings: NDMA Sachet and the US National Weather Service.<br>Run it locally: see the README.</div>
"""


def caption(page: Page, text: str | None) -> None:
    page.evaluate(
        "(t) => { const c = document.getElementById('demo-caption'); if (!c) return; c.textContent = t || ''; c.style.display = t ? 'block' : 'none'; }",
        text,
    )


def card(page: Page, title: str | None, body: str = "") -> None:
    html = CARD_HTML.format(title=title, body=body) if title else ""
    page.evaluate(
        """(h) => {
          const c = document.getElementById('demo-card'); if (!c) return;
          c.innerHTML = h; c.style.display = h ? 'flex' : 'none';
          const cursor = document.getElementById('demo-cursor'); if (cursor) cursor.style.visibility = h ? 'hidden' : 'visible';
        }""",
        html,
    )


def choose_city(page: Page, name: str, region: str) -> None:
    """Pick a city with the app's own search (no reload, so in-memory caches survive)."""
    box = page.get_by_placeholder("Search city")
    box.click()
    box.fill(name)
    # Match the city's own name too, so stale results from an earlier search are never picked.
    option = page.get_by_role("option").filter(has_text=name).filter(has_text=region).first
    option.wait_for(timeout=15_000)
    option.click()
    page.get_by_text(f"WeatherAI – {name}").first.wait_for(timeout=15_000)  # the window title shows the new place


def wait_map_ready(page: Page, timeout_s: float = 150) -> None:
    """Wait for the map's points. If Open-Meteo's per-minute limit was hit (re-recording
    several times in a row does that), the app offers "Try again": wait and press it."""
    ready = page.get_by_text("apart. Times are in your time zone")
    retry = page.get_by_role("button", name="Try again")
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if ready.is_visible():
            return
        if retry.is_visible():
            page.wait_for_timeout(20_000)
            retry.click()
        page.wait_for_timeout(500)
    raise TimeoutError("the map never finished loading")


def glide(page: Page, locator, steps: int = 28) -> None:
    """Move the pointer smoothly to the middle of an element, then click it."""
    box = locator.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=steps)
    page.wait_for_timeout(150)
    locator.click()


def start_menu(page: Page, item: str) -> None:
    """Open the taskbar's Start menu and pick an item, as a visitor would."""
    glide(page, page.get_by_role("button", name="Start", exact=True))
    page.wait_for_timeout(500)
    glide(page, page.locator(".r-start-menu").get_by_text(item, exact=True), steps=16)


def scroll_to_heading(page: Page, text: str, offset: int = 70) -> None:
    page.evaluate(
        """([t, off]) => {
          const h = [...document.querySelectorAll('h2')].find((e) => e.textContent.trim().startsWith(t));
          if (h) window.scrollTo({ top: h.getBoundingClientRect().top + window.scrollY - off, behavior: 'smooth' });
        }""",
        [text, offset],
    )
    page.wait_for_timeout(900)


def record(video_dir: Path) -> tuple[Path, float]:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(
            viewport={"width": W, "height": H}, record_video_dir=str(video_dir), record_video_size={"width": W, "height": H},
            color_scheme="light", reduced_motion="no-preference", locale="en-GB", timezone_id="Asia/Kolkata",
        )
        context.add_init_script(OVERLAY_JS)
        started = time.monotonic()
        page = context.new_page()
        page.mouse.move(W - 80, H - 120)

        # Off-camera (trimmed away): open the map once so its forecast points are cached,
        # then start on the Dashboard. The map later opens without an empty loading state.
        # The map scene opens on Jaipur, so its points are fetched here, in the same page session.
        page.goto(f"{BASE}/#/dashboard")
        page.get_by_role("heading", name="Now").wait_for(timeout=30_000)
        choose_city(page, "Jaipur", "Rajasthan")
        page.goto(f"{BASE}/#/map")
        wait_map_ready(page)
        page.wait_for_timeout(1500)  # let the basemap tiles land in the browser cache too
        page.goto(f"{BASE}/#/models")  # its code and results load once here, not on camera
        page.get_by_role("heading", name="Test-set results").wait_for(timeout=30_000)
        page.get_by_role("rowheader", name="ST-Transformer").first.wait_for(timeout=30_000)
        choose_city(page, "Delhi", "Delhi")
        page.goto(f"{BASE}/#/dashboard")
        page.wait_for_timeout(800)
        page.get_by_role("heading", name="Now").wait_for(timeout=30_000)
        page.wait_for_timeout(1200)

        # 1. Hook: title card over the live Dashboard.
        card(page, "WeatherAI", TITLE_BODY)
        trim_from = time.monotonic() - started
        page.wait_for_timeout(3400)
        card(page, None)
        caption(page, "Live weather for any city, from Open-Meteo")
        page.wait_for_timeout(2400)

        # 2. Search a city.
        caption(page, "Search any city, or ask by voice")
        box = page.get_by_placeholder("Search city")
        glide(page, box)
        page.keyboard.type("Jaipur", delay=130)
        option = page.get_by_role("option").filter(has_text="Rajasthan").first
        option.wait_for(timeout=15_000)
        page.wait_for_timeout(500)
        glide(page, option, steps=18)
        page.get_by_role("heading", name="Now").wait_for(timeout=30_000)
        page.wait_for_timeout(1300)

        # 3. The magic moment: WeatherAI's own models against Open-Meteo (opened from the Start menu).
        caption(page, "Every page is in the Start menu")
        start_menu(page, "Forecast")
        caption(page, None)
        page.get_by_role("heading", name="WeatherAI model prediction, next 24 hours").wait_for(timeout=30_000)
        page.get_by_role("tab", name="Ensemble", exact=True).wait_for(timeout=30_000)
        scroll_to_heading(page, "WeatherAI model prediction")
        caption(page, "WeatherAI's own models next to Open-Meteo, with 80% error ranges")
        page.wait_for_timeout(1500)
        glide(page, page.get_by_role("tab", name="ST-Transformer", exact=True))
        page.wait_for_timeout(1800)
        glide(page, page.get_by_role("tab", name="Ensemble", exact=True))
        page.wait_for_timeout(1800)

        # 4. The weather map.
        caption(page, None)
        page.evaluate("window.scrollTo({ top: 0, behavior: 'smooth' })")
        page.wait_for_timeout(400)
        glide(page, page.get_by_role("link", name="Map", exact=True))
        page.get_by_text("apart. Times are in your time zone").wait_for(timeout=20_000)
        caption(page, "Temperature, rain and wind for the next 48 hours")
        page.wait_for_timeout(1000)
        later = page.get_by_role("button", name="One hour later")
        glide(page, later)
        for _ in range(5):
            page.wait_for_timeout(380)
            later.click()
        page.wait_for_timeout(600)
        glide(page, page.get_by_role("group", name="Map layer").get_by_role("button", name="Wind"))
        page.wait_for_timeout(1000)
        for _ in range(4):
            later.click()
            page.wait_for_timeout(420)
        page.wait_for_timeout(900)

        # 5. Proof: scored on months the models never saw.
        caption(page, None)
        glide(page, page.get_by_role("link", name="Models", exact=True))
        page.get_by_role("heading", name="Test-set results").wait_for(timeout=30_000)
        caption(page, "Every model scored on 10 months of data it never saw")
        page.wait_for_timeout(2200)
        scroll_to_heading(page, "Test-set results", offset=-150)
        page.wait_for_timeout(2200)
        scroll_to_heading(page, "Error by hours ahead")
        caption(page, "Error by hours ahead, error ranges and a weather-station check")
        page.wait_for_timeout(2400)

        # 6. Units: back to the Dashboard, switch to Fahrenheit, mph and a 12-hour clock.
        caption(page, None)
        page.evaluate("window.scrollTo({ top: 0, behavior: 'smooth' })")
        page.wait_for_timeout(400)
        start_menu(page, "Dashboard")
        page.get_by_role("heading", name="Now").wait_for(timeout=30_000)
        page.wait_for_timeout(900)
        caption(page, "°C or °F, km/h or mph, a 24- or 12-hour clock")
        start_menu(page, "Units…")
        dialog = page.get_by_role("dialog", name="Units")
        dialog.wait_for(timeout=10_000)
        page.wait_for_timeout(500)
        for name in ("Fahrenheit (°F)", "Miles per hour (mph)", "12-hour (1:15 pm)"):
            glide(page, dialog.get_by_text(name, exact=True), steps=14)
            page.wait_for_timeout(300)
        page.wait_for_timeout(700)
        glide(page, dialog.get_by_role("button", name="OK"))
        page.wait_for_timeout(2600)

        # 7. End card.
        caption(page, None)
        card(page, "WeatherAI", END_BODY)
        page.wait_for_timeout(3200)
        # The file keeps recording while the browser closes; cut it here.
        trim_to = time.monotonic() - started

        video = Path(page.video.path())
        context.close()
        browser.close()
    return video, trim_from, trim_to


def encode(ffmpeg: str, raw: Path, trim_from: float, trim_to: float) -> None:
    mp4 = OUT / "weatherai-demo.mp4"
    gif = OUT / "weatherai-demo.gif"
    start = max(trim_from - 0.2, 0)
    subprocess.run(
        [ffmpeg, "-y", "-ss", f"{start:.2f}", "-t", f"{trim_to - start:.2f}", "-i", str(raw), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264",
         "-preset", "slow", "-crf", "24", "-movflags", "+faststart", "-an", str(mp4)],
        check=True,
    )
    # GIF for the README: smaller, fewer frames, one shared palette (the UI is flat colour, so it compresses well).
    chain = "fps=12,scale=960:-1:flags=lanczos"
    subprocess.run(
        [ffmpeg, "-y", "-i", str(mp4), "-vf",
         f"{chain},split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
         "-loop", "0", str(gif)],
        check=True,
    )
    for f in (mp4, gif):
        print(f"{f.name}: {f.stat().st_size / 1e6:.1f} MB")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "ffmpeg")
    parser.add_argument("--base", default=BASE, help="where the Vite dev server runs")
    args = parser.parse_args()
    globals()["BASE"] = args.base.rstrip("/")
    with tempfile.TemporaryDirectory() as tmp:
        raw, trim_from, trim_to = record(Path(tmp))
        print(f"recorded {raw.name}; keeping {trim_from:.1f} s to {trim_to:.1f} s")
        encode(args.ffmpeg, raw, trim_from, trim_to)


if __name__ == "__main__":
    main()
