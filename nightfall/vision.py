"""Clothing description from an exit frame: enumerated fields only, fixture on any failure.

Owns the police-report prompt, the JSON schema sent to the model, and the split between the six
fields the Brief contract carries and the richer police-report fields that ride on the ExitEvent.
Rejected: free-text description. The brief renders enums and a confidence, and free text cannot be
validated against R8.
"""
from __future__ import annotations

import base64
import os
from dataclasses import dataclass, field
from typing import Any, Final

from nightfall import brief as briefmod
from nightfall.integrations import anthropic_vision

PATTERNS: Final = frozenset({"solid", "striped", "plaid", "floral", "graphic", "camouflage", "not visible"})
OUTERWEAR: Final = frozenset({"none", "jacket", "coat", "vest", "robe", "not visible"})
HEADWEAR: Final = frozenset({"none", "cap", "beanie", "hat", "hood up", "not visible"})
EYEWEAR: Final = frozenset({"none", "glasses", "sunglasses", "not visible"})
BUILD: Final = frozenset({"slight", "average", "heavy", "not visible"})
CARRIED: Final = frozenset({"none", "bag", "backpack", "purse", "cane", "walker", "umbrella", "phone", "not visible"})

DEFAULT_MIN_LUMINANCE: Final[float] = 20.0  # 0-255. Below this a frame holds no describable detail.

PROMPT: Final[str] = (
    "You are helping a family search for a missing adult who walked out of their home at night. "
    "Describe ONLY what is visibly worn or carried in this frame, in the style of a police "
    "clothing description. Rules: describe clothing and objects only; never guess or state the "
    "person's identity, name, age, sex, race, or any medical or mental condition; use the exact "
    "value 'not visible' for anything you cannot see, including when the frame is dark, blurred or "
    "cropped; never invent detail to fill a field. Set confidence to your honest certainty about "
    "the clothing description as a whole, from 0.0 to 1.0."
)


def _enum(values: frozenset[str]) -> dict[str, Any]:
    return {"type": "string", "enum": sorted(values)}


SCHEMA: Final[dict[str, Any]] = {
    "type": "object",
    "properties": {
        "top_color": _enum(briefmod.COLORS), "top_type": _enum(briefmod.TOPS),
        "bottom_color": _enum(briefmod.COLORS), "bottom_type": _enum(briefmod.BOTTOMS),
        "footwear": _enum(briefmod.FOOTWEAR),
        "top_pattern": _enum(PATTERNS), "bottom_pattern": _enum(PATTERNS),
        "outerwear": _enum(OUTERWEAR), "headwear": _enum(HEADWEAR), "eyewear": _enum(EYEWEAR),
        "build": _enum(BUILD),
        # No maxItems: structured outputs rejects it. coerce_rich caps the list instead.
        "carried_items": {"type": "array", "items": _enum(CARRIED)},
        "confidence": {"type": "number"},
    },
    "required": ["top_color", "top_type", "bottom_color", "bottom_type", "footwear", "top_pattern",
                 "bottom_pattern", "outerwear", "headwear", "eyewear", "build", "carried_items",
                 "confidence"],
    "additionalProperties": False,
}

RICH_ENUMS: Final[dict[str, frozenset[str]]] = {
    "top_pattern": PATTERNS, "bottom_pattern": PATTERNS, "outerwear": OUTERWEAR,
    "headwear": HEADWEAR, "eyewear": EYEWEAR, "build": BUILD,
}


@dataclass(frozen=True)
class ClothingReport:
    """Both shapes of one description: the Brief's six fields, and the full police-report fields."""

    brief: dict[str, Any]
    full: dict[str, Any] = field(default_factory=dict)

    @property
    def source(self) -> str:
        """Where the description came from: 'anthropic' or 'mock'."""
        return str(self.brief.get("source", "mock"))


def coerce_rich(raw: dict[str, Any]) -> dict[str, Any]:
    """R8 for the police-report fields: anything outside its enum becomes 'not visible'."""
    out: dict[str, Any] = {}
    for key, allowed in RICH_ENUMS.items():
        value = str(raw.get(key, "not visible")).lower().strip()
        out[key] = value if value in allowed else "not visible"
    items = raw.get("carried_items")
    seen = [str(i).lower().strip() for i in items] if isinstance(items, list) else []
    out["carried_items"] = [i for i in seen if i in CARRIED and i != "none"][:4]
    return out


def fixture() -> ClothingReport:
    """The description used whenever the model is unavailable or unusable."""
    return ClothingReport(
        brief=briefmod.mock_clothing(),
        full=coerce_rich({"top_pattern": "solid", "bottom_pattern": "solid", "outerwear": "none",
                          "headwear": "none", "eyewear": "glasses", "build": "average",
                          "carried_items": []}),
    )


def min_luminance() -> float:
    """Darkness floor, read at call time so a test can move it without reimporting."""
    try:
        return float(os.environ.get("MIN_LUMINANCE", DEFAULT_MIN_LUMINANCE))
    except ValueError:
        return DEFAULT_MIN_LUMINANCE


def mean_luminance(jpeg: bytes) -> float | None:
    """Mean brightness 0-255, or None when it cannot be measured. Never raises."""
    try:
        import io

        from PIL import Image, ImageStat  # lazy: absent package must not break mock mode

        with Image.open(io.BytesIO(jpeg)) as im:
            return float(ImageStat.Stat(im.convert("L")).mean[0])
    except Exception:
        return None


def _as_bytes(jpeg: bytes | str) -> bytes:
    """Accept raw bytes, bare base64, or a data URI. Returns the decoded image."""
    if isinstance(jpeg, bytes):
        return jpeg
    payload = jpeg.split(",", 1)[-1] if jpeg.startswith("data:") else jpeg
    try:
        return base64.b64decode(payload, validate=False)
    except Exception:
        return b""


def describe_clothing(jpeg: bytes | str) -> ClothingReport:
    """Describe one exit frame. Falls back to the fixture on any failure, and says so."""
    if not jpeg:
        return _fallback("no exit frame captured")
    raw = _as_bytes(jpeg)
    lux = mean_luminance(raw)
    floor = min_luminance()
    if lux is not None and lux < floor:
        return _fallback(f"frame too dark to describe (luminance {lux:.0f} below {floor:g})")
    data = base64.b64encode(raw).decode() if raw else ""
    if not data:
        return _fallback("frame could not be decoded")
    try:
        raw = anthropic_vision.describe(data, PROMPT, SCHEMA)
    except Exception as e:  # any failure: no key, no SDK, timeout, refusal, bad JSON
        return _fallback(f"{type(e).__name__}: {e}")
    clothing = briefmod.coerce_clothing({**raw, "source": "anthropic"})
    return ClothingReport(brief=clothing, full=coerce_rich(raw))


def _fallback(reason: str) -> ClothingReport:
    print(f"anthropic_vision fallback: {reason}")
    return fixture()
