def test_phone_env_override(monkeypatch) -> None:
    from pathlib import Path

    from nightfall.household import load

    monkeypatch.setenv("PHONE_TM_SARAH", "+15550100")
    hh = load(Path("data/household.json"))
    assert hh.tree[0].phone == "+15550100" and hh.tree[1].phone == "web"
