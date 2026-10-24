# Nightfall: the product

## One line

Life Alert inside a doorbell camera, for families keeping a parent with dementia at home.

## The goal

Stop night wandering from becoming a missing-person search. Turn the person around at the door in a voice they trust, and if they leave anyway, put the family on the line with everything police ask for, inside the first minute.

## Who it is for

**Buyer and user:** the adult child (45-65) who moved a parent with dementia into their home, or lives nearby, and cannot afford overnight care. They sleep with one ear open. In the US that is roughly 11 million unpaid dementia caregivers; six in ten people with dementia will wander at some point, and the Alzheimer's Association says half of those not found within 24 hours are seriously hurt or die (their figures, cited in advocacy testimony and NCOA).

**Not for (yet):** memory-care facilities, hospitals, people living entirely alone with no care circle.

## Why now

- Browser-grade vision (person, face, pose) runs on a $30 board or an old laptop; no cloud per frame.
- Voice cloning from thirty seconds of audio is consumer-ready (Cartesia). The redirect works because it is the daughter's voice, not a robot's.
- Language models can write a calm, in-character sentence inside hard guardrails, and describe a frame into fixed fields. We never let them decide anything.

## What exists today (built at Cal Hacks 13.0)

- Door device: person + face detection, direction, wander score, cached voice lines, HELP button, two-way audio, 20 fps video to the phone.
- Caregiver app: arm, live feed, ring with a written brief (wearing, heading, emergency status), answer, take over the voice live, search map with hazards and open-all-night places, care profile, voice samples → clone, face enrollment.
- Distinguishes a wander from a late arrival, a smoke break, or a neighbor at the door (R11, R13), with every decision logged and explainable.
- Works with zero keys in mock mode; real Cartesia, Claude, Moss, Apify, OpenStreetMap behind env vars with fallbacks.

## Software first

Nightfall ships as software: a door page that runs on any laptop, tablet, or old phone propped by the door, and a
caregiver app. No hardware to buy, no installer. Families already own the camera, speaker and microphone; we are the
brain. Hardware is an ideation track (below), not a dependency.

## What we would build next

| Quarter | Milestone |
|---|---|
| Month 1 | Pilot with 10 families through an Alzheimer's Association chapter: real doors, real nights, measure false rings per week and time-to-answer. |
| Month 2 | Native iOS app with push notifications (web Safari can't ring in the background). Door page as an installable kiosk app for tablets and old phones. Works with existing Ring and Wyze cameras through their RTSP/event feeds. |
| Month 3 | Multi-door homes, back door and garage; pose-based fall detection on the same frames; night routine ("he's up at 3 AM again") trends for the care team. |
| Month 6 | Silver Alert hand-off: one tap sends the brief to the local non-emergency line in the format they already use. Care-circle sharing with siblings and neighbors. |

## Business model

$29/month per household (voice clone, places refresh, brief hosting, care-circle seats). Bring your own camera and tablet. Reimbursable path: Medicaid HCBS waivers and long-term-care insurers already pay for PERS (personal emergency response) services; this is PERS with eyes and a familiar voice.

## Hardware: ideation only

If the software proves the behavior, a dedicated doorbell makes sense: Raspberry Pi 5 or Jetson Nano, wide-angle camera, 3 W speaker, MEMS mic, a physical red HELP button, PoE or battery, Chromium kiosk running the same door page. Same code, no cloud per frame. We would also pair with existing doorbell cameras before building our own.

## What we will not do

- Lock doors, dial 911, or restrain anyone. The family decides; we make the decision easy and fast.
- Record continuously. Three frames per exit, deleted on close. Faces as numbers, never images.
- Pretend the person is not ill. The voice never argues and never mentions the diagnosis.

## Risks we know about

- Voice clone consent and misuse: clone only from the caregiver's own recording with on-screen consent; neutral assistant voice for everything that is not the redirect.
- False negatives: an unknown face always rings. A false ring costs one phone one ring at night; a miss can cost a life.
- Wi-Fi at 2 AM: lines are pre-synthesized and cached; the door speaks without a network.
