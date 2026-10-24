"""Missing-person brief: structured fields only, plus HMAC tokens bound to a tree member (R5).

Clothing is a fixture here; the vision lane replaces describe_clothing. Medications appear only
with opt-in. Rejected: DB-backed sessions; a signed token needs no table and expires on its own.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Final

from nightfall.engine import Incident
from nightfall.household import Household
from nightfall.search import rank

SECRET: Final[bytes] = (os.environ.get("BRIEF_SECRET") or secrets.token_hex(16)).encode()
TTL: Final[timedelta] = timedelta(hours=24)

COLORS: Final = frozenset(
    {
        "black",
        "white",
        "gray",
        "navy",
        "blue",
        "red",
        "green",
        "yellow",
        "brown",
        "beige",
        "pink",
        "purple",
        "orange",
        "unknown",
    }
)
TOPS: Final = frozenset({"hoodie", "t-shirt", "jacket", "coat", "sweater", "shirt", "pajama top", "robe", "unknown"})
BOTTOMS: Final = frozenset({"sweatpants", "jeans", "pajama pants", "shorts", "trousers", "skirt", "unknown"})
FOOTWEAR: Final = frozenset({"barefoot", "slippers", "sneakers", "shoes", "socks", "boots", "unknown"})


class BriefError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def coerce_clothing(raw: dict[str, Any]) -> dict[str, Any]:
    """R8: every value outside its enum becomes unknown; confidence clamped to [0, 1]."""

    def pick(key: str, allowed: frozenset[str]) -> str:
        v = str(raw.get(key, "unknown")).lower().strip()
        return v if v in allowed else "unknown"

    try:
        conf = max(0.0, min(1.0, float(raw.get("confidence", 0.0))))
    except (TypeError, ValueError):
        conf = 0.0
    return {
        "top_color": pick("top_color", COLORS),
        "top_type": pick("top_type", TOPS),
        "bottom_color": pick("bottom_color", COLORS),
        "bottom_type": pick("bottom_type", BOTTOMS),
        "footwear": pick("footwear", FOOTWEAR),
        "confidence": conf,
        "source": str(raw.get("source", "mock")),
    }


def clothing_line(c: dict[str, Any]) -> str:
    """Human line for the brief; 'see photo' under 0.4 confidence."""
    if c["confidence"] < 0.4:
        return "see photo"
    parts = [f"{c['top_color']} {c['top_type']}", f"{c['bottom_color']} {c['bottom_type']}", c["footwear"]]
    return ", ".join(p.replace("unknown ", "").strip() for p in parts)


def mock_clothing() -> dict[str, Any]:
    """Fixture used when no vision model runs."""
    return coerce_clothing(
        {
            "top_color": "navy",
            "top_type": "hoodie",
            "bottom_color": "gray",
            "bottom_type": "sweatpants",
            "footwear": "barefoot",
            "confidence": 0.86,
        }
    )


def police_report(hh: Household, inc: Incident, line: str, exited: datetime, history: dict[str, Any]) -> str:
    """The sentences a caregiver reads to the dispatcher, in the order police ask for them."""
    d = hh.description
    parts = (
        d.get("sex"),
        d.get("height"),
        d.get("weight"),
        d.get("hair") and f"{d['hair']} hair",
        d.get("eyes") and f"{d['eyes']} eyes",
        d.get("build"),
        d.get("marks"),
    )
    desc = ", ".join(v for v in parts if v)
    meds = (
        "; ".join(f"{m['name']} {m['dose']}".strip() for m in hh.medications)
        if hh.meds_opt_in and hh.medications
        else "medication list on request"
    )
    if history.get("count"):
        prior = (
            f"Has wandered {history['count']} time(s) before, typically found within {history['typical_minutes']:g} minutes"
            + (", usually heading " + "/".join(history["headings"]) if history.get("headings") else "")
            + "."
        )
    else:
        prior = "No prior wandering on record."
    heading = inc.heading if inc.heading != "unknown" else "direction not seen"
    doctor = f"Doctor: {hh.doctor.get('name')} {hh.doctor.get('phone', '')}. " if hh.doctor.get("name") else ""
    return (
        f"Missing and at risk. {hh.person_full_name or hh.person_name}, age {hh.person_age or 'unknown'}, {desc}. "
        f"{hh.diagnosis or 'Has dementia'}. Last seen at home, {hh.address or 'home address on file'}, at {hhmm(exited)}, "
        f"heading {heading}. Wearing {line}. On foot. Medications: {meds}. {prior} Familiar places: "
        + "; ".join(p["name"] for p in hh.familiar_places[:3])
        + ". "
        + doctor
        + "Please consider a Silver Alert."
    )


def build(
    hh: Household,
    inc: Incident,
    clothing: dict[str, Any],
    places: list[dict[str, Any]],
    frames: list[str],
    now: datetime,
    habits: list[dict[str, Any]] | None = None,
    memory_source: str = "mock",
    history: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble the brief from structured fields. No model text here."""
    sections = rank(places, (hh.home_lat, hh.home_lng), hh.radius_mi, now, list(hh.familiar_places), list(hh.contacts))
    exited = inc.exited_at or now
    line = clothing_line(clothing)
    prose_text = prose(hh, hhmm(exited), line)
    return {
        "incident_id": inc.id,
        "person_name": hh.person_name,
        "photo": hh.person_photo,
        "exit_frames": frames[:3],
        "clothing": clothing,
        "clothing_line": line,
        "medications": list(hh.medications) if hh.meds_opt_in else [],
        "last_seen_at": exited.isoformat(),
        "deadline_at": (inc.deadline_at or exited).isoformat(),
        "last_seen_hhmm": hhmm(exited),
        "deadline_hhmm": hhmm(inc.deadline_at or exited),
        "home": {"lat": hh.home_lat, "lng": hh.home_lng, "radius_mi": hh.radius_mi},
        "hazards": sections.hazards,
        "call_first": sections.call_first,
        "familiar": sections.familiar,
        "contacts": sections.contacts,
        "prose": prose_text,
        "places_source": places[0].get("source", "fixture") if places else "none",
        "habits": [{"text": h["text"], "kind": h.get("kind", "habit")} for h in (habits or [])],
        "memory_source": memory_source,
        "person_full_name": hh.person_full_name or hh.person_name,
        "person_age": hh.person_age,
        "description": dict(hh.description),
        "diagnosis": hh.diagnosis,
        "doctor": dict(hh.doctor),
        "address": hh.address,
        "heading": inc.heading,
        "history": history or {"count": 0, "last": [], "typical_minutes": 0, "headings": []},
        "police_report": police_report(hh, inc, line, exited, history or {"count": 0}),
    }


def hhmm(dt: datetime) -> str:
    """12-hour clock without a leading zero, Windows-safe (no %-I)."""
    return dt.strftime("%I:%M %p").lstrip("0")


def prose(hh: Household, hhmm: str, line: str) -> str:
    """Two template sentences from fields; the model never adds facts here."""
    return (
        f"{hh.person_name} left home at {hhmm} wearing {line}. "
        f"Most people are found within {hh.radius_mi:g} miles; check the hazards first, then call the open places."
    )


def mint(incident_id: str, member_id: str, now: datetime) -> str:
    """Signed token: base64url(incident|member|exp).sig"""
    exp = int((now + TTL).timestamp())
    body = base64.urlsafe_b64encode(f"{incident_id}|{member_id}|{exp}".encode()).decode().rstrip("=")
    sig = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{body}.{sig}"


def verify(token: str, now: datetime) -> tuple[str, str]:
    """Return (incident_id, member_id) or raise BriefError 404 (bad) / 410 (expired)."""
    try:
        body, sig = token.split(".")
    except ValueError:
        raise BriefError(404, "bad token") from None
    want = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(sig, want):
        raise BriefError(404, "bad token")
    pad = "=" * (-len(body) % 4)
    inc_id, member_id, exp = base64.urlsafe_b64decode(body + pad).decode().split("|")
    if now.timestamp() > int(exp):
        raise BriefError(410, "expired")
    return inc_id, member_id


def load_places(path: str | Path) -> list[dict[str, Any]]:
    """Read a places file produced by the Apify Actor or the fixture."""
    p = Path(path)
    return list(json.loads(p.read_text())) if p.exists() else []
