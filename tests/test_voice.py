import hashlib
import io
import struct
import wave

import httpx
import pytest

from nightfall import voice
from nightfall.household import load
from nightfall.integrations import cartesia


def _wav(pcm: bytes) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(pcm)
    return output.getvalue()


@pytest.mark.parametrize("streaming", [False, True])
def test_cartesia_returns_finalized_wav(monkeypatch, streaming) -> None:
    pcm = b"\x10\x00" * 2400
    original = _wav(pcm)
    metadata = b"LIST" + struct.pack("<I", 4) + b"INFO"
    payload = bytearray(original[:12] + metadata + original[12:])
    data_offset = payload.index(b"data")
    struct.pack_into("<I", payload, 4, 0xFFFFFFFF if streaming else len(payload) - 8)
    if streaming:
        struct.pack_into("<I", payload, data_offset + 4, 0xFFFFFFFF)
    monkeypatch.setenv("CARTESIA_API_KEY", "test-key")

    def fake_post(url, **kwargs):
        return httpx.Response(200, content=bytes(payload), request=httpx.Request("POST", url))

    monkeypatch.setattr(cartesia.httpx, "post", fake_post)
    result = cartesia.tts_wav("Test reply.", "test-voice")
    assert struct.unpack_from("<I", result, 4)[0] == len(result) - 8
    with wave.open(io.BytesIO(result), "rb") as audio:
        assert audio.getnframes() == 2400
        assert audio.getframerate() == 24000
        assert audio.readframes(audio.getnframes()) == pcm


def test_legacy_streaming_cache_is_not_reused(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(voice, "OUT", tmp_path)
    monkeypatch.setenv("CARTESIA_VOICE_ID", "test-voice")
    monkeypatch.setattr(cartesia, "enabled", lambda: True)
    speed, emotion = voice.style()
    legacy_key = hashlib.sha1(f"test-voice|{speed}|{emotion}|Test reply.".encode()).hexdigest()
    (tmp_path / f"{legacy_key}.wav").write_bytes(b"legacy streaming audio")
    synthesized = []

    def synthesize(*args, **kwargs):
        synthesized.append(True)
        return _wav(b"\x10\x00" * 2400)

    monkeypatch.setattr(cartesia, "tts_wav", synthesize)
    result = voice.say("Test reply.", "assistant")
    assert synthesized == [True]
    assert result["mode"] == "cartesia"
    assert result["url"] != f"/voice/{legacy_key}.wav"


def test_mock_say_is_browser_tts_and_no_network() -> None:
    ref = voice.say("Hi Dad.")
    assert ref["mode"] == "browser_tts" and ref["source"] == "mock" and ref["url"] == ""
    assert voice.hear(None, typed=" I want to go ") == "I want to go"
    assert voice.hear(b"abc") == ""


def test_real_path_caches_and_falls_back(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(voice, "OUT", tmp_path)
    monkeypatch.setenv("CARTESIA_VOICE_ID", "v1")
    monkeypatch.setattr(voice.cartesia, "enabled", lambda: True)
    calls = []
    monkeypatch.setattr(voice.cartesia, "tts_wav", lambda text, vid, **kw: calls.append(text) or b"RIFFwav")
    a = voice.say("Hi Dad.")
    b = voice.say("Hi Dad.")
    assert a["mode"] == "cartesia" and a == b and calls == ["Hi Dad."]

    def boom(text, vid, **kw):
        raise RuntimeError("down")

    monkeypatch.setattr(voice.cartesia, "tts_wav", boom)
    assert voice.say("Other line.")["mode"] == "browser_tts"


def test_pre_synthesize_mock() -> None:
    assert set(voice.pre_synthesize(load("data/household.json")).values()) == {"browser_tts"}


def test_select_persists_to_env(monkeypatch, tmp_path) -> None:
    env = tmp_path / ".env"
    env.write_text("MOCK=1\nCARTESIA_VOICE_ID=old\nOTHER=x\n")
    voice.select("new-voice-id", 0.95, "calm", env)
    text = env.read_text()
    assert (
        "CARTESIA_VOICE_ID=new-voice-id" in text
        and "VOICE_SPEED=0.95" in text
        and "VOICE_EMOTION=calm" in text
        and "OTHER=x" in text
    )
    assert voice.style() == (0.95, "calm")
    monkeypatch.delenv("VOICE_SPEED", raising=False)
    monkeypatch.delenv("VOICE_EMOTION", raising=False)
