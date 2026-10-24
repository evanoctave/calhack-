import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from nightfall import api, escalation
from nightfall.api_live import live


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(escalation, "LADDER", ((1, 0.05), (2, 0.05), (3, 0.0)))
    with TestClient(api.app) as c:
        c.post("/reset")
        yield c
        c.post("/reset")


def test_live_relay(client: TestClient) -> None:
    with client.websocket_connect("/ws/door") as door:
        assert door.receive_json()["on"] is False
        with client.websocket_connect("/ws/talk/TM-SARAH") as talk:
            assert door.receive_json() == {"type": "live", "on": True, "by": "Sarah"}
            talk.send_bytes(b"\x00\x01" * 1024)
            assert door.receive_bytes() == b"\x00\x01" * 1024
            assert client.get("/app/state").json()["live_by"] == "TM-SARAH"
            assert api.store.takeover_by == "TM-SARAH"
        assert door.receive_json()["on"] is False
    assert live.talker is None and len(live.listeners) == 0


def test_live_rejects_unknown_member(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect), client.websocket_connect("/ws/talk/TM-NOBODY") as ws:
        ws.receive_bytes()


def test_door_mic_relay(client: TestClient) -> None:
    from nightfall.api_live import doormic

    with client.websocket_connect("/ws/door-mic") as door:
        assert door.receive_json() == {"type": "listeners", "count": 0}
        with client.websocket_connect("/ws/listen/TM-SARAH") as phone:
            assert door.receive_json() == {"type": "listeners", "count": 1}
            door.send_bytes(b"\x02\x00" * 512)
            assert phone.receive_bytes() == b"\x02\x00" * 512
        assert door.receive_json() == {"type": "listeners", "count": 0}
    assert doormic.door is None and not doormic.listeners


def test_video_relay(client: TestClient) -> None:
    from nightfall.api_live import video

    with client.websocket_connect("/ws/video-in") as door:
        assert door.receive_json() == {"type": "watchers", "count": 0}
        with client.websocket_connect("/ws/video/TM-SARAH") as phone:
            assert door.receive_json() == {"type": "watchers", "count": 1}
            door.send_bytes(b"\xff\xd8" + b"\x00" * 100)
            assert phone.receive_bytes().startswith(b"\xff\xd8")
        assert door.receive_json() == {"type": "watchers", "count": 0}
    assert video.door is None and not video.watchers
