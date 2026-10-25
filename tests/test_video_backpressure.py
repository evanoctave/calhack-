"""Per-phone JPEG flow control with fake sockets; no server, camera, or external providers."""

import asyncio
from contextlib import suppress
from types import SimpleNamespace

import anyio
import pytest

from nightfall import api_live


class PhoneSocket:
    def __init__(self, *, blocked=False, send_error=False):
        self.incoming = asyncio.Queue()
        self.waiting = asyncio.Queue()
        self.delivered = asyncio.Queue()
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        if not blocked:
            self.release.set()
        self.frames = []
        self.closes = []
        self.send_error = send_error
        self.send_cancelled = False

    async def accept(self):
        pass

    async def receive(self):
        self.waiting.put_nowait(None)
        return await self.incoming.get()

    async def send_bytes(self, data):
        self.started.set()
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.send_cancelled = True
            raise
        if self.send_error:
            raise OSError("Phone disconnected")
        self.frames.append(data)
        self.delivered.put_nowait(data)

    async def close(self, code, reason=""):
        self.closes.append((code, reason))
        self.incoming.put_nowait({"type": "websocket.disconnect"})

    async def frame(self):
        return await asyncio.wait_for(self.delivered.get(), 1)

    async def message(self, **message):
        self.incoming.put_nowait({"type": "websocket.receive", **message})
        # The next receive call means the previous message was processed.
        await asyncio.wait_for(self.waiting.get(), 1)


class DoorSocket:
    def __init__(self):
        self.statuses = []

    async def send_json(self, status):
        self.statuses.append(status)


def assert_removed(hub, socket):
    for entries in (hub.watchers, hub._latest, hub._wake, hub._unacked, hub._last_sent):
        assert socket not in entries


async def stop_pump(hub, socket, task):
    hub.remove(socket)
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_a_slow_phone_never_blocks_a_fast_phone_and_only_keeps_the_latest_frame():
    hub = api_live.VideoHub()
    hub.ACK_GRACE_S = 60
    slow, fast = PhoneSocket(blocked=True), PhoneSocket()
    hub.add(slow, "TM-SARAH")
    hub.add(fast, "TM-MIKE")
    slow_task = asyncio.create_task(hub.pump(slow))
    fast_task = asyncio.create_task(hub.pump(fast))
    try:
        await asyncio.wait_for(hub.broadcast(b"first"), 1)
        await asyncio.wait_for(slow.started.wait(), 1)
        assert await fast.frame() == b"first"
        hub.ack(fast)

        # These broadcasts cannot wait for the slow socket, and only the newest survives.
        async def burst():
            for frame in (b"old-1", b"old-2", b"newest"):
                await hub.broadcast(frame)

        await asyncio.wait_for(burst(), 1)
        assert await fast.frame() == b"newest"
        assert slow.frames == []
        assert hub._latest[slow] == b"newest"

        slow.release.set()
        assert await slow.frame() == b"first"
        assert await slow.frame() == b"newest"
        assert slow.frames == [b"first", b"newest"]
        assert fast.frames == [b"first", b"newest"]
    finally:
        await stop_pump(hub, slow, slow_task)
        await stop_pump(hub, fast, fast_task)


@pytest.mark.asyncio
async def test_at_most_two_frames_are_unacknowledged_and_ack_sends_the_latest_pending_frame():
    hub, phone = api_live.VideoHub(), PhoneSocket()
    hub.ACK_GRACE_S = 60
    hub.add(phone, "TM-SARAH")
    sender = asyncio.create_task(hub.pump(phone))
    try:
        for frame in (b"first", b"second"):
            await hub.broadcast(frame)
            assert await phone.frame() == frame
        await hub.broadcast(b"old-pending")
        await hub.broadcast(b"newest-pending")
        await asyncio.sleep(0)
        assert phone.frames == [b"first", b"second"]
        assert hub._unacked[phone] == 2
        assert hub._latest[phone] == b"newest-pending"

        hub.ack(phone)
        assert await phone.frame() == b"newest-pending"
        assert hub._unacked[phone] == 2
        assert phone not in hub._latest
    finally:
        await stop_pump(hub, phone, sender)


@pytest.mark.asyncio
async def test_legacy_grace_expires_even_while_new_frames_keep_waking_the_pump():
    hub, phone = api_live.VideoHub(), PhoneSocket()
    hub.ACK_GRACE_S = 0.025
    hub.add(phone, "TM-SARAH")
    sender = asyncio.create_task(hub.pump(phone))

    async def feed_continuously():
        number = 0
        while True:
            await hub.broadcast(str(number).encode())
            number += 1
            await asyncio.sleep(0.001)

    feeder = asyncio.create_task(feed_continuously())
    try:
        first, second, after_grace = await asyncio.wait_for(
            _three_frames(phone), 0.5,
        )
        # No ACK was sent. Frames between the window and the deadline were dropped.
        assert int(first) < int(second) < int(after_grace)
        assert int(after_grace) > int(second) + 1
        assert hub._unacked[phone] <= hub.INFLIGHT
    finally:
        feeder.cancel()
        with suppress(asyncio.CancelledError):
            await feeder
        await stop_pump(hub, phone, sender)


async def _three_frames(phone):
    return [await phone.frame() for _ in range(3)]


@pytest.fixture
def route_hub(monkeypatch):
    hub, door = api_live.VideoHub(), DoorSocket()
    hub.ACK_GRACE_S = 60
    hub.door = door
    store = SimpleNamespace(
        hh=SimpleNamespace(member=lambda member: object() if member == "TM-SARAH" else None),
    )
    monkeypatch.setattr(api_live, "video", hub)
    monkeypatch.setattr(api_live, "_store", lambda: store)
    return hub, door


async def connect(phone):
    task = asyncio.create_task(api_live.ws_video(phone, "TM-SARAH"))
    await asyncio.wait_for(phone.waiting.get(), 1)
    return task


async def disconnect(phone, task):
    phone.incoming.put_nowait({"type": "websocket.disconnect"})
    await asyncio.wait_for(task, 1)


@pytest.mark.asyncio
async def test_route_accepts_only_the_exact_text_ack(route_hub):
    hub, door = route_hub
    phone = PhoneSocket()
    route = await connect(phone)
    try:
        for frame in (b"one", b"two"):
            await hub.broadcast(frame)
            assert await phone.frame() == frame
        assert hub._unacked[phone] == 2
        for message in ({"text": "ping"}, {"text": ""}, {"text": "A"}, {"text": "a "}, {"bytes": b"a"}):
            await phone.message(**message)
            assert hub._unacked[phone] == 2
        await phone.message(text="a")
        assert hub._unacked[phone] == 1
        await hub.broadcast(b"three")
        assert await phone.frame() == b"three"
    finally:
        await disconnect(phone, route)
    assert_removed(hub, phone)
    assert door.statuses == [{"type": "watchers", "count": 1}, {"type": "watchers", "count": 0}]


@pytest.mark.asyncio
async def test_disconnect_cancels_and_awaits_a_blocked_sender_and_removes_all_state(route_hub):
    hub, door = route_hub
    phone = PhoneSocket(blocked=True)
    route = await connect(phone)
    await hub.broadcast(b"blocked-send")
    await asyncio.wait_for(phone.started.wait(), 1)
    await hub.broadcast(b"pending")
    await disconnect(phone, route)
    assert route.done()
    assert phone.send_cancelled
    assert_removed(hub, phone)
    assert door.statuses[-1] == {"type": "watchers", "count": 0}


@pytest.mark.asyncio
async def test_cancelled_route_still_notifies_door_that_watcher_disconnected(route_hub):
    hub, _ = route_hub

    class CancellableDoor(DoorSocket):
        async def send_json(self, status):
            # ASGI transports yield here and remain subject to an enclosing
            # AnyIO cancellation scope, unlike our in-memory socket above.
            await anyio.lowlevel.checkpoint()
            await super().send_json(status)

    door = CancellableDoor()
    hub.door = door
    phone = PhoneSocket()
    with anyio.fail_after(1):
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(api_live.ws_video, phone, "TM-SARAH")
            await phone.waiting.get()
            tasks.cancel_scope.cancel()
    assert_removed(hub, phone)
    assert door.statuses == [{"type": "watchers", "count": 1}, {"type": "watchers", "count": 0}]


@pytest.mark.asyncio
async def test_failed_sender_closes_only_its_socket_and_leaves_no_state(route_hub):
    hub, door = route_hub
    phone = PhoneSocket(send_error=True)
    route = await connect(phone)
    await hub.broadcast(b"failed-send")
    await asyncio.wait_for(route, 1)
    assert phone.closes == [(1011, "Video connection lost")]
    assert_removed(hub, phone)
    assert door.statuses[-1] == {"type": "watchers", "count": 0}
