"""Claude's three text jobs, each inside a template and validated by code (R6, R7, R8).

next_line writes one redirect line; describe_clothing fills enumerated fields from a frame;
brief_prose writes two sentences from fields. Mock mode is deterministic. Any failure falls back
to the script or to unknown(). The model never sees medications or sets state.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from typing import Any, Final

from nightfall import brief as briefmod
from nightfall.household import Household
from nightfall.integrations import anthropic_llm
from nightfall.script import BANNED, pick, validate

PERSONA_SYSTEM: Final = (
    "You are {caregiver}, talking to {person} through the speaker by the front door in the middle of the night. "
    "{person} has memory loss and is trying to go out. Talk the way a loving family member really talks at 2 AM: "
    "ordinary words, contractions, short sentences, calm and unhurried.\n"
    "How to sound real:\n"
    "- Answer what {person} just said before anything else. Agree with the feeling, not the facts "
    "(they want to get to work: they've always been the first one in).\n"
    "- Then offer one small, easy next step: come inside, sit down for a minute, wait for you, go back to bed.\n"
    "- A gentle yes-or-no question often works better than an instruction.\n"
    "- Don't sound like an announcement. No 'please be advised', no lists, no 'sweetheart' every line.\n"
    "- Never repeat a sentence or an opening you've already said in this conversation. Change how you start.\n"
    "- Use their name at most once every few lines.\n"
    "Hard rules: one or two sentences, under 120 characters total. Never argue, correct, or say no. Never mention "
    "memory, illness, confusion, or medicine. Don't invent objects, pets, people, food, weather, or places; only "
    "mention what's in the notes or the conversation. Never claim the door is locked or that someone is on the way unless the conversation says so. No digits except a clock time. Reply with the spoken words only.\n"
    "Examples of the tone (don't copy them):\n"
    "They say: I have to get to the office. You say: You've always been the first one in. It's still dark, though. Sit with me a minute?\n"
    "They say: Where's my car? You say: The car's put away for the night. Come on in, I'll be right there.\n"
    "They say nothing. You say: Hey, it's late. How about we head back to bed together?"
)
VISION_SYSTEM: Final = (
    "You describe clothing in a single still frame for a missing-person notice. Return JSON only with keys "
    "top_color, top_type, bottom_color, bottom_type, footwear, confidence (0-1). Allowed values: colors {colors}; "
    "tops {tops}; bottoms {bottoms}; footwear {footwear}. Use 'unknown' when unsure. No other text."
)
_STORE_WORDS: Final = re.compile(r"\b(store|shop|work|office|church|market|bus|train|ralphs)\b", re.IGNORECASE)


def memory_hits(hh: Household, text: str) -> list[str]:
    """Familiar places whose name shares a word with the reply (Moss lane replaces this)."""
    words = {w.lower() for w in re.findall(r"[a-z]+", text, re.IGNORECASE) if len(w) > 3}
    return [
        p["name"]
        for p in hh.familiar_places
        if words & {w.lower() for w in re.findall(r"[a-z]+", p["name"], re.IGNORECASE)}
    ]


def _mentions_medication(hh: Household, line: str) -> bool:
    low = line.lower()
    return (
        any(
            m.get("name", "").lower() in low
            for m in hh.medications
            if m.get("name") and m["name"].lower() != "no insulin"
        )
        or "insulin" in low
    )


def next_line(hh: Household, history: Sequence[tuple[str, str]], hits: Sequence[str] = ()) -> tuple[str, str]:
    """Return (line, source). history is [(speaker, text)], speaker in {"system", "person"}.

    R6 and R7: the model's line must pass script.validate and must not name a medication, whatever the
    person at the door asked for. Otherwise the scripted fallback is spoken.
    """
    last = next((t for s, t in reversed(history) if s == "person"), "")
    turn = sum(1 for s, _ in history if s == "system")
    said = {t for s, t in history if s == "system"}
    fallback = pick("closed_place" if _STORE_WORDS.search(last) else "again" if turn < 3 else "comfort", hh, said)
    if not anthropic_llm.enabled():
        return fallback, "mock"
    try:
        convo = "\n".join(f"{'You' if s == 'system' else hh.person_name}: {t}" for s, t in history[-4:])
        mem = ("Places they know: " + "; ".join(hits)) if hits else ""
        out = anthropic_llm.complete(
            PERSONA_SYSTEM.format(caregiver=hh.caregiver_name, person=hh.person_name),
            f"{mem}\nConversation so far:\n{convo}\nNext line:",
            max_tokens=600,
        )
        line = out.strip().strip('"').splitlines()[0] if out.strip() else ""
        line = line.replace(" — ", ", ").replace("—", ", ").replace("–", ", ").replace("’", "'").strip()
        if line and line[-1] not in ".?!":
            line += "."
        ok, why = validate(line)
        if ok and _mentions_medication(hh, line):
            ok, why = False, "medication named"
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
        sys_prompt = VISION_SYSTEM.format(
            colors=sorted(briefmod.COLORS),
            tops=sorted(briefmod.TOPS),
            bottoms=sorted(briefmod.BOTTOMS),
            footwear=sorted(briefmod.FOOTWEAR),
        )
        out = anthropic_llm.complete(sys_prompt, "Describe the clothing. JSON only.", image_jpeg=jpeg, max_tokens=800)
        m = re.search(r"\{.*\}", out, re.DOTALL)
        raw = json.loads(m.group(0)) if m else {}
        return briefmod.coerce_clothing({**raw, "source": "anthropic"})
    except Exception as e:  # noqa: BLE001
        print(f"anthropic vision fallback: {e}")
        return briefmod.coerce_clothing({"confidence": 0.0, "source": "mock"})


def brief_prose(fields: dict[str, Any]) -> str:
    """Two sentences from structured fields; no new facts. The template is the mock and the fallback."""
    tmpl = (
        f"{fields['person_name']} left home at {fields['last_seen_hhmm']} wearing {fields['clothing_line']}. "
        f"Check {fields['first_hazard']} first, then call {fields['first_call']}."
    )
    if not anthropic_llm.enabled():
        return tmpl
    try:
        out = anthropic_llm.complete(
            "Rewrite the following as two plain sentences for a family member searching at night. Keep every fact, "
            "add nothing, no digits other than the time given.",
            tmpl,
            max_tokens=600,
        )
        if 20 < len(out) < 300 and not any(b in out.lower() for b in BANNED):
            return out
    except Exception as e:  # noqa: BLE001
        print(f"anthropic prose fallback: {e}")
    return tmpl
