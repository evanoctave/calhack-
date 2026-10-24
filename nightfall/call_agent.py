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
    r"\b(got him|got her|found (him|her|them)|i have (him|her)|i'?ve got|he'?s (here|home|safe|with me)|she'?s (here|home|safe))\b",
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
    "just left home at night. Answer the question in one or two short spoken sentences using ONLY the facts "
    "below. If the facts do not contain the answer, say you do not have that and suggest they open the brief. "
    "Never invent places, times, medications or directions. Facts:\n{facts}"
)


@dataclass(frozen=True)
class Reply:
    say: str
    intent: str
    done: bool = False
    ack: bool = False


def _names(items: list[dict[str, Any]], n: int) -> str:
    return ", ".join(p["name"] for p in items[:n]) or "none listed"


def opening(hh: Household, brief: dict[str, Any], member_name: str) -> str:
    """The first thing the agent says. Facts only, from the brief, no model."""
    t = brief["last_seen_hhmm"]
    for_whom = "" if member_name == hh.caregiver_name else f" for {hh.caregiver_name}"
    return (
        f"{member_name}, this is Nightfall calling{for_whom}. {hh.person_name} left the house at {t} "
        f"wearing {brief['clothing_line']}. Most people are found within {brief['home']['radius_mi']:g} miles. "
        f"The nearest hazards are {_names(brief['hazards'], 2)}. Open now nearby: {_names(brief['call_first'], 2)}. "
        f"Say I've got him to stop the other calls, or ask me a question."
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
        return Reply("I did not catch that. Say I've got him, or ask me where to look.", "silence")
    if ACK.search(t):
        return Reply(
            f"Thank you. I am telling the rest of the family {hh.person_name} is safe. Goodbye.", "ack", True, True
        )
    if REPEAT.search(t):
        return Reply(opening(hh, brief, member_name), "repeat")
    if HAZARDS.search(t):
        habit = brief.get("habits", [{}])[0].get("text", "") if brief.get("habits") else ""
        tail = f" The caregiver noted: {habit}." if habit else ""
        return Reply(
            f"Check the hazards first: {_names(brief['hazards'], 4)}. Then the familiar places: {_names(brief['familiar'], 3)}.{tail}",
            "hazards",
        )
    if CLOTHES.search(t):
        return Reply(f"{hh.person_name} was wearing {brief['clothing_line']}. The photo is on the brief.", "clothing")
    if MEDS.search(t):
        meds = "; ".join(f"{m['name']} {m['dose']} {m['note']}".strip() for m in brief["medications"])
        return Reply(f"Medications on file: {meds}." if meds else "Medications were not shared for this brief.", "meds")
    if CALLS.search(t):
        first = brief["call_first"][:3]
        return Reply(
            "Open now: "
            + "; ".join(f"{p['name']} at {p.get('phone') or 'no number'}" for p in first)
            + ". The numbers are tappable on the brief.",
            "calls",
        )
    if BYE.search(t):
        return Reply("Goodbye. The brief stays open on your phone.", "bye", True)
    if anthropic_llm.enabled():
        try:
            out = anthropic_llm.complete(QA_SYSTEM.format(facts=facts(hh, brief)), t, max_tokens=600)
            out = out.replace(" — ", ", ").replace("—", ", ").replace("–", ", ")
            if 0 < len(out) < 400 and not any(b in out.lower() for b in BANNED):
                return Reply(out, "qa")
        except Exception as e:  # noqa: BLE001
            print(f"anthropic qa fallback: {e}")
    return Reply(
        "I can tell you what he was wearing, the hazards, or who to call. Everything else is on the brief.", "unknown"
    )
