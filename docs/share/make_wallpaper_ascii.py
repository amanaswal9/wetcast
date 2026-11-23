r"""Turn a picture of your choosing into the ASCII art on Wetcast's desktop, for this computer only.

    & "$HOME\.venvs\weatherai\Scripts\python.exe" docs/share/make_wallpaper_ascii.py local\wallpaper.jpg
    ... local\wallpaper.jpg --photo --crop 25,95,455,545 --mask local\wallpaper-mask.txt --columns 150

The picture and the result stay out of git (local/ and src/local/ are ignored), so a picture is
never committed or published. Without src/local/wallpaper.ts the desktop stays plain.

How it works, all inside Chromium so the real desktop font is used:
1. The picture is cropped and, with --mask (an SVG path in the picture's own pixel coordinates),
   everything outside the subject is blanked, so the background doesn't clutter the outline.
2. Photos (--photo): the tones inside the mask are equalised, so face, hair and clothes each use
   the full range, and the picture is sharpened a little so features keep their edges.
3. Every printable character is drawn in Noto Sans Mono (the desktop font, loaded from
   node_modules so it is the very same file) and measured on a small grid inside its cell.
   Each cell of the picture is measured the same way, and gets the character whose shape matches
   best: a slash on a slanted edge, an underscore under a brim, a dense letter in a dark patch.
   That keeps lines crisp, which choosing by brightness alone cannot.

Writes src/local/wallpaper.ts with WALLPAPER (dark characters, for the light desktop) and, for
photos, WALLPAPER_LIGHT (light characters for the dark themes, so a face isn't a negative).
"""

import argparse
import base64
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "src" / "local" / "wallpaper.ts"

# Height over width of one character in the desktop font (Noto Sans Mono, line-height 1), measured in Chromium.
CHAR_ASPECT = 1.667
# The desktop picture's font file, the same one the app ships.
FONT_FILE = ROOT / "node_modules" / "@fontsource" / "noto-sans-mono" / "files" / "noto-sans-mono-latin-400-normal.woff2"
# Printable ASCII, without the asterisk (the owner ruled it out) and characters that are awkward in code.
CHARSET = "".join(ch for ch in map(chr, range(32, 127)) if ch not in "*`$\\")

CONVERT_JS = r"""async (o) => {
  const img = new Image(); img.src = o.src; await img.decode()
  const face = new FontFace('Desk Mono', `url(${o.font})`); await face.load(); document.fonts.add(face)
  const [cx, cy, cw, chh] = o.crop || [0, 0, img.naturalWidth, img.naturalHeight]

  // The cropped picture on white, and the subject mask (1 inside, 0 outside).
  const pic = document.createElement('canvas'); pic.width = cw; pic.height = chh
  const pg = pic.getContext('2d'); pg.fillStyle = '#fff'; pg.fillRect(0, 0, cw, chh)
  pg.drawImage(img, -cx, -cy)
  const msk = document.createElement('canvas'); msk.width = cw; msk.height = chh
  const mg = msk.getContext('2d')
  if (o.mask) { mg.translate(-cx, -cy); mg.fillStyle = '#000'; mg.fill(new Path2D(o.mask)) } else { mg.fillStyle = '#000'; mg.fillRect(0, 0, cw, chh) }

  // Each character cell is gw x gh pixels in the working copy, measured on an sx x sy grid.
  const gw = 10, gh = Math.round(gw * o.aspect), sx = o.grid[0], sy = o.grid[1]
  const cols = o.cols, rows = Math.floor(chh / (cw / cols * o.aspect))
  const W = cols * gw, H = rows * gh
  const scale = (src) => {
    const c = document.createElement('canvas'); c.width = W; c.height = H
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, W, H)
    return g.getImageData(0, 0, W, H).data
  }
  const P = scale(pic), M = scale(msk)
  const N = W * H
  const ink = new Float32Array(N), inside = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    ink[i] = 1 - (0.299 * P[i * 4] + 0.587 * P[i * 4 + 1] + 0.114 * P[i * 4 + 2]) / 255
    inside[i] = M[i * 4 + 3] / 255
  }

  if (o.photo) {
    // Equalise tones inside the subject: each pixel becomes its rank among the subject's pixels.
    const vals = []
    for (let i = 0; i < N; i++) if (inside[i] > 0.5) vals.push(ink[i])
    vals.sort((a, b) => a - b)
    const rank = (v) => { let lo = 0, hi = vals.length; while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] < v) lo = m + 1; else hi = m } return lo / vals.length }
    for (let i = 0; i < N; i++) ink[i] = inside[i] > 0.5 ? rank(ink[i]) : 0
    // Local contrast: compare each pixel with its neighbourhood (mean and spread over a window an
    // eighth of the picture wide), so soft shading on a flash-lit face still shows.
    if (o.local > 0) {
      const R = Math.max(4, Math.round(W / 8))
      const boxBlur = (src) => {
        const a = new Float32Array(N), b = new Float32Array(N)
        for (let y = 0; y < H; y++) { let s = 0, n = 0
          for (let x = 0; x <= Math.min(W - 1, R); x++) { s += src[y * W + x]; n++ }
          for (let x = 0; x < W; x++) { a[y * W + x] = s / n
            if (x + R + 1 < W) { s += src[y * W + x + R + 1]; n++ }
            if (x - R >= 0) { s -= src[y * W + x - R]; n-- } } }
        for (let x = 0; x < W; x++) { let s = 0, n = 0
          for (let y = 0; y <= Math.min(H - 1, R); y++) { s += a[y * W + x]; n++ }
          for (let y = 0; y < H; y++) { b[y * W + x] = s / n
            if (y + R + 1 < H) { s += a[(y + R + 1) * W + x]; n++ }
            if (y - R >= 0) { s -= a[(y - R) * W + x]; n-- } } }
        return b
      }
      const sq = new Float32Array(N); for (let i = 0; i < N; i++) sq[i] = ink[i] * ink[i]
      const mean = boxBlur(ink), meanSq = boxBlur(sq)
      for (let i = 0; i < N; i++) {
        if (inside[i] <= 0.5) continue
        const sd = Math.sqrt(Math.max(1e-4, meanSq[i] - mean[i] * mean[i]))
        const loc = Math.min(1, Math.max(0, 0.5 + (ink[i] - mean[i]) / (3 * sd)))
        ink[i] = (1 - o.local) * ink[i] + o.local * loc
      }
    }
    // Sharpen: add back the difference from a blurred copy (box blur, radius about half a cell).
    const r = Math.round(gw / 2), tmp = new Float32Array(N), blur = new Float32Array(N)
    for (let y = 0; y < H; y++) { let s = 0; for (let x = -r; x <= r; x++) s += ink[y * W + Math.min(W - 1, Math.max(0, x))]
      for (let x = 0; x < W; x++) { tmp[y * W + x] = s / (2 * r + 1); s += ink[y * W + Math.min(W - 1, x + r + 1)] - ink[y * W + Math.max(0, x - r)] } }
    for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x]
      for (let y = 0; y < H; y++) { blur[y * W + x] = s / (2 * r + 1); s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x] } }
    for (let i = 0; i < N; i++) ink[i] = inside[i] > 0.5 ? Math.min(1, Math.max(0, ink[i] + o.sharpen * (ink[i] - blur[i]))) : 0
  } else {
    for (let i = 0; i < N; i++) ink[i] *= inside[i]
  }

  // Shape of every character: mean ink on the sx x sy grid inside its cell, drawn in the desktop font.
  const gc = document.createElement('canvas'); gc.width = gw; gc.height = gh
  const gg = gc.getContext('2d', { willReadFrequently: true })
  gg.font = "100px 'Desk Mono'"; const adv = gg.measureText('M').width / 100
  const fs = gw / adv
  const glyphs = []
  for (const ch of o.charset) {
    gg.fillStyle = '#fff'; gg.fillRect(0, 0, gw, gh); gg.fillStyle = '#000'
    gg.font = `${fs}px 'Desk Mono'`; gg.textBaseline = 'middle'; gg.fillText(ch, 0, gh / 2)
    const d = gg.getImageData(0, 0, gw, gh).data
    const f = new Float32Array(sx * sy)
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++)
      f[Math.min(sy - 1, Math.floor(y * sy / gh)) * sx + Math.min(sx - 1, Math.floor(x * sx / gw))] += 1 - d[(y * gw + x) * 4] / 255
    const area = (gw / sx) * (gh / sy)
    for (let k = 0; k < f.length; k++) f[k] /= area
    glyphs.push([ch, f])
  }
  // Characters cover at most part of their cell; scale so the darkest covers "1".
  let top = 0; for (const [, f] of glyphs) for (const v of f) top = Math.max(top, v)
  for (const [, f] of glyphs) for (let k = 0; k < f.length; k++) f[k] /= top

  const match = (value) => {
    const out = []
    const t = new Float32Array(sx * sy)
    for (let r0 = 0; r0 < rows; r0++) {
      let line = ''
      for (let c0 = 0; c0 < cols; c0++) {
        t.fill(0)
        for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
          const i = (r0 * gh + y) * W + c0 * gw + x
          t[Math.min(sy - 1, Math.floor(y * sy / gh)) * sx + Math.min(sx - 1, Math.floor(x * sx / gw))] += value(i)
        }
        const area = (gw / sx) * (gh / sy); let mean = 0
        for (let k = 0; k < t.length; k++) { t[k] = Math.pow(t[k] / area, o.gamma); mean += t[k] }
        mean /= t.length
        if (mean < o.floor) { line += ' '; continue }
        // Tone mode: the charset is a ramp from light to dark, and the cell's mean picks a step.
        if (o.mode === 'tone') {
          const d = (mean - o.floor) / (1 - o.floor)
          line += o.charset[Math.min(o.charset.length - 1, 1 + Math.round(d * (o.charset.length - 2)))]
          continue
        }
        // Best shape match, with the overall darkness weighted in so tone stays right too.
        let best = ' ', err = Infinity
        for (const [ch, f] of glyphs) {
          let e = 0, fm = 0
          for (let k = 0; k < t.length; k++) { const d = f[k] - t[k]; e += d * d; fm += f[k] }
          fm /= t.length; e += o.toneWeight * t.length * (fm - mean) * (fm - mean)
          if (e < err) { err = e; best = ch }
        }
        line += best
      }
      out.push(line.replace(/\s+$/, ''))
    }
    return out
  }
  const dark = match((i) => ink[i])
  const light = o.photo ? match((i) => (inside[i] > 0.5 ? 1 - ink[i] : 0)) : null
  return { dark, light }
}"""


def convert(picture: Path, columns: int, crop, mask, photo: bool, sharpen: float, gamma: float, floor: float, tone: float, charset: str, grid, local: float, mode: str):
    """Run the conversion in Chromium and return (dark rows, light rows or None)."""
    data = base64.b64encode(picture.read_bytes()).decode()
    kind = "png" if picture.suffix.lower() == ".png" else "jpeg"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        result = page.evaluate(
            CONVERT_JS,
            {
                "src": f"data:image/{kind};base64,{data}",
                "cols": columns,
                "aspect": CHAR_ASPECT,
                "font": "data:font/woff2;base64," + base64.b64encode(FONT_FILE.read_bytes()).decode(),
                "crop": crop,
                "mask": mask,
                "photo": photo,
                "sharpen": sharpen,
                "gamma": gamma,
                "floor": floor,
                "toneWeight": tone,
                "charset": charset,
                "grid": grid,
                "local": local,
                "mode": mode,
            },
        )
        browser.close()
    return result["dark"], result["light"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("picture", type=Path)
    parser.add_argument("--columns", type=int, default=140)
    parser.add_argument("--crop", help="x,y,width,height in pixels, to use only part of the picture")
    parser.add_argument("--mask", type=Path, help="file with an SVG path around the subject, in picture pixels")
    parser.add_argument("--photo", action="store_true", help="for photos: equalise tones and sharpen")
    parser.add_argument("--sharpen", type=float, default=0.8)
    parser.add_argument("--gamma", type=float, default=1.0, help="above 1 lightens mid tones, below 1 darkens them")
    parser.add_argument("--floor", type=float, default=0.06, help="cells lighter than this stay empty")
    parser.add_argument("--tone", type=float, default=2.0, help="how much overall darkness counts against shape")
    parser.add_argument("--charset", default=CHARSET, help="characters to choose from (asterisks are always left out)")
    parser.add_argument("--grid", default="4,7", help="columns,rows of the shape grid inside each character")
    parser.add_argument("--local", type=float, default=0.0, help="0 to 1: how much local contrast to mix in (photos)")
    parser.add_argument("--mode", choices=["shape", "tone"], default="shape",
                        help="shape: best-matching character shape; tone: the charset is a light-to-dark ramp")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    crop = [int(v) for v in args.crop.split(",")] if args.crop else None
    mask = args.mask.read_text(encoding="utf-8").strip() if args.mask else None
    charset = "".join(ch for ch in dict.fromkeys(" " + args.charset) if ch not in "*`$\\")
    grid = [int(v) for v in args.grid.split(",")]
    dark, light = convert(args.picture, args.columns, crop, mask, args.photo, args.sharpen, args.gamma, args.floor, args.tone, charset, grid, args.local, args.mode)

    # Trim rows that are empty in both versions, keeping the two the same height.
    both = [d or (light[i] if light else "") for i, d in enumerate(dark)]
    first = next((i for i, r in enumerate(both) if r), 0)
    last = max((i for i, r in enumerate(both) if r), default=len(both) - 1)
    dark = dark[first : last + 1]
    light = light[first : last + 1] if light else None
    assert "*" not in "".join(dark + (light or []))

    body = f"export const WALLPAPER: string[] = {json.dumps(dark, ensure_ascii=False, indent=0)}\n"
    if light:
        body += f"export const WALLPAPER_LIGHT: string[] = {json.dumps(light, ensure_ascii=False, indent=0)}\n"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        "// Made by docs/share/make_wallpaper_ascii.py from a picture in local/. Not in git: see .gitignore.\n" + body,
        encoding="utf-8",
        newline="\n",
    )
    print(f"wrote {args.out}: {len(dark)} rows, {args.columns} columns")


if __name__ == "__main__":
    main()
