"""Cartesia Sonic (TTS) and Ink (STT) over HTTP. Verified shapes: POST /tts/bytes, POST /stt."""

from __future__ import annotations

import os
from typing import Final

import httpx

BASE: Final = "https://api.cartesia.ai"
VERSION: Final = os.environ.get("CARTESIA_VERSION", "2026-08-14")
TTS_MODEL: Final = os.environ.get("CARTESIA_TTS_MODEL", "sonic-3")
STT_MODEL: Final = "ink-whisper"


def enabled() -> bool:
    """True when a key and a voice id are configured and MOCK is off."""
    return (
        os.environ.get("MOCK", "1") != "1"
        and bool(os.environ.get("CARTESIA_API_KEY"))
        and bool(os.environ.get("CARTESIA_VOICE_ID"))
    )


def _headers() -> dict[str, str]:
    key = os.environ.get("CARTESIA_API_KEY", "")
    if not key:
        raise RuntimeError("CARTESIA_API_KEY unset")
    return {"Authorization": f"Bearer {key}", "Cartesia-Version": VERSION}


def tts_wav(text: str, voice_id: str | None = None, speed: float = 0.9) -> bytes:
    """Synthesize one line to 24 kHz 16-bit WAV. Raises on any HTTP or network error."""
    vid = voice_id or os.environ.get("CARTESIA_VOICE_ID", "")
    if not vid:
        raise RuntimeError("CARTESIA_VOICE_ID unset")
    body = {
        "model_id": TTS_MODEL,
        "transcript": text,
        "voice": {"mode": "id", "id": vid},
        "output_format": {"container": "wav", "encoding": "pcm_s16le", "sample_rate": 24000},
        "language": "en",
        "generation_config": {"speed": speed, "emotion": "calm"},
    }
    r = httpx.post(f"{BASE}/tts/bytes", headers=_headers(), json=body, timeout=10.0)
    r.raise_for_status()
    return r.content


def stt(audio: bytes, filename: str = "reply.wav") -> str:
    """Transcribe a short clip with Ink. Returns the text; raises on error."""
    r = httpx.post(
        f"{BASE}/stt",
        headers=_headers(),
        timeout=10.0,
        files={"file": (filename, audio, "audio/wav")},
        data={"model": STT_MODEL, "language": "en"},
    )
    r.raise_for_status()
    return str(r.json().get("text", "")).strip()
