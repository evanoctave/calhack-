# Caregiver UI integration

The caregiver app follows the approved Figma [Core demo](https://www.figma.com/design/FCVXRa2wBHq3HcSK11AXix?node-id=79-137).
The [detailed flow](https://www.figma.com/design/FCVXRa2wBHq3HcSK11AXix?node-id=185-254) supplies supporting interactions.
The [archive](https://www.figma.com/design/FCVXRa2wBHq3HcSK11AXix?node-id=43-126) is historical reference; its dark Soft Glass styles also apply to the current screens.

## Run and preview

Run `./run.sh`, then open `http://127.0.0.1:8000/app`.
Open `/app?demo=1` for recorded camera imagery and explicit scenario controls.
Both the demo UI and `/care/demo/*` require `MOCK=1`.
The normal app uses current camera frames, household details, and server incident state.
Camera capture and HELP remain on `/`; administration remains at `/dashboard.html`.

Enable sound on each caregiver phone and keep the page open for browser demo ringing.
Figma lock screens are OS presentation references; SMS/calls use the existing configured Twilio route.
The browser uses its own incoming-call overlay.

## Screen references

| Figma frame | App route | Purpose |
|---|---|---|
| `182:711` | `/app#setup` | Ready for tonight / care settings |
| `182:489` | `/app#home` | Monitoring and device readiness |
| `182:551`, `164:93` | `#door`, `#wait` | Check-in and return countdown |
| `125:304`, `164:173` | `#alert`, incoming overlay | Family escalation |
| `182:625` | `#call` | Agent briefing and questions |
| `182:719`, `125:520` | `#brief`, `#search` | Photo, clothing, interactive map, detailed search information |
| `182:680` | `#responding` | Acknowledgment, with return still unconfirmed |
| `124:407`, `124:477`, `163:138`, `124:551` | `#record`, `#review`, `#creating`, `#voice-preview` | Recording and voice creation |
| `165:529`, `165:566` | `#emergency` | Early option versus deadline recommendation |

“I'm on it” acknowledges responsibility and stops the call ladder. It does not report a return.
The server's `RETURNED` state supplies the separate return confirmation. Opening an SMS brief and answering an agent call remain separate entry points. Timings come from the server, including shortened demo timers.

## Implementation

- `static/app-tokens.css`: Soft Glass values and light/dark appearance.
- `static/app.css`, `static/app-layout.css`: shared controls and responsive layouts.
- `static/app-care.js`: drafts, uploads, contact order, invitations, familiar places, and demo controls.
- `static/app-ui.js`: hash navigation, SSE/state updates, maps, and incident presentation.
- `static/app-voice.js`: recording review, WAV normalization, voice creation, and live audio.
- `static/brief.html`, `static/brief-page.js`: signed shared briefs with matching styling.
- `nightfall/api_care.py`: API additions supporting the new controls.

Figma decoration and icons are local under `static/assets/figma/`; recorded imagery appears only in demo mode.
The existing Leaflet version and its license are served locally under `static/vendor/leaflet/`.
Camera images, map markers, and incident facts remain dynamic. Maps are a search reference, not live tracking.

Photos are stored in ignored `out/profile/`. Household persistence saves the photo URL, relationship, contact order, and familiar places. Invitations open `/app?member=<id>`.
Recordings use the existing ignored samples directory. The browser submits mono 16 kHz WAV, so recording review/save and concatenation work without FFmpeg. Other uploaded audio formats retain the existing FFmpeg conversion path.

## API additions

| Method | Path | Request / behavior |
|---|---|---|
| POST / GET | `/care/photo` | Multipart `photo`, JPEG/PNG/WebP up to 5 MB; GET serves the current image. |
| PUT | `/care/call-order` | `{member_ids:[...]}` includes every member once; saves order and tiers for subsequent incidents. |
| POST | `/care/members` | `{name}` creates or reuses a web member and returns `member_id` and `invitation_url`. |
| PUT | `/care/places` | `{places:[{name,note?,lat?,lng?}]}`; geocodes new locations before applying changes. |
| POST | `/care/demo/{scenario}` | Mock only: `start`, `leave`, `return`, `visitor`, `home`, `help`, `other-response`, `deadline`. |

`/app/state` also returns `demo_available`, the caregiver relationship, last spoken line, and `incident.emergency.recommendation_due`. The early `call_911` option remains separate from that deadline flag.
Signed brief responses include incident state, acknowledgment/responder, server time, and whether the incident remains active.

## Verification

Run `./run.sh check` for formatting, lint, and Python tests.
`tests/test_care.py` covers upload round trips and validation, contact order, invitation reuse, atomic place updates, WAV recording without FFmpeg, mock-only controls, persistence, and acknowledgment versus emergency/return states.

Browser checks cover light/dark layouts at 390 px and 320 px, polling during edits, a second phone invitation, consent/record/review/save retry, voice creation retry, voice selection, talk/listen/takeover, both return outcomes, a second caregiver's response, maps, and valid/invalid/expired shared briefs.
Use an isolated mock server with temporary persistence for household details, photos, recordings, medical data, history, and voice settings.
