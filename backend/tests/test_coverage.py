"""Where the models make predictions: India's outline and the distance rule."""

from __future__ import annotations

import pytest

from app import coverage


@pytest.mark.parametrize(
    ("name", "lat", "lon", "inside"),
    [
        ("Delhi", 28.61, 77.21, True),
        ("Leh", 34.15, 77.58, True),
        ("Port Blair", 11.62, 92.73, True),
        ("Kanyakumari", 8.09, 77.54, True),
        ("Itanagar", 27.08, 93.61, True),
        ("Kathmandu", 27.70, 85.32, False),
        ("Lahore", 31.55, 74.34, False),
        ("Dhaka", 23.81, 90.41, False),
        ("Colombo", 6.93, 79.85, False),
        ("London", 51.5, -0.12, False),
    ],
)
def test_in_india(name, lat, lon, inside):
    assert coverage.in_india(lat, lon) is inside, name


def test_country_code_wins_over_the_outline():
    assert coverage.in_india(27.70, 85.32, "IN")
    assert not coverage.in_india(28.61, 77.21, "PK")


def test_reach_is_the_farthest_held_out_city():
    # Visakhapatnam is about 301 km from Vijayawada, the farthest held-out city from training.
    assert coverage.reach_km("india") == 310
    assert coverage.reach_km("north_india") == 0


def test_locate_kinds():
    assert coverage.locate("india", 28.62, 77.20).kind == "trained"
    assert coverage.locate("india", 26.24, 73.02).kind == "held_out"  # Jodhpur
    pune = coverage.locate("india", 18.52, 73.86)
    assert pune.kind == "untrained" and pune.nearest.id == "mumbai"
    assert coverage.locate("india", 27.70, 85.32) is None  # Kathmandu
    # The old North India set only covers its own cities.
    assert coverage.locate("north_india", 28.62, 77.20).kind == "trained"
    assert coverage.locate("north_india", 18.52, 73.86) is None
