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

## The moment

1. `./run.sh demo`. Open the dashboard on the laptop, Enable camera (TensorFlow.js person detector loads). Add yourself in the judge box, open the phone link on a phone, tap Enable sound.
2. Walk into the frame (simulating stepping out the front door). The detector fires `person_enter`; the door speaks the redirect in the caregiver voice and keeps talking every 8 s while you stay (4 lines max). Type a reply to steer it; Moss notes shape the next line.
3. Walk out of frame for 3 s: `person_lost`, exit timer starts (5 s in demo). The clothing model reads the last frame with you in it.
4. Phone rings. Tap Answer: live camera feed, the AI call agent's opening (time, clothing, hazards, open places), and the brief link.
5. Tap Take over the voice: quick phrases or typed lines play at the door in the caregiver voice; hold to talk sends your real voice.
6. Still out of view 45 s later: a Call 911 option appears on every phone (you dial, never the system). Walk back into frame: rings cancel, phones show returned.
7. Address setup: `/setup.html` turns any address into hazards (OpenStreetMap) in seconds and open-at-night places (Apify) in a minute.

Keys: `m` approach, `l` leave frame, `b` back in frame, `o`/`c` door.

R11 wander score (docs/TRACKS.md): direction from the door zone, voice check-in by name, face recognition against enrolled faces, attire, time. Entry from the door and a household member answering at the door never ring; unknown always does.

## What is real vs mock

| Piece | Real when | Mock otherwise |
|---|---|---|
| State machine, rules, ladder, tokens, ranking, SSE ring, webcam frames | always | |
| Door voice (Cartesia Sonic, cached, pre-synthesized) | `CARTESIA_API_KEY` + `CARTESIA_VOICE_ID` | browser SpeechSynthesis |
| Reply hearing (Cartesia Ink) | same | typed reply |
| Redirect line, clothing fields, call QA (Claude) | `ANTHROPIC_API_KEY` | scripted lines, fixture clothing |
| Memory (Moss semantic notes) | `MOSS_PROJECT_ID` + `MOSS_PROJECT_KEY` | TF-IDF over the same notes |
| Places (Apify Google Maps + OSM Overpass) | `APIFY_TOKEN` at setup, `scripts/run_actor.py` | Marina (SF) fixture |
| Family call (Twilio + TwiML agent) | `TWILIO_*` + `PUBLIC_URL` | phone page over SSE |

`MOCK=1` forces every mock. `MOCK=0` with missing keys falls back per row and prints `<name> fallback: <reason>`.
`/health` reports which rows are mock. Every brief carries `places_source` and `memory_source` badges.

## Layout

```
nightfall/   engine (pure state machine), escalation, notify, brief, search, script, household, store, actions, api
             voice, llm, call_agent, memory, places, api_voice, integrations/ (cartesia, anthropic, twilio, moss, apify, overpass)
scripts/     run_actor.py (Apify + Overpass -> data/places.<slug>.live.json)
static/      dashboard.html, phone.html, brief.html, tokens.css (light + dark), app.js
data/        household.json, places.marina.json
tests/       engine, escalation, brief, api
docs/        API.md (the contract between lanes)
```

## Evidence

Figures are the Alzheimer's Association's claims as cited in advocacy testimony and NCOA: six in ten people
with dementia wander; up to half of those not found in 24 hours are seriously injured or die; most are found
within 1.5 miles; call emergency services after a 15-minute search.
