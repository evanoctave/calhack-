import { useEffect, useState } from "react";
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
import { ApiError } from "../../data/api";
import { useNightfall } from "../../state/NightfallProvider";
import {
  canRespond,
  canShowEmergency,
  confirmedReturned,
  countdown,
  incidentTitle,
  isHelpIncident,
  isResolvedIncident,
} from "./incidentView";
import styles from "./IncidentPage.module.css";

function useServerTime(serverNow?: string) {
  const [tick, setTick] = useState(0);
  const [anchor, setAnchor] = useState({
    server: Date.now(),
    local: Date.now(),
  });
  useEffect(() => {
    if (serverNow)
      setAnchor({ server: Date.parse(serverNow), local: Date.now() });
  }, [serverNow]);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  void tick;
  return anchor.server + Date.now() - anchor.local;
}

export function AlertPage() {
  const {
    state,
    memberId,
    preview,
    mutate,
    enableSound,
    doorSpeech,
    visitorMessage,
  } = useNightfall();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const now = useServerTime(state?.now);
  if (!state) return <Notice tone="info">Loading tonight’s activity…</Notice>;
  const incident = state.incident,
    name = state.household.person_name;
  const returned = confirmedReturned(incident),
    actionable = canRespond(incident),
    help = isHelpIncident(incident);
  const speech =
    doorSpeech &&
    (!doorSpeech.incident_id || doorSpeech.incident_id === incident?.id)
      ? doorSpeech.text
      : "";
  const time = incident?.exited_at || incident?.opened_at;
  const at = time
    ? new Date(time).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  const deadlinePassed = Boolean(
    incident?.deadline_at && now >= Date.parse(incident.deadline_at),
  );
  const callFirst = state.rings.at(-1)?.member_ids || [];
  const frame = preview
    ? `${import.meta.env.BASE_URL}assets/${returned ? "camera-returned.png" : "camera-demo.png"}`
    : incident?.exit_frame || undefined;
  const act = async (kind: "answer" | "respond") => {
    if (!incident || busy) return;
    setBusy(kind);
    setError("");
    try {
      if (kind === "answer") await enableSound().catch(() => undefined);
      await mutate(kind === "answer" ? "/answer" : "/ack", {
        incident_id: incident.id,
        member_id: memberId,
      });
      navigate(kind === "answer" ? "/incident/call" : "/incident/respond", {
        state: { answered: incident.id },
      });
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 404
          ? "This incident changed while you were responding. The latest state has been refreshed; check it before trying again."
          : cause instanceof Error
            ? cause.message
            : "Could not send your response. Try again.",
      );
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="stack">
      <PageHeader
        back="/"
        eyebrow={
          returned
            ? "Return confirmed"
            : actionable
              ? "Needs your attention"
              : "Tonight’s activity"
        }
        title={incidentTitle(incident, name)}
        description={
          at ? `Front entrance · ${at}` : "Nightfall is watching for changes."
        }
      />
      {error && <Notice tone="danger">{error}</Notice>}
      {incident ? (
        <>
          <CameraFeed
            src={frame}
            caption={
              preview
                ? "Actual webcam · Simulated home scenario"
                : incident.exit_frame
                  ? help
                    ? "Latest image from the door"
                    : "Last clear image captured at exit"
                  : "No saved camera image for this check-in"
            }
          />
          {returned ? (
            <Notice tone="success">
              {name} was detected back inside. Any ongoing rings were cancelled.
            </Notice>
          ) : incident.state === "ACKED" ? (
            <Notice tone="success">
              {incident.acked_by_name || "A family member"} is on it. Other
              phones stopped ringing.{" "}
              {help
                ? "Check on the person at the door."
                : "Return is not yet confirmed."}
            </Notice>
          ) : incident.state === "DOOR_OPEN" ? (
            <Card>
              <p className="eyebrow">Waiting for a return</p>
              <p className={styles.countdown}>
                {countdown(
                  incident.door_opened_at
                    ? new Date(
                        Date.parse(incident.door_opened_at) +
                          state.door_wait_s * 1000,
                      ).toISOString()
                    : null,
                  now,
                )}
              </p>
              <p className="muted">
                Nightfall waits {state.door_wait_s} seconds before calling
                family.
              </p>
            </Card>
          ) : incident.state === "CONVERSATION" ? (
            <Card>
              <h2>A familiar voice at the door</h2>
              <p className="muted">
                Nightfall is speaking with {name} and watching for a return.
              </p>
              {speech && <blockquote aria-live="polite">{speech}</blockquote>}
              <p className="caption">Voice · Cartesia / Dialogue · Claude</p>
            </Card>
          ) : incident.state === "VISITOR" ? (
            <Card>
              <h2>Someone is at the door</h2>
              <p className="muted">
                Open the camera to see and speak with them.
              </p>
              {visitorMessage && (
                <blockquote aria-live="polite">{visitorMessage}</blockquote>
              )}
              {speech && <p className="caption">Nightfall: {speech}</p>}
            </Card>
          ) : incident.state === "WATCHING" ? (
            <Notice tone="info">
              Nightfall is observing this check-in. Family calls have not
              started.
            </Notice>
          ) : actionable ? (
            <Notice tone="warning">
              {help
                ? "Someone pressed Help at the door. The care circle is being called."
                : `No return confirmed. ${name} is still out of view.`}
            </Notice>
          ) : (
            <Notice tone="info">This check-in has ended.</Notice>
          )}
          <Card>
            <details>
              <summary>Why Nightfall responded</summary>
              <div className="stack gap-sm">
                <p className="muted">
                  {help
                    ? "The Help button requested immediate family support."
                    : incident.wander?.reasons?.length
                      ? incident.wander.reasons.join(" · ")
                      : "Nightfall is checking the entrance and watching for a return."}
                </p>
                <Row
                  title="Identity"
                  detail={
                    incident.identity === "match"
                      ? `Recognized as ${name}`
                      : incident.identity === "other"
                        ? "Another household member"
                        : "Not confirmed"
                  }
                />
                {incident.heading && (
                  <Row
                    title="Last observed direction"
                    detail={incident.heading}
                  />
                )}
                {incident.checkin_who && (
                  <Row title="Check-in" detail={incident.checkin_who} />
                )}
              </div>
            </details>
          </Card>
          {(actionable || incident.state === "ACKED") && (
            <Card>
              <p className="eyebrow">Care circle</p>
              {[...state.household.tree]
                .sort((a, b) => a.tier - b.tier)
                .map((person) => (
                  <Row
                    key={person.id}
                    title={person.name}
                    detail={
                      incident.acked_by === person.id
                        ? "On it · Other calls stopped"
                        : incident.acked_by
                          ? "Call stopped"
                          : help
                            ? "Phone alerted · Help requested"
                            : callFirst.includes(person.id)
                              ? "Called · Waiting for a response"
                              : `Contact priority ${person.tier}`
                    }
                    trailing={
                      <span className={styles.order}>{person.tier}</span>
                    }
                  />
                ))}
              <p className="caption">
                {help
                  ? "All family phones are alerted. Telephone calls follow the contact order."
                  : `No answer? Nightfall moves to the next priority after ${state.ladder_step_s} seconds.`}
              </p>
            </Card>
          )}
          {canShowEmergency(incident) &&
            (state.call_911 || incident.emergency.option_shown) && (
              <Card>
                <Badge tone="danger">
                  {deadlinePassed && !help
                    ? "15-minute mark reached"
                    : "Emergency option available"}
                </Badge>
                <h2>
                  {deadlinePassed && !help
                    ? `If ${name} is still missing, call 911.`
                    : "Need emergency help?"}
                </h2>
                {!deadlinePassed && !help && (
                  <p className="muted">
                    15-minute mark in {countdown(incident.deadline_at, now)}
                  </p>
                )}
                <p className="muted">
                  You decide. Nightfall never calls 911 on its own.
                </p>
                {preview ? (
                  <Button
                    variant="danger"
                    onClick={() =>
                      setError(
                        "Preview only. No emergency call will be placed.",
                      )
                    }
                  >
                    Call 911
                  </Button>
                ) : (
                  <a className={styles.emergencyLink} href="tel:911">
                    Call 911
                  </a>
                )}
              </Card>
            )}
          {actionable && (
            <div className="actions">
              <div className="grid-two">
                <Button variant="secondary" onClick={() => navigate("/brief")}>
                  Open brief
                </Button>
                <Button
                  variant="secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void act("respond")}
                >
                  {busy === "respond" ? "Sending…" : "I’ve got him"}
                </Button>
              </div>
              <Button
                disabled={Boolean(busy)}
                onClick={() => void act("answer")}
              >
                {busy === "answer" ? "Connecting…" : "Answer Nightfall"}
              </Button>
            </div>
          )}
          {!actionable && (
            <div className="actions">
              <Button
                onClick={() =>
                  navigate(
                    incident.state === "ACKED" ? "/incident/respond" : "/door",
                  )
                }
              >
                {incident.state === "ACKED"
                  ? "See response"
                  : "Open door camera"}
              </Button>
              <Button variant="secondary" onClick={() => navigate("/")}>
                Back to Home
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <Card>
            <h2>All quiet for now</h2>
            <p className="muted">
              New check-ins and family calls will appear here.
            </p>
          </Card>
          <Button onClick={() => navigate("/")}>Back to Home</Button>
        </>
      )}
    </div>
  );
}

export function ResponsePage() {
  const { state, memberId, preview, setScenario } = useNightfall();
  const navigate = useNavigate();
  if (!state) return <Notice tone="info">Loading response…</Notice>;
  const incident = state.incident,
    returned = confirmedReturned(incident),
    help = isHelpIncident(incident),
    resolved = isResolvedIncident(incident);
  const checkinResolved =
    incident?.state === "RETURNED" && incident.checkin === "self_other";
  const mine = incident?.acked_by === memberId,
    acknowledged = Boolean(incident?.acked_by) && !resolved;
  const by = incident?.acked_by_name || "A family member",
    name = state.household.person_name;
  return (
    <div className="stack">
      <PageHeader
        back="/incident"
        eyebrow={
          returned
            ? "Return confirmed"
            : checkinResolved
              ? "Check-in resolved"
              : acknowledged
                ? "Response confirmed"
                : "Current response"
        }
        title={
          returned
            ? `${name} is back inside`
            : checkinResolved
              ? `${incident.checkin_who || "A family member"} checked in`
              : acknowledged
                ? mine
                  ? "You’re on it."
                  : `${by} is on it.`
                : resolved && incident
                  ? incidentTitle(incident, name)
                  : "Response not confirmed"
        }
        description={
          returned
            ? "Nightfall detected a return."
            : checkinResolved
              ? "The automatic alert was stood down."
              : acknowledged
                ? "Other phones stopped ringing."
                : resolved && incident
                  ? "No family response is needed for this check-in."
                  : "Check the current alert before responding."
        }
      />
      {returned ? (
        <>
          <CameraFeed
            src={
              preview
                ? `${import.meta.env.BASE_URL}assets/camera-returned.png`
                : undefined
            }
            caption={
              preview
                ? "Recorded return capture · Preview"
                : "Return confirmed by Nightfall"
            }
          />
          <Notice tone="success">
            Any ongoing family calls have stopped. This check-in is saved in
            tonight’s activity.
          </Notice>
        </>
      ) : checkinResolved ? (
        <Notice tone="success">
          A care-circle member identified themselves at the door, so this alert
          ended. This does not confirm {name}’s location.
        </Notice>
      ) : acknowledged ? (
        <>
          <Card>
            <div className={styles.avatar}>{by.charAt(0)}</div>
            <h2>{by} is handling the situation.</h2>
            <p>
              Keep the brief open while you coordinate with the care circle.
            </p>
          </Card>
          <Card>
            <h2>
              {help
                ? "Check on the person at the door"
                : `${name}’s return is not confirmed`}
            </h2>
            <p className="muted">
              {help
                ? "This confirms your response to the help request. Keep the camera open while you check in."
                : `This confirms a family response. It does not confirm that ${name} is back inside.`}
            </p>
          </Card>
        </>
      ) : resolved && incident ? (
        <Notice tone="info">
          {incident.state === "WATCHING"
            ? "Nightfall is observing the entrance. Family calls are not active."
            : "This check-in is complete."}
        </Notice>
      ) : (
        <Notice tone="warning">
          No family response is confirmed in the latest server state.
        </Notice>
      )}
      <div className="actions">
        <Button onClick={() => navigate(acknowledged ? "/brief" : "/incident")}>
          {acknowledged ? "Back to search brief" : "View current alert"}
        </Button>
        <Button variant="secondary" onClick={() => navigate("/door")}>
          Open door camera
        </Button>
        {preview && (
          <Button
            variant="quiet"
            onClick={() => {
              setScenario("watching");
              navigate("/");
            }}
          >
            Replay the scenario
          </Button>
        )}
      </div>
    </div>
  );
}
