"""Make Wetcast's dithered black-and-white artwork: an original sky (sun, cumulus clouds,
a low horizon) built from noise in code, then Floyd-Steinberg dithered to 1-bit, in the look
of early-90s scanned pictures. No outside images are used.

Run from the repository root with the project's Python environment:
    & "$HOME\\.venvs\\weatherai\\Scripts\\python.exe" docs/share/make_dither_art.py

Writes public/art/sky.png (320 x 180, shown at 2x with crisp pixels).
"""

import struct
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
W, H = 320, 180
rng = np.random.default_rng(1998)


def value_noise(width: int, height: int, cell: int) -> np.ndarray:
    """Smooth random field: random values on a coarse grid, blended with a smoothstep."""
    gw, gh = width // cell + 2, height // cell + 2
    grid = rng.random((gh, gw)).astype(np.float32)
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32) / cell
    x0, y0 = xx.astype(int), yy.astype(int)
    fx, fy = xx - x0, yy - y0
    sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    top = grid[y0, x0] * (1 - sx) + grid[y0, x0 + 1] * sx
    bottom = grid[y0 + 1, x0] * (1 - sx) + grid[y0 + 1, x0 + 1] * sx
    return top * (1 - sy) + bottom * sy


def write_png_1bit(path: Path, pixels: np.ndarray) -> None:
    """Write a black-and-white image as a 1-bit greyscale PNG (no imaging library needed)."""
    height, width = pixels.shape
    rows = b"".join(b"\x00" + np.packbits(row > 0).tobytes() for row in pixels)  # filter byte 0, then 8 pixels a byte

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 1, 0, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def fractal(width: int, height: int) -> np.ndarray:
    total, amp, norm = np.zeros((height, width), np.float32), 1.0, 0.0
    for cell in (64, 32, 16, 8, 4):
        total += amp * value_noise(width, height, cell)
        norm += amp
        amp *= 0.55
    return total / norm


y, x = np.mgrid[0:H, 0:W].astype(np.float32)

# Sky: darker at the top, lighter towards the horizon.
sky = 0.30 + 0.45 * (y / H)

# Sun upper right, with a soft glow.
sun_x, sun_y, sun_r = 238, 52, 20
d = np.hypot(x - sun_x, y - sun_y)
sky = np.maximum(sky, np.clip(1.15 - d / (sun_r * 3.2), 0, 1) * 0.85)
sky[d < sun_r] = 1.0

# Clouds: noise shaped into puffy banks, lit from above (bright tops, grey undersides).
noise = fractal(W, H)
band = np.exp(-np.square((y - 118) / 30)) + 0.75 * np.exp(-np.square((y - 66) / 16) - np.square((x - 85) / 75))
density = np.clip((noise * 1.4 + band * 0.6 - 0.86) * 6.0, 0, 1)
shade = np.clip(1.0 - (np.roll(density, -6, axis=0) - density) * 1.8 - (y / H) * 0.25, 0.35, 1.0)
img = sky * (1 - density) + shade * density

# Low hills along the bottom.
ridge = 160 + 8 * np.sin(x / 37) + 5 * np.sin(x / 13 + 1.3)
img[y > ridge] = 0.12 + 0.05 * fractal(W, H)[y > ridge]

# Floyd-Steinberg dither to pure black and white.
work = np.clip(img, 0, 1).astype(np.float32).copy()
out = np.zeros_like(work, dtype=np.uint8)
for j in range(H):
    for i in range(W):
        old = work[j, i]
        new = 1.0 if old >= 0.5 else 0.0
        out[j, i] = 255 if new else 0
        err = old - new
        if i + 1 < W:
            work[j, i + 1] += err * 7 / 16
        if j + 1 < H:
            if i > 0:
                work[j + 1, i - 1] += err * 3 / 16
            work[j + 1, i] += err * 5 / 16
            if i + 1 < W:
                work[j + 1, i + 1] += err * 1 / 16

target = ROOT / "public" / "art"
target.mkdir(parents=True, exist_ok=True)
write_png_1bit(target / "sky.png", out)
print("wrote public/art/sky.png")
