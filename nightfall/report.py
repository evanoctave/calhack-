"""Morning report: how last night went and the pattern across the week, for the family over coffee.

Reads only data/history.json (one row per closed incident), so it cannot change the alert flow. A night
runs 18:00 to 18:00, so a 2 AM exit and the morning after belong to the night before. Claude writes a
short summary from the computed facts only; the template is the mock and the fallback. Until the family
has three nights of their own in the week, data/history.sample.json fills the empty nights, flagged.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import median
from typing import Any, Final

from nightfall import history
from nightfall.household import Household
from nightfall.integrations import anthropic_llm

ROOT: Final = Path(__file__).resolve().parent.parent
SAMPLE: Final = ROOT / "data" / "history.sample.json"
NIGHTS: Final = 7
DAY_SHIFT: Final = timedelta(hours=18)
EXITS: Final = ("returned", "acked", "exhausted", "sos")
NO_HEADING: Final = frozenset({"", "unknown", "left", "right", "far", "top"})  # raw camera edges say nothing
OUTCOME: Final = {
    "returned": "Came back inside on {his} own",
    "acked": "Family answered",
    "exhausted": "Nobody answered; everyone was called",
    "sos": "Help button pressed",
    "stand_down": "Family said he was fine",
    "watch_only": "Came to the door, did not leave",
    "visitor": "A visitor at the door",
    "closed": "Ended",
}
SYSTEM: Final = (
    "You write the morning report for an adult child caring for a parent with dementia at home. Use only the "
    "facts given. Three short sentences, 60 words at most, warm and plain, like a calm friend: first how last night went, "
    "then the pattern this week, then one small practical idea about timing or routine drawn from the pattern. "
    "Never give medical or medication advice, never diagnose, never invent events, places or people. "
    "Write times as a person would say them (about 2 AM). Reply with the report only."
)
_cache: dict[str, str] = {}


def night_of(t: datetime) -> date:
    return (t - DAY_SHIFT).date()


def _rows(now: datetime) -> list[dict[str, Any]]:
    """Real incidents in the window, plus flagged sample nights while the family has fewer than three."""
    first = night_of(now) - timedelta(days=NIGHTS - 1)
    real = []
    for r in history.load():
        t = _ts(r.get("opened_at"))
        if t is not None and night_of(t) >= first:
            real.append({**r, "sample": False})
    have = {night_of(_ts(r["opened_at"])) for r in real}
    if len(have) >= 3 or os.environ.get("REPORT_SAMPLE", "1") == "0":
        return real
    try:
        sample = json.loads(SAMPLE.read_text())
    except (OSError, ValueError):
        return real
    out = list(real)
    base = night_of(now)
    for s in sample:
        night = base - timedelta(days=int(s["night_offset"]))
        if night in have or night < first:
            continue
        hh, mm = (int(x) for x in s["time"].split(":"))
        day = night + timedelta(days=1) if hh < 18 else night
        opened = datetime(day.year, day.month, day.day, hh, mm, tzinfo=now.tzinfo)
        left = s["outcome"] in EXITS
        out.append(
            {
                "incident_id": f"SAMPLE-{s['night_offset']}-{s['time']}",
                "opened_at": opened.isoformat(),
                "exited_at": opened.isoformat() if left else None,
                "minutes_out": float(s.get("minutes_out", 0)) if left else 0,
                "outcome": s["outcome"],
                "heading": s.get("heading", "unknown"),
                "acked_by": s.get("acked_by"),
                "sample": True,
            }
        )
    return out


def _ts(v: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(v)) if v else None
    except ValueError:
        return None


def _clock(t: datetime) -> str:
    return t.strftime("%-I:%M %p")


def _window(hours: list[float]) -> str:
    """'around 2 AM' from exit hours (after-midnight hours count past 24 so 11 PM and 1 AM stay close)."""
    if not hours:
        return ""
    m = median(h + 24 if h < 18 else h for h in hours) % 24
    h = round(m * 2) / 2
    whole, half = int(h) % 24, h % 1
    label = f"{whole % 12 or 12}{':30' if half else ''} {'AM' if whole < 12 else 'PM'}"
    return "around " + label


def build(hh: Household, now: datetime) -> dict[str, Any]:
    names = {m.id: m.name for m in hh.tree}
    she = str(hh.description.get("sex", "")).lower().startswith("f")
    he, his = ("she", "her") if she else ("he", "his")
    rows = sorted(_rows(now), key=lambda r: r["opened_at"])
    keys = [night_of(now) - timedelta(days=i) for i in range(NIGHTS - 1, -1, -1)]
    by: dict[date, list[dict[str, Any]]] = {k: [] for k in keys}
    for r in rows:
        k = night_of(_ts(r["opened_at"]))  # type: ignore[arg-type]
        if k in by:
            by[k].append(r)
    week = [
        {
            "night": k.isoformat(),
            "label": k.strftime("%a"),
            "approaches": len(by[k]),
            "exits": sum(1 for r in by[k] if r["outcome"] in EXITS),
            "sample": any(r["sample"] for r in by[k]),
        }
        for k in keys
    ]
    last_key = keys[-1]
    evening = now.hour >= 18 or now.hour < 6
    events = [
        {
            "time": _clock(_ts(r["opened_at"])),  # type: ignore[arg-type]
            "outcome": r["outcome"],
            "label": OUTCOME.get(r["outcome"], r["outcome"]).format(his=his),
            "minutes_out": r.get("minutes_out", 0),
            "heading": "" if (r.get("heading") or "") in NO_HEADING else r["heading"],
            "answered_by": names.get(r.get("acked_by") or "", ""),
            "sample": r["sample"],
        }
        for r in by[last_key]
    ]
    exits = [r for r in rows if r["outcome"] in EXITS]
    last_exits = [e for e in events if e["outcome"] in EXITS]
    facts = {
        "person": hh.person_name,
        "pronoun": he,
        "night_label": "tonight so far" if evening else "last night",
        "last_night": {
            "door_approaches": len(events),
            "left_the_house": len(last_exits),
            "longest_minutes_out": max((e["minutes_out"] for e in last_exits), default=0),
            "came_back_on_own": sum(1 for e in last_exits if e["outcome"] == "returned"),
            "answered_by": sorted({e["answered_by"] for e in last_exits if e["answered_by"]}),
            "times": [e["time"] for e in events],
        },
        "week": {
            "nights": NIGHTS,
            "nights_he_left": sum(1 for w in week if w["exits"]),
            "nights_at_the_door": sum(1 for w in week if w["approaches"]),
            "usual_time": _window(
                [_ts(r["exited_at"]).hour + _ts(r["exited_at"]).minute / 60 for r in exits if r.get("exited_at")]
            ),  # type: ignore[union-attr]
            "typical_minutes_out": round(sum(r["minutes_out"] for r in exits) / len(exits), 1) if exits else 0,
            "headings": sorted({r["heading"] for r in exits if (r.get("heading") or "") not in NO_HEADING}),
        },
    }
    text, source = summary(facts)
    return {
        "ok": True,
        "generated_at": now.isoformat(timespec="seconds"),
        "person_name": hh.person_name,
        "night_label": "Tonight so far" if evening else "Last night",
        "night": last_key.isoformat(),
        "includes_sample": any(r["sample"] for r in rows),
        "events": events,
        "week": week,
        "facts": facts,
        "summary": text,
        "summary_source": source,
    }


def template(f: dict[str, Any]) -> str:
    p, ln, wk, he = f["person"], f["last_night"], f["week"], f.get("pronoun", "he")
    if not ln["door_approaches"]:
        first = f"{p} stayed in all {f['night_label']}; the door was quiet."
    elif not ln["left_the_house"]:
        n = ln["door_approaches"]
        first = (
            f"{p} came to the door {'once' if n == 1 else f'{n} times'} {f['night_label']} and was talked back to bed."
        )
    else:
        who = " and ".join(ln["answered_by"])
        how = f"{who} answered" if who else f"{he} came back inside on {'her' if he == 'she' else 'his'} own"
        first = f"{p} went out {f['night_label']} for about {round(ln['longest_minutes_out'])} minutes, and {how}."
    if wk["nights_he_left"]:
        second = f" {he.capitalize()} has left on {wk['nights_he_left']} of the last {wk['nights']} nights" + (
            f", usually {wk['usual_time']}." if wk["usual_time"] else "."
        )
        third = " A calm check-in a little before that time may help." if wk["usual_time"] else ""
    else:
        second, third = f" No exits in the last {wk['nights']} nights.", ""
    return first + second + third


def summary(facts: dict[str, Any]) -> tuple[str, str]:
    """Claude's wording of the facts, cached per set of facts; the template when mocked or on any failure."""
    tmpl = template(facts)
    if not anthropic_llm.enabled():
        return tmpl, "template"
    key = hashlib.sha1(json.dumps(facts, sort_keys=True).encode()).hexdigest()
    if key in _cache:
        return _cache[key], "claude"
    try:
        out = anthropic_llm.complete(SYSTEM, json.dumps(facts), max_tokens=300, timeout=12.0)
        low = out.lower()
        if 30 < len(out) < 600 and not any(w in low for w in ("medication", "dose", "diagnos", "prescri")):
            _cache[key] = out
            return out, "claude"
    except Exception as e:  # noqa: BLE001
        print(f"anthropic report fallback: {e}")
    return tmpl, "template"
