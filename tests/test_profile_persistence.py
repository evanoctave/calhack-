"""Profile persistence and caregiver snapshots, isolated from the running demo and its files."""

import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from nightfall import api_app, api_setup, engine
from nightfall.household import load


@pytest.fixture
def profile_store(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    path = data / "household.json"
    path.write_text(
        json.dumps(
            {
                "id": "TEST-HOUSEHOLD",
                "person_name": "Dad",
                "person_full_name": "Robert Test",
                "person_age": 78,
                "person_photo": "/reference.jpg",
                "caregiver_name": "Sarah",
                "address": "Old address",
                "home_lat": 37.8,
                "home_lng": -122.4,
                "radius_mi": 1.5,
                "tree": [{"id": "TM-SARAH", "name": "Sarah", "phone": "web", "tier": 1}],
                "description": {"hair": "gray"},
                "diagnosis": "Original diagnosis",
                "doctor": {"name": "Original doctor", "phone": ""},
                "medications": [{"name": "demo medication", "dose": "test", "note": "fixture"}],
                "custom_field": "preserve me",
            }
        )
    )
    household = load(path)
    store = SimpleNamespace(
        hh=household,
        inc=None,
        runner=SimpleNamespace(rings=[]),
        briefs={},
        frames={},
        history=[],
        places=[],
        now=lambda: datetime(2026, 10, 24, 2, 0, tzinfo=UTC),
        night=lambda: True,
        takeover_by=None,
        call_911_sent=False,
        door_speech=None,
        voice_source="mock",
        voice_name="Test voice",
        memory=SimpleNamespace(source="mock"),
        places_source=lambda: "fixture",
        latest_frame=b"",
        latest_frame_at=0,
        link=lambda incident_id, member_id: f"/brief.html#{incident_id}-{member_id}",
    )
    monkeypatch.setattr(api_app, "ROOT", tmp_path)
    monkeypatch.setattr(api_app, "SAMPLES", tmp_path / "samples")
    monkeypatch.setattr(api_app, "_store", lambda: store)
    monkeypatch.setattr(api_app, "_live_by", lambda: None)
    app = FastAPI()
    app.include_router(api_app.router)
    return store, path, TestClient(app)


def test_supported_profile_fields_survive_reload_and_keep_existing_data(profile_store):
    store, path, client = profile_store
    store.hh = replace(store.hh, radius_mi=2.25)
    response = client.post(
        "/profile",
        json={
            "person_full_name": "Robert Updated",
            "caregiver_name": "Sally",
            "description": {"height": "5 ft 9 in", "marks": "Scar on left hand"},
            "diagnosis": "Updated diagnosis",
            "doctor": {"name": "Dr. Test", "phone": "+14155550123"},
        },
    )
    assert response.status_code == 200
    reloaded = load(path)
    assert reloaded.person_full_name == "Robert Updated"
    assert reloaded.description == {"height": "5 ft 9 in", "marks": "Scar on left hand"}
    assert reloaded.diagnosis == "Updated diagnosis"
    assert reloaded.doctor == {"name": "Dr. Test", "phone": "+14155550123"}
    assert reloaded.radius_mi == 2.25
    assert reloaded.caregiver_name == reloaded.tree[0].name == "Sally"
    saved = json.loads(path.read_text())
    assert saved["person_photo"] == "/reference.jpg"
    assert saved["medications"][0]["name"] == "demo medication"
    assert saved["custom_field"] == "preserve me"
    assert list(path.parent.glob(".household-*.tmp")) == []


def test_failed_atomic_replace_returns_500_and_restores_household(profile_store, monkeypatch):
    store, path, client = profile_store
    before = path.read_bytes()
    household = store.hh
    replacement_attempts = []

    def fail_replace(source, target):
        replacement_attempts.append((Path(source), Path(target)))
        assert Path(target).read_bytes() == before
        assert json.loads(Path(source).read_text())["diagnosis"] == "New diagnosis"
        raise OSError("disk unavailable")

    monkeypatch.setattr(api_app.os, "replace", fail_replace)
    response = client.post("/profile", json={"caregiver_name": "Changed", "diagnosis": "New diagnosis"})
    assert response.status_code == 500
    assert "No profile changes were saved" in response.json()["detail"]
    assert store.hh is household
    assert path.read_bytes() == before
    assert len(replacement_attempts) == 1
    assert list(path.parent.glob(".household-*.tmp")) == []


def test_corrupt_profile_file_is_not_overwritten_or_reported_as_saved(profile_store):
    store, path, client = profile_store
    household = store.hh
    path.write_text("incomplete JSON")
    response = client.post("/profile", json={"doctor": {"name": "New doctor"}})
    assert response.status_code == 500
    assert path.read_text() == "incomplete JSON"
    assert store.hh is household


def test_address_failure_restores_household_without_writing_a_partial_profile(profile_store, monkeypatch):
    store, path, client = profile_store
    household, before = store.hh, path.read_bytes()

    async def fail_address(_body, *, persist_household):
        assert persist_household is False
        store.hh = replace(store.hh, home_lat=0, home_lng=0)
        raise HTTPException(404, "address not found")

    monkeypatch.setattr(api_setup, "_setup_address", fail_address)
    response = client.post("/profile", json={"address": "Unresolvable address", "diagnosis": "Changed"})
    assert response.status_code == 404
    assert store.hh is household
    assert path.read_bytes() == before


def test_snapshot_scopes_speech_to_current_incident_and_keeps_ring_incident_ids(profile_store):
    store, _path, client = profile_store
    store.inc = engine.Incident(id="CURRENT", night_mode=True)
    store.inc.cause = "help"
    store.runner.rings = [{"incident_id": "OLD", "tier": 1, "members": ["TM-SARAH"]}]
    store.door_speech = {"incident_id": "OLD", "text": "Old caption"}
    snapshot = client.get("/app/state?member=TM-SARAH").json()
    assert snapshot["incident"]["cause"] == "help"
    assert snapshot["rings"][0]["incident_id"] == "OLD"
    assert snapshot["door_speech"] is None
    store.door_speech = {"incident_id": "CURRENT", "text": "Current caption"}
    assert client.get("/app/state").json()["door_speech"]["text"] == "Current caption"


@pytest.mark.parametrize(
    "state,checkin",
    [
        (engine.State.RETURNED, "none"),
        (engine.State.CLOSED, "none"),
        (engine.State.WATCHING, "none"),
        (engine.State.ESCALATING, "self_other"),
    ],
)
def test_snapshot_hides_stale_emergency_option_for_resolved_states(profile_store, state, checkin):
    store, _path, client = profile_store
    store.inc = engine.Incident(id="CURRENT", night_mode=True, state=state)
    store.inc.checkin = checkin
    store.inc.exited_at = store.now()
    store.call_911_sent = True
    snapshot = client.get("/app/state").json()
    assert snapshot["call_911"] is False
    assert snapshot["incident"]["emergency"]["option_shown"] is False
    assert snapshot["incident"]["emergency"]["deadline_hhmm"] == ""


def test_help_emergency_copy_does_not_claim_an_exit(profile_store):
    store, _path, client = profile_store
    store.inc = engine.Incident(id="HELP", night_mode=True, state=engine.State.ESCALATING)
    store.inc.cause = "help"
    store.inc.exited_at = store.now()
    emergency = client.get("/app/state").json()["incident"]["emergency"]
    assert "Help was requested" in emergency["text"]
    assert "out of view" not in emergency["text"]
    assert emergency["deadline_hhmm"] == ""
    store.call_911_sent = True
    assert client.get("/app/state").json()["call_911"] is True
