import io
import wave
from dataclasses import replace
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from nightfall import api, api_app, api_care, escalation


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(api_app, "_persist_household", lambda hh: None)
    monkeypatch.setattr(api_app, "SAMPLES", tmp_path / "samples")
    monkeypatch.setattr(api_care, "PHOTO", tmp_path / "photo")
    monkeypatch.setattr(escalation, "LADDER", ((1, 60), (2, 60), (3, 0)))
    with TestClient(api.app) as client:
        client.post("/reset")
        yield client
        client.post("/reset")


def test_photo_upload_round_trip_and_rejects_active_content(client):
    assert client.get("/care/photo").status_code == 404
    image = (api.ROOT / "static/assets/figma/demo-camera.png").read_bytes()
    result = client.post("/care/photo", files={"photo": ("portrait.png", image, "image/png")})
    assert result.status_code == 200
    url = result.json()["photo"]
    assert client.get("/app/state").json()["household"]["photo"] == url
    assert client.get(url).content == image
    assert client.get(url).headers["content-type"] == "image/png"
    assert (
        client.post("/care/photo", files={"photo": ("image.svg", b"<svg></svg>", "image/svg+xml")}).status_code == 422
    )
    assert client.post("/care/photo", files={"photo": ("big.png", b"x" * (5 * 1024 * 1024 + 1))}).status_code == 413
    assert client.get(url).content == image


def test_call_order_is_validated_and_tiers_follow_saved_order(client):
    members = client.get("/app/state").json()["household"]["tree"]
    ids = [m["id"] for m in reversed(members)]
    assert client.put("/care/call-order", json={"member_ids": ids[:-1]}).status_code == 422
    assert client.put("/care/call-order", json={"member_ids": [ids[0]] * len(ids)}).status_code == 422
    response = client.put("/care/call-order", json={"member_ids": ids})
    assert response.status_code == 200
    saved = client.get("/app/state").json()["household"]["tree"]
    assert [m["id"] for m in saved] == ids
    assert [m["tier"] for m in saved] == [min(i + 1, 3) for i in range(len(ids))]


def test_invitation_creates_one_member_and_stable_phone_link(client):
    assert client.post("/care/members", json={"name": "  "}).status_code == 422
    first = client.post("/care/members", json={"name": "Aunt Jo"}).json()
    second = client.post("/care/members", json={"name": "aunt jo"}).json()
    assert first["member_id"] == second["member_id"]
    assert first["invitation_url"].endswith("/app?member=" + first["member_id"])
    assert client.get(first["invitation_url"]).status_code == 200
    assert sum(m.id == first["member_id"] for m in api.store.hh.tree) == 1


def test_familiar_place_updates_are_atomic_and_geocode_new_places(client, monkeypatch):
    before = api.store.hh.familiar_places
    monkeypatch.setattr(api_care.geocode, "geocode", lambda query: (_ for _ in ()).throw(ValueError("not found")))
    assert client.put("/care/places", json={"places": [{"name": "Missing place"}]}).status_code == 422
    assert api.store.hh.familiar_places == before
    monkeypatch.setattr(api_care.geocode, "geocode", lambda query: (37.8, -122.4, "Library"))
    response = client.put("/care/places", json={"places": [{"name": "Library", "note": "Sunday visits"}]})
    assert response.status_code == 200
    saved = client.get("/app/state").json()["household"]["familiar_places"]
    assert saved == [{"name": "Library", "note": "Sunday visits", "lat": 37.8, "lng": -122.4}]
    assert client.portal.call(api.store.memory.search, "Sunday visits")[0]["text"] == "Library, Sunday visits"


def test_browser_wav_sample_and_clone_work_without_ffmpeg(client, monkeypatch):
    monkeypatch.setenv("PATH", "/nonexistent")
    data = io.BytesIO()
    with wave.open(data, "wb") as out:
        out.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        out.writeframes(b"\x00\x00" * 20000)
    result = client.post("/voice/samples/introduction", files={"clip": ("clip.wav", data.getvalue(), "audio/wav")})
    assert result.status_code == 200
    assert result.json()["seconds"] >= 1
    assert client.get("/voice/samples/introduction.wav").status_code == 200
    clone = client.post("/voice/clone", json={"name": "Family"})
    assert clone.status_code == 200
    assert clone.json()["source"] == "mock"


def test_emergency_option_is_distinct_from_recommendation_and_ack_is_not_return(client):
    client.post("/care/demo/start")
    for event in ("person_lost", "door_close"):
        client.post("/event", json={"kind": event})
    inc = api.store.inc
    api.store.call_911_sent = True
    state = client.get("/app/state?member=TM-PRIMARY").json()
    assert state["incident"]["emergency"]["option_shown"] is True
    assert state["incident"]["emergency"]["recommendation_due"] is False
    inc.exited_at = api.store.now() - timedelta(minutes=16)
    assert client.get("/app/state").json()["incident"]["emergency"]["recommendation_due"] is True
    client.post("/ack", json={"incident_id": inc.id, "member_id": "TM-PRIMARY"})
    state = client.get("/app/state?member=TM-PRIMARY").json()
    assert state["incident"]["state"] == "ACKED"
    brief = client.get("/brief/" + state["incident"]["brief_link"].split("#")[1]).json()
    assert brief["active"] and brief["acked_by"] == "TM-PRIMARY" and brief["state"] != "RETURNED"
    client.post("/event", json={"kind": "person_back"})
    assert client.get("/app/state").json()["incident"]["state"] == "RETURNED"


def test_demo_controls_cannot_run_with_real_services(client, monkeypatch):
    monkeypatch.setenv("MOCK", "0")
    assert client.post("/care/demo/start").status_code == 404
    assert client.get("/app/state").json()["demo_available"] is False


def test_demo_return_uses_existing_engine_transition_before_exit(client):
    assert client.post("/care/demo/start").status_code == 200
    assert client.get("/app/state").json()["incident"]["state"] == "CONVERSATION"
    assert client.post("/care/demo/return").status_code == 200
    state = client.get("/app/state").json()
    assert state["incident"]["state"] == "RETURNED" and state["rings"] == []


def test_recorded_demo_uses_its_photo_and_only_describes_visible_clothing(client):
    client.post("/care/demo/start")
    client.post("/care/demo/leave")
    client.post("/event", json={"kind": "door_close"})
    state = client.get("/app/state?member=TM-PRIMARY").json()["incident"]
    assert state["exit_frame"] == "/assets/figma/demo-camera.png"
    assert state["clothing_line"] == "gray t-shirt"
    assert state["clothing"]["bottom_type"] == "unknown" and state["clothing"]["footwear"] == "unknown"


def test_ready_made_voice_replaces_clone_label(client, monkeypatch, tmp_path):
    import os

    for key in ("CARTESIA_VOICE_ID", "VOICE_NAME", "VOICE_IS_CLONE", "VOICE_SPEED", "VOICE_EMOTION"):
        monkeypatch.setenv(key, os.environ.get(key, ""))
    monkeypatch.setenv("ENV_FILE", str(tmp_path / "voice.env"))
    api.store.voice_source, api.store.voice_name = "clone", "Family"
    response = client.post(
        "/voice/select",
        json={"voice_id": "ready-made-voice-id", "name": "Michelle Voice", "speed": 1.1, "emotion": "calm"},
    )
    assert response.status_code == 200
    state = client.get("/app/state").json()["voice"]
    assert state["source"] == "stock" and state["name"] == "Michelle Voice"
    assert (tmp_path / "voice.env").exists()
    assert "VOICE_NAME='Michelle Voice'" in (tmp_path / "voice.env").read_text()


def test_relationship_and_uploaded_photo_persist(tmp_path, monkeypatch):
    import json

    monkeypatch.setattr(api_app, "ROOT", tmp_path)
    (tmp_path / "data").mkdir()
    target = tmp_path / "data/household.json"
    target.write_text("{}")
    hh = replace(api.store.hh, caregiver_relationship="Daughter", person_photo="/care/photo?v=example")
    api_app._persist_household(hh)
    persisted = json.loads(target.read_text())
    assert persisted["caregiver_relationship"] == "Daughter"
    assert persisted["person_photo"] == "/care/photo?v=example"
    assert persisted["familiar_places"] == list(hh.familiar_places)


def test_invitation_keeps_relationship_and_phone(client):
    assert client.post("/care/members", json={"name": "Uncle Al", "phone": "12"}).status_code == 422
    made = client.post(
        "/care/members", json={"name": "Uncle Al", "relationship": "Uncle", "phone": "(415) 555-0123"}
    ).json()
    member = next(m for m in api.store.hh.tree if m.id == made["member_id"])
    assert (member.relationship, member.phone) == ("Uncle", "+14155550123")
    tree = client.get("/app/state").json()["household"]["tree"]
    assert next(m for m in tree if m["id"] == made["member_id"])["relationship"] == "Uncle"


def test_member_can_be_removed_and_tiers_renumber(client):
    made = client.post("/care/members", json={"name": "Cousin Pat"}).json()
    before = len(api.store.hh.tree)
    assert client.delete("/care/members/nope").status_code == 404
    assert client.delete("/care/members/" + made["member_id"]).status_code == 200
    assert len(api.store.hh.tree) == before - 1
    assert [m.tier for m in api.store.hh.tree] == [min(i + 1, 3) for i in range(before - 1)]


def test_address_suggest_needs_a_real_query_and_survives_lookup_failure(client, monkeypatch):
    assert client.get("/care/address-suggest?q=ab").json() == {"suggestions": []}
    monkeypatch.setattr(api_care.geocode, "suggest", lambda q: ["1 Main St, Town, Country"])
    assert client.get("/care/address-suggest?q=1 main").json()["suggestions"] == ["1 Main St, Town, Country"]
    monkeypatch.setattr(api_care.geocode, "suggest", lambda q: (_ for _ in ()).throw(RuntimeError("down")))
    assert client.get("/care/address-suggest?q=1 main").json() == {"suggestions": []}
