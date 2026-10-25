"""Nearby job ownership tests; all provider calls and persistence use isolated fakes/tmp files."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from nightfall import api_app, api_setup
from nightfall.household import load


@pytest.fixture
def isolated(monkeypatch, tmp_path):
    folder = tmp_path / "data"
    folder.mkdir()
    source = Path(__file__).resolve().parents[1] / "data" / "household.json"
    household = folder / "household.json"
    household.write_bytes(source.read_bytes())
    store = SimpleNamespace(hh=load(household), places=[], hub=SimpleNamespace(publish=Mock()))
    monkeypatch.setattr(api_setup, "_store", lambda: store)
    monkeypatch.setattr(api_app, "_store", lambda: store)
    monkeypatch.setattr(api_app, "ROOT", tmp_path)
    monkeypatch.setattr(api_setup, "CACHE", folder / "places.json")
    monkeypatch.setattr(api_setup, "_status", {"apify": "idle", "address": "", "hazards": 0, "open": 0, "error": ""})
    monkeypatch.setattr(api_setup, "_task", None)
    monkeypatch.setattr(api_setup, "_request_generation", 0)
    monkeypatch.setattr(api_setup, "_job_generation", 0)
    monkeypatch.setattr(api_setup.apify, "enabled", lambda: True)
    monkeypatch.setattr(api_setup.places, "from_actor", lambda rows: rows)
    jobs, geocodes, resistant = {}, {}, set()
    fallback = Mock()

    async def thread(function, *args):
        if function is api_setup.geocode.geocode:
            address = args[0]
            if address in geocodes:
                await geocodes[address]
            return (1.0 if address == "A" else 2.0), 10.0, address
        if function is api_setup.overpass.hazards:
            return []
        if function is api_setup.apify.night_search_radius:
            latitude = args[0]
            future = asyncio.get_running_loop().create_future()
            jobs[latitude] = future
            if latitude in resistant:
                try:
                    return await asyncio.shield(future)
                except asyncio.CancelledError:
                    # Model an underlying worker that returns despite cancellation.
                    return await future
            return await future
        if function is api_setup.apify.google_places:
            fallback(*args)
            raise AssertionError("A stale job must not start the fallback provider")
        raise AssertionError(f"Unexpected provider: {function}")

    monkeypatch.setattr(api_setup.asyncio, "to_thread", thread)
    return SimpleNamespace(store=store, jobs=jobs, geocodes=geocodes, resistant=resistant, fallback=fallback)


def row(address):
    return {
        "name": f"Shop {address}",
        "lat": 1.0 if address == "A" else 2.0,
        "lng": 10.0,
        "category": "convenience",
        "source": "apify",
    }


async def start(address, google=True):
    await api_setup.setup_address(api_setup.AddressIn(address=address, google=google))
    task = api_setup._task
    await asyncio.sleep(0)
    return task


def test_old_cancellation_cannot_cancel_replacement_status(isolated):
    async def check():
        old = await start("A")
        new = await start("B")
        assert old.cancelled()
        assert api_setup._status["apify"] == "running"
        isolated.jobs[2.0].set_result([row("B")])
        await new
        assert api_setup._status["apify"] == "done"
        assert isolated.store.places == [row("B")]

    asyncio.run(check())


def test_late_old_result_cannot_overwrite_new_places_or_cache(isolated):
    async def check():
        isolated.resistant.add(1.0)
        old = await start("A")
        new = await start("B")
        isolated.jobs[2.0].set_result([row("B")])
        await new
        saved = api_setup.CACHE.read_bytes()
        isolated.jobs[1.0].set_result([row("A")])
        await old
        assert isolated.store.hh.address == "B"
        assert isolated.store.places == [row("B")]
        assert api_setup.CACHE.read_bytes() == saved
        assert api_setup._status["apify"] == "done"
        assert isolated.store.hub.publish.call_count == 1

    asyncio.run(check())


def test_google_false_address_invalidates_previous_business_search(isolated):
    async def check():
        isolated.resistant.add(1.0)
        old = await start("A")
        await start("B", google=False)
        isolated.jobs[1.0].set_result([row("A")])
        await old
        assert api_setup._task is None
        assert isolated.store.hh.address == "B"
        assert isolated.store.places == []
        assert json.loads(api_setup.CACHE.read_text()) == []
        assert api_setup._status["apify"] == "skipped"
        isolated.store.hub.publish.assert_not_called()

    asyncio.run(check())


def test_successful_profile_address_change_rejects_old_job_results(isolated):
    async def check():
        old = await start("A")
        result = await api_app.profile(api_app.ProfileIn(address="B", diagnosis="New care note"))
        assert result["ok"]
        isolated.jobs[1.0].set_result([row("A")])
        await old
        assert isolated.store.hh.address == "B"
        assert isolated.store.places == []
        assert api_setup._status["apify"] == "skipped"
        assert load(api_app.ROOT / "data" / "household.json").diagnosis == "New care note"

    asyncio.run(check())


def test_failed_profile_transaction_restores_home_without_killing_its_job(isolated, monkeypatch):
    async def check():
        old = await start("A")
        before = dict(api_setup._status)

        def fail_save(_household):
            raise HTTPException(500, "Could not save")

        monkeypatch.setattr(api_app, "_persist_household", fail_save)
        with pytest.raises(HTTPException):
            await api_app.profile(api_app.ProfileIn(address="B", diagnosis="Uncommitted note"))
        assert isolated.store.hh.address == "A"
        assert api_setup._status == before
        assert not old.done()
        isolated.jobs[1.0].set_result([row("A")])
        await old
        assert isolated.store.places == [row("A")]
        assert api_setup._status["apify"] == "done"

    asyncio.run(check())


def test_slower_older_address_request_does_not_replace_newer_saved_home(isolated):
    async def check():
        isolated.geocodes["A"] = asyncio.get_running_loop().create_future()
        old_request = asyncio.create_task(api_setup.setup_address(api_setup.AddressIn(address="A", google=False)))
        await asyncio.sleep(0)
        await start("B", google=False)
        saved = (api_app.ROOT / "data" / "household.json").read_bytes()
        isolated.geocodes["A"].set_result(None)
        with pytest.raises(HTTPException) as conflict:
            await old_request
        assert conflict.value.status_code == 409
        assert isolated.store.hh.address == "B"
        assert api_setup._status["address"] == "B"
        assert (api_app.ROOT / "data" / "household.json").read_bytes() == saved

    asyncio.run(check())


def test_stale_provider_error_cannot_start_fallback_or_fail_current_job(isolated):
    async def check():
        isolated.resistant.add(1.0)
        old = await start("A")
        new = await start("B")
        isolated.jobs[1.0].set_exception(ValueError("Old provider failure"))
        await old
        isolated.fallback.assert_not_called()
        assert api_setup._status["apify"] == "running"
        isolated.jobs[2.0].set_result([row("B")])
        await new
        assert isolated.store.places == [row("B")]

    asyncio.run(check())


@pytest.mark.parametrize(
    ("overpass_failed", "actor_failed"),
    [(True, True), (True, False), (False, True)],
)
def test_business_fallback_does_not_clear_unverified_hazard_error(
    isolated, monkeypatch, overpass_failed, actor_failed
):
    original_thread = api_setup.asyncio.to_thread

    async def thread(function, *args):
        if function is api_setup.overpass.hazards and overpass_failed:
            raise RuntimeError("Hazard provider unavailable")
        if function is api_setup.apify.google_places:
            return [row("A")]
        return await original_thread(function, *args)

    monkeypatch.setattr(api_setup.asyncio, "to_thread", thread)
    monkeypatch.setattr(api_setup.places, "from_google", lambda rows, _home: rows)

    async def check():
        status_store(isolated)
        task = await start("A")
        if actor_failed:
            isolated.jobs[1.0].set_exception(RuntimeError("Combined actor unavailable"))
        else:
            isolated.jobs[1.0].set_result([row("A"), {**row("A"), "name": "Water", "category": "water"}])
        await task

        response = await api_setup.setup_status()
        verified = not (overpass_failed and actor_failed)
        assert response["apify"] == "done"
        assert response["open"] == 1
        assert response["results_verified"] is verified
        assert bool(response["error"]) is not verified
        assert json.loads(api_setup._metadata_path().read_text())["complete"] is verified
        if not verified:
            assert "map places could not be checked" in response["error"]
            assert response["hazards"] == 0
        # Restarting must not turn a partially checked area into a verified cache.
        reset_process_status(monkeypatch)
        restored = await api_setup.setup_status()
        assert restored["results_verified"] is verified
        assert restored["error"] == response["error"]

    asyncio.run(check())


def reset_process_status(monkeypatch):
    monkeypatch.setattr(api_setup, "_status", {"apify": "idle", "address": "", "hazards": 0, "open": 0, "error": ""})
    monkeypatch.setattr(api_setup, "_task", None)


def status_store(isolated):
    from datetime import datetime

    from nightfall.places import source_summary

    isolated.store.now = datetime.now
    isolated.store.places_source = lambda: source_summary(isolated.store.places)


@pytest.mark.parametrize("empty", [False, True])
def test_completed_cache_rehydrates_only_matching_rows_home_and_radius(isolated, monkeypatch, empty):
    from dataclasses import replace

    async def check():
        status_store(isolated)
        task = await start("A")
        isolated.jobs[1.0].set_result([] if empty else [row("A")])
        await task
        assert (await api_setup.setup_status())["results_verified"] is True
        reset_process_status(monkeypatch)
        isolated.store.places = json.loads(api_setup.CACHE.read_text())
        restored = await api_setup.setup_status()
        assert restored["apify"] == "done"
        assert restored["results_verified"] is True
        assert restored["total"] == (0 if empty else 1)
        old_home = isolated.store.hh
        isolated.store.hh = replace(old_home, radius_mi=old_home.radius_mi + 0.5)
        assert (await api_setup.setup_status())["results_verified"] is False
        isolated.store.hh = replace(old_home, home_lat=3.0)
        assert (await api_setup.setup_status())["results_verified"] is False
        isolated.store.hh = old_home
        isolated.store.places.append(row("B"))
        assert (await api_setup.setup_status())["results_verified"] is False

    asyncio.run(check())


def test_restart_during_search_exposes_interruption_instead_of_saved_ready(isolated, monkeypatch):
    async def check():
        status_store(isolated)
        task = await start("A")
        assert (await api_setup.setup_status())["results_verified"] is False
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        reset_process_status(monkeypatch)
        isolated.store.places = json.loads(api_setup.CACHE.read_text())
        restored = await api_setup.setup_status()
        assert restored["results_verified"] is False
        assert restored["apify"] == "cancelled"
        assert "interrupted" in restored["error"]

    asyncio.run(check())


def test_legacy_cache_without_metadata_is_not_verified(isolated):
    async def check():
        status_store(isolated)
        isolated.store.places = [row("A")]
        api_setup.CACHE.write_text(json.dumps(isolated.store.places))
        response = await api_setup.setup_status()
        assert response["places_source"] == "apify"
        assert response["results_verified"] is False

    asyncio.run(check())


def test_changed_area_drops_old_businesses_and_same_area_refresh_retains_them(isolated):
    async def check():
        first = await start("A")
        isolated.jobs[1.0].set_result([row("A")])
        await first
        refresh = await start("A")
        assert isolated.store.places == [row("A")]
        isolated.jobs[1.0].set_result([row("A")])
        await refresh
        other = await start("B")
        assert isolated.store.places == []
        assert json.loads(api_setup.CACHE.read_text()) == []
        assert json.loads(api_setup._metadata_path().read_text())["complete"] is False
        isolated.jobs[2.0].set_result([row("B")])
        await other

    asyncio.run(check())


def test_skipped_hazard_search_does_not_certify_unverified_old_business_rows(isolated):
    from dataclasses import replace

    async def check():
        status_store(isolated)
        isolated.store.hh = replace(isolated.store.hh, home_lat=1.0, home_lng=10.0, radius_mi=1.5)
        isolated.store.places = [row("A")]
        await start("A", google=False)
        assert isolated.store.places == []
        response = await api_setup.setup_status()
        assert response["apify"] == "skipped"
        assert response["results_verified"] is True

    asyncio.run(check())


def test_partial_cache_pair_write_is_not_verified_as_saved(isolated, monkeypatch):
    async def check():
        status_store(isolated)
        task = await start("A")
        original_write = api_setup._write_atomic

        def fail_metadata(path, value):
            if path == api_setup._metadata_path():
                raise OSError("metadata disk failure")
            original_write(path, value)

        monkeypatch.setattr(api_setup, "_write_atomic", fail_metadata)
        isolated.jobs[1.0].set_result([row("A")])
        await task
        response = await api_setup.setup_status()
        assert response["results_verified"] is False
        assert response["apify"] == "failed"
        assert "could not be saved" in response["error"]
        reset_process_status(monkeypatch)
        isolated.store.places = json.loads(api_setup.CACHE.read_text())
        assert (await api_setup.setup_status())["results_verified"] is False

    asyncio.run(check())
