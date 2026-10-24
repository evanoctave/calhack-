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
}

BANNED: Final[frozenset[str]] = frozenset(
    {"dementia", "alzheimer", "confused", "you can't", "stop", "no!", "wrong", "remember?", "i told you"}
)
_TIME = re.compile(r"\b\d{1,2}(:\d{2})?\s?(am|pm)\b", re.IGNORECASE)


def fill(template: str, hh: Household) -> str:
    """Substitute the person's short name and the caregiver's name."""
    return template.format(person=hh.person_name, caregiver=hh.caregiver_name)


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
