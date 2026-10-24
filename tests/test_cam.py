import io

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


def test_frame_relay_and_takeover(client: TestClient) -> None:
    assert client.get("/cam/latest.jpg").status_code == 404
    r = client.post("/cam/frame", files={"f": ("f.jpg", io.BytesIO(b"\xff\xd8abc"), "image/jpeg")})
    assert r.json()["ok"]
    assert client.get("/cam/latest.jpg").content == b"\xff\xd8abc"
    assert client.post("/takeover", json={"member_id": "TM-NOBODY"}).status_code == 403
    client.post("/event", json={"kind": "person_enter"})
    assert client.post("/takeover", json={"member_id": "TM-SARAH"}).json()["takeover_by"] == "TM-SARAH"
    r = client.post("/say", json={"member_id": "TM-SARAH", "text": "Dad, it's me. Come inside."}).json()
    assert r["ok"] and r["audio"]["mode"] == "browser_tts"
    log = client.get("/state").json()["log"]
    assert any(e.get("line_source") == "human:Sarah" for e in log)
    assert client.post("/takeover", json={"member_id": "TM-SARAH", "on": False}).json()["takeover_by"] is None


def test_clip_relay(client: TestClient) -> None:
    r = client.post("/say/clip", data={"member_id": "TM-MIKE"}, files={"clip": ("c.mp4", io.BytesIO(b"\x00\x00\x00\x18ftyp"), "audio/mp4")})
    url = r.json()["url"]
    assert url.startswith("/clips/clip-") and client.get(url).status_code == 200
    assert client.get("/clips/../x").status_code in (404, 400)


def test_exit_frames_route(client: TestClient) -> None:
    client.post("/event", json={"kind": "door_open"})
    inc = client.get("/state").json()["incident"]["id"]
    r = client.post(f"/frames/{inc}", files={"f0": ("a.jpg", io.BytesIO(b"\xff\xd8a"), "image/jpeg"), "f1": ("b.jpg", io.BytesIO(b"\xff\xd8b"), "image/jpeg")})
    assert r.json()["frame_ids"] == ["FR-0", "FR-1"]
    big = io.BytesIO(b"x" * (200 * 1024 + 1))
    assert client.post(f"/frames/{inc}", files={"f0": ("c.jpg", big, "image/jpeg")}).status_code == 413
