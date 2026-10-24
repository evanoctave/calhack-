from datetime import datetime, timedelta

import pytest

from nightfall import brief
from nightfall.engine import Incident
from nightfall.household import load
from nightfall.search import is_open, parse_hours

NOW = datetime(2026, 10, 25, 2, 3)


def test_token_roundtrip_tamper_expiry() -> None:
    t = brief.mint("INC-1", "TM-SARAH", NOW)
    assert brief.verify(t, NOW) == ("INC-1", "TM-SARAH")
    with pytest.raises(brief.BriefError) as e:
        brief.verify(t[:-1] + ("a" if t[-1] != "a" else "b"), NOW)
    assert e.value.status == 404
    with pytest.raises(brief.BriefError) as e2:
        brief.verify(t, NOW + timedelta(hours=24, seconds=1))
    assert e2.value.status == 410


def test_clothing_enum_coercion() -> None:
    c = brief.coerce_clothing({"top_color": "teal", "footwear": "flip", "confidence": "0.9"})
    assert c["top_color"] == "unknown" and c["footwear"] == "unknown"
    assert brief.clothing_line(brief.coerce_clothing({"confidence": 0.2})) == "see photo"
    assert brief.clothing_line(brief.mock_clothing()) == "navy hoodie, gray sweatpants, barefoot"


def test_build_sections_and_meds() -> None:
    hh = load("data/household.json")
    places = brief.load_places("data/places.fullerton.json")
    inc = Incident("INC-1")
    inc.exited_at = NOW
    b = brief.build(hh, inc, brief.mock_clothing(), places, [], NOW)
    assert len(b["hazards"]) == 4 and b["hazards"][0]["name"].startswith("Brea Creek")
    assert b["call_first"][0]["name"].startswith("Chevron")
    names = [p["name"] for p in b["call_first"]]
    assert names.index("CVS, Chapman Ave") > names.index("Denny's, Orangethorpe")
    assert not any("(far)" in p["name"] for p in b["hazards"] + b["call_first"])
    assert len(b["medications"]) == 3
    from dataclasses import replace

    b2 = brief.build(replace(hh, meds_opt_in=False), inc, brief.mock_clothing(), places, [], NOW)
    assert b2["medications"] == []


def test_hours_wrap() -> None:
    h = parse_hours("22:00-06:00")
    assert is_open(h, NOW) is True and is_open(h, NOW.replace(hour=14)) is False
    assert is_open(parse_hours(""), NOW) is None
