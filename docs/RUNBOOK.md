# Runbook: demo day

## Start

```
cp .env.example .env            # fill keys; MOCK=0 for real services
./run.sh demo                   # LAN only: binds all interfaces, 5 s door wait, 15 s ladder, prints links
./run.sh tunnel                 # same, plus a Cloudflare quick tunnel; sets PUBLIC_URL to it (Twilio needs this) and prints the https links
```

Laptop: open http://localhost:8000, click **Start the door**, click **test speaker**, set the door edge and enroll faces from the phone.
Phone: open `https://<tunnel>/app?me=<your name>`, tap **Arm alerts**, keep the tab in the foreground.

## The 90-second flow

1. Teammate turns away from the camera or steps out of frame: voice starts within a second.
2. 1.5 s out of view + 3 s door wait: the phone rings with the written brief (wearing, heading, emergency status).
3. Answer: live feed at 20 fps, agent opening, Talk / Listen.
4. Talk: the AI stops mid-sentence, your voice plays at the door. Hang up: AI resumes.
5. Walk back into frame: rings cancel, phone shows "back inside".
6. Neighbor approach (from the door edge): chime, concierge greeting, no alarm. HELP button: rings now.

## Failure recovery

| Symptom | Fix |
|---|---|
| Phone shows no feed | Laptop door page not started, or phone opened `/` and became the door. Reload `/app?me=…`. |
| No sound at the door | Click anywhere on the door page (browser autoplay), check Mac volume, click test speaker. Door reports `audio_blocked` in the admin log. |
| Phone never rings | Tab in background (iOS suspends it). Bring it to the foreground. Server log shows the ring; `/state` shows `rings`. |
| Detector never says "no person" | Something else in frame reads as a person (poster, second person). Caption shows box size; raise the min height in `cam.js`. |
| Face says unknown | Lighting, or not enrolled. Unknown rings by default. |
| Tunnel URL changed | `./run.sh tunnel` mints a new URL every start; reopen the printed phone link. A hand-run cloudflared needs `PUBLIC_URL` updated and a restart. |
| Phantom `motion` events | A pre-detector admin tab is open. Close it. |
| Cartesia / Claude / Moss down | Each falls back to mock on the spot and prints `<name> fallback: <reason>`. `/health` shows which are mock. |
| Need a clean slate | `curl -X POST localhost:8000/reset` (keeps faces and profile; drops the incident, log and judge members). |

## Knobs (`.env`)

`DOOR_WAIT_S` (3 demo / 20 prod), `ESCALATION_STEP_S` (15 / 60), `CALL_911_S` (45), `LINE_GAP_S` (8), `VISITOR_MAX_S` (120), `VOICE_SPEED`, `VOICE_EMOTION`, `PLACES_FILE`.
