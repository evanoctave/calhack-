"""scripts/run_actor.py: .env loading, live fetch, and each fallback. All I/O is faked and redirected to tmp_path."""

import importlib.util
import json
import os
import shutil
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
FIXTURE = [
    {
        "category": "water",
        "name": "Fixture Pond",
        "lat": 37.80,
        "lng": -122.44,
        "distance_mi": 0.1,
        "source": "fixture",
    },
    {"category": "fuel", "name": "Fixture Fuel", "lat": 37.80, "lng": -122.44, "distance_mi": 0.1, "source": "fixture"},
]
STREAM = {
    "type": "way",
    "center": {"lat": 37.801, "lon": -122.441},
    "tags": {"waterway": "stream", "name": "Test Creek"},
}
CHEVRON = {
    "title": "Test Chevron",
    "categoryName": "Gas station",
    "location": {"lat": 37.801, "lng": -122.441},
    "phone": "(415) 555-0100",
    "openingHours": [{"day": "Sunday", "hours": "Open 24 hours"}, {"day": "Monday", "hours": "Closed"}],
}


@pytest.fixture
def ra(tmp_path, monkeypatch):
    """run_actor loaded with ROOT pointing at a scratch copy of data/, and an isolated environment."""
    spec = importlib.util.spec_from_file_location("run_actor", REPO / "scripts" / "run_actor.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    (tmp_path / "data").mkdir()
    shutil.copy(REPO / "data" / "household.json", tmp_path / "data" / "household.json")
    (tmp_path / "data" / "places.marina.json").write_text(json.dumps(FIXTURE))
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    monkeypatch.setattr(os, "environ", {})
    monkeypatch.setattr("sys.argv", ["run_actor.py"])
    return mod


def _out(ra) -> list[dict]:
    return json.loads((ra.ROOT / "data" / "places.marina.live.json").read_text())


def test_load_env_reads_keys_skips_comments_and_keeps_existing(ra, tmp_path) -> None:
    env = tmp_path / ".env"
    env.write_text("# a comment\nAPIFY_TOKEN=abc123\nVOICE=  # inline comment\nKEEP=from_file\n\nnot a pair\n")
    os.environ["KEEP"] = "from_shell"
    ra.load_env(env)
    assert os.environ["APIFY_TOKEN"] == "abc123"
    assert os.environ["VOICE"] == ""
    assert os.environ["KEEP"] == "from_shell"
    assert "not a pair" not in os.environ


def test_load_env_missing_file_is_a_noop(ra, tmp_path) -> None:
    before = dict(os.environ)
    ra.load_env(tmp_path / "nope.env")
    assert os.environ == before


def test_live_run_writes_google_places_and_overpass_hazards(ra, monkeypatch) -> None:
    os.environ["APIFY_TOKEN"] = "t"
    seen = {}
    monkeypatch.setattr(ra.overpass, "hazards", lambda *a: [STREAM])
    monkeypatch.setattr(ra.apify, "google_places", lambda *a, **k: seen.setdefault("called", True) and [CHEVRON])
    assert ra.main() == 0
    rows = _out(ra)
    assert seen["called"]
    assert sorted(r["name"] for r in rows) == ["Test Chevron", "Test Creek"]
    assert {r["name"]: r["source"] for r in rows} == {"Test Chevron": "apify", "Test Creek": "overpass"}


def test_day_flag_reaches_the_hours_parser(ra, monkeypatch) -> None:
    os.environ["APIFY_TOKEN"] = "t"
    monkeypatch.setattr("sys.argv", ["run_actor.py", "--day", "Monday"])
    monkeypatch.setattr(ra.overpass, "hazards", lambda *a: [STREAM])
    monkeypatch.setattr(ra.apify, "google_places", lambda *a, **k: [CHEVRON])  # open Sunday, closed Monday
    ra.main()
    assert next(r for r in _out(ra) if r["name"] == "Test Chevron")["hours"] == ""


def test_overpass_failure_falls_back_to_fixture_hazards(ra, monkeypatch) -> None:
    os.environ["APIFY_TOKEN"] = "t"

    def boom(*a):
        raise RuntimeError("overpass down")

    monkeypatch.setattr(ra.overpass, "hazards", boom)
    monkeypatch.setattr(ra.apify, "google_places", lambda *a, **k: [CHEVRON])
    ra.main()
    names = sorted(r["name"] for r in _out(ra))
    assert names == ["Fixture Pond", "Test Chevron"]  # mock hazard in, real places kept


def test_apify_failure_falls_back_to_fixture_places_but_keeps_hazards(ra, monkeypatch) -> None:
    os.environ["APIFY_TOKEN"] = "t"

    def boom(*a, **k):
        raise RuntimeError("apify down")

    monkeypatch.setattr(ra.overpass, "hazards", lambda *a: [STREAM])
    monkeypatch.setattr(ra.apify, "google_places", boom)
    ra.main()
    assert sorted(r["name"] for r in _out(ra)) == ["Fixture Fuel", "Test Creek"]


def test_no_token_never_calls_apify(ra, monkeypatch) -> None:
    def must_not_run(*a, **k):
        raise AssertionError("apify called without a token")

    monkeypatch.setattr(ra.overpass, "hazards", lambda *a: [STREAM])
    monkeypatch.setattr(ra.apify, "google_places", must_not_run)
    ra.main()
    assert sorted(r["name"] for r in _out(ra)) == ["Fixture Fuel", "Test Creek"]


def test_no_google_flag_skips_apify_even_with_a_token(ra, monkeypatch) -> None:
    os.environ["APIFY_TOKEN"] = "t"
    monkeypatch.setattr("sys.argv", ["run_actor.py", "--no-google"])
    monkeypatch.setattr(ra.overpass, "hazards", lambda *a: [STREAM])
    monkeypatch.setattr(ra.apify, "google_places", lambda *a, **k: pytest.fail("apify called"))
    ra.main()
    assert "Test Chevron" not in {r["name"] for r in _out(ra)}
