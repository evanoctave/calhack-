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


def test_telephone_copy_is_8khz_mulaw_and_a_sixth_the_size(monkeypatch, tmp_path) -> None:
    import struct

    monkeypatch.setattr(voice, "OUT", tmp_path)
    pcm = b"".join(struct.pack("<h", (i * 37) % 20000 - 10000) for i in range(24000))
    hdr = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 24000, 48000, 2, 16)
    (tmp_path / "abc.wav").write_bytes(hdr + b"data" + struct.pack("<I", len(pcm)) + pcm)
    assert voice.telephone_url("/voice/abc.wav") == "/voice/abc.tel.wav"
    tel = (tmp_path / "abc.tel.wav").read_bytes()
    assert struct.unpack("<HHI", tel[20:28]) == (7, 1, 8000) and len(tel) - 58 == 8000
    (tmp_path / "bad.wav").write_bytes(b"RIFFnope")
    assert voice.telephone_url("/voice/bad.wav") == "/voice/bad.wav"
