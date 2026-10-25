"""Live voice relay. The phone streams 16 kHz mono Int16 PCM over a WebSocket; the dashboard (door speaker)
receives the same bytes and plays them with a small jitter buffer. One talker at a time; the newest wins.
Rejected: WebRTC (needs TURN once the phone is on cellular; the tunnel already carries WebSockets).
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any, Final

from anyio import CancelScope
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()


class LiveHub:
    """Fan out talker bytes to every door listener; track who is live."""

    def __init__(self) -> None:
        self.listeners: set[WebSocket] = set()
        self.talker: str | None = None
        self.talker_socket: WebSocket | None = None
        self.frames = 0

    async def broadcast(self, data: bytes) -> None:
        dead = []
        for ws in list(self.listeners):
            try:
                await ws.send_bytes(data)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.listeners.discard(ws)

    async def status(self, obj: dict[str, Any]) -> None:
        for ws in list(self.listeners):
            try:
                await ws.send_json(obj)
            except Exception:  # noqa: BLE001
                self.listeners.discard(ws)


live = LiveHub()


class DoorMicHub:
    """Door microphone -> every phone that is listening. The door only streams while someone listens."""

    def __init__(self) -> None:
        self.listeners: dict[WebSocket, str] = {}
        self.door: WebSocket | None = None
        self.frames = 0

    async def broadcast(self, data: bytes) -> None:
        for ws in list(self.listeners):
            try:
                await ws.send_bytes(data)
            except Exception:  # noqa: BLE001
                self.listeners.pop(ws, None)

    async def tell_door(self) -> None:
        if self.door is not None:
            try:
                await self.door.send_json({"type": "listeners", "count": len(self.listeners)})
            except Exception:  # noqa: BLE001
                self.door = None


doormic = DoorMicHub()


@router.websocket("/ws/door-mic")
async def ws_door_mic(ws: WebSocket) -> None:
    """Door page sends its microphone as 16 kHz Int16 PCM; receives {"type":"listeners","count":n}."""
    await ws.accept()
    doormic.door = ws
    await doormic.tell_door()
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data:
                doormic.frames += 1
                await doormic.broadcast(data)
    except WebSocketDisconnect:
        pass
    finally:
        if doormic.door is ws:
            doormic.door = None


@router.websocket("/ws/listen/{member_id}")
async def ws_listen(ws: WebSocket, member_id: str) -> None:
    """Phone side: hears the door microphone."""
    store = _store()
    if store.hh.member(member_id) is None:
        await ws.close(code=4403)
        return
    await ws.accept()
    doormic.listeners[ws] = member_id
    await doormic.tell_door()
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        doormic.listeners.pop(ws, None)
        await doormic.tell_door()


def _store() -> Any:
    from nightfall.api import store

    return store


@router.websocket("/ws/talk/{member_id}")
async def ws_talk(ws: WebSocket, member_id: str) -> None:
    """Phone side: binary PCM frames in; a text 'ping' keeps the tunnel alive."""
    store = _store()
    m = store.hh.member(member_id)
    if m is None:
        await ws.close(code=4403)
        return
    await ws.accept()
    previous_socket = live.talker_socket
    live.talker = member_id
    live.talker_socket = ws
    store.takeover_by = member_id
    from nightfall.actions import emit

    emit(store, {"type": "live", "on": True, "by": m.name, "member_id": member_id})
    store.hub.publish("dashboard", {"type": "live", "on": True, "by": m.name, "member_id": member_id})
    await live.status({"type": "live", "on": True, "by": m.name})
    try:
        if previous_socket is not None:
            # A previously disconnected socket must not break its replacement.
            with suppress(Exception):
                await previous_socket.close(code=4001, reason="Talk moved to another connection")
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data and live.talker_socket is ws:
                live.frames += 1
                await live.broadcast(data)
    except WebSocketDisconnect:
        pass
    finally:
        # A reconnect can open before the old socket finishes closing, even for
        # the same member. Only the active session owns the live/takeover state.
        if live.talker_socket is ws:
            live.talker_socket = None
            live.talker = None
            if store.takeover_by == member_id and not store.takeover_explicit:
                store.takeover_by = None
            emit(store, {"type": "live", "on": False, "by": m.name, "member_id": member_id})
            store.hub.publish("dashboard", {"type": "live", "on": False, "by": m.name, "member_id": member_id})
            await live.status({"type": "live", "on": False, "by": m.name})


@router.websocket("/ws/door")
async def ws_door(ws: WebSocket) -> None:
    """Door speaker side (dashboard): receives PCM bytes and JSON status."""
    await ws.accept()
    live.listeners.add(ws)
    try:
        await ws.send_json({"type": "live", "on": live.talker is not None, "by": live.talker or ""})
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        live.listeners.discard(ws)
        await asyncio.sleep(0)


class VideoHub:
    """Send each watching phone only its newest JPEG, independently of slow peers."""

    INFLIGHT: Final = 2
    ACK_GRACE_S: Final = 1.5

    def __init__(self) -> None:
        self.watchers: dict[WebSocket, str] = {}
        self.door: WebSocket | None = None
        self.frames = 0
        self._latest: dict[WebSocket, bytes] = {}
        self._wake: dict[WebSocket, asyncio.Event] = {}
        self._unacked: dict[WebSocket, int] = {}
        self._last_sent: dict[WebSocket, float] = {}

    def add(self, ws: WebSocket, member_id: str) -> None:
        self.watchers[ws] = member_id
        self._wake[ws] = asyncio.Event()
        self._unacked[ws] = 0
        self._last_sent[ws] = 0.0

    def remove(self, ws: WebSocket) -> None:
        wake = self._wake.pop(ws, None)
        if wake is not None:
            wake.set()
        for entries in (self.watchers, self._latest, self._unacked, self._last_sent):
            entries.pop(ws, None)

    def ack(self, ws: WebSocket) -> None:
        if ws in self._unacked:
            self._unacked[ws] = max(0, self._unacked[ws] - 1)
            self._wake[ws].set()

    async def broadcast(self, data: bytes) -> None:
        # Never await a phone's transport here: a stalled phone must not block the camera or other phones.
        for ws in self.watchers:
            self._latest[ws] = data
            self._wake[ws].set()

    async def pump(self, ws: WebSocket) -> None:
        loop = asyncio.get_running_loop()
        while ws in self.watchers:
            wake = self._wake[ws]
            wake.clear()
            if self._unacked[ws] >= self.INFLIGHT:
                remaining = self.ACK_GRACE_S - (loop.time() - self._last_sent[ws])
                if remaining > 0:
                    # The deadline is tied to the last send, not the latest wake-up. Continuous incoming
                    # frames therefore cannot starve legacy phones that do not acknowledge frames.
                    with suppress(TimeoutError):
                        await asyncio.wait_for(wake.wait(), remaining)
                    continue
                self._unacked[ws] = 0
            data = self._latest.pop(ws, None)
            if data is None:
                await wake.wait()
                continue
            self._unacked[ws] += 1
            self._last_sent[ws] = loop.time()
            try:
                await ws.send_bytes(data)
            except Exception:  # noqa: BLE001 - a dead phone must not affect the other pumps
                self.remove(ws)
                with suppress(Exception):
                    await ws.close(code=1011, reason="Video connection lost")
                return

    async def tell_door(self) -> None:
        if self.door is not None:
            try:
                await self.door.send_json({"type": "watchers", "count": len(self.watchers)})
            except Exception:  # noqa: BLE001
                self.door = None


video = VideoHub()


@router.websocket("/ws/video-in")
async def ws_video_in(ws: WebSocket) -> None:
    """Door page pushes JPEG frames; receives {"type":"watchers","count":n}. Also refreshes the polled frame."""
    if ws.headers.get("cf-connecting-ip"):
        await ws.close(code=4403)
        return
    await ws.accept()
    video.door = ws
    await video.tell_door()
    store = _store()
    import time as _time

    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data and len(data) <= 200 * 1024:
                video.frames += 1
                await video.broadcast(data)
                if video.frames % 10 == 0:
                    store.latest_frame, store.latest_frame_at = data, _time.time()
    except WebSocketDisconnect:
        pass
    finally:
        if video.door is ws:
            video.door = None


@router.websocket("/ws/video/{member_id}")
async def ws_video(ws: WebSocket, member_id: str) -> None:
    """Phone side: receives the live door video."""
    store = _store()
    if store.hh.member(member_id) is None:
        await ws.close(code=4403)
        return
    await ws.accept()
    video.add(ws, member_id)
    sender = asyncio.create_task(video.pump(ws))
    try:
        await video.tell_door()
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("text") == "a":
                video.ack(ws)
    except WebSocketDisconnect:
        pass
    finally:
        video.remove(ws)
        sender.cancel()
        # ASGI can cancel the whole connection scope on disconnect. Complete
        # cleanup before propagating it so the door receives its watcher count.
        with CancelScope(shield=True):
            with suppress(asyncio.CancelledError):
                await sender
            await video.tell_door()
