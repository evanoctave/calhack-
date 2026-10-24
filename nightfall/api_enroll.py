"""Face enrollment: 128-d descriptors computed in the browser, stored per household in data/faces.json.
Label "person" is the monitored person; "other" is a household member. Raw images are never stored.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()
FACES = Path(os.environ.get("FACES_FILE", "data/faces.json"))


class EnrollIn(BaseModel):
    label: str
    name: str
    descriptor: list[float]


def _load() -> list[dict[str, Any]]:
    try:
        return list(json.loads(FACES.read_text())) if FACES.exists() else []
    except (OSError, ValueError):
        return []


@router.get("/enroll")
async def list_faces() -> dict[str, Any]:
    return {"faces": _load()}


@router.post("/enroll")
async def enroll(body: EnrollIn) -> dict[str, Any]:
    if body.label not in ("person", "other"):
        raise HTTPException(422, "label must be person or other")
    if len(body.descriptor) != 128 or not body.name.strip():
        raise HTTPException(422, "descriptor must have 128 values and a name")
    faces = [f for f in _load() if not (f["name"].lower() == body.name.strip().lower() and f["label"] == body.label)]
    faces.append({"label": body.label, "name": body.name.strip(), "descriptor": [round(x, 5) for x in body.descriptor]})
    FACES.parent.mkdir(parents=True, exist_ok=True)
    FACES.write_text(json.dumps(faces) + "\n")
    return {"ok": True, "count": len(faces)}


@router.delete("/enroll/{name}")
async def unenroll(name: str) -> dict[str, Any]:
    faces = [f for f in _load() if f["name"].lower() != name.lower()]
    FACES.write_text(json.dumps(faces) + "\n")
    return {"ok": True, "count": len(faces)}
