"""Routes for the caregiver mobile app (static/app.html): compact state, care profile, voice samples,
Cartesia voice clone, cloned-voice preview. Everything else the app needs already exists in the other routers.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from starlette.datastructures import UploadFile

from nightfall import llm, voice
from nightfall.integrations import cartesia
from nightfall.store import ROOT

router = APIRouter()
SAMPLES = Path(os.environ.get("SAMPLES_DIR", "out/samples"))
KINDS = ("introduction", "reassurance", "everyday")
SAMPLE_LINES = {
    "introduction": "Hi Dad. It's Sarah. I'm here with you.",
    "reassurance": "Take your time. There's no rush.",
    "everyday": "Let's sit down and have some tea.",
}


def _store() -> Any:
    from nightfall.api import store

    return store


@router.get("/app")
async def app_page() -> FileResponse:
    return FileResponse(ROOT / "static" / "app.html")


@router.get("/app/state")
async def app_state(member: str = "") -> dict[str, Any]:
    """Everything the app renders, in one call. Brief link is minted for the asking member."""
    store = _store()
    hh, inc = store.hh, store.inc
    now = store.now()
    rings = []
    for r in store.runner.rings:
        names = [m.name for m in hh.tree if m.id in r["members"]]
        rings.append({"tier": r["tier"], "members": names, "member_ids": r["members"]})
    exited = inc.exited_at if inc is not None else None
    samples = {k: (SAMPLES / f"{k}.wav").exists() for k in KINDS}
    vid = os.environ.get("CARTESIA_VOICE_ID", "")
    return {
        "now": now.isoformat(),
        "night_mode": store.night(),
        "household": {
            "person_name": hh.person_name,
            "person_full_name": hh.person_full_name or hh.person_name,
            "person_age": hh.person_age,
            "caregiver_name": hh.caregiver_name,
            "address": hh.address,
            "photo": hh.person_photo,
            "radius_mi": hh.radius_mi,
            "home": {"lat": hh.home_lat, "lng": hh.home_lng},
            "tree": [m.__dict__ for m in hh.tree],
            "familiar_places": list(hh.familiar_places),
            "notes": list(hh.notes),
            "medications": list(hh.medications) if hh.meds_opt_in else [],
            "contacts": list(hh.contacts),
        },
        "incident": None
        if inc is None
        else {
            "id": inc.id,
            "state": inc.state.value,
            "opened_at": inc.opened_at.isoformat() if inc.opened_at else None,
            "exited_at": exited.isoformat() if exited else None,
            "minutes_since_exit": round((now - exited).total_seconds() / 60, 1) if exited else None,
            "deadline_at": inc.deadline_at.isoformat() if inc.deadline_at else None,
            "acked_by": inc.acked_by,
            "acked_by_name": next((m.name for m in hh.tree if m.id == inc.acked_by), None),
            "lines_spoken": inc.lines_spoken,
            "person_in_frame": inc.person_in_frame,
            "brief_link": store.link(inc.id, member) if member and inc.id in store.briefs else "",
            "exit_frame": (store.frames.get(inc.id) or [""])[-1],
            "clothing_line": store.briefs[inc.id]["clothing_line"] if inc.id in store.briefs else "",
            "clothing": store.briefs[inc.id]["clothing"] if inc.id in store.briefs else None,
        },
        "rings": rings,
        "ladder_step_s": store_ladder_step(),
        "takeover_by": store.takeover_by,
        "live_by": _live_by(),
        "call_911": store.call_911_sent,
        "voice": {
            "voice_id": vid,
            "source": store.voice_source,
            "name": store.voice_name,
            "mock": not cartesia.enabled(),
            "samples": samples,
            "style": voice.style(),
        },
        "memory_source": store.memory.source,
        "places_source": store.places_source(),
        "live_frame": bool(store.latest_frame) and time.time() - store.latest_frame_at < 10,
    }


def _door_wait() -> float:
    from nightfall import engine

    return float(engine.DOOR_WAIT_S)


def _live_by() -> str | None:
    from nightfall.api_live import live

    return live.talker


def store_ladder_step() -> float:
    from nightfall.escalation import LADDER

    return float(LADDER[0][1])


class ProfileIn(BaseModel):
    person_full_name: str | None = None
    person_name: str | None = None
    person_age: int | None = None
    caregiver_name: str | None = None
    address: str | None = None


@router.post("/profile")
async def profile(body: ProfileIn) -> dict[str, Any]:
    """Update the care profile; geocodes a new address (hazards only, no Apify spend); persists to data/household.json."""
    store = _store()
    changes = {k: v for k, v in body.model_dump().items() if v is not None and k != "address"}
    if "person_age" in changes and not 0 <= changes["person_age"] <= 120:
        raise HTTPException(422, "age out of range")
    store.hh = replace(store.hh, **changes)
    geo: dict[str, Any] = {}
    if body.address and body.address.strip() and body.address.strip() != store.hh.address:
        from nightfall.api_setup import AddressIn, setup_address

        geo = await setup_address(AddressIn(address=body.address.strip(), radius_mi=store.hh.radius_mi, google=False))
        store.hh = replace(store.hh, address=body.address.strip())
    _persist_household(store.hh)
    return {
        "ok": True,
        "household": {
            "person_full_name": store.hh.person_full_name,
            "person_age": store.hh.person_age,
            "caregiver_name": store.hh.caregiver_name,
            "address": store.hh.address,
        },
        "geo": {k: geo[k] for k in ("lat", "lng", "display_name") if k in geo},
    }


def _persist_household(hh: Any) -> None:
    path = ROOT / "data" / "household.json"
    try:
        d = json.loads(path.read_text())
        d.update(
            {
                "person_full_name": hh.person_full_name,
                "person_age": hh.person_age,
                "caregiver_name": hh.caregiver_name,
                "person_name": hh.person_name,
                "address": hh.address,
                "home_lat": hh.home_lat,
                "home_lng": hh.home_lng,
                "tree": [m.__dict__ for m in hh.tree],
            }
        )
        path.write_text(json.dumps(d, indent=2) + "\n")
    except OSError as e:
        print(f"household not persisted: {e}")


@router.post("/voice/samples/{kind}")
async def voice_sample(kind: str, request: Request) -> dict[str, Any]:
    """Store one recorded sample (any browser format) as 16 kHz mono WAV via ffmpeg."""
    if kind not in KINDS:
        raise HTTPException(404, "unknown sample kind")
    form = await request.form()
    clip = form.get("clip")
    if not isinstance(clip, UploadFile):
        raise HTTPException(422, "clip required")
    data = await clip.read()
    if len(data) > 8 * 1024 * 1024 or len(data) < 1000:
        raise HTTPException(413, "clip too large or empty")
    SAMPLES.mkdir(parents=True, exist_ok=True)
    raw = SAMPLES / f"{kind}.raw"
    raw.write_bytes(data)
    out = SAMPLES / f"{kind}.wav"
    ok = await asyncio.to_thread(_ffmpeg, raw, out)
    raw.unlink(missing_ok=True)
    if not ok:
        raise HTTPException(500, "could not convert the recording")
    return {"ok": True, "kind": kind, "seconds": _seconds(out), "url": f"/voice/samples/{kind}.wav"}


def _ffmpeg(src: Path, dst: Path) -> bool:
    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ac", "1", "-ar", "16000", str(dst)],
            capture_output=True,
            timeout=60,
            check=False,
        )
        return r.returncode == 0 and dst.exists()
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"ffmpeg: {e}")
        return False


def _seconds(wav: Path) -> float:
    try:
        return round((wav.stat().st_size - 44) / (16000 * 2), 1)
    except OSError:
        return 0.0


@router.get("/voice/samples/{kind}.wav")
async def voice_sample_file(kind: str) -> Response:
    p = SAMPLES / f"{kind}.wav"
    if kind not in KINDS or not p.exists():
        raise HTTPException(404, "no sample")
    return Response(content=p.read_bytes(), media_type="audio/wav")


@router.delete("/voice/samples/{kind}")
async def voice_sample_delete(kind: str) -> dict[str, Any]:
    (SAMPLES / f"{kind}.wav").unlink(missing_ok=True)
    return {"ok": True}


class CloneIn(BaseModel):
    name: str = "Sarah"


@router.post("/voice/clone")
async def voice_clone(body: CloneIn) -> dict[str, Any]:
    """Stitch the recorded samples into one clip, clone it at Cartesia, switch the door voice to it."""
    store = _store()
    clips = [SAMPLES / f"{k}.wav" for k in KINDS if (SAMPLES / f"{k}.wav").exists()]
    if not clips:
        raise HTTPException(422, "record at least one sample first")
    stitched = SAMPLES / "stitched.wav"
    if not await asyncio.to_thread(_concat, clips, stitched):
        raise HTTPException(500, "could not stitch samples")
    if not cartesia.enabled():
        store.voice_source, store.voice_name = "mock", body.name
        return {"ok": True, "voice_id": "mock", "source": "mock", "seconds": _seconds(stitched)}
    try:
        vid = await asyncio.to_thread(cartesia.clone_voice, f"Nightfall {body.name}", stitched.read_bytes())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"cartesia clone failed: {str(e)[:160]}") from None
    voice.select(
        vid, 1.0, "happy", os.environ.get("ENV_FILE", ".env"), {"VOICE_IS_CLONE": "1", "VOICE_NAME": body.name}
    )
    store.voice_source, store.voice_name = "clone", body.name
    asyncio.get_running_loop().run_in_executor(None, voice.pre_synthesize, store.hh)
    from nightfall.actions import emit

    emit(store, {"type": "voice", "voice_id": vid[:8], "source": "clone", "name": body.name})
    return {"ok": True, "voice_id": vid, "source": "clone", "seconds": _seconds(stitched)}


def _concat(clips: list[Path], dst: Path) -> bool:
    lst = dst.with_suffix(".txt")
    lst.write_text("".join(f"file '{c.resolve()}'\n" for c in clips))
    try:
        r = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(lst),
                "-ac",
                "1",
                "-ar",
                "16000",
                str(dst),
            ],
            capture_output=True,
            timeout=60,
            check=False,
        )
        return r.returncode == 0
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"ffmpeg concat: {e}")
        return False
    finally:
        lst.unlink(missing_ok=True)


class PreviewIn(BaseModel):
    situation: str = "He is at the front door at 2 AM and says he needs to go to work."


@router.post("/voice/preview")
async def voice_preview(body: PreviewIn) -> dict[str, Any]:
    """Claude writes a fresh redirect line for the situation; the current (cloned) voice speaks it."""
    store = _store()
    hits = [h["text"] for h in await store.memory.search(body.situation, 2)]
    line, source = llm.next_line(store.hh, [("system", "Hi Dad, it's me."), ("person", body.situation[:200])], hits)
    return {
        "text": line,
        "line_source": source,
        "audio": voice.say(line, store.hh.persona),
        "sample_lines": SAMPLE_LINES,
    }
