# Nightfall

Night-exit guardian for people with dementia living at home. When someone heads for the door at
2 AM, Nightfall talks them back to bed in a familiar voice. If they leave anyway, the camera keeps
the frame of what they were wearing, the family phone tree rings in order, and every phone gets a
missing-person brief: photo, clothing, medications, a 1.5-mile map with hazards and open-all-night
places to call first, and the local non-emergency number.

Cal Hacks 13.0. See `NIGHTFALL-MASTER-PROMPT.md` for the full spec and team lanes.

## Run

```
./run.sh          # serves http://127.0.0.1:8000 in mock mode, no keys
./run.sh demo     # all interfaces, short timers, live places file, prints the phone URL
./run.sh test
./run.sh check    # gate before every commit
```

Demo knobs: `DOOR_WAIT_S=5 ESCALATION_STEP_S=10 ./run.sh` shortens the waits.

## The moment (mock)

1. Open `http://127.0.0.1:8000`. Type your name in the judge box, open the phone page link on a phone (or a second tab), tap Enable sound.
2. Press Simulate approach (or enable the camera and walk into the right third of the frame). The browser speaks the redirect line.
3. Press Open door, then wait 20 s (or Close door). The phone page rings and speaks the message.
4. Tap Open brief on the phone: photo, clothing, meds, map with red hazards and green call-first pins, 15-minute clock.
5. Tap I've got him. Rings stop. The dashboard log shows every transition with its rule id.

## What is real vs mock

| Piece | Real when | Mock otherwise |
|---|---|---|
| State machine, rules, ladder, tokens, ranking, SSE ring, webcam frames | always | |
| Door voice (Cartesia Sonic, cached, pre-synthesized) | `CARTESIA_API_KEY` + `CARTESIA_VOICE_ID` | browser SpeechSynthesis |
| Reply hearing (Cartesia Ink) | same | typed reply |
| Redirect line, clothing fields, call QA (Claude) | `ANTHROPIC_API_KEY` | scripted lines, fixture clothing |
| Memory (Moss semantic notes) | `MOSS_PROJECT_ID` + `MOSS_PROJECT_KEY` | TF-IDF over the same notes |
| Places (Apify Google Maps + OSM Overpass) | `APIFY_TOKEN` at setup, `scripts/run_actor.py` | Fullerton fixture |
| Family call (Twilio + TwiML agent) | `TWILIO_*` + `PUBLIC_URL` | phone page over SSE |

`MOCK=1` forces every mock. `MOCK=0` with missing keys falls back per row and prints `<name> fallback: <reason>`.
`/health` reports which rows are mock. Every brief carries `places_source` and `memory_source` badges.

## Layout

```
nightfall/   engine (pure state machine), escalation, notify, brief, search, script, household, store, actions, api
             voice, llm, call_agent, memory, places, api_voice, integrations/ (cartesia, anthropic, twilio, moss, apify, overpass)
scripts/     run_actor.py (Apify + Overpass -> data/places.<slug>.live.json)
static/      dashboard.html, phone.html, brief.html, tokens.css (light + dark), app.js
data/        household.json, places.fullerton.json
tests/       engine, escalation, brief, api
docs/        API.md (the contract between lanes)
```

## Evidence

Figures are the Alzheimer's Association's claims as cited in advocacy testimony and NCOA: six in ten people
with dementia wander; up to half of those not found in 24 hours are seriously injured or die; most are found
within 1.5 miles; call emergency services after a 15-minute search.
