"""All mutable demo state in one object so tests can reset it.

Rejected: SQLite tonight; the light demo needs no persistence. docs/DATA-MODEL.md lists the tables
the core lane adds next.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from nightfall import brief as briefmod
from nightfall import engine
from nightfall.escalation import Runner
from nightfall.household import Household, in_window, load
from nightfall.integrations import twilio
from nightfall.memory import Memory
from nightfall.notify import Hub, SseNotifier, TwilioNotifier

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_URL = os.environ.get("PUBLIC_URL") or "http://127.0.0.1:8000"


class Store:
    """All mutable demo state."""

    def __init__(self) -> None:
        self.hh: Household = load(ROOT / "data" / "household.json")
        self.places = briefmod.load_places(os.environ.get("PLACES_FILE") or ROOT / "data" / "places.fullerton.json")
        self.memory = Memory(self.hh)
        self.inc: engine.Incident | None = None
        self.log: list[dict[str, Any]] = []
        self.frames: dict[str, list[str]] = {}
        self.briefs: dict[str, dict[str, Any]] = {}
        self.history: list[tuple[str, str]] = []
        self.last_payload: dict[str, Any] = {}
        self.frame_bytes: dict[str, bytes] = {}
        self.latest_frame: bytes = b""
        self.latest_frame_at: float = 0.0
        self.takeover_by: str | None = None
        self.call_911_sent: bool = False
        self.night_mode: bool = True
        self.hub = Hub()
        notifier = (
            TwilioNotifier(self.hub, self.link, PUBLIC_URL, self.log)
            if twilio.enabled()
            else SseNotifier(self.hub, self.link, self.log)
        )
        self.runner = Runner(notifier)
        self.lock = asyncio.Lock()
        self.tick_task: asyncio.Task[None] | None = None
        self.memory_task: asyncio.Task[None] | None = None

    def places_source(self) -> str:
        return str(self.places[0].get("source", "fixture")) if self.places else "none"

    def now(self) -> datetime:
        return datetime.now().astimezone()

    def link(self, incident_id: str, member_id: str) -> str:
        return f"{PUBLIC_URL}/brief.html#{briefmod.mint(incident_id, member_id, self.now())}"

    def night(self) -> bool:
        return self.night_mode or in_window(self.now().time(), self.hh.night_start, self.hh.night_end)
