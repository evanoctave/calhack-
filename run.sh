#!/usr/bin/env bash
# ./run.sh        serve the demo on http://127.0.0.1:8000 (mock mode, no keys needed)
# ./run.sh test   run the test suite
# ./run.sh check  tests + import smoke; the gate before every commit
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; fi
PY=.venv/bin/python
[ -f .env ] && set -a && . ./.env && set +a
export MOCK="${MOCK:-1}"
case "${1:-serve}" in
  serve) exec $PY -m uvicorn nightfall.api:app --host 127.0.0.1 --port "${PORT:-8000}" ;;
  test) exec $PY -m pytest -q ;;
  check) $PY -m pytest -q && $PY -c "import nightfall.api" && echo "check: green" ;;
  *) echo "usage: ./run.sh [serve|test|check]"; exit 2 ;;
esac
