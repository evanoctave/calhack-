"""Side effects of engine transitions: speak, capture frames, build brief, ring, cancel, banner.

Kept apart from the engine (pure) and the routes (HTTP). The voice lane swaps the speak action for
Cartesia audio and the ring action for the Twilio call agent without touching engine.py.
"""
from __future__ import annotations

import asyncio
from typing import Any

from nightfall import brief as briefmod
from nightfall import engine
from nightfall import vision
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
        if a.startswith("speak:"):
            line = fill(SCRIPT[a.split(":")[1]], store.hh)
            emit(store, {"type": "speak", "text": line, "mode": "browser_tts"})
        elif a == "capture_exit_frames":
            store.hub.publish("dashboard", {"type": "exit_frames_request", "incident_id": inc.id})
        elif a == "build_brief":
            store.briefs[inc.id] = briefmod.build(store.hh, inc, briefmod.mock_clothing(), store.places,
                                                  store.frames.get(inc.id, []), store.now())
            emit(store, {"type": "brief_ready", "incident_id": inc.id})
            schedule_description(store, inc.id)
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




def schedule_description(store: Store, incident_id: str) -> None:
    """Start the vision call once per incident, whichever lands last: the frames or the brief.

    The brief is built at exit but frames arrive afterwards on their own request, so neither event
    is reliably last. Both call this; the guards below make it idempotent.
    """
    if incident_id in store.described or incident_id in store.vision_tasks:
        return
    if not store.frames.get(incident_id) or incident_id not in store.briefs:
        return
    store.vision_tasks[incident_id] = asyncio.create_task(_describe(store, incident_id))


async def _describe(store: Store, incident_id: str) -> None:
    """Describe the frame closest to the exit and patch the brief in place.

    The brief is already on every phone with the fixture in it; this only replaces the clothing.
    The SDK call is synchronous, so it runs in a thread: blocking here would stall SSE and the
    one second ticker for the length of the call.
    """
    try:
        frames = store.frames.get(incident_id) or []
        report = await asyncio.to_thread(vision.describe_clothing, frames[-1])
        b = store.briefs.get(incident_id)
        if b is not None:
            b["clothing"] = report.brief
            b["clothing_line"] = briefmod.clothing_line(report.brief)
            emit(store, {"type": "brief_ready", "incident_id": incident_id,
                         "clothing_source": report.source, "clothing_line": b["clothing_line"]})
        store.described.add(incident_id)
    except asyncio.CancelledError:
        raise
    except Exception as e:  # the brief keeps the fixture; never take the demo down
        print(f"describe_exit_frame fallback: {type(e).__name__}: {e}")
    finally:
        store.vision_tasks.pop(incident_id, None)


async def cancel_descriptions(store: Store) -> None:
    """Cancel every in-flight vision call. Used by /reset and shutdown."""
    for task in list(store.vision_tasks.values()):
        task.cancel()
    for task in list(store.vision_tasks.values()):
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
    store.vision_tasks.clear()
    store.described.clear()
