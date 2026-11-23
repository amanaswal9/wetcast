r"""Turn a picture of your choosing into the ASCII art on Wetcast's desktop, for this computer only.

    & "$HOME\.venvs\weatherai\Scripts\python.exe" docs/share/make_wallpaper_ascii.py local\wallpaper.jpg

Works best with black-and-white line art. The picture and the result stay out of git (local/ and
src/local/ are ignored), so a picture you don't own the rights to is never committed or published.
Without src/local/wallpaper.ts the desktop shows only the weather note.

Chromium decodes the picture; the white margins are trimmed; each character cell is averaged to
one darkness value; a gentle contrast curve keeps thin ink lines visible; and the darkness picks a
character from a ramp (no asterisks).
"""

import argparse
import base64
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "src" / "local" / "wallpaper.ts"

# From empty to fully inked.
RAMP = " .:-=+o#%@"
# Height over width of one character in the desktop font (Consolas, line-height 1), measured in the browser.
CHAR_ASPECT = 1.82

# Measures the picture in the page: trims white margins, then averages each cell's darkness.
MEASURE_JS = """async ([src, cols, aspect]) => {
  const img = new Image(); img.src = src; await img.decode()
  const w = img.naturalWidth, h = img.naturalHeight
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0)
  const px = g.getImageData(0, 0, w, h).data
  const dark = (x, y) => { const i = (y * w + x) * 4; return 1 - (px[i] + px[i + 1] + px[i + 2]) / 765 }
  // Bounds of everything darker than near-white.
  let x0 = w, y0 = h, x1 = 0, y1 = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (dark(x, y) > 0.08) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1
  const cw = bw / cols, ch = cw * aspect, rows = Math.floor(bh / ch)
  const out = []
  for (let r = 0; r < rows; r++) {
    const line = []
    for (let k = 0; k < cols; k++) {
      let sum = 0, n = 0
      for (let y = Math.floor(y0 + r * ch); y < Math.floor(y0 + (r + 1) * ch); y++)
        for (let x = Math.floor(x0 + k * cw); x < Math.floor(x0 + (k + 1) * cw); x++) { sum += dark(x, y); n++ }
      line.push(n ? sum / n : 0)
    }
    out.push(line)
  }
  return out
}"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("picture", type=Path)
    parser.add_argument("--columns", type=int, default=150)
    parser.add_argument("--contrast", type=float, default=1.0, help="below 1 lifts thin lines, above 1 thins them")
    parser.add_argument("--floor", type=float, default=0.12, help="cells lighter than this stay empty, which clears speckle")
    args = parser.parse_args()

    data = base64.b64encode(args.picture.read_bytes()).decode()
    kind = "png" if args.picture.suffix.lower() == ".png" else "jpeg"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        cells = page.evaluate(MEASURE_JS, [f"data:image/{kind};base64,{data}", args.columns, CHAR_ASPECT])
        browser.close()

    top = len(RAMP) - 1
    def level(d: float) -> int:
        # Light specks from fine hatching become empty space; the rest is spread over the ramp.
        if d < args.floor:
            return 0
        d = (d - args.floor) / (1 - args.floor)
        return min(top, 1 + round(pow(d, args.contrast) * (top - 1)))

    rows = ["".join(RAMP[level(d)] for d in row).rstrip() for row in cells]
    while rows and not rows[0]:
        rows.pop(0)
    while rows and not rows[-1]:
        rows.pop()
    assert "*" not in "".join(rows)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        "// Made by docs/share/make_wallpaper_ascii.py from a picture in local/. Not in git: see .gitignore.\n"
        f"export const WALLPAPER: string[] = {json.dumps(rows, ensure_ascii=False, indent=0)}\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"wrote {OUT.relative_to(ROOT)}: {len(rows)} rows, {args.columns} columns")


if __name__ == "__main__":
    main()
