#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
NIGHTFALL_PYTHON="${NIGHTFALL_PYTHON:-.venv/bin/python}"
if [ ! -x "$NIGHTFALL_PYTHON" ]; then
  echo "Create a Python 3.12+ environment and install frontend/requirements-mock.txt. See frontend/README.md."
  exit 1
fi
# Never source .env or reuse external credentials for this local mock command.
exec env MOCK=1 APIFY_TOKEN= ANTHROPIC_API_KEY= CARTESIA_API_KEY= CARTESIA_VOICE_ID= \
  TWILIO_ACCOUNT_SID= TWILIO_AUTH_TOKEN= TWILIO_FROM= MOSS_PROJECT_ID= MOSS_PROJECT_KEY= \
  PLACES_FILE=data/places.marina.json PUBLIC_URL="http://127.0.0.1:${PORT:-8000}" \
  DOOR_WAIT_S="${DOOR_WAIT_S:-20}" ESCALATION_STEP_S="${ESCALATION_STEP_S:-60}" \
  CALL_911_S="${CALL_911_S:-45}" PYTHONUNBUFFERED=1 \
  "$NIGHTFALL_PYTHON" -m uvicorn nightfall.api:app --host 127.0.0.1 \
  --port "${PORT:-8000}" --timeout-graceful-shutdown 3
