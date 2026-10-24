# Nightfall caregiver frontend

React + TypeScript + Vite implementation of the archived detailed mobile flow.

- Design: Figma `FCVXRa2wBHq3HcSK11AXix`, archive page `185:254`.
- Backend baseline: `main@802b770e7c889637b286e73a5cd9c26a1ed7ed3b`.
- Working branch: `codex/mobile-caregiver-integration`.
- Existing `/app` and `/door` entries are retained; local backend patches fix the mobile integration contracts.

## Start the frontend

Node 22.12+ or 24 is recommended. From this directory:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173/ui/index.html?preview=1#/setup/profile** for the isolated preview. Preview uses sample data, sends no backend requests, and does not place calls or generate audio. Use the “Preview · Scenarios” menu to choose outcomes. Recording, where explicitly enabled, records only the consenting user's local microphone sample.

Open **http://127.0.0.1:5173/ui/index.html#/home** for the connected app. The Vite proxy expects a backend at `http://127.0.0.1:8000`. To change it, copy `.env.example` to `.env.local` and set `NIGHTFALL_BACKEND_URL`; restart Vite. This setting is a server URL, never an API secret.

## Local backend without external calls

In the repository root, use Python 3.12+:

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r frontend/requirements-mock.txt
```

Then, in a second terminal from `frontend/`:

```sh
npm run mock
```

This helper clears external provider credentials and keeps the 20-second door wait, 60-second escalation interval and 45-second emergency option. It does not read `.env`. Backend timers remain authoritative. The mock requirements include a local FFmpeg binary for sample conversion when system FFmpeg is missing. `/door` is still the computer's camera/speaker surface; the React app is the family phone surface.

The full backend requirements include `anthropic>=1.0`; live voice verification used SDK 2.3.0. The minimal mock environment above omits that SDK and provider credentials. For live voice work, configure `MOCK=0`, Anthropic and Cartesia keys, and valid voice IDs on the backend, then point `NIGHTFALL_BACKEND_URL` at it. Keep all provider keys out of Vite configuration. Verify returned provider sources: configuration flags alone do not prove a successful live call.

## Production build on the existing backend

```sh
npm run build
```

The output is `../static/ui/`. Open **http://127.0.0.1:8000/ui/index.html#/home**. The explicit `index.html` matters because the existing FastAPI static mount does not serve directory indexes at `/ui/`.

Existing SMS links at `/brief.html#TOKEN` automatically open the React brief when its build is installed. `/brief.html?legacy=1#TOKEN` keeps the original brief available. The signed recipient ID is taken from the verified brief response. Historical briefs cannot acknowledge a different current incident.

## Implemented flow

- Care setup, consented family recording with automatic Stop & save, waveform review/retry/delete, provider clone and generated preview requests, ready-made voices with Natural/Warm previews and speed/emotion settings, contact priorities, nearby search, door registration requests, sound activation, and joining.
- Night watch, conversation/return countdown, incoming web ringing, AI calls with automatic listen-after-reply, pause/resume and typed input, clearly labeled device-voice fallback, family response, return, visitor/help states, emergency choices.
- Door video, voice takeover, prepared/custom speech, recorded messages, and independent Talk/Listen controls from Home or Door, including permission/connection cleanup and safe reconnect ownership. The current door device pauses its microphone during Talk; stop talking to hear the reply.
- Mobile brief with camera evidence, clothing, map, ranked hazards, places to call, familiar places, care details, contacts, dispatcher summary, printing, and invalid/expired-link states.

Missing persistence is not simulated in connected mode: photo, medications, familiar places and contact reorder remain limited until the backend adds those contracts. Unsupported controls explain the limitation; preview allows temporary edits. Address/name/voice and other existing endpoints use real server responses. Phone identity, profile names and age come from the backend and may differ from the Figma sample data.

This is a mobile web app. Active-page sound is implemented; iPhone native lock-screen push is not. Existing backend SMS/telephone behavior is separate and requires Twilio configuration.

## Checks and code map

```sh
npm run check
npm run format
```

`check` runs strict TypeScript, Vitest, and the production build. Before publication: 114 frontend tests and the full 162-test backend suite passed, including actual local sample conversion/concatenation using the bundled FFmpeg binary. The production build passed. A 390px connected browser check covered Help → Mike’s phone → signed brief → acknowledgement → return, and current door subtitles. The latest 390px browser checks used synthetic recording and mocked speech/API responses to verify Stop & save → review, preset controls, and automatic call turns with device-voice fallback and pause. Earlier implementation checks covered 14 routes at 360, 390 and 430px without horizontal overflow. Local mock backend checks covered return before escalation, family answering, acknowledgement while continuing dialogue, signed SMS-brief compatibility and recipient binding. A synthetic binary payload verified the WebSocket relay.

On October 24, a consenting tester saved a 6.12-second recording from a real phone and confirmed replay. The real Cartesia clone request succeeded, the backend selected the clone, and the tester reported hearing speech resembling their own voice. A separate `/voice/preview` request returned Anthropic-generated text and a valid Cartesia WAV. Live Mac camera frames reached the backend. The tester confirmed phone-to-Mac Talk and Mac-to-phone Listen, with Talk stopped before listening. The tester then spoke a question about usual routine, heard the reply, and the server emitted `intent: qa` for the recognized question; the phone fetched the Cartesia reply audio. Phone speech recognition uses the browser, not Cartesia Ink. Twilio, Apify, and Moss were disabled in this voice-test runtime.

- `src/features/`: setup, voice, home, incident, live door/call, brief.
- `src/state/NightfallProvider.tsx`: shared snapshot, SSE, member session and sound.
- `src/data/`: typed API contracts and explicit preview fixtures.
- `src/components/`: shared glass surfaces, controls, camera crops and Leaflet map.
- [IMPLEMENTATION.md](IMPLEMENTATION.md): route/API mapping and state behavior.
- [BACKEND-GAPS.md](BACKEND-GAPS.md): concrete changes needed from the backend teammate.

All Figma photos/map artwork used for preview are stored in `public/assets/`; live views use server frames and live map tiles. Fonts are bundled locally. No external API secrets belong in Vite environment variables or source code.
