"""Voice in and out. say() returns an AudioRef the page can play; hear() turns audio into text.

Real mode: Cartesia Sonic WAV cached by sha1 under out/voice (LRU 64) so the door never waits on the
network; every scripted line is pre-synthesized at boot. Mock mode: the browser speaks the text with
SpeechSynthesis. Rejected: streaming WebSocket TTS (more moving parts; lines are short and cacheable).
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any, Final, TypedDict

from nightfall.household import Household
from nightfall.integrations import cartesia
from nightfall.script import SCRIPT, fill

OUT: Final = Path(os.environ.get("VOICE_CACHE_DIR", "out/voice"))
LRU: Final = 64


class AudioRef(TypedDict):
    mode: str  # "cartesia" | "browser_tts"
    text: str
    url: str  # "/voice/<sha>.wav" when mode == cartesia
    source: str  # "cartesia" | "mock"


def _key(text: str, voice_id: str) -> str:
    speed, emotion = style()
    return hashlib.sha1(f"{voice_id}|{speed}|{emotion}|{text}".encode()).hexdigest()


def cached_path(text: str, voice_id: str) -> Path:
    """Where the WAV for this line lives (may not exist yet)."""
    return OUT / f"{_key(text, voice_id)}.wav"


def _prune() -> None:
    files = sorted(OUT.glob("*.wav"), key=lambda p: p.stat().st_mtime)
    for p in files[:-LRU]:
        p.unlink(missing_ok=True)


def style() -> tuple[float, str]:
    """Speed and emotion for the caregiver voice; VOICE_SPEED and VOICE_EMOTION env, defaults 1.0 / happy."""
    try:
        speed = float(os.environ.get("VOICE_SPEED", "1.0"))
    except ValueError:
        speed = 1.0
    return speed, os.environ.get("VOICE_EMOTION", "happy")


def select(voice_id: str, speed: float, emotion: str, env_path: str | Path = ".env") -> None:
    """Switch the caregiver voice at runtime and persist it to .env (key stays untouched)."""
    os.environ["CARTESIA_VOICE_ID"] = voice_id
    os.environ["VOICE_SPEED"] = str(speed)
    os.environ["VOICE_EMOTION"] = emotion
    path = Path(env_path)
    if not path.exists():
        return
    lines = path.read_text().splitlines()
    want = {"CARTESIA_VOICE_ID": voice_id, "VOICE_SPEED": str(speed), "VOICE_EMOTION": emotion}
    seen: set[str] = set()
    for i, ln in enumerate(lines):
        k = ln.split("=", 1)[0].strip()
        if k in want:
            lines[i] = f"{k}={want[k]}"
            seen.add(k)
    lines += [f"{k}={v}" for k, v in want.items() if k not in seen]
    path.write_text("\n".join(lines) + "\n")


def say(text: str, persona: str = "caregiver_clone") -> AudioRef:
    """Return playable audio for one line. Falls back to browser TTS on any failure."""
    mock: AudioRef = {"mode": "browser_tts", "text": text, "url": "", "source": "mock"}
    if not cartesia.enabled():
        return mock
    voice_id = (
        os.environ.get("CARTESIA_VOICE_ID", "")
        if persona == "caregiver_clone"
        else os.environ.get("CARTESIA_ASSISTANT_VOICE_ID", os.environ.get("CARTESIA_VOICE_ID", ""))
    )
    path = cached_path(text, voice_id)
    try:
        if not path.exists():
            OUT.mkdir(parents=True, exist_ok=True)
            speed, emotion = style()
            path.write_bytes(cartesia.tts_wav(text, voice_id, speed=speed, emotion=emotion))
            _prune()
        return {"mode": "cartesia", "text": text, "url": f"/voice/{path.name}", "source": "cartesia"}
    except Exception as e:  # noqa: BLE001 - any vendor failure degrades to mock
        print(f"cartesia fallback: {e}")
        return mock


def hear(audio: bytes | None, typed: str | None = None) -> str:
    """Transcribe the person's reply. Typed text wins (dashboard); audio goes to Ink when enabled."""
    if typed:
        return typed.strip()
    if audio and cartesia.enabled():
        try:
            return cartesia.stt(audio)
        except Exception as e:  # noqa: BLE001
            print(f"cartesia stt fallback: {e}")
    return ""


def pre_synthesize(hh: Household) -> dict[str, Any]:
    """Warm the cache for every scripted line. Returns {line_key: mode}."""
    return {k: say(fill(v, hh))["mode"] for k, v in SCRIPT.items()}
