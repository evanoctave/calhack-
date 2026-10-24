"""Wander score v2: a deterministic evidence model that decides stand-down vs speak-only vs escalate.

Each observation is a likelihood ratio: how much more often it is seen when a person with dementia is
wandering than when someone is leaving for an ordinary reason. Ratios multiply, so they add in log-odds
(a hand-set naive Bayes): P(wander) = sigmoid(prior + sum of log-likelihood ratios). The score is that
probability as 0-100 and the bands are unchanged: under 30 ignore, 30-59 speak only, 60+ ring.

Every term is code-owned (browser detector, check-in parser, clothing enums, clock, history); the language
model never sets one. Every term is reported with its weight, so a judge or a caregiver can read exactly
why the phone rang. Safety asymmetry: an unknown never lowers the odds, and the prior alone rings
(a false ring costs one phone one ring; a miss can cost a life).
"""

from __future__ import annotations

import math
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
# Obligations from an earlier life: the commonest reason people with dementia give for leaving at night.
_DISORIENTED: Final = re.compile(
    r"\b(work|office|shift|job|late for|pick up the (kids|children|baby)|my (mother|mom|mum|father|dad)|"
    r"go(ing)? home|take me home|the bus|school|catch the train|meeting)\b",
    re.IGNORECASE,
)
_SELF: Final = re.compile(r"\b(it'?s|this is|i'?m|i am)\s+([A-Za-z]+)\b", re.IGNORECASE)


@dataclass(frozen=True)
class Features:
    identity: str = "unknown"  # match | other | unknown  (face recognition on the track)
    direction: str = "unknown"  # exit | entry | unknown    (door-zone track geometry)
    checkin: str = "none"  # none | self_other | air | disoriented | confused | silence
    attire_night: bool = False  # pajamas, robe, slippers, barefoot (used when the detail below is missing)
    in_window: bool = True  # night window or manually armed
    hour: float | None = None  # local hour of the approach, 0-24
    armed: bool = True  # armed by hand: the clock can raise the odds but never lower them
    face_conf: float = 1.0  # 0-1, how sure the face match is
    footwear: str = ""  # barefoot | slippers | socks | shoes | unknown
    top_type: str = ""
    bottom_type: str = ""
    prior_exit_hours: tuple[float, ...] = ()  # hours of his earlier exits, from the wander history
    approaches_15m: int = 1  # trips to the door in the last 15 minutes, this one included
    lines_unheeded: int = 0  # redirect lines spoken while he kept heading out


@dataclass(frozen=True)
class Verdict:
    score: int
    action: str  # ignore | speak_only | escalate
    reasons: tuple[str, ...] = field(default_factory=tuple)
    probability: float = 0.0
    factors: tuple[tuple[str, float], ...] = field(default_factory=tuple)  # (signal, log-likelihood ratio)


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
    if _DISORIENTED.search(t) and not _AIR.search(t):
        return "disoriented", ""
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


# Prior: an unexplained exit at the watched door rings by itself (P = 0.60).
PRIOR: Final = math.log(0.6 / 0.4)
# Log-likelihood ratios. Signs and ordering follow the wandering literature (time of night, nightwear,
# disorientation, repeated exit-seeking, and prior wandering are the strongest predictors); magnitudes are
# hand-set so the household cases in tests/test_rules.py land in the right band.
W: Final[dict[str, float]] = {
    "face_match": 1.2,
    "face_other": -2.0,
    "said_care_circle": -3.0,
    "claimed_other_but_face_matches": 0.4,
    "errand": -0.8,
    "disoriented": 1.0,
    "confused": 0.6,
    "silence": 0.3,
    "barefoot": 1.0,
    "slippers": 0.7,
    "nightwear": 0.6,
    "night_attire": 0.9,
    "daytime": -1.0,
    "per_prior_exit_same_hour": 0.3,
    "per_extra_approach": 0.25,
    "per_unheeded_line": 0.3,
}
CAP: Final[dict[str, float]] = {"history": 0.9, "pacing": 0.75, "unheeded": 0.6}


def circadian(hour: float) -> float:
    """Night-time risk curve: highest in the small hours, a smaller bump at dusk (sundowning), low by day."""
    h = hour % 24
    if 2 <= h < 5:
        return 0.5
    if h >= 22 or h < 2:
        return 0.35
    if 5 <= h < 7:
        return 0.2
    if 16 <= h < 20:
        return 0.25
    if 8 <= h < 16:
        return -0.9
    return 0.0


def _hour_gap(a: float, b: float) -> float:
    d = abs(a - b) % 24
    return min(d, 24 - d)


def _odds(x: float) -> str:
    return f"odds x{math.exp(x):.1f}" if x >= 0 else f"odds /{math.exp(-x):.1f}"


def wander_score(f: Features) -> Verdict:
    """P(wander) as 0-100 from log-odds evidence. Unknown everything = 60 (rings)."""
    if f.direction == "entry":
        return Verdict(0, "ignore", ("arrival: came in from the door",), 0.0, (("arrival", -math.inf),))
    terms: list[tuple[str, float, str]] = []  # (signal, llr, plain-English reason)

    def add(signal: str, llr: float, why: str) -> None:
        if llr:
            terms.append((signal, llr, f"{why} ({_odds(llr)})"))

    conf = max(0.0, min(1.0, f.face_conf))
    if f.identity == "match":
        add("face", W["face_match"] * conf, f"face: monitored person, {round(conf * 100)}% sure")
    elif f.identity == "other":
        add("face", W["face_other"] * conf, "face: not the monitored person")
    if f.checkin == "self_other":
        if f.identity == "match":  # confabulation guard: he says he's someone else, the face says otherwise
            add("check-in", W["claimed_other_but_face_matches"], "check-in: gave another name, but the face is his")
        else:
            add("check-in", W["said_care_circle"], "check-in: a care-circle member identified themselves")
    elif f.checkin in ("air", "disoriented", "confused", "silence"):
        why = {
            "air": "check-in: coherent errand reply",
            "disoriented": "check-in: an obligation from an earlier life (work, home, the kids)",
            "confused": "check-in: reply did not identify anyone",
            "silence": "check-in: no answer to the door's question",
        }[f.checkin]
        add("check-in", W["errand" if f.checkin == "air" else f.checkin], why)
    feet = {"barefoot": "barefoot", "slippers": "slippers", "socks": "slippers"}.get(f.footwear, "")
    night_clothes = f.top_type in NIGHTWEAR_TOPS or f.bottom_type in NIGHTWEAR_BOTTOMS
    if feet or night_clothes:
        if feet:
            add("attire", W[feet], f"attire: {f.footwear}")
        if night_clothes:
            add("attire", W["nightwear"], "attire: nightwear")
    elif f.attire_night:
        add("attire", W["night_attire"], "attire: nightwear or barefoot")
    if not f.in_window:
        add("time", W["daytime"], "daytime")
    elif f.hour is not None:
        c = circadian(f.hour)
        if c < 0 and f.armed:
            c = 0.0
        add("time", c, f"time: {int(f.hour) % 12 or 12} {'AM' if f.hour % 24 < 12 else 'PM'} on the night curve")
    if f.hour is not None and f.prior_exit_hours:
        near = sum(1 for h in f.prior_exit_hours if _hour_gap(h, f.hour) <= 1.5)
        add(
            "history",
            min(CAP["history"], W["per_prior_exit_same_hour"] * near),
            f"history: {near} earlier exit{'s' if near != 1 else ''} near this hour",
        )
    if f.approaches_15m > 1:
        add(
            "pacing",
            min(CAP["pacing"], W["per_extra_approach"] * (f.approaches_15m - 1)),
            f"pacing: {f.approaches_15m} trips to the door in 15 min",
        )
    if f.lines_unheeded > 0:
        add(
            "redirect",
            min(CAP["unheeded"], W["per_unheeded_line"] * f.lines_unheeded),
            f"kept heading out after {f.lines_unheeded} redirect line{'s' if f.lines_unheeded != 1 else ''}",
        )
    if f.identity == "unknown":
        terms.append(("face", 0.0, "face: unknown (no change, rings by default)"))
    logit = PRIOR + sum(t[1] for t in terms)
    p = 1 / (1 + math.exp(-logit))
    score = max(0, min(100, round(p * 100)))
    action = "ignore" if score < 30 else "speak_only" if score < 60 else "escalate"
    reasons = (f"prior {round(100 * 0.6)}% (an unexplained exit rings)", *(t[2] for t in terms))
    return Verdict(score, action, reasons, round(p, 3), tuple((t[0], round(t[1], 3)) for t in terms if t[1]))
