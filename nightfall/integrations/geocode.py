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
