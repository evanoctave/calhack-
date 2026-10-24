"""Turn Overpass hazards and Apify Google Maps rows into the Place shape search.rank consumes.

Runs at setup (scripts/run_actor.py), never during an incident. Dedupes hazards by name within 400 m
so one creek is one row, not forty way segments. Hours parse the Google "11 AM to 9:30 PM" strings into
the "HH:MM-HH:MM" spec; "Open 24 hours" becomes "24/7".
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Final

from nightfall.search import haversine_mi

HAZARD_CATS: Final = frozenset({"water", "rail", "motorway", "construction"})
_WATERWAYS: Final = {"river": "River", "stream": "Stream", "canal": "Canal"}  # not drains, ditches or boat docks
SEARCHES: Final = [
    "24 hour gas station",
    "24 hour convenience store",
    "24 hour restaurant",
    "hospital emergency room",
    "24 hour pharmacy",
    "train station",
]
_CAT: Final[tuple[tuple[re.Pattern[str], str], ...]] = (
    (re.compile(r"gas|fuel|petrol", re.IGNORECASE), "fuel"),
    (re.compile(r"convenience|grocery|market|7-?eleven", re.IGNORECASE), "convenience"),
    (re.compile(r"hospital|emergency|urgent", re.IGNORECASE), "hospital"),
    (re.compile(r"pharmacy|drug", re.IGNORECASE), "pharmacy"),
    (re.compile(r"\b(train|transit|bus|metro)\b|station", re.IGNORECASE), "transit"),
    (re.compile(r"restaurant|diner|cafe|coffee|fast food|donut|taco|burger", re.IGNORECASE), "diner"),
)
# "10 AM to 1:30 PM", "2 to 7 PM" (start may omit AM/PM), repeated for split hours
_RANGE: Final = re.compile(
    r"(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*(?:to|-|–)\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)", re.IGNORECASE
)


def _cat(category: str) -> str | None:
    """Place category from the Google category name; None when nothing fits (the row is skipped)."""
    return next((c for pat, c in _CAT if pat.search(category)), None)


def _minutes(h: int, mi: int, ap: str) -> int:
    return (h % 12 + (12 if ap.upper() == "PM" else 0)) * 60 + mi


def _hhmm(minutes: int) -> str:
    return f"{minutes // 60 % 24:02d}:{minutes % 60:02d}"


def hours_spec(opening_hours: list[dict[str, str]] | None, today: str | None = None) -> str:
    """Google hours for today -> "24/7" | "HH:MM-HH:MM" | "" (unknown or closed)."""
    if not opening_hours:
        return ""
    day = today or datetime.now().strftime("%A")
    row = next(
        (r for r in opening_hours if str(r.get("day", "")).lower().startswith(day.lower()[:3])), opening_hours[0]
    )
    txt = str(row.get("hours", ""))
    if "24 hours" in txt.lower():
        return "24/7"
    ranges = []
    for m in _RANGE.finditer(txt):
        end = _minutes(int(m.group(4)), int(m.group(5) or 0), m.group(6))
        ap = m.group(3) or m.group(6)
        start = _minutes(int(m.group(1)), int(m.group(2) or 0), ap)
        if not m.group(3) and start > end:  # "9 to 5 PM" means 9 AM
            start = _minutes(int(m.group(1)), int(m.group(2) or 0), "AM")
        ranges.append((start, end))
    # One interval is all search.parse_hours takes: first opening to last closing, ignoring a midday gap.
    return f"{_hhmm(ranges[0][0])}-{_hhmm(ranges[-1][1])}" if ranges else ""


def from_google(items: list[dict[str, Any]], home: tuple[float, float], day: str | None = None) -> list[dict[str, Any]]:
    """Map scraper rows to Place dicts; skips ads, closed, coordinate-less and uncategorised rows.

    day names the weekday whose hours to keep (default: today).
    """
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, float, float]] = set()
    for it in items:
        loc = it.get("location") or {}
        if it.get("isAdvertisement") or it.get("permanentlyClosed") or it.get("temporarilyClosed") or "lat" not in loc:
            continue
        name = str(it.get("title", "")).strip()
        category = _cat(str(it.get("categoryName", "")))
        lat, lng = float(loc["lat"]), float(loc["lng"])
        key = (name.lower(), round(lat, 3), round(lng, 3))
        if not name or category is None or key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "category": category,
                "name": name,
                "lat": lat,
                "lng": lng,
                "distance_mi": round(haversine_mi(home[0], home[1], lat, lng), 2),
                "hours": hours_spec(it.get("openingHours"), day),
                "phone": str(it.get("phone") or ""),
                "address": str(it.get("address") or ""),
                "source": "apify",
            }
        )
    return out


def from_overpass(elements: list[dict[str, Any]], home: tuple[float, float]) -> list[dict[str, Any]]:
    """Map Overpass ways to hazard Places, one row per distinct name within 400 m."""
    out: list[dict[str, Any]] = []
    for e in elements:
        t = e.get("tags", {})
        c = e.get("center") or {"lat": e.get("lat"), "lon": e.get("lon")}
        if c.get("lat") is None:
            continue
        if t.get("waterway") in _WATERWAYS or t.get("natural") == "water":
            cat, label = "water", t.get("name") or _WATERWAYS.get(t.get("waterway", ""), "Water body")
        elif t.get("railway") == "rail":
            cat, label = "rail", t.get("name") or "Rail line"
        elif str(t.get("highway", "")).startswith("motorway"):
            cat, label = "motorway", t.get("name") or t.get("ref") or "Freeway on-ramp"
        elif t.get("landuse") == "construction":
            cat, label = "construction", t.get("name") or "Construction site"
        else:
            continue
        lat, lng = float(c["lat"]), float(c["lon"])
        dup = next((p for p in out if p["name"] == label and haversine_mi(p["lat"], p["lng"], lat, lng) < 0.25), None)
        if dup is not None:
            continue
        out.append(
            {
                "category": cat,
                "name": str(label),
                "lat": lat,
                "lng": lng,
                "hours": "",
                "phone": "",
                "source": "apify",
                "distance_mi": round(haversine_mi(home[0], home[1], lat, lng), 2),
            }
        )
    out.sort(key=lambda p: p["distance_mi"])
    return out
