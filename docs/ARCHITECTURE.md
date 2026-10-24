# Architecture

Life Alert inside a doorbell camera. Two devices, one server, five outside services, every decision in code.

## Devices

| Device | Page | Role |
|---|---|---|
| Laptop (next to the door) | `/` → `static/door.html` | Camera, person + face detectors, speaker, microphone, one red HELP button. Nothing else to click. Only this device may send camera frames. |
| Caregiver phone | `/app?me=<name>` → `static/app.html` | Live feed, alerts, brief, search map, two-way audio (Talk / Listen), care profile, voice samples, face enrollment, door settings. |
| Admin (any browser on the laptop) | `/dashboard.html` | Everything the door does plus simulate buttons and the full event log. |

## Server (FastAPI, one process, one asyncio loop)

```
door page ──person_enter/lost/back, features, sos, reply──▶ POST /event ──▶ engine.step (pure)
                                                                              │ Transition(actions)
                                                                              ▼
                                                                      actions.run_actions
                                            speak ◀── voice.say (Cartesia | browser TTS)
                                            next line ◀── llm.next_line (Claude, validated) ◀── memory.search (Moss | TF-IDF)
                                            brief ◀── brief.build ◀── search.rank(places) + vision clothing (Claude)
                                            ring ◀── escalation.Runner ──▶ notify (SSE phone | Twilio)
                                            notices ──▶ hub.publish (SSE: dashboard, phone:<member>)
phone app ◀── GET /app/state (poll 2 s) + SSE /sse/phone/{member} + WS /ws/video, /ws/listen
phone app ──▶ WS /ws/talk (mic), POST /ack /answer /takeover /say /door/command /profile /voice/*
```

Modules (`nightfall/`):

| Module | Owns |
|---|---|
| `engine.py` | States and transitions, R0-R3, R11-R13. Pure over (incident, event). The only writer of `incident.state`. |
| `rules.py` | Wander score (R11): direction, check-in, identity, attire, time. Deterministic, logged with reasons. |
| `escalation.py` | Ladder (tier 1, 60 s) → (tier 2, 60 s) → tier 3. One asyncio task per incident; ack cancels. |
| `actions.py` | Side effects named by transitions: speak, frames, brief, ring, notices, vision in the background. |
| `store.py` | All mutable state. One incident at a time. |
| `api.py` | Core routes, SSE hub, tick loop, cache headers, device routing. |
| `api_app.py` | Phone app: state, profile, voice samples, Cartesia clone, preview. |
| `api_cam.py` | Camera frames, takeover, say/clip, door commands, telemetry, `/door`. |
| `api_live.py` | WebSockets: talk (phone mic → door), door-mic (door → phones), video (door → phones). |
| `api_voice.py` | TwiML call agent, phone-page agent turns, voice selection. |
| `api_setup.py` | Address → geocode → hazards now, Apify places in the background. |
| `api_enroll.py` | Face descriptors (128 floats per person, no images). |
| `brief.py` | Brief fields, clothing enums (R8), HMAC tokens (R5). |
| `search.py` | Haversine, hours, ranking (R9). |
| `places.py` | Overpass and Google Maps rows → Place shape. |
| `voice.py`, `llm.py`, `call_agent.py`, `memory.py` | Vendor-facing logic, each with a mock. |
| `integrations/` | The only files that read API keys. |

## Outside services and what each one is for

| Service | Used for | When | Mock |
|---|---|---|---|
| Cartesia Sonic / Ink | Every spoken line at the door (caregiver clone or stock voice), the call agent (neutral voice), voice clone from the caregiver's samples, STT path | Lines pre-synthesized at boot and cached by hash; clone at setup | browser SpeechSynthesis |
| Claude (Anthropic) | (a) next redirect line inside a template, validated; (b) clothing from the exit frame into enums; (c) call-agent answers from a fact sheet | (a) per reply, (b) once per exit in the background, (c) per caller question | scripted lines, fixture clothing, intent answers |
| Moss | Semantic index of the caregiver's notes; hits steer the redirect line, the brief's habits, the call agent | Index built in the background at boot; queried per reply | TF-IDF over the same notes |
| Apify Google Maps scraper | Open-all-night places with phone and hours around the home | Setup only, background task, cached to `data/places.*.live.json` | Marina fixture |
| OpenStreetMap Overpass | Hazards: water, rail, motorway, construction | Setup, seconds | fixture |
| Nominatim | Address → coordinates | Setup | none needed |
| Twilio | Outbound call driven by the TwiML agent, SMS link | On ring, if configured | SSE phone page |

Nothing outside runs on the exit critical path: the ring fires within the door wait regardless of vendor latency.

## Safety invariants

- No code path dials 911. The phone shows a `tel:911` link after `CALL_911_S` out of view and at the 15-minute mark.
- The model returns text only. State, timers, tiers, medications and the wander score are code.
- Every model line passes `script.validate` (length, banned phrases, no digits except a time) and a medication-name check; failures fall back to the script.
- Unknown identity rings. Only a recognized household member, a care-circle member naming themselves, or an entry from outside lowers the score.
- Frames: three exit JPEGs per incident, deleted on close. Faces: descriptors only. Brief links: HMAC, 24 h, bound to a member.
