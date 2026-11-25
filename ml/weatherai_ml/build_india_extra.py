"""Build ml/weatherai_ml/regions/india_extra.json: python -m weatherai_ml.build_india_extra

More cities for the public copy's forecasts. The models never train on them and they are not used to
measure accuracy: the public export forecasts them as ordinary places in India, the way the full setup
forecasts any point near the training cities. Training and the held-out list are unchanged.

Choice: the large cities not already covered, and a second city in most states. Each must be more
than CITY_KM from every covered city (a closer one would just get that city's forecast) and within
the models' reach of a training city. Open-Meteo's free limit (10,000 calls a day, shared by everyone
on the publishing machine) is what keeps the list short: about 90 cities in all, updated 8 times a day.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx

from .build_india_cities import km, lookup
from .config import REGIONS_DIR

OUT = REGIONS_DIR / "india_extra.json"
CITY_KM = 30  # the server's backend/app/coverage.py CITY_KM
REACH_KM = 310  # the server's reach_km("india"): farthest held-out city from a training city

# (id, search name, state or union territory)
EXTRA = [
    ("pune", "Pune", "Maharashtra"),
    ("nashik", "Nashik", "Maharashtra"),
    ("solapur", "Solapur", "Maharashtra"),
    ("surat", "Surat", "Gujarat"),
    ("vadodara", "Vadodara", "Gujarat"),
    ("rajkot", "Rajkot", "Gujarat"),
    ("ludhiana", "Ludhiana", "Punjab"),
    ("jalandhar", "Jalandhar", "Punjab"),
    ("meerut", "Meerut", "Uttar Pradesh"),
    ("prayagraj", "Prayagraj", "Uttar Pradesh"),
    ("bareilly", "Bareilly", "Uttar Pradesh"),
    ("aligarh", "Aligarh", "Uttar Pradesh"),
    ("kota", "Kota", "Rajasthan"),
    ("udaipur", "Udaipur", "Rajasthan"),
    ("jabalpur", "Jabalpur", "Madhya Pradesh"),
    ("gwalior", "Gwalior", "Madhya Pradesh"),
    ("madurai", "Madurai", "Tamil Nadu"),
    ("tiruchirappalli", "Tiruchirappalli", "Tamil Nadu"),
    ("salem", "Salem", "Tamil Nadu"),
    ("mysuru", "Mysuru", "Karnataka"),
    ("hubballi", "Hubli", "Karnataka"),
    ("kochi", "Kochi", "Kerala"),
    ("kozhikode", "Kozhikode", "Kerala"),
    ("nellore", "Nellore", "Andhra Pradesh"),
    ("tirupati", "Tirupati", "Andhra Pradesh"),
    ("warangal", "Warangal", "Telangana"),
    ("jamshedpur", "Jamshedpur", "Jharkhand"),
    ("dhanbad", "Dhanbad", "Jharkhand"),
    ("gaya", "Gaya", "Bihar"),
    ("muzaffarpur", "Muzaffarpur", "Bihar"),
    ("bilaspur", "Bilaspur", "Chhattisgarh"),
    ("siliguri", "Siliguri", "West Bengal"),
    ("asansol", "Asansol", "West Bengal"),
    ("jammu", "Jammu", "Jammu and Kashmir"),
    ("dibrugarh", "Dibrugarh", "Assam"),
    ("silchar", "Silchar", "Assam"),
    ("dimapur", "Dimapur", "Nagaland"),
    ("rourkela", "Rourkela", "Odisha"),
    ("berhampur", "Brahmapur", "Odisha"),
    ("haldwani", "Haldwani", "Uttarakhand"),
    ("dharamshala", "Dharamsala", "Himachal Pradesh"),
    ("kolhapur", "Kolhapur", "Maharashtra"),
]

# Names shown in place of the search name (the geocoder spells some with accents or older names).
DISPLAY_NAMES = {"hubballi": "Hubballi", "berhampur": "Berhampur", "dharamshala": "Dharamshala"}


def main() -> None:
    """Geocode every city, check its distances, and write the list."""
    covered = json.loads((REGIONS_DIR / "india.json").read_text())
    training = [c for c in covered if c["role"] == "train"]
    out: list[dict] = []
    problems = []
    with httpx.Client(timeout=30) as client:
        for cid, name, state in EXTRA:
            hit = lookup(client, name, state)
            city = {
                "id": cid,
                "name": DISPLAY_NAMES.get(cid, name),
                "state": state,
                "latitude": round(hit["latitude"], 4),
                "longitude": round(hit["longitude"], 4),
                "geocoded_admin1": hit.get("admin1"),
            }
            near = min(covered + out, key=lambda c: km(city, c))
            near_km = km(city, near)
            reach = min(km(city, t) for t in training)
            note = ""
            if near_km <= CITY_KM:
                note = f"  <-- within {CITY_KM} km of {near['name']}"
            elif reach > REACH_KM:
                note = f"  <-- {reach:.0f} km from the nearest training city"
            if note:
                problems.append(cid)
            print(f"{cid:16s} {hit['name']:16s} {hit.get('admin1', ''):22s} {hit['latitude']:.3f},{hit['longitude']:.3f}  nearest {near['name']} {near_km:.0f} km{note}")
            out.append(city)
    if problems:
        raise SystemExit(f"not written: fix {', '.join(problems)}")
    OUT.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {OUT} ({len(out)} cities)")


if __name__ == "__main__":
    main()
