"""Phone page-switch speed probe (not a test): how long each page takes to appear and to finish,
on the production build with a phone profile (4x slower CPU) and recorded network responses.

Compare two builds in alternation, so background load affects both equally:
    npm run build ; Copy-Item dist dist-base -Recurse      (the "before" build)
    ... change code ... ; npm run build                     (the "after" build)
    python e2e/speed_probe.py --dirs dist-base dist --rounds 5

For each page switch it reports the median over rounds of:
    shown  - from the click until the page's own content is on screen (no loading placeholder)
    ready  - until it has finished loading its data and no placeholder is left
    blocked- total main-thread time in long tasks (>50 ms) during the switch
"""

from __future__ import annotations

import argparse
import statistics
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from conftest import PHONE, ROOT, _port_open, close, open_app  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PAGES = ["map", "models", "analytics", "locations", "forecast", "dashboard"]

PROBE_JS = """
window.__longTasks = 0;
try {
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__longTasks += e.duration })
    .observe({ type: 'longtask', buffered: false });
} catch (e) {}
"""

# The page counts as shown when #content has something other than the loading placeholder, and
# as ready when no placeholder (skeleton, busy region, "Loading…" text) is left inside it.
WAIT_SHOWN = """() => { const c = document.getElementById('content'); if (!c) return false;
  return c.children.length > 0 && !c.querySelector(':scope > [aria-busy="true"] .r-group-title') }"""
WAIT_READY = """() => { const c = document.getElementById('content'); if (!c) return false;
  if (c.querySelector('.r-skeleton, .r-chart-skeleton, [aria-busy="true"]')) return false;
  return !/Loading/.test(c.innerText.slice(0, 4000)) }"""


def serve(dist: str, port: int) -> subprocess.Popen:
    vite = ROOT / "node_modules" / "vite" / "bin" / "vite.js"
    proc = subprocess.Popen(
        ["node", str(vite), "preview", "--outDir", dist, "--port", str(port), "--strictPort", "--host", "127.0.0.1"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
    )
    for _ in range(100):
        if _port_open(port):
            return proc
        time.sleep(0.1)
    proc.kill()
    raise SystemExit(f"vite preview for {dist} did not start")


def one_round(browser, base: str) -> dict[str, tuple[float, float, float]]:
    page = open_app(browser, base, PHONE)
    cdp = page.context.new_cdp_session(page)
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})
    page.goto(f"{base}/#/dashboard")
    page.wait_for_load_state("networkidle")
    page.wait_for_function(WAIT_READY, timeout=30_000)
    page.wait_for_timeout(2500)  # let the idle-time preloading finish, as for a real visitor
    out = {}
    for pid in PAGES:
        page.evaluate(PROBE_JS)
        t0 = time.perf_counter()
        page.evaluate(f"location.hash = '#/{pid}'")
        page.wait_for_function(WAIT_SHOWN, timeout=30_000, polling="raf")
        shown = time.perf_counter() - t0
        page.wait_for_function(WAIT_READY, timeout=30_000, polling="raf")
        ready = time.perf_counter() - t0
        page.wait_for_timeout(300)
        blocked = page.evaluate("window.__longTasks") / 1000
        out[pid] = (shown, ready, blocked)
        page.wait_for_timeout(700)
    close(page)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dirs", nargs="+", default=["dist"], help="build folders to compare, e.g. dist-base dist")
    parser.add_argument("--rounds", type=int, default=5)
    args = parser.parse_args()
    servers = {d: (4180 + i, serve(d, 4180 + i)) for i, d in enumerate(args.dirs)}
    results: dict[str, dict[str, list]] = {d: {p: [] for p in PAGES} for d in args.dirs}
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for r in range(args.rounds):
                for d in args.dirs:  # alternate builds every round
                    port = servers[d][0]
                    base = f"http://127.0.0.1:{port}"
                    import conftest  # the recorded-network router compares against BASE

                    conftest.BASE = base
                    for pid, v in one_round(browser, base).items():
                        results[d][pid].append(v)
                print(f"round {r + 1}/{args.rounds} done", flush=True)
            browser.close()
    finally:
        for _, proc in servers.values():
            proc.terminate()
    med = lambda xs, k: statistics.median(x[k] for x in xs) * 1000  # noqa: E731
    print(f"\n{'page':<11}" + "".join(f"{d:>30}" for d in args.dirs))
    print(f"{'':<11}" + "".join(f"{'shown / ready / blocked ms':>30}" for _ in args.dirs))
    for pid in PAGES:
        row = "".join(f"{med(results[d][pid], 0):>10.0f}{med(results[d][pid], 1):>10.0f}{med(results[d][pid], 2):>10.0f}" for d in args.dirs)
        print(f"{pid:<11}{row}")


if __name__ == "__main__":
    main()
