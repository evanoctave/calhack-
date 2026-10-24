"""Side effects of engine transitions: speak, capture frames, build brief, ring, cancel, banner.

Kept apart from the engine (pure) and the routes (HTTP). The voice lane swaps the speak action for
Cartesia audio and the ring action for the Twilio call agent without touching engine.py.
"""

from __future__ import annotations

import asyncio
from typing import Any

from nightfall import brief as briefmod
from nightfall import engine, llm, voice
from nightfall.script import SCRIPT, fill
from nightfall.store import Store


def emit(store: Store, obj: dict[str, Any]) -> None:
    """Append to the log and push to the dashboard channel."""
    obj.setdefault("ts", store.now().isoformat())
    store.log.append(obj)
    store.hub.publish("dashboard", obj)


async def run_actions(store: Store, tr: engine.Transition, inc: engine.Incident) -> None:
    """Execute every action named by a transition, in order."""
    for a in tr.actions:
        if a == "speak:open":
            store.history = []
            _speak(store, fill(SCRIPT["open"], store.hh), "script")
        elif a == "speak:again":
            if store.takeover_by:
                emit(store, {"type": "takeover_skip", "by": store.takeover_by})
                continue
            reply = str(tr_payload(tr, inc, store).get("text", "")) if tr.detail != "auto line" else ""
            hits: list[str] = []
            if reply:
                store.history.append(("person", reply))
                hits = [h["text"] for h in await store.memory.search(reply, 2)]
                emit(store, {"type": "memory", "query": reply, "hits": hits, "source": store.memory.source})
            line, source = llm.next_line(store.hh, store.history, hits)
            _speak(store, line, source)
        elif a == "notify:stand_down":
            who = inc.checkin_who or ("another person" if inc.identity == "other" else "someone")
            for m in store.hh.tree:
                store.hub.publish(
                    f"phone:{m.id}", {"type": "stand_down", "incident_id": inc.id, "who": who, "detail": tr.detail}
                )
            emit(store, {"type": "stand_down", "incident_id": inc.id, "who": who, "detail": tr.detail})
        elif a == "notify:watch_only":
            for m in store.hh.tree:
                store.hub.publish(f"phone:{m.id}", {"type": "watch_only", "incident_id": inc.id, "detail": tr.detail})
            emit(store, {"type": "watch_only", "incident_id": inc.id, "detail": tr.detail})
        elif a == "notify:returned":
            for m in store.hh.tree:
                store.hub.publish(f"phone:{m.id}", {"type": "returned", "incident_id": inc.id})
            emit(store, {"type": "returned", "incident_id": inc.id})
        elif a == "capture_exit_frames":
            store.hub.publish("dashboard", {"type": "exit_frames_request", "incident_id": inc.id})
        elif a == "build_brief":
            clothing = llm.describe_clothing(store.frame_bytes.get(inc.id))
            habits = await store.memory.search("where does he go when he leaves at night", 3)
            store.briefs[inc.id] = briefmod.build(
                store.hh,
                inc,
                clothing,
                store.places,
                store.frames.get(inc.id, []),
                store.now(),
                habits,
                store.memory.source,
            )
            emit(store, {"type": "brief_ready", "incident_id": inc.id})
        elif a == "start_escalation":
            t = (inc.exited_at or store.now()).strftime("%I:%M %p").lstrip("0")
            msg = f"{store.hh.person_name} has left the house at {t}. Open the brief."
            await store.runner.start(inc.id, store.hh, msg)
        elif a == "cancel_escalation":
            await store.runner.cancel(inc.id)
        elif a == "banner:call_911":
            for m in store.hh.tree:
                store.hub.publish(f"phone:{m.id}", {"type": "deadline", "incident_id": inc.id})
        elif a == "delete_frames":
            store.frames.pop(inc.id, None)


def _speak(store: Store, line: str, source: str) -> None:
    """Resolve audio for a line (Cartesia or browser TTS) and push it to the dashboard."""
    store.history.append(("system", line))
    ref = voice.say(line, store.hh.persona)
    emit(
        store,
        {
            "type": "speak",
            "text": line,
            "mode": ref["mode"],
            "url": ref["url"],
            "voice_source": ref["source"],
            "line_source": source,
        },
    )


def tr_payload(tr: engine.Transition, inc: engine.Incident, store: Store) -> dict[str, Any]:
    """The payload of the event that caused this transition (kept on the store by the API layer)."""
    return store.last_payload


async def _clothing_now(store: Store, incident_id: str) -> dict[str, Any]:
    """Clothing for the brief without stalling the ring: ready result, a short wait, or 'see photo'."""
    task = store.vision_tasks.get(incident_id)
    if task is not None and not task.done():
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=0.8)
        except Exception as e:  # noqa: BLE001
            print(f"vision not ready for the ring: {type(e).__name__}")
    if incident_id in store.clothing:
        return store.clothing[incident_id]
    if incident_id not in store.frame_bytes and not llm.anthropic_llm.enabled():
        return briefmod.mock_clothing()
    return briefmod.coerce_clothing({"confidence": 0.0, "source": "pending"})


def start_vision(store: Store, incident_id: str) -> None:
    """Describe the exit frame in the background; patch the brief when the result lands."""
    if incident_id in store.vision_tasks and not store.vision_tasks[incident_id].done():
        return

    async def run() -> None:
        try:
            c = await asyncio.to_thread(llm.describe_clothing, store.frame_bytes.get(incident_id))
            store.clothing[incident_id] = c
            from nightfall.rules import attire_is_night

            if store.inc is not None and store.inc.id == incident_id:
                store.inc.attire_night = attire_is_night(c)
                emit(
                    store,
                    {
                        "type": "features",
                        "incident_id": incident_id,
                        "attire_night": store.inc.attire_night,
                        "score": store.inc.verdict().score,
                        "reasons": list(store.inc.verdict().reasons),
                    },
                )
            b = store.briefs.get(incident_id)
            if b is not None:
                b["clothing"], b["clothing_line"] = c, briefmod.clothing_line(c)
                b["prose"] = briefmod.prose(store.hh, b["last_seen_hhmm"], b["clothing_line"])
                for m in store.hh.tree:
                    store.hub.publish(f"phone:{m.id}", {"type": "brief_updated", "incident_id": incident_id})
            emit(
                store,
                {
                    "type": "clothing",
                    "incident_id": incident_id,
                    "line": briefmod.clothing_line(c),
                    "confidence": c["confidence"],
                    "source": c["source"],
                },
            )
        finally:
            store.vision_tasks.pop(incident_id, None)

    store.vision_tasks[incident_id] = asyncio.create_task(run())
