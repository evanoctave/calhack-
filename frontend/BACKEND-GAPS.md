# Backend contracts needed by the detailed caregiver flow

Source baseline: `main@802b770e7c889637b286e73a5cd9c26a1ed7ed3b`, plus the integration fixes in `codex/mobile-caregiver-integration`. These fixes are proposed in this branch; they are not yet merged into main. This document describes source behavior, not verified external integration. The React frontend does not silently simulate missing connected endpoints. Explicit `?preview=1` is a separate, network-isolated demonstration.

## Editable care details

Locally fixed: `POST /profile` accepts names, age, caregiver, address, description, diagnosis, and doctor. Household persistence now includes description, diagnosis, doctor, and the current search radius. It writes through a temporary file and atomic replacement; a write failure returns an error and restores the previous in-memory household instead of reporting success. Profile editing exposes the supported descriptive fields.

Locally fixed: `/setup/address` persists the trimmed address, resolved home coordinates, and `radius_mi` before replacing household/place/status state or launching an Apify job. A persistence failure leaves the previous state and saved household intact and starts no new job. Combined address/profile edits defer the save until the full profile can be committed once.

There are no write contracts for the profile photo, medications, familiar places, habits/notes, or reference contacts. Proposed additions:

- `POST /profile/photo` multipart `photo` → `{ok, url}`; validate type and size and persist the relative image URL. Keep raw face-enrollment images separate: current enrollment stores descriptors only.
- Extend `POST /profile` with explicitly validated `medications`, `familiar_places`, `notes`, `contacts`, and `meds_opt_in`, or provide dedicated endpoints for each. Persist updates atomically. The read model must remain `GET /app/state.household`.
- Familiar places need latitude/longitude before map rendering; persist the selected geocoded place, not an unlocated name. A list of places does not establish a familiar route. A saved path needs its own coordinate-array field if the product retains that feature.

Acceptance: save, refetch, restart server, refetch again; every field matches. A failed save must return a failure status rather than only log an I/O error.

## Call order and joining

`POST /tree {name, phone, tier}` only adds a member in memory and deduplicates by name. There is no update, delete, or reorder route. Joining at tier 1 currently adds another first-tier member; it does not shift existing contacts. The escalation runner captures the household at incident start.

Propose `PUT /tree {members:[{id,name,phone,tier}]}` with stable IDs, validation, atomic persistence, and a clear policy that the revised order applies to the next incident. In the first implementation, use three explicit priorities. Tier 3 currently rings all members in tiers 1–3, not Linda alone; the UI must not promise otherwise.

Invitation delivery and invite-token validation are absent. Current name-based join links are demo participation, not authenticated invitations. Do not show a delivered invitation state unless a delivery service reports success.

Acceptance: reordering survives reload/restart; IDs remain stable; duplicate display names are handled without merging unrelated people; the incident uses a documented order.

## Night watch on/off

Locally fixed: `POST /arm {on:false}` is authoritative. `Store.night()` now returns the explicit watch state, so scheduled hours no longer override Off. The frontend continues to display the returned server state and surfaces failed requests.

## Acknowledgement is not return

`POST /answer` only records answering. `POST /ack` stops escalation and starts a default 300-second quiet period. It does not confirm physical return. Locally fixed: a stale incident ID is rejected with 404 before cancellation, quiet time, or another incident can be changed. The frontend still refetches after mutation failures to recover a current view.

Remaining: expose `quiet_until` and a reason in `/app/state` if the quiet period needs visible UI; distinguish responding from confirmed safe if the product needs both. Sensor `RETURNED` remains distinct from `ACKED`; a household member's `self_other` check-in is also not proof of Dad's return.

The backend's 45-second trigger applies to unacknowledged escalating/exhausted incidents. A previously offered emergency option can remain relevant after acknowledgment while return is unconfirmed. The frontend now hides it for returned, closed, watch-only, or `self_other` states, even if a retained server flag is true. It never automatically dials 911.

## Door commands and actual connectivity

`POST /door/command` confirms the message was published, not that the camera or speaker started. Browser permissions and audio unlocking still require the door device's user gesture. Use frame freshness for connected status (`/app/state.live_frame`, `/cam/latest.jpg` 404 after 10 seconds). A future command ID plus acknowledged result would permit reliable pending/failed UI.

Locally fixed: `static/door.html` sends `{kind:'reply',payload:{text}}`, matching `/event`. Recognized door speech can reach the dialogue/check-in parser. This contract correction is not confirmation that microphone recognition has been exercised on a real device.

Automatic `speak` events and door telemetry, including enrollment results, are forwarded to the family phone stream. `/app/state.door_speech` retains the current incident's latest subtitle for reconnection. The frontend distinguishes enrollment command dispatch from a reported enrollment result. Visitor messages remain separate from an exit alarm.

## Voice generation

Sample upload, deletion, Cartesia cloning, voice selection and generated preview endpoints exist. The clone request selects the new voice immediately; there is no separate draft/approve transaction and no progress job endpoint. Show indeterminate pending state. `source:'mock'` means no real clone was created.

The voice preview now plays the chosen available reference sample rather than assuming an introduction sample exists. Generated preview uses the currently selected backend voice and only plays returned audio. On this integration branch, `/voice/select` clears the previous clone metadata in memory and the persisted environment file. Ready-made and cloned-family voices are labeled separately; changed voice settings invalidate older generated previews.

If consent needs to be retained by the service, add an explicit consent record to the clone contract. The existing request accepts only `{name}`. Sample names are three fixed slots and one recording per slot; multiple retained takes require a new storage contract.

## Brief and history

`GET /brief/{token}` returns 404 for invalid/unavailable links and 410 for expired links; token TTL is 24 hours. Existing generated links are `/brief.html#token`. Retain that URL or provide an explicit compatibility route when adopting a new UI.

The verified response's `viewer` is the signed recipient's member ID, not their display name. The brief binds response actions to that ID and disables acknowledgment for a historical brief or a non-actionable incident. The server mints a fresh token whenever `/app/state` is requested, so the frontend stabilizes the open brief token rather than replacing its query key every polling cycle.

Clothing may arrive after the brief; `brief_updated` triggers a refetch. Locally fixed: brief construction receives recorded history. Incident and brief `cause` distinguish `help` from `door`; Help wording is retained in subsequent prose updates, and Help incidents are excluded from wandering counts. A Help button press alone does not establish identity, an exit, or a missing person. The internal escalation timestamp is retained for compatibility, but the UI does not label it as an exit or display a fabricated search countdown.

Still needed: recompute the dispatcher paragraph when delayed clothing changes if that paragraph includes clothing. A real care-profile photo is shown when available and kept distinct from incident camera captures. This display fix does not add a photo-upload API.

## Notifications and transport

SSE web ringing is foreground browser behavior. Real SMS/telephone uses Twilio, separately configured. There is no Web Push subscription/service worker contract; a PWA installation alone cannot create lock-screen alerts. Notification mockups must remain labeled preview until that integration exists.

Serve the React build and APIs from one origin. The current root `StaticFiles` mount has `html=False`: a build at `static/ui/index.html` opens at `/ui/index.html`, not `/ui/`. Generated links/QR codes need the explicit file entry unless a dedicated index route is added. Vite development must proxy REST, SSE, and `/ws/*` with WebSocket upgrade. Do not route API misses into the SPA HTML fallback. Keep `/door`, existing brief links, and old frontend entry points intact while evaluating the new UI. Door video upload rejects requests through the Cloudflare tunnel; use the local door device and tunnel for family phones.

Locally fixed: `/app/state.rings` includes each ring's `incident_id`, allowing the frontend to reject old-incident ringing on reconnect. Phone events also include answered/live status, and subtitles can recover from the snapshot. A durable per-member answered-state contract is still absent; after a full reload, answering suppression cannot be reconstructed solely from the current snapshot.

## Required integration checks

1. Snapshot after mount, SSE reconnect, tab resume, and member switch contains the current incident and member; no old member's ring leaks through.
2. Answering does not acknowledge. Acknowledgement stops ringing, preserves unknown physical return, and handles superseded incidents honestly.
3. Microphone permission denial, audio playback rejection, stale camera, disconnected WS, empty voice recording, failed clone, and expired brief have usable recovery states.
4. A real iPhone over HTTPS can enable sound, record/review a sample, receive active-page ringing, and open the brief. Test real SMS/phone separately from browser preview.
5. Explicit preview makes zero backend requests, including setup mutations; live mode never substitutes fixture success on network failure.
