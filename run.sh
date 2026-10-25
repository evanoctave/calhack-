#!/usr/bin/env bash
# ./run.sh        serve the demo on http://127.0.0.1:8000 (mock mode, no keys needed)
# ./run.sh demo   serve on all interfaces with short timers; prints the phone-page URL for the LAN IP
# ./run.sh tunnel demo + a Cloudflare quick tunnel; prints public https links for the phone and the door
# ./run.sh test   run the test suite
# ./run.sh check  tests + import smoke; the gate before every commit
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; fi
PY=.venv/bin/python
# .env fills in anything not already set; variables given on the command line win (MOCK=1 ./run.sh).
if [ -f .env ]; then
  _keep=$(for k in $(compgen -e); do declare -p "$k"; done)
  set -a; . ./.env; set +a
  eval "$_keep"; unset _keep
fi
export MOCK="${MOCK:-1}" PYTHONUNBUFFERED=1
PORT="${PORT:-8000}"

print_links() {  # $1 = public base URL; phone links use the first care-circle member of the active household
  read -r MEMBER_ID MEMBER_NAME <<<"$($PY - <<'PYEOF'
import json, os
f = "data/household.json" if os.environ.get("FRESH_START", "1") not in ("1", "keep") else "data/household.live.json"
try:
    m = json.load(open(f))["tree"][0]
    print(m["id"], m["name"].split()[0])
except Exception:
    print("", "")
PYEOF
)"
  echo "places:    ${PLACES_FILE:-auto: setup-page cache, else sample live run, else fixture}"
  echo "door:      http://localhost:${PORT}   (laptop = doorbell camera + speaker)"
  echo "admin:     http://localhost:${PORT}/dashboard.html"
  echo "phone app: $1/app?me=${MEMBER_NAME:-Evan}"
  [ -n "$MEMBER_ID" ] && echo "phone:     $1/phone.html#${MEMBER_ID}   (legacy page)"
}

case "${1:-serve}" in
  serve) exec $PY -m uvicorn nightfall.api:app --host "${HOST:-127.0.0.1}" --port "$PORT" ;;
  demo)
    IP=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
    export PUBLIC_URL="${PUBLIC_URL:-http://${IP:-127.0.0.1}:${PORT}}" DOOR_WAIT_S="${DOOR_WAIT_S:-5}" ESCALATION_STEP_S="${ESCALATION_STEP_S:-15}"
    print_links "$PUBLIC_URL"
    exec $PY -m uvicorn nightfall.api:app --host 0.0.0.0 --port "$PORT" ;;
  tunnel)
    # Quick tunnel (no Cloudflare account). http2 over IPv4: QUIC/IPv6 drops on phone hotspots.
    command -v cloudflared >/dev/null || { echo "cloudflared not found: brew install cloudflared"; exit 1; }
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "port $PORT is already in use (another ./run.sh?). Stop it or run: PORT=8001 ./run.sh tunnel"; exit 1
    fi
    LOG=$(mktemp -t nightfall-tunnel)
    cloudflared tunnel --url "http://localhost:${PORT}" --protocol http2 --edge-ip-version 4 --no-autoupdate >"$LOG" 2>&1 &
    CF=$!
    UV=""
    trap 'kill $CF $UV 2>/dev/null; rm -f "$LOG"' EXIT
    trap 'exit 130' INT TERM
    URL=""
    for _ in $(seq 1 60); do
      URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -n1 || true)
      [ -n "$URL" ] && break
      kill -0 "$CF" 2>/dev/null || { cat "$LOG"; echo "tunnel: cloudflared exited"; exit 1; }
      sleep 0.5
    done
    [ -n "$URL" ] || { cat "$LOG"; echo "tunnel: no trycloudflare URL after 30 s"; exit 1; }
    # The tunnel URL wins over any PUBLIC_URL in .env: Twilio and the phone must reach this process.
    export PUBLIC_URL="$URL" DOOR_WAIT_S="${DOOR_WAIT_S:-5}" ESCALATION_STEP_S="${ESCALATION_STEP_S:-15}"
    echo "tunnel:    $URL   (log: $LOG)"
    print_links "$URL"
    echo "door (remote): $URL/door.html   (/ through the tunnel redirects to the phone app)"
    $PY -m uvicorn nightfall.api:app --host 0.0.0.0 --port "$PORT" &
    UV=$!
    wait "$UV" ;;
  test) MOCK=1 exec $PY -m pytest -q ;;
  check) $PY -m ruff check nightfall scripts tests && $PY -m ruff format --check nightfall scripts tests >/dev/null && MOCK=1 $PY -m pytest -q && echo "check: green" ;;
  *) echo "usage: ./run.sh [serve|demo|tunnel|test|check]"; exit 2 ;;
esac
