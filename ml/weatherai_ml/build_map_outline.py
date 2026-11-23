"""Builds public/map-outline.json: a small world outline drawn under the weather map at once, so the map
is never a blank grey box while OpenStreetMap's tiles are still loading.

Source: Natural Earth 1:50m admin-0 countries (public domain), as redistributed in the npm package
world-atlas 2.0.2 (ISC), the same file build_india_outline.py reads. Natural Earth draws India's
de facto boundary. Lines are simplified to about 5 km and rounded to 0.01 degrees: it only has to
look right until the tiles arrive.

Run (the TopoJSON file comes from `npm pack world-atlas@2.0.2`):
    python -m weatherai_ml.build_map_outline path/to/countries-50m.json
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from .build_india_outline import _polygon_arcs, decode_arcs, ring

OUT = Path(__file__).resolve().parents[2] / "public" / "map-outline.json"
TOLERANCE_DEG = 0.05
MIN_SIZE_DEG = 0.4


def simplify(points: list[tuple[float, float]], tolerance: float = TOLERANCE_DEG) -> list[tuple[float, float]]:
    """Douglas-Peucker: drop points closer than `tolerance` to the line through their neighbours."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = points[a], points[b]
        dx, dy = x2 - x1, y2 - y1
        length = math.sqrt(dx * dx + dy * dy)
        best, index = 0.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            if length:
                d = abs(dy * (px - x1) - dx * (py - y1)) / length
            else:  # both ends are the same point: use the plain distance to it
                d = math.sqrt(pow(px - x1, 2) + pow(py - y1, 2))
            if d > best:
                best, index = d, i
        if best > tolerance:
            keep[index] = True
            stack += [(a, index), (index, b)]
    return [p for p, k in zip(points, keep) if k]


def encode(points: list[tuple[float, float]]) -> list[int]:
    """[lat0, lon0, dlat1, dlon1, ...] in hundredths of a degree: whole-number steps keep the file small."""
    out: list[int] = []
    last = (0, 0)
    for lon, lat in points:
        q = (round(lat * 100), round(lon * 100))
        if out and q == last:
            continue
        out += [q[0] - last[0], q[1] - last[1]]
        last = q
    return out


def build(topo: dict) -> dict:
    """The simplified outline of every country, ready to write as JSON."""
    arcs = [simplify(a) for a in decode_arcs(topo)]
    land = []
    for g in topo["objects"]["countries"]["geometries"]:
        for polygon in _polygon_arcs(g):
            outer = ring(arcs, polygon[0])
            lons, lats = [p[0] for p in outer], [p[1] for p in outer]
            # Islands smaller than about 40 km across are left out.
            if len(outer) >= 4 and (max(lats) - min(lats)) + (max(lons) - min(lons)) > MIN_SIZE_DEG:
                land.append(encode(outer))
    return {
        "source": "Natural Earth 1:50m admin-0 countries (public domain), via world-atlas 2.0.2; simplified",
        "note": "land: each country's outer ring as [lat0, lon0, dlat, dlon, ...] in hundredths of a degree.",
        "land": land,
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    out = build(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    points = sum(len(r) // 2 for r in out["land"])
    print(f"wrote {OUT} ({len(out['land'])} land shapes, {points} points, {OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
