"""Camera relay and human takeover routes.

The dashboard posts a small JPEG every few hundred ms while an incident is open; phones poll the
latest one. Takeover: a relative's typed line is synthesized in the caregiver voice and played by the
dashboard; a recorded clip is relayed as-is. Rejected: WebRTC (too many moving parts for a hotspot demo).
"""

from __future__ import annotations

import asyncio
import base64
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from starlette.datastructures import UploadFile

from nightfall import voice

router = APIRouter()
MAX_FRAME = 200 * 1024
CLIP_DIR = Path("out/clips")


def _store() -> Any:
    from nightfall.api import store

    return store


def _from_door_device(request: Request) -> bool:
    """The door page runs on the laptop next to the server; anything through the tunnel is a phone."""
    return not request.headers.get("cf-connecting-ip")


@router.post("/cam/frame")
async def cam_frame(request: Request) -> dict[str, Any]:
    """Latest camera frame from the door device (multipart 'f'). Phones may not act as the door."""
    store = _store()
    if not _from_door_device(request):
        raise HTTPException(403, "only the door device may send camera frames")
    form = await request.form()
    f = form.get("f")
    if not isinstance(f, UploadFile):
        raise HTTPException(422, "no frame")
    data = await f.read()
    if len(data) > MAX_FRAME:
        raise HTTPException(413, "frame over 200 KB")
    store.latest_frame, store.latest_frame_at = data, time.time()
    return {"ok": True, "bytes": len(data)}


@router.get("/cam/latest.jpg")
async def cam_latest() -> Response:
    store = _store()
    if not store.latest_frame or time.time() - store.latest_frame_at > 10:
        raise HTTPException(404, "no live frame")
    return Response(
        content=store.latest_frame,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store", "X-Frame-Age": f"{time.time() - store.latest_frame_at:.1f}"},
    )


@router.get("/door")
async def door_page(request: Request) -> Response:
    from fastapi.responses import FileResponse, RedirectResponse

    if not _from_door_device(request):
        return RedirectResponse("/app")
    return FileResponse(Path(__file__).resolve().parent.parent / "static" / "door.html")


class CommandIn(BaseModel):
    cmd: str
    label: str = ""
    name: str = ""
    edge: str = ""
    member_id: str = ""


@router.post("/door/command")
async def door_command(body: CommandIn) -> dict[str, Any]:
    """Phone -> door device: enroll a face, set the door edge, start the camera. Relayed over the dashboard SSE."""
    store = _store()
    if body.cmd not in ("enroll", "door_edge", "start", "say_test"):
        raise HTTPException(422, "unknown command")
    if body.cmd == "enroll" and (body.label not in ("person", "other") or not body.name.strip()):
        raise HTTPException(422, "enroll needs label and name")
    if body.cmd == "door_edge" and body.edge not in ("far", "left", "right", "top"):
        raise HTTPException(422, "bad edge")
    obj = {"type": "command", **body.model_dump()}
    store.hub.publish("dashboard", obj)
    from nightfall.actions import emit

    emit(store, {"type": "command_log", "cmd": body.cmd, "name": body.name, "edge": body.edge, "label": body.label})
    return {"ok": True}


class TelemetryIn(BaseModel):
    event: str
    detail: str = ""


@router.post("/door/telemetry")
async def door_telemetry(body: TelemetryIn) -> dict[str, Any]:
    """Door page reports what it sees and hears (detector state, audio play results) for debugging at the table."""
    store = _store()
    from nightfall.actions import emit

    emit(store, {"type": "door", "event": body.event[:40], "detail": body.detail[:200]})
    print(f"door: {body.event} {body.detail[:120]}")
    if body.event == "door_started":
        # a restarted door is a fresh session: end a conversation still running from before the reload,
        # but never an escalation (a door reboot must not cancel the family's calls)
        from nightfall import engine
        from nightfall.api import _step

        store.quiet_until = store.last_open_at = None
        if store.inc is not None and store.inc.state in (
            engine.State.CONVERSATION,
            engine.State.DOOR_OPEN,
            engine.State.WATCHING,
        ):
            await _step("stand_down", {"checkin": "self_other", "who": "door restarted"})
    return {"ok": True}


class TakeoverIn(BaseModel):
    member_id: str
    on: bool = True


@router.post("/takeover")
async def takeover(body: TakeoverIn) -> dict[str, Any]:
    """A relative takes over (or hands back) the voice at the door. Stops the AI's auto lines."""
    store = _store()
    m = store.hh.member(body.member_id)
    if m is None:
        raise HTTPException(403, "not a tree member")
    store.takeover_by = body.member_id if body.on else None
    store.takeover_explicit = body.on
    from nightfall.actions import emit

    emit(store, {"type": "takeover", "by": m.name if body.on else None, "member_id": body.member_id, "on": body.on})
    for t in store.hh.tree:
        store.hub.publish(f"phone:{t.id}", {"type": "takeover", "by": m.name if body.on else None, "on": body.on})
    return {"ok": True, "takeover_by": store.takeover_by}


class SayIn(BaseModel):
    member_id: str
    text: str


@router.post("/say")
async def say(body: SayIn) -> dict[str, Any]:
    """Relative's typed line, spoken at the door in the caregiver voice."""
    store = _store()
    m = store.hh.member(body.member_id)
    if m is None:
        raise HTTPException(403, "not a tree member")
    text = body.text.strip()[:200]
    if not text:
        raise HTTPException(422, "empty")
    from nightfall.actions import emit

    store.history.append(("system", text))
    ref = await asyncio.to_thread(voice.say, text, store.hh.persona)
    emit(
        store,
        {
            "type": "speak",
            "text": text,
            "mode": ref["mode"],
            "url": ref["url"],
            "voice_source": ref["source"],
            "line_source": f"human:{m.name}",
        },
    )
    return {"ok": True, "audio": ref}


@router.post("/say/clip")
async def say_clip(request: Request) -> dict[str, Any]:
    """Relative's recorded voice clip (multipart 'clip', audio/*), relayed to the door speaker."""
    store = _store()
    form = await request.form()
    member_id = str(form.get("member_id", ""))
    clip = form.get("clip")
    m = store.hh.member(member_id)
    if m is None or not isinstance(clip, UploadFile):
        raise HTTPException(422, "member_id and clip required")
    data = await clip.read()
    if len(data) > 2 * 1024 * 1024:
        raise HTTPException(413, "clip over 2 MB")
    if len(data) < 1500:
        raise HTTPException(422, "empty clip; record for at least a second")
    CLIP_DIR.mkdir(parents=True, exist_ok=True)
    ext = "mp4" if "mp4" in (clip.content_type or "") else "webm" if "webm" in (clip.content_type or "") else "bin"
    name = f"clip-{int(time.time() * 1000)}.{ext}"
    (CLIP_DIR / name).write_bytes(data)
    for old in sorted(CLIP_DIR.glob("clip-*"))[:-20]:
        old.unlink(missing_ok=True)
    from nightfall.actions import emit

    emit(
        store,
        {
            "type": "speak",
            "text": f"[{m.name}'s voice]",
            "mode": "clip",
            "url": f"/clips/{name}",
            "voice_source": "human",
            "line_source": f"human:{m.name}",
        },
    )
    return {"ok": True, "url": f"/clips/{name}"}


@router.get("/clips/{name}")
async def clip_file(name: str) -> Response:
    if "/" in name or ".." in name or not name.startswith("clip-"):
        raise HTTPException(404, "no")
    p = CLIP_DIR / name
    if not p.exists():
        raise HTTPException(404, "no")
    mt = (
        "audio/mp4" if name.endswith(".mp4") else "audio/webm" if name.endswith(".webm") else "application/octet-stream"
    )
    return Response(content=p.read_bytes(), media_type=mt)


@router.post("/frames/{incident_id}")
async def frames(incident_id: str, request: Request) -> dict[str, Any]:
    """Up to 3 exit frames (JPEG, 200 KB each) kept for the brief and the clothing model."""
    store = _store()
    form = await request.form()
    out: list[str] = []
    for f in form.values():
        if isinstance(f, UploadFile):
            data = await f.read()
            if len(data) > MAX_FRAME:
                raise HTTPException(413, "frame over 200 KB")
            out.append("data:image/jpeg;base64," + base64.b64encode(data).decode())
            store.frame_bytes[incident_id] = data
    store.frames[incident_id] = (store.frames.get(incident_id, []) + out)[-3:]
    if incident_id in store.briefs:
        store.briefs[incident_id]["exit_frames"] = store.frames[incident_id]
    from nightfall.actions import start_vision

    start_vision(store, incident_id)
    return {"frame_ids": [f"FR-{i}" for i in range(len(store.frames[incident_id]))]}
