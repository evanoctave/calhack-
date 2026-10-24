"""Store picks its places file: PLACES_FILE, else the live Marina file, else the fixture."""

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
    (tmp_path / "data" / "places.marina.json").write_text(json.dumps(_place("Fixture")))
    monkeypatch.setattr(store, "ROOT", tmp_path)
    monkeypatch.delenv("PLACES_FILE", raising=False)
    return tmp_path


def test_fixture_used_when_no_live_file(root) -> None:
    assert [p["name"] for p in store.Store().places] == ["Fixture"]


def test_live_file_wins_over_fixture(root) -> None:
    (root / "data" / "places.marina.live.json").write_text(json.dumps(_place("Live")))
    assert [p["name"] for p in store.Store().places] == ["Live"]


def test_places_file_env_wins_over_live(root, monkeypatch) -> None:
    (root / "data" / "places.marina.live.json").write_text(json.dumps(_place("Live")))
    custom = root / "custom.json"
    custom.write_text(json.dumps(_place("Custom")))
    monkeypatch.setitem(os.environ, "PLACES_FILE", str(custom))
    assert [p["name"] for p in store.Store().places] == ["Custom"]


def test_committed_live_file_is_what_the_app_ships_with() -> None:
    s = store.Store()
    assert len(s.places) > 20 and {p["source"] for p in s.places} == {"apify"}
