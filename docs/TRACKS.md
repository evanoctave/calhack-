# Tracks: what each sponsor technology does in Nightfall

| Track | Where it runs | What it does in the product | Mock when no key |
|---|---|---|---|
| Cartesia (Best Use) | `nightfall/voice.py`, `integrations/cartesia.py` | Sonic TTS speaks every redirect line at the door and every call-agent line; lines cached by hash and pre-synthesized at boot so the door never waits; Ink STT path for spoken replies | browser SpeechSynthesis |
| Anthropic (Claude for Public Benefit) | `nightfall/llm.py`, `call_agent.py`, `integrations/anthropic_llm.py` | Three jobs: writes the next redirect line inside a template (validated, medication names blocked, scripted fallback); turns the exit frame into enumerated clothing fields; answers the relative's questions on the call from a fact sheet only | scripted lines, fixture clothing, intent-only answers |
| Moss | `nightfall/memory.py`, `integrations/moss.py` | One semantic index per household over the caregiver's notes; hits steer the redirect line ("he thinks he's going to work"), the brief's habits section and the call agent's facts | TF-IDF over the same notes |
| Apify | `integrations/apify.py`, `nightfall/places.py`, `scripts/run_actor.py`, `api_setup.py` | Google Maps scraper fetches open-all-night places with phones and hours around the home at setup; OSM Overpass fetches hazards; both cached to `data/places.*.live.json` | Fullerton fixture |
| Microsoft (Built for the Real World) | whole flow | Customer: family caregivers of a parent with dementia at home overnight. Measured: exit to first ring under 5 s, brief under 30 s. Production path below | |
| Meta (Bringing People Closer) | phone tree, live feed, takeover | The relative answers, sees the door, and speaks to their parent through the house in their own voice | |
| Best People-First | whole flow | The person at the door is never argued with, never told they have dementia; the relative decides about 911 | |

## Telling a wander from a late arrival or a smoke break (R11)

Deterministic wander score, every input owned by code and logged with its reason:

| Signal | Source | Effect |
|---|---|---|
| Direction | door-zone track geometry in the browser | entry from the door = ignore; exit toward it = counts |
| Voice check-in | the door line is a question; reply parsed by code | a care-circle member naming themselves = stand down (-50); a coherent errand = -15; no identification = +15 |
| Identity | face recognition in the browser against enrolled descriptors; label sticks to the track when they turn away | monitored person +20; other household member -45; unknown = no change |
| Attire | clothing enums from the exit frame | nightwear, slippers, barefoot +15 |
| Time | night window or manual arm | daytime -20 (and R0 already gates) |

Baseline 60. Under 30 ignore; 30-59 speak at the door but do not ring; 60+ ring. Unknown everything still rings:
a false alarm costs one phone one ring, a miss can cost a life. No PIN, nothing for the person to remember.

## Ring camera half (R13): visitors and homecomings

Anyone approaching from the outside (track starts at the door edge) never triggers the night redirect. A known
household face or the monitored person coming back in = "home" notice, no sound. Anyone else = visitor, any hour:
the door greets them in the neutral assistant voice ("you've reached the household, can I help you?"), the phone
gets a doorbell chime with the live feed, Talk (phone mic to door speaker) and Listen (door mic to phone),
and a transcript of what they said. The visitor incident closes when they leave or after two minutes. The
HELP button (R12) and the night wander flow (R0-R11) are untouched by visitors.

## Named community (Anthropic)

Adult children in Orange County caring for a parent with dementia at home overnight, without paid help.

## Where Claude could go wrong, and what stops it

| Failure | Guard |
|---|---|
| Invents clothing | enumerated fields, `unknown` otherwise, confidence under 0.4 shows "see photo", the frame is always on the brief |
| Argues, corrects, or names the illness | banned-phrase list, 140-char cap, line budget of 4, scripted fallback |
| Invents props, pets, weather | persona prompt restricts to notes and conversation; still the weakest guard, so the frame and the scripted lines are what the caregiver can rely on |
| Names a medication at the door | runtime check against the caregiver's medication table replaces the line |
| Tells the relative something not in the brief | call QA gets a fact sheet and nothing else; the common questions are answered by code before the model sees them |
| Decides anything | state, timers, tiers, 911 are code; the model only returns text |

## Production path (Microsoft)

Laptop webcam to an indoor RTSP camera; browser coco-ssd to an on-device model; SQLite-free in-memory store to Postgres; the Apify run nightly per home; Twilio behind the same `Notifier` interface (built and tested, disabled on a trial account); consented voice clone per caregiver with a neutral-voice persona switch; HIPAA posture: the brief is caregiver-entered data, not clinical records.

## Measured (fill in at the table)

| Metric | Target | Measured |
|---|---|---|
| person enters frame to first spoken word | under 2 s (cached audio) | |
| person leaves frame to phone ring | under 10 s (3 s lost + 5 s wait in demo) | |
| ring to brief open on a phone | under 30 s | |
| Moss query | under 50 ms warm | 0.00 s measured |
| Cartesia line, uncached | about 1.8 s | 1.75 s measured |
