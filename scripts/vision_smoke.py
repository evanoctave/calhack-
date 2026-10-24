#!/usr/bin/env python3
"""Send one real image to Claude and print what comes back. Not part of the app or the test gate.

The point is to exercise the request shape against the live API once, in isolation, so a wrong
parameter name surfaces here and not in the middle of the demo wiring.

    ANTHROPIC_API_KEY=sk-... .venv/bin/python scripts/vision_smoke.py photo.jpg
"""
from __future__ import annotations

import base64
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nightfall import vision  # noqa: E402
from nightfall.brief import clothing_line  # noqa: E402
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
    if not anthropic_vision.configured():
        print("ANTHROPIC_API_KEY is not set, so this would only exercise the fixture.")
        print("Set it in .env or inline:  ANTHROPIC_API_KEY=sk-... .venv/bin/python scripts/vision_smoke.py photo.jpg")
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

    report = vision.describe_clothing(jpeg)
    print(f"\nOK in {elapsed:.1f}s\n")
    print("raw model output")
    print(json.dumps(raw, indent=2))
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
