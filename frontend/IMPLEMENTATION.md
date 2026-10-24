# Nightfall caregiver frontend implementation

## Baseline and application boundary

This React, TypeScript, and Vite application implements the detailed caregiver flow from **03 · Archive — Detailed flow** in the [Nightfall Figma file](https://www.figma.com/design/FCVXRa2wBHq3HcSK11AXix/Nightfall?node-id=180-2879). Its source baseline is `main` commit `802b770e7c889637b286e73a5cd9c26a1ed7ed3b`, plus the integration fixes on `codex/mobile-caregiver-integration` documented here. These fixes are proposed in this branch; they are not yet merged into main.

The phone is the caregiver interface. The existing computer `/door` screen remains the camera, microphone, detector, and entrance speaker. This change does not replace the door detection engine or install a native iOS application.

The frontend uses React Router's HashRouter, TanStack Query, CSS Modules, Leaflet, and QRCode. Shared controls use the archived Soft Glass palette, Geist typography, and mobile layouts. External Figma labels, flow arrows, mock status bars, and iPhone home indicators are not application controls. Existing care-profile photos are displayed when supplied rather than replaced with the demonstration portrait. Camera assets are the supplied actual demonstration captures; preview labels distinguish them from live camera frames, and the brief separates reference photos from incident captures.

### Entry points

- Connected app: `/ui/index.html#/home`
- Isolated preview: `/ui/index.html?preview=1#/home`
- Setup: `/ui/index.html#/setup/profile`
- Family invitation: `/ui/index.html#/join`
- Shared brief: `/ui/index.html#/brief/<encoded-token>`

Use `index.html` explicitly: the existing FastAPI static mount is not configured to resolve directory indexes. Assets retain the `/ui/` base. The Vite build writes to `static/ui/`. Existing `/app`, `/door`, and legacy phone pages remain available.

The existing `/brief.html#<token>` entry checks for the React build and forwards to the React brief when installed. `/brief.html?legacy=1#<token>` retains the previous brief for troubleshooting. This preserves already-generated SMS link shapes.

During development, Vite proxies the existing REST, SSE, and WebSocket paths to `NIGHTFALL_BACKEND_URL` (default `http://127.0.0.1:8000`). This is a development-server setting, not a browser API key. External service credentials remain on the Python server. A phone opening an HTTP LAN URL may display the UI, but microphone capture requires HTTPS or a browser-recognized secure context. A QR generated at localhost is labeled as local-only.

## Routes and user flow

| Route after `#`             | Purpose and next step                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `/home`                     | Night watch status, latest event, camera preview, family and voice entry points. Opens the current alert or live door controls.    |
| `/setup/profile`            | Person's name, familiar name, age, caregiver name, photo, medications. Continue opens family voice.                                |
| `/setup/voice`              | Compatibility route to `/voice/samples`.                                                                                           |
| `/voice/samples`            | Three sample categories: introduction, reassurance, everyday speech. Record, replay, delete, create a voice, or choose a preset.   |
| `/voice/record?kind=<kind>` | Explicit voice consent and microphone permission, recording, then stop for local review.                                           |
| `/voice/review?kind=<kind>` | Actual local recording waveform, playback, record again, and upload only after Save.                                               |
| `/voice/create`             | Create a family voice from saved samples. Displays pending service work without invented percentages.                              |
| `/voice/preview`            | Replay the sample, enter a situation, generate new text/audio, then continue setup.                                                |
| `/voice/presets`            | Existing voice library, Natural/Warm recordings, speed, emotion, and Use.                                                          |
| `/setup/contacts`           | Numbered call priorities and family invitation sheet with QR, link, and manual contact addition.                                   |
| `/setup/places`             | Home address, radius, familiar places; begins nearby discovery.                                                                    |
| `/setup/nearby`             | Map, nearby hazards, places to call, and search status. Continue opens camera setup.                                               |
| `/setup/camera`             | Door edge, latest frame, monitored-person and other-household face registration requests.                                          |
| `/setup/sound`              | User gesture to enable sound in the open web page.                                                                                 |
| `/setup/ready`              | Review of the selected setup, then Home.                                                                                           |
| `/join`                     | Add or reconnect to a care-circle member, select that identity on this phone, enable sound, then Home.                             |
| `/care`                     | Reopen settings, voice, camera, nearby places, and phone sound; select a demo family identity.                                     |
| `/incident`                 | Current incident, status progression, family contact state, answer/open brief/acknowledge actions.                                 |
| `/incident/call`            | Nightfall agent transcript, audio response, typed questions, optional supported-browser speech input, end call, and door controls. |
| `/door`                     | Live image/video, listen, talk, persistent AI takeover, typed/preset phrases, recorded voice clip.                                 |
| `/brief`                    | Resolve the current viewer's signed brief link from the incident.                                                                  |
| `/brief/:token`             | Shared scrollable brief, images, clothing, map, care details, contacts, dispatcher summary, print, and acknowledgment.             |
| `/incident/respond`         | Your response, another family member's response, or confirmed return.                                                              |

The normal setup order is profile → voice → contacts → home/nearby places → camera → sound → Home. Recording, presets, invitation, and nearby results are subflows, not new top-level navigation tabs.

The incident flow is server-driven. A detected approach can return safely without family escalation. If the person remains out of view, the app displays the server's wait/call state, receives family notifications, opens the call or brief, and shows response or return. A separate Help-button cause prompts a check at the door without asserting an exit. Visitor messages, watch-only observations, household check-ins, and confirmed returns have distinct wording. Answering a call is distinct from acknowledging responsibility. Ending the agent conversation does not itself assert that Dad is safe.

## API and transport mapping

Paths below describe the inspected backend plus local contract corrections. Preview-only actions never reach the backend.

| UI function                     | Interface                                                       | Behavior                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared state                    | `GET /app/state?member=<id>`                                    | Household, incident cause, rings with incident IDs, retained `door_speech`, voice state, camera availability, timers, and viewer brief link.     |
| State updates                   | `GET /sse/phone/<id>`                                           | Family ring, visitor, subtitle, door/enrollment, answered, and live events. Reconnects refetch the snapshot.                                     |
| Profile                         | `POST /profile`                                                 | Names, age, caregiver, address, description, diagnosis, and doctor. Supported fields persist atomically; save failure returns an error.          |
| Join/add contact                | `POST /tree`                                                    | `{name, phone, tier}` → `{member_id, phone_url, existing?}`. Web-only members use `phone: "web"`.                                                |
| Nearby discovery                | `POST /setup/address`                                           | `{address, radius_mi, google: true}` resolves hazards, saves address/coordinates/radius atomically, then starts optional Apify search.           |
| Nearby result/status            | `GET /setup/status`                                             | `hazards_ranked`, `call_first`, `familiar`, home coordinates, source, and Apify status. Poll while running.                                      |
| Existing face registrations     | `GET /enroll`                                                   | Read registered names and labels. A person is marked registered only when the monitored name matches.                                            |
| Device request                  | `POST /door/command`                                            | `{cmd, member_id, ...}`. `door_edge` adds `edge`; `enroll` adds `label` and `name`. A successful POST means queued, not completed on the device. |
| Voice upload                    | `POST /voice/samples/<kind>`                                    | Multipart `clip`. Stop & save uploads the take, then keeps review open; a failed upload retains the take for retry.                              |
| Voice playback/delete           | `GET /voice/samples/<kind>.wav`, `DELETE /voice/samples/<kind>` | Replay the saved sample or remove it.                                                                                                            |
| Family voice creation           | `POST /voice/clone`                                             | `{name}` → `{voice_id, source, seconds, ok}`. The backend selects the new voice as part of cloning.                                              |
| Generated preview               | `POST /voice/preview`                                           | `{situation}` → `{text, line_source, audio}`. Play only a returned audio URL; missing audio remains an honest text-only preview.                 |
| Voice library                   | `GET /samples/index.json`                                       | Array of `{id, name, variant, file, gen}`. Group by voice ID and select the matching Natural/Warm recording.                                     |
| Voice selection                 | `POST /voice/select`                                            | `{voice_id, speed, emotion}`. Prerecorded preview files do not change when speed or emotion changes.                                             |
| Watch control                   | `POST /arm`                                                     | `{on}`. Always render the state returned by the server, rather than assuming the requested value became effective.                               |
| Answer                          | `POST /answer`                                                  | `{incident_id, member_id}` records answer; does not acknowledge responsibility.                                                                  |
| Agent opening                   | `GET /agent/opening/<incident>/<member>`                        | Opening transcript and audio reference.                                                                                                          |
| Agent turn                      | `POST /agent/turn`                                              | `{incident_id, member_id, text}` → `{say, intent, done, ack, audio}`. Respect `done` and `ack` separately.                                       |
| Acknowledge                     | `POST /ack`                                                     | `{incident_id, member_id}`. A superseded ID returns 404 before side effects. Refetch after errors to recover current status.                     |
| Video                           | `WS /ws/video/<member>`                                         | JPEG frame stream with an age-checked `/cam/latest.jpg` fallback.                                                                                |
| Listen/talk                     | `WS /ws/listen/<member>`, `WS /ws/talk/<member>`                | PCM audio, with browser microphone permission and cleanup on leaving the screen.                                                                 |
| Persistent takeover             | `POST /takeover`                                                | `{member_id, on}` pauses automatic door speech until handed back.                                                                                |
| Speak a phrase                  | `POST /say`                                                     | `{member_id, text}` prepares and sends speech to the door. Successful submission is not speaker playback confirmation.                           |
| Send recorded message           | `POST /say/clip`                                                | Multipart `member_id`, `clip`. The door controls release media resources after sending or cancelling.                                            |
| Brief                           | `GET /brief/<token>`                                            | Signed viewer-specific brief data. 404 and 410 render separate invalid/expired states.                                                           |
| Draft-only unsupported settings | `POST /preview/profile`                                         | Preview interceptor only. Supports local photo, medications, familiar places, and tree changes; it is never sent to a real backend.              |

The nearby setup submits a single `/setup/address` request, then polls that search's status. The endpoint saves the address, resolved coordinates, and radius before publishing the new state or launching Apify. A failed save leaves the previous household, places, and search status intact. A combined `/profile` update defers geocoded household persistence until all profile fields can be committed together.

## State, media, and preview behavior

`NightfallProvider` owns the selected member, snapshot query, SSE subscription, refresh behavior, preview flag, and alert sound. It refreshes after mutations and on reconnection. Periodic snapshot reads repair missed events. Changing member closes the previous stream and stops any current ring.

Door speech is retained independently of the last miscellaneous event. The phone receives filtered `speak` and door telemetry events; the snapshot's `door_speech` repairs a missed subtitle on reconnect. Visitor speech is presented separately. Ring snapshots carry incident IDs so a previous incident's ring does not reappear. Enrollment command dispatch stays pending until device telemetry or enrollment data confirms a result.

Counts and timers derive from server timestamps and settings. The browser does not independently declare a new incident, return, or acknowledgment. Acknowledgment stops other family ringing but does not change `person_in_frame` to claim a physical return. An older shared brief cannot acknowledge a newer incident, and the local backend rejects that ID before side effects. Return, closed, watch-only, and `self_other` check-ins suppress stale response/emergency actions. An acknowledgment can retain an already offered emergency option while return remains unconfirmed.

`cause: "help"` is carried through incident, brief, call text, and stored history. The existing escalation clock is retained internally, but the app does not call that timestamp an exit or show an exit-search countdown for Help. Call openings, deterministic answers, model facts, and dispatcher text do not invent a missing person or on-foot departure from a button press. Help entries are excluded from prior wandering counts; actual history is now passed into brief construction.

Call audio, recognition, pending responses, and transcript state are invalidated when the incident disappears, its ID changes, or the selected family member changes. Late responses from the previous call cannot play over a new incident. `ack: true` with `done: false` still keeps the agent conversation available.

After the user starts or answers a call, successful response playback starts browser speech recognition automatically. Each recognized question uses the existing agent-turn endpoint, then playback and listening repeat. Pause/resume and typed input remain available; typing pauses automatic listening. Missing or failed provider audio falls back to browser SpeechSynthesis with an explicit **Device voice** label, never a cloned-family-voice claim. Unsupported or denied recognition keeps typed input available. Hidden pages, ended calls, and identity changes stop the conversation media. Preview never starts recognition or device speech.

Home and Door both expose independent Talk and Listen controls. They can run together using separate PCM sockets and AudioContexts; stopping or losing one does not tear down the other. Sending an AI phrase or changing takeover stops Talk but preserves Listen. Navigation, member/preview changes, and hiding the page release both channels. The backend binds Talk ownership to the current socket: a replacement closes the old sender, and late old frames/cleanup cannot interfere with the new session. The separate recorded-message control also discards late microphone permissions after an identity change.

The preview is entered explicitly with `?preview=1` before the hash. Its API adapter updates an in-memory session and never sends action requests to the connected backend. Scenario controls cover watching, approach, waiting, leaving, return, response by you/another person, visitor, help, and the emergency recommendation. Changing a scenario retains the preview household and voice choices. Refreshing the browser resets preview-only edits.

Preview voice capture, if the user grants microphone permission, is local to the browser. Saving is intercepted; cloning and generation do not contact Cartesia or Claude. Generated audio is not invented. The library fixture deliberately has no audio files. Recorded sample blobs are held within the mounted voice flow, and reloading an unsaved review correctly asks the user to record again. Do not key/remount `VoicePage` when only its route parameter changes.

Family voice recording requires a user action and voice consent. Recordings stop after 60 seconds and reject empty/oversized samples. Stop & save uploads automatically while opening the waveform review; uploading, saved, and failed states are explicit. Failed uploads keep the local take for retry. Saved takes can be played, replaced, or deleted. Late permission grants after leaving the screen are stopped. Audio playback, microphone tracks, recorders, object URLs, and live sockets are cleaned up when their owning flow ends. Media errors leave the user with a retry or transcript rather than a fake success.

Voice preview selects an available recorded sample, including reassurance or everyday speech when no introduction sample exists. Generated speech uses the currently selected backend voice and an actual returned audio URL. Reference-sample playback, generated speech, and prerecorded Natural/Warm library clips are presented as different sources.

Ready-made voice selection preserves the server's current voice and style. When that voice is absent from the library, choosing a replacement is explicit. Speed 0.95 and calm emotion are defaults only when the server has no style. Natural/Warm previews retain their prerecorded sound; editable speed/emotion are sent when selecting the voice, not applied to those preview files.

The family browser must stay open for its current web ringing behavior. The sound button unlocks browser audio; it does not request or implement native iPhone lock-screen push. Existing Twilio call/SMS behavior remains on the backend. The app never automatically dials 911; any available phone action remains an explicit user choice. Preview mode does not place calls.

## Local backend corrections

- Supported profile fields, including description, diagnosis, doctor, and the current radius, are written through atomic household-file replacement; persistence errors are reported instead of converted into success.
- Standalone nearby searches also persist home address, coordinates, and radius before changing the active search or launching the optional business lookup.
- Explicit Night watch Off is honored even during the scheduled night window.
- Stale acknowledgments return 404 before changing another incident or quiet time.
- The door's recognized reply uses `/event`'s required `payload.text` shape.
- Subtitle and enrollment telemetry reach phone streams; the latest current-incident subtitle survives an SSE reconnect through `door_speech` in the snapshot.
- Ring snapshots include `incident_id`; Help cause persists through the brief/history path, and recorded history is included in briefs.
- Live Talk ownership follows the active socket, preventing a reconnect or superseded family sender from clearing or mixing with the current door audio.

These are local patches on the stated baseline, not a deployment or remote merge confirmation.

## Remaining limitations and backend work

| Gap in the inspected backend                                                                           | Current frontend behavior / required follow-up                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No write contract for profile photo, medications, familiar places, habits/notes, or reference contacts | Live mode shows existing information and says editing is unavailable. Preview allows supported local drafts. Add validated write and persistence contracts before enabling live editing. |
| No contact update/delete/reorder endpoints                                                             | Live mode can add/join only. Numbered priorities are readable; preview can reorder. Existing names passed to `/tree` reconnect to the original member and retain their original tier.    |
| `/tree` does not persist immediately                                                                   | UI says newly added contacts belong to the current server session. Backend should own reliable persistence. A later profile write can incidentally persist the current tree.             |
| `/voice/select` does not update `store.voice_source` / `store.voice_name`                              | Ready copy says a voice is selected, avoiding a false claim that a preset is still the earlier clone. Backend should return authoritative selected voice identity/source.                |
| Acknowledgment applies a default 300-second quiet window                                               | Repeat demonstrations may need the existing Reset or intended door restart. This is backend behavior; the frontend does not pretend that acknowledgment proves physical return.          |
| Per-member answered state is not durable in the snapshot                                               | Current-session suppression prevents repeated browser ringing; a full reload cannot recover answered state solely from the snapshot.                                                     |
| Late clothing updates do not rebuild the dispatcher paragraph                                          | The clothing card and brief prose update, but the saved dispatcher paragraph still needs recomputation before treating its clothing text as current.                                     |
| Device command response only confirms dispatch                                                         | Camera setup says the request was sent and waits for telemetry/registration data. Do not interpret POST success as camera/enrollment success.                                            |
| No live position or familiar-route geometry contract                                                   | Maps show home/search references, known places, and hazards; no fabricated moving location or familiar route.                                                                            |
| Demo identity selection is not authentication                                                          | Member selectors and invitation routes support the current demo backend. Production authentication and household access control are not added here.                                      |

Known integrations are labeled at the relevant scene: voice with Cartesia, generated dialogue with Claude, nearby business data with Apify, and hazards with OpenStreetMap. Code presence and connected mock responses do not establish that production keys or services are running.

## Verification

Commands from `frontend/`:

```sh
npm run typecheck
npm test
npm run build
```

Focused tests cover preview isolation, response/return distinctions, Help versus exit wording, stale emergency suppression, continuous call listening and device-voice fallback, server-reset/new-incident call cleanup, microphone cleanup including delayed permission, stop-and-save/retry, preset selection payloads, available-sample selection, empty review recovery, family joining, address/search ordering, simultaneous Talk/Listen with PCM playback, and stale media callbacks. Backend tests exercise Help semantics, call/brief facts, history filtering, the existing door flow, and Talk socket ownership in isolation. No automated test should place a real family or emergency call.

Browser acceptance should inspect 390px first, then 360–430px widths: no horizontal overflow, readable card titles, usable inline actions, modal scrolling, and fixed actions remaining reachable. Walk through setup and both main incident outcomes. Verify two member sessions, state recovery after reconnect, brief invalid/expired routes, voice-service errors, and media permission denial.

A successful build or fixture test is not verification of Cartesia cloning, Claude speech generation, Twilio delivery, Apify live retrieval, actual camera recognition, or iPhone audio behavior. Those require the configured server and consenting test devices. Keep real-service findings separate from preview and mock-server results.
