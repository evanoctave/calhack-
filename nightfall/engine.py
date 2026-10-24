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

from nightfall.rules import Features, wander_score
from nightfall.rules import Verdict as RuleVerdict


class State(str, Enum):
    ARMED_OFF = "ARMED_OFF"
    ARMED_IDLE = "ARMED_IDLE"
    CONVERSATION = "CONVERSATION"
    VISITOR = "VISITOR"
    WATCHING = "WATCHING"
    DOOR_OPEN = "DOOR_OPEN"
    ESCALATING = "ESCALATING"
    ACKED = "ACKED"
    RETURNED = "RETURNED"
    EXHAUSTED = "EXHAUSTED"
    CLOSED = "CLOSED"


DOOR_WAIT_S: Final[float] = float(os.environ.get("DOOR_WAIT_S", "20"))
DEADLINE_S: Final[float] = 15 * 60
MAX_LINES: Final[int] = 4
VISITOR_MAX_S: Final[float] = float(os.environ.get("VISITOR_MAX_S", "120"))
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
    heading: str = "unknown"
    identity: str = "unknown"
    direction: str = "unknown"
    checkin: str = "none"
    checkin_who: str = ""
    attire_night: bool = False

    def features(self) -> Features:
        return Features(self.identity, self.direction, self.checkin, self.attire_night, self.night_mode)

    def verdict(self) -> RuleVerdict:
        return wander_score(self.features())

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
    """Someone at the door. Entry from outside is a visitor or a return (any hour); otherwise the night redirect."""
    inc.identity, inc.direction, inc.checkin, inc.checkin_who = "unknown", "unknown", "none", ""
    _absorb(inc, ev)
    if inc.direction == "entry":
        if inc.identity == "other":
            return _t(inc, State.ARMED_IDLE, ("notify:home",), "R13", "household member came home")
        if inc.identity == "match":
            return _t(inc, State.ARMED_IDLE, ("notify:home",), "R13", f"{'the person we watch'} came back in")
        inc.opened_at = ev.ts
        inc.lines_spoken = 1
        inc.last_line_at = ev.ts
        inc.person_in_frame = True
        return _t(inc, State.VISITOR, ("speak:visitor_open", "notify:visitor"), "R13", "visitor at the door")
    if not inc.night_mode:
        return _ignored(inc, ev, "R0 outside night window")
    inc.opened_at = ev.ts
    inc.lines_spoken = 1
    inc.last_line_at = ev.ts
    inc.person_in_frame = ev.kind == "person_enter"
    v = inc.verdict()
    if v.action == "ignore":
        return _ignored(inc, ev, "R11 " + "; ".join(v.reasons))
    return _t(inc, State.CONVERSATION, ("speak:open",), "R0", f"ok; wander score {v.score}")


def _absorb(inc: Incident, ev: Event) -> None:
    """Copy detector facts from an event payload onto the incident (code-owned inputs to the score)."""
    p = ev.payload
    if p.get("identity") in ("match", "other", "unknown"):
        inc.identity = str(p["identity"])
    if p.get("direction") in ("exit", "entry", "unknown"):
        inc.direction = str(p["direction"])
    if p.get("checkin"):
        inc.checkin = str(p["checkin"])
        inc.checkin_who = str(p.get("who", ""))
    if "attire_night" in p:
        inc.attire_night = bool(p["attire_night"])


def _stand_down(inc: Incident, ev: Event) -> Transition:
    """A care-circle member identified themselves, or the face is a known other: no wander."""
    _absorb(inc, ev)
    v = inc.verdict()
    if v.action != "ignore" and inc.checkin != "self_other":
        return _ignored(inc, ev, f"R11 score {v.score}, staying alert")
    who = inc.checkin_who or ("another person" if inc.identity == "other" else "")
    actions: tuple[str, ...] = (
        ("cancel_escalation", "notify:stand_down") if inc.state == State.ESCALATING else ("notify:stand_down",)
    )
    return _t(inc, State.RETURNED, actions, "R11", f"stand down: {who}; " + "; ".join(v.reasons))


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


HEADINGS: Final[frozenset[str]] = frozenset({"left", "right", "away", "toward", "unknown"})


def _person_lost(inc: Incident, ev: Event) -> Transition:
    """Camera lost the person: same clock as a door opening (R2). Records which way they went."""
    inc.person_in_frame = False
    h = str(ev.payload.get("heading", "unknown")).lower()
    inc.heading = h if h in HEADINGS else "unknown"
    tr = _door_open(inc, ev)
    return Transition(
        tr.from_state, tr.to_state, tr.actions, tr.rule, "person left the frame" if tr.rule != "ignored" else tr.detail
    )


def _lost_from_idle(inc: Incident, ev: Event) -> Transition:
    """Person walked out of view before any approach was seen: speak now and start the exit clock."""
    first = _motion(inc, ev)
    if first.to_state != State.CONVERSATION:
        return first
    second = _person_lost(inc, ev)
    return Transition(
        first.from_state, second.to_state, first.actions + second.actions, "R2", "left the frame without stopping"
    )


def _person_back_door(inc: Incident, ev: Event) -> Transition:
    inc.person_in_frame = True
    inc.seen_inside = True
    return _t(inc, State.RETURNED, ("log:returned",), "R2", "person back in frame")


def _person_back_escalating(inc: Incident, ev: Event) -> Transition:
    inc.person_in_frame = True
    return _t(inc, State.RETURNED, ("cancel_escalation", "notify:returned"), "R2", "person back in frame after exit")


def _person_back_quiet(inc: Incident, ev: Event) -> Transition:
    """Back in frame after the family answered, or while only watching: tell the phones, no ladder to cancel."""
    inc.person_in_frame = True
    return _t(inc, State.RETURNED, ("notify:returned",), "R2", "person back in frame")


def _watching_features(inc: Incident, ev: Event) -> Transition:
    """Identity firmed up while watching: a match now rings; anything else keeps watching."""
    _absorb(inc, ev)
    v = inc.verdict()
    if v.action == "escalate":
        return _t(
            inc, State.ESCALATING, ("start_escalation",), "R2", f"now ringing; score {v.score}: " + "; ".join(v.reasons)
        )
    return Transition(inc.state, inc.state, (), "R11", f"watching; score {v.score}")


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
    """R11 bands at the moment they leave: ignore = not a wander, speak_only = watch without ringing, else ring."""
    inc.exited_at = ev.ts
    v = inc.verdict()
    why = "; ".join(v.reasons)
    if v.action == "ignore":
        return _t(inc, State.CLOSED, ("notify:stand_down",), "R11", f"{detail}; score {v.score}, not a wander: {why}")
    if v.action == "speak_only":
        return _t(
            inc,
            State.WATCHING,
            ("build_brief", "notify:watch_only"),
            "R11",
            f"{detail}; score {v.score}, no ring: {why}",
        )
    return _t(inc, State.ESCALATING, ("build_brief", "start_escalation"), "R2", f"{detail}; score {v.score}")


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


def _features(inc: Incident, ev: Event) -> Transition:
    """Detector update (identity, direction, attire) without a state change."""
    _absorb(inc, ev)
    v = inc.verdict()
    return Transition(inc.state, inc.state, (), "R11", f"score {v.score} ({v.action}): " + "; ".join(v.reasons))


def _sos(inc: Incident, ev: Event) -> Transition:
    """Help button on the door device: ring the family now, whatever the score says."""
    if inc.state in (State.ESCALATING, State.ACKED, State.EXHAUSTED):
        return _ignored(inc, ev, "already escalated")
    inc.opened_at = inc.opened_at or ev.ts
    inc.exited_at = ev.ts
    inc.identity = "match"
    return _t(
        inc,
        State.ESCALATING,
        ("build_brief", "start_escalation", "notify:sos"),
        "R12",
        "help button pressed at the door",
    )


def _visitor_reply(inc: Incident, ev: Event) -> Transition:
    inc.lines_spoken += 1
    inc.last_line_at = ev.ts
    return _t(inc, State.VISITOR, ("speak:visitor_reply", "notify:visitor_said"), "R13", "visitor spoke")


def _visitor_left(inc: Incident, ev: Event) -> Transition:
    inc.person_in_frame = False
    return _t(inc, State.CLOSED, ("speak:visitor_bye", "notify:visitor_left"), "R13", "visitor left")


def _visitor_tick(inc: Incident, ev: Event) -> Transition:
    if inc.opened_at is not None and (ev.ts - inc.opened_at).total_seconds() >= VISITOR_MAX_S:
        return _t(inc, State.CLOSED, ("notify:visitor_left",), "R13", "visitor timed out")
    return _ignored(inc, ev, "visitor present")


def _visitor_features(inc: Incident, ev: Event) -> Transition:
    """A face match while a 'visitor' stands outside means the person we watch is coming back in."""
    _absorb(inc, ev)
    if inc.identity in ("match", "other"):
        return _t(inc, State.CLOSED, ("notify:home",), "R13", "recognized at the door: " + inc.identity)
    return Transition(inc.state, inc.state, (), "R13", "visitor, identity " + inc.identity)


def _close(inc: Incident, ev: Event) -> Transition:
    return _t(inc, State.CLOSED, ("delete_frames",), "R10", "closed")


TRANSITIONS: Final[dict[tuple[State, str], Handler]] = {
    (State.ARMED_IDLE, "motion"): _motion,
    (State.ARMED_IDLE, "person_enter"): _motion,
    (State.ARMED_IDLE, "person_lost"): _lost_from_idle,
    (State.CONVERSATION, "tick"): _tick_conversation,
    (State.CONVERSATION, "stand_down"): _stand_down,
    (State.DOOR_OPEN, "stand_down"): _stand_down,
    (State.ESCALATING, "stand_down"): _stand_down,
    (State.CONVERSATION, "features"): _features,
    (State.CONVERSATION, "person_enter"): _features,
    (State.DOOR_OPEN, "features"): _features,
    (State.ARMED_IDLE, "features"): _features,
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
    (State.ESCALATING, "close"): _close,
    (State.ACKED, "person_back"): _person_back_quiet,
    (State.EXHAUSTED, "person_back"): _person_back_quiet,
    (State.WATCHING, "person_back"): _person_back_quiet,
    (State.WATCHING, "ack"): _ack,
    (State.WATCHING, "close"): _close,
    (State.WATCHING, "features"): _watching_features,
    (State.WATCHING, "stand_down"): _stand_down,
    (State.WATCHING, "sos"): _sos,
    (State.ESCALATING, "tick"): _tick_escalating,
    (State.EXHAUSTED, "ack"): _ack,
    (State.VISITOR, "reply"): _visitor_reply,
    (State.VISITOR, "person_lost"): _visitor_left,
    (State.VISITOR, "tick"): _visitor_tick,
    (State.VISITOR, "features"): _visitor_features,
    (State.VISITOR, "person_enter"): _visitor_features,
    (State.VISITOR, "sos"): _sos,
    (State.VISITOR, "close"): _close,
    (State.ARMED_IDLE, "sos"): _sos,
    (State.CONVERSATION, "sos"): _sos,
    (State.DOOR_OPEN, "sos"): _sos,
    (State.RETURNED, "sos"): _sos,
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
        "stand_down",
        "features",
        "sos",
    }
)


def step(inc: Incident, ev: Event) -> Transition:
    """Apply one event. Unknown (state, kind) pairs are ignored and reported as such."""
    handler = TRANSITIONS.get((inc.state, ev.kind))
    if handler is None:
        return _ignored(inc, ev, f"no transition for {inc.state.value} + {ev.kind}")
    return handler(inc, ev)
