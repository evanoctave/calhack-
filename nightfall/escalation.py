"""Escalation ladder runner. One asyncio task per incident; ack sets an Event that stops it.

LADDER is (tier, seconds to wait for an ack before the next tier). Tier 3 is everyone plus the
911 guidance. Rejected: a heap-based scheduler thread; asyncio tasks are cancellable and enough for
one household per process.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Final, Protocol

from nightfall.household import Household, TreeMember

STEP_S: Final[float] = float(os.environ.get("ESCALATION_STEP_S", "60"))
LADDER: Final[tuple[tuple[int, float], ...]] = ((1, STEP_S), (2, STEP_S), (3, 0.0))


class Notifier(Protocol):
    async def ring(self, members: list[TreeMember], message: str, incident_id: str, tier: int) -> None: ...


class Runner:
    """Walks the ladder for an incident until ack, cancel, or the ladder ends."""

    def __init__(self, notifier: Notifier) -> None:
        self._notifier = notifier
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._acks: dict[str, asyncio.Event] = {}
        self.rings: list[dict[str, Any]] = []
        self.acked_by: dict[str, str] = {}

    async def start(self, incident_id: str, hh: Household, message: str) -> None:
        """Begin the ladder. Idempotent per incident."""
        if incident_id in self._tasks:
            return
        self._acks[incident_id] = asyncio.Event()
        self._tasks[incident_id] = asyncio.create_task(self._run(incident_id, hh, message))

    async def ack(self, incident_id: str, member_id: str) -> bool:
        """Record the first ack and stop further rings. Returns False if already acked or unknown."""
        ev = self._acks.get(incident_id)
        if ev is None or ev.is_set():
            return False
        self.acked_by[incident_id] = member_id
        ev.set()
        return True

    async def cancel(self, incident_id: str) -> None:
        """Cancel the ladder task and forget the incident."""
        task = self._tasks.pop(incident_id, None)
        self._acks.pop(incident_id, None)
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    def live(self) -> int:
        """Number of ladder tasks still registered (leak check)."""
        return len(self._tasks)

    async def _run(self, incident_id: str, hh: Household, message: str) -> None:
        ack = self._acks[incident_id]
        try:
            for tier, wait in LADDER:
                members = [m for m in hh.tree if m.tier <= tier] if tier == 3 else hh.members_at(tier)
                self.rings.append({"incident_id": incident_id, "tier": tier, "members": [m.id for m in members]})
                await self._notifier.ring(members, message, incident_id, tier)
                if wait <= 0:
                    break
                try:
                    await asyncio.wait_for(ack.wait(), timeout=wait)
                    return
                except TimeoutError:
                    continue
            await ack.wait()
        finally:
            self._tasks.pop(incident_id, None)
