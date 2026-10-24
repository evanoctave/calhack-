"""Selected voice identity stays consistent after replacing a family clone with a preset."""

import os
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from nightfall import actions, api_voice, voice


@pytest.fixture
def selected_clone(tmp_path, monkeypatch):
    values = {
        "CARTESIA_VOICE_ID": "previous-cloned-voice",
        "VOICE_SPEED": "1.0",
        "VOICE_EMOTION": "happy",
        "VOICE_IS_CLONE": "1",
        "VOICE_NAME": "Test caregiver",
    }
    env = tmp_path / "backend.env"
    env.write_text("UNRELATED_SETTING=keep\n" + "".join(f"{key}={value}\n" for key, value in values.items()))
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("ENV_FILE", str(env))
    store = SimpleNamespace(hh=object(), voice_source="clone", voice_name="Test caregiver")
    monkeypatch.setattr(api_voice, "_store", lambda: store)
    monkeypatch.setattr(voice, "pre_synthesize", lambda _household: {})
    monkeypatch.setattr(actions, "emit", lambda *_args: None)
    app = FastAPI()
    app.include_router(api_voice.router)
    with TestClient(app) as client:
        yield client, store, env


def test_preset_selection_replaces_clone_identity_and_persists_it(selected_clone):
    client, store, env = selected_clone

    response = client.post(
        "/voice/select", json={"voice_id": "ready-made-voice", "speed": 0.95, "emotion": "calm"}
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "voice_id": "ready-made-voice",
        "speed": 0.95,
        "emotion": "calm",
    }
    assert (store.voice_source, store.voice_name) == ("stock", "")
    assert os.environ["CARTESIA_VOICE_ID"] == "ready-made-voice"
    assert os.environ["VOICE_IS_CLONE"] == "0"
    assert os.environ["VOICE_NAME"] == ""
    saved = dict(line.split("=", 1) for line in env.read_text().splitlines())
    assert saved == {
        "UNRELATED_SETTING": "keep",
        "CARTESIA_VOICE_ID": "ready-made-voice",
        "VOICE_SPEED": "0.95",
        "VOICE_EMOTION": "calm",
        "VOICE_IS_CLONE": "0",
        "VOICE_NAME": "",
    }


def test_invalid_preset_keeps_the_existing_clone_identity(selected_clone):
    client, store, env = selected_clone
    before = env.read_text()

    response = client.post("/voice/select", json={"voice_id": "ready-made-voice", "speed": 2.0})

    assert response.status_code == 422
    assert (store.voice_source, store.voice_name) == ("clone", "Test caregiver")
    assert os.environ["CARTESIA_VOICE_ID"] == "previous-cloned-voice"
    assert os.environ["VOICE_IS_CLONE"] == "1"
    assert env.read_text() == before
