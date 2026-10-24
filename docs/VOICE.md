# Voice agent lane (`voice-agent-feature`)

Three voice jobs, all behind mocks, all validated by code. The model never sets state, tiers, timers or medications.

## 1. Door redirect

- `voice.say(line, persona)` -> `AudioRef {mode, text, url, source}`. Real: Cartesia Sonic `POST /tts/bytes`
  (`Authorization: Bearer`, `Cartesia-Version: 2026-08-14`, `model_id: sonic-3`, WAV 24 kHz) cached by sha1
  in `out/voice/` (LRU 64), served at `/voice/<sha>.wav`. Mock: the dashboard speaks with SpeechSynthesis.
  Completed audio is rewritten with finite RIFF and data lengths before caching; versioned cache keys bypass
  older streaming WAVs whose length placeholders can break telephone playback.
- `voice.pre_synthesize(hh)` runs at boot so the first line at the door never waits on the network.
- `voice.hear(audio, typed)` -> text. Real: Cartesia Ink `POST /stt` (`model=ink-whisper`). Mock: the typed reply.
- `llm.next_line(hh, history, memory_hits)` -> `(line, source)`. Real: Claude (`claude-opus-5`, override with
  `ANTHROPIC_MODEL`) writes one line inside the persona template; `script.validate` enforces R6 (under 140 chars,
  no banned phrase, no digits except a time, terminal punctuation). Any failure -> scripted fallback
  (`closed_place` when the reply mentions a store or work, `again`, then `comfort`).
- Persona: `household.persona` is `caregiver_clone` (consented clone id in `CARTESIA_VOICE_ID`) or `assistant`.
  The telephone opening uses Twilio's neutral voice; later call-agent lines use the assistant voice
  (`CARTESIA_ASSISTANT_VOICE_ID`).

## 2. Family call agent

`call_agent.opening(hh, brief, member_name)` composes the first line from brief fields only: time, clothing,
radius, two nearest hazards, two open places, how to ack. `call_agent.handle(hh, brief, name, text)` -> `Reply`.
Deterministic intents run first: ack ("I've got him", "he's with me"), repeat, hazards / where to look, clothing,
medications (from the caregiver table), who to call, goodbye. Anything else goes to Claude with a fact sheet and
the rule "only these facts"; banned phrases or empty output fall to a safe default.

Transports, same brain:
- Twilio: `TwilioNotifier` calls every member with an E.164 phone. Twilio fetches `POST /twiml/{inc}/{member}`
  (opening + `<Gather input="speech" speechTimeout="auto">`), posts `SpeechResult` to `/twiml/.../turn`, loops
  until ack or goodbye (`<Hangup/>`). The link also goes by SMS. Any Twilio error -> SSE only, logged on the dashboard.
  The pickup response uses `<Say voice="Polly.Joanna">` immediately, without waiting for Cartesia synthesis or an
  audio-file download. Later replies retain Cartesia, with reasoning and synthesis off the server event loop so
  one slow call does not block another call's opening or incident handling.
  Telephone reasoning has a five-second budget and speech generation a two-second budget. Slow reasoning returns
  a spoken brief/help prompt; slow synthesis speaks the answer with Twilio's voice and keeps listening.
- Phone page (mock and fallback): `GET /agent/opening/{inc}/{member}`, `POST /agent/turn` with browser speech
  recognition in and TTS or Cartesia audio out. A spoken ack calls `/ack` exactly like the button.

## 2b. Human takeover

When a relative taps Answer on the phone page they get the live door feed (`/cam/latest.jpg`, relayed by
the dashboard every 400 ms) and a Take over button. `POST /takeover` pauses the AI's auto lines
(`takeover_skip` in the log). `POST /say` speaks their typed line at the door in the caregiver voice;
`POST /say/clip` relays a hold-to-talk recording (mp4 on iOS, webm elsewhere) untouched. Handing back
resumes the AI. The 911 option (`call_911_option` after `CALL_911_S`, default 45 s out of view) is a
`tel:911` link; nothing dials automatically.

## 3. Brief prose

`llm.brief_prose(fields)` -> two sentences from fields; template is the mock and the fallback.

## Memory (Moss)

`memory.Memory` builds one Moss index per household from the caregiver's notes (familiar places, habits)
in a background task at boot (about 7 s cold, 60 s the first time an index is created). Until it is ready
searches return nothing so the door never waits. Hits feed `llm.next_line`, the brief's habits section and
the call agent's fact sheet. Mock is TF-IDF over the same notes.

## Env

```
MOCK=0
CARTESIA_API_KEY=  CARTESIA_VOICE_ID=<clone or stock Michelle>  CARTESIA_ASSISTANT_VOICE_ID=<stock Skylar>
MOSS_PROJECT_ID=   MOSS_PROJECT_KEY=
ANTHROPIC_API_KEY= ANTHROPIC_MODEL=claude-opus-5
TWILIO_ACCOUNT_SID= TWILIO_AUTH_TOKEN= TWILIO_FROM=
PUBLIC_URL=https://<tunnel>   # Twilio must reach /twiml and /voice
```

## Consent and limits

The clone is made only from the caregiver's own recording with on-screen consent in the Cartesia console.
The redirect lines state orientation and reassurance, never facts the system does not have. Twilio trial accounts
can only call verified numbers; the phone page is the primary ring in the demo. Browser speech recognition needs
Chrome or Safari over HTTPS or localhost.

## Where Claude could go wrong, and the guard

| Failure | Guard |
|---|---|
| Invents clothing | enumerated fields, `unknown` for anything else, confidence under 0.4 shows "see photo", frame always attached |
| Argues or escalates tone | length cap, banned-phrase list, scripted fallback, 4-line budget (R1) |
| Hallucinates a medication or a place on the call | medications and places come from the caregiver table and the brief; the QA prompt gets a fact sheet and nothing else; code intents answer the common questions before the model sees them |
| Takes the ack decision | ack is a regex on the caller's words plus the `/ack` endpoint; the model's text never changes state |
