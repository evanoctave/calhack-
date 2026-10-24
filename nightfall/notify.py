"""Notifiers. SSE pushes a ring to each member's phone page; Twilio (voice lane) sits behind the same
interface and falls back to SSE.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

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

    def __init__(self, hub: Hub, link: LinkFn, log: list[dict[str, Any]] | None = None) -> None:
        self._hub = hub
        self._link = link
        self._log = log

    async def ring(self, members: list[TreeMember], message: str, incident_id: str, tier: int) -> None:
        for m in members:
            self._hub.publish(
                f"phone:{m.id}",
                {
                    "type": "ring",
                    "message": message,
                    "link": self._link(incident_id, m.id),
                    "incident_id": incident_id,
                    "tier": tier,
                },
            )
        self._record({"type": "ring", "tier": tier, "members": [m.name for m in members], "source": "sse"})

    def _record(self, obj: dict[str, Any]) -> None:
        """Push to the dashboard and keep it in the persistent log when one is attached."""
        if self._log is not None:
            from datetime import datetime

            obj.setdefault("ts", datetime.now().astimezone().isoformat())
            self._log.append(obj)
        self._hub.publish("dashboard", obj)


class TwilioNotifier:
    """Calls members with an E.164 phone through the TwiML agent and texts the link; SSE always runs too."""

    def __init__(self, hub: Hub, link: LinkFn, public_url: str, log: list[dict[str, Any]] | None = None) -> None:
        self._sse = SseNotifier(hub, link, log)
        self._hub = hub
        self._link = link
        self._public = public_url

    async def ring(self, members: list[TreeMember], message: str, incident_id: str, tier: int) -> None:
        await self._sse.ring(members, message, incident_id, tier)
        from nightfall.integrations import twilio

        for m in members:
            if not m.phone.startswith("+"):
                continue
            result = "called"
            try:
                await asyncio.to_thread(twilio.create_call, m.phone, f"{self._public}/twiml/{incident_id}/{m.id}")
            except Exception as e:  # noqa: BLE001
                print(f"twilio fallback: {e}")
                result = f"sse only: {e}"
            try:  # US texts need carrier (A2P) registration; a failed text never undoes the call
                await asyncio.to_thread(twilio.send_sms, m.phone, f"{message} {self._link(incident_id, m.id)}")
            except Exception as e:  # noqa: BLE001
                print(f"twilio sms skipped: {e}")
            self._sse._record({"type": "ring", "tier": tier, "members": [m.name], "source": "twilio", "result": result})
