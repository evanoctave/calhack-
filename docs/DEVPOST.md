# Nightfall: Devpost submission draft

Paste each section into the matching Devpost field. Lines tagged **TODO** are not true yet; fix or delete them before submitting.

## Title

Nightfall

## Tagline (under 200 characters)

Life Alert inside a doorbell camera, for families keeping a parent with dementia at home: it talks him back to bed in his daughter's voice, and rings her with everything police ask for if he leaves.

## Inspiration

Six in ten people living with dementia will wander at least once, and the Alzheimer's Association says up to half of those not found within 24 hours are seriously hurt or die ([alz.org](https://www.alz.org/getmedia/e4480fd3-e7fe-4bcb-81b3-30066c57de7f/alzheimers-dementia-wandering-behavior-ts.pdf), [NCOA](https://www.ncoa.org/article/understanding-wandering-risks/)). Most are found within 1.5 miles of where they were last seen ([Washoe County Sheriff](https://washoesheriff.com/general-information/staying-safe/wandering-prevention-alzheimers-and-dementia-walkaways.php)), so the first minutes decide the outcome.

Those minutes usually go to the wrong things. A caregiver woken at 2 AM spends them finding a recent photo, trying to remember what Dad was wearing, and guessing which way he went. The people we built for are the roughly 11 million unpaid dementia caregivers in the US, most often an adult child aged 45 to 65 who moved a parent in and cannot afford overnight care. They sleep with one ear open. Door alarms only tell them the door opened. Nothing in the house tries to turn the person around, and nothing hands the family a brief they can read to a dispatcher.

Evan's mother cared for her grandmother with dementia. What stayed with us was how she described the gap: "I didn't have what I needed," and that Silver Alerts get broadcast to a whole neighborhood "because there's no other way unless someone is watching them constantly, at all times." Nightfall is the someone watching at night.

## What it does

Nightfall is software for two devices people already own.

- **The door device** is any laptop, tablet or old phone propped by the front door. It has a camera, a speaker, a microphone and one red HELP button, and nothing else to click.
- **The caregiver app** runs on the family's phones: live feed, alert, brief, search map, live voice, care profile and face enrollment.

When the person they care for heads for the door at night, the door speaks to him in a familiar voice: a calm question, never an argument, never a mention of the illness ("Hi Dad, it's late. Where are you headed?"). His reply steers the next line, using the caregiver's own notes ("he thinks he's going to work").

If he leaves anyway, every phone in the care circle rings within seconds. Whoever answers gets:

- what he is wearing, read from the last frame with him in it, with the frame shown beside the description
- which way he went, relative to the door camera
- a map of nearby dangers (water, rail lines, freeway ramps, construction) and of places open all night (24-hour gas stations, stores, diners, ER, pharmacy, transit), with phone numbers and hours
- his familiar places and habits, pinned on the map
- a live feed of the door, and a button to speak through it in their own voice
- a "Read this to the dispatcher" paragraph with a Copy button. It opens with "missing and at risk", carries every field police ask for first (name, age, description, photo, clothing, last seen, diagnosis, medications, doctor, prior wandering, routines) and ends with "Please consider a Silver Alert."

If he is still out of view after a set time, a Call 911 button appears on every phone. Nightfall never dials 911 itself; the family decides.

It also has to tell a wander apart from everything else that happens at a front door. A neighbor or delivery person approaching from outside gets a doorbell chime and a polite greeting in a neutral voice, never the night redirect. A household member coming home is logged quietly. A spouse going out for a smoke who answers the door's question by name stands it down. Every one of those decisions is made by a deterministic wander score with logged reasons. An unknown person heading out at night always rings: a false alarm costs one phone one ring, and a miss can cost a life.

## How we built it

- **Server:** FastAPI, one process, one asyncio loop.
  - The core is a pure state machine (`nightfall/engine.py`) over incidents and events. It is the only code that changes incident state.
  - An escalation ladder rings tier 1, then tier 2, then tier 3, and an answer cancels it.
  - Phones get the ring over SSE, with a Twilio call agent behind the same `Notifier` interface.
  - Live video, talk and listen run over WebSockets.
- **Vision in the browser:** TensorFlow.js coco-ssd for person detection and face-api for face recognition. Enrolled faces are stored as 128 numbers per person, never images. The door page sends `person_enter`, `person_lost` and `person_back` events and buffers exit frames.
- **Wander score (R11, `nightfall/rules.py`):** five inputs, each owned by code and logged with its reason.
  - direction, from the door-zone track
  - a voice check-in, where a care-circle member naming themselves stands it down
  - identity: monitored person, other household member, or unknown
  - attire, where nightwear, slippers or bare feet raise the score
  - time of night
- **Claude, in three bounded jobs:**
  - writing the next redirect line inside a template
  - turning the exit frame into fixed clothing fields
  - answering the relative's questions on the call from a fact sheet only

  Claude returns text and nothing else. Every line passes a validator (length cap, banned phrases, a medication-name check) or falls back to a scripted line.
- **Cartesia Sonic** speaks every line. Door lines are pre-synthesized at boot and cached by hash, so the door never waits on the network. The app records voice samples and clones the caregiver's voice through Cartesia.
- **Moss** holds a semantic index of the caregiver's notes per household. Hits steer the redirect line, the habits section of the brief and the call agent's facts.
- **Apify:** we built and published our own Actor, [night-search-radius](https://apify.com/evanoctave/night-search-radius).
  - It takes a home location and returns hazards from OpenStreetMap Overpass, open-all-night places with phones and hours (by calling Apify's Google Maps Scraper), and the person's familiar places, each with its distance.
  - Nightfall runs it once at setup from `/setup.html` and caches the result, so nothing on the 2 AM path waits on a scraper.
- **No keys needed to demo:** every vendor sits behind a mock, so `./run.sh` works with no keys at all, and `/health` shows which pieces are live. 86 tests and a `./run.sh check` gate run before every commit.

## Challenges we ran into

- **Telling a wander from a normal night.** The first version rang for everyone who walked past the camera. Direction from the door zone, a spoken check-in and face identity each fixed a different false alarm. Keeping the "unknown always rings" rule while doing it took several passes.
- **Latency at the door.** A redirect that starts two seconds late is a redirect he walks past. Pre-synthesizing and caching every scripted line, and keeping every vendor call off the exit path, is what made it fast enough.
- **Keeping the model out of decisions.** It was tempting to let Claude decide whether to ring. We kept state, timers, tiers and the score in code, and gave the model only text jobs with validators and fallbacks.
- **Campus Wi-Fi isolates clients,** so the phone and the laptop couldn't see each other. The demo runs over a phone hotspot.
- **Publishing to the Apify Store** needed a public profile, accepted Store terms, and output and dataset schemas before it would go live.

## Accomplishments that we're proud of

- The full loop works on real hardware: walk toward the door, hear the redirect, walk out, and a phone rings with clothing, heading, hazards, open places and a live feed. Then the person on the phone speaks through the door.
- The brief answers every question a dispatcher asks first, mapped one to one against AARP, the BJA law-enforcement guide, the Herbert Protocol and the Alzheimer's Association.
- A published, reusable Apify Actor that any search-and-rescue or caregiving tool can call for any address.
- Every decision is explainable. The wander score logs why it rang or didn't, and the model never decides anything.
- It runs with zero API keys, and each vendor falls back on its own without breaking the flow.

## What we learned

- The voice matters more than the words. A calm question in a familiar voice is what caregivers already do at the door; a robot reading a warning is what makes people push past.
- What police need in the first minutes is well documented and short. The hard part is having it ready at 2 AM, not knowing what it is.
- Bounded model jobs are easier to trust and to test than open-ended ones. Validators plus scripted fallbacks let us use Claude where it is strong and keep it away from the rest.

- From Evan's mother: the hardest part was not the emergency but losing the connection ("they're in a different world") while still carrying everything else. That is why the door speaks in a familiar voice instead of arguing, and why the family decides, not the software.

## What's next for Nightfall

- **Month 1:** a pilot with 10 families through an Alzheimer's Association chapter, measuring false rings per week and time to answer.
- **Month 2:**
  - a native iOS app with background push notifications
  - the door page as an installable kiosk app for tablets and old phones
  - support for existing Ring and Wyze cameras
- **Month 3:**
  - back doors, garages and multi-door homes
  - fall detection from the same frames
  - night-routine trends for the care team
- **Month 6:**
  - one-tap Silver Alert hand-off of the brief to the local non-emergency line
  - care-circle sharing with siblings and neighbors

**Business model:** $29 a month per household, bring your own camera and tablet. Medicaid HCBS waivers and long-term-care insurers already reimburse personal emergency response services, and this is PERS with eyes and a familiar voice. Hardware (a Pi-based doorbell with a physical HELP button running the same door page) is an option once the software proves the behavior, not a dependency.

## Built with

python, fastapi, asyncio, javascript, html, css, tensorflow.js, coco-ssd, face-api, websockets, server-sent-events, anthropic-claude, cartesia, moss, apify, apify-sdk, node.js, google-maps-scraper, openstreetmap, overpass-api, nominatim, twilio, cloudflare-tunnel, pytest

## Measured

| Metric | Target | Measured |
|---|---|---|
| Person enters frame to first spoken word | under 2 s (cached audio) | 0.03 s median, 5 runs (pre-synthesized line) |
| Person leaves frame to phone ring | under 10 s (1.5 s lost + door wait) | 3.3 s median, 5 runs (3.24-3.47 s; demo door wait 3 s, production 20 s) |
| Ring to the family on the line hearing the brief | under 30 s | 3.4 s median, 5 runs (real Twilio call, answer included) |
| Person speaks at the door to the next line | under 5 s | about 3 s (Claude 1.4-2.3 s + Cartesia 0.9-1.1 s) |
| Cartesia line, uncached | about 1.8 s | 1.75 s |
| Moss query, warm | under 50 ms | under 10 ms (reads 0.00 s) |

## Why we fit each track

**Best Use of Cartesia.** Cartesia Sonic speaks every word at the door and every line of the call agent. Door lines are pre-synthesized at boot and cached by hash, so the redirect starts without waiting on the network (`nightfall/voice.py`, `integrations/cartesia.py`). The caregiver app records voice samples and clones the caregiver's voice (`/voice/clone` in `nightfall/api_app.py`), because a redirect works when it is the daughter's voice. The demo door speaks in a real clone of the caregiver's voice made from 30 seconds of recordings in the app, and the family call uses a neutral assistant voice by design.

**Anthropic: Claude for Public Benefit.** Claude has three bounded jobs: writing the next redirect line inside a template, turning the exit frame into enumerated clothing fields, and answering the relative's questions from a fact sheet (`nightfall/llm.py`, `nightfall/call_agent.py`). It never decides anything. Every line passes a validator and a medication-name check or falls back to a script, and `docs/TRACKS.md` lists each way Claude could go wrong and what stops it. Named community: adult children in Orange County caring for a parent with dementia at home overnight, without paid help.

**Microsoft: Built for the Real World.** Nightfall has a named customer (family caregivers of a parent with dementia at home overnight) and a measured loop (exit to ring, ring to brief). It runs on hardware people already own. The production path in `docs/TRACKS.md` covers RTSP cameras, on-device models, Postgres and a HIPAA posture where the brief is caregiver-entered data. Measured over five runs: exit to a real phone ringing in 3.3 s, the family hearing the brief 3.4 s after the ring (`scripts/timings.py`).

**Best Use of Apify.** The product runs our own Actor at address setup (`nightfall/api_setup.py`, `integrations/apify.py`). The Actor calls Apify's Google Maps Scraper for 24-hour places with phones and hours, merges them with OpenStreetMap hazards, and caches the result, so the 2 AM search map has real phone numbers to call first.

**Best Actor (Apify).** [night-search-radius](https://apify.com/evanoctave/night-search-radius) is published on the Apify Store.
- Input: any home location, a search radius (1.5 miles by default, matching where most people are found) and optional familiar places.
- Output: one ranked dataset of places to check first, call first and look first, nearest first, with a table view and a summary record.
- Source is in `actor/`.

**Best Use of Moss.** Each household gets one Moss index over the caregiver's notes (`nightfall/memory.py`, `integrations/moss.py`). Hits steer the door's next line ("he thinks he's going to work"), the brief's habits section and the call agent's facts. A warm query returns in under 10 ms, so it can sit on the conversation path at the door.

**Best People-First Hack.**
- The person at the door is never argued with, never told they have dementia, and never locked in.
- The family decides about 911; the system never dials.
- No continuous recording: three frames per exit, deleted on close, and faces kept as numbers, never images.
- An unknown person always rings, because a miss costs more than a false alarm.

**Most Technically Complex.** One night exit runs the whole stack:
- browser person and face detection
- a pure state machine and a deterministic wander score with logged reasons
- an escalation ladder over SSE and Twilio
- WebSocket live video and two-way audio
- three validated Claude jobs, a Cartesia voice pipeline with a cache, Moss retrieval, and a published Apify Actor

All of it runs inside a ten-second exit-to-ring budget, with a mock for every vendor and 86 tests.

**Most Creative.** It is a doorbell camera turned inside out. It watches who is leaving, not who is arriving, and answers with a familiar voice instead of an alarm. The same device still handles the neighbor at the door with a chime and a greeting.

**Meta: Bringing People Closer Together.** When the phone rings, the relative sees the door live and speaks through the house in their own voice (Take over the voice, hold to talk). A daughter across town can be at her father's door in seconds. The whole care circle, siblings and neighbors included, rings in tiers, so the nearest person answers first.

## Project image brief

Dark, quiet, 3:2.
- **Left half:** a front door at night seen from inside the hall, lit only by a warm porch light. An older man in a robe and slippers has his hand on the knob, and a small laptop on the hall table shows the door camera with a soft outline around him.
- **Right half:** a phone held in a hand, showing the ringing Nightfall screen ("Dad is at the front door"), with the clothing line, a small map with a water hazard and a 24-hour gas station pinned, and Answer and Talk buttons.
- **Branding:** the Nightfall wordmark top left, with the tagline "Life Alert inside a doorbell camera" under it.

No red alarm imagery and no sirens. The mood is calm and in control. Use real app screenshots for the phone if possible (`/app` in dark mode).

## Submission checklist

- [ ] Project image uploaded
- [ ] Public GitHub repo link: https://github.com/evanoctave/calhack- (merge `frontend-v1` to `main` first)
- [ ] Demo video link (**TODO**)
- [ ] Every track above opted in
- [ ] TODO tags removed
- [ ] Submitted by 8:30 AM Sunday; at the venue by 8:00 AM
