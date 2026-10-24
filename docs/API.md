# Nightfall API contract (all lanes build against this)

Base `http://127.0.0.1:8000`. JSON. Errors `{"detail": ...}`.

| Method | Path | Request | Response | Codes |
|---|---|---|---|---|
| GET | `/health` | | `{ok, mock:{cartesia, anthropic, apify, twilio}, now, night_mode}` | 200 |
| GET | `/state` | | `{household, now, night_mode, ladder, incident, log[], rings[]}` | 200 |
| POST | `/arm` | `{on: bool}` | `{night_mode}` | 200 |
| POST | `/event` | `{kind, payload?}` kinds: `motion door_open door_close person_seen{inside} reply{text} tick close` | `{incident_id, from, to, rule, detail, actions}` | 200, 422 |
| POST | `/frames/{incident_id}` | multipart, up to 3 JPEG, 200 KB each | `{frame_ids}` | 200, 413 |
| POST | `/ack` | `{incident_id, member_id}` | `{ok, acked_by, first}` | 200, 403, 404 |
| POST | `/tree` | `{name, phone: "web" or E.164, tier: 1..3}` | `{member_id, phone_url}` | 200, 422 |
| GET | `/brief/{token}` | | Brief JSON (below) | 200, 404, 410 |
| GET | `/sse/dashboard` | | events: `state speak ring brief_ready exit_frames_request tree arm reset` | 200 |
| GET | `/sse/phone/{member_id}` | | events: `ring{message, link, tier} acked{by} deadline` | 200 |
| POST | `/reset` | | `{ok}` | 200 |

## Brief JSON

```json
{
  "incident_id": "INC-...", "person_name": "Dad", "photo": "/robert.svg",
  "exit_frames": ["data:image/jpeg;base64,..."],
  "clothing": {"top_color": "navy", "top_type": "hoodie", "bottom_color": "gray", "bottom_type": "sweatpants",
               "footwear": "barefoot", "confidence": 0.86, "source": "mock"},
  "clothing_line": "navy hoodie, gray sweatpants, barefoot",
  "medications": [{"name": "donepezil", "dose": "10 mg", "note": "nightly"}],
  "last_seen_at": "ISO", "deadline_at": "ISO",
  "home": {"lat": 33.8704, "lng": -117.9242, "radius_mi": 1.5},
  "hazards": [Place], "call_first": [Place], "familiar": [Place], "contacts": [{"name", "phone", "note"}],
  "prose": "two sentences from fields", "places_source": "fixture | apify", "viewer": "TM-..."
}
```

`Place = {category, name, lat, lng, distance_mi, phone, hours, open_now?, source}`.
Categories: hazards `water rail motorway construction`; call-first `fuel convenience diner hospital transit pharmacy`.

## State machine (engine.py)

`ARMED_IDLE -motion-> CONVERSATION -door_open-> DOOR_OPEN -(20 s or door_close, nobody inside)-> ESCALATING -ack-> ACKED -close-> CLOSED`
`DOOR_OPEN -person_seen inside-> RETURNED`. `ESCALATING -(exit + 15 min)-> EXHAUSTED`.
Env knobs for demos: `DOOR_WAIT_S` (default 20), `ESCALATION_STEP_S` (default 60).

## Lane hooks

- Voice lane: replace the `speak:*` action handler in `nightfall/actions.py` and add a `Notifier` in `nightfall/notify.py`.
- Vision lane: POST frames to `/frames/{incident_id}`; replace `brief.mock_clothing()` in `actions.py` with `vision.describe_clothing`.
- Apify lane: write `data/places.<slug>.json` in the Place shape; set `source: "apify"`.
- Frontend lane: `static/*.html` consume only the endpoints above.
