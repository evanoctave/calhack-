# Nightfall · tracks

Nightfall is Life Alert inside a doorbell camera, for families keeping a parent with dementia at home. A laptop by the
front door is the camera and speaker; the caregiver's phone is everything else. This page maps each prize track to
what we built, where it lives in the code, and the moment it shows up in the demo.

| Track | In one line | Demo moment |
|---|---|---|
| [Most Technically Complex](#most-technically-complex) | A real-time state machine with a probabilistic wander score, browser vision, live audio and video, and a phone call agent | The alert screen's "Why Nightfall called" card |
| [Best Use of Cartesia](#best-use-of-cartesia) | The door speaks in a cloned family voice, cached so it starts with no network wait | Dad steps into frame and hears his son |
| [Anthropic · Claude for Public Benefit](#anthropic--claude-for-public-benefit) | Claude has three bounded jobs and decides nothing | Live redirect lines that answer what Dad says |
| [Best Use of Apify](#best-use-of-apify) | Our published Actor powers the search brief's places to check and to call | The brief's map and call list |
| [Best Actor (Apify)](#best-actor-apify) | `night-search-radius` on the Apify Store | Run it from the Store page with an address |
| [Best Use of Moss](#best-use-of-moss) | Semantic memory over the caregiver's notes steers what the door says | "He thinks he's going to work" shapes the reply |
| [Microsoft · Built for the Real World](#microsoft--built-for-the-real-world) | Named customer, measured loop, runs on hardware families own | Exit to a real phone ringing in 3.3 s |
| [Meta · Bringing People Closer](#meta--bringing-people-closer) | The family answers, sees the door, and speaks through it in their own voice | "Take over the voice" on the phone |
| [Best People-First Hack](#best-people-first-hack) | Never argues, never names the illness, the family decides, no autonomous 911 | The door's tone; the 911 screen says "you decide" |
| [Most Creative](#most-creative) | A doorbell that talks someone back to bed before anyone has to search | The whole first minute |

---

## Most Technically Complex

**The wander score** (`nightfall/rules.py`) decides, at the moment someone leaves, whether this is Dad wandering, a
family member taking out the trash, or a visitor. It is a deterministic evidence model, not a points table:

- Every observation is a **likelihood ratio**. Ratios multiply, so they add in **log-odds**:
  `P(wander) = sigmoid(prior + Σ log-likelihood ratios)`. The score is that probability as 0-100.
- **Prior:** an unexplained exit at the watched door rings on its own (P = 0.60). Unknowns never lower the odds.
- **Signals**, each from code, never from the language model:

| Signal | Source | Effect |
|---|---|---|
| Direction | door-zone track geometry in the browser | coming in from the door = arrival, never a wander |
| Face, weighted by confidence | face recognition against enrolled faces | Dad ×3.3 at full confidence; a known other ÷7.4 |
| Check-in reply | the door asks; the reply is parsed by code | a care-circle member naming themselves ÷20; an obligation from an earlier life ("I have to get to work") ×2.7; a coherent errand ÷2.2 |
| Confabulation guard | face + check-in together | Dad's face saying "it's Mike" does not stand down (×1.5 instead) |
| Clothing, graded | clothing enums from the exit frame | barefoot ×2.7, slippers ×2.0, nightwear ×1.8 |
| Night curve | the clock | highest 2-5 AM (×1.6), dusk sundowning (×1.3), daytime ÷2.5 unless armed by hand |
| His own history | the wander history | each earlier exit within 90 minutes of this hour ×1.35, capped |
| Pacing | door approaches in the last 15 minutes | each extra trip ×1.28, capped |
| Ignored redirects | lines spoken while he kept heading out | each ×1.35, capped |

- **Bands:** under 30 ignore, 30-59 the door speaks but nobody is called, 60+ the family is called.
- **Explainable:** every term is returned with its weight, shown to the family as "Why Nightfall called", and logged.
  `tests/test_rules.py` checks that the factors reproduce the probability exactly.

Real verdicts from the model:

| Situation | Score | Decision |
|---|---|---|
| Dad, 2:40 AM, barefoot, "I have to get to work", second trip, ignored two lines | 100 | call the family |
| Dad, 2:50 AM, says "it's Mike" | 96 | call the family (confabulation guard) |
| Unknown face, 3 AM, no answer | 89 | call the family |
| Unknown, 2 PM, night watch off | 38 | speak, don't call |
| Mike, 11:10 PM, "it's Mike, taking the trash out" | 2 | stand down |

**Around it:**
- **Incident state machine** (`nightfall/engine.py`): pure transitions over 11 states (watching, at the door, door
  open, escalating, acknowledged, returned, visitor...), each with a named rule (R0-R13) and logged reason.
- **Escalation ladder** (`nightfall/escalation.py`): tiered calls with per-tier timeouts, cancelled by an
  acknowledgement or a return; a family member's "he's safe" silences the door for five minutes.
- **Browser vision** (`static/cam.js`): coco-ssd person detection and face-api recognition on the laptop, track
  direction from the door edge, a ring buffer of exit frames; no cloud per frame.
- **Real-time media:** 20 fps door video to the phone over WebSockets, phone mic to door speaker as live PCM, door
  mic to phone, barge-in when Dad talks over the door, echo filtering of the door's own voice.
- **Phone call agent** (`nightfall/call_agent.py`, `nightfall/api_voice.py`): a real Twilio call with speech input,
  deterministic intents first ("I'm on my way", "he's fine", "where should I look"), Claude only for open questions.
- **117 tests**, a mock mode that runs with zero keys, and every vendor behind a fallback.

## Best Use of Cartesia

- **Voice clone** from 30 seconds recorded in the app (`/voice/clone`, `nightfall/integrations/cartesia.py`); the door
  speaks in the caregiver's own voice, because a redirect works when it is family.
- **Sonic-3 with emotion and speed:** door lines are generated calm at 0.95 speed, slower for an older listener.
- **Zero-wait door:** every scripted line and its variants are synthesized at boot and cached by hash, so the first
  word plays 0.03 s after Dad steps into frame (measured, `scripts/timings.py`).
- **Every live line** Claude writes is synthesized on the fly (about 1 s); the family call agent uses a separate neutral
  voice by design.

## Anthropic · Claude for Public Benefit

**Named community:** adult children caring for a parent with dementia at home overnight, without paid help.

Claude has three bounded jobs and decides nothing (`nightfall/llm.py`, `nightfall/call_agent.py`):
1. **The next line at the door**, answering what Dad just said, agreeing with the feeling, offering one small step.
   Validated by code: length cap, banned phrases, no medication names, no invented claims; a scripted line otherwise.
2. **Clothing from the exit frame** into fixed fields for the brief, "see photo" below 40% confidence.
3. **Open questions on the family call**, answered only from a fact sheet built from the brief.

State, timers, who gets called, and 911 are all code. `docs/TRACKS.md` lists each way Claude could go wrong and what
stops it.

## Best Use of Apify

The product runs our own Actor when the caregiver sets the home address (`nightfall/api_setup.py`,
`nightfall/integrations/apify.py`) and falls back to the Google Maps Scraper directly if it fails. The result becomes
the brief's **places to check first** (water, rail, freeway ramps, construction) and **places to call first** (24-hour
gas stations, stores, the ER, pharmacies, transit, with phones and hours), computed at setup so nothing waits on the
network at 2 AM.

## Best Actor (Apify)

**[night-search-radius](https://apify.com/evanoctave/night-search-radius)** on the Apify Store (`actor/`):
- Type a home address (geocoded) or coordinates; optional familiar places.
- Hazards from OpenStreetMap measured at their nearest point (a long shoreline counts at its closest edge), deduped;
  open-all-night places from the Google Maps Scraper, 24-hour places first; familiar places with distances.
- Every row has a section, a plain-language "why", and a map link; a `SUMMARY` record carries a one-line brief.
- Output and dataset schemas, a Store README with real output, curl and Python examples.

## Best Use of Moss

One semantic index per household over the caregiver's notes (`nightfall/memory.py`, `nightfall/integrations/moss.py`).
When Dad answers the door, the reply is searched against the notes and the hits steer Claude's next line (he thinks he's
going to his old job at the Palace of Fine Arts), the brief's habits section, and the call agent's facts. Warm queries
measured under 10 ms. TF-IDF over the same notes when Moss is unavailable.

## Microsoft · Built for the Real World

- **Customer:** about 11 million unpaid dementia caregivers in the US; six in ten people with dementia wander.
- **Measured over five runs** (`scripts/timings.py`): enter frame to first word 0.03 s; leave frame to a real phone
  ringing 3.3 s (demo door wait 3 s, production 20 s); ring to the family hearing the brief 3.4 s; Dad speaks to next
  line about 3 s.
- **Runs on what families own:** any laptop or tablet by the door, any phone. No hardware to buy.
- **Production path** in `docs/TRACKS.md`: RTSP cameras, on-device models, Postgres, consented clones, a HIPAA posture
  where the brief is caregiver-entered data.
- **Talked to a caregiver:** Evan's mother, who cared for her grandmother with dementia (quote in the README).

## Meta · Bringing People Closer

The person who answers is not handed a log; they are put at the door. The phone shows the live camera, and the family
member can **talk through the door** live, **take over the voice** so the AI goes quiet, or send a line in the family
voice. A doorbell visitor gets a chime and the same two-way audio. The call agent reads them what Dad is wearing and
where to look, in plain English.

## Best People-First Hack

- The door never argues, never says no, never mentions memory or illness (validator in `nightfall/script.py`).
- It answers what Dad says instead of repeating instructions, and stops talking the moment he speaks.
- The family decides about 911; Nightfall shows the option and never dials.
- Three frames per exit, deleted on close; faces stored as numbers, never images; phone numbers kept out of the repo.
- Unknown always rings: a false alarm costs one phone one ring at night; a miss can cost a life.

## Most Creative

A doorbell that turns someone around in their son's voice before anyone has to search, and if it can't, puts the
family on the phone with everything police ask for inside the first minute.
