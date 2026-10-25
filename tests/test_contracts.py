"""Every example in /contracts must validate against its schema."""

import json
from pathlib import Path

import pytest

jsonschema = pytest.importorskip("jsonschema")
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parent.parent / "contracts"


def _validator(name: str):
    registry = Registry()
    for f in ROOT.glob("*.schema.json"):
        s = json.loads(f.read_text())
        registry = registry.with_resource(s["$id"], Resource.from_contents(s))
    schema = json.loads((ROOT / f"{name}.schema.json").read_text())
    return jsonschema.Draft202012Validator(schema, registry=registry)


@pytest.mark.parametrize("name", ["profile", "exit_event", "search_plan"])
def test_example_matches_schema(name):
    _validator(name).validate(json.loads((ROOT / "examples" / f"{name}.json").read_text()))


def test_demo_search_plan_fixture_matches_schema():
    plan = ROOT.parent / "data" / "search_plan.sample.json"
    _validator("search_plan").validate(json.loads(plan.read_text()))


def test_sse_examples_match_schema():
    v = _validator("sse_events")
    for event in json.loads((ROOT / "examples" / "sse_events.json").read_text()):
        v.validate(event)
