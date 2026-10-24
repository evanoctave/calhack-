import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  Field,
  Notice,
  PageHeader,
} from "../../components/ui";
import { api, ApiError } from "../../data/api";
import type { AgentReply } from "../../data/types";
import { useNightfall } from "../../state/NightfallProvider";
import {
  canShowEmergency,
  isHelpIncident,
  isResolvedIncident,
} from "../incident/incidentView";
import styles from "./Live.module.css";

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;
function speechRecognition(): RecognitionConstructor | undefined {
  return (
    (
      window as unknown as {
        SpeechRecognition?: RecognitionConstructor;
        webkitSpeechRecognition?: RecognitionConstructor;
      }
    ).SpeechRecognition ||
    (window as unknown as { webkitSpeechRecognition?: RecognitionConstructor })
      .webkitSpeechRecognition
  );
}

export function CallPage() {
  const { state, memberId, preview, mutate, refresh, enableSound } =
    useNightfall();
  const navigate = useNavigate(),
    location = useLocation();
  const incident = state?.incident;
  const sessionKey = incident ? `${incident.id}:${memberId}` : "";
  const callAvailable = canShowEmergency(incident);
  const [reply, setReply] = useState<AgentReply | null>(null);
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<
    "idle" | "loading" | "ready" | "speaking" | "listening" | "ended"
  >("idle");
  const [error, setError] = useState(""),
    [audioNotice, setAudioNotice] = useState("");
  const audio = useRef<HTMLAudioElement | null>(null),
    recognition = useRef<Recognition | null>(null);
  const alive = useRef(true),
    requestNumber = useRef(0),
    openingFor = useRef("");
  const isBusy = status === "loading";
  const stopMedia = useCallback(() => {
    if (audio.current) {
      audio.current.pause();
      audio.current.onended = audio.current.onerror = null;
      audio.current = null;
    }
    if (recognition.current) {
      recognition.current.onend =
        recognition.current.onresult =
        recognition.current.onerror =
          null;
      recognition.current.abort();
      recognition.current = null;
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      requestNumber.current++;
      openingFor.current = "";
      stopMedia();
    };
  }, [stopMedia]);
  useEffect(() => {
    // A server reset, a new incident, or a different family member starts a new conversation.
    requestNumber.current++;
    stopMedia();
    openingFor.current = "";
    setReply(null);
    setQuestion("");
    setError("");
    setAudioNotice("");
    setStatus("idle");
  }, [sessionKey, stopMedia]);
  useEffect(() => {
    if (!callAvailable) {
      requestNumber.current++;
      stopMedia();
      setReply(null);
      setQuestion("");
      setStatus(incident ? "ended" : "idle");
    } else {
      setStatus((previous) => (previous === "ended" ? "idle" : previous));
    }
  }, [callAvailable, incident?.id, stopMedia]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) {
        stopMedia();
        setStatus((previous) =>
          previous === "loading" || previous === "ended" ? previous : "ready",
        );
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [stopMedia]);

  const play = useCallback(
    async (response: AgentReply) => {
      stopMedia();
      setAudioNotice("");
      const finalStatus = response.done ? "ended" : "ready";
      if (!response.audio?.url || preview || document.hidden) {
        setStatus(finalStatus);
        setAudioNotice(
          preview
            ? "Preview transcript. No generated audio is attached."
            : document.hidden && response.audio?.url
              ? "Tap Play response when you return to this screen."
              : "Audio is unavailable. You can read the transcript and keep typing.",
        );
        return;
      }
      const element = new Audio(response.audio.url);
      audio.current = element;
      element.onended = () => {
        if (alive.current && audio.current === element) setStatus(finalStatus);
      };
      element.onerror = () => {
        if (alive.current && audio.current === element) {
          setStatus(finalStatus);
          setAudioNotice(
            "Audio could not play. Read the transcript or tap Play response to retry.",
          );
        }
      };
      try {
        setStatus("speaking");
        await element.play();
      } catch {
        if (alive.current && audio.current === element) {
          setStatus(finalStatus);
          setAudioNotice("Tap Play response to enable audio on this phone.");
        }
      }
    },
    [preview, stopMedia],
  );

  const open = useCallback(
    async (alreadyAnswered: boolean) => {
      if (!incident || !canShowEmergency(incident)) return;
      const run = ++requestNumber.current;
      setStatus("loading");
      setError("");
      try {
        if (!alreadyAnswered) {
          await enableSound().catch(() => undefined);
          if (!alive.current || run !== requestNumber.current) return;
          await mutate("/answer", {
            incident_id: incident.id,
            member_id: memberId,
          });
        }
        if (!alive.current || run !== requestNumber.current) return;
        const response = await api.get<AgentReply>(
          `/agent/opening/${encodeURIComponent(incident.id)}/${encodeURIComponent(memberId)}`,
        );
        if (!alive.current || run !== requestNumber.current) return;
        setReply(response);
        await play(response);
      } catch (cause) {
        if (!alive.current || run !== requestNumber.current) return;
        setStatus("idle");
        setError(
          cause instanceof ApiError && cause.status === 404
            ? "This call is no longer available. Return to the current alert."
            : cause instanceof Error
              ? cause.message
              : "Could not open the call.",
        );
        void refresh();
      }
    },
    [
      incident?.id,
      incident?.state,
      incident?.checkin,
      memberId,
      enableSound,
      mutate,
      refresh,
      play,
    ],
  );
  useEffect(() => {
    const resume = (
      location.state as {
        resume?: { incidentId: string; memberId: string; reply: AgentReply };
      } | null
    )?.resume;
    if (
      resume &&
      callAvailable &&
      resume.incidentId === incident?.id &&
      resume.memberId === memberId
    ) {
      setReply(resume.reply);
      setStatus(resume.reply.done ? "ended" : "ready");
    }
  }, [incident?.id, memberId, location.state, callAvailable]);
  useEffect(() => {
    const answered = (location.state as { answered?: string } | null)?.answered;
    if (
      incident &&
      callAvailable &&
      answered === incident.id &&
      openingFor.current !== incident.id
    ) {
      openingFor.current = incident.id;
      void open(true);
    }
  }, [incident?.id, location.state, open, callAvailable]);

  const sendTurn = async (text: string) => {
    if (
      !incident ||
      !canShowEmergency(incident) ||
      !text.trim() ||
      isBusy ||
      status === "ended"
    )
      return;
    stopMedia();
    setQuestion("");
    setError("");
    setStatus("loading");
    const run = ++requestNumber.current;
    try {
      const response = await mutate<AgentReply>("/agent/turn", {
        incident_id: incident.id,
        member_id: memberId,
        text: text.trim(),
      });
      if (!alive.current || run !== requestNumber.current) return;
      setReply(response);
      // An acknowledgement can stop other calls while this conversation remains open.
      await play(response);
    } catch (cause) {
      if (!alive.current || run !== requestNumber.current) return;
      setStatus("ready");
      setQuestion(text);
      setError(
        cause instanceof Error
          ? cause.message
          : "Nightfall could not answer. Please try again.",
      );
    }
  };
  const speak = () => {
    if (!callAvailable) return;
    if (status === "listening") {
      stopMedia();
      setStatus("ready");
      return;
    }
    const Constructor = speechRecognition();
    if (!Constructor) {
      setError(
        "Voice input is not available in this browser. Type your question below.",
      );
      return;
    }
    if (preview) {
      setError(
        "Voice input is available in the connected app. Type a question in this preview.",
      );
      return;
    }
    stopMedia();
    setError("");
    const recognizer = new Constructor();
    recognition.current = recognizer;
    recognizer.lang = "en-US";
    recognizer.continuous = false;
    recognizer.interimResults = false;
    recognizer.onresult = (event) => {
      if (!alive.current || recognition.current !== recognizer) return;
      void sendTurn(event.results[0]?.[0]?.transcript || "");
    };
    recognizer.onend = () => {
      if (alive.current && recognition.current === recognizer)
        setStatus((previous) =>
          previous === "listening" ? "ready" : previous,
        );
    };
    recognizer.onerror = (event) => {
      if (alive.current && recognition.current === recognizer) {
        setError(
          event.error === "not-allowed"
            ? "Microphone permission is blocked. Type your question instead."
            : "Could not hear a full question. Try again or type it.",
        );
        setStatus("ready");
      }
    };
    try {
      setStatus("listening");
      recognizer.start();
    } catch {
      setStatus("ready");
      setError("Could not start voice input. Type your question instead.");
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void sendTurn(question);
  };

  if (!state || !incident)
    return (
      <div className="stack">
        <PageHeader back="/incident" title="Call with Nightfall" />
        <Notice tone="info">There is no current incident to discuss.</Notice>
      </div>
    );
  const noLongerActive = isResolvedIncident(incident);
  return (
    <div className="stack">
      <PageHeader
        back="/incident"
        eyebrow={
          status === "idle"
            ? "Ready to connect"
            : status === "ended"
              ? "Call ended"
              : "On the line"
        }
        title="Call with Nightfall"
        description="Hear what happened. Ask what to do next."
      />
      {error && <Notice tone="danger">{error}</Notice>}
      {!noLongerActive && !callAvailable && (
        <Notice tone="info">
          Family calls have not started. You can still view the camera or speak
          through the door.
        </Notice>
      )}
      {noLongerActive && (
        <Notice tone="success">
          {incident.state === "RETURNED" && incident.checkin !== "self_other"
            ? `${state.household.person_name} is back inside.`
            : incident.state === "WATCHING"
              ? "Nightfall is observing. Family calls are not active."
              : "This incident has ended."}{" "}
          The latest status is available on the alert screen.
        </Notice>
      )}
      <Card>
        <p className="eyebrow">
          {preview ? "Sample agent briefing" : "Nightfall briefing"}
        </p>
        {reply ? (
          <p className={styles.transcript} aria-live="polite">
            {reply.say}
          </p>
        ) : (
          <p className="muted">
            {isHelpIncident(incident)
              ? "Connect to hear about the help request at the door and what to do next."
              : `Connect to hear when ${state.household.person_name} left, what they were wearing, and where to start looking.`}
          </p>
        )}
        {reply?.audio?.url && !preview && callAvailable && (
          <Button variant="quiet" onClick={() => void play(reply)}>
            Play response
          </Button>
        )}
        {audioNotice && <p className="caption">{audioNotice}</p>}
        <p className="caption">Voice · Cartesia / Dialogue · Nightfall agent</p>
      </Card>
      {incident.acked_by && !noLongerActive && (
        <Notice tone="success">
          {incident.acked_by === memberId
            ? "You’re on it."
            : `${incident.acked_by_name} is on it.`}{" "}
          Other phones stopped ringing.{" "}
          {reply?.done === false
            ? "You can keep asking questions."
            : isHelpIncident(incident)
              ? "Check on the person at the door."
              : "Return is not yet confirmed."}
        </Notice>
      )}
      {status === "idle" ? (
        <Button onClick={() => void open(false)} disabled={!callAvailable}>
          Connect to Nightfall
        </Button>
      ) : (
        <>
          <Badge>
            {status === "loading"
              ? "Nightfall is thinking…"
              : status === "speaking"
                ? "Nightfall is speaking…"
                : status === "listening"
                  ? "Listening…"
                  : status === "ended"
                    ? "Call ended"
                    : "Ready for your question"}
          </Badge>
          {status !== "ended" && (
            <form onSubmit={submit} className="stack gap-sm">
              <Field
                label="Ask Nightfall"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Where should I look?"
                maxLength={600}
                disabled={isBusy}
              />
              <div className="grid-two">
                <Button type="submit" disabled={isBusy || !question.trim()}>
                  Ask
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={isBusy}
                  onClick={speak}
                >
                  {status === "listening" ? "Stop listening" : "Speak"}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
      <div className="actions">
        <Button onClick={() => navigate("/brief")}>Open caregiver brief</Button>
        <Button
          variant="secondary"
          onClick={() =>
            navigate("/door", {
              state: {
                resume: reply
                  ? { incidentId: incident.id, memberId, reply }
                  : undefined,
              },
            })
          }
        >
          Open door camera
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            stopMedia();
            navigate(incident.acked_by ? "/incident/respond" : "/incident");
          }}
        >
          {status === "ended" ? "Back to the alert" : "End call"}
        </Button>
      </div>
    </div>
  );
}
