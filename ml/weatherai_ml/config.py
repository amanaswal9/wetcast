"""Single source of truth for the forecasting setup."""

import json
from dataclasses import dataclass
from pathlib import Path

ML_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ML_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
ARTIFACTS_DIR = ML_ROOT / "artifacts"
REGIONS_DIR = Path(__file__).resolve().parent / "regions"


@dataclass(frozen=True)
class City:
    id: str
    name: str
    latitude: float
    longitude: float
    state: str = ""
    # "train": used for training/validation/test. "holdout": never trained on;
    # only used to measure accuracy at unseen locations.
    role: str = "train"


# North India: ten cities spanning the Indo-Gangetic plain, Thar desert edge and Himalayan foothills.
CITIES: tuple[City, ...] = (
    City("delhi", "Delhi", 28.6139, 77.2090),
    City("jaipur", "Jaipur", 26.9124, 75.7873),
    City("lucknow", "Lucknow", 26.8467, 80.9462),
    City("chandigarh", "Chandigarh", 30.7333, 76.7794),
    City("agra", "Agra", 27.1767, 78.0081),
    City("dehradun", "Dehradun", 30.3165, 78.0322),
    City("kanpur", "Kanpur", 26.4499, 80.3319),
    City("amritsar", "Amritsar", 31.6340, 74.8723),
    City("bikaner", "Bikaner", 28.0229, 73.3119),
    City("varanasi", "Varanasi", 25.3176, 82.9739),
)

CITY_BY_ID = {c.id: c for c in CITIES}

REGION_NAMES = ("north_india", "india")
DEFAULT_REGION = "north_india"


def region_cities(region: str) -> tuple[City, ...]:
    """Cities for a region. The all-India list is built by build_india_cities.py.
    The ten North India cities keep their original coordinates there, because
    their data was downloaded at exactly those points."""
    if region == "north_india":
        return CITIES
    if region == "india":
        rows = json.loads((REGIONS_DIR / "india.json").read_text())
        out = []
        for r in rows:
            original = CITY_BY_ID.get(r["id"])
            lat, lon = (original.latitude, original.longitude) if original else (r["latitude"], r["longitude"])
            out.append(City(r["id"], r["name"], lat, lon, r["state"], r["role"]))
        return tuple(out)
    raise ValueError(f"unknown region {region!r}")


def raw_dir(region: str) -> Path:
    return RAW_DIR if region == "north_india" else DATA_DIR / f"raw_{region}"


def artifacts_dir(region: str) -> Path:
    """North India keeps its original location; other regions get a subfolder."""
    return ARTIFACTS_DIR if region == "north_india" else ARTIFACTS_DIR / region

# Spatial context: the city plus four neighbours ~55 km away (0.5 degrees).
NEIGHBOUR_OFFSET_DEG = 0.5
POINTS: tuple[tuple[str, float, float], ...] = (
    ("c", 0.0, 0.0),
    ("n", NEIGHBOUR_OFFSET_DEG, 0.0),
    ("s", -NEIGHBOUR_OFFSET_DEG, 0.0),
    ("e", 0.0, NEIGHBOUR_OFFSET_DEG),
    ("w", 0.0, -NEIGHBOUR_OFFSET_DEG),
)

# Open-Meteo hourly variables requested for every point (training and inference).
API_VARIABLES: tuple[str, ...] = (
    "temperature_2m",
    "relative_humidity_2m",
    "precipitation",
    "pressure_msl",
    "wind_speed_10m",
    "wind_direction_10m",
    "cloud_cover",
)

# Per-point derived features, in order.
POINT_FEATURES: tuple[str, ...] = ("temp", "rh", "precip_log1p", "pressure", "wind_u", "wind_v", "cloud")
TIME_FEATURES: tuple[str, ...] = ("hour_sin", "hour_cos", "doy_sin", "doy_cos")
STATIC_FEATURES: tuple[str, ...] = ("lat", "lon", "elevation")

# The exact model input order. Saved with every model and checked at inference.
FEATURE_ORDER: tuple[str, ...] = (
    tuple(f"{p}_{f}" for p, _, _ in POINTS for f in POINT_FEATURES) + TIME_FEATURES + STATIC_FEATURES
)

TARGETS: tuple[str, ...] = ("temperature", "humidity", "precipitation")
TARGET_UNITS = {"temperature": "°C", "humidity": "%", "precipitation": "mm"}

LOOKBACK_HOURS = 48
HORIZON_HOURS = 24

# Chronological split (UTC). A window belongs to a split only if every input
# and target hour lies inside it, so no window straddles a boundary.
DATA_START = "2023-01-01"
DATA_END = "2026-10-31"
SPLITS = {
    "train": ("2023-01-01T00:00", "2024-12-31T23:00"),
    "val": ("2025-01-01T00:00", "2025-12-31T23:00"),
    "test": ("2026-01-01T00:00", "2026-10-31T23:00"),
}

INTERVAL_LEVEL = 0.8
SEED = 42
