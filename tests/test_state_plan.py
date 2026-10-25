"""/state carries the timings and the score the door page uses to explain what happens next."""

import pytest
from fastapi.testclient import TestClient

from nightfall import api


@pytest.fixture
def client():
    with TestClient(api.app) as c:
        c.post("/reset")
        yield c
        c.post("/reset")


def test_state_exposes_timing_and_incident_facts_for_the_door_plan(client):
    s = client.get("/state").json()
    assert set(s["timing"]) == {"line_gap_s", "max_lines", "visitor_max_s", "deadline_s"}
    assert s["incident"] is None
    client.post("/event", json={"kind": "person_enter", "payload": {}})
    inc = client.get("/state").json()["incident"]
    assert inc["state"] == "CONVERSATION" and inc["lines_spoken"] == 1 and inc["person_in_frame"] is True
    assert inc["verdict"] in {"ignore", "speak_only", "escalate"} and isinstance(inc["reasons"], list)
