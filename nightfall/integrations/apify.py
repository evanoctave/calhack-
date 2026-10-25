"""Apify at setup: our published Actor night-search-radius first, the Google Maps Scraper directly as fallback.

Both run synchronously and return raw dataset items.
"""

from __future__ import annotations

import os
from typing import Any, Final

import httpx

ACTOR: Final = os.environ.get("APIFY_PLACES_ACTOR", "compass~crawler-google-places")
BASE: Final = "https://api.apify.com/v2"
SEARCH_ACTOR: Final = os.environ.get("APIFY_SEARCH_ACTOR", "evanoctave~night-search-radius")


def enabled() -> bool:
    """True when a token is configured (used only at setup time, never at 2 AM)."""
    return bool(os.environ.get("APIFY_TOKEN"))


def google_places(
    lat: float,
    lng: float,
    radius_km: float,
    searches: list[str],
    per_search: int = 6,
    timeout_s: float = 300.0,
    memory_mbytes: int | None = None,
) -> list[dict[str, Any]]:
    """Run the scraper for several search strings around a point. Raises on HTTP errors."""
    body = {
        "searchStringsArray": searches,
        "customGeolocation": {"type": "Point", "coordinates": [str(lng), str(lat)], "radiusKm": radius_km},
        "maxCrawledPlacesPerSearch": per_search,
        "language": "en",
        "skipClosedPlaces": True,
        "scrapeReviewsPersonalData": False,
        "maxReviews": 0,
        "maxImages": 0,
    }
    r = httpx.post(
        f"{BASE}/acts/{ACTOR}/run-sync-get-dataset-items",
        params={"timeout": int(timeout_s), "format": "json", **({"memory": memory_mbytes} if memory_mbytes else {})},
        headers={"Authorization": f"Bearer {os.environ['APIFY_TOKEN']}"},
        json=body,
        timeout=timeout_s + 30,
    )
    r.raise_for_status()
    data = r.json()
    return list(data) if isinstance(data, list) else []


def night_search_radius(
    lat: float, lng: float, radius_mi: float, timeout_s: float = 300.0, google_maps: bool = True
) -> list[dict[str, Any]]:
    """Run our Store Actor: hazards, open-at-night places with phones and hours, nearest first. Raises on HTTP errors."""
    r = httpx.post(
        f"{BASE}/acts/{SEARCH_ACTOR}/run-sync-get-dataset-items",
        params={"timeout": int(timeout_s), "format": "json"},
        headers={"Authorization": f"Bearer {os.environ['APIFY_TOKEN']}"},
        json={"lat": lat, "lng": lng, "radius_mi": radius_mi, "google_maps": google_maps},
        timeout=timeout_s + 30,
    )
    r.raise_for_status()
    data = r.json()
    return list(data) if isinstance(data, list) else []
