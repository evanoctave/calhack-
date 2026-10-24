"""Scripted redirect lines and the R6 validator. The voice lane extends this with model-written lines."""

from __future__ import annotations

import re
from typing import Final

from nightfall.household import Household

SCRIPT: Final[dict[str, str]] = {
    "open": "Hi {person}, it's {caregiver}. It's the middle of the night. Let's head back to bed.",
    "again": "It's still dark out, {person}. Everything's okay. Come back inside and I'll see you in the morning.",
    "closed_place": "The store is closed right now. Let's go back to bed and go in the morning.",
    "comfort": "You're home. You're safe. I'm right here.",
    "goodnight": "Good night, {person}. I love you.",
    "visitor_open": "Hi, you've reached the {family} household. Can I help you?",
    "visitor_reply": "Thank you. I'll let the family know you're here.",
    "visitor_bye": "Thanks for coming by. Have a good night.",
}

# More ways to say the scripted lines, in the order the door uses them: each time a line is needed, the first
# variant not already said tonight. Variant one is SCRIPT itself. All are pre-synthesized at boot.
VARIANTS: Final[dict[str, tuple[str, ...]]] = {
    "open": (
        SCRIPT["open"],
        "Hey {person}, it's {caregiver}. It's still nighttime. Come on back to bed with me.",
        "Hi {person}, it's just me, {caregiver}. Everybody's asleep. Let's get you back to bed.",
    ),
    "again": (
        SCRIPT["again"],
        "It's okay, {person}. It's still dark out. Come on in and sit down for me.",
        "I'm right here. It's way too early to head out. Let's go back to bed.",
        "You don't need to go anywhere tonight. Come back in, I've got everything handled.",
    ),
    "comfort": (
        SCRIPT["comfort"],
        "You're okay. You're home, and I'm right here with you.",
        "Everything's taken care of, {person}. Let's rest now.",
    ),
    "closed_place": (
        SCRIPT["closed_place"],
        "They're closed this late. We'll go first thing in the morning, okay?",
    ),
}


def pick(key: str, hh: Household, said: set[str] | frozenset[str] = frozenset()) -> str:
    """The first variant of a scripted line not already said tonight (the last one if all were)."""
    lines = [fill(t, hh) for t in VARIANTS.get(key, (SCRIPT[key],))]
    return next((ln for ln in lines if ln not in said), lines[-1])


BANNED: Final[frozenset[str]] = frozenset(
    {"dementia", "alzheimer", "confused", "you can't", "stop", "no!", "wrong", "remember?", "i told you"}
)
_TIME = re.compile(r"\b\d{1,2}(:\d{2})?\s?(am|pm)\b", re.IGNORECASE)


def fill(template: str, hh: Household) -> str:
    """Substitute the person's short name and the caregiver's name."""
    family = (
        hh.person_full_name.split()[-1] if hh.person_full_name and " " in hh.person_full_name else hh.caregiver_name
    )
    return template.format(person=hh.person_name, caregiver=hh.caregiver_name, family=family)


def validate(line: str) -> tuple[bool, str]:
    """R6: under 140 chars, no banned phrase, ends with . or ?, no digits except a clock time."""
    if len(line) >= 140:
        return False, "too long"
    low = line.lower()
    for b in BANNED:
        if b in low:
            return False, f"banned phrase: {b}"
    if not line.rstrip().endswith((".", "?", "!")):
        return False, "no terminal punctuation"
    if re.search(r"\d", _TIME.sub("", line)):
        return False, "digits outside a time"
    return True, "ok"
