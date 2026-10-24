#!/usr/bin/env python3
"""Send one real image to Claude and print what comes back. Not part of the app or the test gate.

The point is to exercise the request shape against the live API once, in isolation, so a wrong
parameter name surfaces here and not in the middle of the demo wiring.

    ANTHROPIC_API_KEY=sk-... .venv/bin/python scripts/vision_smoke.py photo.jpg
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

def load_dotenv(path: Path) -> list[str]:
    """Read .env the way run.sh does, so this script works the same way the demo does."""
    loaded: list[str] = []
    if not path.exists():
        return loaded
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]                      # quoted: keep verbatim
        else:
            value = re.split(r"\s#", value, maxsplit=1)[0].strip()  # drop inline comment
        if value and key not in os.environ:
            os.environ[key] = value
            loaded.append(key)
    return loaded


ROOT = Path(__file__).resolve().parent.parent
_LOADED = load_dotenv(ROOT / ".env")

from nightfall import vision  # noqa: E402
from nightfall.brief import clothing_line, coerce_clothing  # noqa: E402
from nightfall.integrations import anthropic_vision  # noqa: E402


def main(argv: list[str]) -> int:
    """Describe one image file. Returns a shell exit code."""
    if len(argv) != 2:
        print(__doc__)
        return 2
    path = Path(argv[1])
    if not path.exists():
        print(f"no such file: {path}")
        return 2
    if _LOADED:
        print(f"loaded  .env ({', '.join(_LOADED)})")
    if not anthropic_vision.configured():
        print("No Anthropic credentials found, so this would only exercise the fixture.")
        print("Put ANTHROPIC_API_KEY=sk-ant-... in .env (copy .env.example), then rerun.")
        return 2

    jpeg = path.read_bytes()
    print(f"image   {path} ({len(jpeg) / 1024:.0f} KB)")
    print(f"model   {anthropic_vision.model()}  timeout {anthropic_vision.timeout_s():g}s")

    started = time.monotonic()
    try:
        raw = anthropic_vision.describe(base64.b64encode(jpeg).decode(), vision.PROMPT, vision.SCHEMA)
    except Exception as e:
        print(f"\nFAILED after {time.monotonic() - started:.1f}s")
        print(f"  {type(e).__name__}: {e}")
        print("\nThe demo would fall back to the fixture here, so this is not fatal,")
        print("but the real description will not work until this call succeeds.")
        return 1
    elapsed = time.monotonic() - started

    # Build both shapes from the one response. Calling describe_clothing here would
    # issue a second request and print two different answers for the same image.
    report = vision.ClothingReport(
        brief=coerce_clothing({**raw, "source": "anthropic"}), full=vision.coerce_rich(raw)
    )
    print(f"\nOK in {elapsed:.1f}s\n")
    print("raw model output")
    print(json.dumps(raw, indent=2))
    lux = vision.mean_luminance(jpeg)
    if lux is not None:
        print(f"\nluminance       {lux:.0f}/255 (floor {vision.min_luminance():g})")
    print("\nbrief fields (the six in docs/API.md)")
    print(json.dumps(report.brief, indent=2))
    print(f"\nclothing_line   {clothing_line(report.brief)!r}")
    print(f"source          {report.source}")
    if elapsed > anthropic_vision.timeout_s() * 0.6:
        print(f"\nNote: {elapsed:.1f}s is close to the {anthropic_vision.timeout_s():g}s timeout.")
        print("Consider ANTHROPIC_VISION_MODEL=claude-sonnet-5 or a longer VISION_TIMEOUT_S.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
