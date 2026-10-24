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
./run.sh test
./run.sh check    # gate before every commit
```

`run.sh` creates `.env` from `.env.example` on first run and installs dependencies whenever
`requirements.txt` changes. `.env` is gitignored; fill in the keys you have and leave the rest
blank to stay on the mocks.

Demo knobs: `DOOR_WAIT_S=5 ESCALATION_STEP_S=10 ./run.sh` shortens the waits. An inline value
wins over `.env`.

## The moment (mock)

1. Open `http://127.0.0.1:8000`. Type your name in the judge box, open the phone page link on a phone (or a second tab), tap Enable sound.
2. Press Simulate approach (or enable the camera and walk into the right third of the frame). The browser speaks the redirect line.
3. Press Open door, then wait 20 s (or Close door). The phone page rings and speaks the message.
4. Tap Open brief on the phone: photo, clothing, meds, map with red hazards and green call-first pins, 15-minute clock.
5. Tap I've got him. Rings stop. The dashboard log shows every transition with its rule id.

## What is real vs mock

Real now: state machine, rules R0-R4/R8/R9, escalation ladder, HMAC brief tokens, ranking, SSE phone ring, webcam motion zone and exit frames.
Mock now: voice (browser TTS), clothing (fixture), places (Fullerton fixture), phone call (SSE page). Each lane replaces its mock behind the same interface.

## Layout

```
nightfall/   engine (pure state machine), escalation, notify, brief, search, script, household, store, actions, api
static/      dashboard.html, phone.html, brief.html, tokens.css (light + dark), app.js
data/        household.json, places.fullerton.json
tests/       engine, escalation, brief, api
docs/        API.md (the contract between lanes)
```

## Evidence

Figures are the Alzheimer's Association's claims as cited in advocacy testimony and NCOA: six in ten people
with dementia wander; up to half of those not found in 24 hours are seriously injured or die; most are found
within 1.5 miles; call emergency services after a 15-minute search.
