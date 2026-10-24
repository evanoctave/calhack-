"""Vision lane: the fixture fallback must survive every way the model call can fail."""
from __future__ import annotations

import base64
from typing import Any

import pytest

from nightfall import vision
from nightfall.integrations import anthropic_vision

GOOD: dict[str, Any] = {
    "top_color": "red", "top_type": "jacket", "bottom_color": "black", "bottom_type": "jeans",
    "footwear": "slippers", "top_pattern": "striped", "bottom_pattern": "solid",
    "outerwear": "coat", "headwear": "beanie", "eyewear": "glasses", "build": "slight",
    "carried_items": ["cane", "bag"], "confidence": 0.77,
}

JPEG = b"\xff\xd8\xff\xe0fake-jpeg-bytes"


def _stub(monkeypatch, result=None, exc=None):
    def fake(*_a: object, **_k: object) -> dict[str, Any]:
        if exc is not None:
            raise exc
        return result  # type: ignore[return-value]

    monkeypatch.setattr(anthropic_vision, "describe", fake)


def test_happy_path_parses_both_shapes(monkeypatch) -> None:
    _stub(monkeypatch, result=GOOD)
    r = vision.describe_clothing(JPEG)
    assert r.source == "anthropic"
    assert r.brief["top_color"] == "red" and r.brief["bottom_type"] == "jeans"
    assert r.brief["confidence"] == 0.77
    assert r.full["headwear"] == "beanie" and r.full["carried_items"] == ["cane", "bag"]


def test_no_api_key_falls_back(monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = vision.describe_clothing(JPEG)
    assert r.source == "mock" and r.brief["top_type"] == "hoodie"


def test_missing_sdk_falls_back(monkeypatch) -> None:
    _stub(monkeypatch, exc=ModuleNotFoundError("No module named 'anthropic'"))
    assert vision.describe_clothing(JPEG).source == "mock"


def test_timeout_falls_back(monkeypatch) -> None:
    _stub(monkeypatch, exc=TimeoutError("read timeout"))
    assert vision.describe_clothing(JPEG).source == "mock"


def test_malformed_response_falls_back(monkeypatch) -> None:
    _stub(monkeypatch, exc=ValueError("vision response was not a JSON object"))
    assert vision.describe_clothing(JPEG).source == "mock"


def test_empty_frame_falls_back_without_calling(monkeypatch) -> None:
    def boom(*_a: object, **_k: object) -> dict[str, Any]:
        raise AssertionError("must not call the model with no frame")

    monkeypatch.setattr(anthropic_vision, "describe", boom)
    assert vision.describe_clothing(b"").source == "mock"


def test_out_of_enum_values_become_unknown_and_not_visible(monkeypatch) -> None:
    _stub(monkeypatch, result={**GOOD, "top_color": "chartreuse", "footwear": "flip-flops",
                               "headwear": "sombrero", "build": "athletic",
                               "carried_items": ["chainsaw", "none", "bag"]})
    r = vision.describe_clothing(JPEG)
    assert r.brief["top_color"] == "unknown" and r.brief["footwear"] == "unknown"
    assert r.full["headwear"] == "not visible" and r.full["build"] == "not visible"
    assert r.full["carried_items"] == ["bag"]


def test_confidence_is_clamped(monkeypatch) -> None:
    _stub(monkeypatch, result={**GOOD, "confidence": 4.2})
    assert vision.describe_clothing(JPEG).brief["confidence"] == 1.0
    _stub(monkeypatch, result={**GOOD, "confidence": "not a number"})
    assert vision.describe_clothing(JPEG).brief["confidence"] == 0.0


def test_missing_fields_do_not_raise(monkeypatch) -> None:
    _stub(monkeypatch, result={"confidence": 0.5})
    r = vision.describe_clothing(JPEG)
    assert r.brief["top_type"] == "unknown"
    assert r.full["carried_items"] == [] and r.full["outerwear"] == "not visible"


def test_data_uri_prefix_is_stripped(monkeypatch) -> None:
    seen: dict[str, str] = {}

    def fake(data: str, *_a: object, **_k: object) -> dict[str, Any]:
        seen["data"] = data
        return GOOD

    monkeypatch.setattr(anthropic_vision, "describe", fake)
    b64 = base64.b64encode(JPEG).decode()
    vision.describe_clothing(f"data:image/jpeg;base64,{b64}")
    assert seen["data"] == b64


def test_schema_enums_match_the_brief_contract() -> None:
    props = vision.SCHEMA["properties"]
    from nightfall import brief as briefmod

    assert set(props["top_color"]["enum"]) == briefmod.COLORS
    assert set(props["footwear"]["enum"]) == briefmod.FOOTWEAR
    assert vision.SCHEMA["additionalProperties"] is False


def test_prompt_forbids_identity_and_medical_guessing() -> None:
    p = vision.PROMPT.lower()
    assert "never guess or state the person's identity" in p
    assert "medical" in p and "not visible" in p


@pytest.mark.parametrize("env,expected", [({}, "claude-opus-5"), ({"ANTHROPIC_VISION_MODEL": "claude-sonnet-5"}, "claude-sonnet-5")])
def test_model_id_comes_from_env(monkeypatch, env: dict[str, str], expected: str) -> None:
    monkeypatch.delenv("ANTHROPIC_VISION_MODEL", raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    assert anthropic_vision.model() == expected


def test_auth_token_counts_as_configured(monkeypatch, tmp_path) -> None:
    """The SDK reads ANTHROPIC_AUTH_TOKEN and `ant auth login` profiles too, not just the key."""
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    assert anthropic_vision.configured() is False
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok")
    assert anthropic_vision.configured() is True


def test_ant_profile_counts_as_configured(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    assert anthropic_vision.configured() is False
    (tmp_path / ".config" / "anthropic").mkdir(parents=True)
    assert anthropic_vision.configured() is True
