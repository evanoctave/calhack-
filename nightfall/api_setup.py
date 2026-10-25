"""Caregiver setup: type an address, get the hazards around it now and the open-at-night places soon.

Geocode + Overpass run inline (a few seconds). The Apify Google Maps run takes one to two minutes and
costs a few cents, so it runs as a background task and the page polls /setup/status. The result is
cached to data/places.custom.live.json and becomes the household's place list.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
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
_request_generation = 0
_job_generation = 0


def _store() -> Any:
    from nightfall.api import store

    return store


class AddressIn(BaseModel):
    address: str
    radius_mi: float = 1.5
    google: bool = True


@router.post("/setup/address")
async def setup_address(body: AddressIn) -> dict[str, Any]:
    """Save the home and radius, then update hazards and start the optional Apify run."""
    return await _setup_address(body)


async def _setup_address(body: AddressIn, *, persist_household: bool = True) -> dict[str, Any]:
    """The profile route defers persistence until its other edits can be committed together."""
    global _task, _request_generation, _job_generation
    store = _store()
    if not 0.25 < body.radius_mi <= 5:
        raise HTTPException(422, "radius_mi must be in (0.25, 5]")
    # Only the public route owns persistence. The profile helper is part of an
    # outer transaction and must leave its rollback semantics intact.
    request_generation = None
    if persist_household:
        _request_generation += 1
        request_generation = _request_generation
    try:
        lat, lng, name = await asyncio.to_thread(geocode.geocode, body.address.strip())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(404, f"address not found: {e}") from None
    radius_m = int(body.radius_mi * 1609.34)
    map_error = ""
    try:
        hz = places.from_overpass(await asyncio.to_thread(overpass.hazards, lat, lng, radius_m), (lat, lng))
    except Exception as e:  # noqa: BLE001
        print(f"overpass fallback: {e}")
        hz = []
        map_error = "Nearby map places could not be checked. Try again when the connection is available."
    if request_generation is not None and request_generation != _request_generation:
        raise HTTPException(409, "A newer home-address request replaced this one. Check the current setup.")
    updated = replace(store.hh, address=body.address.strip(), home_lat=lat, home_lng=lng, radius_mi=body.radius_mi)
    if persist_household:
        from nightfall.api_app import _persist_household

        _persist_household(updated)
        # Invalidate before cancelling: the old task's cancellation handler can
        # run after the replacement has already set its own status to running.
        _job_generation += 1
        previous_task, _task = _task, None
        if previous_task is not None and not previous_task.done():
            previous_task.cancel()
    previous_metadata = _matching_metadata(store)
    same_area = (store.hh.home_lat, store.hh.home_lng, store.hh.radius_mi) == (lat, lng, body.radius_mi)
    store.hh = updated
    # Only a refresh of the same area may retain its previous business results.
    keep = (
        [p for p in store.places if p["category"] not in places.HAZARD_CATS]
        if same_area and previous_metadata and previous_metadata.get("complete") is True
        else []
    )
    store.places = hz + keep
    _status.update({"address": name, "hazards": len(hz), "open": len(keep), "error": map_error, "lat": lat, "lng": lng})
    if body.google and apify.enabled():
        _status["apify"] = "running"
        _task = asyncio.create_task(_run_apify(lat, lng, body.radius_mi, _job_generation, hazard_error=map_error))
    else:
        _status["apify"] = "skipped" if not body.google else "no token"
    if persist_household:
        _save(store.places)
    return {"lat": lat, "lng": lng, "display_name": name, "hazards": hz, "apify": _status["apify"]}


async def _run_apify(
    lat: float, lng: float, radius_mi: float, generation: int | None = None, *, hazard_error: str = ""
) -> None:
    store = _store()
    generation = _job_generation if generation is None else generation

    def current() -> bool:
        # The home check also covers a profile transaction that changes the
        # address with google=False. If that transaction rolls back, its old
        # job may still complete normally for the restored home.
        return (
            generation == _job_generation
            and _store() is store
            and (store.hh.home_lat, store.hh.home_lng, store.hh.radius_mi) == (lat, lng, radius_mi)
        )

    try:
        result_error = hazard_error
        try:
            rows = places.from_actor(await asyncio.to_thread(apify.night_search_radius, lat, lng, radius_mi))
            # The combined actor checks hazards too. Its business-only fallback
            # cannot recover a failed Overpass check or certify that area.
            result_error = ""
        except Exception as e:  # noqa: BLE001
            if not current():
                return
            print(f"night-search-radius failed ({type(e).__name__}); calling the Google Maps Scraper directly")
            items = await asyncio.to_thread(apify.google_places, lat, lng, radius_mi * 1.609, places.SEARCHES)
            rows = places.from_google(items, (lat, lng))
        if not current():
            return
        g = [p for p in rows if p["category"] not in places.HAZARD_CATS]
        hz = [p for p in rows if p["category"] in places.HAZARD_CATS] or [
            p for p in store.places if p["category"] in places.HAZARD_CATS
        ]
        store.places = hz + g
        _status.update({"apify": "done", "open": len(g), "hazards": len(hz), "error": result_error})
        _save(store.places)
    except asyncio.CancelledError:
        if current():
            _status["apify"] = "cancelled"
        raise
    except Exception as e:  # noqa: BLE001
        if not current():
            return
        _status.update({"apify": "failed", "error": type(e).__name__})
    if current():
        store.hub.publish("dashboard", {"type": "setup", "apify": _status["apify"], "open": _status["open"]})


def _metadata_path() -> Path:
    return CACHE.with_name(f"{CACHE.stem}.meta.json")


def _rows_hash(rows: list[dict[str, Any]]) -> str:
    return hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _home(store: Any) -> dict[str, float]:
    return {"lat": store.hh.home_lat, "lng": store.hh.home_lng, "radius_mi": store.hh.radius_mi}


def _write_atomic(path: Path, value: Any) -> None:
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, prefix=".places-", suffix=".tmp", delete=False
        ) as stream:
            temporary = Path(stream.name)
            stream.write(json.dumps(value, indent=1) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _save(rows: list[dict[str, Any]]) -> None:
    """Keep row-list compatibility; the sidecar binds completion to these exact rows/home."""
    store = _store()
    complete = (
        _status["apify"] in {"done", "skipped"}
        and not _status.get("error")
        and (not rows or places.source_summary(rows) in {"apify", "overpass"})
    )
    metadata = {
        "version": 1,
        "home": _home(store),
        "rows_sha256": _rows_hash(rows),
        "complete": complete,
        "status": dict(_status),
    }
    try:
        _write_atomic(CACHE, rows)
        _write_atomic(_metadata_path(), metadata)
    except OSError as e:
        print(f"places cache not written: {e}")
        _status.update(
            {"apify": "failed", "error": "Nearby results could not be saved. Check status before trying again."}
        )


def _matching_metadata(store: Any) -> dict[str, Any] | None:
    try:
        metadata = json.loads(_metadata_path().read_text())
        if (
            not isinstance(metadata, dict)
            or metadata.get("version") != 1
            or metadata.get("home") != _home(store)
            or metadata.get("rows_sha256") != _rows_hash(store.places)
            or not isinstance(metadata.get("status"), dict)
        ):
            return None
        return metadata
    except (OSError, ValueError, TypeError):
        return None


@router.get("/setup/status")
async def setup_status() -> dict[str, Any]:
    store = _store()
    metadata = _matching_metadata(store)
    status = dict(_status)
    # The module status starts empty after restart. Never resurrect a previous
    # process's running job: no worker exists to finish it in this process.
    if status["apify"] == "idle" and not status.get("address") and metadata:
        status.update(metadata["status"])
        if status["apify"] == "running":
            status.update(
                {
                    "apify": "cancelled",
                    "error": "The previous nearby search was interrupted. Start a new search to complete this area.",
                }
            )
    results_verified = bool(
        metadata
        and metadata.get("complete") is True
        and status["apify"] in {"done", "skipped"}
        and not status.get("error")
    )
    sections = rank(
        store.places,
        (store.hh.home_lat, store.hh.home_lng),
        store.hh.radius_mi,
        store.now(),
        list(store.hh.familiar_places),
        list(store.hh.contacts),
    )
    return {
        **status,
        "results_verified": results_verified,
        "home": {"lat": store.hh.home_lat, "lng": store.hh.home_lng, "radius_mi": store.hh.radius_mi},
        "hazards_ranked": sections.hazards,
        "call_first": sections.call_first,
        "familiar": sections.familiar,
        "places_source": store.places_source(),
        "total": len(store.places),
    }
