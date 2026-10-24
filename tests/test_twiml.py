import pytest
from fastapi.testclient import TestClient

from nightfall import api, escalation
from nightfall.household import TreeMember
from nightfall.notify import Hub, TwilioNotifier


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(escalation, "LADDER", ((1, 0.05), (2, 0.05), (3, 0.0)))
    with TestClient(api.app) as c:
        c.post("/reset")
        yield c
        c.post("/reset")


def test_twiml_call_flow(client: TestClient) -> None:
    client.post("/event", json={"kind": "door_open"})
    inc = client.post("/event", json={"kind": "door_close"}).json()["incident_id"]
    r = client.post(f"/twiml/{inc}/TM-SARAH")
    assert r.status_code == 200 and "<Gather" in r.text and "navy hoodie" in r.text and 'input="speech"' in r.text
    r = client.post(f"/twiml/{inc}/TM-SARAH/turn", data={"SpeechResult": "where should I look"})
    assert "Palace of Fine Arts lagoon" in r.text and "<Gather" in r.text
    r = client.post(f"/twiml/{inc}/TM-SARAH/turn", data={"SpeechResult": "I've got him"})
    assert "<Hangup/>" in r.text
    assert client.get("/state").json()["incident"]["acked_by"] == "TM-SARAH"
    assert client.post("/twiml/INC-nope/TM-SARAH").status_code == 404


def test_agent_turn_json(client: TestClient) -> None:
    client.post("/event", json={"kind": "door_open"})
    inc = client.post("/event", json={"kind": "door_close"}).json()["incident_id"]
    o = client.get(f"/agent/opening/{inc}/TM-MIKE").json()
    assert "Mike" in o["say"] and o["audio"]["mode"] == "browser_tts"
    r = client.post(
        "/agent/turn", json={"incident_id": inc, "member_id": "TM-MIKE", "text": "what is he wearing"}
    ).json()
    assert r["intent"] == "clothing" and "barefoot" in r["say"]
    assert client.get("/voice/../x.wav").status_code in (404, 400)


async def test_twilio_notifier_falls_back_to_sse(monkeypatch) -> None:
    from nightfall.integrations import twilio

    def boom(*a, **k):
        raise RuntimeError("trial account")

    monkeypatch.setattr(twilio, "create_call", boom)
    hub = Hub()
    q = hub.subscribe("phone:TM-X")
    d = hub.subscribe("dashboard")
    n = TwilioNotifier(hub, lambda i, m: "http://x/brief", "http://x")
    await n.ring([TreeMember("TM-X", "X", "+15555550100", 1)], "msg", "INC-1", 1)
    assert q.get_nowait()["type"] == "ring"
    msgs = [d.get_nowait() for _ in range(2)]
    assert msgs[1]["source"] == "twilio" and msgs[1]["result"].startswith("sse only")
