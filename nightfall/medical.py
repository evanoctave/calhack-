"""Medical record for the person in care: blood type, allergies, conditions, care team, directives.

Lives in data/medical.json, which is gitignored: the repo is public and this is health information.
Until the family saves their own, reads fall back to data/medical.sample.json (demo data, tracked).
Kept apart from household.json on purpose: the alert flow never reads it, so editing it cannot change
what the door says or who gets called. Height and weight stay in household.description, where the
missing-person brief already reads them.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Final

ROOT: Final = Path(__file__).resolve().parent.parent
SAMPLE: Final = ROOT / "data" / "medical.sample.json"
BLOOD_TYPES: Final = ("", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "Unknown")
DIRECTIVES: Final = ("", "Full code", "DNR", "DNR / POLST on file", "Not sure")
TEXT_FIELDS: Final = (
    "date_of_birth",
    "mobility",
    "communication",
    "implants",
    "preferred_hospital",
    "insurance_provider",
    "insurance_member_id",
    "emergency_notes",
)
LIST_FIELDS: Final = ("allergies", "conditions")
MAX_TEXT: Final = 300
MAX_ITEMS: Final = 20
MAX_ITEM: Final = 80


def path() -> Path:
    return Path(os.environ.get("MEDICAL_FILE", str(ROOT / "data" / "medical.json")))


def empty() -> dict[str, Any]:
    return {"blood_type": "", "advance_directive": "", **dict.fromkeys(TEXT_FIELDS, ""), **{k: [] for k in LIST_FIELDS}}


def load() -> dict[str, Any]:
    """The saved record, else the sample, else blanks. `sample` says which one the family is looking at."""
    for p, sample in ((path(), False), (SAMPLE, True)):
        try:
            raw = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        return {**empty(), **clean(raw), "sample": sample, "updated_at": str(raw.get("updated_at", ""))}
    return {**empty(), "sample": True, "updated_at": ""}


def clean(raw: dict[str, Any]) -> dict[str, Any]:
    """Keep known fields only, trimmed and bounded. Raises ValueError on a value outside a fixed list."""
    out: dict[str, Any] = {}
    if "blood_type" in raw:
        bt = str(raw["blood_type"] or "").strip().upper().replace("UNKNOWN", "Unknown")
        if bt not in BLOOD_TYPES:
            raise ValueError(f"blood type must be one of {', '.join(b for b in BLOOD_TYPES if b)}")
        out["blood_type"] = bt
    if "advance_directive" in raw:
        d = str(raw["advance_directive"] or "").strip()
        if d not in DIRECTIVES:
            raise ValueError(f"advance directive must be one of {', '.join(x for x in DIRECTIVES if x)}")
        out["advance_directive"] = d
    for k in TEXT_FIELDS:
        if k in raw:
            out[k] = str(raw[k] or "").strip()[:MAX_TEXT]
    if out.get("date_of_birth"):
        try:
            datetime.strptime(out["date_of_birth"], "%Y-%m-%d")
        except ValueError as e:
            raise ValueError("date of birth must be YYYY-MM-DD") from e
    for k in LIST_FIELDS:
        if k in raw:
            items = raw[k] if isinstance(raw[k], list) else str(raw[k] or "").split(",")
            out[k] = [s for s in (str(i).strip()[:MAX_ITEM] for i in items) if s][:MAX_ITEMS]
    return out


def save(changes: dict[str, Any]) -> dict[str, Any]:
    """Merge changes into the current record (sample included) and write it atomically."""
    current = {k: v for k, v in load().items() if k not in ("sample", "updated_at")}
    record = {**current, **clean(changes), "updated_at": datetime.now().astimezone().isoformat(timespec="seconds")}
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(record, indent=2) + "\n")
    tmp.replace(p)
    return {**record, "sample": False}
