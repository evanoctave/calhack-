import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  Notice,
  PageHeader,
  Row,
} from "../../components/ui";
import { CameraFeed } from "../../components/CameraFeed";
import { useNightfall } from "../../state/NightfallProvider";
import { canShowEmergency, isHelpIncident } from "../incident/incidentView";
import { useDoorVideo } from "../live/useDoorVideo";
import { useDoorAudio } from "../live/useDoorAudio";
import { DoorAudioControls } from "../live/DoorAudioControls";

export function HomePage() {
  const {
    state,
    memberId,
    preview,
    setScenario,
    soundEnabled,
    enableSound,
    mutate,
    refresh,
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
        <h1>Your night, connected</h1>
        <p className="muted">
          Connect to the Nightfall server or open Preview to explore the app.
        </p>
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
  const returned = inc?.state === "RETURNED" && inc.checkin !== "self_other";
  const active = inc && !["CLOSED", "ARMED_IDLE"].includes(inc.state);
  const countdown = inc?.door_opened_at
    ? Math.max(
        0,
        Math.ceil(
          state.door_wait_s -
            (clock + offset - new Date(inc.door_opened_at).getTime()) / 1000,
        ),
      )
    : 0;
  const title =
    inc?.state === "CONVERSATION"
      ? `Talking to ${h.person_name}`
      : inc?.state === "DOOR_OPEN"
        ? `${h.person_name} is out of view`
        : inc?.state === "RETURNED"
          ? returned
            ? `${h.person_name} is back inside`
            : `${inc.checkin_who || "Family"} checked in`
          : inc?.acked_by && active
            ? `${inc.acked_by_name || "Family"} is on it`
            : inc?.state === "VISITOR"
              ? "Someone is at the door"
              : inc?.state === "WATCHING"
                ? "Watching the entrance"
                : isHelpIncident(inc) &&
                    inc &&
                    ["ESCALATING", "EXHAUSTED"].includes(inc.state)
                  ? "Help requested at the door"
                  : inc?.exited_at && inc.state !== "CLOSED"
                    ? `${h.person_name} left home`
                    : state.night_mode
                      ? "Night watch is on"
                      : "Night watch is off";
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
      <PageHeader
        title={title}
        description={`Good evening, ${h.tree.find((m) => m.id === memberId)?.name || h.caregiver_name}`}
      />
      <Badge
        tone={
          canShowEmergency(inc) && !inc?.acked_by
            ? "danger"
            : inc?.state === "DOOR_OPEN"
              ? "warning"
              : "success"
        }
      >
        {active
          ? inc?.state === "RETURNED"
            ? returned
              ? "Return confirmed"
              : "Check-in complete"
            : inc?.acked_by
              ? "Family is responding · Return not confirmed"
              : inc?.state === "VISITOR"
                ? "Visitor check-in"
                : "Checking the door"
          : `Watching over ${h.person_name}`}
      </Badge>
      <button
        className="camera-link"
        onClick={() => navigate("/door")}
        aria-label="Open the front entrance camera"
      >
        <CameraFeed
          src={
            preview
              ? `/ui/assets/${returned ? "camera-returned.png" : "camera-demo.png"}`
              : video.src
          }
          live={video.live}
          caption={
            preview
              ? "Recorded demo · Tap for Talk / Listen"
              : video.live
                ? "Front entrance · Tap for Talk / Listen"
                : video.status
          }
        />
      </button>
      <DoorAudioControls
        audio={audio}
        onToggle={(direction) => {
          if (audio.channels[direction] !== "off") {
            audio.stop(direction);
            void refresh();
          } else void audio.start(direction);
        }}
      />
      {inc?.state === "CONVERSATION" && (
        <Card>
          <p className="eyebrow">A familiar voice at the door</p>
          <h2 style={{ marginTop: 8 }}>
            Helping {h.person_name} head back inside
          </h2>
          <p className="caption muted" style={{ marginTop: 8 }}>
            {inc.lines_spoken} lines spoken. Return is not yet confirmed.
          </p>
          <p className="sponsor" style={{ marginTop: 12 }}>
            Voice · Cartesia / Dialogue · Claude
          </p>
        </Card>
      )}
      {inc?.state === "DOOR_OPEN" && (
        <Notice tone="warning">
          <strong className="tabular">
            {countdown > 0
              ? `${countdown}s return check`
              : "Checking for an update…"}
          </strong>
          <p>Nightfall checks for a return before calling your care circle.</p>
        </Notice>
      )}
      {inc?.state === "VISITOR" && (
        <Notice>
          Nightfall is checking who is at the door. Open the camera to listen or
          speak.
        </Notice>
      )}
      <Card>
        <Row
          title="Latest check"
          detail={
            inc?.state === "RETURNED"
              ? returned
                ? "Back inside · Calls cancelled"
                : "Check-in resolved · Calls stopped"
              : inc?.state === "WATCHING"
                ? "Observation only · Family calls are not active"
                : inc?.state === "CLOSED"
                  ? "Check-in complete"
                  : isHelpIncident(inc)
                    ? "Help button pressed · Check the door"
                    : inc?.exited_at
                      ? `Exit at ${new Date(inc.exited_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
                      : inc?.state === "CONVERSATION"
                        ? "Voice check-in in progress"
                        : "No exit detected"
          }
          trailing={
            <span className="caption muted">
              {new Date(state.now).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          }
        />
      </Card>
      {active && (
        <Button
          onClick={() =>
            navigate(
              inc?.state === "RETURNED" || inc?.acked_by
                ? "/incident/respond"
                : "/incident",
            )
          }
        >
          {inc?.state === "RETURNED"
            ? "View return details"
            : inc?.acked_by
              ? "View response"
              : "Open current alert"}
        </Button>
      )}
      <Card>
        <Row
          title="Family AI voice"
          detail={
            state.voice.mock
              ? "Demo voice · Provider not connected"
              : `${state.voice.name || "Selected voice"} · Ready`
          }
          onClick={() => navigate("/voice")}
        />
        <Row
          title="Care circle"
          detail={callOrder || "No family contacts yet"}
          onClick={() => navigate("/setup/contacts")}
        />
      </Card>
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
        <Button variant="secondary" onClick={() => navigate("/setup/profile")}>
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
      {preview && (
        <Card>
          <p className="eyebrow">Continue this preview</p>
          <div className="stack gap-sm" style={{ marginTop: 12 }}>
            {!inc && (
              <Button onClick={() => setScenario("approach")}>
                Dad approaches the door
              </Button>
            )}
            {inc?.state === "CONVERSATION" && (
              <>
                <Button onClick={() => setScenario("returned")}>
                  He heads back inside
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setScenario("countdown")}
                >
                  He leaves the camera view
                </Button>
              </>
            )}
            {inc?.state === "DOOR_OPEN" && (
              <>
                <Button onClick={() => setScenario("ringing")}>
                  He stays outside · Call family
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setScenario("returned")}
                >
                  He returns during the check
                </Button>
              </>
            )}
            {inc && !["CONVERSATION", "DOOR_OPEN"].includes(inc.state) && (
              <Button
                variant="secondary"
                onClick={() => setScenario("watching")}
              >
                Reset preview
              </Button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
