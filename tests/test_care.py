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


def test_test_call_needs_a_dialable_member_and_twilio(client, monkeypatch):
    from nightfall.integrations import twilio

    assert client.post("/care/test-call", json={"member_id": "nope"}).status_code == 404
    made = client.post("/care/members", json={"name": "Aunt Bea"}).json()
    assert client.post("/care/test-call", json={"member_id": made["member_id"]}).status_code == 422
    client.post("/care/members", json={"name": "Aunt Bea", "phone": "415-555-0123"})
    monkeypatch.setattr(twilio, "enabled", lambda: False)
    assert client.post("/care/test-call", json={"member_id": made["member_id"]}).status_code == 409
    placed = []
    monkeypatch.setattr(twilio, "enabled", lambda: True)
    monkeypatch.setattr(twilio, "create_call", lambda to, url: placed.append((to, url)) or "CA1")
    assert client.post("/care/test-call", json={"member_id": made["member_id"]}).json()["called"] == "Aunt Bea"
    assert placed[0][0] == "+14155550123" and placed[0][1].endswith("/twiml/test/" + made["member_id"])
    assert "test call" in client.post("/twiml/test/" + made["member_id"]).text.lower()


def test_phone_numbers_normalize_and_old_saved_numbers_load_dialable(tmp_path):
    import json

    from nightfall.household import load, normalize_phone

    assert normalize_phone("(626) 265-9377") == "+16262659377"
    assert normalize_phone("16262659377") == "+16262659377"
    assert normalize_phone("+44 20 7946 0958") == "+442079460958"
    assert normalize_phone("12") is None and normalize_phone("442079460958") is None
    raw = json.loads((api.ROOT / "data" / "household.json").read_text())
    raw["tree"][0]["phone"] = "16262659377"
    path = tmp_path / "h.json"
    path.write_text(json.dumps(raw))
    assert load(path).tree[0].phone == "+16262659377"


def test_clear_everything_refuses_to_overwrite_the_demo_household(client):
    before = api.store.hh
    assert client.post("/care/clear").status_code == 409
    assert api.store.hh == before


def test_clear_everything_wipes_entered_data_in_a_scratch_copy(client, monkeypatch, tmp_path):
    import shutil

    from nightfall import api_app, api_enroll, history
    from nightfall import store as store_mod

    data = tmp_path / "data"
    data.mkdir()
    shutil.copyfile(api.ROOT / "data" / "household.blank.json", data / "household.blank.json")
    (data / "household.live.json").write_text((data / "household.blank.json").read_text())
    for name in ("faces", "history"):
        (data / f"{name}.json").write_text("[1]")
    medical, photo, samples = data / "medical.json", tmp_path / "photo", tmp_path / "samples"
    medical.write_text("{}")
    photo.write_text("x")
    samples.mkdir()
    (samples / "everyday.wav").write_bytes(b"x")
    monkeypatch.setattr(store_mod, "ROOT", tmp_path)
    monkeypatch.setattr(store_mod, "household_filename", lambda: "household.live.json")
    monkeypatch.setattr(store_mod, "household_path", lambda: data / "household.live.json")
    monkeypatch.setattr(api, "household_path", lambda: data / "household.live.json")
    monkeypatch.setattr(api_enroll, "FACES", data / "faces.json")
    monkeypatch.setattr(history, "FILE", data / "history.json")
    monkeypatch.setattr(api_care, "PHOTO", photo)
    monkeypatch.setattr(api_app, "SAMPLES", samples)
    monkeypatch.setenv("MEDICAL_FILE", str(medical))
    assert client.post("/care/clear").json() == {"ok": True}
    assert not any(p.exists() for p in (data / "faces.json", data / "history.json", medical, photo))
    assert list(samples.glob("*.wav")) == [] and api.store.places == []
    assert api.store.hh.tree == () and api.store.hh.caregiver_name == ""


def test_invitation_link_uses_the_public_url_so_it_works_off_this_laptop(client, monkeypatch):
    monkeypatch.setenv("PUBLIC_URL", "https://family.example.com/")
    made = client.post("/care/members", json={"name": "Cousin Dee"}).json()
    assert made["invitation_url"] == "https://family.example.com/app?member=" + made["member_id"]
    assert client.get("/app/state").json()["public_url"] == "https://family.example.com/"


def test_schedule_switch_and_times_decide_when_the_door_is_watching(client, monkeypatch):
    from datetime import datetime

    assert client.put("/care/schedule", json={"enabled": True, "start": "21:00", "end": "21:00"}).status_code == 422
    assert client.put("/care/schedule", json={"enabled": True, "start": "9pm", "end": "06:00"}).status_code == 422
    monkeypatch.setattr(api.store, "night_mode", False)  # real clock rules, not the test override
    at = lambda hhmm: datetime.fromisoformat(f"2026-10-24T{hhmm}:00-07:00")
    assert client.put("/care/schedule", json={"enabled": True, "start": "21:00", "end": "06:00"}).status_code == 200
    for when, expected in (("22:00", True), ("02:30", True), ("12:00", False), ("06:00", False)):
        monkeypatch.setattr(api.store, "now", lambda when=when: at(when))
        assert api.store.night() is expected, when
    client.put("/care/schedule", json={"enabled": False, "start": "21:00", "end": "06:00"})
    monkeypatch.setattr(api.store, "now", lambda: at("22:00"))
    assert api.store.night() is False and client.get("/app/state").json()["household"]["watch_enabled"] is False
    client.put("/care/schedule", json={"enabled": True, "start": "21:00", "end": "06:00"})
