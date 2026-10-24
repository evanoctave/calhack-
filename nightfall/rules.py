"""Wander score: deterministic, explainable. Decides stand-down vs speak-only vs escalate.

Errs toward a ring: unknown identity or unknown direction never lowers the score. The model never
sets any of these inputs; they come from the browser detector, the check-in parser and the clothing enums.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Final

NIGHTWEAR_TOPS: Final = frozenset({"pajama top", "robe"})
NIGHTWEAR_BOTTOMS: Final = frozenset({"pajama pants"})
NIGHTWEAR_FEET: Final = frozenset({"barefoot", "slippers", "socks"})
_AIR: Final = re.compile(
    r"\b(air|smoke|cigarette|trash|garbage|dog|walk the|mail|car|uber|lyft|work shift|night shift)\b", re.IGNORECASE
)
_SELF: Final = re.compile(r"\b(it'?s|this is|i'?m|i am)\s+([A-Za-z]+)\b", re.IGNORECASE)


@dataclass(frozen=True)
class Features:
    identity: str = "unknown"  # match | other | unknown  (face recognition on the track)
    direction: str = "unknown"  # exit | entry | unknown    (door-zone track geometry)
    checkin: str = "none"  # none | self_other | air | silence | confused
    attire_night: bool = False  # pajamas, robe, slippers, barefoot
    in_window: bool = True  # night window or manually armed


@dataclass(frozen=True)
class Verdict:
    score: int
    action: str  # ignore | speak_only | escalate
    reasons: tuple[str, ...] = field(default_factory=tuple)


def parse_checkin(text: str, household_names: Iterable[str], person_name: str) -> tuple[str, str]:
    """Classify a reply at the door. Returns (kind, who). Names must belong to the care circle, not the person."""
    t = text.strip()
    names = {n.strip().lower() for n in household_names if n.strip()}
    m = _SELF.search(t)
    if m and m.group(2).lower() in names and m.group(2).lower() != person_name.lower():
        return "self_other", m.group(2)
    low = t.lower()
    for n in names:
        if n != person_name.lower() and re.search(rf"\b{re.escape(n)}\b", low) and _AIR.search(t):
            return "self_other", n.title()
    if _AIR.search(t):
        return "air", ""
    if not t:
        return "silence", ""
    return "confused", ""


def attire_is_night(clothing: dict[str, object]) -> bool:
    return (
        str(clothing.get("top_type")) in NIGHTWEAR_TOPS
        or str(clothing.get("bottom_type")) in NIGHTWEAR_BOTTOMS
        or str(clothing.get("footwear")) in NIGHTWEAR_FEET
    )


def wander_score(f: Features) -> Verdict:
    """0-100. Under 30 ignore; 30-59 speak only; 60+ escalate when the person leaves. Unknown everything = 60."""
    s, why = 60, ["baseline 60 (unknown identity rings)"]
    if f.direction == "entry":
        return Verdict(0, "ignore", ("arrival: came in from the door",))
    if f.identity == "other":
        s -= 45
        why.append("face: not the monitored person (-45)")
    elif f.identity == "match":
        s += 20
        why.append("face: monitored person (+20)")
    else:
        why.append("face: unknown (no change, rings by default)")
    if f.checkin == "self_other":
        s -= 50
        why.append("check-in: a care-circle member identified themselves (-50)")
    elif f.checkin == "air":
        s -= 15
        why.append("check-in: coherent errand reply (-15)")
    elif f.checkin == "confused":
        s += 15
        why.append("check-in: reply did not identify anyone (+15)")
    if f.attire_night:
        s += 15
        why.append("attire: nightwear or barefoot (+15)")
    if not f.in_window:
        s -= 20
        why.append("daytime (-20)")
    s = max(0, min(100, s))
    action = "ignore" if s < 30 else "speak_only" if s < 60 else "escalate"
    return Verdict(s, action, tuple(why))
