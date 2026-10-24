"""Voice-lane routes: TwiML for the Twilio call agent, the phone-page agent turn, cached voice files.

TwiML flow: Twilio POSTs /twiml/{inc}/{member} -> we speak the opening and <Gather input="speech">;
the caller's words POST to /twiml/{inc}/{member}/turn -> call_agent.handle -> speak reply, loop or hang up.
"""

from __future__ import annotations

import asyncio
from typing import Any
from xml.sax.saxutils import escape

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from nightfall import call_agent, voice
from nightfall.store import PUBLIC_URL

router = APIRouter()


def _store() -> Any:
    from nightfall.api import store

    return store


def _twiml(say: str, gather_url: str | None, hangup: bool, *, use_cartesia: bool = True) -> Response:
    ref = voice.say(say, "assistant") if use_cartesia else None
    inner = (
        f"<Play>{escape(PUBLIC_URL + ref['url'])}</Play>"
        if ref is not None and ref["mode"] == "cartesia"
        else f'<Say voice="Polly.Joanna">{escape(say)}</Say>'
    )
    if hangup or gather_url is None:
        body = f"<Response>{inner}<Hangup/></Response>"
    else:
        body = (
            f'<Response><Gather input="speech" action="{escape(gather_url)}" method="POST" '
            f'speechTimeout="auto" timeout="6">{inner}</Gather>'
            f"<Say>I did not hear anything. The brief is on your phone. Goodbye.</Say></Response>"
        )
    return Response(content='<?xml version="1.0" encoding="UTF-8"?>' + body, media_type="application/xml")


def _ctx(incident_id: str, member_id: str) -> tuple[Any, dict[str, Any], str]:
    store = _store()
    b = store.briefs.get(incident_id)
    m = store.hh.member(member_id)
    if b is None or m is None:
        raise HTTPException(404, "no such incident or member")
    return store, b, m.name


@router.post("/twiml/{incident_id}/{member_id}")
async def twiml_open(incident_id: str, member_id: str) -> Response:
    store, b, name = _ctx(incident_id, member_id)
    store.log.append(
        {
            "type": "call",
            "incident_id": incident_id,
            "member_id": member_id,
            "intent": "opening",
            "ts": store.now().isoformat(),
        }
    )
    return _twiml(
        call_agent.opening(store.hh, b, name),
        f"{PUBLIC_URL}/twiml/{incident_id}/{member_id}/turn",
        False,
        use_cartesia=False,
    )


@router.post("/twiml/{incident_id}/{member_id}/turn")
async def twiml_turn(incident_id: str, member_id: str, request: Request) -> Response:
    store, b, name = _ctx(incident_id, member_id)
    form = await request.form()
    text = str(form.get("SpeechResult", ""))
    r = await asyncio.to_thread(call_agent.handle, store.hh, b, name, text)
    store.log.append(
        {
            "type": "call",
            "incident_id": incident_id,
            "member_id": member_id,
            "heard": text,
            "intent": r.intent,
            "ts": store.now().isoformat(),
        }
    )
    store.hub.publish("dashboard", {"type": "call", "member_id": member_id, "heard": text, "intent": r.intent})
    if r.ack:
        await _ack(store, incident_id, member_id)
    return await asyncio.to_thread(_twiml, r.say, f"{PUBLIC_URL}/twiml/{incident_id}/{member_id}/turn", r.done)


class AnswerIn(BaseModel):
    incident_id: str
    member_id: str


@router.post("/answer")
async def answer(body: AnswerIn) -> dict[str, Any]:
    """A relative picked up the web call. Logged and shown on the dashboard."""
    store, _b, name = _ctx(body.incident_id, body.member_id)
    from nightfall.actions import emit

    emit(store, {"type": "answered", "incident_id": body.incident_id, "member_id": body.member_id, "by": name})
    return {"ok": True}


class TurnIn(BaseModel):
    incident_id: str
    member_id: str
    text: str


@router.post("/agent/turn")
async def agent_turn(body: TurnIn) -> dict[str, Any]:
    """Phone-page agent (browser STT in, TTS out). Same brain as the Twilio call."""
    store, b, name = _ctx(body.incident_id, body.member_id)
    r = await asyncio.to_thread(call_agent.handle, store.hh, b, name, body.text)
    store.hub.publish(
        "dashboard", {"type": "call", "member_id": body.member_id, "heard": body.text, "intent": r.intent}
    )
    if r.ack:
        await _ack(store, body.incident_id, body.member_id)
    return {
        "say": r.say,
        "intent": r.intent,
        "done": r.done,
        "ack": r.ack,
        "audio": await asyncio.to_thread(voice.say, r.say, "assistant"),
    }


@router.get("/agent/opening/{incident_id}/{member_id}")
async def agent_opening(incident_id: str, member_id: str) -> dict[str, Any]:
    store, b, name = _ctx(incident_id, member_id)
    say = call_agent.opening(store.hh, b, name)
    return {"say": say, "audio": await asyncio.to_thread(voice.say, say, "assistant")}


async def _ack(store: Any, incident_id: str, member_id: str) -> None:
    from nightfall.api import AckIn, ack

    try:
        await ack(AckIn(incident_id=incident_id, member_id=member_id))
    except HTTPException as e:
        print(f"ack on a superseded incident ignored: {e.detail}")


class VoiceSelectIn(BaseModel):
    voice_id: str
    speed: float = 1.0
    emotion: str = "happy"


@router.post("/voice/select")
async def voice_select(body: VoiceSelectIn) -> dict[str, Any]:
    """Switch the door voice now; re-synthesizes the script lines in the background."""
    import asyncio
    import os

    store = _store()
    if not 0.6 <= body.speed <= 1.5 or len(body.voice_id) < 8:
        raise HTTPException(422, "bad voice settings")
    voice.select(body.voice_id, body.speed, body.emotion, os.environ.get("ENV_FILE", ".env"))
    asyncio.get_running_loop().run_in_executor(None, voice.pre_synthesize, store.hh)
    from nightfall.actions import emit

    emit(store, {"type": "voice", "voice_id": body.voice_id[:8], "speed": body.speed, "emotion": body.emotion})
    return {"ok": True, "voice_id": body.voice_id, "speed": body.speed, "emotion": body.emotion}


@router.get("/voice/current")
async def voice_current() -> dict[str, Any]:
    import os

    speed, emotion = voice.style()
    return {
        "voice_id": os.environ.get("CARTESIA_VOICE_ID", ""),
        "speed": speed,
        "emotion": emotion,
        "mock": not voice.cartesia.enabled(),
    }


@router.get("/voice/{name}")
async def voice_file(name: str) -> FileResponse:
    if not name.endswith(".wav") or "/" in name or ".." in name:
        raise HTTPException(404, "no")
    path = voice.OUT / name
    if not path.exists():
        raise HTTPException(404, "no")
    return FileResponse(path, media_type="audio/wav")
