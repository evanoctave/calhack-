# Nightfall

A door-camera and caregiver app for families caring for someone with dementia at home. Nightfall detects activity at the door, speaks a familiar redirect, and alerts the care circle if the person leaves. The family receives a search brief with a recent image, clothing description, nearby places, and phone numbers.

Built at Cal Hacks 13.0, UC Berkeley, October 2026.

## Purpose

When a family member leaves home unexpectedly, caregivers need clear information and a way to coordinate. Nightfall brings door monitoring, family calls, live communication, and search information into one workflow.

The prototype uses a laptop as the door device and a mobile browser as the caregiver interface.

## Features

- **Door monitoring:** browser-based person detection, optional face enrollment, direction estimates, and a help button.
- **Caregiver voice:** record and review voice samples, create a consented voice clone, and play familiar prompts at the door.
- **Family escalation:** call contacts in order through Twilio, send brief links by SMS, and deliver browser alerts over Server-Sent Events.
- **Live communication:** view the door camera and use Talk or Listen from the caregiver app.
- **Search briefs:** share a recent image, clothing details, last-seen information, mapped hazards when available, and nearby open businesses with visible tap-to-call numbers.
- **Care profiles:** save the monitored person's details, photo, medical information, familiar places, and care-circle call order across restarts.
- **Clear response states:** acknowledge responsibility with **I'm on it**, return to night watch while a search stays active, or explicitly **Confirm back home** to close the search.
- **Activity reports:** review wandering history and a morning summary, with sample activity labeled when used.

## Tech Stack

| Layer                     | Technologies                                                              |
| ------------------------- | ------------------------------------------------------------------------- |
| Backend                   | Python, FastAPI, Uvicorn, asyncio, Pydantic, HTTPX                        |
| Frontend                  | HTML, CSS, vanilla JavaScript; no frontend build step                     |
| Camera and face detection | TensorFlow.js, COCO-SSD, MediaPipe, face-api.js                           |
| Live updates and media    | Server-Sent Events, WebSockets, browser camera/microphone APIs, Web Audio |
| Maps and location data    | Leaflet, OpenStreetMap, Nominatim, Overpass                               |
| AI and voice              | Cartesia speech synthesis, transcription, and voice cloning               |
| Calls and messaging       | Twilio Voice, TwiML, SMS                                                  |
| Place discovery           | Apify Google Maps Scraper; a separate Node.js Apify Actor                 |
| Care-note retrieval       | Moss semantic search with a local TF-IDF fallback                         |
| Storage                   | Local JSON files, cached media, and signed brief links                    |
| Testing and quality       | pytest, pytest-asyncio, FastAPI TestClient, Ruff                          |

## How It Works

1. The door browser detects a person and sends approach, departure, and identity events to FastAPI.
2. A deterministic state machine evaluates the event and selects actions such as speaking, waiting, or escalating.
3. If an exit triggers escalation, the server builds a brief and starts the care-circle call ladder.
4. The caregiver app receives updates through SSE and polling, with video and audio relayed over WebSockets.
5. Acknowledgment stops further escalation. A camera-detected return or explicit family confirmation marks the person as returned.

The state machine and escalation rules live separately from AI integrations. AI supplies descriptions and conversation; application code controls alert transitions.

The server currently handles one household per process. Household details, medical records, places, and activity history are saved locally; active incidents and background tasks remain in memory.

See [Architecture](docs/ARCHITECTURE.md) and the [API contract](docs/API.md) for implementation details.

## Repository Structure

```text
.
|-- nightfall/                 # Python application
|   |-- api*.py                # HTTP, SSE, and WebSocket routes
|   |-- engine.py              # Incident state machine
|   |-- rules.py               # Deterministic wandering assessment
|   |-- escalation.py          # Care-circle call ladder
|   |-- actions.py             # Transition side effects
|   |-- brief.py               # Search brief and signed links
|   |-- search.py              # Distance and opening-hours ranking
|   |-- household.py           # Care profile and contact models
|   |-- store.py               # Runtime state and household loading
|   `-- integrations/          # External service adapters
|-- static/                    # Caregiver, door, admin, and shared-brief UI
|-- actor/                     # Standalone Apify search-radius Actor
|-- scripts/                   # Place fetching, search plans, and timing tools
|-- data/                      # Fixtures, saved profiles, and place caches
|-- contracts/                 # JSON schemas and example payloads
|-- tests/                     # Backend, integration, and behavior tests
|-- docs/                      # Architecture, API, product, and demo guides
|-- .env.example               # Environment configuration template
|-- requirements.txt           # Python dependencies
|-- pyproject.toml             # pytest and Ruff configuration
`-- run.sh                     # Server and development commands
```

## Getting Started

### Prerequisites

- Python 3.12 or newer.
- A browser with camera and microphone support for the door experience.
- Internet access for browser model downloads, map tiles, address lookups, and live integrations.
- Optional: FFmpeg for uploaded audio formats that need conversion. The built-in recorder produces WAV files directly.

Node.js is only needed to work on the standalone [Apify Actor](actor/README.md).

### Local Setup

From the repository root:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

For a fresh checkout, create the environment file. Keep your existing `.env` if you already have one.

```bash
cp .env.example .env
./run.sh
```

The example configuration uses `MOCK=1` and empty service credentials, so you can explore the app without paid integrations. Address lookups and map tiles still use the network. Place searches use `APIFY_TOKEN` whenever it is configured.

### App Pages

| Page            | Local URL                                                             | Purpose                                               |
| --------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| Caregiver app   | [localhost:8000/app](http://localhost:8000/app)                       | Setup, night watch, alerts, briefs, and care settings |
| Door device     | [localhost:8000](http://localhost:8000/)                              | Laptop camera, speaker, microphone, and help button   |
| Admin dashboard | [localhost:8000/dashboard.html](http://localhost:8000/dashboard.html) | Event log and simulation controls                     |
| Mock scenarios  | [localhost:8000/app?demo=1](http://localhost:8000/app?demo=1)         | Simulated caregiver flows when `MOCK=1`               |

A mobile browser opening `/` is redirected to the caregiver app.

### First Use

1. Open `/app` and select **Who are we monitoring**. Enter the person's details and choose **Save care details**.
2. Add care-circle members and phone numbers, then set the call order.
3. Set the home address under **Home & nearby places** and run the place search.
4. Record a familiar voice if needed. Open the door page on the laptop, start the camera, and allow the requested permissions.
5. Start night watch. Use mock scenarios to explore alerts, briefs, and return confirmation before configuring real calls.

Profile edits replace the previous saved details. Returning from a brief to night watch keeps an ongoing search active; **Confirm back home** is a separate action.

## Configuration

`run.sh` loads `.env` before starting the app. Restart the server after changing service settings.

| Variable                                                 | Purpose                                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `MOCK`                                                   | `1` selects mock behavior for voice, reasoning, calls, and care-note retrieval; `0` enables configured live adapters                 |
| `ANTHROPIC_API_KEY`                                      | Claude conversation, clothing descriptions, and call-agent answers                                                                   |
| `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID`                  | Speech synthesis and transcription; voice cloning uses the Cartesia API                                                              |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Outbound calls and SMS                                                                                                               |
| `PUBLIC_URL`                                             | Public server base URL for Twilio callbacks and shared links                                                                         |
| `APIFY_TOKEN`                                            | Nearby-business searches                                                                                                             |
| `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY`                    | Optional semantic retrieval over care notes; add these to `.env` to use Moss                                                         |
| `BRIEF_SECRET`                                           | Signing secret for shared brief links                                                                                                |
| `DOOR_WAIT_S`, `ESCALATION_STEP_S`                       | Exit delay and time between call tiers                                                                                               |
| `FRESH_START`                                            | Defaults to `1`, which creates the live household on first launch and preserves it afterward; `0` selects the tracked demo household |
| `PLACES_FILE`                                            | Optional override for the places JSON file                                                                                           |

Missing credentials use the relevant fallback where supported. `/health` reports which integrations are running in mock mode. Moss requires project credentials; `MOSS_API_KEY` alone does not enable it.

### Real Phone Calls

1. Set `MOCK=0` and the Twilio credentials in `.env`.
2. Expose port `8000` through an HTTPS tunnel, such as ngrok, and set `PUBLIC_URL` to its base URL. Keep `/app` out of this value.
3. Restart the server and open `<PUBLIC_URL>/app` on the phone.
4. Add the recipient's full phone number, including country code, in the care circle.
5. Use **Phone alerts > Test call** to verify delivery.

Browser alerts work without Twilio. SMS delivery depends on the configured Twilio account and messaging capabilities. Nightfall offers a caregiver-controlled 911 link; it does not call emergency services automatically.

## Development and Testing

```bash
./run.sh             # Local server, using .env settings
./run.sh demo        # Bind all interfaces; use shorter default timers
./run.sh test        # Python test suite
./run.sh check       # Ruff lint, formatting check, and tests
```

Demo mode defaults to a 5-second door wait and 15-second escalation steps when those settings are not already configured. The server defaults are 20 and 60 seconds. Set the desired values in `.env`.

Tests cover incident transitions, escalation cancellation, signed links, profile persistence, medical records, place ranking, voice handling, and API behavior. Test configuration forces mock mode and clears vendor credentials.

### Local Data

| Path                           | Contents                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `data/household.live.json`     | Saved profile, care-circle contacts, home location, and familiar places; ignored by Git |
| `data/household.json`          | Tracked demo household selected with `FRESH_START=0`                                    |
| `data/places.custom.live.json` | Places found through address setup                                                      |
| `data/faces.json`              | Locally saved face descriptors; ignored by Git                                          |
| `data/history.json`            | Saved incident outcomes; ignored by Git                                                 |
| `data/medical.json`            | Medical record; ignored by Git                                                          |
| `out/`                         | Profile photos, voice samples, and other generated media; ignored by Git                |

Keep API credentials in the ignored `.env` file and personal profile data out of commits.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): event flow and module responsibilities.
- [API contract](docs/API.md): HTTP, SSE, and WebSocket interfaces.
- [UI integration](docs/UI-INTEGRATION.md): screen behavior and design implementation.
- [Demo runbook](docs/RUNBOOK.md): device setup and troubleshooting.
- [Voice guide](docs/VOICE.md): recording, cloning, and speech behavior.
- [Product overview](docs/PRODUCT.md): audience and product direction.
- [Engineering decisions](docs/DECISIONS.md) and [implementation tracks](docs/TRACKS.md).
- [Apify Actor](actor/README.md): standalone search-radius service.

## License

[MIT](LICENSE).

## Author

Nam Do, Evan Barreau, Ethan Ikenaga, Jun Kim
