"""Family-call voice agent. Deterministic intents first; Claude answers open questions from brief fields only.

Runs identically behind Twilio <Gather> (speech text in) and the phone page (browser STT in). Rejected:
letting the model drive the call; the ack decision and the facts must come from code and the brief.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Final

from nightfall.household import Household
from nightfall.integrations import anthropic_llm
from nightfall.script import BANNED

ACK: Final = re.compile(
    r"\b(got him|got her|found (him|her|them)|i have (him|her)|i'?ve got|i got (it|this|him|her)|got it|"
    r"he'?s (here|home|safe|with me|ok(ay)?|fine|good|back)|she'?s (here|home|safe|with me|ok(ay)?|fine|good|back)|"
    r"(all|we'?re|it'?s|everything'?s) (good|fine|ok(ay)?)|all set|false alarm|never ?mind|"
    r"(you can )?stop calling|no need to call|i'?ll take it from here)\b",
    re.IGNORECASE,
)
RESPONDING: Final = re.compile(
    r"\b(on my way|i'?m (going|coming|heading|leaving|out)|i'?ll (go|look|find|check|head)|going (to look|out|now)|"
    r"heading (out|over)|leaving now|i'?m on it|i'?ll handle)\b",
    re.IGNORECASE,
)
FOUND: Final = re.compile(
    r"\b(got (him|her)|found (him|her|them)|i have (him|her)|(he|she)'?s (here|home|safe|with me|back))\b",
    re.IGNORECASE,
)
REPEAT: Final = re.compile(r"\b(repeat|again|say that|what did you say)\b", re.IGNORECASE)
HAZARDS: Final = re.compile(
    r"\b(hazard|danger|creek|water|rail|track|freeway|highway|where (should|do) i (look|go|start))\b", re.IGNORECASE
)
CLOTHES: Final = re.compile(r"\b(wear|wearing|clothes|clothing|shoes|barefoot|jacket|hoodie)\b", re.IGNORECASE)
CALLS: Final = re.compile(r"\b(call|phone|open|gas station|diner|hospital|police|number)\b", re.IGNORECASE)
MEDS: Final = re.compile(r"\b(meds?|medications?|medicines?|pills?|insulin)\b", re.IGNORECASE)
BYE: Final = re.compile(r"\b(bye|goodbye|hang up|that'?s all|thanks|thank you)\b", re.IGNORECASE)

QA_SYSTEM: Final = (
    "You are the Nightfall assistant on a phone call with a family member whose relative with memory loss has "
    "just left home at night. Answer like a calm, kind person on the phone: contractions, plain words, one or two short "
    "spoken sentences, using ONLY the facts "
    "below. If the facts do not contain the answer, say you do not have that and suggest they open the brief. "
    "Never invent places, times, medications or directions. Facts:\n{facts}"
)


@dataclass(frozen=True)
class Reply:
    say: str
    intent: str
    done: bool = False
    ack: bool = False


def _spoken(name: str, place: bool = True) -> str:
    """A name as you'd say it: 'X, Lombard St' -> 'X on Lombard St'; notes after a comma dropped otherwise."""
    head, _, rest = name.partition(", ")
    if not rest:
        return name
    return f"{head} on {rest}" if place and rest[:1].isupper() and len(rest.split()) <= 3 else head


def _and(xs: list[str]) -> str:
    if not xs:
        return ""
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1]


def _names(items: list[dict[str, Any]], n: int, place: bool = True) -> str:
    return _and([_spoken(p["name"], place) for p in items[:n]]) or "none listed"


def _miles(r: float) -> str:
    return {0.5: "half a mile", 1.0: "a mile", 1.5: "a mile and a half", 2.0: "two miles"}.get(r, f"{r:g} miles")


def _wearing(hh: Household, brief: dict[str, Any]) -> str:
    """Clothing as a spoken clause; never reads the brief's 'see photo' label aloud."""
    line = brief["clothing_line"]
    if not line or line == "see photo":
        return "What he was wearing is in the photo on the brief."
    parts = [p.strip() for p in line.split(",") if p.strip()]
    feet = [p for p in parts if p in ("barefoot", "slippers", "socks")]
    clothes = [p for p in parts if p not in feet]
    said = _and([("a " if i == 0 and not c.endswith("s") else "") + c for i, c in enumerate(clothes)])
    tail = {"barefoot": ", and he's barefoot", "slippers": ", in slippers", "socks": ", in his socks"}
    end = tail.get(feet[0], "") if feet else ""
    if said:
        return f"He's in {said}{end}."
    return f"He's {feet[0]}." if feet else f"He was wearing {line}."


def opening(hh: Household, brief: dict[str, Any], member_name: str) -> str:
    """The first thing the agent says. Facts only, from the brief, no model."""
    t = brief["last_seen_hhmm"]
    for_whom = "" if member_name == hh.caregiver_name else f" for {hh.caregiver_name}"
    hz, open_now = brief["hazards"], brief["call_first"]
    look = (
        f" Start close: check {_spoken(hz[0]['name'])} first"
        + (f", then {_spoken(hz[1]['name'])}." if len(hz) > 1 else ".")
        if hz
        else ""
    )
    call = f" {_spoken(open_now[0]['name'])} is open right now if you want to call." if open_now else ""
    return (
        f"Hi {member_name}, it's Nightfall{for_whom}. {hh.person_name} just walked out the front door, at {t}. "
        f"{_wearing(hh, brief)} Most people are found within {_miles(brief['home']['radius_mi'])}.{look}{call} "
        f"Say I'm on my way and I'll stop the other calls, or ask me anything."
    )


def facts(hh: Household, brief: dict[str, Any]) -> str:
    """Flat fact sheet the model may quote. Medications come from the caregiver table, never invented."""
    meds = "; ".join(f"{m['name']} {m['dose']} {m['note']}".strip() for m in brief["medications"]) or "not shared"
    return "\n".join(
        [
            f"Person: {hh.person_name}. Left home at {brief['last_seen_hhmm']}. Wearing: {brief['clothing_line']}.",
            f"Search radius: {brief['home']['radius_mi']:g} miles from home.",
            "Hazards nearest first: " + "; ".join(f"{p['name']} ({p['distance_mi']} mi)" for p in brief["hazards"]),
            "Open places to call: "
            + "; ".join(f"{p['name']} {p.get('phone', '')} ({p['distance_mi']} mi)" for p in brief["call_first"][:5]),
            "Familiar places: " + "; ".join(p["name"] for p in brief["familiar"]),
            "Habits from the caregiver's notes: " + "; ".join(h["text"] for h in brief.get("habits", [])),
            "Contacts: "
            + "; ".join(f"{c['name']} {c.get('phone', '')} {c.get('note', '')}".strip() for c in brief["contacts"]),
            f"Medications: {meds}.",
            f"Call 911 after 15 minutes of searching, at {brief['deadline_hhmm']}.",
        ]
    )


def handle(hh: Household, brief: dict[str, Any], member_name: str, text: str) -> Reply:
    """One caller turn. Deterministic intents first, then the model, then a safe default."""
    t = text.strip()
    if not t:
        return Reply("Sorry, I didn't catch that. You can say I've got him, or ask where to look.", "silence")
    if ACK.search(t) and not (RESPONDING.search(t) and not FOUND.search(t)):  # "got it, on my way" = responding
        return Reply(
            f"Oh, good. I'll let the rest of the family know {hh.person_name}'s safe. Goodnight.", "ack", True, True
        )
    if RESPONDING.search(t):
        first = brief["hazards"][0] if brief["hazards"] else None
        where = (
            f" Head for {_spoken(first['name'])} first, it's {first['distance_mi']} miles from the house."
            if first
            else ""
        )
        say = f"Okay. I've told everyone you're on your way, so nobody else gets called.{where}"
        rest_text = RESPONDING.sub(" ", t)  # "on my way, what was he wearing?" answers the question too
        if any(p.search(rest_text) for p in (HAZARDS, CLOTHES, MEDS, CALLS)):
            return Reply(f"{say} {handle(hh, brief, member_name, rest_text).say}", "responding", False, True)
        return Reply(f"{say} Tell me when you've got him, or ask me anything.", "responding", False, True)
    if REPEAT.search(t):
        return Reply(opening(hh, brief, member_name), "repeat")
    if HAZARDS.search(t):
        habit = brief.get("habits", [{}])[0].get("text", "") if brief.get("habits") else ""
        tail = f" One more thing from your notes: {habit}." if habit else ""
        return Reply(
            f"Start with {_names(brief['hazards'], 3)}. Those are the risky spots. "
            f"After that, try the places he knows: {_names(brief['familiar'], 3, place=False)}.{tail}",
            "hazards",
        )
    if CLOTHES.search(t):
        return Reply(f"{_wearing(hh, brief)} The photo is on the brief.", "clothing")
    if MEDS.search(t):
        meds = "; ".join(f"{m['name']} {m['dose']} {m['note']}".strip() for m in brief["medications"])
        return Reply(f"Medications on file: {meds}." if meds else "Medications were not shared for this brief.", "meds")
    if CALLS.search(t):
        first = brief["call_first"][:3]
        return Reply(
            "These are open right now: "
            + "; ".join(f"{p['name']}" + (f", {p['phone']}" if p.get("phone") else "") for p in first)
            + ". You can tap the numbers on the brief.",
            "calls",
        )
    if BYE.search(t):
        return Reply("Okay. The brief stays open on your phone. Good luck.", "bye", True)
    if anthropic_llm.enabled():
        try:
            out = anthropic_llm.complete(QA_SYSTEM.format(facts=facts(hh, brief)), t, max_tokens=600)
            out = out.replace(" — ", ", ").replace("—", ", ").replace("–", ", ")
            if 0 < len(out) < 400 and not any(b in out.lower() for b in BANNED):
                return Reply(out, "qa")
        except Exception as e:  # noqa: BLE001
            print(f"anthropic qa fallback: {e}")
    return Reply(
        "I can tell you what he's wearing, where to look, or who's open to call. The rest is on the brief.", "unknown"
    )
