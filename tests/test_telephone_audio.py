"""Telephone-only compression is isolated from providers, saved voices and browser audio."""

import io
import os
import struct
import wave
from pathlib import Path
from types import SimpleNamespace

import pytest

from nightfall import api_voice, voice


def pcm_wav(rate=24000, frames=24000, channels=1, width=2):
    stream = io.BytesIO()
    with wave.open(stream, "wb") as clip:
        clip.setnchannels(channels)
        clip.setsampwidth(width)
        clip.setframerate(rate)
        clip.writeframes(b"\0" * frames * channels * width)
    return stream.getvalue()


@pytest.fixture
def cache(tmp_path, monkeypatch):
    monkeypatch.setattr(voice, "OUT", tmp_path)
    return tmp_path


def test_telephone_wav_is_8khz_mulaw_without_changing_source(cache):
    raw = pcm_wav()
    source = cache / "speech.wav"
    source.write_bytes(raw)
    assert voice.telephone_url("/voice/speech.wav") == "/voice/speech.tel.wav"
    result = (cache / "speech.tel.wav").read_bytes()
    assert struct.unpack("<HHI", result[20:28]) == (7, 1, 8000)
    assert struct.unpack("<I", result[54:58]) == (8000,)
    assert result[58:] == b"\xff" * 8000
    assert len(result) < len(raw) / 5
    assert source.read_bytes() == raw
    before = (cache / "speech.tel.wav").stat().st_mtime_ns
    assert voice.telephone_url("/voice/speech.wav") == "/voice/speech.tel.wav"
    assert (cache / "speech.tel.wav").stat().st_mtime_ns == before


def test_riff_metadata_padding_and_data_word_do_not_corrupt_conversion(cache):
    raw = pcm_wav(frames=9)
    metadata = b"data?"  # odd length and misleading marker inside metadata
    junk = b"JUNK" + struct.pack("<I", len(metadata)) + metadata + b"\0"
    raw = raw[:12] + junk + raw[12:]
    raw = raw[:4] + struct.pack("<I", len(raw) - 8) + raw[8:]
    (cache / "speech.wav").write_bytes(raw)
    assert voice.telephone_url("/voice/speech.wav") == "/voice/speech.tel.wav"
    result = (cache / "speech.tel.wav").read_bytes()
    assert struct.unpack("<I", result[54:58]) == (3,)
    assert result[58:] == b"\xff\xff\xff\0"  # RIFF pads odd payloads
    assert struct.unpack("<I", result[4:8])[0] == len(result) - 8


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"RIFFnope",
        pcm_wav()[:-2],
        pcm_wav(frames=0),
        pcm_wav(frames=1),
        pcm_wav(rate=44100),
        pcm_wav(channels=2),
        pcm_wav(width=1),
        pcm_wav()[:24] + struct.pack("<I", 0) + pcm_wav()[28:],
    ],
)
def test_malformed_or_unsupported_audio_falls_back_to_original(cache, raw):
    (cache / "speech.wav").write_bytes(raw)
    assert voice.telephone_url("/voice/speech.wav") == "/voice/speech.wav"
    assert not (cache / "speech.tel.wav").exists()


@pytest.mark.parametrize("failure", ["read", "replace"])
def test_io_failure_keeps_original_url_and_cleans_temporary_file(cache, monkeypatch, failure):
    (cache / "speech.wav").write_bytes(pcm_wav())

    def denied(*_args, **_kwargs):
        raise PermissionError("blocked cache")

    if failure == "read":
        monkeypatch.setattr(Path, "read_bytes", denied)
    else:
        monkeypatch.setattr(voice.os, "replace", denied)
    assert voice.telephone_url("/voice/speech.wav") == "/voice/speech.wav"
    assert not list(cache.glob("*.tmp"))


def test_missing_source_or_non_cache_url_is_unchanged(cache):
    for url in ("/voice/missing.wav", "/other/audio.wav", "/voice/../secret.wav", "/voice/speech.tel.wav"):
        assert voice.telephone_url(url) == url


def test_pruning_removes_companion_but_counts_original_lines(cache, monkeypatch):
    monkeypatch.setattr(voice, "LRU", 1)
    for index, name in enumerate(("old", "new")):
        for suffix in (".wav", ".tel.wav"):
            path = cache / (name + suffix)
            path.write_bytes(b"audio")
            os.utime(path, (index + 1, index + 1))
    voice._prune()
    assert {p.name for p in cache.iterdir()} == {"new.wav", "new.tel.wav"}


def test_twiml_uses_compact_audio(cache, monkeypatch):
    (cache / "speech.wav").write_bytes(pcm_wav())
    monkeypatch.setattr(voice, "say", lambda *_: {"mode": "cartesia", "url": "/voice/speech.wav"})
    response = api_voice._twiml("Hello", None, True)
    assert b"/voice/speech.tel.wav</Play>" in response.body
    assert b"<Hangup/>" in response.body


async def test_browser_call_keeps_pcm_url(monkeypatch):
    monkeypatch.setattr(api_voice, "_ctx", lambda *_: (SimpleNamespace(hh=None), {}, "Sarah"))
    monkeypatch.setattr(api_voice.call_agent, "opening", lambda *_: "Hello")
    monkeypatch.setattr(voice, "say", lambda *_: {"mode": "cartesia", "url": "/voice/speech.wav"})
    monkeypatch.setattr(voice, "telephone_url", lambda *_: pytest.fail("browser must keep PCM audio"))
    assert (await api_voice.agent_opening("incident", "member"))["audio"]["url"] == "/voice/speech.wav"


@pytest.mark.parametrize("sample,encoded", [(0, 255), (1, 255), (-1, 127), (32124, 128), (-32124, 0)])
def test_mulaw_known_values(sample, encoded):
    assert voice._mulaw(sample) == encoded
