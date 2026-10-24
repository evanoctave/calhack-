"""Camera relay and human takeover routes.

The dashboard posts a small JPEG every few hundred ms while an incident is open; phones poll the
latest one. Takeover: a relative's typed line is synthesized in the caregiver voice and played by the
dashboard; a recorded clip is relayed as-is. Rejected: WebRTC (too many moving parts for a hotspot demo).
"""

from __future__ import annotations

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


@router.post("/cam/frame")
async def cam_frame(request: Request) -> dict[str, Any]:
    """Latest camera frame from the dashboard (multipart 'f')."""
    store = _store()
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
    ref = voice.say(text, store.hh.persona)
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
