"""Exit frames written to disk, named by incident and timestamp.

The brief keeps frames in memory as data URIs; this is the durable copy a searcher can hand to
police. Every function here swallows its own errors: a full or read-only disk must never take the
demo down, so a failed write returns None and says why. Rejected: writing through the store; the
path has to be computable from an incident id alone for the ExitEvent to carry it.
"""
from __future__ import annotations

import os
import re
from datetime import datetime
from pathlib import Path
from typing import Final

DEFAULT_DIR: Final[str] = "out/snapshots"
MAX_BYTES: Final[int] = 200 * 1024
_UNSAFE: Final[re.Pattern[str]] = re.compile(r"[^A-Za-z0-9_-]")


def root() -> Path:
    """Snapshot root, read at call time so a test can redirect it without reimporting."""
    return Path(os.environ.get("SNAPSHOT_DIR", DEFAULT_DIR))


def safe_id(incident_id: str) -> str:
    """Strip an incident id down to path-safe characters. It arrives from the URL, so it is hostile."""
    cleaned = _UNSAFE.sub("", incident_id)[:64]
    return cleaned or "unknown"


def stamp(now: datetime) -> str:
    """Filesystem-safe timestamp. Colons are legal on macOS and a problem everywhere else."""
    return now.strftime("%Y-%m-%dT%H-%M-%S")


def save(incident_id: str, jpeg: bytes, now: datetime, index: int = 0) -> Path | None:
    """Write one frame. Returns the path, or None if anything at all went wrong."""
    if not jpeg:
        return _failed("empty frame")
    if len(jpeg) > MAX_BYTES:
        return _failed(f"frame over {MAX_BYTES // 1024} KB")
    base = root().resolve()
    target = (base / safe_id(incident_id) / f"{stamp(now)}-{index}.jpg").resolve()
    if not target.is_relative_to(base):
        return _failed(f"path escapes {base}")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(jpeg)
    except OSError as e:
        return _failed(f"{type(e).__name__}: {e}")
    return target


def save_all(incident_id: str, frames: list[bytes], now: datetime) -> list[str]:
    """Write every frame, skipping the ones that fail. Returns the paths that landed."""
    saved = [save(incident_id, f, now, i) for i, f in enumerate(frames)]
    return [str(p) for p in saved if p is not None]


def latest(paths: list[str]) -> str | None:
    """The frame closest to the exit: the one the ExitEvent carries."""
    return paths[-1] if paths else None


def _failed(reason: str) -> None:
    print(f"snapshot fallback: {reason}")
    return None
