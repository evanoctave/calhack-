"""Mutable runtime state, initialized from the saved household profile.

Profiles and care-circle contacts live in JSON; active incidents and their tasks stay in memory.
"""

from __future__ import annotations

import asyncio
import os
import shutil
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


def household_filename() -> str:
    """Use the saved, gitignored household by default; FRESH_START=0 selects the tracked demo household."""
    return "household.live.json" if os.environ.get("FRESH_START", "1") == "1" else "household.json"


def household_path() -> Path:
    return ROOT / "data" / household_filename()


def initialize_household() -> None:
    """Start setup on the first launch; keep saved profiles and phone contacts on subsequent launches."""
    if os.environ.get("FRESH_START", "1") == "1" and not household_path().exists():
        shutil.copyfile(ROOT / "data" / "household.blank.json", household_path())


def places_file() -> Path:
    """PLACES_FILE wins; else the setup page's live cache; else the sample live run; else the sample fixture."""
    env = os.environ.get("PLACES_FILE")
    if env:
        return Path(env)
    for name in ("places.custom.live.json", "places.sample.live.json"):
        if (ROOT / "data" / name).exists():
            return ROOT / "data" / name
    return ROOT / "data" / "places.sample.json"


class Store:
    """All mutable demo state."""

    def __init__(self) -> None:
        initialize_household()
        self.hh: Household = load(household_path())
        # Home still at 0,0 means setup has not run; do not show another area's cached places.
        self.places = [] if (self.hh.home_lat, self.hh.home_lng) == (0.0, 0.0) else briefmod.load_places(places_file())
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
        self.last_open_at: Any = None  # when the door last said its opening line
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
