"""Care settings used by the caregiver UI; the incident engine remains the state authority."""

from __future__ import annotations

import asyncio
import hashlib
import os
import secrets
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from starlette.datastructures import UploadFile

from nightfall import api_app
from nightfall.household import TreeMember, normalize_phone
from nightfall.integrations import geocode
from nightfall.memory import Memory

router = APIRouter(prefix="/care")
PHOTO = Path("out/profile/photo")


def _image_type(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    raise HTTPException(422, "Choose a JPEG, PNG, or WebP photo.")


@router.post("/photo")
async def upload_photo(request: Request) -> dict:
    form = await request.form()
    photo = form.get("photo")
    if not isinstance(photo, UploadFile):
        raise HTTPException(422, "Choose a photo first.")
    data = await photo.read(5 * 1024 * 1024 + 1)
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(413, "Choose a photo smaller than 5 MB.")
    _image_type(data)
    PHOTO.parent.mkdir(parents=True, exist_ok=True)
    pending = PHOTO.with_name("photo-" + secrets.token_hex(6))
    pending.write_bytes(data)
    pending.replace(PHOTO)
    url = "/care/photo?v=" + hashlib.sha256(data).hexdigest()[:12]
    store = api_app._store()
    store.hh = replace(store.hh, person_photo=url)
    api_app._persist_household(store.hh)
    return {"ok": True, "photo": url}


@router.get("/photo")
async def get_photo() -> Response:
    try:
        data = PHOTO.read_bytes()
    except FileNotFoundError:
        raise HTTPException(404, "No profile photo yet.") from None
    return Response(data, media_type=_image_type(data), headers={"X-Content-Type-Options": "nosniff"})


class CallOrderIn(BaseModel):
    member_ids: list[str]


@router.put("/call-order")
async def call_order(body: CallOrderIn) -> dict:
    store = api_app._store()
    members = {m.id: m for m in store.hh.tree}
    if len(body.member_ids) != len(members) or set(body.member_ids) != set(members):
        raise HTTPException(422, "Include every care-circle member exactly once.")
    tree = tuple(replace(members[mid], tier=min(i + 1, 3)) for i, mid in enumerate(body.member_ids))
    store.hh = replace(store.hh, tree=tree)
    api_app._persist_household(store.hh)
    return {"ok": True, "tree": [m.__dict__ for m in tree]}


def _e164(raw: str) -> str:
    phone = normalize_phone(raw)
    if phone is None:
        raise HTTPException(422, "Enter a full phone number. Outside the US, start with + and the country code.")
    return phone


class MemberIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    relationship: str = Field(default="", max_length=60)
    phone: str = Field(default="", max_length=30)


@router.post("/members")
async def add_member(body: MemberIn, request: Request) -> dict:
    store = api_app._store()
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "Enter a name.")
    relationship, phone = body.relationship.strip(), body.phone.strip()
    if phone:
        phone = _e164(phone)
    existing = next((m for m in store.hh.tree if m.name.casefold() == name.casefold()), None)
    if existing is None:
        existing = TreeMember(
            "TM-" + secrets.token_hex(4), name, phone or "web", min(len(store.hh.tree) + 1, 3), relationship
        )
        store.hh = store.hh.with_member(existing)
        api_app._persist_household(store.hh)
    elif relationship or phone:
        existing = replace(existing, relationship=relationship or existing.relationship, phone=phone or existing.phone)
        store.hh = replace(store.hh, tree=tuple(existing if m.id == existing.id else m for m in store.hh.tree))
        api_app._persist_household(store.hh)
    base = os.environ.get("PUBLIC_URL", "").rstrip("/") or str(request.base_url).rstrip(
        "/"
    )  # a link must work off this laptop
    url = base + "/app?" + urlencode({"member": existing.id})
    return {"ok": True, "member_id": existing.id, "invitation_url": url}


@router.delete("/members/{member_id}")
async def remove_member(member_id: str) -> dict:
    store = api_app._store()
    kept = [m for m in store.hh.tree if m.id != member_id]
    if len(kept) == len(store.hh.tree):
        raise HTTPException(404, "That person is not in the care circle.")
    tree = tuple(replace(m, tier=min(i + 1, 3)) for i, m in enumerate(sorted(kept, key=lambda m: m.tier)))
    store.hh = replace(store.hh, tree=tree)
    api_app._persist_household(store.hh)
    return {"ok": True, "tree": [m.__dict__ for m in tree]}


@router.get("/address-suggest")
async def address_suggest(q: str = "") -> dict:
    """Completions for the home-address box; a lookup failure just means no suggestions."""
    q = q.strip()
    if len(q) < 4:
        return {"suggestions": []}
    try:
        return {"suggestions": await asyncio.to_thread(geocode.suggest, q[:200])}
    except Exception as error:  # noqa: BLE001 — suggestions are optional
        print(f"address suggest failed: {type(error).__name__}")
        return {"suggestions": []}


@router.post("/clear")
async def clear_everything() -> dict:
    """Erase everything the family entered and start from the blank setup. Cloned voices at Cartesia are not touched."""
    import json
    import shutil

    from nightfall import api, api_enroll, api_setup, history, medical
    from nightfall.store import ROOT, household_filename, household_path

    if household_filename() == "household.json":  # FRESH_START=0 works on the committed demo household
        raise HTTPException(409, "Clear is not available while running on the demo household (FRESH_START=0).")
    shutil.copyfile(ROOT / "data" / "household.blank.json", household_path())
    for target in (api_enroll.FACES, medical.path(), history.FILE, PHOTO):
        Path(target).unlink(missing_ok=True)
    for clip in api_app.SAMPLES.glob("*.wav"):
        clip.unlink(missing_ok=True)
    (ROOT / "data" / "places.custom.live.json").write_text(json.dumps([]) + "\n")
    api_setup.reset_state()
    store = api_app._store()
    store.voice_source, store.voice_name = "stock", ""
    await api.reset()
    store.places = []
    return {"ok": True}


class ScheduleIn(BaseModel):
    enabled: bool
    start: str = Field(pattern=r"^\d{2}:\d{2}$")
    end: str = Field(pattern=r"^\d{2}:\d{2}$")


@router.put("/schedule")
async def set_schedule(body: ScheduleIn) -> dict:
    """The on/off switch and the daily active times; the window may wrap past midnight (9 PM to 6 AM)."""
    from datetime import time

    try:
        start, end = time.fromisoformat(body.start), time.fromisoformat(body.end)
    except ValueError:
        raise HTTPException(422, "Enter times like 21:00.") from None
    if start == end:
        raise HTTPException(422, "Start and end times must be different.")
    store = api_app._store()
    store.hh = replace(store.hh, watch_enabled=body.enabled, night_start=start, night_end=end)
    api_app._persist_household(store.hh)
    return {"ok": True, "enabled": body.enabled, "start": body.start, "end": body.end}


class TestCallIn(BaseModel):
    member_id: str


class ConfirmReturnIn(BaseModel):
    incident_id: str
    member_id: str


@router.post("/confirm-return")
async def confirm_return(body: ConfirmReturnIn) -> dict:
    """A care-circle member explicitly confirms the person is safely back home."""
    from nightfall import api, engine

    store = api_app._store()
    if store.hh.member(body.member_id) is None:
        raise HTTPException(403, "Not a care-circle member.")
    if store.inc is None or store.inc.id != body.incident_id:
        raise HTTPException(409, "This alert has changed. Refresh before confirming a return.")
    if store.inc.state == engine.State.RETURNED:
        return {"ok": True, "state": "RETURNED", "returned_by": store.inc.returned_by}
    if store.inc.state not in (
        engine.State.ESCALATING,
        engine.State.ACKED,
        engine.State.EXHAUSTED,
        engine.State.WATCHING,
    ):
        raise HTTPException(409, "There is no active search to close.")
    result = await api._step("confirm_return", {"member_id": body.member_id}, expected_incident_id=body.incident_id)
    if result["to"] != "RETURNED":
        raise HTTPException(409, "This alert has changed. Refresh before confirming a return.")
    store.quiet_until = store.now() + timedelta(seconds=api.QUIET_AFTER_ACK_S)
    return {"ok": True, "state": "RETURNED", "returned_by": store.inc.returned_by}


@router.post("/test-call")
async def test_call(body: TestCallIn) -> dict:
    """Ring one care-circle member now with a short test message, through the same Twilio path as a real alert."""
    from nightfall.integrations import twilio
    from nightfall.store import PUBLIC_URL

    store = api_app._store()
    member = store.hh.member(body.member_id)
    if member is None:
        raise HTTPException(404, "That person is not in the care circle.")
    if not member.phone.startswith("+"):
        raise HTTPException(422, f"Add a phone number for {member.name} in the call order first.")
    if not twilio.enabled():
        raise HTTPException(409, "Phone calls are off: the app is in mock mode or Twilio is not set up.")
    try:
        await asyncio.to_thread(twilio.create_call, member.phone, f"{PUBLIC_URL}/twiml/test/{member.id}")
    except Exception as error:  # noqa: BLE001 — Twilio/network errors become a readable message
        print(f"test call failed: {type(error).__name__}: {error}")
        raise HTTPException(
            502, "Twilio could not place the call. Check the number, and that the account can call it."
        ) from None
    return {"ok": True, "called": member.name}


class FamiliarPlaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    note: str = Field(default="", max_length=400)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


class PlacesIn(BaseModel):
    places: list[FamiliarPlaceIn] = Field(max_length=30)


@router.put("/places")
async def familiar_places(body: PlacesIn) -> dict:
    store = api_app._store()
    rows = []
    for place in body.places:
        name = place.name.strip()
        if not name:
            raise HTTPException(422, "Enter a name for every place.")
        lat, lng = place.lat, place.lng
        if lat is None or lng is None:
            try:
                lat, lng, _ = await asyncio.to_thread(geocode.geocode, f"{name}, {store.hh.address}")
            except Exception as error:  # noqa: BLE001 — geocoder adapters can raise provider-specific errors
                print(f"familiar place geocode failed: {type(error).__name__}")
                raise HTTPException(422, f"Could not locate {name}. Add a street address to its name.") from None
        rows.append({"name": name, "note": place.note.strip(), "lat": lat, "lng": lng})
    store.hh = replace(store.hh, familiar_places=tuple(rows))
    api_app._persist_household(store.hh)
    memory = Memory(store.hh)
    await memory.ensure()
    previous, store.memory = store.memory, memory
    await previous.close()
    return {"ok": True, "places": rows}


@router.post("/demo/{scenario}")
async def demo_event(scenario: str) -> dict:
    """Explicit mock-only scenario controls; never available with real vendor integrations."""
    if os.environ.get("MOCK") != "1":
        raise HTTPException(404, "Demo mode is unavailable.")
    from nightfall import api, engine

    store = api_app._store()
    if scenario in ("start", "visitor", "home", "help"):
        if store.inc is not None:
            await store.runner.cancel(store.inc.id)
        store.inc = None
        store.history = []
        store.runner.rings = []
        store.quiet_until = None
        store.call_911_sent = False
        store.night_mode = True
        if scenario == "help":
            await api._step("sos", {})
        else:
            payload = {"identity": "match", "direction": "exit"}
            if scenario in ("visitor", "home"):
                payload = {"identity": "unknown" if scenario == "visitor" else "other", "direction": "entry"}
            await api._step("person_enter", payload)
    elif scenario == "return":
        if store.inc is None:
            raise HTTPException(409, "Start a night scenario first.")
        if store.inc.state == engine.State.CONVERSATION:
            await api._step("person_seen", {"inside": True})
        else:
            await api._step("person_back", {})
    elif scenario == "leave":
        if store.inc is None:
            raise HTTPException(409, "Start a night scenario first.")
        from nightfall.brief import coerce_clothing

        # The explicit recorded demo has a known photo; do not pair it with the unrelated default clothing fixture.
        store.frames[store.inc.id] = ["/assets/figma/demo-camera.png"]
        store.clothing[store.inc.id] = coerce_clothing(
            {"top_color": "gray", "top_type": "t-shirt", "confidence": 0.8, "source": "mock"}
        )
        await api._step("person_lost", {})
    elif scenario == "deadline":
        if store.inc is None or store.inc.exited_at is None:
            raise HTTPException(409, "Simulate an exit first.")
        store.inc.exited_at = store.now() - timedelta(seconds=engine.DEADLINE_S + 1)
        await api._step("tick", {})
    elif scenario == "other-response":
        if store.inc is None or store.inc.state not in (engine.State.ESCALATING, engine.State.EXHAUSTED):
            raise HTTPException(409, "Simulate an exit and wait for a family alert first.")
        other = next((m for m in store.hh.tree if m.tier > 1), None)
        if other is None:
            raise HTTPException(409, "Add another care-circle member first.")
        await api.ack(api.AckIn(incident_id=store.inc.id, member_id=other.id))
    else:
        raise HTTPException(404, "Unknown scenario.")
    return {"ok": True}
