"""Voice in and out. say() returns an AudioRef the page can play; hear() turns audio into text.

Real mode: Cartesia Sonic WAV cached by sha1 under out/voice (LRU 64) so the door never waits on the
network; every scripted line is pre-synthesized at boot. Mock mode: the browser speaks the text with
SpeechSynthesis. Rejected: streaming WebSocket TTS (more moving parts; lines are short and cacheable).
"""

from __future__ import annotations

import hashlib
import io
import os
import struct
import tempfile
import wave
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
    files = sorted((p for p in OUT.glob("*.wav") if not p.name.endswith(".tel.wav")), key=lambda p: p.stat().st_mtime)
    for p in files[:-LRU]:
        p.unlink(missing_ok=True)
        p.with_suffix(".tel.wav").unlink(missing_ok=True)


def _mulaw(sample: int) -> int:
    """Encode one signed 16-bit PCM sample as G.711 mu-law."""
    sign = 0x80 if sample < 0 else 0
    magnitude = min(abs(sample), 32635) + 0x84
    exponent = magnitude.bit_length() - 8
    return ~(sign | (exponent << 4) | ((magnitude >> (exponent + 3)) & 0x0F)) & 0xFF


def _telephone_wav(raw: bytes) -> bytes:
    # wave locates real RIFF chunks, including odd-length metadata padding. A
    # byte search for "data" can instead match an unrelated metadata value.
    with wave.open(io.BytesIO(raw), "rb") as clip:
        rate, frames = clip.getframerate(), clip.getnframes()
        if clip.getnchannels() != 1 or clip.getsampwidth() != 2 or clip.getcomptype() != "NONE":
            raise ValueError("telephone conversion needs mono 16-bit PCM")
        if rate < 8000 or rate % 8000 or not frames:
            raise ValueError("unsupported or empty PCM rate")
        pcm = clip.readframes(frames)
        if len(pcm) != frames * 2:
            raise ValueError("truncated PCM data")
    step = rate // 8000
    samples = [sample for (sample,) in struct.iter_unpack("<h", pcm)]
    encoded = bytes(_mulaw(sum(samples[i : i + step]) // step) for i in range(0, len(samples) - step + 1, step))
    if not encoded:
        raise ValueError("PCM clip is too short")

    def chunk(name: bytes, body: bytes) -> bytes:
        return name + struct.pack("<I", len(body)) + body + (b"\0" if len(body) % 2 else b"")

    body = (
        b"WAVE"
        + chunk(b"fmt ", struct.pack("<HHIIHHH", 7, 1, 8000, 8000, 1, 8, 0))
        + chunk(b"fact", struct.pack("<I", len(encoded)))
        + chunk(b"data", encoded)
    )
    return b"RIFF" + struct.pack("<I", len(body)) + body


def telephone_url(url: str) -> str:
    """Return a compact 8 kHz mu-law cache URL for Twilio, or the original on failure.

    Browser/door playback keeps its original PCM URL. Conversion never changes
    the selected voice and never invokes a speech provider.
    """
    if not url.startswith("/voice/"):
        return url
    name = url.removeprefix("/voice/")
    if not name.endswith(".wav") or name.endswith(".tel.wav") or "/" in name or "\\" in name or ".." in name:
        return url
    src, dst = OUT / name, (OUT / name).with_suffix(".tel.wav")
    temporary: Path | None = None
    try:
        encoded = _telephone_wav(src.read_bytes())
        if dst.is_file() and dst.read_bytes() == encoded:
            return f"/voice/{dst.name}"
        # Calls may request the same line concurrently. Publish only a complete
        # WAV so a second caller cannot fetch a partially written cache entry.
        with tempfile.NamedTemporaryFile(dir=OUT, prefix=".telephone-", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(encoded)
        os.replace(temporary, dst)
        return f"/voice/{dst.name}"
    except (OSError, EOFError, ValueError, wave.Error, struct.error):
        return url
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def style() -> tuple[float, str]:
    """Speed and emotion for the caregiver voice; VOICE_SPEED and VOICE_EMOTION env, defaults 1.0 / happy."""
    try:
        speed = float(os.environ.get("VOICE_SPEED", "1.0"))
    except ValueError:
        speed = 1.0
    return speed, os.environ.get("VOICE_EMOTION", "happy")


def select(
    voice_id: str, speed: float, emotion: str, env_path: str | Path = ".env", extra: dict[str, str] | None = None
) -> None:
    """Switch the caregiver voice at runtime and persist it to .env (key stays untouched)."""
    os.environ["CARTESIA_VOICE_ID"] = voice_id
    os.environ["VOICE_SPEED"] = str(speed)
    os.environ["VOICE_EMOTION"] = emotion
    for k, v in (extra or {}).items():
        os.environ[k] = v
    path = Path(env_path)
    if not path.exists():
        return
    lines = path.read_text().splitlines()
    want = {"CARTESIA_VOICE_ID": voice_id, "VOICE_SPEED": str(speed), "VOICE_EMOTION": emotion, **(extra or {})}
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
    from nightfall.script import VARIANTS

    out = {
        k: say(fill(v, hh), "assistant" if k.startswith("visitor_") else hh.persona)["mode"] for k, v in SCRIPT.items()
    }
    for k, lines in VARIANTS.items():
        for i, v in enumerate(lines[1:], 2):
            out[f"{k}_{i}"] = say(fill(v, hh), hh.persona)["mode"]
    return out
