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


def test_hours_spec_split_and_bare_meridiem() -> None:
    nbsp = " "  # Google puts a narrow no-break space before AM/PM
    oh = [
        {"day": "Monday", "hours": f"10{nbsp}AM to 1:30{nbsp}PM, 2 to 7{nbsp}PM"},
        {"day": "Tuesday", "hours": f"12 to 8:30{nbsp}PM"},
        {"day": "Wednesday", "hours": f"6:30{nbsp}PM to 3{nbsp}AM"},
        {"day": "Thursday", "hours": f"9 to 5{nbsp}PM"},
    ]
    assert places.hours_spec(oh, "Monday") == "10:00-19:00"
    assert places.hours_spec(oh, "Tuesday") == "12:00-20:30"
    assert places.hours_spec(oh, "Wednesday") == "18:30-03:00"
    assert places.hours_spec(oh, "Thursday") == "09:00-17:00"


def test_from_google_skips_uncategorised_and_keeps_same_name_apart() -> None:
    def row(title: str, cat: str, lat: float) -> dict:
        return {"title": title, "categoryName": cat, "location": {"lat": lat, "lng": -117.927}}

    out = places.from_google(
        [
            row("Muni", "Public transport authority", 33.874),
            row("Business centre", "Business center", 33.874),
            row("Shell", "Gas station", 33.874),
            row("Shell", "Gas station", 33.884),
            row("Shell", "Gas station", 33.874),
        ],
        HOME,
    )
    assert [p["category"] for p in out] == ["fuel", "fuel"]


def test_from_google_picks_requested_day() -> None:
    item = {
        "title": "Corner Market",
        "categoryName": "Convenience store",
        "location": {"lat": 33.874, "lng": -117.927},
        "openingHours": [{"day": "Saturday", "hours": "Closed"}, {"day": "Sunday", "hours": "Open 24 hours"}],
    }
    assert places.from_google([item], HOME, "Sunday")[0]["hours"] == "24/7"
    assert places.from_google([item], HOME, "Saturday")[0]["hours"] == ""


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


def test_from_overpass_labels_and_skips_non_channels() -> None:
    els = [
        {"type": "way", "center": {"lat": 33.876, "lon": -117.925}, "tags": {"waterway": "stream"}},
        {"type": "way", "center": {"lat": 33.8, "lon": -117.9}, "tags": {"waterway": "fuel"}},
        {"type": "relation", "center": {"lat": 33.88, "lon": -117.92}, "tags": {"natural": "water", "name": "Lagoon"}},
    ]
    out = places.from_overpass(els, HOME)
    assert sorted(p["name"] for p in out) == ["Lagoon", "Stream"]


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
