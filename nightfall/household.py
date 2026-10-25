"""Household config: person, caregiver, night window, phone tree, medications, familiar places.

Frozen dataclasses so the engine cannot mutate the tree mid-incident. Loaded from data/household.json.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, replace
from datetime import time
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class TreeMember:
    id: str
    name: str
    phone: str
    tier: int


@dataclass(frozen=True)
class Household:
    id: str
    person_name: str
    person_photo: str
    caregiver_name: str
    night_start: time
    night_end: time
    home_lat: float
    home_lng: float
    radius_mi: float
    meds_opt_in: bool
    tree: tuple[TreeMember, ...]
    medications: tuple[dict[str, str], ...] = field(default_factory=tuple)
    familiar_places: tuple[dict[str, Any], ...] = field(default_factory=tuple)
    contacts: tuple[dict[str, str], ...] = field(default_factory=tuple)
    persona: str = "caregiver_clone"
    notes: tuple[dict[str, str], ...] = field(default_factory=tuple)
    person_full_name: str = ""
    person_age: int = 0
    address: str = ""
    description: dict[str, str] = field(default_factory=dict)  # height, weight, hair, eyes, sex, build, marks
    diagnosis: str = ""
    doctor: dict[str, str] = field(default_factory=dict)  # name, phone
    caregiver_relationship: str = ""

    def members_at(self, tier: int) -> list[TreeMember]:
        """Tree members at exactly this tier."""
        return [m for m in self.tree if m.tier == tier]

    def member(self, member_id: str) -> TreeMember | None:
        """Look up a member by id."""
        return next((m for m in self.tree if m.id == member_id), None)

    def with_member(self, m: TreeMember) -> Household:
        """Return a copy with one more tree member."""
        return replace(self, tree=self.tree + (m,))


def in_window(t: time, start: time, end: time) -> bool:
    """True if t in [start, end), wrapping past midnight when start > end."""
    if start <= end:
        return start <= t < end
    return t >= start or t < end


def phone_env(member_id: str) -> str:
    """Real numbers live in .env (PHONE_TM_PRIMARY=+1...), never in the tracked household file."""
    return "PHONE_" + member_id.replace("-", "_").upper()


def load(path: str | Path) -> Household:
    """Load and validate data/household.json."""
    raw: dict[str, Any] = json.loads(Path(path).read_text())
    tree = tuple(TreeMember(**{**m, "phone": os.environ.get(phone_env(m["id"]), m["phone"])}) for m in raw["tree"])
    tiers = sorted({m.tier for m in tree})
    if not tiers or tiers[0] != 1 or tiers != list(range(1, len(tiers) + 1)):
        raise ValueError("tree tiers must be contiguous from 1")
    radius = float(raw.get("radius_mi", 1.5))
    if not 0.25 < radius <= 5:
        raise ValueError("radius_mi must be in (0.25, 5]")
    return Household(
        id=raw["id"],
        person_name=raw["person_name"],
        person_photo=raw.get("person_photo", ""),
        caregiver_name=raw["caregiver_name"],
        night_start=time.fromisoformat(raw.get("night_start", "21:00")),
        night_end=time.fromisoformat(raw.get("night_end", "06:00")),
        home_lat=float(raw["home_lat"]),
        home_lng=float(raw["home_lng"]),
        radius_mi=radius,
        meds_opt_in=bool(raw.get("meds_opt_in", True)),
        tree=tree,
        medications=tuple(raw.get("medications", [])),
        familiar_places=tuple(raw.get("familiar_places", [])),
        contacts=tuple(raw.get("contacts", [])),
        persona=str(raw.get("persona", "caregiver_clone")),
        notes=tuple(raw.get("notes", [])),
        person_full_name=str(raw.get("person_full_name", "")),
        person_age=int(raw.get("person_age", 0) or 0),
        address=str(raw.get("address", "")),
        description={k: str(v) for k, v in dict(raw.get("description", {})).items()},
        diagnosis=str(raw.get("diagnosis", "")),
        doctor={k: str(v) for k, v in dict(raw.get("doctor", {})).items()},
        caregiver_relationship=str(raw.get("caregiver_relationship", "")),
    )
