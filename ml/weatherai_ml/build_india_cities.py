"""Build ml/weatherai_ml/regions/india.json: python -m weatherai_ml.build_india_cities

Looks up each city with Open-Meteo geocoding (restricted to India) so the
coordinates come from a reference source rather than being typed by hand.

Choice of cities:
  - training: the capital (or nearest large city) of every state and union
    territory, plus the existing North India cities and a few extra climates;
  - holdout: cities the model never trains on, used to measure accuracy at
    unseen locations. Each is at least 150 km from every training city so its
    neighbour points don't overlap a training city's.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import httpx

GEOCODE = "https://geocoding-api.open-meteo.com/v1/search"
OUT = Path(__file__).resolve().parent / "regions" / "india.json"
MIN_HOLDOUT_KM = 150

# (id, search name, state or union territory, role). `admin` is used to pick the right match.
CITIES = [
    # Existing North India cities (already downloaded)
    ("delhi", "New Delhi", "Delhi", "train"),
    ("jaipur", "Jaipur", "Rajasthan", "train"),
    ("lucknow", "Lucknow", "Uttar Pradesh", "train"),
    ("chandigarh", "Chandigarh", "Chandigarh", "train"),
    ("agra", "Agra", "Uttar Pradesh", "train"),
    ("dehradun", "Dehradun", "Uttarakhand", "train"),
    ("kanpur", "Kanpur", "Uttar Pradesh", "train"),
    ("amritsar", "Amritsar", "Punjab", "train"),
    ("bikaner", "Bikaner", "Rajasthan", "train"),
    ("varanasi", "Varanasi", "Uttar Pradesh", "train"),
    # State capitals (or the nearest large city to a new capital)
    ("vijayawada", "Vijayawada", "Andhra Pradesh", "train"),
    ("itanagar", "Itanagar", "Arunachal Pradesh", "train"),
    ("guwahati", "Guwahati", "Assam", "train"),
    ("patna", "Patna", "Bihar", "train"),
    ("raipur", "Raipur", "Chhattisgarh", "train"),
    ("panaji", "Panjim", "Goa", "train"),  # "Panaji" alone matches a village in Gujarat
    ("ahmedabad", "Ahmedabad", "Gujarat", "train"),
    ("hisar", "Hisar", "Haryana", "train"),
    ("shimla", "Shimla", "Himachal Pradesh", "train"),
    ("ranchi", "Ranchi", "Jharkhand", "train"),
    ("bengaluru", "Bengaluru", "Karnataka", "train"),
    ("thiruvananthapuram", "Thiruvananthapuram", "Kerala", "train"),
    ("bhopal", "Bhopal", "Madhya Pradesh", "train"),
    ("mumbai", "Mumbai", "Maharashtra", "train"),
    ("imphal", "Imphal", "Manipur", "train"),
    ("shillong", "Shillong", "Meghalaya", "train"),
    ("aizawl", "Aizawl", "Mizoram", "train"),
    ("kohima", "Kohima", "Nagaland", "train"),
    ("bhubaneswar", "Bhubaneswar", "Odisha", "train"),
    ("gangtok", "Gangtok", "Sikkim", "train"),
    ("chennai", "Chennai", "Tamil Nadu", "train"),
    ("hyderabad", "Hyderabad", "Telangana", "train"),
    ("agartala", "Agartala", "Tripura", "train"),
    ("kolkata", "Kolkata", "West Bengal", "train"),
    # Union territory capitals
    ("port_blair", "Port Blair", "Andaman and Nicobar", "train"),
    ("daman", "Daman", "Dadra and Nagar Haveli and Daman and Diu", "train"),
    ("srinagar", "Srinagar", "Jammu and Kashmir", "train"),
    ("leh", "Leh", "Ladakh", "train"),
    ("kavaratti", "Kavaratti", "Lakshadweep", "train"),
    ("puducherry", "Puducherry", "Puducherry", "train"),
    # Held-out cities: never trained on, used to measure accuracy at unseen places
    ("aurangabad", "Aurangabad", "Maharashtra", "holdout"),
    ("nagpur", "Nagpur", "Maharashtra", "holdout"),
    ("coimbatore", "Coimbatore", "Tamil Nadu", "holdout"),
    ("visakhapatnam", "Visakhapatnam", "Andhra Pradesh", "holdout"),
    ("jodhpur", "Jodhpur", "Rajasthan", "holdout"),
    ("indore", "Indore", "Madhya Pradesh", "holdout"),
    # Dibrugarh was tried but is only 136 km from Itanagar; the north-east is too densely trained to hold a city out.
    ("gorakhpur", "Gorakhpur", "Uttar Pradesh", "holdout"),
    ("mangaluru", "Mangaluru", "Karnataka", "holdout"),
]

DISPLAY_NAMES = {"delhi": "Delhi", "panaji": "Panaji", "mangaluru": "Mangaluru"}


def km(a: dict, b: dict) -> float:
    p1, p2 = math.radians(a["latitude"]), math.radians(b["latitude"])
    dp, dl = p2 - p1, math.radians(b["longitude"] - a["longitude"])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def norm(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())


def lookup(client: httpx.Client, name: str, state: str) -> dict:
    r = client.get(GEOCODE, params={"name": name, "count": 10, "language": "en", "format": "json", "countryCode": "IN"})
    r.raise_for_status()
    results = r.json().get("results", [])
    if not results:
        raise ValueError(f"no match for {name}")
    # Prefer a match in the expected state/territory, then the most populous.
    in_state = [x for x in results if norm(state)[:6] in norm(x.get("admin1", "")) or norm(x.get("admin1", ""))[:6] in norm(state)]
    pool = in_state or results
    return max(pool, key=lambda x: x.get("population") or 0)


def main() -> None:
    out = []
    with httpx.Client(timeout=30) as client:
        for cid, name, state, role in CITIES:
            hit = lookup(client, name, state)
            out.append(
                {
                    "id": cid,
                    "name": DISPLAY_NAMES.get(cid, hit["name"]),
                    "state": state,
                    "role": role,
                    "latitude": round(hit["latitude"], 4),
                    "longitude": round(hit["longitude"], 4),
                    "geocoded_admin1": hit.get("admin1"),
                }
            )
            print(f"{role:7s} {cid:20s} {hit['name']:20s} {hit.get('admin1', ''):30s} {hit['latitude']:.3f},{hit['longitude']:.3f}")

    train = [c for c in out if c["role"] == "train"]
    for h in (c for c in out if c["role"] == "holdout"):
        nearest = min(train, key=lambda t: km(h, t))
        d = km(h, nearest)
        flag = "" if d >= MIN_HOLDOUT_KM else "  <-- TOO CLOSE"
        print(f"holdout {h['name']:15s} nearest training city {nearest['name']:15s} {d:6.0f} km{flag}")
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2))
    print(f"wrote {OUT} ({len(train)} training, {len(out) - len(train)} held out)")


if __name__ == "__main__":
    main()
