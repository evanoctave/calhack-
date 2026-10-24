"""Live voice relay. The phone streams 16 kHz mono Int16 PCM over a WebSocket; the dashboard (door speaker)
receives the same bytes and plays them with a small jitter buffer. One talker at a time; the newest wins.
Rejected: WebRTC (needs TURN once the phone is on cellular; the tunnel already carries WebSockets).
"""

from __future__ import annotations

import asyncio
from typing import Any, Final

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()


class LiveHub:
    """Fan out talker bytes to every door listener; track who is live."""

    def __init__(self) -> None:
        self.listeners: set[WebSocket] = set()
        self.talker: str | None = None
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
    live.talker = member_id
    store.takeover_by = member_id
    from nightfall.actions import emit

    emit(store, {"type": "live", "on": True, "by": m.name, "member_id": member_id})
    store.hub.publish("dashboard", {"type": "live", "on": True, "by": m.name, "member_id": member_id})
    await live.status({"type": "live", "on": True, "by": m.name})
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data:
                live.frames += 1
                await live.broadcast(data)
    except WebSocketDisconnect:
        pass
    finally:
        if live.talker == member_id:
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
    """Door camera -> every phone watching. JPEG frames as binary messages; the door streams only while watched.

    Each phone gets its own sender holding only the newest frame, and at most two frames unacknowledged: a phone
    on a slow tunnel skips frames instead of falling seconds behind, and never stalls the door or other phones.
    """

    INFLIGHT: Final = 2
    ACK_GRACE_S: Final = 1.5  # a phone that never acks (old page) still gets a frame this often

    def __init__(self) -> None:
        self.watchers: dict[WebSocket, str] = {}
        self.door: WebSocket | None = None
        self.frames = 0
        self._latest: dict[WebSocket, bytes] = {}
        self._wake: dict[WebSocket, asyncio.Event] = {}
        self._unacked: dict[WebSocket, int] = {}

    def add(self, ws: WebSocket, member_id: str) -> None:
        self.watchers[ws] = member_id
        self._wake[ws], self._unacked[ws] = asyncio.Event(), 0

    def remove(self, ws: WebSocket) -> None:
        for d in (self.watchers, self._latest, self._wake, self._unacked):
            d.pop(ws, None)

    def ack(self, ws: WebSocket) -> None:
        if ws in self._unacked:
            self._unacked[ws] = max(0, self._unacked[ws] - 1)
            self._wake[ws].set()

    async def broadcast(self, data: bytes) -> None:
        for ws in list(self.watchers):
            self._latest[ws] = data
            if ws in self._wake:
                self._wake[ws].set()

    async def pump(self, ws: WebSocket) -> None:
        """Send this phone the newest frame whenever it has room; drops everything older."""
        while ws in self.watchers:
            ev = self._wake[ws]
            try:
                await asyncio.wait_for(ev.wait(), self.ACK_GRACE_S)
            except TimeoutError:
                self._unacked[ws] = 0
            ev.clear()
            if self._unacked.get(ws, 0) >= self.INFLIGHT:
                continue
            data = self._latest.pop(ws, None)
            if data is None:
                continue
            self._unacked[ws] = self._unacked.get(ws, 0) + 1
            try:
                await ws.send_bytes(data)
            except Exception:  # noqa: BLE001
                self.remove(ws)
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
    await video.tell_door()
    sender = asyncio.create_task(video.pump(ws))
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("text"):
                video.ack(ws)
    except WebSocketDisconnect:
        pass
    finally:
        video.remove(ws)
        sender.cancel()
        await video.tell_door()
