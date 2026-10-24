"""Snapshots are evidence, but a disk problem must never take the demo down."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nightfall import api, escalation, snapshot

T0 = datetime(2026, 10, 25, 2, 3, 17)
JPEG = b"\xff\xd8\xff\xe0" + b"x" * 64


@pytest.fixture
def tmp_root(tmp_path, monkeypatch):
    monkeypatch.setenv("SNAPSHOT_DIR", str(tmp_path / "snaps"))
    return tmp_path / "snaps"


def test_writes_a_file_named_by_incident_and_time(tmp_root) -> None:
    p = snapshot.save("INC-ab12", JPEG, T0)
    assert p is not None and p.read_bytes() == JPEG
    assert p.parent.name == "INC-ab12" and p.name == "2026-10-25T02-03-17-0.jpg"


def test_index_keeps_same_second_frames_apart(tmp_root) -> None:
    paths = snapshot.save_all("INC-ab12", [JPEG, JPEG, JPEG], T0)
    assert len(set(paths)) == 3


def test_env_is_read_at_call_time(tmp_path, monkeypatch) -> None:
    """Read per call, not at import, so a test can redirect it without reimporting."""
    monkeypatch.setenv("SNAPSHOT_DIR", str(tmp_path / "a"))
    first = snapshot.save("INC-x", JPEG, T0)
    monkeypatch.setenv("SNAPSHOT_DIR", str(tmp_path / "b"))
    second = snapshot.save("INC-x", JPEG, T0)
    assert first is not None and second is not None and first.parent != second.parent


@pytest.mark.parametrize("hostile", ["../../etc/passwd", "../../../tmp/evil", "..", "/", "....//"])
def test_incident_id_cannot_escape_the_root(tmp_root, hostile: str) -> None:
    """incident_id arrives from the URL. It is hostile input."""
    p = snapshot.save(hostile, JPEG, T0)
    if p is not None:
        assert p.is_relative_to(tmp_root.resolve())
    assert not Path("/etc/passwd.jpg").exists()


def test_unwritable_destination_returns_none_and_does_not_raise(tmp_path, monkeypatch) -> None:
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("i am a file")
    monkeypatch.setenv("SNAPSHOT_DIR", str(blocker))
    assert snapshot.save("INC-x", JPEG, T0) is None


def test_empty_and_oversized_frames_are_skipped(tmp_root) -> None:
    assert snapshot.save("INC-x", b"", T0) is None
    assert snapshot.save("INC-x", b"x" * (snapshot.MAX_BYTES + 1), T0) is None


def test_save_all_keeps_the_good_frames(tmp_root) -> None:
    saved = snapshot.save_all("INC-x", [JPEG, b"", JPEG], T0)
    assert len(saved) == 2


def test_latest_is_the_frame_closest_to_the_exit() -> None:
    assert snapshot.latest(["a.jpg", "b.jpg", "c.jpg"]) == "c.jpg"
    assert snapshot.latest([]) is None


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("SNAPSHOT_DIR", str(tmp_path / "snaps"))
    monkeypatch.setattr(escalation, "LADDER", ((1, 0.05), (2, 0.05), (3, 0.0)))
    with TestClient(api.app) as c:
        c.post("/reset")
        yield c
        c.post("/reset")


def test_posted_frames_land_on_disk(client, tmp_path) -> None:
    r = client.post("/frames/INC-live", files={"f0": ("f0.jpg", JPEG, "image/jpeg")})
    assert r.status_code == 200
    assert r.json() == {"frame_ids": ["FR-0"]}, "response shape is fixed by docs/API.md"
    assert api.store.snapshots["INC-live"]
    assert Path(api.store.snapshots["INC-live"][0]).read_bytes() == JPEG


def test_reset_clears_the_saved_paths(client) -> None:
    client.post("/frames/INC-live", files={"f0": ("f0.jpg", JPEG, "image/jpeg")})
    client.post("/reset")
    assert api.store.snapshots == {}


def test_frames_reach_the_brief(client) -> None:
    """Regression: api.py imported fastapi's UploadFile, which never matches isinstance
    against the starlette instance request.form() yields, so every frame was dropped."""
    client.post("/event", json={"kind": "door_open"})
    client.post("/event", json={"kind": "door_close"})
    inc = api.store.inc
    assert inc is not None and inc.id in api.store.briefs

    client.post(f"/frames/{inc.id}", files={"f0": ("f0.jpg", JPEG, "image/jpeg")})
    assert api.store.briefs[inc.id]["exit_frames"], "the brief must carry the exit frame"
    assert api.store.briefs[inc.id]["exit_frames"][0].startswith("data:image/jpeg;base64,")
