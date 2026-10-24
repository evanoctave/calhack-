"""Exit by absence: last seen at the door, then nobody, means they went out."""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from nightfall.engine import Event, Incident, State, step

T0 = datetime(2026, 10, 25, 2, 0, 0)


def at(s: float) -> datetime:
    return T0 + timedelta(seconds=s)


def door(s: float) -> Event:
    """A sighting in the door zone: present, but not back inside."""
    return Event("person_seen", at(s), {"inside": False, "zone": "door"})


def room(s: float) -> Event:
    """A sighting away from the door: they went back into the house."""
    return Event("person_seen", at(s), {"inside": True, "zone": "room"})


@pytest.fixture
def talking() -> Incident:
    inc = Incident("INC-1")
    step(inc, Event("motion", at(0)))
    assert inc.state == State.CONVERSATION
    return inc


def test_person_appearing_starts_the_conversation() -> None:
    inc = Incident("INC-1")
    tr = step(inc, Event("motion", at(0)))
    assert tr.to_state == State.CONVERSATION and "speak:open" in tr.actions


def test_at_the_door_keeps_watching(talking) -> None:
    tr = step(talking, door(2))
    assert talking.state == State.CONVERSATION and tr.rule == "ignored"
    assert talking.last_zone == "door" and talking.last_person_at == at(2)


def test_gone_from_the_door_is_an_exit(talking, monkeypatch) -> None:
    monkeypatch.setenv("ABSENCE_S", "10")
    step(talking, door(2))
    assert step(talking, Event("tick", at(8))).rule == "ignored"
    tr = step(talking, Event("tick", at(12)))
    assert tr.to_state == State.ESCALATING
    assert "build_brief" in tr.actions and "start_escalation" in tr.actions
    assert talking.exited_at == at(12)


def test_going_back_inside_cancels_everything(talking) -> None:
    step(talking, door(2))
    tr = step(talking, room(4))
    assert tr.to_state == State.RETURNED
    assert step(talking, Event("tick", at(600))).rule == "ignored"


def test_never_at_the_door_just_goes_quiet(talking, monkeypatch) -> None:
    """Someone crossing the hallway must not ring the family."""
    monkeypatch.setenv("CONVERSATION_TIMEOUT_S", "90")
    assert step(talking, Event("tick", at(60))).rule == "ignored"
    tr = step(talking, Event("tick", at(95)))
    assert tr.to_state == State.RETURNED and tr.rule == "R1"


def test_conversation_is_no_longer_a_dead_end(talking, monkeypatch) -> None:
    """Regression: CONVERSATION had no tick, no close and no re-trigger, so one stray
    motion event stuck the demo until /reset."""
    monkeypatch.setenv("CONVERSATION_TIMEOUT_S", "90")
    step(talking, Event("tick", at(95)))
    assert step(talking, Event("close", at(96))).to_state == State.CLOSED
    again = Incident("INC-2")
    assert step(again, Event("motion", at(100))).to_state == State.CONVERSATION


def test_absence_window_is_read_per_call(talking, monkeypatch) -> None:
    monkeypatch.setenv("ABSENCE_S", "60")
    step(talking, door(2))
    assert step(talking, Event("tick", at(30))).rule == "ignored"
    monkeypatch.setenv("ABSENCE_S", "5")
    assert step(talking, Event("tick", at(30))).to_state == State.ESCALATING


def test_a_sighting_resets_the_absence_clock(talking, monkeypatch) -> None:
    monkeypatch.setenv("ABSENCE_S", "10")
    step(talking, door(2))
    step(talking, door(9))
    assert step(talking, Event("tick", at(15))).rule == "ignored", "only 6 s since the last sighting"
    assert step(talking, Event("tick", at(20))).to_state == State.ESCALATING


def test_the_door_sensor_path_still_works(monkeypatch) -> None:
    """Simulate exit must keep working: it is the fallback when detection fails on stage."""
    monkeypatch.setenv("DOOR_WAIT_S", "20")
    inc = Incident("INC-1")
    step(inc, Event("motion", at(0)))
    assert step(inc, Event("door_open", at(2))).to_state == State.DOOR_OPEN
    assert step(inc, Event("door_close", at(5))).to_state == State.ESCALATING


def test_exit_by_absence_and_by_door_produce_the_same_actions(monkeypatch) -> None:
    monkeypatch.setenv("ABSENCE_S", "10")
    a = Incident("INC-A")
    step(a, Event("motion", at(0))); step(a, door(2))
    by_absence = step(a, Event("tick", at(20)))
    b = Incident("INC-B")
    step(b, Event("motion", at(0))); step(b, Event("door_open", at(2)))
    by_door = step(b, Event("door_close", at(5)))
    assert by_absence.actions == by_door.actions
    assert by_absence.to_state == by_door.to_state == State.ESCALATING
