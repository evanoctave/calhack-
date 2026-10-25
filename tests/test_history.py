from datetime import datetime, timedelta

import pytest

from nightfall import brief, history
from nightfall.engine import Incident
from nightfall.household import load


@pytest.fixture(autouse=True)
def tmp_history(monkeypatch, tmp_path):
    monkeypatch.setattr(history, "FILE", tmp_path / "history.json")


def test_record_and_summary() -> None:
    t0 = datetime(2026, 10, 25, 2, 0)
    history.record("INC-1", t0, t0 + timedelta(seconds=10), t0 + timedelta(minutes=6), "returned", "left", None, 80)
    history.record(
        "INC-2", t0, t0 + timedelta(seconds=10), t0 + timedelta(minutes=12), "acked", "left", "TM-PRIMARY", 60
    )
    history.record("INC-3", t0, None, t0 + timedelta(minutes=1), "stand_down", "unknown", None, 10)
    s = history.summary(history.load())
    assert s["count"] == 2 and s["typical_minutes"] == pytest.approx(8.9, abs=0.2) and s["headings"] == ["left"]
    assert s["last"][0]["incident_id"] == "INC-2"


def test_police_report_has_what_dispatch_asks() -> None:
    hh = load("data/household.json")
    inc = Incident("INC-1")
    inc.exited_at = datetime(2026, 10, 25, 2, 3)
    inc.heading = "left"
    r = brief.police_report(
        hh,
        inc,
        "navy hoodie, gray sweatpants, barefoot",
        inc.exited_at,
        {"count": 2, "typical_minutes": 9, "headings": ["left"]},
    )
    for needle in (
        "Missing and at risk",
        "Robert Miller",
        "74",
        "5 ft 10 in",
        "Alzheimer",
        "2:03 AM",
        "navy hoodie",
        "donepezil",
        "wandered 2 time",
        "Silver Alert",
        "Dr. Priya Nair",
    ):
        assert needle in r, needle
    b = brief.build(
        hh,
        inc,
        brief.mock_clothing(),
        brief.load_places("data/places.sample.json"),
        [],
        inc.exited_at,
        history={"count": 0, "last": [], "typical_minutes": 0, "headings": []},
    )
    assert "No prior wandering" in b["police_report"] and b["description"]["hair"] and b["doctor"]["name"]
