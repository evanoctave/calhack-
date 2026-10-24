import io
import subprocess

import pytest
from fastapi.testclient import TestClient

from nightfall import api, api_app, escalation


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(escalation, "LADDER", ((1, 0.05), (2, 0.05), (3, 0.0)))
    monkeypatch.setattr(api_app, "SAMPLES", tmp_path / "samples")
    monkeypatch.setattr(api_app, "_persist_household", lambda hh: None)
    with TestClient(api.app) as c:
        c.post("/reset")
        yield c
        c.post("/reset")


def _wav(seconds: float = 1.2) -> bytes:
    r = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={seconds}",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "wav",
            "pipe:1",
        ],
        capture_output=True,
        timeout=30,
        check=False,
    )
    return r.stdout


def test_app_state_and_profile(client: TestClient) -> None:
    s = client.get("/app/state?member=TM-PRIMARY").json()
    assert s["household"]["person_full_name"] and s["incident"] is None and s["voice"]["mock"]
    r = client.post(
        "/profile", json={"person_full_name": "Robert Miller", "person_age": 74, "caregiver_name": "Sarah"}
    ).json()
    assert r["ok"] and r["household"]["person_age"] == 74
    assert client.post("/profile", json={"person_age": 200}).status_code == 422
    client.post("/event", json={"kind": "person_enter"})
    client.post("/event", json={"kind": "person_lost"})
    client.post("/event", json={"kind": "door_close"})
    s = client.get("/app/state?member=TM-PRIMARY").json()
    assert (
        s["incident"]["state"] == "ESCALATING"
        and s["incident"]["brief_link"].startswith("http")
        and s["rings"][0]["members"] == ["Sarah"]
    )


@pytest.mark.skipif(
    subprocess.run(["which", "ffmpeg"], capture_output=True, check=False).returncode != 0, reason="ffmpeg"
)
def test_samples_and_mock_clone(client: TestClient) -> None:
    wav = _wav()
    assert (
        client.post("/voice/samples/nope", files={"clip": ("c.wav", io.BytesIO(wav), "audio/wav")}).status_code == 404
    )
    r = client.post("/voice/samples/introduction", files={"clip": ("c.wav", io.BytesIO(wav), "audio/wav")}).json()
    assert r["ok"] and r["seconds"] >= 1.0
    assert client.get("/voice/samples/introduction.wav").status_code == 200
    assert client.get("/app/state").json()["voice"]["samples"]["introduction"] is True
    c = client.post("/voice/clone", json={"name": "Sarah"}).json()
    assert c["ok"] and c["source"] == "mock" and c["seconds"] >= 1.0
    p = client.post("/voice/preview", json={"situation": "I need to go to work"}).json()
    assert p["text"].endswith((".", "?", "!")) and p["audio"]["mode"] == "browser_tts"
    client.delete("/voice/samples/introduction")
    assert client.get("/voice/samples/introduction.wav").status_code == 404
    assert client.post("/voice/clone", json={"name": "Sarah"}).status_code == 422


def test_app_page_served(client: TestClient) -> None:
    assert "Night watch" in client.get("/app").text


def test_caregiver_rename_renames_tree_member(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from nightfall import api_app

    monkeypatch.setattr(api_app, "_persist_household", lambda hh: None)
    before = client.get("/app/state?member=TM-PRIMARY").json()["household"]["caregiver_name"]
    client.post("/profile", json={"caregiver_name": "Evan"})
    hh = api_app._store().hh
    assert hh.caregiver_name == "Evan" and hh.tree[0].name == "Evan" and hh.tree[1].name == "Mike"
    client.post("/profile", json={"caregiver_name": before})


def test_family_ack_on_old_call_silences_new_incident(client: TestClient) -> None:
    from nightfall import api

    for k in ("person_enter", "person_lost", "door_close"):
        client.post("/event", json={"kind": k})
    old = api.store.inc.id
    client.post("/event", json={"kind": "person_back"})
    client.post("/event", json={"kind": "person_enter"})  # Dad back out at the door: a new incident talks
    assert api.store.inc.id != old and api.store.inc.state.value == "CONVERSATION"
    assert client.post("/ack", json={"incident_id": old, "member_id": "TM-PRIMARY"}).status_code == 404
    assert api.store.inc.state.value == "RETURNED"
    r = client.post("/event", json={"kind": "person_enter"}).json()
    assert r.get("ignored") == "quiet after family ack"
    client.post("/door/telemetry", json={"event": "door_started"})
    assert api.store.quiet_until is None


def test_door_restart_ends_conversation(client: TestClient) -> None:
    from nightfall import api

    client.post("/event", json={"kind": "person_enter"})
    assert api.store.inc.state.value == "CONVERSATION"
    client.post("/door/telemetry", json={"event": "door_started"})
    assert api.store.inc.state.value == "RETURNED"


def test_reentry_soon_after_greeting_does_not_regreet(client: TestClient) -> None:
    from nightfall import api

    client.post("/event", json={"kind": "person_enter"})
    client.post("/event", json={"kind": "person_lost"})
    client.post("/event", json={"kind": "person_back"})
    client.post("/event", json={"kind": "person_enter"})
    lines = [e["text"] for e in api.store.log if e.get("type") == "speak"]
    assert lines[0].startswith("Hi ") and not lines[-1].startswith("Hi ") and "still dark" in lines[-1]
