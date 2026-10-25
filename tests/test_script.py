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


def test_blank_names_never_leave_gaps_in_the_audio() -> None:
    from dataclasses import replace

    blank = replace(load("data/household.json"), person_name="", person_full_name="", caregiver_name="")
    for key, v in SCRIPT.items():
        line = fill(v, blank)
        assert " ," not in line and ", ." not in line and "it's ." not in line, (key, line)
        assert validate(line) == (True, "ok"), (key, line)
    assert fill(SCRIPT["open"], blank).startswith("Hi, it's me.")
