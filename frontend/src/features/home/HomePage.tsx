import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Notice, PageHeader, Row } from "../../components/ui";
import { CameraFeed } from "../../components/CameraFeed";
import { useNightfall } from "../../state/NightfallProvider";
import { canShowEmergency } from "../incident/incidentView";
import { useDoorVideo } from "../live/useDoorVideo";
import { useDoorAudio } from "../live/useDoorAudio";
import { DoorAudioControls } from "../live/DoorAudioControls";
import { NearbySearchSummary } from "../../components/NearbySearchProgress";
import {
  doorDecisionFacts,
  getHomeStatus,
  hasConfirmedReturn,
} from "./homeStatus";

export function HomePage() {
  const {
    state,
    memberId,
    preview,
    soundEnabled,
    enableSound,
    mutate,
    refresh,
    doorSpeech,
    loading,
    error,
  } = useNightfall();
  const navigate = useNavigate();
  const video = useDoorVideo(memberId, preview);
  const audio = useDoorAudio(memberId, preview, () => void refresh());
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const offset = useMemo(
    () => (state?.now ? new Date(state.now).getTime() - Date.now() : 0),
    [state?.now],
  );
  if (!state)
    return (
      <div className="empty-state">
        <h1>
          {loading ? "Connecting to Nightfall…" : "Nightfall is unavailable"}
        </h1>
        <p className="muted">
          {error || "Waiting for the current household and door status."}
        </p>
        {!loading && <Button onClick={() => void refresh()}>Try again</Button>}
      </div>
    );
  const h = state.household,
    inc = state.incident;
  const callTiers = new Map<number, string[]>();
  for (const member of h.tree) {
    const names = callTiers.get(member.tier) || [];
    names.push(member.name);
    callTiers.set(member.tier, names);
  }
  const callOrder = [...callTiers]
    .sort(([a], [b]) => a - b)
    .map(([tier, names]) => `${tier} · ${names.join(" + ")}`)
    .join(" → ");
  const returned = hasConfirmedReturn(inc);
  const status = getHomeStatus(state, soundEnabled, preview);
  const speech =
    inc?.id && doorSpeech?.incident_id === inc.id ? doorSpeech : null;
  const speechTime = speech?.ts ? new Date(speech.ts) : null;
  const operatorId = state.live_by || state.takeover_by;
  const operatorName =
    h.tree.find((member) => member.id === operatorId)?.name ||
    "A family member";
  const countdown = inc?.door_opened_at
    ? Math.max(
        0,
        Math.ceil(
          state.door_wait_s -
            (clock + offset - new Date(inc.door_opened_at).getTime()) / 1000,
        ),
      )
    : 0;
  const changeWatch = async () => {
    setBusy(true);
    setMessage("");
    try {
      await mutate("/arm", { on: !state.night_mode });
      if (state.night_mode && !preview)
        setMessage(
          "Watch change requested. The server’s current status is shown above.",
        );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not change night watch.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="screen">
      <PageHeader title={status.title} description={status.reason} />
      {error && (
        <Notice tone="warning">Status may be out of date. {error}</Notice>
      )}
      {operatorId && (
        <Notice>
          {state.live_by
            ? `${operatorName}’s microphone is connected to the door speaker. Automatic voice is paused.`
            : `${operatorName} has taken over the door voice. Automatic voice is paused.`}
        </Notice>
      )}
      {speech?.text && (
        <Card>
          <div className="inline spread">
            <h2>Voice at the door</h2>
            {speechTime && !Number.isNaN(speechTime.getTime()) && (
              <time className="caption muted" dateTime={speech.ts}>
                {speechTime.toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
            )}
          </div>
          <p style={{ marginTop: 12 }}>“{speech.text}”</p>
          <p className="caption muted" style={{ marginTop: 8 }}>
            {preview
              ? "Sample transcript"
              : state.voice.mock
                ? "Latest transcript · Mock voice mode"
                : "Latest line sent to the door"}
            {!speechTime || Number.isNaN(speechTime.getTime())
              ? " · Time unavailable"
              : ""}
          </p>
        </Card>
      )}
      {inc?.state === "DOOR_OPEN" && (
        <p className="caption muted tabular" role="status">
          {countdown > 0
            ? `${countdown}s remaining before the family call check`
            : "Waiting for the server’s next update…"}
        </p>
      )}
      <Button onClick={() => navigate(status.action.path)}>
        {status.action.label}
      </Button>
      {canShowEmergency(inc) && (
        <Button variant="secondary" onClick={() => navigate("/incident")}>
          View current alert
        </Button>
      )}
      <details>
        <summary>Why is Nightfall speaking?</summary>
        <div className="stack gap-sm caption muted">
          {inc && !["ARMED_IDLE", "ARMED_OFF", "CLOSED"].includes(inc.state) ? (
            doorDecisionFacts(inc, h.person_name).map((fact) => (
              <p key={fact}>{fact}</p>
            ))
          ) : (
            <p>
              When night watch is enabled, a person entering the door camera’s
              view can start a voice check-in. Camera identity, movement
              direction, and replies determine whether Nightfall contacts
              family.
            </p>
          )}
          <p>
            These signals do not tell Nightfall whether someone is asleep or
            what they intend to do.
          </p>
        </div>
      </details>
      <div className="stack gap-sm">
        <CameraFeed
          aspect="monitor"
          expandable
          src={
            preview
              ? `/ui/assets/${returned ? "camera-returned.png" : "camera-demo.png"}`
              : video.src
          }
          live={video.live}
          caption={
            preview
              ? "Recorded camera image"
              : video.live
                ? "Front entrance"
                : video.status
          }
        />
        <Button variant="secondary" onClick={() => navigate("/door")}>
          Open door controls
        </Button>
      </div>
      <div className="stack gap-sm">
        <DoorAudioControls
          audio={audio}
          onToggle={(direction) => {
            if (audio.channels[direction] !== "off") {
              audio.stop(direction);
              void refresh();
            } else void audio.start(direction);
          }}
        />
      </div>
      <Card>
        <Row
          title="Voice at the door"
          detail={
            preview
              ? state.voice.name || "Family voice"
              : state.voice.mock
                ? "Mock voice mode"
                : state.voice.name || "Choose a voice"
          }
          onClick={() => navigate("/voice?returnTo=/home")}
        />
        <Row
          title="Care circle"
          detail={callOrder || "No family contacts yet"}
          onClick={() => navigate("/setup/contacts?mode=edit&returnTo=/home")}
        />
        <Row
          title="Care profile"
          detail={`${h.person_full_name || h.person_name} · Care details`}
          onClick={() => navigate("/setup/profile?mode=edit&returnTo=/home")}
        />
      </Card>
      <NearbySearchSummary />
      {!soundEnabled && (
        <Button
          variant="secondary"
          onClick={() => void enableSound().catch((e) => setMessage(e.message))}
        >
          Enable sound on this phone
        </Button>
      )}
      {message && <Notice tone="warning">{message}</Notice>}
      <div className="actions">
        <Button variant="secondary" onClick={() => navigate("/setup")}>
          Review care setup
        </Button>
        <Button
          variant="quiet"
          onClick={() => void changeWatch()}
          disabled={busy}
        >
          {busy
            ? "Updating…"
            : state.night_mode
              ? "Turn night watch off"
              : "Turn night watch on"}
        </Button>
      </div>
    </div>
  );
}
