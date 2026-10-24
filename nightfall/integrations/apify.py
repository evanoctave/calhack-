"""Apify Google Maps Scraper (compass~crawler-google-places) run synchronously. Returns raw items."""

from __future__ import annotations

import os
from typing import Any, Final

import httpx

ACTOR: Final = os.environ.get("APIFY_PLACES_ACTOR", "compass~crawler-google-places")
BASE: Final = "https://api.apify.com/v2"


def enabled() -> bool:
    """True when a token is configured (used only at setup time, never at 2 AM)."""
    return bool(os.environ.get("APIFY_TOKEN"))


def google_places(
    lat: float, lng: float, radius_km: float, searches: list[str], per_search: int = 6, timeout_s: float = 300.0
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
        params={"timeout": int(timeout_s), "format": "json"},
        headers={"Authorization": f"Bearer {os.environ['APIFY_TOKEN']}"},
        json=body,
        timeout=timeout_s + 30,
    )
    r.raise_for_status()
    data = r.json()
    return list(data) if isinstance(data, list) else []
