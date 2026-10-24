"""Replay the moment many times; no ladder tasks or SSE subscribers may survive."""

import pytest
from fastapi.testclient import TestClient

from nightfall import api, escalation


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(escalation, "LADDER", ((1, 0.02), (2, 0.02), (3, 0.0)))
    with TestClient(api.app) as c:
        c.post("/reset")
        yield c
        c.post("/reset")


def test_replays_leave_nothing_behind(client: TestClient) -> None:
    for i in range(25):
        client.post("/event", json={"kind": "person_enter"})
        client.post("/event", json={"kind": "person_lost"})
        r = client.post("/event", json={"kind": "door_close"}).json()
        inc = r["incident_id"]
        client.post("/ack", json={"incident_id": inc, "member_id": "TM-PRIMARY"})
        client.post("/event", json={"kind": "close"})
        assert api.store.runner.live() == 0, f"ladder task alive after replay {i}"
    assert api.store.hub.count() == 0
    assert api.store.frames == {} and api.store.frame_bytes == {}
    assert len(api.store.log) < 25 * 12
