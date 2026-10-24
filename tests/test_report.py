import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from nightfall import api, history, report
from nightfall.household import load

TZ = ZoneInfo("America/Los_Angeles")
NOW = datetime(2026, 10, 24, 9, 30, tzinfo=TZ)  # Saturday morning: "last night" is Friday night


@pytest.fixture
def hist(monkeypatch, tmp_path):
    f = tmp_path / "history.json"
    monkeypatch.setattr(history, "FILE", f)

    def write(*rows):
        f.write_text(json.dumps(list(rows)))

    write()
    return write


def _row(opened: datetime, outcome: str = "returned", minutes: float = 5.0, acked_by=None, heading="unknown"):
    return {
        "incident_id": f"INC-{opened:%d%H%M}",
        "opened_at": opened.isoformat(),
        "exited_at": opened.isoformat() if outcome in report.EXITS else None,
        "closed_at": (opened + timedelta(minutes=minutes)).isoformat(),
        "minutes_out": minutes if outcome in report.EXITS else 0,
        "outcome": outcome,
        "heading": heading,
        "acked_by": acked_by,
        "score": 60,
    }


def test_a_night_runs_six_pm_to_six_pm() -> None:
    fri = datetime(2026, 10, 23, tzinfo=TZ).date()
    assert report.night_of(datetime(2026, 10, 23, 23, 0, tzinfo=TZ)) == fri
    assert report.night_of(datetime(2026, 10, 24, 2, 10, tzinfo=TZ)) == fri
    assert report.night_of(datetime(2026, 10, 24, 17, 59, tzinfo=TZ)) == fri


def test_sample_nights_fill_in_until_the_family_has_three(hist) -> None:
    hh = load("data/household.json")
    r = report.build(hh, NOW)
    assert r["includes_sample"] and r["night_label"] == "Last night" and len(r["week"]) == 7
    assert all(e["sample"] for e in r["events"])
    real = [_row(datetime(2026, 10, d, 2, 15, tzinfo=TZ), "acked", 8, "TM-SARAH") for d in (22, 23, 24)]
    hist(*real)
    r = report.build(hh, NOW)
    assert not r["includes_sample"]
    assert r["events"][0]["answered_by"] == hh.member("TM-SARAH").name and r["events"][0]["label"] == "Family answered"
    assert r["facts"]["week"]["nights_he_left"] == 3 and r["facts"]["week"]["usual_time"] == "around 2 AM"


def test_template_reads_like_a_person(hist, monkeypatch) -> None:
    monkeypatch.setenv("REPORT_SAMPLE", "0")
    hh = load("data/household.json")
    assert "stayed in" in report.build(hh, NOW)["summary"] and "No exits" in report.build(hh, NOW)["summary"]
    hist(_row(datetime(2026, 10, 24, 1, 50, tzinfo=TZ), "watch_only"))
    assert "came to the door once" in report.build(hh, NOW)["summary"]
    hist(_row(datetime(2026, 10, 24, 1, 50, tzinfo=TZ), "returned", 6.4))
    s = report.build(hh, NOW)["summary"]
    assert "about 6 minutes" in s and "on his own" in s and "around 2 AM" in s


def test_usual_time_wraps_midnight() -> None:
    assert report._window([23.5, 0.5]) == "around 12 AM"
    assert report._window([]) == ""


def test_claude_wording_is_checked_and_falls_back(hist, monkeypatch) -> None:
    hh = load("data/household.json")
    monkeypatch.setattr(report.anthropic_llm, "enabled", lambda: True)
    monkeypatch.setattr(report, "_cache", {})
    monkeypatch.setattr(
        report.anthropic_llm, "complete", lambda *a, **k: "Try a lower medication dose tonight, he slept well."
    )
    r = report.build(hh, NOW)
    assert r["summary_source"] == "template"
    monkeypatch.setattr(
        report.anthropic_llm, "complete", lambda *a, **k: "Dad had a calm night and stayed close to home."
    )
    assert report.build(hh, NOW)["summary_source"] == "claude"


def test_endpoints(hist) -> None:
    with TestClient(api.app) as c:
        r = c.get("/report").json()
        assert r["ok"] and r["summary"] and len(r["week"]) == 7
        a = c.post("/report/listen").json()
        assert a["summary"] == r["summary"] and a["audio"]["mode"] == "browser_tts"
