"""ExitEvent is the contract three other lanes build against. Shape drift must fail here."""
from __future__ import annotations

from dataclasses import fields
from datetime import datetime
from pathlib import Path

import pytest

from nightfall import exit_event, vision
from nightfall.engine import Incident
from nightfall.exit_event import ExitEvent
from nightfall.household import load

FIXTURE = Path("data/fixtures/exit_event.json")
T0 = datetime.fromisoformat("2026-10-25T02:03:17-07:00")


@pytest.fixture
def hh():
    return load("data/household.json")


@pytest.fixture
def inc():
    i = Incident(id="INC-test")
    i.exited_at = T0
    return i


def test_fixture_exists_and_round_trips() -> None:
    ev = exit_event.load_fixture(FIXTURE)
    assert ev.incident_id == "INC-demo001"
    assert ExitEvent.from_dict(ev.to_dict()) == ev


def test_fixture_covers_every_field() -> None:
    """A new field without a fixture update breaks the other lanes silently. Fail here instead."""
    import json

    raw = json.loads(FIXTURE.read_text())
    assert set(raw) == {f.name for f in fields(ExitEvent)}


def test_position_comes_from_household_not_a_literal(hh, inc) -> None:
    ev = exit_event.build(inc, hh, vision.fixture(), T0)
    assert (ev.lat, ev.lng) == (hh.home_lat, hh.home_lng)


def test_occurred_at_uses_exit_time_not_now(hh, inc) -> None:
    later = datetime.fromisoformat("2026-10-25T09:00:00-07:00")
    assert exit_event.build(inc, hh, vision.fixture(), later).occurred_at == T0.isoformat()


def test_falls_back_to_now_when_exit_time_missing(hh) -> None:
    ev = exit_event.build(Incident(id="INC-x"), hh, vision.fixture(), T0)
    assert ev.occurred_at == T0.isoformat()


def test_clothing_carries_both_shapes(hh, inc) -> None:
    ev = exit_event.build(inc, hh, vision.fixture(), T0)
    assert ev.clothing["top_type"] == "hoodie"
    assert ev.clothing_full["eyewear"] == "glasses"
    assert ev.clothing_line == "navy hoodie, gray sweatpants, barefoot"
    assert ev.clothing_source == "mock"


def test_low_confidence_renders_see_photo(hh, inc) -> None:
    quiet = vision.ClothingReport(brief={**vision.fixture().brief, "confidence": 0.2})
    assert exit_event.build(inc, hh, quiet, T0).clothing_line == "see photo"


@pytest.mark.parametrize("bad", ["sideways", "NORTHISH", "", None, 7])
def test_bad_direction_becomes_unknown(hh, inc, bad: object) -> None:
    assert exit_event.build(inc, hh, vision.fixture(), T0, direction=bad).direction == "unknown"


def test_enums_are_accepted_and_normalised(hh, inc) -> None:
    ev = exit_event.build(inc, hh, vision.fixture(), T0, direction="NorthEast",
                          exit_side=" Right ", detector="simulated")
    assert (ev.direction, ev.exit_side, ev.detector) == ("northeast", "right", "simulated")


def test_simulated_exit_is_distinguishable_from_real(hh, inc) -> None:
    """Simulate must take the identical path, but the log has to say which fired."""
    real = exit_event.build(inc, hh, vision.fixture(), T0, detector="motion")
    fake = exit_event.build(inc, hh, vision.fixture(), T0, detector="simulated")
    assert real.detector != fake.detector
    assert real.to_dict() | {"detector": "simulated"} == fake.to_dict()


def test_from_dict_drops_unknown_keys() -> None:
    raw = exit_event.load_fixture(FIXTURE).to_dict() | {"injected": "nope"}
    assert not hasattr(ExitEvent.from_dict(raw), "injected")


def test_event_is_immutable() -> None:
    ev = exit_event.load_fixture(FIXTURE)
    with pytest.raises(Exception):
        ev.incident_id = "INC-other"  # type: ignore[misc]
