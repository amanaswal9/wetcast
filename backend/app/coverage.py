"""Where Wetcast's own models make predictions, and how accurate to expect them to be there.

The served models were trained on one region's cities (registry.region_id):
- "india": 40 training cities plus 8 held-out cities the models never saw. The models use a place's
  latitude, longitude and elevation, not its name, so they can run anywhere; they are offered at any
  point in India within REACH of a training city, the farthest that a held-out city (where the
  accuracy at new places was measured) lies from one.
- "north_india" (the older models): only the ten training cities themselves.

Every answer says which of three kinds of place it is, with the accuracy measured for that kind:
a training city (its own test-period error), a held-out city (its own error at a place never trained
on), or anywhere else (the held-out cities' error, as the best available estimate).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache

from weatherai_ml.config import REGIONS_DIR, TARGETS, City, region_cities
from weatherai_ml.predict import haversine_km

from .registry import ModelRegistry

CITY_KM = 30.0  # a point this close to a known city gets that city's forecast and accuracy
GRID_DEG = 0.05  # other points snap to this grid (about 5 km) so nearby requests share a forecast
COAST_KM = 10.0  # slack along the coast, where the 1:50m outline can cut off coastal towns


@dataclass(frozen=True)
class Located:
    """Where a requested point falls relative to the models' cities."""

    city: City  # what the forecast is computed for: a known city, or a grid point
    kind: str  # "trained", "held_out" or "untrained"
    nearest: City  # nearest training city
    nearest_km: float


@lru_cache
def _outline() -> dict:
    """India's outline (polygons with holes) and coastline, from Natural Earth via the ml package."""
    data = json.loads((REGIONS_DIR / "india_outline.json").read_text(encoding="utf-8"))
    return {
        "polygons": [[[(float(x), float(y)) for x, y in r] for r in polygon] for polygon in data["polygons"]],
        "coast": [[(float(x), float(y)) for x, y in line] for line in data["coast"]],
    }


def _in_ring(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    """Ray casting; ring points are (lon, lat) as in the outline file."""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        (xi, yi), (xj, yj) = ring[i], ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _near_coast(lon: float, lat: float, km: float) -> bool:
    """Within `km` of India's coastline (flat-earth distance; fine at this scale)."""
    kx, ky = 111.32 * math.cos(math.radians(lat)), 110.57
    for line in _outline()["coast"]:
        for (x1, y1), (x2, y2) in zip(line, line[1:]):
            ax, ay = (x1 - lon) * kx, (y1 - lat) * ky
            bx, by = (x2 - lon) * kx, (y2 - lat) * ky
            dx, dy = bx - ax, by - ay
            t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
            if math.hypot(ax + t * dx, ay + t * dy) <= km:
                return True
    return False


def in_india(latitude: float, longitude: float, country: str | None = None) -> bool:
    """A country code from the app's place search wins; otherwise Natural Earth's outline decides,
    with COAST_KM of slack along the coast (land borders get none)."""
    if country:
        return country.upper() == "IN"
    inside = any(
        _in_ring(longitude, latitude, polygon[0]) and not any(_in_ring(longitude, latitude, h) for h in polygon[1:])
        for polygon in _outline()["polygons"]
    )
    return inside or _near_coast(longitude, latitude, COAST_KM)


@lru_cache
def cities(region: str) -> tuple[City, ...]:
    """All of a region's cities, training and held out."""
    return region_cities(region)


@lru_cache
def extra_cities(region: str) -> tuple[City, ...]:
    """More cities the public copy forecasts, as ordinary places near the training cities: never
    trained on and not used to measure accuracy (weatherai_ml/build_india_extra.py makes the list)."""
    path = REGIONS_DIR / f"{region}_extra.json"
    if not path.exists():
        return ()
    return tuple(City(r["id"], r["name"], r["latitude"], r["longitude"], r["state"], "extra") for r in json.loads(path.read_text()))


def training_cities(region: str) -> list[City]:
    """The cities the models trained on."""
    return [c for c in cities(region) if c.role == "train"]


def held_out_cities(region: str) -> list[City]:
    """The cities kept out of training to measure accuracy at new places."""
    return [c for c in cities(region) if c.role == "holdout"]


def _nearest(latitude: float, longitude: float, among: list[City]) -> tuple[City, float]:
    """The closest city in `among` and its distance in km."""
    return min(((c, haversine_km(latitude, longitude, c.latitude, c.longitude)) for c in among), key=lambda x: x[1])


@lru_cache
def reach_km(region: str) -> float:
    """How far from a training city predictions are offered: the farthest held-out city's distance,
    rounded up to 10 km. 0 when the region has no held-out cities (only training cities are served)."""
    held = held_out_cities(region)
    if not held:
        return 0.0
    far = max(_nearest(h.latitude, h.longitude, training_cities(region))[1] for h in held)
    return math.ceil(far / 10) * 10


def locate(region: str, latitude: float, longitude: float, country: str | None = None) -> Located | None:
    """Where a point falls, or None when the models don't cover it."""
    nearest, km = _nearest(latitude, longitude, training_cities(region))
    known, known_km = _nearest(latitude, longitude, list(cities(region)))
    if known_km <= CITY_KM:
        kind = "trained" if known.role == "train" else "held_out"
        return Located(known, kind, nearest, km)
    if km > reach_km(region) or region != "india" or not in_india(latitude, longitude, country):
        return None
    # Snap to the grid, so requests a few hundred metres apart share one cached forecast.
    lat = round(round(latitude / GRID_DEG) * GRID_DEG, 2)
    lon = round(round(longitude / GRID_DEG) * GRID_DEG, 2)
    point = City(f"pt{lat:+.2f}{lon:+.2f}", f"{abs(lat):.2f}°{'N' if lat >= 0 else 'S'}, {abs(lon):.2f}°{'E' if lon >= 0 else 'W'}", lat, lon)
    return Located(point, "untrained", nearest, km)


def unsupported_detail(region: str) -> str:
    """The message for a place the models don't cover."""
    if region == "india":
        return (
            f"Wetcast's models cover India: anywhere within {reach_km(region):.0f} km of the "
            f"{len(training_cities(region))} cities they were trained on."
        )
    return f"Wetcast's models only cover the {len(training_cities(region))} cities they were trained on."


def expected_error(registry: ModelRegistry, name: str, located: Located) -> dict:
    """The accuracy measured for this kind of place, for one model, as mean absolute errors."""
    per_city = registry.evaluation_summary(name)["per_city_mae"]
    metrics = registry.metrics(name)
    region = registry.region_id
    if located.kind != "untrained":
        mae = {t: per_city[t].get(located.city.id) for t in TARGETS}
        basis = (
            f"measured for {located.city.name} on the test period"
            if located.kind == "trained"
            else f"measured for {located.city.name}, a city the models never trained on"
        )
        low = high = None
    else:
        mae = {t: metrics["test_unseen"][t]["mae"] for t in TARGETS}
        held = [c.id for c in held_out_cities(region)]
        temps = [per_city["temperature"][c] for c in held if c in per_city["temperature"]]
        low, high = (min(temps), max(temps)) if temps else (None, None)
        basis = f"measured on {len(held)} cities the models never trained on"
    return {
        "mae": {t: (round(float(v), 3) if v is not None else None) for t, v in mae.items()},
        "basis": basis,
        "temperature_range": [round(low, 2), round(high, 2)] if low is not None else None,
    }


def describe(region: str, located: Located) -> tuple[str, str]:
    """A short label and a one-sentence explanation."""
    c, near, km = located.city, located.nearest, round(located.nearest_km)
    if located.kind == "trained":
        return "Trained city", f"{c.name} is one of the cities the models were trained on."
    if located.kind == "held_out":
        return (
            "Held-out city",
            f"{c.name} was kept out of training to test the models on new places; the nearest training city "
            f"is {near.name}, {km} km away.",
        )
    return (
        "Untrained location",
        f"The models never trained here; the nearest training city is {near.name}, {km} km away.",
    )
