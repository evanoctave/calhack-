"""The ExitEvent: what the perception lane hands every other lane when someone leaves.

One frozen record, built once at exit and never mutated. The full field set is declared here even
where a later step fills it in (snapshot_path, direction, exit_side), so the fixture other lanes
build against does not change shape under them. Rejected: emitting a bare dict; the enums below are
the only guard against a typo reaching the brief.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime
from pathlib import Path
from typing import Any, Final

from nightfall.engine import Incident
from nightfall.household import Household
from nightfall.vision import ClothingReport

DIRECTIONS: Final = frozenset({"north", "northeast", "east", "southeast", "south", "southwest",
                               "west", "northwest", "unknown"})
EXIT_SIDES: Final = frozenset({"left", "right", "unknown"})
DETECTORS: Final = frozenset({"motion", "person", "simulated", "door_sensor", "unknown"})


def _pick(value: Any, allowed: frozenset[str]) -> str:
    """Any value outside its enum becomes unknown. The brief never renders a typo."""
    v = str(value).lower().strip()
    return v if v in allowed else "unknown"


@dataclass(frozen=True)
class ExitEvent:
    """One exit, as handed to the voice, geo and brief lanes."""

    incident_id: str
    occurred_at: str
    lat: float
    lng: float
    clothing: dict[str, Any] = field(default_factory=dict)
    clothing_full: dict[str, Any] = field(default_factory=dict)
    clothing_line: str = "see photo"
    clothing_source: str = "mock"
    snapshot_path: str | None = None
    direction: str = "unknown"
    exit_side: str = "unknown"
    detector: str = "unknown"

    def to_dict(self) -> dict[str, Any]:
        """JSON-ready dict. The wire shape other lanes consume."""
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        """Pretty JSON, used to write the fixture."""
        return json.dumps(self.to_dict(), indent=indent) + "\n"

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "ExitEvent":
        """Rebuild from the wire shape, coercing every enum. Unknown keys are dropped."""
        known = {f.name for f in fields(cls)}
        data = {k: v for k, v in raw.items() if k in known}
        data["direction"] = _pick(data.get("direction", "unknown"), DIRECTIONS)
        data["exit_side"] = _pick(data.get("exit_side", "unknown"), EXIT_SIDES)
        data["detector"] = _pick(data.get("detector", "unknown"), DETECTORS)
        return cls(**data)


def build(inc: Incident, hh: Household, report: ClothingReport, now: datetime,
          snapshot_path: str | None = None, direction: str = "unknown",
          exit_side: str = "unknown", detector: str = "unknown") -> ExitEvent:
    """Assemble the event. Last-known position is the home from household.json, never a literal."""
    from nightfall.brief import clothing_line

    occurred = inc.exited_at or now
    return ExitEvent(
        incident_id=inc.id,
        occurred_at=occurred.isoformat(),
        lat=hh.home_lat,
        lng=hh.home_lng,
        clothing=dict(report.brief),
        clothing_full=dict(report.full),
        clothing_line=clothing_line(report.brief),
        clothing_source=report.source,
        snapshot_path=snapshot_path,
        direction=_pick(direction, DIRECTIONS),
        exit_side=_pick(exit_side, EXIT_SIDES),
        detector=_pick(detector, DETECTORS),
    )


def load_fixture(path: str | Path) -> ExitEvent:
    """Read the canonical fixture the other lanes build against."""
    return ExitEvent.from_dict(json.loads(Path(path).read_text()))
