from nightfall import places

HOME = (33.8704, -117.9242)


def test_hours_spec() -> None:
    oh = [
        {"day": "Monday", "hours": "Open 24 hours"},
        {"day": "Tuesday", "hours": "7 AM to 10:30 PM"},
        {"day": "Wednesday", "hours": "Closed"},
    ]
    assert places.hours_spec(oh, "Monday") == "24/7"
    assert places.hours_spec(oh, "Tuesday") == "07:00-22:30"
    assert places.hours_spec(oh, "Wednesday") == ""
    assert places.hours_spec(None) == ""


def test_from_google_filters_and_maps() -> None:
    items = [
        {
            "title": "Chevron",
            "categoryName": "Gas station",
            "location": {"lat": 33.874, "lng": -117.927},
            "phone": "+1 714",
            "openingHours": [{"day": "Monday", "hours": "Open 24 hours"}],
        },
        {
            "title": "Ad",
            "categoryName": "Gas station",
            "location": {"lat": 33.874, "lng": -117.927},
            "isAdvertisement": True,
        },
        {
            "title": "Closed",
            "categoryName": "Diner",
            "location": {"lat": 33.874, "lng": -117.927},
            "permanentlyClosed": True,
        },
        {"title": "No coords", "categoryName": "Diner"},
        {"title": "St Jude ER", "categoryName": "Emergency room", "location": {"lat": 33.886, "lng": -117.912}},
    ]
    out = places.from_google(items, HOME)
    assert [p["category"] for p in out] == ["fuel", "hospital"]
    assert out[0]["hours"] == "24/7" and out[0]["source"] == "apify"


def test_from_overpass_dedupes() -> None:
    els = [
        {
            "type": "way",
            "center": {"lat": 33.876, "lon": -117.925},
            "tags": {"waterway": "stream", "name": "Brea Creek"},
        },
        {
            "type": "way",
            "center": {"lat": 33.8761, "lon": -117.9251},
            "tags": {"waterway": "stream", "name": "Brea Creek"},
        },
        {
            "type": "way",
            "center": {"lat": 33.851, "lon": -117.914},
            "tags": {"railway": "rail", "name": "Metrolink Orange Subdivision"},
        },
        {"type": "way", "center": {"lat": 33.853, "lon": -117.927}, "tags": {"highway": "motorway_link"}},
        {"type": "way", "center": {"lat": 33.853, "lon": -117.927}, "tags": {"building": "yes"}},
    ]
    out = places.from_overpass(els, HOME)
    assert sorted(p["category"] for p in out) == ["motorway", "rail", "water"]
    assert out[0]["name"] == "Brea Creek"
