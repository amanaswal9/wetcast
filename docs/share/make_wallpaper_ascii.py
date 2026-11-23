r"""Turn a picture of your choosing into the ASCII art on Wetcast's desktop, for this computer only.

    & "$HOME\.venvs\weatherai\Scripts\python.exe" docs/share/make_wallpaper_ascii.py local\wallpaper.jpg

Works with black-and-white line art and, with --photo (and usually --crop), with photos. The picture and the result stay out of git (local/ and
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
# Photos have soft shading, so they get more steps.
PHOTO_RAMP = " .,:;-~=+ilox#X%8@"
# Height over width of one character in the desktop font (Consolas, line-height 1), measured in the browser.
CHAR_ASPECT = 1.82

# Measures the picture in the page: trims white margins, then averages each cell's darkness.
MEASURE_JS = """async ([src, cols, aspect, crop, stretch, sharpen]) => {
  const img = new Image(); img.src = src; await img.decode()
  const w = img.naturalWidth, h = img.naturalHeight
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0)
  const px = g.getImageData(0, 0, w, h).data
  // Darkness of every pixel (perceived brightness, so a red hat reads as darker than pale skin).
  let ink = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) ink[i] = 1 - (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255
  // Photos: unsharp mask (the picture minus a blurred copy, added back) so edges like eyes,
  // mouth and outlines survive being averaged into big character cells.
  if (sharpen > 0) {
    const r = Math.max(2, Math.round(Math.min(w, h) / 150)), blur = new Float32Array(w * h), tmp = new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0
      for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < w) { s += ink[y * w + xx]; n++ } }
      tmp[y * w + x] = s / n
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0
      for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++ } }
      blur[y * w + x] = s / n
    }
    for (let i = 0; i < w * h; i++) ink[i] = Math.min(1, Math.max(0, ink[i] + sharpen * (ink[i] - blur[i])))
  }
  const dark = (x, y) => ink[y * w + x]
  // The part to use: a given crop (x, y, width, height in pixels), or else the bounds of
  // everything darker than near-white, which trims the margins of line art.
  let x0 = w, y0 = h, x1 = 0, y1 = 0
  if (crop) {
    [x0, y0] = crop; x1 = Math.min(w, crop[0] + crop[2]) - 1; y1 = Math.min(h, crop[1] + crop[3]) - 1
  } else {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (dark(x, y) > 0.08) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
    }
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
  // Photos: spread the cells' darkness over the full range (2nd to 98th percentile), so a
  // dim or washed-out picture still uses every character in the ramp.
  if (stretch) {
    const all = out.flat().sort((a, b) => a - b)
    const lo = all[Math.floor(all.length * 0.02)], hi = all[Math.floor(all.length * 0.98)]
    for (const line of out) for (let k = 0; k < line.length; k++) line[k] = Math.min(1, Math.max(0, (line[k] - lo) / (hi - lo || 1)))
  }
  return out
}"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("picture", type=Path)
    parser.add_argument("--columns", type=int, default=150)
    parser.add_argument("--contrast", type=float, default=1.0, help="below 1 lifts thin lines, above 1 thins them")
    parser.add_argument("--floor", type=float, default=0.12, help="cells lighter than this stay empty, which clears speckle")
    parser.add_argument("--crop", help="x,y,width,height in pixels, to use only part of the picture")
    parser.add_argument("--photo", action="store_true", help="for photos: sharpen, stretch the contrast and use a finer ramp")
    args = parser.parse_args()

    data = base64.b64encode(args.picture.read_bytes()).decode()
    kind = "png" if args.picture.suffix.lower() == ".png" else "jpeg"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        crop = [int(v) for v in args.crop.split(",")] if args.crop else None
        cells = page.evaluate(MEASURE_JS, [f"data:image/{kind};base64,{data}", args.columns, CHAR_ASPECT, crop, args.photo, 1.8 if args.photo else 0])
        browser.close()

    ramp = PHOTO_RAMP if args.photo else RAMP
    top = len(ramp) - 1
    def level(d: float) -> int:
        # Light specks from fine hatching become empty space; the rest is spread over the ramp.
        if d < args.floor:
            return 0
        d = (d - args.floor) / (1 - args.floor)
        return min(top, 1 + round(pow(d, args.contrast) * (top - 1)))

    def to_rows(value) -> list[str]:
        return ["".join(ramp[level(value(d))] for d in row).rstrip() for row in cells]

    # Dark characters on a light background: density follows darkness.
    rows = to_rows(lambda d: d)
    # Photos also get a version for the dark themes, where density follows lightness, so a face
    # looks natural instead of like a negative. Line art reads fine as a negative and skips it.
    light = to_rows(lambda d: 1 - d) if args.photo else None
    assert "*" not in "".join(rows + (light or []))

    body = f"export const WALLPAPER: string[] = {json.dumps(rows, ensure_ascii=False, indent=0)}\n"
    if light:
        body += f"export const WALLPAPER_LIGHT: string[] = {json.dumps(light, ensure_ascii=False, indent=0)}\n"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        "// Made by docs/share/make_wallpaper_ascii.py from a picture in local/. Not in git: see .gitignore.\n" + body,
        encoding="utf-8",
        newline="\n",
    )
    print(f"wrote {OUT.relative_to(ROOT)}: {len(rows)} rows, {args.columns} columns")


if __name__ == "__main__":
    main()
