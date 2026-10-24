import asyncio
from xml.etree import ElementTree

import pytest
from fastapi.testclient import TestClient

from nightfall import api, api_voice, escalation
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
    r = client.post(f"/twiml/{inc}/TM-PRIMARY")
    assert r.status_code == 200 and "<Gather" in r.text and "navy hoodie" in r.text and 'input="speech"' in r.text
    r = client.post(f"/twiml/{inc}/TM-PRIMARY/turn", data={"SpeechResult": "where should I look"})
    assert "Palace of Fine Arts lagoon" in r.text and "<Gather" in r.text
    r = client.post(f"/twiml/{inc}/TM-PRIMARY/turn", data={"SpeechResult": "I've got him"})
    assert "<Hangup/>" in r.text
    assert client.get("/state").json()["incident"]["acked_by"] == "TM-PRIMARY"
    assert client.post("/twiml/INC-nope/TM-PRIMARY").status_code == 404


def test_twiml_open_speaks_without_waiting_for_cartesia(client: TestClient, monkeypatch) -> None:
    client.post("/event", json={"kind": "door_open"})
    inc = client.post("/event", json={"kind": "door_close"}).json()["incident_id"]

    def unexpected_synthesis(*args, **kwargs):
        raise AssertionError("Answering the call must not wait for external speech synthesis")

    monkeypatch.setattr(api_voice.voice, "say", unexpected_synthesis)
    response = client.post(f"/twiml/{inc}/TM-PRIMARY")
    assert response.status_code == 200
    document = ElementTree.fromstring(response.text)
    gather = document.find("Gather")
    assert gather is not None
    opening = gather.find("Say")
    assert opening is not None and "left the house" in opening.text
    assert gather.find("Play") is None


@pytest.mark.parametrize("transport", ["twiml", "web"])
def test_call_turn_vendor_work_does_not_block_event_loop(client: TestClient, monkeypatch, transport) -> None:
    client.post("/event", json={"kind": "door_open"})
    inc = client.post("/event", json={"kind": "door_close"}).json()["incident_id"]
    original_handle = api_voice.call_agent.handle
    original_say = api_voice.voice.say
    calls = []

    def assert_off_loop():
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        assert loop is None, "Call vendor work must run outside the server event loop"

    def handle_off_loop(*args, **kwargs):
        assert_off_loop()
        calls.append("reasoning")
        return original_handle(*args, **kwargs)

    def say_off_loop(*args, **kwargs):
        assert_off_loop()
        calls.append("synthesis")
        return original_say(*args, **kwargs)

    monkeypatch.setattr(api_voice.call_agent, "handle", handle_off_loop)
    monkeypatch.setattr(api_voice.voice, "say", say_off_loop)
    if transport == "twiml":
        response = client.post(f"/twiml/{inc}/TM-PRIMARY/turn", data={"SpeechResult": "what is he wearing"})
    else:
        response = client.post(
            "/agent/turn", json={"incident_id": inc, "member_id": "TM-PRIMARY", "text": "what is he wearing"}
        )
    assert response.status_code == 200
    assert calls == ["reasoning", "synthesis"]


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
