import pytest
from fastapi.testclient import TestClient

from nightfall import api, api_enroll


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(api_enroll, "FACES", tmp_path / "faces.json")
    with TestClient(api.app) as c:
        yield c


def test_enroll_roundtrip(client: TestClient) -> None:
    assert client.get("/enroll").json() == {"faces": []}
    assert (
        client.post("/enroll", json={"label": "person", "name": "Robert", "descriptor": [0.1] * 127}).status_code == 422
    )
    assert client.post("/enroll", json={"label": "cat", "name": "x", "descriptor": [0.1] * 128}).status_code == 422
    assert (
        client.post("/enroll", json={"label": "person", "name": "Robert", "descriptor": [0.1] * 128}).json()["count"]
        == 1
    )
    assert (
        client.post("/enroll", json={"label": "person", "name": "robert", "descriptor": [0.2] * 128}).json()["count"]
        == 1
    ), "re-enroll replaces"
    assert (
        client.post("/enroll", json={"label": "other", "name": "Mike", "descriptor": [0.3] * 128}).json()["count"] == 2
    )
    faces = client.get("/enroll").json()["faces"]
    assert [f["name"] for f in faces] == ["robert", "Mike"] and len(faces[0]["descriptor"]) == 128
    assert client.delete("/enroll/MIKE").json()["count"] == 1
