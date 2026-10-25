"""Place provenance is based on every row, independent of API keys or row order."""

from datetime import datetime, time

import pytest

from nightfall import brief
from nightfall.engine import Incident
from nightfall.household import Household
from nightfall.store import Store


@pytest.mark.parametrize(
    ("sources", "expected"),
    [
        ([], "none"),
        (["overpass"], "overpass"),
        (["apify"], "apify"),
        (["overpass", "apify"], "apify"),
        (["overpass", "apify", "fixture"], "fixture"),
        (["apify", None], "fixture"),
        (["overpass", "mock"], "mock"),
        (["apify", "unverified"], "unknown"),
    ],
)
def test_store_and_brief_agree_on_all_place_sources(sources, expected, monkeypatch) -> None:
    # A configured token must not turn fixture/unknown rows into verified live data.
    monkeypatch.setenv("APIFY_TOKEN", "unused-test-token")
    hh = Household(
        id="TEST",
        person_name="Dad",
        person_photo="",
        caregiver_name="Sarah",
        night_start=time(21),
        night_end=time(6),
        home_lat=37.8,
        home_lng=-122.44,
        radius_mi=1.5,
        meds_opt_in=False,
        tree=(),
    )
    rows = [
        {
            "category": "water" if source == "overpass" else "fuel",
            "name": f"Place {i}",
            "lat": hh.home_lat,
            "lng": hh.home_lng,
            **({"source": source} if source is not None else {}),
        }
        for i, source in enumerate(sources)
    ]
    # Avoid Store initialization: this assertion needs only its source-summary method.
    store = object.__new__(Store)
    for ordered in (rows, list(reversed(rows))):
        store.places = ordered
        assert store.places_source() == expected
        result = brief.build(hh, Incident("TEST"), brief.mock_clothing(), ordered, [], datetime(2026, 10, 25, 2))
        assert result["places_source"] == expected
