"""Anthropic SDK wrapper. One function: complete(system, user, image) -> text. Imported lazily so mock
mode never loads the SDK. Default model claude-opus-5; override with ANTHROPIC_MODEL.
"""

from __future__ import annotations

import os
from typing import Final

MODEL: Final = os.environ.get("ANTHROPIC_MODEL", "claude-opus-5")


def enabled() -> bool:
    """True when a key is configured and MOCK is off."""
    return os.environ.get("MOCK", "1") != "1" and bool(os.environ.get("ANTHROPIC_API_KEY"))


def complete(
    system: str, user: str, *, image_jpeg: bytes | None = None, max_tokens: int = 400, timeout: float = 15.0
) -> str:
    """Single-turn completion. Returns the concatenated text blocks. Raises on API or refusal."""
    import base64

    import anthropic

    client = anthropic.Anthropic(timeout=timeout, max_retries=1)
    content: list[dict[str, object]] = []
    if image_jpeg is not None:
        content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": base64.standard_b64encode(image_jpeg).decode(),
                },
            }
        )
    content.append({"type": "text", "text": user})
    resp = client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        system=system,
        output_config={"effort": "low"},
        messages=[{"role": "user", "content": content}],
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("model refused")
    return "".join(b.text for b in resp.content if b.type == "text").strip()
