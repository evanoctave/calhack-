from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient

from nightfall import api, api_app, api_setup, escalation, history
from nightfall.household import load
from nightfall.store import Store


@pytest.fixture
def client(monkeypatch, tmp_path):
    household_source = (api_app.ROOT / "data" / "household.json").read_text()
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "household.json").write_text(household_source)
    monkeypatch.setattr(api, "store", Store())
    monkeypatch.setattr(api_app, "ROOT", tmp_path)
    monkeypatch.setattr(history, "FILE", tmp_path / "history.json")
    monkeypatch.setattr(api_setup, "_status", {"apify": "idle", "address": "", "hazards": 0, "open": 0, "error": ""})
    monkeypatch.setattr(api_setup, "_task", None)
    monkeypatch.setattr(escalation, "LADDER", ((1, 0.05), (2, 0.05), (3, 0.0)))
    monkeypatch.setattr(api_setup, "CACHE", tmp_path / "places.json")
    with TestClient(api.app) as c:
        c.post("/reset")
        yield c
        c.post("/reset")


def test_address_moves_home_and_lists_hazards(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(api_setup.geocode, "geocode", lambda a: (34.05, -118.25, "Somewhere, Los Angeles"))
    monkeypatch.setattr(
        api_setup.overpass,
        "hazards",
        lambda lat, lng, r: [
            {
                "type": "way",
                "center": {"lat": 34.052, "lon": -118.25},
                "tags": {"waterway": "river", "name": "LA River"},
            },
            {
                "type": "way",
                "center": {"lat": 34.045, "lon": -118.26},
                "tags": {"highway": "motorway", "ref": "US 101"},
            },
        ],
    )
    monkeypatch.setattr(api_setup.apify, "enabled", lambda: False)
    r = client.post("/setup/address", json={"address": "somewhere", "radius_mi": 1.0}).json()
    assert r["lat"] == 34.05 and len(r["hazards"]) == 2 and r["apify"] == "no token"
    s = client.get("/setup/status").json()
    assert s["home"]["lat"] == 34.05 and [h["name"] for h in s["hazards_ranked"]] == ["LA River", "US 101"]
    assert client.get("/state").json()["household"]["person_name"] == "Dad"


def test_bad_address_404(client: TestClient, monkeypatch) -> None:
    def boom(a):
        raise ValueError("no match")

    monkeypatch.setattr(api_setup.geocode, "geocode", boom)
    assert client.post("/setup/address", json={"address": "zzz"}).status_code == 404
    assert client.post("/setup/address", json={"address": "x", "radius_mi": 9}).status_code == 422


def test_address_and_radius_survive_household_reload(client: TestClient, monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(api_setup.geocode, "geocode", lambda address: (34.05, -118.25, "Resolved address"))
    monkeypatch.setattr(api_setup.overpass, "hazards", lambda *args: [])
    monkeypatch.setattr(api_setup.apify, "enabled", lambda: False)
    response = client.post("/setup/address", json={"address": "  New home address  ", "radius_mi": 2.0})
    assert response.status_code == 200
    reloaded = load(tmp_path / "data" / "household.json")
    assert reloaded.address == "New home address"
    assert (reloaded.home_lat, reloaded.home_lng, reloaded.radius_mi) == (34.05, -118.25, 2.0)
    assert api.store.hh.address == reloaded.address
    assert client.get("/setup/status").json()["home"] == {"lat": 34.05, "lng": -118.25, "radius_mi": 2.0}


def test_address_save_failure_keeps_previous_state_and_does_not_start_apify(
    client: TestClient, monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(api_setup.geocode, "geocode", lambda address: (34.05, -118.25, "Resolved address"))
    monkeypatch.setattr(api_setup.overpass, "hazards", lambda *args: [])
    monkeypatch.setattr(api_setup.apify, "enabled", lambda: True)
    run_apify = AsyncMock()
    monkeypatch.setattr(api_setup, "_run_apify", run_apify)
    previous_household, previous_places = api.store.hh, api.store.places
    previous_status = dict(api_setup._status)
    path = tmp_path / "data" / "household.json"
    original = path.read_bytes()
    monkeypatch.setattr(api_app.os, "replace", Mock(side_effect=OSError("disk unavailable")))
    response = client.post("/setup/address", json={"address": "New home address", "radius_mi": 2.0})
    assert response.status_code == 500
    assert "Could not save" in response.json()["detail"]
    assert api.store.hh is previous_household and api.store.places is previous_places
    assert api_setup._status == previous_status
    assert path.read_bytes() == original
    assert not list((tmp_path / "data").glob(".household-*.tmp"))
    assert api_setup._task is None
    run_apify.assert_not_called()


def test_profile_address_change_commits_once_with_other_profile_edits(
    client: TestClient, monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(api_setup.geocode, "geocode", lambda address: (34.05, -118.25, "Resolved address"))
    monkeypatch.setattr(api_setup.overpass, "hazards", lambda *args: [])
    persist = Mock(wraps=api_app._persist_household)
    monkeypatch.setattr(api_app, "_persist_household", persist)
    response = client.post("/profile", json={"address": "New home address", "diagnosis": "Updated diagnosis"})
    assert response.status_code == 200
    persist.assert_called_once()
    reloaded = load(tmp_path / "data" / "household.json")
    assert reloaded.address == "New home address" and reloaded.diagnosis == "Updated diagnosis"
    assert reloaded.home_lat == 34.05


def test_profile_address_failure_rolls_back_places_and_status_too(client: TestClient, monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(api_setup.geocode, "geocode", lambda address: (34.05, -118.25, "Resolved address"))
    monkeypatch.setattr(api_setup.overpass, "hazards", lambda *args: [])
    previous_household, previous_places = api.store.hh, api.store.places
    previous_status = dict(api_setup._status)
    path = tmp_path / "data" / "household.json"
    original = path.read_bytes()
    monkeypatch.setattr(api_app.os, "replace", Mock(side_effect=OSError("disk unavailable")))
    response = client.post("/profile", json={"address": "New home address", "diagnosis": "Updated diagnosis"})
    assert response.status_code == 500
    assert api.store.hh is previous_household and api.store.places is previous_places
    assert api_setup._status == previous_status
    assert path.read_bytes() == original
    assert not api_setup.CACHE.exists()


def test_fresh_approach_after_returned_opens_new_incident(client: TestClient) -> None:
    client.post("/event", json={"kind": "person_enter"})
    a = client.get("/state").json()["incident"]["id"]
    client.post("/event", json={"kind": "person_seen", "payload": {"inside": True}})
    assert client.get("/state").json()["incident"]["state"] == "RETURNED"
    r = client.post("/event", json={"kind": "person_enter"}).json()
    assert r["incident_id"] != a and r["to"] == "CONVERSATION"
