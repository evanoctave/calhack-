"""Nominatim geocoding (OpenStreetMap). No key; needs a User-Agent; one request per second max."""

from __future__ import annotations

from typing import Final

import httpx

URL: Final = "https://nominatim.openstreetmap.org/search"
UA: Final = "nightfall-calhacks/0.1 (hackathon demo)"


def geocode(address: str) -> tuple[float, float, str]:
    """Return (lat, lng, display_name) for an address. Raises on no match or HTTP error."""
    r = httpx.get(URL, params={"q": address, "format": "json", "limit": 1}, headers={"User-Agent": UA}, timeout=15.0)
    r.raise_for_status()
    rows = r.json()
    if not rows:
        raise ValueError(f"no match for {address!r}")
    return float(rows[0]["lat"]), float(rows[0]["lon"]), str(rows[0].get("display_name", address))


SUGGEST_URL: Final = "https://photon.komoot.io/api/"


def suggest(query: str, limit: int = 5) -> list[str]:
    """Address completions for a partial query (Photon, built for search-as-you-type; Nominatim forbids it)."""
    r = httpx.get(
        SUGGEST_URL, params={"q": query, "limit": limit, "lang": "en"}, headers={"User-Agent": UA}, timeout=8.0
    )
    r.raise_for_status()
    out: list[str] = []
    for f in r.json().get("features", []):
        p = f.get("properties", {})
        street = " ".join(x for x in (p.get("housenumber"), p.get("street")) if x)
        head = street or p.get("name", "")
        region = " ".join(x for x in (p.get("state"), p.get("postcode")) if x)
        label = ", ".join(x for x in (head, p.get("city") or p.get("county"), region, p.get("country")) if x)
        if label and label not in out:
            out.append(label)
    return out
