"""Claude's three text jobs, each inside a template and validated by code (R6, R7, R8).

next_line writes one redirect line; describe_clothing fills enumerated fields from a frame;
brief_prose writes two sentences from fields. Mock mode is deterministic. Any failure falls back
to the script or to unknown(). The model never sees medications or sets state.
"""
from __future__ import annotations

import json
import re
from typing import Any, Final, Sequence

from nightfall import brief as briefmod
from nightfall.household import Household
from nightfall.integrations import anthropic_llm
from nightfall.script import BANNED, SCRIPT, fill, validate

PERSONA_SYSTEM: Final = (
    "You speak as {caregiver}, the adult child of {person}, who has memory loss and is at the front "
    "door in the middle of the night. Write exactly one short spoken line (under 120 characters) that "
    "gently turns them back toward bed. Warm, concrete, present tense. Never argue, never correct, never "
    "mention memory, illness, confusion or the word 'no'. Never state facts you were not given. No digits "
    "except a clock time. Reply with the line only."
)
VISION_SYSTEM: Final = (
    "You describe clothing in a single still frame for a missing-person notice. Return JSON only with keys "
    "top_color, top_type, bottom_color, bottom_type, footwear, confidence (0-1). Allowed values: colors {colors}; "
    "tops {tops}; bottoms {bottoms}; footwear {footwear}. Use 'unknown' when unsure. No other text."
)
_STORE_WORDS: Final = re.compile(r"\b(store|shop|work|office|church|market|bus|train|ralphs)\b", re.I)


def memory_hits(hh: Household, text: str) -> list[str]:
    """Familiar places whose name shares a word with the reply (Moss lane replaces this)."""
    words = {w.lower() for w in re.findall(r"[a-z]+", text, re.I) if len(w) > 3}
    return [p["name"] for p in hh.familiar_places if words & {w.lower() for w in re.findall(r"[a-z]+", p["name"], re.I)}]


def next_line(hh: Household, history: Sequence[tuple[str, str]], hits: Sequence[str] = ()) -> tuple[str, str]:
    """Return (line, source). history is [(speaker, text)], speaker in {"system", "person"}."""
    last = next((t for s, t in reversed(history) if s == "person"), "")
    turn = sum(1 for s, _ in history if s == "system")
    fallback = fill(SCRIPT["closed_place"] if _STORE_WORDS.search(last) else SCRIPT["again"] if turn < 3 else SCRIPT["comfort"], hh)
    if not anthropic_llm.enabled():
        return fallback, "mock"
    try:
        convo = "\n".join(f"{'You' if s == 'system' else hh.person_name}: {t}" for s, t in history[-4:])
        mem = ("Places they know: " + "; ".join(hits)) if hits else ""
        out = anthropic_llm.complete(PERSONA_SYSTEM.format(caregiver=hh.caregiver_name, person=hh.person_name),
                                     f"{mem}\nConversation so far:\n{convo}\nNext line:", max_tokens=80)
        line = out.strip().strip('"').splitlines()[0] if out.strip() else ""
        line = line.replace(" — ", ", ").replace("—", ", ").replace("–", ", ").replace("’", "'")
        ok, why = validate(line)
        if ok:
            return line, "anthropic"
        print(f"llm line replaced: {why}")
    except Exception as e:  # noqa: BLE001
        print(f"anthropic fallback: {e}")
    return fallback, "mock"


def describe_clothing(jpeg: bytes | None) -> dict[str, Any]:
    """R8: enumerated clothing fields from one exit frame; fixture in mock mode; unknown() on failure."""
    if jpeg is None or not anthropic_llm.enabled():
        return briefmod.mock_clothing()
    try:
        sys_prompt = VISION_SYSTEM.format(colors=sorted(briefmod.COLORS), tops=sorted(briefmod.TOPS),
                                          bottoms=sorted(briefmod.BOTTOMS), footwear=sorted(briefmod.FOOTWEAR))
        out = anthropic_llm.complete(sys_prompt, "Describe the clothing. JSON only.", image_jpeg=jpeg, max_tokens=200)
        m = re.search(r"\{.*\}", out, re.S)
        raw = json.loads(m.group(0)) if m else {}
        return briefmod.coerce_clothing({**raw, "source": "anthropic"})
    except Exception as e:  # noqa: BLE001
        print(f"anthropic vision fallback: {e}")
        return briefmod.coerce_clothing({"confidence": 0.0, "source": "mock"})


def brief_prose(fields: dict[str, Any]) -> str:
    """Two sentences from structured fields; no new facts. The template is the mock and the fallback."""
    tmpl = (f"{fields['person_name']} left home at {fields['last_seen_hhmm']} wearing {fields['clothing_line']}. "
            f"Check {fields['first_hazard']} first, then call {fields['first_call']}.")
    if not anthropic_llm.enabled():
        return tmpl
    try:
        out = anthropic_llm.complete(
            "Rewrite the following as two plain sentences for a family member searching at night. Keep every fact, "
            "add nothing, no digits other than the time given.", tmpl, max_tokens=120)
        if 20 < len(out) < 300 and not any(b in out.lower() for b in BANNED):
            return out
    except Exception as e:  # noqa: BLE001
        print(f"anthropic prose fallback: {e}")
    return tmpl
