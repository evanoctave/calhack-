from nightfall import llm
from nightfall.household import load
from nightfall.script import validate

hh = load("data/household.json")


def test_next_line_mock_is_valid_and_contextual() -> None:
    line, src = llm.next_line(hh, [("system", "x."), ("person", "I need to go to the store")])
    assert src == "mock" and validate(line)[0] and "closed" in line
    line2, _ = llm.next_line(hh, [("system", "x."), ("person", "who are you")])
    assert validate(line2)[0] and "still dark" in line2


def test_banned_model_output_falls_back(monkeypatch) -> None:
    monkeypatch.setattr(llm.anthropic_llm, "enabled", lambda: True)
    monkeypatch.setattr(llm.anthropic_llm, "complete", lambda *a, **k: "You're confused, Dad, stop.")
    line, src = llm.next_line(hh, [("system", "x."), ("person", "I want to leave")])
    assert src == "mock" and validate(line)[0]


def test_good_model_output_used(monkeypatch) -> None:
    monkeypatch.setattr(llm.anthropic_llm, "enabled", lambda: True)
    monkeypatch.setattr(llm.anthropic_llm, "complete", lambda *a, **k: "I'm right here, Dad. Let's sit down together.")
    line, src = llm.next_line(hh, [("system", "x."), ("person", "where is everyone")])
    assert src == "anthropic" and line.startswith("I'm right here")


def test_memory_hits() -> None:
    assert "Palace" in llm.memory_hits(hh, "I have to get to the Palace")[0]
    assert llm.memory_hits(hh, "hello") == []


def test_describe_clothing_mock_and_garbage(monkeypatch) -> None:
    assert llm.describe_clothing(None)["top_color"] == "navy"
    monkeypatch.setattr(llm.anthropic_llm, "enabled", lambda: True)
    monkeypatch.setattr(llm.anthropic_llm, "complete", lambda *a, **k: "not json at all")
    c = llm.describe_clothing(b"\xff\xd8")
    assert c["top_color"] == "unknown" and c["confidence"] == 0.0
    monkeypatch.setattr(
        llm.anthropic_llm,
        "complete",
        lambda *a, **k: '{"top_color":"teal","top_type":"hoodie","footwear":"flip","confidence":0.9}',
    )
    c = llm.describe_clothing(b"\xff\xd8")
    assert c == {**c, "top_color": "unknown", "top_type": "hoodie", "footwear": "unknown", "source": "anthropic"}


def test_persona_prompt_uses_only_the_form_and_wrong_address_is_caught() -> None:
    from dataclasses import replace

    hh = replace(load("data/household.json"), person_name="Bob", person_full_name="Bob Miller", caregiver_name="Sarah")
    hh = replace(hh, caregiver_relationship="daughter")
    prompt = llm.persona_prompt(hh)
    assert "Sarah, Bob's daughter" in prompt and "only 'Bob'" in prompt and "adult child" not in prompt
    assert llm._wrong_address(hh, "Here, Mum, take my arm and we'll walk back.")
    assert llm._wrong_address(hh, "Let's go, Dad, nice and slow.")
    assert not llm._wrong_address(hh, "It's still dark out, Bob. Let's go back to bed.")
    # a name that really is "Dad" on the form is fine
    assert not llm._wrong_address(replace(hh, person_name="Dad"), "Come back inside, Dad.")
