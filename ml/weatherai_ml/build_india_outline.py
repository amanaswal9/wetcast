"""Builds regions/india_outline.json: India's outline, used to tell whether a point is in India.

Source: Natural Earth 1:50m admin-0 countries (public domain), as redistributed in the npm package
world-atlas 2.0.2 (ISC). Natural Earth draws India's de facto boundary. At this scale the outline is
accurate to a few kilometres, so the API also trusts a country code when the app knows one, and
allows a little slack along the coast (arcs no other country uses), where a coarse outline would
otherwise cut off coastal towns; land borders get no slack.

Run (the TopoJSON file comes from `npm pack world-atlas@2.0.2`):
    python -m weatherai_ml.build_india_outline path/to/countries-50m.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from .config import REGIONS_DIR

INDIA_ISO_NUMERIC = "356"
OUT = REGIONS_DIR / "india_outline.json"


def decode_arcs(topo: dict) -> list[list[tuple[float, float]]]:
    """Absolute lon/lat for every arc of a quantized TopoJSON topology."""
    (sx, sy), (tx, ty) = topo["transform"]["scale"], topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        points = []
        for dx, dy in arc:
            x, y = x + dx, y + dy
            points.append((x * sx + tx, y * sy + ty))
        arcs.append(points)
    return arcs


def ring(arcs: list[list[tuple[float, float]]], indexes: list[int]) -> list[tuple[float, float]]:
    """Join arcs into one ring; a negative index means the arc reversed (~i)."""
    out: list[tuple[float, float]] = []
    for i in indexes:
        points = arcs[i] if i >= 0 else list(reversed(arcs[~i]))
        out.extend(points if not out else points[1:])  # consecutive arcs share an end point
    return out


def _polygon_arcs(geometry: dict) -> list[list[list[int]]]:
    """A geometry's polygons as lists of arc-index rings; points and lines have none."""
    if geometry["type"] == "MultiPolygon":
        return geometry["arcs"]
    if geometry["type"] == "Polygon":
        return [geometry["arcs"]]
    return []


def india_polygons(topo: dict) -> tuple[list[list[list[tuple[float, float]]]], list[list[tuple[float, float]]]]:
    """India's polygons, and its coastline: the arcs of its outline that no other country shares."""
    arcs = decode_arcs(topo)
    geometries = topo["objects"]["countries"]["geometries"]
    geometry = next(g for g in geometries if str(g.get("id")) == INDIA_ISO_NUMERIC)
    polygons = _polygon_arcs(geometry)
    used_elsewhere = {
        i if i >= 0 else ~i for g in geometries if g is not geometry for p in _polygon_arcs(g) for r in p for i in r
    }
    india_arcs = {i if i >= 0 else ~i for p in polygons for r in p for i in r}
    coast = [arcs[i] for i in sorted(india_arcs - used_elsewhere)]
    return [[ring(arcs, r) for r in polygon] for polygon in polygons], coast


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    topo = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    polygons, coast = india_polygons(topo)
    out = {
        "source": "Natural Earth 1:50m admin-0 countries v4.1.0 (public domain), via world-atlas 2.0.2",
        "note": "Polygons of [outer ring, holes...]; each ring a list of [longitude, latitude].",
        "polygons": [[[[round(lon, 3), round(lat, 3)] for lon, lat in r] for r in polygon] for polygon in polygons],
        "coast": [[[round(lon, 3), round(lat, 3)] for lon, lat in line] for line in coast],
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    n = sum(len(r) for p in polygons for r in p)
    print(f"wrote {OUT} ({len(polygons)} polygons, {n} points, {len(coast)} coast lines, {OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
