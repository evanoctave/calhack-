import asyncio

import pytest
from fastapi.testclient import TestClient

from nightfall import api, escalation


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(escalation, "LADDER", ((1, 0.05), (2, 0.05), (3, 0.0)))
    with TestClient(api.app) as c:
        c.post("/reset")
        yield c
        c.post("/reset")


def test_moment(client: TestClient) -> None:
    assert client.get("/health").json()["ok"]
    judge = client.post("/tree", json={"name": "Judge", "phone": "web", "tier": 1}).json()
    r = client.post("/event", json={"kind": "motion"}).json()
    assert r["to"] == "CONVERSATION" and "speak:open" in r["actions"]
    client.post("/event", json={"kind": "door_open"})
    r = client.post("/event", json={"kind": "door_close"}).json()
    assert r["to"] == "ESCALATING"
    inc = r["incident_id"]
    s = client.get("/state").json()
    assert s["rings"] and s["rings"][0]["tier"] == 1 and judge["member_id"] in s["rings"][0]["members"]
    assert client.post("/ack", json={"incident_id": inc, "member_id": "TM-NOBODY"}).status_code == 403
    a = client.post("/ack", json={"incident_id": inc, "member_id": judge["member_id"]}).json()
    assert a["first"] and a["acked_by"] == judge["member_id"]
    assert client.get("/state").json()["incident"]["state"] == "ACKED"
    link = api.store.link(inc, judge["member_id"])
    b = client.get("/brief/" + link.split("#")[1]).json()
    assert b["clothing_line"] == "navy hoodie, gray sweatpants, barefoot" and b["viewer"] == judge["member_id"]
    assert client.get("/brief/bad.token").status_code == 404


def test_unknown_event_422(client: TestClient) -> None:
    assert client.post("/event", json={"kind": "explode"}).status_code == 422
