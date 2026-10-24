"""Wander history: one line per closed incident, persisted to data/history.json.

Police ask whether this has happened before, where the person was found and how long it took. The
brief answers from this file. Only outcome facts are stored, never frames.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

FILE = Path(os.environ.get("HISTORY_FILE", "data/history.json"))


def load() -> list[dict[str, Any]]:
    try:
        return list(json.loads(FILE.read_text())) if FILE.exists() else []
    except (OSError, ValueError):
        return []


def record(
    incident_id: str,
    opened_at: datetime | None,
    exited_at: datetime | None,
    closed_at: datetime,
    outcome: str,
    heading: str,
    acked_by: str | None,
    score: int,
    cause: str = "door",
) -> dict[str, Any]:
    """Append one closed incident. Outcome: returned | acked | exhausted | stand_down | watch_only | visitor | sos."""
    row = {
        "incident_id": incident_id,
        "cause": cause,
        "opened_at": opened_at.isoformat() if opened_at else None,
        "exited_at": exited_at.isoformat() if exited_at else None,
        "closed_at": closed_at.isoformat(),
        "minutes_out": round((closed_at - exited_at).total_seconds() / 60, 1) if exited_at and cause != "help" else 0,
        "outcome": outcome,
        "heading": heading,
        "acked_by": acked_by,
        "score": score,
    }
    rows = load()
    rows.append(row)
    try:
        FILE.parent.mkdir(parents=True, exist_ok=True)
        FILE.write_text(json.dumps(rows[-200:], indent=1) + "\n")
    except OSError as e:
        print(f"history not written: {e}")
    return row


def summary(rows: list[dict[str, Any]], limit: int = 5) -> dict[str, Any]:
    """What police ask: has it happened before, how often, how long, which way."""
    exits = [
        r
        for r in rows
        if r.get("cause", "door") != "help"
        and r.get("exited_at")
        and r.get("outcome") in ("returned", "acked", "exhausted")
    ]
    return {
        "count": len(exits),
        "last": exits[-limit:][::-1],
        "typical_minutes": round(sum(r["minutes_out"] for r in exits) / len(exits), 1) if exits else 0,
        "headings": sorted({r.get("heading", "unknown") for r in exits} - {"unknown"}),
    }
