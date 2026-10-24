from nightfall.household import load
from nightfall.memory import Memory, TfidfMemory, notes_from

hh = load("data/household.json")


async def test_tfidf_ranks_store_note_first() -> None:
    m = TfidfMemory()
    assert await m.ensure(notes_from(hh)) >= 7
    hits = await m.search("I need to get to the store", 2)
    assert hits and "Ralphs" in hits[0]["text"]
    hits = await m.search("going to work", 2)
    assert "train tracks" in hits[0]["text"]
    assert await m.search("zzz", 2) == []


async def test_facade_mock_source() -> None:
    m = Memory(hh)
    assert m.source == "mock"
    assert await m.search("church") == []  # not warmed yet: never blocks the door
    await m.ensure()
    hits = await m.search("church")
    assert hits and "Mary" in hits[0]["text"]
