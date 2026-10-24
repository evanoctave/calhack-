#!/usr/bin/env bash
# ./run.sh        serve the demo on http://127.0.0.1:8000 (mock mode, no keys needed)
# ./run.sh test   run the test suite
# ./run.sh check  tests + import smoke; the gate before every commit
set -euo pipefail
cd "$(dirname "$0")"

# One file to put keys in. Created from the template on first run.
if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example - add your keys there"
fi

# Virtualenv, then dependencies whenever requirements.txt changes. The old guard
# only installed when .venv was missing, so a new dependency was never picked up
# and the feature needing it failed silently.
[ -d .venv ] || python3 -m venv .venv
if [ requirements.txt -nt .venv/.installed ]; then
  echo "installing dependencies..."
  .venv/bin/pip install -q -r requirements.txt
  touch .venv/.installed
fi
PY=.venv/bin/python

# Load .env line by line, skipping comments, blanks and blank values. An exported
# empty ANTHROPIC_API_KEY would shadow a real credential from `ant auth login`.
# Read in a loop rather than sourcing: process substitution is not available on
# every shell this has to run on, and it fails silently when it is not.
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|'#'*|' '*'#'*) continue ;;
  esac
  key=${line%%=*}
  key=${key#"${key%%[![:space:]]*}"}
  key=${key%"${key##*[![:space:]]}"}
  value=${line#*=}
  value=${value#"${value%%[![:space:]]*}"}
  case "$value" in
    \"*\"|\'*\') value=${value#?}; value=${value%?} ;;        # quoted: keep verbatim
    *) value=${value%%[[:space:]]#*}                        # drop "VALUE  # comment"
       value=${value%"${value##*[![:space:]]}"} ;;          # and trailing spaces
  esac
  # An inline value wins, so `DOOR_WAIT_S=5 ./run.sh` still shortens the demo.
  if [ "$key" != "$line" ] && [ -n "$value" ] && [ -z "${!key:-}" ]; then
    export "$key=$value"
  fi
done < .env

export MOCK="${MOCK:-1}"
case "${1:-serve}" in
  serve) exec $PY -m uvicorn nightfall.api:app --host 127.0.0.1 --port "${PORT:-8000}" ;;
  test) exec $PY -m pytest -q ;;
  check) $PY -m pytest -q && $PY -c "import nightfall.api" && echo "check: green" ;;
  *) echo "usage: ./run.sh [serve|test|check]"; exit 2 ;;
esac
