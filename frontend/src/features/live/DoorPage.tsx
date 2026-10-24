import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  Field,
  Notice,
  PageHeader,
  Sheet,
} from "../../components/ui";
import { CameraFeed } from "../../components/CameraFeed";
import { api } from "../../data/api";
import type { AudioRef } from "../../data/types";
import { useNightfall } from "../../state/NightfallProvider";
import { getMicrophone, supportedRecordingType, userMediaError } from "./media";
import { useDoorAudio } from "./useDoorAudio";
import { DoorAudioControls } from "./DoorAudioControls";
import { useDoorVideo } from "./useDoorVideo";
import styles from "./Live.module.css";

export function DoorPage() {
  const {
    state,
    memberId,
    preview,
    mutate,
    refresh,
    doorSpeech,
    visitorMessage,
  } = useNightfall();
  const navigate = useNavigate(),
    location = useLocation();
  const video = useDoorVideo(memberId, preview);
  const audio = useDoorAudio(memberId, preview, () => {
    void refresh();
  });
  const [more, setMore] = useState(false),
    [text, setText] = useState("");
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null),
    recordStream = useRef<MediaStream | null>(null);
  const alive = useRef(true),
    holdWanted = useRef(false),
    recordTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startingRecording = useRef(false),
    recordStarted = useRef(0),
    clipGeneration = useRef(0);

  const cancelClip = () => {
    clipGeneration.current++;
    startingRecording.current = false;
    holdWanted.current = false;
    clearTimeout(recordTimer.current);
    if (recorder.current) {
      recorder.current.onstop = null;
      recorder.current.ondataavailable = null;
      if (recorder.current.state !== "inactive") recorder.current.stop();
      recorder.current = null;
    }
    recordStream.current?.getTracks().forEach((track) => track.stop());
    recordStream.current = null;
  };
  useEffect(() => {
    alive.current = true;
    setRecording(false);
    setBusy("");
    setError("");
    setMessage("");
    const hidden = () => {
      if (document.hidden) {
        cancelClip();
        setRecording(false);
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      alive.current = false;
      cancelClip();
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [memberId, preview]);

  const setTakeover = async (on: boolean) => {
    setBusy("takeover");
    setError("");
    setMessage("");
    audio.stop("talking");
    cancelClip();
    setRecording(false);
    try {
      await mutate("/takeover", { member_id: memberId, on });
      setMessage(
        on
          ? "You have the door voice. Automatic speech is paused until you hand it back."
          : "Door voice handed back to Nightfall.",
      );
      if (on) setMore(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not change the door voice.",
      );
    } finally {
      setBusy("");
    }
  };
  const say = async (phrase: string) => {
    if (!phrase.trim() || busy) return;
    audio.stop("talking");
    setBusy("say");
    setError("");
    setMessage("");
    try {
      const response = await mutate<{ ok: boolean; audio: AudioRef }>("/say", {
        member_id: memberId,
        text: phrase.trim(),
      });
      setMessage(
        preview
          ? "Preview only. The phrase was not played at a door."
          : response.audio?.mode === "mock"
            ? "Mock mode: phrase prepared, but generated audio is unavailable."
            : "Phrase sent to the door speaker.",
      );
      setText("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not send this phrase.",
      );
    } finally {
      setBusy("");
    }
  };
  const toggleAudio = async (direction: "talking" | "listening") => {
    cancelClip();
    setRecording(false);
    setError("");
    setMessage("");
    if (audio.channels[direction] !== "off") {
      audio.stop(direction);
      await refresh();
      return;
    }
    try {
      await audio.start(direction);
    } catch (cause) {
      setError(userMediaError(cause));
    }
  };
  const finishClip = () => {
    holdWanted.current = false;
    clearTimeout(recordTimer.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
  };
  const beginClip = async () => {
    if (busy || startingRecording.current || recorder.current) return;
    if (preview) {
      setMessage(
        "Preview only. Connect to Nightfall to record and send your real voice.",
      );
      return;
    }
    holdWanted.current = true;
    startingRecording.current = true;
    const run = ++clipGeneration.current;
    const isCurrent = () => alive.current && run === clipGeneration.current;
    audio.stop();
    setError("");
    setMessage("");
    try {
      const type = supportedRecordingType(),
        stream = await getMicrophone();
      if (!isCurrent() || !holdWanted.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      recordStream.current = stream;
      const take = new MediaRecorder(
        stream,
        type ? { mimeType: type } : undefined,
      );
      const chunks: BlobPart[] = [];
      recorder.current = take;
      take.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      take.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        recordStream.current = null;
        recorder.current = null;
        if (!isCurrent()) return;
        setRecording(false);
        const blob = new Blob(chunks, {
          type: take.mimeType || type || "audio/webm",
        });
        if (blob.size < 1500 || Date.now() - recordStarted.current < 1000) {
          setError(
            "Hold for at least one second, speak, then release to send.",
          );
          return;
        }
        if (blob.size > 2 * 1024 * 1024) {
          setError("This clip is too long. Record a shorter message.");
          return;
        }
        const body = new FormData();
        body.append("member_id", memberId);
        body.append(
          "clip",
          blob,
          blob.type.includes("mp4") ? "message.mp4" : "message.webm",
        );
        setBusy("clip");
        try {
          await api.upload("/say/clip", body);
          if (isCurrent())
            setMessage("Your recorded voice was sent to the door speaker.");
        } catch (cause) {
          if (isCurrent())
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not send the recording.",
            );
        } finally {
          if (isCurrent()) setBusy("");
        }
      };
      take.start(200);
      recordStarted.current = Date.now();
      setRecording(true);
      recordTimer.current = setTimeout(finishClip, 20000);
    } catch (cause) {
      if (isCurrent()) {
        setError(userMediaError(cause));
        cancelClip();
      }
    } finally {
      if (isCurrent()) startingRecording.current = false;
    }
  };

  if (!state) return <Notice tone="info">Connecting to the door…</Notice>;
  const ownTakeover = state.takeover_by === memberId;
  const takingOver = state.household.tree.find(
    (person) => person.id === state.takeover_by,
  )?.name;
  const name = state.household.person_name;
  const hasCall = Boolean(
    state.incident &&
    ["ESCALATING", "EXHAUSTED", "ACKED"].includes(state.incident.state),
  );
  const phrases = [
    `Hi ${name}, I’m here.`,
    "Please come back inside.",
    "Let’s sit down together.",
  ];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void say(text);
  };
  const closeMore = () => {
    cancelClip();
    setRecording(false);
    setMore(false);
  };

  return (
    <div className="stack">
      <PageHeader
        back={state.incident ? "/incident" : "/"}
        eyebrow="Door camera"
        title={
          state.incident?.state === "VISITOR"
            ? "Talk at the door"
            : `Talk to ${name} at the door`
        }
        description="See the entrance and speak through its speaker."
      />
      <CameraFeed
        src={
          preview
            ? `${import.meta.env.BASE_URL}assets/camera-demo.png`
            : video.src
        }
        live={video.live}
        caption={video.status}
      />
      {doorSpeech?.text &&
        (!doorSpeech.incident_id ||
          doorSpeech.incident_id === state.incident?.id) && (
          <Card>
            <p className="eyebrow">Nightfall at the door</p>
            <p aria-live="polite">{doorSpeech.text}</p>
          </Card>
        )}
      {state.incident?.state === "VISITOR" && visitorMessage && (
        <Card>
          <p className="eyebrow">Visitor said</p>
          <p aria-live="polite">{visitorMessage}</p>
        </Card>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {message && <Notice tone="info">{message}</Notice>}
      {state.takeover_by && (
        <Notice tone="info">
          {ownTakeover
            ? "You have"
            : `${takingOver || "Another family member"} has`}{" "}
          the door voice.{" "}
          {ownTakeover && audio.channels.talking === "off"
            ? "Hand back to Nightfall when you are finished."
            : "Automatic speech is paused."}
        </Notice>
      )}
      <Card>
        <div className="stack gap-sm">
          <DoorAudioControls
            audio={audio}
            disabled={Boolean(busy)}
            onToggle={(direction) => void toggleAudio(direction)}
          />
          <Button
            variant="secondary"
            disabled={Boolean(busy)}
            onClick={() => void setTakeover(!ownTakeover)}
          >
            {busy === "takeover"
              ? "Updating…"
              : ownTakeover
                ? "Hand back to Nightfall"
                : "Take over the voice"}
          </Button>
          <p className="caption">
            Talk and Listen can stay on together. Talking pauses the AI while
            your microphone is live. Use headphones to reduce echo.
          </p>
        </div>
      </Card>
      <Card>
        <h2>Say in the family AI voice</h2>
        <div className={styles.phrases}>
          {phrases.map((phrase) => (
            <Button
              variant="quiet"
              key={phrase}
              disabled={Boolean(busy)}
              onClick={() => void say(phrase)}
            >
              ▷ {phrase}
            </Button>
          ))}
        </div>
        <p className="caption">
          {state.voice.source === "clone"
            ? `${state.voice.name || state.household.caregiver_name}’s cloned voice`
            : state.voice.mock
              ? "Mock voice · No generated speech"
              : "Selected Nightfall voice"}{" "}
          · Cartesia
        </p>
      </Card>
      <div className="actions">
        <Button variant="secondary" onClick={() => setMore(true)}>
          More voice controls
        </Button>
        <Button
          onClick={() =>
            navigate(hasCall ? "/incident/call" : "/", {
              state: location.state,
            })
          }
        >
          {hasCall ? "Back to the call" : "Back to Home"}
        </Button>
      </div>
      {more && (
        <Sheet
          title={
            ownTakeover ? "You have the door voice" : "More voice controls"
          }
          onClose={closeMore}
        >
          <div className="stack">
            <p className="muted">
              {ownTakeover
                ? "Nightfall’s automatic speech is paused."
                : "Type a phrase or send your own recorded voice."}
            </p>
            {recording && (
              <p className={styles.recording} role="status">
                Recording your real voice… Release to send.
              </p>
            )}
            {error && <Notice tone="danger">{error}</Notice>}
            {message && <Notice tone="info">{message}</Notice>}
            <form className="stack gap-sm" onSubmit={submit}>
              <Field
                label="Say in the family voice"
                placeholder={`${name}, I’m here. Please wait by the door.`}
                value={text}
                maxLength={200}
                onChange={(event) => setText(event.target.value)}
              />
              <Button type="submit" disabled={Boolean(busy) || !text.trim()}>
                {busy === "say" ? "Preparing speech…" : "Speak this phrase"}
              </Button>
            </form>
            <Button
              className={styles.hold}
              variant={recording ? "danger" : "secondary"}
              disabled={Boolean(busy)}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                void beginClip();
              }}
              onPointerUp={finishClip}
              onPointerCancel={() => {
                cancelClip();
                setRecording(false);
              }}
              onKeyDown={(event) => {
                if ([" ", "Enter"].includes(event.key) && !event.repeat) {
                  event.preventDefault();
                  void beginClip();
                }
              }}
              onKeyUp={(event) => {
                if ([" ", "Enter"].includes(event.key)) {
                  event.preventDefault();
                  finishClip();
                }
              }}
            >
              {busy === "clip"
                ? "Sending recording…"
                : recording
                  ? "Release to send"
                  : "Hold to talk"}
            </Button>
            <p className="caption">
              Hold for at least a second. Release to send your real voice to the
              door speaker. Maximum 20 seconds.
            </p>
            {ownTakeover && (
              <Button
                variant="secondary"
                disabled={Boolean(busy)}
                onClick={() => void setTakeover(false)}
              >
                Hand back to Nightfall
              </Button>
            )}
            <Button onClick={closeMore}>Back to the camera</Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
