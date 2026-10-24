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
  const [autoListening, setAutoListening] = useState(false);
  const [deviceVoice, setDeviceVoice] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null),
    recognition = useRef<Recognition | null>(null);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const mediaGeneration = useRef(0),
    automatic = useRef(false);
  const listenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const listenNext = useRef<() => void>(() => undefined);
  const sendRecognized = useRef<(text: string) => void>(() => undefined);
  const answeredMember = useRef(memberId);
  const alive = useRef(true),
    requestNumber = useRef(0),
    openingFor = useRef("");
  const isBusy = status === "loading";
  const updateAutomatic = useCallback((on: boolean) => {
    automatic.current = on;
    setAutoListening(on);
  }, []);
  const stopRecognition = useCallback(() => {
    clearTimeout(listenTimer.current);
    listenTimer.current = undefined;
    if (recognition.current) {
      const current = recognition.current;
      recognition.current = null;
      current.onend = current.onresult = current.onerror = null;
      current.abort();
    }
  }, []);
  const stopMedia = useCallback(() => {
    mediaGeneration.current++;
    stopRecognition();
    if (audio.current) {
      audio.current.pause();
      audio.current.onended = audio.current.onerror = null;
      audio.current = null;
    }
    if (utterance.current) {
      utterance.current.onend = utterance.current.onerror = null;
      utterance.current = null;
      window.speechSynthesis?.cancel();
    }
  }, [stopRecognition]);
  const pauseAutomatic = useCallback(() => {
    updateAutomatic(false);
    stopRecognition();
    setStatus((previous) => (previous === "listening" ? "ready" : previous));
  }, [updateAutomatic, stopRecognition]);
  const scheduleListening = useCallback((generation: number) => {
    clearTimeout(listenTimer.current);
    if (
      !automatic.current ||
      !alive.current ||
      document.hidden ||
      generation !== mediaGeneration.current
    )
      return;
    listenTimer.current = setTimeout(() => {
      listenTimer.current = undefined;
      if (
        automatic.current &&
        alive.current &&
        !document.hidden &&
        generation === mediaGeneration.current
      )
        listenNext.current();
    }, 350);
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      requestNumber.current++;
      openingFor.current = "";
      automatic.current = false;
      stopMedia();
    };
  }, [stopMedia]);
  useEffect(() => {
    // A server reset, a new incident, or a different family member starts a new conversation.
    requestNumber.current++;
    stopMedia();
    updateAutomatic(false);
    openingFor.current = "";
    setReply(null);
    setQuestion("");
    setError("");
    setAudioNotice("");
    setDeviceVoice(false);
    setStatus("idle");
  }, [sessionKey, stopMedia, updateAutomatic]);
  useEffect(() => {
    if (!callAvailable) {
      requestNumber.current++;
      stopMedia();
      updateAutomatic(false);
      setReply(null);
      setQuestion("");
      setStatus(incident ? "ended" : "idle");
    } else {
      setStatus((previous) => (previous === "ended" ? "idle" : previous));
    }
  }, [callAvailable, incident?.id, stopMedia, updateAutomatic]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) {
        requestNumber.current++;
        stopMedia();
        updateAutomatic(false);
        setStatus((previous) =>
          previous === "loading"
            ? "idle"
            : previous === "ended" || previous === "idle"
              ? previous
              : "ready",
        );
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [stopMedia, updateAutomatic]);

  const play = useCallback(
    async (response: AgentReply) => {
      stopMedia();
      const generation = mediaGeneration.current;
      setAudioNotice("");
      setDeviceVoice(false);
      const finalStatus = response.done ? "ended" : "ready";
      const valid = () =>
        alive.current &&
        generation === mediaGeneration.current &&
        !document.hidden;
      const finish = () => {
        if (!valid()) return;
        setStatus(finalStatus);
        if (response.done) updateAutomatic(false);
        else scheduleListening(generation);
      };
      if (preview || document.hidden) {
        setStatus(finalStatus);
        setAudioNotice(
          preview
            ? "Preview transcript. No generated audio is attached."
            : "Call paused. Tap Play response when you return to this screen.",
        );
        return;
      }
      const fallback = () => {
        if (!valid()) return;
        if (audio.current) {
          audio.current.onended = audio.current.onerror = null;
          audio.current.pause();
          audio.current = null;
        }
        if (
          !response.say ||
          !window.speechSynthesis ||
          !window.SpeechSynthesisUtterance
        ) {
          updateAutomatic(false);
          setStatus(finalStatus);
          setAudioNotice(
            "Audio is unavailable. Read the transcript, then tap Speak or type a question.",
          );
          return;
        }
        setDeviceVoice(true);
        setAudioNotice(
          "Device voice · Browser speech, not your family’s cloned voice.",
        );
        const speech = new SpeechSynthesisUtterance(response.say);
        utterance.current = speech;
        speech.lang = "en-US";
        speech.rate = 0.95;
        speech.onend = () => {
          if (!valid() || utterance.current !== speech) return;
          utterance.current = null;
          finish();
        };
        const failed = () => {
          if (!valid() || utterance.current !== speech) return;
          utterance.current = null;
          updateAutomatic(false);
          setStatus(finalStatus);
          setAudioNotice(
            "Device voice could not play. Tap Play response to retry, or type a question.",
          );
        };
        speech.onerror = failed;
        try {
          setStatus("speaking");
          window.speechSynthesis.speak(speech);
        } catch {
          failed();
        }
      };
      if (!response.audio?.url) {
        fallback();
        return;
      }
      const element = new Audio(response.audio.url);
      audio.current = element;
      element.onended = () => {
        if (valid() && audio.current === element) {
          audio.current = null;
          finish();
        }
      };
      element.onerror = () => {
        if (valid() && audio.current === element) fallback();
      };
      try {
        setStatus("speaking");
        await element.play();
      } catch {
        if (valid() && audio.current === element) fallback();
      }
    },
    [preview, stopMedia, updateAutomatic, scheduleListening],
  );

  const open = useCallback(
    async (alreadyAnswered: boolean) => {
      if (!incident || !canShowEmergency(incident)) return;
      const run = ++requestNumber.current;
      updateAutomatic(!preview);
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
        updateAutomatic(false);
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
      updateAutomatic,
      preview,
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
      answeredMember.current === memberId &&
      openingFor.current !== incident.id
    ) {
      openingFor.current = incident.id;
      void open(true);
    }
  }, [incident?.id, location.state, open, callAvailable, memberId]);

  const sendTurn = async (text: string) => {
    if (
      !incident ||
      !canShowEmergency(incident) ||
      !text.trim() ||
      isBusy ||
      status === "ended" ||
      reply?.done
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
      updateAutomatic(false);
      setStatus("ready");
      setQuestion(text);
      setError(
        cause instanceof Error
          ? cause.message
          : "Nightfall could not answer. Please try again.",
      );
    }
  };
  const startListening = () => {
    if (
      !callAvailable ||
      !alive.current ||
      document.hidden ||
      reply?.done ||
      status === "ended" ||
      status === "loading"
    )
      return;
    if (preview) {
      setError(
        "Voice input is available in the connected app. Type a question in this preview.",
      );
      return;
    }
    const Constructor = speechRecognition();
    if (!Constructor) {
      updateAutomatic(false);
      setError(
        "Voice input is not available in this browser. Type your question below.",
      );
      return;
    }
    stopMedia();
    const generation = mediaGeneration.current;
    setError("");
    const recognizer = new Constructor();
    recognition.current = recognizer;
    recognizer.lang = "en-US";
    recognizer.continuous = false;
    recognizer.interimResults = false;
    recognizer.onresult = (event) => {
      if (
        !alive.current ||
        recognition.current !== recognizer ||
        generation !== mediaGeneration.current
      )
        return;
      const text = event.results[0]?.[0]?.transcript?.trim();
      if (text) sendRecognized.current(text);
    };
    recognizer.onend = () => {
      if (
        !alive.current ||
        recognition.current !== recognizer ||
        generation !== mediaGeneration.current
      )
        return;
      recognition.current = null;
      setStatus((previous) => (previous === "listening" ? "ready" : previous));
      scheduleListening(generation);
    };
    recognizer.onerror = (event) => {
      if (
        !alive.current ||
        recognition.current !== recognizer ||
        generation !== mediaGeneration.current
      )
        return;
      if (event.error === "no-speech") return; // onend restarts the current automatic conversation.
      pauseAutomatic();
      setError(
        ["not-allowed", "service-not-allowed"].includes(event.error)
          ? "Microphone permission is blocked. Allow it in browser settings, then resume listening, or type your question."
          : "Voice input stopped. Resume listening to try again, or type your question.",
      );
      setStatus("ready");
    };
    try {
      setStatus("listening");
      recognizer.start();
    } catch {
      pauseAutomatic();
      setStatus("ready");
      setError("Could not start voice input. Type your question instead.");
    }
  };
  useEffect(() => {
    listenNext.current = startListening;
    sendRecognized.current = (text) => {
      void sendTurn(text);
    };
  });
  const speak = () => {
    if (status === "listening") pauseAutomatic();
    else startListening();
  };
  const toggleAutomatic = () => {
    if (automatic.current) {
      pauseAutomatic();
      return;
    }
    if (preview || !callAvailable || status === "ended" || reply?.done) return;
    updateAutomatic(true);
    setError("");
    if (status === "ready") startListening();
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
        {reply?.say && !preview && callAvailable && (
          <Button
            variant="quiet"
            disabled={isBusy}
            onClick={() => void play(reply)}
          >
            Play response
          </Button>
        )}
        {audioNotice && <p className="caption">{audioNotice}</p>}
        <p className="caption">
          Voice ·{" "}
          {deviceVoice ? "Browser device voice" : "Cartesia when available"} /
          Dialogue · Nightfall agent
        </p>
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
          {!preview && status !== "ended" && !reply?.done && (
            <div className="stack gap-sm">
              <Button
                variant="quiet"
                onClick={toggleAutomatic}
                aria-pressed={autoListening}
              >
                {autoListening
                  ? "Pause automatic listening"
                  : "Resume automatic listening"}
              </Button>
              <p className="caption">
                {autoListening
                  ? "After Nightfall speaks, your microphone listens for the next question."
                  : "Automatic listening is paused. Speak once or type below."}
              </p>
            </div>
          )}
          {status !== "ended" && !reply?.done && (
            <form onSubmit={submit} className="stack gap-sm">
              <Field
                label="Ask Nightfall"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onFocus={pauseAutomatic}
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
            updateAutomatic(false);
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
