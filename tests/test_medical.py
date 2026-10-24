import pytest
from fastapi.testclient import TestClient

from nightfall import api, medical


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("MEDICAL_FILE", str(tmp_path / "medical.json"))
    with TestClient(api.app) as c:
        yield c


def test_reads_the_sample_until_the_family_saves(client: TestClient) -> None:
    r = client.get("/medical").json()
    assert r["medical"]["sample"] is True and r["medical"]["blood_type"] == "O+"
    assert "AB-" in r["blood_types"] and "DNR" in r["directives"]


def test_save_merges_persists_and_cleans(client: TestClient, tmp_path) -> None:
    r = client.post("/medical", json={"blood_type": "ab-", "allergies": "latex, , peanuts ", "nonsense": "x"}).json()
    m = r["medical"]
    assert m["sample"] is False and m["blood_type"] == "AB-" and m["allergies"] == ["latex", "peanuts"]
    assert m["conditions"][0].startswith("Alzheimer")  # untouched fields carry over from the sample
    assert "nonsense" not in m and (tmp_path / "medical.json").exists()
    again = client.get("/medical").json()["medical"]
    assert again["blood_type"] == "AB-" and again["sample"] is False and again["updated_at"]


@pytest.mark.parametrize("bad", [{"blood_type": "C+"}, {"advance_directive": "maybe"}, {"date_of_birth": "March 1952"}])
def test_rejects_values_outside_the_lists(client: TestClient, bad) -> None:
    assert client.post("/medical", json=bad).status_code == 422


def test_bounds_long_input(client: TestClient) -> None:
    m = client.post("/medical", json={"emergency_notes": "x" * 5000, "conditions": ["y" * 500] * 50}).json()["medical"]
    assert len(m["emergency_notes"]) == medical.MAX_TEXT
    assert len(m["conditions"]) == medical.MAX_ITEMS and len(m["conditions"][0]) == medical.MAX_ITEM
