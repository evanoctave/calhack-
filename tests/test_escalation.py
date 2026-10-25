import asyncio

import pytest

from nightfall import escalation
from nightfall.escalation import Runner
from nightfall.household import Household, TreeMember


class FakeNotifier:
    def __init__(self) -> None:
        self.calls: list[tuple[int, list[str]]] = []

    async def ring(self, members, message, incident_id, tier) -> None:
        self.calls.append((tier, [m.id for m in members]))


def hh() -> Household:
    from datetime import time

    return Household(
        "HH",
        "Dad",
        "",
        "Sarah",
        time(21),
        time(6),
        0,
        0,
        1.5,
        True,
        (TreeMember("A", "a", "web", 1), TreeMember("B", "b", "web", 2), TreeMember("C", "c", "web", 3)),
    )


@pytest.fixture(autouse=True)
def fast_ladder(monkeypatch):
    monkeypatch.setattr(escalation, "LADDER", ((1, 0.05), (2, 0.05), (3, 0.0)))


async def test_ack_stops_tier_two() -> None:
    n = FakeNotifier()
    r = Runner(n)
    await r.start("I", hh(), "m")
    await asyncio.sleep(0.01)
    assert await r.ack("I", "A") is True
    assert await r.ack("I", "B") is False
    await asyncio.sleep(0.15)
    assert [t for t, _ in n.calls] == [1] and r.live() == 0


async def test_no_ack_rings_all_tiers() -> None:
    n = FakeNotifier()
    r = Runner(n)
    await r.start("I", hh(), "m")
    await r.start("I", hh(), "m")
    await asyncio.sleep(0.2)
    assert [t for t, _ in n.calls] == [1, 2, 3]
    assert n.calls[2][1] == ["C"]  # tier 3 is everyone not yet called
    await r.cancel("I")
    assert r.live() == 0
