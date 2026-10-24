"""Fetch live places for the household and write data/places.<slug>.live.json.

Usage: .venv/bin/python scripts/run_actor.py [--slug fullerton] [--no-google]
Hazards from Overpass (free); open-at-night places from the Apify Google Maps scraper (APIFY_TOKEN).
Without a token, hazards still come from Overpass and the call-first rows fall back to the fixture.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from nightfall import places  # noqa: E402
from nightfall.household import load  # noqa: E402
from nightfall.integrations import apify, overpass  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", default="fullerton")
    ap.add_argument("--no-google", action="store_true")
    a = ap.parse_args()
    hh = load(ROOT / "data" / "household.json")
    home = (hh.home_lat, hh.home_lng)
    radius_m = int(hh.radius_mi * 1609.34)
    rows: list[dict] = []
    try:
        hz = places.from_overpass(overpass.hazards(hh.home_lat, hh.home_lng, radius_m), home)
        print(f"overpass: {len(hz)} hazards")
        rows += hz
    except Exception as e:  # noqa: BLE001
        print(f"overpass fallback: {e}")
    fixture = json.loads((ROOT / "data" / f"places.{a.slug}.json").read_text())
    if apify.enabled() and not a.no_google:
        try:
            items = apify.google_places(hh.home_lat, hh.home_lng, hh.radius_mi * 1.609, places.SEARCHES)
            g = places.from_google(items, home)
            print(f"apify: {len(items)} rows -> {len(g)} places")
            rows += g
        except Exception as e:  # noqa: BLE001
            print(f"apify fallback: {e}")
            rows += [p for p in fixture if p["category"] not in ("water", "rail", "motorway", "construction")]
    else:
        print("apify: no token or --no-google; using fixture call-first rows")
        rows += [p for p in fixture if p["category"] not in ("water", "rail", "motorway", "construction")]
    if not any(p["category"] in ("water", "rail", "motorway", "construction") for p in rows):
        rows += [p for p in fixture if p["category"] in ("water", "rail", "motorway", "construction")]
    out = ROOT / "data" / f"places.{a.slug}.live.json"
    out.write_text(json.dumps(rows, indent=1) + "\n")
    print(f"wrote {out} ({len(rows)} rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
