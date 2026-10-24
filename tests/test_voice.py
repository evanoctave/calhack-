import sys

from nightfall import voice
from nightfall.household import load


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
    monkeypatch.setattr(voice.cartesia, "tts_wav", lambda text, vid: calls.append(text) or b"RIFFwav")
    a = voice.say("Hi Dad.")
    b = voice.say("Hi Dad.")
    assert a["mode"] == "cartesia" and a == b and calls == ["Hi Dad."]

    def boom(text, vid):
        raise RuntimeError("down")

    monkeypatch.setattr(voice.cartesia, "tts_wav", boom)
    assert voice.say("Other line.")["mode"] == "browser_tts"


def test_pre_synthesize_mock() -> None:
    assert set(voice.pre_synthesize(load("data/household.json")).values()) == {"browser_tts"}
