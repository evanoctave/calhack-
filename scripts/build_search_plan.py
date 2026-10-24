"""Build data/search_plan.marina.json, the demo SearchPlan fixture, from the household and places fixtures.

Run from the repo root: python scripts/build_search_plan.py
Ranking reuses nightfall.search.rank, so the fixture matches what the brief shows. The route is straight-line
walking estimates (3 mph) in caregiver order; the geo lane replaces it with real routing.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from nightfall.search import rank

WALK_MPH = 3.0
AT = datetime(2026, 10, 25, 23, 30)  # Sunday night, so open_now reflects a night search


def main() -> None:
    hh = json.loads((ROOT / "data" / "household.json").read_text())
    places = json.loads((ROOT / "data" / "places.marina.json").read_text())
    home = (hh["home_lat"], hh["home_lng"])
    s = rank(places, home, hh["radius_mi"], AT, hh["familiar_places"], hh["contacts"])

    stops = [
        {
            "name": f["name"],
            "lat": f["lat"],
            "lng": f["lng"],
            "distance_mi": f["distance_mi"],
            "eta_min": round(f["distance_mi"] / WALK_MPH * 60),
        }
        for f in s.familiar
    ]
    plan = {
        "profile_id": hh["id"],
        "generated_at": AT.isoformat() + "Z",
        "home": {"lat": home[0], "lng": home[1], "radius_mi": hh["radius_mi"]},
        "open_late": s.call_first,
        "hazards": s.hazards,
        "route": {"stops": stops},
        "local_contacts": s.contacts,
        "source": "fixture",
    }
    out = ROOT / "data" / "search_plan.marina.json"
    out.write_text(json.dumps(plan, indent=2) + "\n")
    print(f"wrote {out.relative_to(ROOT)}: {len(s.call_first)} open_late, {len(s.hazards)} hazards, {len(stops)} stops")


if __name__ == "__main__":
    main()
