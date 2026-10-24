"""Talk-session ownership tests; no ASGI server, media devices, or providers."""

import asyncio
from types import SimpleNamespace

import pytest

from nightfall import actions, api_live


class PhoneSocket:
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.waiting = asyncio.Queue()
        self.closes = []
        self.close_error = None

    async def accept(self):
        pass

    async def close(self, code, reason):
        self.closes.append((code, reason))
        if self.close_error:
            raise self.close_error
        # Disconnect delivery is controlled separately to exercise late frames
        # and cleanup after the server has sent the close handshake.

    async def receive(self):
        self.waiting.put_nowait(None)
        return await self.incoming.get()

    async def send_frame(self, data):
        self.incoming.put_nowait({"type": "websocket.receive", "bytes": data})
        # Entering receive again proves the prior frame was handled.
        await asyncio.wait_for(self.waiting.get(), 1)


class DoorSocket:
    def __init__(self):
        self.frames = []
        self.statuses = []

    async def send_bytes(self, data):
        self.frames.append(data)

    async def send_json(self, obj):
        self.statuses.append(obj)


@pytest.fixture
def relay(monkeypatch):
    members = {
        "TM-SARAH": SimpleNamespace(name="Sarah"),
        "TM-MIKE": SimpleNamespace(name="Mike"),
    }
    published, events = [], []
    store = SimpleNamespace(
        hh=SimpleNamespace(member=members.get),
        takeover_by=None,
        takeover_explicit=False,
        hub=SimpleNamespace(publish=lambda channel, obj: published.append((channel, obj))),
    )
    hub, door = api_live.LiveHub(), DoorSocket()
    hub.listeners.add(door)
    monkeypatch.setattr(api_live, "live", hub)
    monkeypatch.setattr(api_live, "_store", lambda: store)
    monkeypatch.setattr(actions, "emit", lambda _, obj: events.append(obj))
    return SimpleNamespace(store=store, hub=hub, door=door, published=published, events=events)


async def connect(member):
    socket = PhoneSocket()
    task = asyncio.create_task(api_live.ws_talk(socket, member))
    await asyncio.wait_for(socket.waiting.get(), 1)
    return socket, task


async def disconnect(socket, task):
    socket.incoming.put_nowait({"type": "websocket.disconnect"})
    await asyncio.wait_for(task, 1)


@pytest.mark.asyncio
async def test_same_member_reconnect_keeps_new_session_live(relay):
    old, old_task = await connect("TM-SARAH")
    new, new_task = await connect("TM-SARAH")
    try:
        assert old.closes == [(4001, "Talk moved to another connection")]
        assert new.closes == []
        await disconnect(old, old_task)

        assert relay.hub.talker == "TM-SARAH"
        assert relay.hub.talker_socket is new
        assert relay.store.takeover_by == "TM-SARAH"
        assert all(event["on"] for event in relay.events)
        assert all(obj["on"] for _, obj in relay.published)
        assert all(status["on"] for status in relay.door.statuses)

        await new.send_frame(b"\x01\x00")
        assert relay.door.frames == [b"\x01\x00"]
    finally:
        await disconnect(new, new_task)

    assert relay.hub.talker is None
    assert relay.hub.talker_socket is None
    assert relay.store.takeover_by is None
    assert sum(not event["on"] for event in relay.events) == 1
    assert relay.door.statuses[-1]["on"] is False


@pytest.mark.asyncio
async def test_newest_member_exclusively_relays_audio(relay):
    old, old_task = await connect("TM-SARAH")
    new, new_task = await connect("TM-MIKE")
    try:
        assert old.closes == [(4001, "Talk moved to another connection")]
        await old.send_frame(b"old")
        await new.send_frame(b"new")
        assert relay.door.frames == [b"new"]
        assert relay.hub.frames == 1

        await disconnect(old, old_task)
        assert relay.hub.talker == "TM-MIKE"
        assert relay.store.takeover_by == "TM-MIKE"
        assert all(event["on"] for event in relay.events)
        assert all(status["on"] for status in relay.door.statuses)
    finally:
        if not old_task.done():
            await disconnect(old, old_task)
        await disconnect(new, new_task)


@pytest.mark.asyncio
async def test_superseded_socket_does_not_resume_after_new_owner_closes(relay):
    old, old_task = await connect("TM-SARAH")
    new, new_task = await connect("TM-MIKE")
    await disconnect(new, new_task)
    try:
        await old.send_frame(b"stale")
        assert relay.door.frames == []
        assert relay.hub.talker is None
        assert relay.store.takeover_by is None
    finally:
        await disconnect(old, old_task)
    assert sum(not event["on"] for event in relay.events) == 1


@pytest.mark.asyncio
async def test_active_disconnect_preserves_explicit_takeover(relay):
    relay.store.takeover_explicit = True
    old, old_task = await connect("TM-SARAH")
    new, new_task = await connect("TM-SARAH")
    await disconnect(old, old_task)
    await disconnect(new, new_task)
    assert relay.hub.talker is None
    assert relay.hub.talker_socket is None
    assert relay.store.takeover_by == "TM-SARAH"
    assert relay.store.takeover_explicit is True


@pytest.mark.asyncio
@pytest.mark.parametrize("close_error", [RuntimeError("Already closed"), OSError("Connection lost")])
async def test_old_socket_close_failure_does_not_break_replacement(relay, close_error):
    old, old_task = await connect("TM-SARAH")
    old.close_error = close_error
    new, new_task = await connect("TM-MIKE")
    try:
        assert old.closes == [(4001, "Talk moved to another connection")]
        assert relay.hub.talker_socket is new
        assert relay.store.takeover_by == "TM-MIKE"
        await new.send_frame(b"new")
        assert relay.door.frames == [b"new"]
        await disconnect(old, old_task)
        assert relay.hub.talker_socket is new
        assert all(event["on"] for event in relay.events)
    finally:
        if not old_task.done():
            await disconnect(old, old_task)
        await disconnect(new, new_task)
