# Decisions

- Table-driven state machine over nested ifs: every (state, event) pair is printable and walked by a test.
- asyncio tasks for the ladder over a scheduler thread: cancellable, one household per process.
- Deterministic wander score over a model decision: explainable to a judge and a family; a miss is worse than a false ring, so unknown rings.
- Vision off the ring's critical path: the brief rings with "see photo" and patches when Claude answers.
- PCM over WebSockets for two-way audio over WebRTC: works through the tunnel on cellular, no TURN.
- JPEG push over WebSocket at 20 fps over polling: smooth enough for a doorbell, trivial fallback.
- Browser-side detectors (coco-ssd, MediaPipe face, face-api) over server-side vision: no per-frame cloud cost, zero latency to the first spoken word.
- Consented voice clone with a neutral-voice persona switch: the redirect is orientation and reassurance in a familiar voice; the concierge and the call agent never use the clone.
- Pre-synthesized script lines: the door never waits on the network to say the first sentence.
- Apify at setup, never at 2 AM: places are cached per home.
- The laptop is the only door: frames and door pages through the tunnel are refused, so a phone can't hijack the feed.
- No autonomous 911: the Association says 15 minutes of searching first; the phone makes the mark impossible to miss.
