# Nightfall

**Life Alert inside a doorbell camera, for families keeping a parent with dementia at home.**

> "It was very hard taking care of my grandmother. It was hard seeing her memory diminish, and knowing that I couldn't take care of her. I couldn't get her to understand why she couldn't do things, and we just couldn't connect anymore. I didn't have what I needed. There is nothing you can say or do that would connect with them, because they're in a different world. That's why, when you see the Silver Alerts, they're broadcast around the entire neighborhood, telling everyone to look for them, because there's no other way unless someone is watching them constantly, at all times. Assistance is required, especially to balance everything else I have to do."
>
> Evan's mother, who cared for her grandmother with dementia

Six in ten people with dementia will wander. Half of those not found within 24 hours are seriously hurt or die
(Alzheimer's Association figures). Tonight, a caregiver's first fifteen minutes go to finding a photo, remembering
what Dad was wearing, and guessing which way he went.

Nightfall is a door device and a phone app. When he heads for the door at 2 AM it talks him back to bed in his
daughter's voice. If he leaves anyway, her phone rings within seconds with what he is wearing, which way he went,
a map of the dangers and the open-all-night places nearby, a live feed of the door, and a button to speak through
it in her own voice. A neighbor at the door gets a doorbell chime and a polite greeting instead. A red HELP button
on the door rings the family at any hour.

Who it is for, what we would build next, and how it makes money: `docs/PRODUCT.md`.
How it works: `docs/ARCHITECTURE.md`. Every route: `docs/API.md`. Demo day: `docs/RUNBOOK.md`.
Why it decides the way it does: `docs/DECISIONS.md`, `docs/TRACKS.md`. Voice: `docs/VOICE.md`.

Built at Cal Hacks 13.0 (UC Berkeley), October 2026.

## Run

```
./run.sh          # serves http://127.0.0.1:8000 in mock mode, no keys
./run.sh demo     # all interfaces, short timers, live places file, prints the phone URL
./run.sh test
./run.sh check    # gate before every commit
```

Demo knobs: `DOOR_WAIT_S=5 ESCALATION_STEP_S=10 ./run.sh` shortens the waits.

## Devices

Life Alert inside a doorbell camera. The laptop at `/` is the door device: camera, speaker, one red HELP button, nothing else to click. The phone at `/app?me=<name>` is the caregiver's dashboard: live feed, alert, brief, search, live voice, door settings and face enrollment. `/dashboard.html` is the admin view.

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
| Places: our Apify Actor [night-search-radius](https://apify.com/evanoctave/night-search-radius) (Overpass hazards + Google Maps open places) | `APIFY_TOKEN` at setup, `/setup.html` or `scripts/run_actor.py` | Marina (SF) fixture |
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

## What police ask for first, and where Nightfall has it ready

From AARP, the Alzheimer's Association, the BJA law-enforcement guide and the Herbert Protocol toolkit, the first
questions a dispatcher asks when a person with dementia is missing, and where each answer lives in the brief:

| Dispatcher asks | Where it is |
|---|---|
| Full name, age, physical description, a recent photo | profile photo, name and age at the top of the brief, description in the dispatcher script |
| What they were wearing | clothing from the exit frame (AI-described, the frame shown beside it) |
| When and where last seen, which way they went | exit time, home address, heading relative to the door camera |
| That they have dementia, other conditions, medication list, doctor | diagnosis in the caregiver's words, medications (opt-in), doctor contact |
| Prior wandering: how often, how long, where found | wander history from past incidents |
| Routines and familiar routes | familiar places and habits from the care notes, pinned on the map |
| Classify as "missing and at risk", ask for a Silver Alert | the dispatcher script opens with those words |

The brief carries a "Read this to the dispatcher" paragraph assembled from those fields, with a Copy button. Sources:
[AARP: what to do if an older person is missing](https://www.aarp.org/caregiving/basics/dementia-wandering-finding-missing-person/),
[BJA: Alzheimer's-aware law enforcement program guide](https://bja.ojp.gov/sites/g/files/xyckuh186/files/Publications/AlzheimersAware.pdf),
[Herbert Protocol toolkit](https://herbertprotocol.com/carer-toolkits/how-to-find-missing-person-with-dementia/),
[Alzheimer's Association: wandering](https://www.alz.org/help-support/caregiving/stages-behaviors/wandering).

## Evidence

Figures are the Alzheimer's Association's claims: six in ten people living with dementia will wander at least once
([alz.org wandering tip sheet](https://www.alz.org/getmedia/e4480fd3-e7fe-4bcb-81b3-30066c57de7f/alzheimers-dementia-wandering-behavior-ts.pdf));
if not found within 24 hours, up to half risk serious injury or death ([NCOA](https://www.ncoa.org/article/understanding-wandering-risks/));
most are found within 1.5 miles of where they were last seen, some sources say 94% ([Washoe County Sheriff](https://washoesheriff.com/general-information/staying-safe/wandering-prevention-alzheimers-and-dementia-walkaways.php));
the Association's guidance is to begin search efforts immediately and call 911 after 15 minutes.
