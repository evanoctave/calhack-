# NIGHTFALL MASTER PROMPT (Cal Hacks 13.0)

Paste this file into Claude Code at the repo root. It is the one source of truth for the
team. Everything below is binding unless a teammate's lane doc overrides it for their lane.

## 0. One sentence

When someone with dementia heads for the door at 2 AM, Nightfall talks them back to bed in a
familiar voice; if they leave anyway, the camera keeps the frame of what they were wearing, an
AI voice agent calls the family tree in order, and every phone gets a ready-made missing-person
brief (photo, clothing, medications, 1.5-mile map with hazards and open-all-night places to call
first) inside the first minute.

## 1. Evidence (cite as the Alzheimer's Association's claims, not ours)

- Six in ten people with dementia will wander.
- Up to half of those not found within 24 hours suffer serious injury or death.
- Most are found within 1.5 miles of the last known location.
- Guidance: call emergency services after a 15-minute search.
- Sources: house.mn.gov testimony doc; ncoa.org "Understanding wandering risks".

## 2. What is real tonight vs simulated

| Piece | Demo (now) | Production path |
|---|---|---|
| Door sensor | laptop webcam motion zone + dashboard buttons / keys `o` `c` | Zigbee/HomeKit contact sensor, ESP32 reed switch |
| Camera | laptop webcam via `getUserMedia`, 5 fps ring buffer in browser | indoor RTSP camera |
| Person ID | Claude vision on exit frame: is this the enrolled person? clothing into enumerated fields | same, plus on-device model |
| Voice at door | Cartesia Sonic TTS, consented caregiver voice clone (stock voice fallback, browser TTS mock) | same |
| Hearing reply | Cartesia Ink STT (typed reply mock) | same |
| Family call | Twilio outbound call driven by AI voice agent: speaks where, when, radius, hazards; answers questions; listens for "I've got him" | same |
| Phone notification | caregiver phone page over SSE (rings, vibrates, speaks) + Twilio SMS link | push notification app |
| Places data | Apify Actor `night-search-radius` run at setup, cached; Fullerton fixture when no token | nightly Actor run per home |
| Memory | Moss semantic notes (TF-IDF mock) | Moss |
| Store | SQLite | Postgres |

## 3. Laws for Claude Code

1. `MOCK=1` default. Zero env vars: `./run.sh` serves the full demo and `./run.sh check` is green.
2. Every integration sits behind one function with the same signature in mock and real mode,
   switched by env var, falls back to mock on any exception with a printed `<name> fallback: <reason>`
   and a `source: mock` field in its output.
3. The model never decides. Deterministic code owns: night window, exit detection, escalation
   ladder, timers, who gets the link, the 15-minute banner. The model only: writes the next
   redirect line inside a template; describes the exit frame into enumerated fields; writes two
   brief sentences from structured fields; answers caller questions from brief fields only.
4. Files under 200 lines, hard cap 250. Split by responsibility.
5. Type hints everywhere, docstring on every public function. Tests after every change.
6. No secrets in the repo. Keys read only inside `nightfall/integrations/*.py`.
7. No emojis in code, UI or docs. Terse prose.
8. Explain each file in two or three sentences before writing it (what it owns, data structure,
   rejected alternative).
9. Commit at every green checkpoint. Never commit `.env`, `data/*.db*`, `out/`, `.venv/`, `node_modules/`.

## 4. Team lanes (branch per lane, merge to `main` through `docs/API.md`)

| Lane | Branch | Owns |
|---|---|---|
| Core (on main now) | `main` | `nightfall/engine.py`, `escalation.py`, `brief.py`, `api.py`, tests, `docs/API.md` |
| Voice agent | `voice-agent-feature` | `nightfall/voice.py`, `script.py`, `llm.py`, `call_agent.py`, `integrations/cartesia.py`, `anthropic.py`, `twilio.py` |
| Vision | `vision-feature` | `static/cam.js`, `nightfall/vision.py` (person match + clothing fields), `integrations/anthropic.py` vision call |
| Frontend | `frontend-feature` | `static/*.html`, design tokens, dark mode, Leaflet map |
| Apify | `apify-feature` | `actor/`, `scripts/run_actor.py`, `nightfall/search.py`, `data/places.*.json` |

The contract between lanes is `docs/API.md` and the `Brief` JSON shape. Do not change either
without a PR that updates both the doc and `tests/test_api.py`.

## 5. Architecture (light demo already on main)

```
webcam / buttons -> POST /event -> engine.step (pure state machine)
                                  -> escalation.Runner (asyncio ladder 1,2,3)
                                  -> notify.ring (SSE phone page | Twilio call agent)
                                  -> brief.build (photo, clothing, meds, places, deadline)
                                  -> GET /brief/{token} (HMAC, 24 h)
dashboard.html  phone.html  brief.html  (SSE live)
```

States: `ARMED_OFF ARMED_IDLE APPROACH CONVERSATION DOOR_OPEN EXITED ESCALATING ACKED RETURNED EXHAUSTED CLOSED`.
Events: `arm disarm motion tick door_open door_close person_seen reply exit_frames ack close`.

Rules R0-R10 (short):
- R0 triggers count only inside the night window or when manually armed.
- R1 conversation at most 90 s or 4 lines, then silence; never nags.
- R2 exit = door open and no person seen inside within 20 s, or door closed with no inside sighting.
- R3 ladder (tier 1, 60 s), (tier 2, 60 s), (tier 3, everyone + 911 guidance). Exit + 15 min: banner "Call 911 now".
- R4 any member ack stops rings; second ack no-op.
- R5 brief links HMAC-signed, 24 h, bound to a member; meds only with opt-in.
- R6 every spoken line validated: under 140 chars, no banned phrase, no digits except a time.
- R7 the model never sets state, timers, tiers or medications (import-graph test).
- R8 clothing fields only from enums; confidence under 0.4 renders "see photo"; photo always attached.
- R9 search sections: hazards by distance; call-first open-now first, top 8; familiar in caregiver order.
- R10 every event cites evidence ids that resolve.

## 6. Voice agent lane spec (branch `voice-agent-feature`)

Three jobs, all behind mocks:

1. Door redirect. `voice.say(line, persona)` -> Cartesia Sonic bytes, cached by sha1, pre-synthesized
   at boot so the door never waits on the network. `voice.hear(wav)` -> Cartesia Ink transcript.
   `llm.next_line(persona, history, memory_hits)` -> Claude writes one line inside a strict template,
   `script.validate` enforces R6, scripted fallback on any failure.
2. Family call agent. `call_agent.CallAgent` runs an outbound Twilio call. Opening line is synthesized
   in the caregiver's consented voice (the "audio deepfake" is consent-gated and persona-switchable to a
   neutral assistant voice): "This is Nightfall for Sarah. Robert left the house at 2:03 AM wearing a
   navy hoodie and gray sweatpants, barefoot. Most people are found within a mile and a half. The creek
   and the rail line are the nearest hazards. Say 'I've got him' to stop the other calls, or ask me a question."
   Caller speech goes through Twilio `<Gather input="speech">`; intent is matched by deterministic code
   (ack / repeat / question / hangup); questions are answered by Claude from brief fields only, never new facts.
   Mock mode: the same agent runs on the phone page with browser STT/TTS.
3. Brief prose. `llm.brief_prose(fields)` -> two sentences, no new facts.

Guardrails: banned phrases (`dementia`, `alzheimer`, `confused`, `you can't`, `stop`, `no!`, `wrong`,
`remember?`, `I told you`), line length cap, medications never spoken by the model unless they come from
the caregiver table, the person is never told they have dementia and never argued with.

## 7. Vision lane spec

`static/cam.js`: `getUserMedia`, 5 fps canvas, ring buffer of 150 JPEGs, motion = mean abs diff in the
door zone over threshold for 3 consecutive frames -> `POST /event {kind: motion}`. On `exit_frames_request`
over SSE, POST the frames at t-5 s, t-2 s, t-0 s to `/frames/{incident_id}` (3 max, 200 KB each).
`nightfall/vision.py`: `identify(jpeg, enrolled_photo) -> Match(is_person: bool, confidence)` and
`describe_clothing(jpeg) -> Clothing` (enums: COLORS, TOPS, BOTTOMS, FOOTWEAR; anything else `unknown`).
A non-match (a caregiver walking out) does not escalate; it logs `R2 not-person` and returns to idle.
Mock: fixture `navy hoodie, gray sweatpants, barefoot, 0.86`.

## 8. Apify lane spec

Actor `night-search-radius`: input `{lat, lng, radius_mi, familiar_places[]}`; output dataset rows
`{category, name, lat, lng, distance_mi, phone, open_24h, hours, source}`. Hazards (water, rail,
motorway, construction) and amenities (fuel, hospital, police, pharmacy, transit, 24 h shops) from
Overpass; phones and hours by calling the Google Maps Scraper Actor from inside ours. Runs at setup,
cached to `data/places.<slug>.json`, never at 2 AM. `src=apify` badge on the brief map. Fixture for
Fullerton (33.8704, -117.9242) with 24 rows, 4 of them beyond 1.5 mi to prove exclusion.

## 9. Frontend lane spec

Reference: the Claude Design mock the team shared. Reproduce its structure, then remove the
vibe-coded feel:

- Design tokens in one `static/tokens.css`: `--bg --surface --surface-2 --text --muted --accent
  --danger --ok --border --radius --font`. Light palette on `:root`, dark palette under
  `:root[data-theme="dark"]` and `@media (prefers-color-scheme: dark)`. Theme toggle persisted in
  `localStorage`, wrapped in try/catch. `color-scheme` set on both.
- Dark mode is the default at night (the dashboard runs at 2 AM); light mode available.
- One typeface (system stack or Inter), 3 sizes, 2 weights. No gradients, no glassmorphism, no
  emoji icons, no rounded-pill-everything. Borders 1 px, radius 6 px, 8 px spacing grid.
- Status is shown by text + a single colored dot, not a glowing card.
- Three pages: `dashboard.html` (state, live log, camera preview with motion zone, simulate buttons,
  judge box, QR), `phone.html` (ring, speak, "I've got him", "Open brief"), `brief.html` (photo,
  exit frames, clothing line, meds, Leaflet map with red hazards / green call-first / blue familiar,
  contacts, 15-minute countdown).
- All dynamic text through an `esc()` helper. No inline event handlers on injected HTML.

## 10. Tracks (opt in to all on Devpost)

Cartesia (voice core: Sonic TTS clone, Ink STT, pre-synth), Anthropic Claude for Public Benefit
(community: adult children in Orange County caring for a parent with dementia at home overnight;
Claude's three jobs and where each can go wrong), Microsoft Built for the Real World (measured:
exit to first ring under 5 s, brief under 30 s), Apify Best Use + Best Actor, Moss, Best People-First,
Best Hardware (only with a real sensor), Notability journal, Meta.

## 11. Demo (90 s)

1. Dashboard: "2:00 AM, night mode ON". Judge scans QR, enters name, becomes tier 1.
2. Teammate walks into the webcam door zone. Voice: "Hi Dad, it's Sarah. It's the middle of the
   night. Let's head back to bed."
3. Teammate opens the prop door and leaves. Camera keeps the last frames. 20 s debounce.
4. Judge's phone rings; the agent speaks the exit, clothing, radius and hazards. Text with link arrives.
5. Judge opens the brief: photo, clothing, meds, map, call-first list, 15-minute clock.
6. Judge says or taps "I've got him". Rings stop. Log shows ACKED with rule ids and evidence.

## 12. First instructions to Claude Code (any lane)

Read `docs/API.md` and `README.md`. Run `./run.sh check`. State your lane and the files you will
touch. Build in the order given in your lane spec, test after each file, commit at green, open a PR
to `main`. Do not edit files owned by another lane without a note in the PR.
