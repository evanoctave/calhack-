"""Caregiver setup: type an address, get the open-at-night places around it as the Apify scrapers finish.

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
from nightfall.integrations import apify, geocode
from nightfall.search import rank

router = APIRouter()
CACHE = Path("data/places.custom.live.json")
_status: dict[str, Any] = {"apify": "idle", "address": "", "hazards": 0, "open": 0, "error": ""}
_task: asyncio.Task[None] | None = None
_open: list[dict[str, Any]] = []
_where: tuple[float, float, float] | None = None
# Few terms, few places each, one scraper run per term in parallel: a handful of places in well under a minute.
# No "24 hour" in the terms: they hid ordinary stores that are open late; rank() puts open-now places first.
FAST_SEARCHES = ["gas station", "convenience store", "hospital emergency room", "pharmacy"]
PER_SEARCH = 5
RUN_MEMORY_MB = 1024


def _where_set(lat: float, lng: float, radius_mi: float) -> None:
    global _where
    _where = (round(lat, 4), round(lng, 4), radius_mi)


def _store() -> Any:
    from nightfall.api import store

    return store


class AddressIn(BaseModel):
    address: str
    radius_mi: float = 1.5
    google: bool = True


@router.post("/setup/address")
async def setup_address(body: AddressIn) -> dict[str, Any]:
    """Geocode and move the household home; with Apify the scrapers run in the background and the
    places show up in /setup/status as each one finishes."""
    global _task, _open
    store = _store()
    if not 0.25 < body.radius_mi <= 5:
        raise HTTPException(422, "radius_mi must be in (0.25, 5]")
    try:
        lat, lng, name = await asyncio.to_thread(geocode.geocode, body.address.strip())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(404, f"address not found: {e}") from None
    store.hh = replace(store.hh, home_lat=lat, home_lng=lng, radius_mi=body.radius_mi, address=body.address.strip())
    running = _task is not None and not _task.done()
    same = (round(lat, 4), round(lng, 4), body.radius_mi) == _where
    _status.update({"address": name, "error": "", "lat": lat, "lng": lng})
    if body.google and apify.enabled():
        if not (running and same):  # a second press for the same place must not pay for a second run
            if running and _task is not None:
                _task.cancel()
            _open = []
            _publish()
            _status["apify"] = "running"
            _where_set(lat, lng, body.radius_mi)
            _task = asyncio.create_task(_run_apify(lat, lng, body.radius_mi))
    else:
        _status["apify"] = "skipped" if not body.google else "no token"
        _open = [p for p in store.places if p["category"] not in places.HAZARD_CATS]
        _publish()
    return {"lat": lat, "lng": lng, "display_name": name, "apify": _status["apify"]}


def _publish() -> None:
    """The open-at-night places found so far; saved so a restart keeps them."""
    store = _store()
    store.places = list(_open)
    _status["open"] = len(_open)
    _save(store.places)


async def _search_one(lat: float, lng: float, radius_mi: float, term: str) -> None:
    """One scraper run for one search term; its places appear as soon as it finishes."""
    items = await asyncio.to_thread(
        apify.google_places, lat, lng, radius_mi * 1.609, [term], PER_SEARCH, 150.0, RUN_MEMORY_MB
    )
    known = {p["name"].casefold() for p in _open}
    _open.extend(p for p in places.from_google(items, (lat, lng)) if p["name"].casefold() not in known)
    _publish()


async def _run_apify(lat: float, lng: float, radius_mi: float) -> None:
    """The search terms run as parallel scraper runs: places appear as each finishes."""
    store = _store()
    try:
        jobs = [_search_one(lat, lng, radius_mi, term) for term in FAST_SEARCHES]
        errors = [r for r in await asyncio.gather(*jobs, return_exceptions=True) if isinstance(r, BaseException)]
        for r in errors:
            print(f"apify search failed: {type(r).__name__}: {r}")
        if len(errors) == len(FAST_SEARCHES):
            _status.update({"apify": "failed", "error": type(errors[0]).__name__})
        else:
            _status["apify"] = "done"
    except asyncio.CancelledError:
        if _task is asyncio.current_task():  # a newer search replaced this one and owns the status
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
