"""Help-button incidents must not become invented exits or wandering history."""

from datetime import datetime, timedelta

import pytest

from nightfall import brief, call_agent, engine, history
from nightfall.household import load

NOW = datetime(2026, 10, 25, 2, 3)
HH = load("data/household.json")


def make_help():
    incident = engine.Incident("INC-HELP")
    transition = engine.step(incident, engine.Event("sos", NOW))
    data = brief.build(HH, incident, brief.mock_clothing(), [], [], NOW)
    return incident, transition, data


def test_help_keeps_escalation_clock_without_asserting_identity_or_exit():
    incident, transition, data = make_help()
    assert incident.cause == data["cause"] == "help"
    assert transition.to_state == engine.State.ESCALATING
    assert "start_escalation" in transition.actions
    assert incident.exited_at == NOW  # Internal compatibility clock, not exit evidence.
    assert incident.deadline_at == NOW + timedelta(minutes=15)
    assert incident.identity == "unknown"
    later = engine.step(incident, engine.Event("tick", NOW + timedelta(minutes=15)))
    assert later.detail == "15 minutes since help request"


def test_help_brief_and_police_script_do_not_invent_a_missing_person():
    _, _, data = make_help()
    for text in (data["prose"], data["police_report"]):
        assert "2:03 AM" in text
        assert "left home" not in text
        assert "Missing and at risk" not in text
        assert "On foot" not in text
        assert "Silver Alert" not in text
    assert "Help" in data["prose"]
    assert "Robert Miller" in data["police_report"]
    assert "current location have not been confirmed" in data["police_report"]
    assert "left home" not in brief.prose(HH, "2:03 AM", "see photo", cause="help")


def test_default_door_brief_preserves_existing_exit_contract():
    incident = engine.Incident("INC-DOOR", exited_at=NOW)
    data = brief.build(HH, incident, brief.mock_clothing(), [], [], NOW)
    assert data["cause"] == "door"
    assert "left home at 2:03 AM" in data["prose"]
    assert "Missing and at risk" in data["police_report"]


def test_help_call_opening_and_model_facts_use_request_time():
    _, _, data = make_help()
    opening = call_agent.opening(HH, data, "Sarah")
    facts = call_agent.facts(HH, data)
    assert "Help was requested at the door at 2:03 AM" in opening
    assert "left the house" not in opening
    assert "Most people are found" not in opening
    assert "Left home" not in facts
    assert "15 minutes of searching" not in facts
    assert "No confirmed exit or search-start time" in facts


@pytest.mark.parametrize(
    ("question", "intent", "expected"),
    [
        ("When did he leave?", "time", "request time, not a confirmed exit time"),
        ("Where should I look?", "help_location", "Start with the door camera"),
        ("Is Dad missing?", "help_location", "does not confirm an exit"),
        ("Should I call 911?", "emergency", "Nightfall never calls on its own"),
        ("Who can I call?", "calls", "care circle"),
    ],
)
def test_help_answers_are_specific_without_providers(monkeypatch, question, intent, expected):
    monkeypatch.setattr(call_agent.anthropic_llm, "enabled", lambda: False)
    _, _, data = make_help()
    reply = call_agent.handle(HH, data, "Sarah", question)
    assert reply.intent == intent
    assert expected in reply.say
    assert not reply.ack


def test_help_acknowledgement_does_not_claim_safety_and_keeps_followup_open():
    _, _, data = make_help()
    responding = call_agent.handle(HH, data, "Sarah", "I'm on my way. Where should I look?")
    assert responding.ack and not responding.done
    assert "door camera" in responding.say
    assert "hazards first" not in responding.say
    acknowledged = call_agent.handle(HH, data, "Sarah", "all set")
    assert acknowledged.ack and acknowledged.done
    assert "is safe" not in acknowledged.say


def test_open_ended_help_qa_receives_help_context(monkeypatch):
    seen = {}

    def answer(system, _question, **_kwargs):
        seen["system"] = system
        return "Open the door camera to check in."

    monkeypatch.setattr(call_agent.anthropic_llm, "enabled", lambda: True)
    monkeypatch.setattr(call_agent.anthropic_llm, "complete", answer)
    _, _, data = make_help()
    result = call_agent.handle(HH, data, "Sarah", "Can you explain the situation?")
    assert result.intent == "qa"
    assert "Help requested at the door" in seen["system"]
    assert "just left home at night" not in seen["system"]


def test_help_and_legacy_sos_history_do_not_count_as_prior_wandering(monkeypatch, tmp_path):
    monkeypatch.setattr(history, "FILE", tmp_path / "history.json")
    history.record("INC-DOOR", NOW, NOW, NOW + timedelta(minutes=5), "returned", "left", None, 4)
    for outcome in ("returned", "acked", "exhausted"):
        row = history.record(
            f"HELP-{outcome}", NOW, NOW, NOW + timedelta(minutes=20), outcome, "right", None, 0, cause="help"
        )
        assert row["cause"] == "help" and row["minutes_out"] == 0
    rows = history.load() + [{"outcome": "sos", "exited_at": NOW.isoformat(), "minutes_out": 50}]
    summary = history.summary(rows)
    assert summary["count"] == 1
    assert summary["typical_minutes"] == 5
    assert summary["headings"] == ["left"]
    assert summary["last"][0]["incident_id"] == "INC-DOOR"
