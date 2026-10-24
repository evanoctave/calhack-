"""Morning report endpoints. Read-only over the wander history; the alert flow never calls these."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter

from nightfall import report, voice

router = APIRouter()


def _store() -> Any:
    from nightfall.api import store

    return store


@router.get("/report")
async def get_report() -> dict[str, Any]:
    store = _store()
    return await asyncio.to_thread(report.build, store.hh, store.now())


@router.post("/report/listen")
async def listen() -> dict[str, Any]:
    """The summary in the family's voice (Cartesia, cached), or the phone's own speech in mock mode."""
    store = _store()
    r = await asyncio.to_thread(report.build, store.hh, store.now())
    return {
        "ok": True,
        "summary": r["summary"],
        "audio": await asyncio.to_thread(voice.say, r["summary"], store.hh.persona),
    }
