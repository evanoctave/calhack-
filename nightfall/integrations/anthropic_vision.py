"""Claude vision call on a single exit frame. Reads the key; raises on every failure.

The only file in this lane that touches an API key (master prompt law 6). The SDK is imported
lazily so mock mode still runs when the package is absent. Rejected: returning a fixture from here.
The caller owns the fallback so one place logs it and one place stamps source.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Final

DEFAULT_MODEL: Final[str] = "claude-opus-5"
DEFAULT_TIMEOUT_S: Final[float] = 8.0
MAX_TOKENS: Final[int] = 1024


def configured() -> bool:
    """True when any credential the SDK can use is present.

    An unset ANTHROPIC_API_KEY does not mean there are no credentials: the SDK also reads
    ANTHROPIC_AUTH_TOKEN and a profile stored by `ant auth login`. Checking only the key would
    send a teammate who authenticated that way to the fixture for no reason.
    """
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    return (Path.home() / ".config" / "anthropic").is_dir()


def model() -> str:
    """Vision model id. Separate from the voice lane's ANTHROPIC_MODEL so the lanes cannot collide."""
    return os.environ.get("ANTHROPIC_VISION_MODEL", DEFAULT_MODEL)


def timeout_s() -> float:
    """Hard ceiling on the call. The brief is already on screen; this only fills a field in."""
    try:
        return float(os.environ.get("VISION_TIMEOUT_S", DEFAULT_TIMEOUT_S))
    except ValueError:
        return DEFAULT_TIMEOUT_S


def describe(jpeg_b64: str, prompt: str, schema: dict[str, Any], media_type: str = "image/jpeg") -> dict[str, Any]:
    """Send one frame, return the parsed JSON object. Raises on missing key, SDK, timeout or bad JSON."""
    if not configured():
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    import anthropic  # lazy: absent package must not break mock mode

    client = anthropic.Anthropic(timeout=timeout_s())
    response = client.messages.create(
        model=model(),
        max_tokens=MAX_TOKENS,
        thinking={"type": "adaptive"},
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": jpeg_b64}},
                {"type": "text", "text": prompt},
            ],
        }],
    )
    if response.stop_reason == "refusal":
        raise RuntimeError(f"refused: {getattr(response.stop_details, 'category', None)}")
    text = next((b.text for b in response.content if b.type == "text"), "")
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ValueError("vision response was not a JSON object")
    return parsed
