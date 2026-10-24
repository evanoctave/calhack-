from nightfall.household import load
from nightfall.script import SCRIPT, fill, validate


def test_every_scripted_line_validates() -> None:
    hh = load("data/household.json")
    for v in SCRIPT.values():
        assert validate(fill(v, hh)) == (True, "ok")


def test_banned_and_digits_and_length() -> None:
    assert validate("You're confused, Dad, stop.")[0] is False
    assert validate("Take 2 pills.")[0] is False
    assert validate("It's 2 AM, Dad. Let's go back to bed.")[0] is True
    assert validate("x" * 139 + ".")[0] is False
    assert validate("No period here")[0] is False
