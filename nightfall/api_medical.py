"""Medical record endpoints for the caregiver app's settings. Standalone: the alert flow never calls these."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from nightfall import medical

router = APIRouter()


@router.get("/medical")
async def get_medical() -> dict[str, Any]:
    return {
        "ok": True,
        "medical": medical.load(),
        "blood_types": medical.BLOOD_TYPES[1:],
        "directives": medical.DIRECTIVES[1:],
    }


@router.post("/medical")
async def post_medical(body: dict[str, Any]) -> dict[str, Any]:
    try:
        return {"ok": True, "medical": medical.save(body)}
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
