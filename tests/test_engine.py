from datetime import datetime, timedelta

from nightfall import engine
from nightfall.engine import Event, Incident, State, step

T0 = datetime(2026, 10, 25, 2, 0, 0)


def at(s: float) -> datetime:
    return T0 + timedelta(seconds=s)


def test_outside_window_ignored() -> None:
    inc = Incident("INC-1", night_mode=False)
    tr = step(inc, Event("door_open", at(0)))
    assert tr.rule == "ignored" and inc.state == State.ARMED_IDLE


def test_motion_speaks_open() -> None:
    inc = Incident("INC-1")
    tr = step(inc, Event("motion", at(0)))
    assert inc.state == State.CONVERSATION and "speak:open" in tr.actions


def test_line_budget() -> None:
    inc = Incident("INC-1")
    step(inc, Event("motion", at(0)))
    for i in range(3):
        assert "speak:again" in step(inc, Event("reply", at(i + 1), {"text": "work"})).actions
    assert step(inc, Event("reply", at(9), {"text": "work"})).rule == "ignored"


def test_false_alarm_returned() -> None:
    inc = Incident("INC-1")
    step(inc, Event("motion", at(0)))
    step(inc, Event("door_open", at(8)))
    tr = step(inc, Event("person_seen", at(15), {"inside": True}))
    assert inc.state == State.RETURNED and tr.rule == "R2"


def test_exit_after_door_wait() -> None:
    inc = Incident("INC-1")
    step(inc, Event("door_open", at(6)))
    assert step(inc, Event("tick", at(6 + engine.DOOR_WAIT_S - 1))).rule == "ignored"
    tr = step(inc, Event("tick", at(6 + engine.DOOR_WAIT_S)))
    assert inc.state == State.ESCALATING and set(tr.actions) == {"build_brief", "start_escalation"}
    assert inc.exited_at == at(6 + engine.DOOR_WAIT_S)


def test_door_close_without_sighting_exits() -> None:
    inc = Incident("INC-1")
    step(inc, Event("door_open", at(0)))
    step(inc, Event("door_close", at(5)))
    assert inc.state == State.ESCALATING


def test_ack_then_close() -> None:
    inc = Incident("INC-1")
    step(inc, Event("door_open", at(0)))
    step(inc, Event("door_close", at(5)))
    tr = step(inc, Event("ack", at(40), {"member_id": "TM-SARAH"}))
    assert inc.state == State.ACKED and inc.acked_by == "TM-SARAH" and "cancel_escalation" in tr.actions
    step(inc, Event("close", at(50)))
    assert inc.state == State.CLOSED


def test_deadline_exhausted() -> None:
    inc = Incident("INC-1")
    step(inc, Event("door_open", at(0)))
    step(inc, Event("door_close", at(5)))
    assert step(inc, Event("tick", at(5 + 899))).rule == "ignored"
    tr = step(inc, Event("tick", at(5 + 900)))
    assert inc.state == State.EXHAUSTED and "banner:call_911" in tr.actions


def test_every_pair_resolves() -> None:
    for st in State:
        for kind in engine.EVENT_KINDS:
            inc = Incident("INC-x", state=st)
            inc.door_opened_at = at(0)
            inc.exited_at = at(0)
            tr = step(inc, Event(kind, at(1), {"member_id": "x"}))
            assert tr.rule in {"ignored", "R0", "R1", "R2", "R3", "R4", "R10"}
