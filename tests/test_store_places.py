"""Store picks its places file: PLACES_FILE, else the sample live file, else the fixture."""

import json
import os
import shutil
from pathlib import Path

import pytest

from nightfall import store

REPO = Path(__file__).resolve().parent.parent


def _place(name: str) -> list[dict]:
    return [{"category": "fuel", "name": name, "lat": 37.80, "lng": -122.44, "distance_mi": 0.1, "source": "fixture"}]


@pytest.fixture
def root(tmp_path, monkeypatch):
    (tmp_path / "data").mkdir()
    shutil.copy(REPO / "data" / "household.json", tmp_path / "data" / "household.json")
    (tmp_path / "data" / "places.sample.json").write_text(json.dumps(_place("Fixture")))
    monkeypatch.setattr(store, "ROOT", tmp_path)
    monkeypatch.delenv("PLACES_FILE", raising=False)
    return tmp_path


def test_fixture_used_when_no_live_file(root) -> None:
    assert [p["name"] for p in store.Store().places] == ["Fixture"]


def test_live_file_wins_over_fixture(root) -> None:
    (root / "data" / "places.sample.live.json").write_text(json.dumps(_place("Live")))
    assert [p["name"] for p in store.Store().places] == ["Live"]


def test_places_file_env_wins_over_live(root, monkeypatch) -> None:
    (root / "data" / "places.sample.live.json").write_text(json.dumps(_place("Live")))
    custom = root / "custom.json"
    custom.write_text(json.dumps(_place("Custom")))
    monkeypatch.setitem(os.environ, "PLACES_FILE", str(custom))
    assert [p["name"] for p in store.Store().places] == ["Custom"]


def test_committed_live_file_is_what_the_app_ships_with(monkeypatch) -> None:
    monkeypatch.delenv("PLACES_FILE", raising=False)  # conftest pins the fixture for every other test
    monkeypatch.setattr(store, "ROOT", REPO)
    if (REPO / "data" / "places.custom.live.json").exists():
        pytest.skip("a setup-page cache on this machine takes precedence over the committed sample file")
    s = store.Store()
    assert len(s.places) > 20 and {p["source"] for p in s.places} == {"apify"}


def test_first_launch_creates_blank_live_household(root, monkeypatch) -> None:
    monkeypatch.setenv("FRESH_START", "1")
    shutil.copy(REPO / "data" / "household.blank.json", root / "data" / "household.blank.json")
    live = root / "data" / "household.live.json"
    tracked = root / "data" / "household.json"
    tracked_before = tracked.read_bytes()
    s = store.Store()
    assert s.hh.person_name == "" and s.hh.person_full_name == ""
    assert json.loads(live.read_text())["person_name"] == ""
    assert s.places == []
    assert tracked.read_bytes() == tracked_before


def test_restart_preserves_saved_profile_and_call_recipients(root, monkeypatch) -> None:
    from dataclasses import replace

    from nightfall import api_app
    from nightfall.household import TreeMember

    monkeypatch.setenv("FRESH_START", "1")
    monkeypatch.setenv("PHONE_TM_PRIMARY", "+14155550123")
    monkeypatch.setattr(api_app, "ROOT", root)
    shutil.copy(REPO / "data" / "household.blank.json", root / "data" / "household.blank.json")
    first = store.Store()
    saved = replace(
        first.hh,
        person_name="Robert",
        person_full_name="Robert Example",
        caregiver_name="Sam",
        tree=(
            TreeMember("TM-PRIMARY", "Sam", "+14155550123", 1),
            TreeMember("TM-INVITED", "Alex", "+14155550124", 2),
        ),
    )
    api_app._persist_household(saved)
    live = root / "data" / "household.live.json"
    before = live.read_bytes()

    restarted = store.Store()

    assert restarted.hh == saved
    assert restarted.hh.members_at(1)[0].phone == "+14155550123"
    assert restarted.hh.members_at(2)[0].phone == "+14155550124"
    assert live.read_bytes() == before
    # Environment-managed numbers stay out of the saved profile.
    assert json.loads(before)["tree"][0]["phone"] == "web"


def test_fresh_start_off_uses_the_tracked_demo(root, monkeypatch) -> None:
    monkeypatch.setenv("FRESH_START", "0")
    assert store.Store().hh.person_name == "Dad"
    assert not (root / "data" / "household.live.json").exists()
