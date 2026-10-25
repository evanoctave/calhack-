# Nightfall API contract

Base `http://127.0.0.1:8000` (laptop) or the tunnel URL (phones). JSON. Errors `{"detail": ...}`.
Pages and scripts are served with `Cache-Control: no-store`. Anything arriving through the tunnel is a phone: `/` and `/door` redirect it to `/app`, and `/cam/frame` and `/ws/video-in` refuse it.

## Core (api.py)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/health` | | `{ok, mock:{cartesia, anthropic, apify, twilio, moss}, now, night_mode}` |
| GET | `/state` | | `{household, now, night_mode, ladder, door_wait_s, incident{id,state,door_opened_at,exited_at,deadline_at,acked_by}, log[], rings[]}` |
| POST | `/arm` | `{on}` | `{night_mode}` |
| POST | `/event` | `{kind, payload?}` (`ack` is rejected here, use `/ack`) kinds: `person_enter person_lost person_back features stand_down reply{text} motion door_open door_close person_seen{inside} tick close sos` | `{incident_id, from, to, rule, detail, actions}` |
| POST | `/ack` | `{incident_id, member_id}` | `{ok, acked_by, first}` (403 non-member, 404) |
| POST | `/care/confirm-return` | `{incident_id, member_id}` | `{ok,state:"RETURNED",returned_by}` (403 non-member, 409 stale/inactive search); stops pending calls and records a family-confirmed return without changing camera visibility. |
| POST | `/tree` | `{name, phone:"web"|E.164, tier}` | `{member_id, phone_url, existing?}` idempotent by name |
| GET | `/brief/{token}` | | Brief JSON (404 bad, 410 expired) |
| GET | `/sse/dashboard` | | `state speak ring takeover_skip live door setup command command_log brief_ready exit_frames_request tree arm reset memory features stand_down watch_only call takeover live answered clothing voice command door visitor* home sos call_911_option returned` |
| GET | `/sse/phone/{member_id}` | | `ring{message,link,tier} acked returned brief_updated deadline call_911_option takeover stand_down watch_only visitor visitor_said visitor_left home sos` |
| POST | `/reset` | | `{ok}` reloads data/household.json (judge members added through the app's profile save persist there), keeps faces, rebuilds memory |

Event payload fields the detector may send: `identity` (match/other/unknown), `direction` (exit/entry/unknown), `heading` (left/right/away/toward/unknown), `attire_night`, `checkin`/`who` (set by the server from a reply), `source`, `reason`.

## Phone app (api_app.py)

The caregiver UI's additional photo, contact-order, invitation, familiar-place, and mock scenario routes are
documented in [UI-INTEGRATION.md](UI-INTEGRATION.md#api-additions).

| Method | Path | Notes |
|---|---|---|
| GET | `/app` | the app page |
| GET | `/app/state?member=TM-…` | everything the app renders: household, incident (state, heading, identity, direction, checkin, wander{score,action,reasons}, emergency{text,option_shown,deadline_hhmm}, clothing, exit_frame, brief_link, visitor), rings, door_wait_s, ladder_step_s, takeover_by, live_by, call_911, voice{voice_id,source,name,mock,samples,style}, memory_source, places_source, live_frame |
| POST | `/profile` | `{person_full_name?, person_name?, person_age?, caregiver_name?, address?}`; address geocodes and fetches hazards; persisted to `data/household.json` |
| POST | `/voice/samples/{introduction|reassurance|everyday}` | multipart `clip` (any browser format) → 16 kHz WAV |
| GET/DELETE | `/voice/samples/{kind}.wav`, `/voice/samples/{kind}` | |
| POST | `/voice/clone` | `{name}` stitches samples, clones at Cartesia, switches the door voice; mock without keys |
| POST | `/voice/preview` | `{situation}` → `{text, line_source, audio}` a fresh Claude line in the current voice |

## Door device (api_cam.py)

| Method | Path | Notes |
|---|---|---|
| GET | `/door` | door page (laptop only) |
| POST | `/cam/frame` | multipart `f` JPEG ≤ 200 KB, laptop only |
| GET | `/cam/latest.jpg` | polling fallback, 404 if older than 10 s |
| POST | `/frames/{incident_id}` | up to 3 exit JPEGs; starts clothing vision in the background |
| POST | `/takeover` | `{member_id, on}` pauses the AI lines (explicit, survives live sessions) |
| POST | `/say` | `{member_id, text}` spoken at the door in the caregiver voice |
| POST | `/say/clip` | multipart `member_id`, `clip` ≥ 1.5 KB, relayed as-is |
| POST | `/door/command` | `{cmd: enroll{label,name} | door_edge{edge} | start | say_test}` relayed to the door over SSE |
| POST | `/door/telemetry` | `{event, detail}` from the door page (detector, audio) into the log |

## Live audio and video (api_live.py, WebSockets)

| Path | Direction | Payload |
|---|---|---|
| `/ws/talk/{member_id}` | phone → server → door | 16 kHz mono Int16 PCM frames. Opening it sets takeover; closing clears it unless `/takeover` was explicit. Door cuts any playing AI line. |
| `/ws/door` | server → door | PCM from the talker + JSON `{type:"live", on, by}` |
| `/ws/door-mic` | door → server → phones | PCM; door receives `{type:"listeners", count}` and streams only while count > 0 and nobody is talking |
| `/ws/listen/{member_id}` | server → phone | PCM from the door microphone |
| `/ws/video-in` | door → server (laptop only) | JPEG frames ~20 fps; door receives `{type:"watchers", count}` |
| `/ws/video/{member_id}` | server → phone | JPEG frames |

## Voice agent (api_voice.py)

`POST /twiml/{inc}/{member}` and `…/turn` (Twilio), `GET /agent/opening/{inc}/{member}`, `POST /agent/turn {incident_id, member_id, text}`, `POST /answer`, `GET /clips/{name}`, `POST /voice/select {voice_id, speed, emotion}`, `GET /voice/current`, `GET /voice/{sha}.wav`.

## Setup and enrollment

`POST /setup/address {address, radius_mi, google}` (hazards now, Apify in the background), `GET /setup/status`.
`GET /enroll`, `POST /enroll {label: person|other, name, descriptor[128]}`, `DELETE /enroll/{name}`.

## Brief JSON

```json
{"incident_id","person_name","photo","exit_frames":[...],"clothing":{top_color,top_type,bottom_color,bottom_type,footwear,confidence,source},
 "clothing_line","medications":[...],"last_seen_at","deadline_at","last_seen_hhmm","deadline_hhmm","home":{lat,lng,radius_mi},
 "hazards":[Place],"call_first":[Place],"familiar":[Place],"contacts":[...],"habits":[{text,kind}],"memory_source","prose","places_source","viewer"}
```
`Place = {category, name, lat, lng, distance_mi, phone, hours, open_now?, source}`.

## State machine

`ARMED_IDLE -person_enter-> CONVERSATION -person_lost-> DOOR_OPEN -(DOOR_WAIT_S)-> ESCALATING -ack-> ACKED -close-> CLOSED`
`ARMED_IDLE -person_lost-> DOOR_OPEN` (speaks and starts the clock in one step). `DOOR_OPEN|ESCALATING -person_back-> RETURNED`.
`CONVERSATION|DOOR_OPEN|ESCALATING|WATCHING -stand_down-> RETURNED` (care-circle member identified). `ARMED_IDLE -person_enter{direction:entry}-> VISITOR` (or `home` notice when recognized) `-person_lost-> CLOSED`.
`ARMED_IDLE|CONVERSATION|DOOR_OPEN|RETURNED|VISITOR|WATCHING -sos-> ESCALATING` (HELP). `ESCALATING -(exit + 15 min)-> EXHAUSTED`.
At exit the R11 band decides: ignore → CLOSED with `stand_down`; speak_only → `WATCHING` (brief, no ladder, no 911 timers; a later face match starts the ladder); escalate → ESCALATING. `ACKED|EXHAUSTED|WATCHING -person_back-> RETURNED`. A fresh approach supersedes RETURNED/ACKED/EXHAUSTED/WATCHING.
