"""Search radius ranking. Haversine, hours parsing, and R9 section ranking over a places list.

Single pass computes distance once per place; sorts on n ~ 200 are cheap. Rejected: a geo index.
The Apify lane fills data/places.*.json; this module only ranks.
"""
from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Final, NamedTuple

HAZARDS: Final = frozenset({"water", "rail", "motorway", "construction"})
CALL_FIRST: Final = frozenset({"fuel", "convenience", "diner", "hospital", "transit", "pharmacy"})


class Sections(NamedTuple):
    hazards: list[dict[str, Any]]
    call_first: list[dict[str, Any]]
    familiar: list[dict[str, Any]]
    contacts: list[dict[str, Any]]


def haversine_mi(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in miles."""
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def parse_hours(spec: str) -> tuple[tuple[int, int], ...]:
    """Minutes-of-day intervals. "24/7" -> ((0,1440),); "22:00-06:00" wraps into two; unknown -> ()."""
    s = spec.strip()
    if s == "24/7":
        return ((0, 1440),)
    try:
        a, b = s.split("-")
        h1, m1 = (int(x) for x in a.split(":"))
        h2, m2 = (int(x) for x in b.split(":"))
    except ValueError:
        return ()
    start, end = h1 * 60 + m1, h2 * 60 + m2
    if start < end:
        return ((start, end),)
    return ((start, 1440), (0, end))


def is_open(hours: tuple[tuple[int, int], ...], at: datetime) -> bool | None:
    """True/False if hours known, None if unknown."""
    if not hours:
        return None
    m = at.hour * 60 + at.minute
    return any(a <= m < b for a, b in hours)


def rank(places: list[dict[str, Any]], home: tuple[float, float], radius_mi: float, at: datetime,
         familiar: list[dict[str, Any]], contacts: list[dict[str, Any]]) -> Sections:
    """R9: hazards by distance; call-first open-now first then unknown, top 8; familiar in caregiver order."""
    inside: list[dict[str, Any]] = []
    for p in places:
        d = haversine_mi(home[0], home[1], float(p["lat"]), float(p["lng"]))
        if d <= radius_mi:
            inside.append({**p, "distance_mi": round(d, 2)})
    hazards = sorted((p for p in inside if p["category"] in HAZARDS), key=lambda p: (p["distance_mi"], p["name"]))

    def open_rank(p: dict[str, Any]) -> int:
        o = is_open(parse_hours(str(p.get("hours", ""))), at)
        return 0 if o is True else 1 if o is None else 2

    callers = [p for p in inside if p["category"] in CALL_FIRST]
    for p in callers:
        p["open_now"] = is_open(parse_hours(str(p.get("hours", ""))), at)
    call_first = sorted(callers, key=lambda p: (open_rank(p), p["distance_mi"], p["name"]))[:8]
    fam = [{**f, "distance_mi": round(haversine_mi(home[0], home[1], f["lat"], f["lng"]), 2)} for f in familiar]
    return Sections(hazards, call_first, fam, list(contacts))
