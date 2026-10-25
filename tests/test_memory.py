from typing import ClassVar

from nightfall.household import load
from nightfall.memory import Memory, TfidfMemory, notes_from

hh = load("data/household.json")


async def test_tfidf_ranks_store_note_first() -> None:
    m = TfidfMemory()
    assert await m.ensure(notes_from(hh)) >= 7
    hits = await m.search("I need to get to the market", 2)
    assert hits and "Market" in hits[0]["text"]
    hits = await m.search("going to work", 2)
    assert "Palace of Fine Arts" in hits[0]["text"]
    assert await m.search("zzz", 2) == []


class _FakeMossClient:
    """Records SDK calls; never talks to the network."""

    calls: ClassVar[list[str]] = []

    def __init__(self, *_: object, **__: object) -> None:
        pass

    async def list_indexes(self) -> list[object]:
        return []

    async def create_index(self, *_: object, **__: object) -> None:
        self.calls.append("create")

    async def add_docs(self, *_: object, **__: object) -> None:
        self.calls.append("add")

    async def load_index(self, *_: object, **__: object) -> str:
        self.calls.append("load")
        return "loaded"

    async def query(self, *_: object, **__: object) -> None:
        self.calls.append("query")

    async def close(self) -> None:
        return None


async def test_moss_skips_empty_mutation(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """A fresh household has no notes; Moss rejects an empty add_docs with HTTP 400, so we must not send one."""
    import moss as sdk

    from nightfall.integrations.moss import MossIndex

    _FakeMossClient.calls = []
    monkeypatch.setattr(sdk, "MossClient", _FakeMossClient)
    monkeypatch.setenv("MOSS_PROJECT_ID", "p")
    monkeypatch.setenv("MOSS_PROJECT_KEY", "k")
    idx = MossIndex("HH-1")
    assert await idx.ensure([]) == 0
    assert await idx.search("church") == []
    assert _FakeMossClient.calls == []

    _FakeMossClient.calls = []
    assert await idx.ensure(notes_from(hh)) >= 7
    assert _FakeMossClient.calls == ["create", "load"]


async def test_facade_mock_source() -> None:
    m = Memory(hh)
    assert m.source == "mock"
    assert await m.search("church") == []  # not warmed yet: never blocks the door
    await m.ensure()
    hits = await m.search("church")
    assert hits and "church" in hits[0]["text"]
