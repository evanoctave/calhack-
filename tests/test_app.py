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


def _align_caregiver_with_first_member() -> None:
    """A profile rename follows the tree member who carries the caregiver's name; make that the first member."""
    from dataclasses import replace

    store = api_app._store()
    store.hh = replace(store.hh, caregiver_name=store.hh.tree[0].name)


def test_app_state_and_profile(client: TestClient) -> None:
    _align_caregiver_with_first_member()
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
    _align_caregiver_with_first_member()
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


def test_profile_save_keeps_the_search_radius(tmp_path, monkeypatch) -> None:
    import json
    from dataclasses import replace

    monkeypatch.setattr(api_app, "ROOT", tmp_path)
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "household.json").write_text(json.dumps({"radius_mi": 1.5}))
    api_app._persist_household(replace(api.store.hh, radius_mi=3.0))
    saved = json.loads((tmp_path / "data" / "household.json").read_text())
    assert saved["radius_mi"] == 3.0 and "description" in saved and "doctor" in saved


def test_person_details_and_later_edits_survive_restarts(tmp_path, monkeypatch) -> None:
    import shutil

    from nightfall import api_care, store

    (tmp_path / "data").mkdir()
    shutil.copy(api.ROOT / "data/household.blank.json", tmp_path / "data/household.blank.json")
    monkeypatch.setenv("FRESH_START", "1")
    monkeypatch.setattr(store, "ROOT", tmp_path)
    monkeypatch.setattr(api_app, "ROOT", tmp_path)
    monkeypatch.setattr(api_care, "PHOTO", tmp_path / "photo")
    original = {
        "person_full_name": "Robert Example",
        "person_name": "Bob",
        "person_age": 74,
        "caregiver_name": "Sam",
        "caregiver_relationship": "Daughter",
        "description": {"height": "5 ft 9 in", "hair": "Gray", "eyes": "Brown"},
        "diagnosis": "Dementia",
        "doctor": {"name": "Dr. Example", "phone": "415-555-0101"},
    }
    monkeypatch.setattr(api, "store", store.Store())
    with TestClient(api.app) as client:
        member = client.post("/care/members", json={"name": "Sam", "phone": "415-555-0123"}).json()
        assert client.post("/profile", json=original).status_code == 200
        image = (api.ROOT / "static/assets/figma/demo-camera.png").read_bytes()
        photo = client.post("/care/photo", files={"photo": ("portrait.png", image, "image/png")}).json()["photo"]

    updates = {
        "person_full_name": "Robert Updated",
        "person_name": "Robert",
        "person_age": 75,
        "description": {"height": "5 ft 9 in", "hair": "White", "eyes": "Brown"},
        "diagnosis": "Updated care notes",
        "doctor": {"name": "Dr. New", "phone": "415-555-0102"},
    }
    cleared = {"person_age": 0, "description": {}, "diagnosis": "", "doctor": {"name": "", "phone": ""}}
    for expected, edit in (
        (original, updates),
        ({**original, **updates}, cleared),
        ({**original, **updates, **cleared}, None),
    ):
        monkeypatch.setattr(api, "store", store.Store())
        with TestClient(api.app) as client:
            saved = client.get("/app/state").json()["household"]
            assert {field: saved[field] for field in expected} == expected
            assert saved["photo"] == photo
            assert client.get(photo).content == image
            assert saved["tree"][0]["id"] == member["member_id"]
            assert saved["tree"][0]["phone"] == "+14155550123"
            if edit is not None:
                assert client.post("/profile", json=edit).status_code == 200


def test_failed_profile_save_keeps_previous_file_and_reports_failure(tmp_path, monkeypatch) -> None:
    from dataclasses import replace
    from pathlib import Path

    from fastapi import HTTPException

    monkeypatch.setenv("FRESH_START", "1")
    monkeypatch.setattr(api_app, "ROOT", tmp_path)
    (tmp_path / "data").mkdir()
    target = tmp_path / "data/household.live.json"
    previous = (api.ROOT / "data/household.blank.json").read_bytes()
    target.write_bytes(previous)

    def fail_replace(self, destination):
        raise OSError("disk unavailable")

    monkeypatch.setattr(Path, "replace", fail_replace)
    with pytest.raises(HTTPException) as error:
        api_app._persist_household(replace(api.store.hh, person_name="Changed"))
    assert error.value.status_code == 500
    assert target.read_bytes() == previous
    assert list(target.parent.glob(".household-*")) == []
