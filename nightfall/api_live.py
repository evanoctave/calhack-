"""Live voice relay. The phone streams 16 kHz mono Int16 PCM over a WebSocket; the dashboard (door speaker)
receives the same bytes and plays them with a small jitter buffer. One talker at a time; the newest wins.
Rejected: WebRTC (needs TURN once the phone is on cellular; the tunnel already carries WebSockets).
"""

from __future__ import annotations

import asyncio
from typing import Any

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
        emit(store, {"type": "live", "on": False, "by": m.name, "member_id": member_id})
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
