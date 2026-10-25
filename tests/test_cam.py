import io
from dataclasses import replace
from datetime import timedelta
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from nightfall import api, engine, escalation
from nightfall.integrations import twilio
from nightfall.notify import TwilioNotifier


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(escalation, "LADDER", ((1, 0.05), (2, 0.05), (3, 0.0)))
    with TestClient(api.app) as c:
        c.post("/reset")
        yield c
        c.post("/reset")


def test_frame_relay_and_takeover(client: TestClient) -> None:
    assert client.get("/cam/latest.jpg").status_code == 404
    r = client.post("/cam/frame", files={"f": ("f.jpg", io.BytesIO(b"\xff\xd8abc"), "image/jpeg")})
    assert r.json()["ok"]
    assert client.get("/cam/latest.jpg").content == b"\xff\xd8abc"
    assert client.post("/takeover", json={"member_id": "TM-NOBODY"}).status_code == 403
    client.post("/event", json={"kind": "person_enter"})
    assert client.post("/takeover", json={"member_id": "TM-PRIMARY"}).json()["takeover_by"] == "TM-PRIMARY"
    r = client.post("/say", json={"member_id": "TM-PRIMARY", "text": "Dad, it's me. Come inside."}).json()
    assert r["ok"] and r["audio"]["mode"] == "browser_tts"
    log = client.get("/state").json()["log"]
    assert any(e.get("line_source") == f"human:{api.store.hh.tree[0].name}" for e in log)
    assert client.post("/takeover", json={"member_id": "TM-PRIMARY", "on": False}).json()["takeover_by"] is None


def test_clip_relay(client: TestClient) -> None:
    r = client.post(
        "/say/clip",
        data={"member_id": "TM-MIKE"},
        files={"clip": ("c.mp4", io.BytesIO(b"\x00\x00\x00\x18ftyp"), "audio/mp4")},
    )
    assert r.status_code == 422, "empty clips are rejected"
    r = client.post(
        "/say/clip",
        data={"member_id": "TM-MIKE"},
        files={"clip": ("c.mp4", io.BytesIO(b"\x00\x00\x00\x18ftyp" + b"\x00" * 4000), "audio/mp4")},
    )
    url = r.json()["url"]
    assert url.startswith("/clips/clip-") and client.get(url).status_code == 200
    assert client.get("/clips/../x").status_code in (404, 400)


def test_exit_frames_route(client: TestClient) -> None:
    client.post("/event", json={"kind": "door_open"})
    inc = client.get("/state").json()["incident"]["id"]
    r = client.post(
        f"/frames/{inc}",
        files={
            "f0": ("a.jpg", io.BytesIO(b"\xff\xd8a"), "image/jpeg"),
            "f1": ("b.jpg", io.BytesIO(b"\xff\xd8b"), "image/jpeg"),
        },
    )
    assert r.json()["frame_ids"] == ["FR-0", "FR-1"]
    big = io.BytesIO(b"x" * (200 * 1024 + 1))
    assert client.post(f"/frames/{inc}", files={"f0": ("c.jpg", big, "image/jpeg")}).status_code == 413


def test_camera_exit_calls_primary_after_exit_wait(client: TestClient, monkeypatch) -> None:
    primary = replace(api.store.hh.tree[0], phone="+14155550123")
    monkeypatch.setattr(api.store, "hh", replace(api.store.hh, tree=(primary,)))
    monkeypatch.setattr(
        api.store.runner, "_notifier", TwilioNotifier(api.store.hub, api.store.link, api.PUBLIC_URL, api.store.log)
    )
    call = Mock(return_value="CA-test")
    monkeypatch.setattr(twilio, "create_call", call)
    monkeypatch.setattr(twilio, "send_sms", Mock(return_value="SM-test"))

    client.post("/event", json={"kind": "person_enter", "payload": {"identity": "match", "direction": "exit"}})
    lost = client.post("/event", json={"kind": "person_lost", "payload": {"heading": "left"}}).json()
    assert lost["to"] == "DOOR_OPEN"
    call.assert_not_called()
    api.store.inc.door_opened_at -= timedelta(seconds=engine.DOOR_WAIT_S + 1)
    exited = client.post("/event", json={"kind": "tick"}).json()
    assert exited["to"] == "ESCALATING"

    async def wait_for_call():
        import asyncio

        for _ in range(100):
            if call.called:
                return
            await asyncio.sleep(0.01)
        pytest.fail("Camera exit never reached Twilio")

    client.portal.call(wait_for_call)
    inc_id = exited["incident_id"]
    call.assert_called_with(primary.phone, f"{api.PUBLIC_URL}/twiml/{inc_id}/{primary.id}")
    # Twilio can retrieve the call instructions for the newly created incident.
    assert client.post(f"/twiml/{inc_id}/{primary.id}").status_code == 200


def test_phone_cannot_be_the_door(client: TestClient) -> None:
    r = client.post(
        "/cam/frame",
        files={"f": ("f.jpg", io.BytesIO(b"\xff\xd8abc"), "image/jpeg")},
        headers={"cf-connecting-ip": "203.0.113.9"},
    )
    assert r.status_code == 403
    r = client.get(
        "/", headers={"user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"}, follow_redirects=False
    )
    assert r.status_code in (302, 307) and r.headers["location"] == "/app"
    r = client.get("/", headers={"user-agent": "Mozilla/5.0 (Macintosh)"})
    assert r.status_code == 200 and "Nightfall door" in r.text
