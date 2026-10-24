"""Incident state machine. Pure over (incident, event); no I/O, no clock reads.

Owns the only place that sets incident.state. A dict keyed by (state, event kind) dispatches to a
handler; unknown pairs are no-ops recorded as "ignored". Rejected: nested ifs (not printable, not
walkable by a test).
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Final


class State(str, Enum):
    ARMED_OFF = "ARMED_OFF"
    ARMED_IDLE = "ARMED_IDLE"
    CONVERSATION = "CONVERSATION"
    DOOR_OPEN = "DOOR_OPEN"
    ESCALATING = "ESCALATING"
    ACKED = "ACKED"
    RETURNED = "RETURNED"
    EXHAUSTED = "EXHAUSTED"
    CLOSED = "CLOSED"


DOOR_WAIT_S: Final[float] = float(os.environ.get("DOOR_WAIT_S", "20"))
DEADLINE_S: Final[float] = 15 * 60
MAX_LINES: Final[int] = 4
LINE_GAP_S: Final[float] = float(os.environ.get("LINE_GAP_S", "8"))


@dataclass
class Event:
    kind: str
    ts: datetime
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass
class Incident:
    id: str
    state: State = State.ARMED_IDLE
    night_mode: bool = True
    opened_at: datetime | None = None
    door_opened_at: datetime | None = None
    exited_at: datetime | None = None
    acked_by: str | None = None
    lines_spoken: int = 0
    seen_inside: bool = False
    last_line_at: datetime | None = None
    person_in_frame: bool = False

    @property
    def deadline_at(self) -> datetime | None:
        """Exit time plus 15 minutes, the Association's call-911 mark."""
        if self.exited_at is None:
            return None
        from datetime import timedelta

        return self.exited_at + timedelta(seconds=DEADLINE_S)


@dataclass(frozen=True)
class Transition:
    from_state: State
    to_state: State
    actions: tuple[str, ...]
    rule: str
    detail: str = ""


Handler = Callable[[Incident, Event], Transition]


def _t(inc: Incident, to: State, actions: tuple[str, ...], rule: str, detail: str = "") -> Transition:
    tr = Transition(inc.state, to, actions, rule, detail)
    inc.state = to
    return tr


def _ignored(inc: Incident, ev: Event, why: str) -> Transition:
    return Transition(inc.state, inc.state, (), "ignored", why)


def _motion(inc: Incident, ev: Event) -> Transition:
    if not inc.night_mode:
        return _ignored(inc, ev, "R0 outside night window")
    inc.opened_at = ev.ts
    inc.lines_spoken = 1
    inc.last_line_at = ev.ts
    inc.person_in_frame = ev.kind == "person_enter"
    return _t(inc, State.CONVERSATION, ("speak:open",), "R0", "ok")


def _reply(inc: Incident, ev: Event) -> Transition:
    if inc.lines_spoken >= MAX_LINES:
        return _ignored(inc, ev, "R1 line budget exhausted")
    inc.lines_spoken += 1
    inc.last_line_at = ev.ts
    return _t(inc, State.CONVERSATION, ("speak:again",), "R1", "ok")


def _tick_conversation(inc: Incident, ev: Event) -> Transition:
    """While the person stays in frame, speak another line every LINE_GAP_S until the R1 budget ends."""
    if not inc.person_in_frame or inc.last_line_at is None:
        return _ignored(inc, ev, "conversation idle")
    if inc.lines_spoken >= MAX_LINES:
        return _ignored(inc, ev, "R1 line budget exhausted")
    if (ev.ts - inc.last_line_at).total_seconds() < LINE_GAP_S:
        return _ignored(inc, ev, "waiting for reply")
    inc.lines_spoken += 1
    inc.last_line_at = ev.ts
    return _t(inc, State.CONVERSATION, ("speak:again",), "R1", "auto line")


def _person_lost(inc: Incident, ev: Event) -> Transition:
    """Camera lost the person: same clock as a door opening (R2)."""
    inc.person_in_frame = False
    tr = _door_open(inc, ev)
    return Transition(
        tr.from_state, tr.to_state, tr.actions, tr.rule, "person left the frame" if tr.rule != "ignored" else tr.detail
    )


def _person_back_door(inc: Incident, ev: Event) -> Transition:
    inc.person_in_frame = True
    inc.seen_inside = True
    return _t(inc, State.RETURNED, ("log:returned",), "R2", "person back in frame")


def _person_back_escalating(inc: Incident, ev: Event) -> Transition:
    inc.person_in_frame = True
    return _t(inc, State.RETURNED, ("cancel_escalation", "notify:returned"), "R2", "person back in frame after exit")


def _seen_inside_conv(inc: Incident, ev: Event) -> Transition:
    if not ev.payload.get("inside", True):
        return _ignored(inc, ev, "seen but not inside")
    return _t(inc, State.RETURNED, ("log:returned",), "R2", "returned before door")


def _door_open(inc: Incident, ev: Event) -> Transition:
    if not inc.night_mode:
        return _ignored(inc, ev, "R0 outside night window")
    inc.opened_at = inc.opened_at or ev.ts
    inc.door_opened_at = ev.ts
    inc.seen_inside = False
    return _t(inc, State.DOOR_OPEN, ("capture_exit_frames",), "R2", "waiting")


def _exit(inc: Incident, ev: Event, detail: str) -> Transition:
    inc.exited_at = ev.ts
    return _t(inc, State.ESCALATING, ("build_brief", "start_escalation"), "R2", detail)


def _door_close(inc: Incident, ev: Event) -> Transition:
    assert inc.door_opened_at is not None
    secs = (ev.ts - inc.door_opened_at).total_seconds()
    if inc.seen_inside:
        return _t(inc, State.RETURNED, ("log:returned",), "R2", f"door opened {secs:.0f} s, person inside")
    return _exit(inc, ev, f"door closed after {secs:.0f} s, nobody seen inside")


def _seen_inside_door(inc: Incident, ev: Event) -> Transition:
    if not ev.payload.get("inside", True):
        return _ignored(inc, ev, "seen but not inside")
    inc.seen_inside = True
    return _t(inc, State.RETURNED, ("log:returned",), "R2", "person seen inside")


def _tick_door(inc: Incident, ev: Event) -> Transition:
    assert inc.door_opened_at is not None
    secs = (ev.ts - inc.door_opened_at).total_seconds()
    if secs >= DOOR_WAIT_S:
        return _exit(inc, ev, f"door open {secs:.0f} s, nobody seen inside")
    return _ignored(inc, ev, f"waiting {secs:.0f}/{DOOR_WAIT_S:.0f} s")


def _ack(inc: Incident, ev: Event) -> Transition:
    inc.acked_by = str(ev.payload.get("member_id", ""))
    return _t(inc, State.ACKED, ("cancel_escalation",), "R4", f"acked by {inc.acked_by}")


def _tick_escalating(inc: Incident, ev: Event) -> Transition:
    dl = inc.deadline_at
    if dl is not None and ev.ts >= dl:
        return _t(inc, State.EXHAUSTED, ("banner:call_911",), "R3", "15 minutes since exit")
    return _ignored(inc, ev, "escalating")


def _close(inc: Incident, ev: Event) -> Transition:
    return _t(inc, State.CLOSED, ("delete_frames",), "R10", "closed")


TRANSITIONS: Final[dict[tuple[State, str], Handler]] = {
    (State.ARMED_IDLE, "motion"): _motion,
    (State.ARMED_IDLE, "person_enter"): _motion,
    (State.CONVERSATION, "tick"): _tick_conversation,
    (State.CONVERSATION, "person_lost"): _person_lost,
    (State.DOOR_OPEN, "person_back"): _person_back_door,
    (State.ESCALATING, "person_back"): _person_back_escalating,
    (State.ARMED_IDLE, "door_open"): _door_open,
    (State.CONVERSATION, "reply"): _reply,
    (State.CONVERSATION, "person_seen"): _seen_inside_conv,
    (State.CONVERSATION, "door_open"): _door_open,
    (State.DOOR_OPEN, "door_close"): _door_close,
    (State.DOOR_OPEN, "person_seen"): _seen_inside_door,
    (State.DOOR_OPEN, "tick"): _tick_door,
    (State.ESCALATING, "ack"): _ack,
    (State.ESCALATING, "tick"): _tick_escalating,
    (State.EXHAUSTED, "ack"): _ack,
    (State.ACKED, "close"): _close,
    (State.EXHAUSTED, "close"): _close,
    (State.RETURNED, "close"): _close,
}

EVENT_KINDS: Final[frozenset[str]] = frozenset(
    {
        "motion",
        "door_open",
        "door_close",
        "person_seen",
        "reply",
        "tick",
        "ack",
        "close",
        "person_enter",
        "person_lost",
        "person_back",
    }
)


def step(inc: Incident, ev: Event) -> Transition:
    """Apply one event. Unknown (state, kind) pairs are ignored and reported as such."""
    handler = TRANSITIONS.get((inc.state, ev.kind))
    if handler is None:
        return _ignored(inc, ev, f"no transition for {inc.state.value} + {ev.kind}")
    return handler(inc, ev)
