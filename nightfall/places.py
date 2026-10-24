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
SEARCHES: Final = ["24 hour gas station", "24 hour convenience store", "24 hour restaurant",
                   "hospital emergency room", "24 hour pharmacy", "train station"]
_CAT: Final[tuple[tuple[re.Pattern[str], str], ...]] = (
    (re.compile(r"gas|fuel|petrol", re.I), "fuel"),
    (re.compile(r"convenience|grocery|market|7-?eleven", re.I), "convenience"),
    (re.compile(r"hospital|emergency|urgent|medical|clinic", re.I), "hospital"),
    (re.compile(r"pharmacy|drug", re.I), "pharmacy"),
    (re.compile(r"train|transit|bus|metro|station", re.I), "transit"),
    (re.compile(r"restaurant|diner|cafe|coffee|fast food|donut|taco|burger", re.I), "diner"),
)
_TIME: Final = re.compile(r"(\d{1,2})(?::(\d{2}))?\s*(AM|PM)", re.I)


def _cat(name: str, category: str) -> str:
    for pat, c in _CAT:
        if pat.search(category) or pat.search(name):
            return c
    return "diner"


def _hhmm(m: re.Match[str]) -> str:
    h, mi, ap = int(m.group(1)), int(m.group(2) or 0), m.group(3).upper()
    h = h % 12 + (12 if ap == "PM" else 0)
    return f"{h:02d}:{mi:02d}"


def hours_spec(opening_hours: list[dict[str, str]] | None, today: str | None = None) -> str:
    """Google hours for today -> "24/7" | "HH:MM-HH:MM" | "" (unknown or closed)."""
    if not opening_hours:
        return ""
    day = today or datetime.now().strftime("%A")
    row = next((r for r in opening_hours if str(r.get("day", "")).lower().startswith(day.lower()[:3])), opening_hours[0])
    txt = str(row.get("hours", ""))
    if "24 hours" in txt.lower():
        return "24/7"
    times = list(_TIME.finditer(txt))
    if len(times) >= 2:
        return f"{_hhmm(times[0])}-{_hhmm(times[1])}"
    return ""


def from_google(items: list[dict[str, Any]], home: tuple[float, float]) -> list[dict[str, Any]]:
    """Map scraper rows to Place dicts; skips ads, closed and coordinate-less rows."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for it in items:
        loc = it.get("location") or {}
        if it.get("isAdvertisement") or it.get("permanentlyClosed") or it.get("temporarilyClosed") or "lat" not in loc:
            continue
        name = str(it.get("title", "")).strip()
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        out.append({"category": _cat(name, str(it.get("categoryName", ""))), "name": name, "lat": float(loc["lat"]),
                    "lng": float(loc["lng"]), "hours": hours_spec(it.get("openingHours")), "phone": str(it.get("phone") or ""),
                    "address": str(it.get("address") or ""), "source": "apify"})
    return out


def from_overpass(elements: list[dict[str, Any]], home: tuple[float, float]) -> list[dict[str, Any]]:
    """Map Overpass ways to hazard Places, one row per distinct name within 400 m."""
    out: list[dict[str, Any]] = []
    for e in elements:
        t = e.get("tags", {})
        c = e.get("center") or {"lat": e.get("lat"), "lon": e.get("lon")}
        if c.get("lat") is None:
            continue
        if t.get("waterway") or t.get("natural") == "water":
            cat, label = "water", t.get("name") or f"{t.get('waterway', 'water')} channel"
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
        out.append({"category": cat, "name": str(label), "lat": lat, "lng": lng, "hours": "", "phone": "", "source": "apify"})
    out.sort(key=lambda p: haversine_mi(home[0], home[1], p["lat"], p["lng"]))
    return out
