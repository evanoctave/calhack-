from datetime import datetime, timedelta

from nightfall import engine
from nightfall.engine import Event, Incident, State, step
from nightfall.rules import Features, attire_is_night, parse_checkin, wander_score

T0 = datetime(2026, 10, 25, 2, 0)
NAMES = ["Sarah", "Mike", "Linda (neighbor)"]


def at(s: float) -> datetime:
    return T0 + timedelta(seconds=s)


def test_parse_checkin() -> None:
    assert parse_checkin("It's Mike, just getting some air", NAMES, "Dad") == ("self_other", "Mike")
    assert parse_checkin("this is Sarah, taking the trash out", NAMES, "Dad")[0] == "self_other"
    assert parse_checkin("I'm Dad", NAMES, "Dad")[0] == "confused"
    assert parse_checkin("need some air", NAMES, "Dad") == ("air", "")
    assert parse_checkin("I have to get to work, they are waiting", NAMES, "Dad")[0] == "confused"
    assert parse_checkin("", NAMES, "Dad") == ("silence", "")
    assert parse_checkin("It's Robert", NAMES, "Dad")[0] == "confused", (
        "a name outside the care circle does not stand down"
    )


def test_wander_score_cases() -> None:
    assert wander_score(Features()).action == "escalate", "unknown everything rings"
    assert wander_score(Features(direction="entry")).action == "ignore"
    assert wander_score(Features(identity="other")).action == "ignore"
    assert wander_score(Features(identity="other", attire_night=True)).action == "speak_only"
    assert wander_score(Features(checkin="self_other")).action == "ignore"
    assert wander_score(Features(identity="unknown", checkin="air")).action == "speak_only"
    v = wander_score(Features(identity="match", checkin="confused", attire_night=True))
    assert v.score == 100 and v.action == "escalate" and len(v.reasons) == 4


def test_attire() -> None:
    assert attire_is_night({"top_type": "hoodie", "bottom_type": "sweatpants", "footwear": "barefoot"})
    assert not attire_is_night({"top_type": "jacket", "bottom_type": "jeans", "footwear": "sneakers"})


def test_arrival_is_a_visitor_or_a_homecoming() -> None:
    inc = Incident("INC-1")
    tr = step(inc, Event("person_enter", at(0), {"direction": "entry"}))
    assert inc.state == State.VISITOR and "speak:visitor_open" in tr.actions and "notify:visitor" in tr.actions
    step(inc, Event("reply", at(5), {"text": "Hi, it's the neighbor, just dropping off mail"}))
    assert inc.state == State.VISITOR
    tr = step(inc, Event("person_lost", at(20)))
    assert inc.state == State.CLOSED and "notify:visitor_left" in tr.actions
    home = Incident("INC-2")
    tr = step(home, Event("person_enter", at(0), {"direction": "entry", "identity": "other"}))
    assert home.state == State.ARMED_IDLE and "notify:home" in tr.actions
    day = Incident("INC-3", night_mode=False)
    step(day, Event("person_enter", at(0), {"direction": "entry"}))
    assert day.state == State.VISITOR, "doorbell works in daytime"


def test_checkin_stands_down_before_and_after_exit() -> None:
    inc = Incident("INC-1")
    step(inc, Event("person_enter", at(0)))
    tr = step(inc, Event("stand_down", at(4), {"checkin": "self_other", "who": "Mike"}))
    assert inc.state == State.RETURNED and "Mike" in tr.detail and "notify:stand_down" in tr.actions
    inc2 = Incident("INC-2")
    step(inc2, Event("person_enter", at(0)))
    step(inc2, Event("person_lost", at(3)))
    step(inc2, Event("tick", at(3 + engine.DOOR_WAIT_S)))
    assert inc2.state == State.ESCALATING
    tr = step(inc2, Event("stand_down", at(40), {"checkin": "self_other", "who": "Sarah"}))
    assert inc2.state == State.RETURNED and "cancel_escalation" in tr.actions


def test_other_person_leaving_speaks_only() -> None:
    inc = Incident("INC-1")
    step(inc, Event("person_enter", at(0), {"identity": "unknown"}))
    step(inc, Event("features", at(1), {"identity": "other", "attire_night": True}))
    step(inc, Event("person_lost", at(3)))
    tr = step(inc, Event("tick", at(3 + engine.DOOR_WAIT_S)))
    assert inc.state == State.WATCHING and "notify:watch_only" in tr.actions and "start_escalation" not in tr.actions
    step(inc, Event("features", at(10), {"identity": "match"}))
    assert inc.state == State.ESCALATING, "identity firming up to the monitored person starts the ladder"


def test_known_other_leaving_is_not_a_wander() -> None:
    inc = Incident("INC-1")
    step(inc, Event("person_enter", at(0)))
    step(inc, Event("features", at(1), {"identity": "other"}))
    step(inc, Event("person_lost", at(3), {"direction": "exit"}))
    tr = step(inc, Event("tick", at(3 + engine.DOOR_WAIT_S)))
    assert inc.state == State.CLOSED and "notify:stand_down" in tr.actions and "start_escalation" not in tr.actions


def test_homecoming_never_rings() -> None:
    inc = Incident("INC-1")
    tr = step(inc, Event("person_lost", at(0), {"direction": "entry", "identity": "match"}))
    assert (
        inc.state == State.ARMED_IDLE
        and "start_escalation" not in tr.actions
        and "capture_exit_frames" not in tr.actions
    )


def test_person_back_after_ack() -> None:
    inc = Incident("INC-1")
    step(inc, Event("person_enter", at(0)))
    step(inc, Event("person_lost", at(3)))
    step(inc, Event("tick", at(3 + engine.DOOR_WAIT_S)))
    step(inc, Event("ack", at(30), {"member_id": "TM-SARAH"}))
    tr = step(inc, Event("person_back", at(60)))
    assert inc.state == State.RETURNED and "notify:returned" in tr.actions


def test_checkin_is_case_insensitive() -> None:
    assert parse_checkin("it's mike", NAMES, "Dad") == ("self_other", "mike")
    assert parse_checkin("It's Mike", NAMES, "Dad")[0] == "self_other"


def test_unknown_identity_still_rings() -> None:
    inc = Incident("INC-1")
    step(inc, Event("person_enter", at(0)))
    step(inc, Event("person_lost", at(3)))
    tr = step(inc, Event("tick", at(3 + engine.DOOR_WAIT_S)))
    assert "start_escalation" in tr.actions
