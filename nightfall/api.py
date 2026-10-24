"""FastAPI routes and SSE streams. Calls engine.step under one lock so sensor events never interleave.

State lives in nightfall.store.Store; side effects of transitions live in nightfall.actions.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from nightfall import brief as briefmod
from nightfall import engine, voice
from nightfall.actions import emit as _emit
from nightfall.actions import run_actions as _run_actions
from nightfall.escalation import LADDER
from nightfall.household import TreeMember, load
from nightfall.integrations import anthropic_llm, cartesia, twilio
from nightfall.api_voice import router as voice_router
from nightfall.store import ROOT, Store

PUBLIC_URL = os.environ.get("PUBLIC_URL", "http://127.0.0.1:8000")
MAX_FRAME = 200 * 1024


store = Store()


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    store.tick_task = asyncio.create_task(_ticker())
    print("voice pre-synthesis:", voice.pre_synthesize(store.hh))
    try:
        yield
    finally:
        store.tick_task.cancel()
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
        if store.inc is None or store.inc.state == engine.State.CLOSED:
            store.inc = engine.Incident(id=f"INC-{secrets.token_hex(4)}", night_mode=store.night())
        inc = store.inc
        inc.night_mode = store.night()
        store.last_payload = payload
        tr = engine.step(inc, engine.Event(kind, store.now(), payload))
        if kind != "tick" or tr.from_state != tr.to_state:
            _emit(store, {"type": "state", "incident_id": inc.id, "kind": kind, "from": tr.from_state.value,
                   "to": tr.to_state.value, "rule": tr.rule, "detail": tr.detail, "actions": list(tr.actions)})
        await _run_actions(store, tr, inc)
        return {"incident_id": inc.id, "from": tr.from_state.value, "to": tr.to_state.value,
                "rule": tr.rule, "detail": tr.detail, "actions": list(tr.actions)}


async def _ticker() -> None:
    while True:
        await asyncio.sleep(1)
        if store.inc is not None and store.inc.state in (engine.State.DOOR_OPEN, engine.State.ESCALATING):
            await _step("tick", {})


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "mock": {"cartesia": not cartesia.enabled(), "anthropic": not anthropic_llm.enabled(),
                                 "apify": True, "twilio": not twilio.enabled()},
            "now": store.now().isoformat(), "night_mode": store.night()}


@app.get("/state")
async def state() -> dict[str, Any]:
    inc = store.inc
    return {
        "household": {"person_name": store.hh.person_name, "caregiver_name": store.hh.caregiver_name,
                      "tree": [m.__dict__ for m in store.hh.tree]},
        "now": store.now().isoformat(), "night_mode": store.night(), "ladder": LADDER,
        "incident": None if inc is None else {"id": inc.id, "state": inc.state.value,
                                              "exited_at": inc.exited_at.isoformat() if inc.exited_at else None,
                                              "deadline_at": inc.deadline_at.isoformat() if inc.deadline_at else None,
                                              "acked_by": inc.acked_by},
        "log": store.log[-50:], "rings": store.runner.rings,
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
    m = TreeMember(id=f"TM-{secrets.token_hex(3)}", name=body.name, phone=body.phone, tier=body.tier)
    store.hh = store.hh.with_member(m)
    _emit(store, {"type": "tree", "member": m.__dict__})
    return {"member_id": m.id, "phone_url": f"{PUBLIC_URL}/phone.html#{m.id}"}


@app.post("/frames/{incident_id}")
async def frames(incident_id: str, request: Request) -> dict[str, Any]:
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
    return {"frame_ids": [f"FR-{i}" for i in range(len(store.frames[incident_id]))]}


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
            except asyncio.TimeoutError:
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
    store.inc, store.log, store.frames, store.briefs = None, [], {}, {}
    store.history, store.frame_bytes = [], {}
    store.runner.rings.clear()
    store.hh = load(ROOT / "data" / "household.json")
    store.hub.publish("dashboard", {"type": "reset"})
    return {"ok": True}


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(ROOT / "static" / "dashboard.html")


app.include_router(voice_router)
app.mount("/", StaticFiles(directory=str(ROOT / "static")), name="static")
