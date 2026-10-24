"""FastAPI routes and SSE streams. Calls engine.step under one lock so sensor events never interleave.

State lives in nightfall.store.Store; side effects of transitions live in nightfall.actions.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from nightfall import brief as briefmod
from nightfall import engine, voice
from nightfall.actions import emit as _emit
from nightfall.actions import run_actions as _run_actions
from nightfall.api_app import router as app_router
from nightfall.api_cam import router as cam_router
from nightfall.api_enroll import router as enroll_router
from nightfall.api_live import router as live_router
from nightfall.api_setup import router as setup_router
from nightfall.api_voice import router as voice_router
from nightfall.escalation import LADDER
from nightfall.household import TreeMember, load
from nightfall.integrations import anthropic_llm, cartesia, twilio
from nightfall.store import ROOT, Store

PUBLIC_URL = os.environ.get("PUBLIC_URL") or "http://127.0.0.1:8000"
CALL_911_S = float(os.environ.get("CALL_911_S", "45"))


store = Store()


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    store.tick_task = asyncio.create_task(_ticker())
    print("voice pre-synthesis:", voice.pre_synthesize(store.hh))
    store.memory_task = asyncio.create_task(_warm_memory())
    try:
        yield
    finally:
        store.tick_task.cancel()
        if store.memory_task is not None:
            store.memory_task.cancel()
        await store.memory.close()
        if store.inc is not None:
            await store.runner.cancel(store.inc.id)


app = FastAPI(title="Nightfall", lifespan=_lifespan)


class EventIn(BaseModel):
    kind: str
    payload: dict[str, Any] = {}


class AckIn(BaseModel):
    incident_id: str
    member_id: str


class TreeIn(BaseModel):
    name: str
    phone: str = "web"
    tier: int = 1


class ArmIn(BaseModel):
    on: bool


async def _step(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    async with store.lock:
        done = (
            engine.State.CLOSED,
            engine.State.RETURNED,
            engine.State.ACKED,
            engine.State.EXHAUSTED,
            engine.State.WATCHING,
        )
        fresh = kind in ("motion", "person_enter", "door_open", "sos")
        watch_only = False
        if (
            store.inc is None
            or store.inc.state == engine.State.CLOSED
            or (fresh and (store.inc.state in done or watch_only))
        ):
            if store.inc is not None and store.inc.state != engine.State.CLOSED:
                await store.runner.cancel(store.inc.id)
            store.inc = engine.Incident(id=f"INC-{secrets.token_hex(4)}", night_mode=store.night())
            store.takeover_by, store.call_911_sent = None, False
        inc = store.inc
        inc.night_mode = store.night()
        if kind == "reply":
            from nightfall.rules import parse_checkin

            ck, who = parse_checkin(
                str(payload.get("text", "")),
                [m.name for m in store.hh.tree] + [store.hh.caregiver_name],
                store.hh.person_name,
            )
            payload = {**payload, "checkin": ck, "who": who}
            if ck == "self_other":
                kind = "stand_down"
        store.last_payload = payload
        tr = engine.step(inc, engine.Event(kind, store.now(), payload))
        if kind != "tick" or tr.from_state != tr.to_state:
            _emit(
                store,
                {
                    "type": "state",
                    "incident_id": inc.id,
                    "kind": kind,
                    "from": tr.from_state.value,
                    "to": tr.to_state.value,
                    "rule": tr.rule,
                    "detail": tr.detail,
                    "actions": list(tr.actions),
                },
            )
        await _run_actions(store, tr, inc)
        return {
            "incident_id": inc.id,
            "from": tr.from_state.value,
            "to": tr.to_state.value,
            "rule": tr.rule,
            "detail": tr.detail,
            "actions": list(tr.actions),
        }


async def _warm_memory() -> None:
    n = await store.memory.ensure()
    print("memory:", store.memory.source, "notes:", n)
    store.hub.publish("dashboard", {"type": "memory_ready", "source": store.memory.source, "notes": n})


async def _ticker() -> None:
    while True:
        await asyncio.sleep(0.5)
        try:
            inc = store.inc
            if inc is not None and inc.state in (
                engine.State.CONVERSATION,
                engine.State.DOOR_OPEN,
                engine.State.ESCALATING,
            ):
                await _step("tick", {})
            if (
                inc is not None
                and inc.exited_at is not None
                and not store.call_911_sent
                and inc.acked_by is None
                and inc.state in (engine.State.ESCALATING, engine.State.EXHAUSTED)
                and (store.now() - inc.exited_at).total_seconds() >= CALL_911_S
            ):
                store.call_911_sent = True
                for m in store.hh.tree:
                    store.hub.publish(
                        f"phone:{m.id}", {"type": "call_911_option", "incident_id": inc.id, "out_of_view_s": CALL_911_S}
                    )
                _emit(store, {"type": "call_911_option", "incident_id": inc.id})
        except Exception as e:  # noqa: BLE001
            print(f"ticker: {type(e).__name__}: {e}")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "mock": {
            "cartesia": not cartesia.enabled(),
            "anthropic": not anthropic_llm.enabled(),
            "apify": store.places_source() != "apify",
            "twilio": not twilio.enabled(),
            "moss": store.memory.source != "moss",
        },
        "now": store.now().isoformat(),
        "night_mode": store.night(),
    }


@app.get("/state")
async def state() -> dict[str, Any]:
    inc = store.inc
    return {
        "household": {
            "person_name": store.hh.person_name,
            "caregiver_name": store.hh.caregiver_name,
            "tree": [m.__dict__ for m in store.hh.tree],
        },
        "now": store.now().isoformat(),
        "night_mode": store.night(),
        "ladder": LADDER,
        "door_wait_s": engine.DOOR_WAIT_S,
        "incident": None
        if inc is None
        else {
            "id": inc.id,
            "state": inc.state.value,
            "door_opened_at": inc.door_opened_at.isoformat() if inc.door_opened_at else None,
            "exited_at": inc.exited_at.isoformat() if inc.exited_at else None,
            "deadline_at": inc.deadline_at.isoformat() if inc.deadline_at else None,
            "acked_by": inc.acked_by,
        },
        "log": store.log[-50:],
        "rings": store.runner.rings,
    }


@app.post("/arm")
async def arm(body: ArmIn) -> dict[str, Any]:
    store.night_mode = body.on
    _emit(store, {"type": "arm", "night_mode": store.night()})
    return {"night_mode": store.night()}


@app.post("/event")
async def event(body: EventIn) -> dict[str, Any]:
    if body.kind not in engine.EVENT_KINDS or body.kind == "ack":
        raise HTTPException(422, f"unknown kind {body.kind}")
    return await _step(body.kind, body.payload)


@app.post("/ack")
async def ack(body: AckIn) -> dict[str, Any]:
    if store.hh.member(body.member_id) is None:
        raise HTTPException(403, "not a tree member")
    if store.inc is None or store.inc.id != body.incident_id:
        raise HTTPException(404, "no such incident")
    first = await store.runner.ack(body.incident_id, body.member_id)
    if first:
        await _step("ack", {"member_id": body.member_id})
        for m in store.hh.tree:
            store.hub.publish(f"phone:{m.id}", {"type": "acked", "by": body.member_id, "incident_id": body.incident_id})
    return {"ok": True, "acked_by": store.inc.acked_by, "first": first}


@app.post("/tree")
async def tree(body: TreeIn) -> dict[str, Any]:
    if not 1 <= body.tier <= 3:
        raise HTTPException(422, "tier must be 1..3")
    existing = next((t for t in store.hh.tree if t.name.strip().lower() == body.name.strip().lower()), None)
    if existing is not None:
        return {"member_id": existing.id, "phone_url": f"{PUBLIC_URL}/phone.html#{existing.id}", "existing": True}
    m = TreeMember(id=f"TM-{secrets.token_hex(3)}", name=body.name, phone=body.phone, tier=body.tier)
    store.hh = store.hh.with_member(m)
    _emit(store, {"type": "tree", "member": m.__dict__})
    return {"member_id": m.id, "phone_url": f"{PUBLIC_URL}/phone.html#{m.id}"}


@app.get("/brief/{token}")
async def get_brief(token: str) -> dict[str, Any]:
    try:
        inc_id, member_id = briefmod.verify(token, store.now())
    except briefmod.BriefError as e:
        raise HTTPException(e.status, e.detail) from None
    b = store.briefs.get(inc_id)
    if b is None:
        raise HTTPException(404, "no brief")
    return {**b, "viewer": member_id}


async def _sse(channel: str) -> AsyncIterator[str]:
    q = store.hub.subscribe(channel)
    try:
        yield "event: hello\ndata: {}\n\n"
        while True:
            try:
                obj = await asyncio.wait_for(q.get(), timeout=15)
                yield f"data: {json.dumps(obj)}\n\n"
            except TimeoutError:
                yield ": keepalive\n\n"
    finally:
        store.hub.unsubscribe(channel, q)


@app.get("/sse/dashboard")
async def sse_dashboard() -> StreamingResponse:
    return StreamingResponse(_sse("dashboard"), media_type="text/event-stream")


@app.get("/sse/phone/{member_id}")
async def sse_phone(member_id: str) -> StreamingResponse:
    return StreamingResponse(_sse(f"phone:{member_id}"), media_type="text/event-stream")


@app.post("/reset")
async def reset() -> dict[str, Any]:
    if store.inc is not None:
        await store.runner.cancel(store.inc.id)
    store.inc, store.frames, store.briefs = None, {}, {}
    store.log.clear()
    store.history, store.frame_bytes = [], {}
    store.takeover_by, store.call_911_sent, store.latest_frame = None, False, b""
    store.clothing.clear()
    store.runner.rings.clear()
    store.hh = load(ROOT / "data" / "household.json")
    from nightfall.store import places_file

    store.places = briefmod.load_places(places_file())
    from nightfall.memory import Memory

    old_memory = store.memory
    store.memory = Memory(store.hh)
    for t in store.vision_tasks.values():
        t.cancel()
    store.vision_tasks.clear()
    store.takeover_explicit, store.latest_frame_at = False, 0.0
    try:
        await old_memory.close()
    except Exception as e:  # noqa: BLE001
        print(f"memory close: {e}")
    store.memory_task = asyncio.create_task(_warm_memory())
    store.hub.publish("dashboard", {"type": "reset"})
    return {"ok": True}


@app.get("/")
async def index(request: Request) -> Response:
    """Laptop gets the door device; a phone (or anything through the tunnel) gets the caregiver app."""
    ua = request.headers.get("user-agent", "").lower()
    via_tunnel = bool(request.headers.get("cf-connecting-ip"))
    if via_tunnel or any(k in ua for k in ("iphone", "ipad", "android", "mobile")):
        return RedirectResponse("/app")
    return FileResponse(ROOT / "static" / "door.html")


@app.middleware("http")
async def _no_cache_static(request: Request, call_next):  # type: ignore[no-untyped-def]
    """Phones cache app JS aggressively; during the hackathon every page load must get the newest files."""
    resp = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".js", ".css", ".html")) or path in ("/app", "/door"):
        resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp


app.include_router(voice_router)
app.include_router(cam_router)
app.include_router(setup_router)
app.include_router(app_router)
app.include_router(live_router)
app.include_router(enroll_router)
app.mount("/", StaticFiles(directory=str(ROOT / "static")), name="static")
