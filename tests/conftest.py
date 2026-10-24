"""Tests always run in mock mode with no vendor keys, whatever .env says."""

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)
os.environ["MOCK"] = "1"
for key in (
    "ANTHROPIC_API_KEY",
    "CARTESIA_API_KEY",
    "CARTESIA_VOICE_ID",
    "APIFY_TOKEN",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM",
    "MOSS_PROJECT_ID",
    "MOSS_PROJECT_KEY",
    "PLACES_FILE",
):
    os.environ.pop(key, None)
os.environ["PUBLIC_URL"] = "http://127.0.0.1:8000"
# tests close incidents in milliseconds; keep them out of the real wander history and medical record
_TMP = Path(tempfile.mkdtemp(prefix="nightfall-tests-"))
os.environ["HISTORY_FILE"] = str(_TMP / "history.json")
os.environ["MEDICAL_FILE"] = str(_TMP / "medical.json")
os.environ["PLACES_FILE"] = str(ROOT / "data" / "places.marina.json")
