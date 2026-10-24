"""Step 4: the brief ships instantly with the fixture, then the real description replaces it."""
from __future__ import annotations

import asyncio
import io
from datetime import datetime

import pytest

from nightfall import actions, vision
from nightfall.engine import Incident
from nightfall.store import Store

REAL = vision.ClothingReport(
    brief={"top_color": "red", "top_type": "jacket", "bottom_color": "black",
           "bottom_type": "jeans", "footwear": "slippers", "confidence": 0.8, "source": "anthropic"},
    full={"headwear": "beanie"},
)


def _jpeg(shade: int) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (shade, shade, shade)).save(buf, format="JPEG")
    return buf.getvalue()


@pytest.fixture
def store() -> Store:
    s = Store()
    inc = Incident(id="INC-live")
    inc.exited_at = datetime(2026, 10, 25, 2, 3, 17)
    s.inc = inc
    s.briefs["INC-live"] = {"clothing": vision.fixture().brief, "clothing_line": "navy hoodie, gray sweatpants, barefoot"}
    s.frames["INC-live"] = ["data:image/jpeg;base64," + __import__("base64").b64encode(_jpeg(200)).decode()]
    return s


async def _settle(store: Store) -> None:
    for task in list(store.vision_tasks.values()):
        await task


async def test_brief_is_usable_before_the_call_returns(store, monkeypatch) -> None:
    """The phones already have the brief; the description only replaces a field."""
    started = asyncio.Event()

    def slow(_f: object) -> vision.ClothingReport:
        started.set()
        return REAL

    monkeypatch.setattr(vision, "describe_clothing", slow)
    actions.schedule_description(store, "INC-live")
    assert store.briefs["INC-live"]["clothing_line"] == "navy hoodie, gray sweatpants, barefoot"
    await _settle(store)


async def test_description_replaces_the_fixture(store, monkeypatch) -> None:
    monkeypatch.setattr(vision, "describe_clothing", lambda _f: REAL)
    actions.schedule_description(store, "INC-live")
    await _settle(store)
    b = store.briefs["INC-live"]
    assert b["clothing"]["source"] == "anthropic"
    assert b["clothing_line"] == "red jacket, black jeans, slippers"
    assert any(e.get("clothing_source") == "anthropic" for e in store.log)


async def test_failure_leaves_the_fixture_in_place(store, monkeypatch) -> None:
    def boom(_f: object) -> vision.ClothingReport:
        raise RuntimeError("api down")

    monkeypatch.setattr(vision, "describe_clothing", boom)
    actions.schedule_description(store, "INC-live")
    await _settle(store)
    assert store.briefs["INC-live"]["clothing_line"] == "navy hoodie, gray sweatpants, barefoot"


async def test_one_exit_makes_one_call(store, monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(vision, "describe_clothing", lambda f: calls.append(f) or REAL)
    actions.schedule_description(store, "INC-live")   # brief built
    actions.schedule_description(store, "INC-live")   # frames arrived
    await _settle(store)
    actions.schedule_description(store, "INC-live")   # a late third frame
    await _settle(store)
    assert len(calls) == 1


async def test_no_call_without_frames(store, monkeypatch) -> None:
    monkeypatch.setattr(vision, "describe_clothing", lambda _f: pytest.fail("called with no frame"))
    store.frames.clear()
    actions.schedule_description(store, "INC-live")
    assert not store.vision_tasks


async def test_no_call_without_a_brief(store, monkeypatch) -> None:
    monkeypatch.setattr(vision, "describe_clothing", lambda _f: pytest.fail("called with no brief"))
    store.briefs.clear()
    actions.schedule_description(store, "INC-live")
    assert not store.vision_tasks


async def test_cancel_clears_tasks_and_markers(store, monkeypatch) -> None:
    monkeypatch.setattr(vision, "describe_clothing", lambda _f: REAL)
    actions.schedule_description(store, "INC-live")
    await actions.cancel_descriptions(store)
    assert store.vision_tasks == {} and store.described == set()


def test_dark_frame_skips_the_api_call(monkeypatch) -> None:
    """A black hallway frame holds nothing to describe. Do not spend the call to be told so."""
    from nightfall.integrations import anthropic_vision

    monkeypatch.setattr(anthropic_vision, "describe",
                        lambda *a, **k: pytest.fail("must not call the model on a dark frame"))
    r = vision.describe_clothing(_jpeg(2))
    assert r.source == "mock"


def test_lit_frame_is_not_skipped(monkeypatch) -> None:
    seen = []
    from nightfall.integrations import anthropic_vision

    monkeypatch.setattr(anthropic_vision, "describe", lambda *a, **k: seen.append(1) or {"confidence": 0.9})
    vision.describe_clothing(_jpeg(200))
    assert seen == [1]


def test_darkness_floor_is_configurable(monkeypatch) -> None:
    monkeypatch.setenv("MIN_LUMINANCE", "250")
    from nightfall.integrations import anthropic_vision

    monkeypatch.setattr(anthropic_vision, "describe", lambda *a, **k: pytest.fail("floor ignored"))
    assert vision.describe_clothing(_jpeg(200)).source == "mock"


def test_luminance_is_measured_correctly() -> None:
    assert vision.mean_luminance(_jpeg(0)) < 5
    assert vision.mean_luminance(_jpeg(255)) > 250
    assert vision.mean_luminance(b"not a jpeg") is None
