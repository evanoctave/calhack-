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

BANNED: Final[frozenset[str]] = frozenset(
    {"dementia", "alzheimer", "confused", "you can't", "stop", "no!", "wrong", "remember?", "i told you"}
)
_TIME = re.compile(r"\b\d{1,2}(:\d{2})?\s?(am|pm)\b", re.IGNORECASE)


def fill(template: str, hh: Household) -> str:
    """Substitute the person's short name and the caregiver's name."""
    family = (
        hh.person_full_name.split()[-1] if hh.person_full_name and " " in hh.person_full_name else hh.caregiver_name
    )
    text = template.format(person=hh.person_name.strip(), caregiver=hh.caregiver_name.strip(), family=family.strip())
    # a name still missing from the form must not leave "Hi , it's ." in the audio
    text = re.sub(r"\s+,", ",", text).replace("it's .", "it's me.")
    text = re.sub(r",\s*\.", ".", text)
    return re.sub(r"\bthe\s+household", "the household", text)


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
