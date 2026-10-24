"""Phone event regressions, using a fresh in-process store and no external providers."""

import asyncio
from copy import deepcopy
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from nightfall import actions, api, api_app, api_cam, engine, history, voice
from nightfall.store import Store


@pytest.fixture
async def isolated_store(monkeypatch, tmp_path):
    monkeypatch.setattr(history, "FILE", tmp_path / "history.json")
    monkeypatch.setattr(api_app, "SAMPLES", tmp_path / "samples")
    monkeypatch.setattr(api_app, "_persist_household", lambda hh: None)
    monkeypatch.setattr(api, "_warm_memory", AsyncMock())
    monkeypatch.setattr(
        voice,
        "say",
        lambda text, persona="caregiver_clone": {
            "mode": "browser_tts",
            "source": "mock",
            "text": text,
            "url": "",
        },
    )
    store = Store()
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(store, "now", lambda: datetime(2026, 10, 24, 2, 0, tzinfo=UTC))
    yield store
    for incident_id in list(store.runner._tasks):
        await store.runner.cancel(incident_id)
    for task in [store.memory_task, *store.vision_tasks.values()]:
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    await store.memory.close()


def phones(store):
    return {member.id: store.hub.subscribe(f"phone:{member.id}") for member in store.hh.tree}


async def test_door_speech_reaches_phones_as_text_only_and_survives_snapshot_reload(isolated_store):
    store = isolated_store
    store.inc = engine.Incident(id="INC-CURRENT")
    dashboard = store.hub.subscribe("dashboard")
    subscribers = phones(store)
    actions.emit(
        store,
        {
            "type": "speak",
            "text": "Come inside for a moment.",
            "url": "/voice/private.wav",
            "mode": "cartesia",
            "voice_source": "cartesia",
            "raw_audio": "not for phone transport",
        },
    )
    expected = {
        "type": "speak",
        "text": "Come inside for a moment.",
        "incident_id": "INC-CURRENT",
        "ts": store.now().isoformat(),
    }
    for queue in subscribers.values():
        assert queue.get_nowait() == expected
        assert queue.empty()
    assert dashboard.get_nowait()["url"] == "/voice/private.wav"
    snapshot = await api_app.app_state(member=store.hh.tree[0].id)
    assert snapshot["door_speech"] == {"text": expected["text"], "incident_id": "INC-CURRENT", "ts": expected["ts"]}


@pytest.mark.parametrize("next_incident", [None, "INC-NEW"])
async def test_snapshot_does_not_restore_subtitles_from_a_previous_incident(isolated_store, next_incident):
    store = isolated_store
    store.inc = engine.Incident(id="INC-OLD")
    actions.emit(store, {"type": "speak", "text": "An old conversation."})
    store.inc = engine.Incident(id=next_incident) if next_incident else None
    assert (await api_app.app_state())["door_speech"] is None


@pytest.mark.parametrize("result", ["enroll_success", "enroll_error"])
async def test_enrollment_result_preserves_person_identity_for_phone_feedback(isolated_store, result):
    subscribers = phones(isolated_store)
    await api_cam.door_telemetry(
        api_cam.TelemetryIn(
            event=result,
            detail="Camera registration result",
            name="Robert Miller",
            label="person",
        )
    )
    for queue in subscribers.values():
        event = queue.get_nowait()
        assert event == {
            "type": "door",
            "event": result,
            "detail": "Camera registration result",
            "name": "Robert Miller",
            "label": "person",
            "ts": isolated_store.now().isoformat(),
        }


async def test_camera_debug_and_control_commands_do_not_leak_to_phones(isolated_store):
    subscribers = phones(isolated_store)
    dashboard = isolated_store.hub.subscribe("dashboard")
    await api_cam.door_telemetry(api_cam.TelemetryIn(event="detector_ready", detail="debug data"))
    await api_cam.door_command(api_cam.CommandIn(cmd="enroll", name="Robert Miller", label="person"))
    assert all(queue.empty() for queue in subscribers.values())
    received = [dashboard.get_nowait() for _ in range(dashboard.qsize())]
    assert any(event["type"] == "command" and event["cmd"] == "enroll" for event in received)


async def test_answer_event_is_private_but_takeover_status_reaches_the_care_circle(isolated_store):
    store = isolated_store
    subscribers = phones(store)
    answered_by = store.hh.tree[0].id
    actions.emit(store, {"type": "answered", "member_id": answered_by, "incident_id": "INC-CURRENT", "url": "private"})
    assert subscribers[answered_by].get_nowait() == {
        "type": "answered",
        "member_id": answered_by,
        "incident_id": "INC-CURRENT",
        "ts": store.now().isoformat(),
    }
    assert all(queue.empty() for queue in subscribers.values())
    actions.emit(store, {"type": "live", "member_id": answered_by, "by": "Sarah", "on": True})
    for queue in subscribers.values():
        event = queue.get_nowait()
        assert event["type"] == "live" and event["by"] == "Sarah" and event["on"] is True


async def test_stale_ack_does_not_silence_or_change_the_current_incident(isolated_store, monkeypatch):
    store = isolated_store
    store.inc = engine.Incident(id="INC-NEW", state=engine.State.CONVERSATION)
    before = deepcopy(store.inc)
    subscribers = phones(store)
    runner_ack = AsyncMock()
    monkeypatch.setattr(store.runner, "ack", runner_ack)
    with pytest.raises(HTTPException) as raised:
        await api.ack(api.AckIn(incident_id="INC-OLD", member_id=store.hh.tree[0].id))
    assert raised.value.status_code == 404
    runner_ack.assert_not_awaited()
    assert store.inc == before
    assert store.quiet_until is None
    assert store.log == []
    assert all(queue.empty() for queue in subscribers.values())


async def test_explicit_night_watch_off_blocks_wander_speech_even_at_two_am(isolated_store):
    store = isolated_store
    assert store.now().hour == 2
    assert await api.arm(api.ArmIn(on=False)) == {"night_mode": False}
    off = await api.event(api.EventIn(kind="person_enter"))
    assert off["actions"] == []
    assert store.door_speech is None and store.runner.rings == []
    assert (await api_app.app_state())["night_mode"] is False
    await api.arm(api.ArmIn(on=True))
    on = await api.event(api.EventIn(kind="person_enter"))
    assert on["to"] == "CONVERSATION"
    assert "speak:open" in on["actions"]
    assert store.door_speech["incident_id"] == store.inc.id


async def test_reset_notifies_existing_and_invited_phones_and_clears_subtitles(isolated_store):
    store = isolated_store
    joined = await api.tree(api.TreeIn(name="Demo judge", phone="web", tier=1))
    subscribers = phones(store)
    assert joined["member_id"] in subscribers
    store.inc = engine.Incident(id="INC-CURRENT")
    actions.emit(store, {"type": "speak", "text": "Previous session."})
    for queue in subscribers.values():
        queue.get_nowait()
    result = await api.reset()
    assert result == {"ok": True}
    assert store.inc is None and store.door_speech is None
    assert (await api_app.app_state())["door_speech"] is None
    for member_id, queue in subscribers.items():
        assert not queue.empty(), f"Reset did not reach {member_id}"
        assert queue.get_nowait() == {"type": "reset"}
