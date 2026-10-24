"""Caregiver setup: type an address, get the hazards around it now and the open-at-night places soon.

Geocode + Overpass run inline (a few seconds). The Apify Google Maps run takes one to two minutes and
costs a few cents, so it runs as a background task and the page polls /setup/status. The result is
cached to data/places.custom.live.json and becomes the household's place list.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from nightfall import places
from nightfall.integrations import apify, geocode, overpass
from nightfall.search import rank

router = APIRouter()
CACHE = Path("data/places.custom.live.json")
_status: dict[str, Any] = {"apify": "idle", "address": "", "hazards": 0, "open": 0, "error": ""}
_task: asyncio.Task[None] | None = None


def _store() -> Any:
    from nightfall.api import store

    return store


class AddressIn(BaseModel):
    address: str
    radius_mi: float = 1.5
    google: bool = True


@router.post("/setup/address")
async def setup_address(body: AddressIn) -> dict[str, Any]:
    """Geocode, fetch hazards now, start the Apify run, move the household home."""
    global _task
    store = _store()
    if not 0.25 < body.radius_mi <= 5:
        raise HTTPException(422, "radius_mi must be in (0.25, 5]")
    try:
        lat, lng, name = await asyncio.to_thread(geocode.geocode, body.address.strip())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(404, f"address not found: {e}") from None
    radius_m = int(body.radius_mi * 1609.34)
    try:
        hz = places.from_overpass(await asyncio.to_thread(overpass.hazards, lat, lng, radius_m), (lat, lng))
    except Exception as e:  # noqa: BLE001
        print(f"overpass fallback: {e}")
        hz = []
    store.hh = replace(store.hh, home_lat=lat, home_lng=lng, radius_mi=body.radius_mi)
    keep = [p for p in store.places if p["category"] not in places.HAZARD_CATS]
    store.places = hz + keep
    _status.update({"address": name, "hazards": len(hz), "open": len(keep), "error": "", "lat": lat, "lng": lng})
    if body.google and apify.enabled():
        if _task is not None and not _task.done():
            _task.cancel()
        _status["apify"] = "running"
        _task = asyncio.create_task(_run_apify(lat, lng, body.radius_mi))
    else:
        _status["apify"] = "skipped" if not body.google else "no token"
    _save(store.places)
    return {"lat": lat, "lng": lng, "display_name": name, "hazards": hz, "apify": _status["apify"]}


async def _run_apify(lat: float, lng: float, radius_mi: float) -> None:
    store = _store()
    try:
        try:
            rows = places.from_actor(await asyncio.to_thread(apify.night_search_radius, lat, lng, radius_mi))
        except Exception as e:  # noqa: BLE001
            print(f"night-search-radius failed ({type(e).__name__}); calling the Google Maps Scraper directly")
            items = await asyncio.to_thread(apify.google_places, lat, lng, radius_mi * 1.609, places.SEARCHES)
            rows = places.from_google(items, (lat, lng))
        g = [p for p in rows if p["category"] not in places.HAZARD_CATS]
        hz = [p for p in rows if p["category"] in places.HAZARD_CATS] or [
            p for p in store.places if p["category"] in places.HAZARD_CATS
        ]
        store.places = hz + g
        _status.update({"apify": "done", "open": len(g)})
        _save(store.places)
    except asyncio.CancelledError:
        _status["apify"] = "cancelled"
        raise
    except Exception as e:  # noqa: BLE001
        _status.update({"apify": "failed", "error": type(e).__name__})
    store.hub.publish("dashboard", {"type": "setup", "apify": _status["apify"], "open": _status["open"]})


def _save(rows: list[dict[str, Any]]) -> None:
    try:
        CACHE.write_text(json.dumps(rows, indent=1) + "\n")
    except OSError as e:
        print(f"places cache not written: {e}")


@router.get("/setup/status")
async def setup_status() -> dict[str, Any]:
    store = _store()
    sections = rank(
        store.places,
        (store.hh.home_lat, store.hh.home_lng),
        store.hh.radius_mi,
        store.now(),
        list(store.hh.familiar_places),
        list(store.hh.contacts),
    )
    return {
        **_status,
        "home": {"lat": store.hh.home_lat, "lng": store.hh.home_lng, "radius_mi": store.hh.radius_mi},
        "hazards_ranked": sections.hazards,
        "call_first": sections.call_first,
        "familiar": sections.familiar,
        "places_source": store.places_source(),
        "total": len(store.places),
    }
