# Nightfall — repo overview for agents

Cal Hacks 13.0 project. A night-exit guardian for people with dementia living at home: when
someone heads for the door at 2 AM, a familiar voice talks them back to bed; if they leave anyway
the camera keeps the exit frames, the family phone tree rings in tier order, and every phone gets
a missing-person brief (photo, clothing, meds, 1.5-mile map with hazards and open-all-night places).

Start here, in order: this file, then `docs/API.md` (the contract between lanes), then
`NIGHTFALL-MASTER-PROMPT.md` (the binding team spec), then `README.md` (the demo script).

## Run

```
./run.sh          # serve http://127.0.0.1:8000, mock mode, no keys needed
./run.sh test     # pytest
./run.sh check    # pytest + import smoke; the gate before every commit
```

`run.sh` creates `.venv` on first run and installs `requirements.txt`. Demo knobs:
`DOOR_WAIT_S=5 ESCALATION_STEP_S=10 ./run.sh` shortens the waits. Verified green: 17 tests pass.

## Stack

Python 3.12+/3.13, FastAPI + uvicorn, asyncio, pytest (`asyncio_mode = "auto"` in `pyproject.toml`).
Frontend is three plain HTML files plus one shared `app.js` — no framework, no build step. Ruff
config exists (line-length 120) but ruff is not in `requirements.txt` and is not part of `check`.

## Architecture

```
webcam / dashboard buttons
   -> POST /event
      -> engine.step(incident, event)        pure state machine, the ONLY writer of incident.state
         -> actions.run_actions(...)          side effects named by the transition
            -> escalation.Runner              asyncio ladder: tier 1 -> 2 -> 3
            -> notify.SseNotifier / Hub       SSE fan-out to phone pages + dashboard
            -> brief.build                    structured brief + HMAC link
   -> GET /brief/{token}                      token-gated brief JSON
```

The hard rule from the master prompt: **deterministic code owns state, timers, tiers and
medications; a model never does.** Keep that separation when adding anything.

## Module map (`nightfall/`)

| File | Owns |
|---|---|
| `engine.py` | `State`, `Event`, `Incident`, `Transition`, `step()`. Pure — no I/O, no clock reads. Dispatch is a `TRANSITIONS` dict keyed by `(state, event kind)`; unknown pairs are no-op `"ignored"` transitions. |
| `actions.py` | Executes the action strings a transition names (`speak:*`, `capture_exit_frames`, `build_brief`, `start_escalation`, `cancel_escalation`, `banner:call_911`, `delete_frames`). This is the seam the voice/vision lanes swap. |
| `escalation.py` | `Runner`: one asyncio task per incident walking `LADDER = ((1, 60s), (2, 60s), (3, 0))`. First `ack()` sets an `asyncio.Event` that stops it. |
| `notify.py` | `Hub` (bounded per-channel SSE queues, drops oldest when full) and `SseNotifier` (rings phone channels, mirrors to dashboard). A Twilio notifier would implement the same `Notifier` protocol. |
| `brief.py` | Clothing enums + `coerce_clothing` (R8), `clothing_line`, `build()`, and HMAC `mint`/`verify` for 24 h brief tokens (R5). `mock_clothing()` is the vision-lane fixture. |
| `search.py` | `haversine_mi`, `parse_hours`, `is_open`, and `rank()` — R9 section ranking (hazards by distance; call-first open-now first, top 8; familiar in caregiver order). |
| `household.py` | Frozen `Household`/`TreeMember` dataclasses, `in_window()` night-window check, `load()` with validation (tiers contiguous from 1, radius in (0.25, 5]). |
| `script.py` | `SCRIPT` redirect templates, `fill()`, and `validate()` — R6: under 140 chars, no banned phrase, terminal punctuation, no digits outside a clock time. |
| `store.py` | `Store`, the single mutable-state object (household, places, incident, log, frames, briefs, hub, runner, lock). No DB — in-memory only. |
| `api.py` | FastAPI routes and the two SSE streams. Every event goes through `_step()` under `store.lock`. A 1 s `_ticker()` task drives `tick` events while DOOR_OPEN or ESCALATING. |

## State machine

States: `ARMED_OFF ARMED_IDLE CONVERSATION DOOR_OPEN ESCALATING ACKED RETURNED EXHAUSTED CLOSED`.
Event kinds: `motion door_open door_close person_seen reply tick ack close`.

Happy path:
`ARMED_IDLE -motion-> CONVERSATION -door_open-> DOOR_OPEN -(20 s elapsed, or door_close with nobody
seen inside)-> ESCALATING -ack-> ACKED -close-> CLOSED`.
Branches: `person_seen{inside:true}` from CONVERSATION or DOOR_OPEN goes to `RETURNED`;
`ESCALATING` plus 15 min since exit goes to `EXHAUSTED` with the call-911 banner.

Rules cited in transitions: R0 night window, R1 conversation budget (4 lines), R2 exit detection,
R3 ladder + 15-minute deadline, R4 first ack wins, R10 close/cleanup. R5–R9 live in `brief.py`,
`script.py` and `search.py`. Rule ids appear in every log line — keep citing them.

## HTTP surface

`docs/API.md` is authoritative. Summary: `GET /health /state`, `POST /arm /event /ack /tree
/frames/{incident_id} /reset`, `GET /brief/{token}`, `GET /sse/dashboard /sse/phone/{member_id}`.
`/event` rejects `ack` — acks go through `/ack` so membership is checked. `StaticFiles` is mounted
at `/` last, so `/dashboard.html`, `/phone.html`, `/brief.html`, `/tokens.css`, `/app.js` serve
from `static/`.

## Frontend (`static/`)

- `dashboard.html` — state, live log, webcam preview, simulate buttons (keys `o` `c` `m`), judge
  box that POSTs `/tree` and returns a phone-page URL. Contains the camera code inline: 5 fps
  canvas diff over the right third of the frame ("door zone"), 3 consecutive hits post `motion`,
  150-frame JPEG ring buffer posted to `/frames/{id}` on `exit_frames_request`.
- `phone.html` — subscribes to `/sse/phone/{member_id}` (member id from the URL hash), rings with
  a WebAudio oscillator, vibrates, speaks, offers "I've got him" and "Open brief".
- `brief.html` — reads the HMAC token from the URL hash, renders photo, exit frames, clothing,
  meds, contacts, a Leaflet map (red hazards / green call-first / blue familiar) and a
  15-minute countdown.
- `tokens.css` — design tokens; light on `:root`, dark under `:root[data-theme="dark"]` and
  `prefers-color-scheme`. `app.js` defaults the theme to dark (the dashboard runs at 2 AM).

All injected HTML goes through `esc()` in `app.js`. Keep it that way.

## Data

`data/household.json` — the demo household (person "Dad", caregiver "Sarah", Fullerton CA home at
33.8704/-117.9242, three-tier tree, meds, familiar places, contacts). `data/places.fullerton.json`
— the places fixture in the `Place` shape the Apify lane produces.

## Conventions (from `NIGHTFALL-MASTER-PROMPT.md` §3, binding)

1. `MOCK=1` is the default; zero env vars must still give a full demo and a green `check`.
2. Every integration sits behind one function with the same signature in mock and real mode,
   falls back to mock on any exception with a printed `<name> fallback: <reason>`, and tags its
   output `source: mock`.
3. The model never sets state, timers, tiers or medications.
4. Files under 200 lines, hard cap 250. Split by responsibility.
5. Type hints everywhere, docstring on every public function, `from __future__ import annotations`.
6. No secrets in the repo; keys read only inside `nightfall/integrations/*.py` (that package does
   not exist yet — create it when a real integration lands).
7. **No emojis in code, UI or docs.** Terse prose.
8. Commit at every green checkpoint.

## Lanes and branches

Lane ownership is in `NIGHTFALL-MASTER-PROMPT.md` §4. Branches seen on the remote: `main`, `dev`,
`Nam`, `voice-agent-feature`. The contract between lanes is `docs/API.md` plus the Brief JSON
shape — changing either needs a PR that updates the doc **and** `tests/test_api.py`. Do not edit
another lane's files without noting it in the PR.

Planned lane hooks already stubbed for replacement:
- Voice: swap the `speak:*` branch in `actions.py`; add a `Notifier` in `notify.py`.
- Vision: POST frames to `/frames/{incident_id}`; replace `brief.mock_clothing()` in `actions.py`.
- Apify: write `data/places.<slug>.json` in the `Place` shape with `source: "apify"`.

## Tests (`tests/`)

`test_engine.py` (state machine paths), `test_escalation.py` (ladder, ack, cancel, leak check via
`Runner.live()`), `test_brief.py` (clothing coercion, tokens, ranking), `test_api.py` (routes via
`TestClient`, with `LADDER` monkeypatched to 0.05 s steps). `conftest.py` puts the repo root on
`sys.path` and chdirs there, so paths resolve the same from any cwd.

## Known gaps and gotchas

- **Doc drift.** `README.md` and the master prompt list states `APPROACH`/`EXITED` and events
  `arm`/`disarm`/`exit_frames`; `engine.py` has none of them. The code is the truth.
- **`/arm {on: false}` does not disarm during the night window.** `Store.night()` returns
  `night_mode or in_window(...)`, so the time window wins. Intentional or not, test against it.
- **`BRIEF_SECRET` defaults to a fresh random secret per process**, so every brief link breaks on
  restart. Set it in `.env` if links must survive.
- **No persistence.** Everything is in `Store`; a restart or `/reset` clears incidents, logs,
  frames and briefs. The master prompt names SQLite as the production path.
- **Single household, single incident.** `store.inc` holds one incident; a new event after
  `CLOSED` starts a fresh one.
- `brief.html` loads Leaflet from `unpkg.com`, so the map needs network access.
- `file.txt` at the repo root is a stray test artifact with the contents `hello`.
- `nightfall/integrations/`, `nightfall/voice.py`, `nightfall/vision.py`, `actor/` and
  `docs/DATA-MODEL.md` are referenced in the spec but do not exist yet.

## Before you commit

Run `./run.sh check` and make sure it prints `check: green`. Never commit `.env`, `data/*.db*`,
`out/`, `.venv/` or `node_modules/`.
