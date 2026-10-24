import pytest
from fastapi.testclient import TestClient

from nightfall import api, api_setup, escalation


@pytest.fixture
def client(monkeypatch, tmp_path):
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


def test_fresh_approach_after_returned_opens_new_incident(client: TestClient) -> None:
    client.post("/event", json={"kind": "person_enter"})
    a = client.get("/state").json()["incident"]["id"]
    client.post("/event", json={"kind": "person_seen", "payload": {"inside": True}})
    assert client.get("/state").json()["incident"]["state"] == "RETURNED"
    r = client.post("/event", json={"kind": "person_enter"}).json()
    assert r["incident_id"] != a and r["to"] == "CONVERSATION"
