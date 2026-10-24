"""OpenStreetMap Overpass query for hazards near a point. No key; needs a User-Agent."""

from __future__ import annotations

from typing import Any, Final

import httpx

MIRRORS: Final = ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter")
UA: Final = "nightfall-calhacks/0.1 (hackathon demo)"


def hazards(lat: float, lng: float, radius_m: int) -> list[dict[str, Any]]:
    """Ways tagged water, rail, motorway or construction within radius, with center coordinates."""
    q = (
        f'[out:json][timeout:25];(way["waterway"](around:{radius_m},{lat},{lng});'
        f'way["natural"="water"](around:{radius_m},{lat},{lng});'
        f'way["railway"="rail"](around:{radius_m},{lat},{lng});'
        f'way["highway"~"^motorway"](around:{radius_m},{lat},{lng});'
        f'way["landuse"="construction"](around:{radius_m},{lat},{lng}););out center tags 80;'
    )
    last: Exception | None = None
    for url in MIRRORS:
        try:
            r = httpx.post(url, data={"data": q}, headers={"User-Agent": UA}, timeout=40.0)
            r.raise_for_status()
            return list(r.json().get("elements", []))
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError(f"overpass failed: {last}")
