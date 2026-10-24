"""Notifiers. SSE pushes a ring to each member's phone page; Twilio (voice lane) sits behind the same
interface and falls back to SSE.
"""
from __future__ import annotations

import asyncio
from typing import Any, Callable

from nightfall.household import TreeMember

LinkFn = Callable[[str, str], str]  # (incident_id, member_id) -> brief url


class Hub:
    """Bounded SSE fan-out. channel -> set of queues; queues pruned on disconnect."""

    def __init__(self, maxsize: int = 100) -> None:
        self._subs: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}
        self._maxsize = maxsize

    def subscribe(self, channel: str) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self._maxsize)
        self._subs.setdefault(channel, set()).add(q)
        return q

    def unsubscribe(self, channel: str, q: asyncio.Queue[dict[str, Any]]) -> None:
        subs = self._subs.get(channel)
        if subs is not None:
            subs.discard(q)
            if not subs:
                self._subs.pop(channel, None)

    def publish(self, channel: str, obj: dict[str, Any]) -> None:
        for q in list(self._subs.get(channel, ())):
            if q.full():
                q.get_nowait()
            q.put_nowait(obj)

    def count(self) -> int:
        """Total live subscribers (leak check)."""
        return sum(len(s) for s in self._subs.values())


class SseNotifier:
    """Rings phone pages over SSE. Also mirrors every ring to the dashboard log."""

    def __init__(self, hub: Hub, link: LinkFn) -> None:
        self._hub = hub
        self._link = link

    async def ring(self, members: list[TreeMember], message: str, incident_id: str, tier: int) -> None:
        for m in members:
            self._hub.publish(
                f"phone:{m.id}",
                {"type": "ring", "message": message, "link": self._link(incident_id, m.id),
                 "incident_id": incident_id, "tier": tier},
            )
        self._hub.publish(
            "dashboard",
            {"type": "ring", "tier": tier, "members": [m.name for m in members], "source": "sse"},
        )
