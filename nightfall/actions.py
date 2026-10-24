"""Side effects of engine transitions: speak, capture frames, build brief, ring, cancel, banner.

Kept apart from the engine (pure) and the routes (HTTP). The voice lane swaps the speak action for
Cartesia audio and the ring action for the Twilio call agent without touching engine.py.
"""
from __future__ import annotations

from typing import Any

from nightfall import brief as briefmod
from nightfall import engine
from nightfall import llm, voice
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
            reply = str(tr_payload(tr, inc, store).get("text", ""))
            store.history.append(("person", reply))
            line, source = llm.next_line(store.hh, store.history, llm.memory_hits(store.hh, reply))
            _speak(store, line, source)
        elif a == "capture_exit_frames":
            store.hub.publish("dashboard", {"type": "exit_frames_request", "incident_id": inc.id})
        elif a == "build_brief":
            clothing = llm.describe_clothing(store.frame_bytes.get(inc.id))
            store.briefs[inc.id] = briefmod.build(store.hh, inc, clothing, store.places,
                                                  store.frames.get(inc.id, []), store.now())
            emit(store, {"type": "brief_ready", "incident_id": inc.id})
        elif a == "start_escalation":
            t = (inc.exited_at or store.now()).strftime("%-I:%M %p")
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
    emit(store, {"type": "speak", "text": line, "mode": ref["mode"], "url": ref["url"],
                 "voice_source": ref["source"], "line_source": source})


def tr_payload(tr: engine.Transition, inc: engine.Incident, store: Store) -> dict[str, Any]:
    """The payload of the event that caused this transition (kept on the store by the API layer)."""
    return store.last_payload
