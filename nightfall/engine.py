"""Incident state machine. Pure over (incident, event); no I/O, no clock reads.

Owns the only place that sets incident.state. A dict keyed by (state, event kind) dispatches to a
handler; unknown pairs are no-ops recorded as "ignored". Rejected: nested ifs (not printable, not
walkable by a test).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Final


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
DEFAULT_ABSENCE_S: Final[float] = 10.0
DEFAULT_CONVERSATION_TIMEOUT_S: Final[float] = 90.0
DOOR_ZONE: Final[str] = "door"


def _env_float(name: str, default: float) -> float:
    """Read a tuning value per call, not at import, so a test can change it without reimporting."""
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def absence_s() -> float:
    """Seconds with nobody visible, after a sighting at the door, before it counts as an exit."""
    return _env_float("ABSENCE_S", DEFAULT_ABSENCE_S)


def conversation_timeout_s() -> float:
    """R1: the conversation goes quiet after this long with no sighting at the door."""
    return _env_float("CONVERSATION_TIMEOUT_S", DEFAULT_CONVERSATION_TIMEOUT_S)


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
    last_person_at: datetime | None = None
    last_zone: str = ""

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
    return _t(inc, State.CONVERSATION, ("speak:open",), "R0", "ok")


def _reply(inc: Incident, ev: Event) -> Transition:
    if inc.lines_spoken >= MAX_LINES:
        return _ignored(inc, ev, "R1 line budget exhausted")
    inc.lines_spoken += 1
    return _t(inc, State.CONVERSATION, ("speak:again",), "R1", "ok")


def _seen_inside_conv(inc: Incident, ev: Event) -> Transition:
    """A sighting away from the door means they went back in. At the door it only resets the clock."""
    inc.last_person_at = ev.ts
    inc.last_zone = str(ev.payload.get("zone", "") or "")
    if not ev.payload.get("inside", True):
        return _ignored(inc, ev, f"at the {inc.last_zone or 'door'}, still watching")
    return _t(inc, State.RETURNED, ("log:returned",), "R2", "returned before door")


def _tick_conversation(inc: Incident, ev: Event) -> Transition:
    """R2 by absence: last seen at the door, then nobody, for long enough, means they went out.

    Without a sighting at the door there is nothing to escalate on, so the conversation simply
    goes quiet (R1) and the incident ends. That also stops CONVERSATION being a state with no exit.
    """
    if inc.last_person_at is not None and inc.last_zone == DOOR_ZONE:
        gone = (ev.ts - inc.last_person_at).total_seconds()
        if gone >= absence_s():
            return _exit(inc, ev, f"last seen at the door, gone {gone:.0f} s")
        return _ignored(inc, ev, f"at the door, gone {gone:.0f}/{absence_s():.0f} s")
    since = (ev.ts - inc.opened_at).total_seconds() if inc.opened_at else 0.0
    if since >= conversation_timeout_s():
        return _t(inc, State.RETURNED, ("log:returned",), "R1", f"quiet after {since:.0f} s, never at the door")
    return _ignored(inc, ev, f"talking {since:.0f}/{conversation_timeout_s():.0f} s")


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
    (State.ARMED_IDLE, "door_open"): _door_open,
    (State.CONVERSATION, "reply"): _reply,
    (State.CONVERSATION, "tick"): _tick_conversation,
    (State.CONVERSATION, "close"): _close,
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
    {"motion", "door_open", "door_close", "person_seen", "reply", "tick", "ack", "close"}
)


def step(inc: Incident, ev: Event) -> Transition:
    """Apply one event. Unknown (state, kind) pairs are ignored and reported as such."""
    handler = TRANSITIONS.get((inc.state, ev.kind))
    if handler is None:
        return _ignored(inc, ev, f"no transition for {inc.state.value} + {ev.kind}")
    return handler(inc, ev)
