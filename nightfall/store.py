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


def places_file() -> Path:
    """PLACES_FILE wins; else the setup page's live cache if present; else the SF Marina fixture."""
    env = os.environ.get("PLACES_FILE")
    if env:
        return Path(env)
    custom = ROOT / "data" / "places.custom.live.json"
    return custom if custom.exists() else ROOT / "data" / "places.marina.json"


class Store:
    """All mutable demo state."""

    def __init__(self) -> None:
        self.hh: Household = load(ROOT / "data" / "household.json")
        self.places = briefmod.load_places(places_file())
        self.memory = Memory(self.hh)
        self.inc: engine.Incident | None = None
        self.log: list[dict[str, Any]] = []
        self.frames: dict[str, list[str]] = {}
        self.briefs: dict[str, dict[str, Any]] = {}
        self.history: list[tuple[str, str]] = []
        self.last_payload: dict[str, Any] = {}
        self.frame_bytes: dict[str, bytes] = {}
        self.latest_frame: bytes = b""
        self.clothing: dict[str, dict[str, Any]] = {}
        self.vision_tasks: dict[str, asyncio.Task[None]] = {}
        self.latest_frame_at: float = 0.0
        self.takeover_by: str | None = None
        self.takeover_explicit: bool = False
        self.call_911_sent: bool = False
        self.voice_source: str = "clone" if os.environ.get("VOICE_IS_CLONE") == "1" else "stock"
        self.voice_name: str = os.environ.get("VOICE_NAME", "")
        self.night_mode: bool = True
        self.quiet_until: Any = None  # after a family member says he's safe, re-entries don't restart the door
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
