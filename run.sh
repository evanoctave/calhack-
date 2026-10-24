#!/usr/bin/env bash
# ./run.sh        serve the demo on http://127.0.0.1:8000 (mock mode, no keys needed)
# ./run.sh demo   serve on all interfaces with short timers; prints the phone-page URL for the LAN IP
# ./run.sh test   run the test suite
# ./run.sh check  tests + import smoke; the gate before every commit
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; fi
PY=.venv/bin/python
[ -f .env ] && set -a && . ./.env && set +a
export MOCK="${MOCK:-1}" PYTHONUNBUFFERED=1
case "${1:-serve}" in
  serve) exec $PY -m uvicorn nightfall.api:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}" ;;
  demo)
    IP=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
    export PUBLIC_URL="${PUBLIC_URL:-http://${IP:-127.0.0.1}:${PORT:-8000}}" DOOR_WAIT_S="${DOOR_WAIT_S:-5}" ESCALATION_STEP_S="${ESCALATION_STEP_S:-15}"
    echo "places:    ${PLACES_FILE:-data/places.marina.json}"
    echo "dashboard: http://localhost:${PORT:-8000}"
    echo "phone:     $PUBLIC_URL/phone.html#TM-SARAH"
    exec $PY -m uvicorn nightfall.api:app --host 0.0.0.0 --port "${PORT:-8000}" ;;
  test) MOCK=1 exec $PY -m pytest -q ;;
  check) $PY -m ruff check nightfall scripts tests && $PY -m ruff format --check nightfall scripts tests >/dev/null && MOCK=1 $PY -m pytest -q && echo "check: green" ;;
  *) echo "usage: ./run.sh [serve|demo|test|check]"; exit 2 ;;
esac
