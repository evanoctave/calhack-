"""Measure the demo timings from the running server's event log.

Usage: .venv/bin/python scripts/timings.py [http://localhost:8000]
Run the demo several times without /reset in between (tap Start between runs), then run this.
Per run: person enters frame -> first spoken word; person leaves frame -> first ring; first ring -> family
answers (call opening or brief opened).
"""

from __future__ import annotations

import statistics
import sys
from datetime import datetime

import httpx


def ts(e: dict) -> datetime:
    return datetime.fromisoformat(e["ts"])


def main() -> int:
    base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
    log = httpx.get(f"{base}/log", timeout=10).json()
    enter_word, lost_ring, ring_answer = [], [], []
    present = lost = ring = None
    for e in log:
        t, ev = e.get("type"), e.get("event")
        if t == "door" and ev == "person_present":
            present = ts(e)
        elif t == "door" and ev == "audio_playing" and present:
            enter_word.append((ts(e) - present).total_seconds())
            present = None
        elif t == "door" and ev == "person_absent":
            lost, ring = ts(e), None
        elif t == "ring" and lost and ring is None:
            ring = ts(e)
            lost_ring.append((ring - lost).total_seconds())
            lost = None
        elif t in ("call", "answered") and ring and (e.get("intent") in ("opening", None)):
            ring_answer.append((ts(e) - ring).total_seconds())
            ring = None

    def row(name: str, xs: list[float]) -> None:
        if xs:
            print(
                f"{name:34s} n={len(xs)}  median {statistics.median(xs):5.2f} s  (min {min(xs):.2f}, max {max(xs):.2f})"
            )
        else:
            print(f"{name:34s} no samples")

    row("enters frame -> first spoken word", enter_word)
    row("leaves frame -> first ring", lost_ring)
    row("first ring -> family answers", ring_answer)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
