# Tracks: what each sponsor technology does in Nightfall

| Track | Where it runs | What it does in the product | Mock when no key |
|---|---|---|---|
| Cartesia (Best Use) | `nightfall/voice.py`, `integrations/cartesia.py` | Sonic TTS speaks every redirect line at the door and every call-agent line; lines cached by hash and pre-synthesized at boot so the door never waits; Ink STT path for spoken replies | browser SpeechSynthesis |
| Anthropic (Claude for Public Benefit) | `nightfall/llm.py`, `call_agent.py`, `integrations/anthropic_llm.py` | Three jobs: writes the next redirect line inside a template (validated, medication names blocked, scripted fallback); turns the exit frame into enumerated clothing fields; answers the relative's questions on the call from a fact sheet only | scripted lines, fixture clothing, intent-only answers |
| Moss | `nightfall/memory.py`, `integrations/moss.py` | One semantic index per household over the caregiver's notes; hits steer the redirect line ("he thinks he's going to work"), the brief's habits section and the call agent's facts | TF-IDF over the same notes |
| Apify (Best Use + Best Actor) | `actor/` (published Actor `evanoctave/night-search-radius`), `integrations/apify.py`, `nightfall/places.py`, `api_setup.py` | Our Actor returns hazards (Overpass), open-all-night places with phones and hours (calls the Google Maps Scraper), and familiar places with distances, for any home; the product runs it at setup and caches the result | Marina fixture |
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

## Devpost (deadline Sun Oct 25, 9:00 AM; be at the venue by 8:00 AM)

- Title: Nightfall. Tagline: Life Alert inside a doorbell camera, for families keeping a parent with dementia at home.
- Required: project image, public GitHub repo, live or pre-recorded demo. Judging is a 3-minute pitch plus 2 minutes of questions.
- Opt in: Best Use of Cartesia, Anthropic Claude for Public Benefit, Microsoft Built for the Real World, Best Use of Apify, Best Actor (Actor: https://apify.com/evanoctave/night-search-radius), Best Use of Moss, Best People-First Hack, Most Technically Complex, Most Creative, Meta Bringing People Closer Together.
- Pitch spine (3 minutes): 0:00 the moment (turn away, voice, out of frame, phone rings with the brief); 0:50 answer, live feed, take over the voice; 1:20 neighbor at the door, chime not alarm; 1:40 the problem and the figures, named community; 2:10 how: Cartesia clone, Claude's three bounded jobs, Moss notes, Apify Actor, wander score; 2:45 what's real vs mock, no autonomous 911.
- Q&A answers ready: deception and consent; false alarms (R11/R13); why not call 911; privacy (3 frames, faces as numbers); where Claude goes wrong.

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

## Measured (Oct 24, laptop + iPhone, `scripts/timings.py`)

| Metric | Target | Measured |
|---|---|---|
| person enters frame to first spoken word | under 2 s (cached audio) | 0.03 s median, 5 runs |
| person leaves frame to phone ring | under 10 s (1.5 s lost + door wait) | 3.3 s median, 5 runs (demo door wait 3 s) |
| ring to family on the line hearing the brief | under 30 s | 3.4 s median, 5 runs (real Twilio call) |
| person speaks at the door to next line | under 5 s | about 3 s (Claude 1.4-2.3 s + Cartesia ~1 s) |
| Moss query | under 50 ms warm | 0.00 s measured |
| Cartesia line, uncached | about 1.8 s | 1.75 s measured |
