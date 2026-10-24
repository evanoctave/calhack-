import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useNightfall } from "./state/NightfallProvider";
import { Badge, Button, Notice, Sheet } from "./components/ui";
import { isHelpIncident } from "./features/incident/incidentView";
import { HomePage } from "./features/home/HomePage";
import styles from "./App.module.css";

const SetupPage = lazy(() =>
  import("./features/setup/SetupPage").then((m) => ({ default: m.SetupPage })),
);
const JoinPage = lazy(() =>
  import("./features/setup/SetupPage").then((m) => ({ default: m.JoinPage })),
);
const CarePage = lazy(() =>
  import("./features/setup/SetupPage").then((m) => ({ default: m.CarePage })),
);
const VoicePage = lazy(() =>
  import("./features/voice/VoicePage").then((m) => ({ default: m.VoicePage })),
);
const AlertPage = lazy(() =>
  import("./features/incident/IncidentPage").then((m) => ({
    default: m.AlertPage,
  })),
);
const ResponsePage = lazy(() =>
  import("./features/incident/IncidentPage").then((m) => ({
    default: m.ResponsePage,
  })),
);
const CallPage = lazy(() =>
  import("./features/live/CallPage").then((m) => ({ default: m.CallPage })),
);
const DoorPage = lazy(() =>
  import("./features/live/DoorPage").then((m) => ({ default: m.DoorPage })),
);
const BriefPage = lazy(() =>
  import("./features/brief/BriefPage").then((m) => ({ default: m.BriefPage })),
);

class ScreenBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { failed: boolean }
> {
  state = { failed: false };
  componentDidUpdate(previous: { children: ReactNode; resetKey: string }) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey)
      this.setState({ failed: false });
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="empty-state">
        <h1>This screen couldn’t open</h1>
        <p className="muted">Reload to reconnect to Nightfall.</p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}

const scenarios = [
  ["watching", "Night watch", "No incident. Ready for the night."],
  ["approach", "Dad approaches", "The familiar voice speaks at the door."],
  ["countdown", "Out of view", "A short check before calling family."],
  ["returned", "Dad returns", "Back inside. Family calls are cancelled."],
  ["ringing", "Dad leaves", "The family phone rings with a brief."],
  ["responding", "You are on it", "Other family calls have stopped."],
  ["other-family", "Mike is on it", "Another family member is responding."],
  ["emergency", "15-minute mark", "A recommendation to call 911."],
  ["visitor", "Someone at the door", "A visitor, separate from an exit alert."],
  ["help", "Help requested", "The door help button alerts the family."],
];

export default function App() {
  const {
    state,
    memberId,
    preview,
    loading,
    error,
    refresh,
    mutate,
    enableSound,
    setScenario,
    silenceRing,
    shouldRing,
    visitorMessage,
  } = useNightfall();
  const location = useLocation(),
    navigate = useNavigate();
  const [scenarioOpen, setScenarioOpen] = useState(false),
    [dismissed, setDismissed] = useState("");
  const [dismissedVisitor, setDismissedVisitor] = useState("");
  const [answering, setAnswering] = useState(false),
    [answerError, setAnswerError] = useState("");
  const incident = state?.incident;
  const showIncoming =
    incident &&
    ["ESCALATING", "EXHAUSTED"].includes(incident.state) &&
    !incident.acked_by &&
    shouldRing &&
    dismissed !== incident.id &&
    !location.pathname.includes("/call") &&
    !location.pathname.startsWith("/brief");
  useEffect(() => {
    if (!incident || !["ESCALATING", "EXHAUSTED"].includes(incident.state))
      setDismissed("");
  }, [incident?.id, incident?.state]);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);
  const answer = async () => {
    if (!incident || answering) return;
    setAnswering(true);
    setAnswerError("");
    try {
      await enableSound().catch(() => undefined);
      await mutate("/answer", {
        incident_id: incident.id,
        member_id: memberId,
      });
      setDismissed(incident.id);
      navigate("/incident/call", { state: { answered: incident.id } });
    } catch (cause) {
      setAnswerError(
        cause instanceof Error ? cause.message : "Could not answer. Try again.",
      );
    } finally {
      setAnswering(false);
    }
  };
  const standalone =
    location.pathname.startsWith("/brief/") || location.pathname === "/join";
  const navHidden =
    location.pathname.startsWith("/setup") ||
    location.pathname.startsWith("/voice") ||
    location.pathname.includes("/call") ||
    standalone;
  return (
    <div className={styles.shell}>
      <div className={`${styles.topbar} no-print`}>
        <span className={styles.brand}>
          <span className={styles.moon} aria-hidden>
            ☾
          </span>{" "}
          Nightfall
        </span>
        {preview ? (
          <button onClick={() => setScenarioOpen(true)} className={styles.mode}>
            Preview · Scenarios
          </button>
        ) : (
          <span className={styles.mode}>Caregiver</span>
        )}
      </div>
      <main className={styles.content}>
        {preview && (
          <p className={`${styles.previewNote} no-print`}>
            Preview · Sample data, no calls placed
          </p>
        )}
        {error && !standalone && (
          <Notice tone="warning">
            <p>{error}</p>
            <button className="link-button" onClick={() => void refresh()}>
              Try again
            </button>
            <span> · </span>
            <button className="link-button" onClick={() => navigate("/join")}>
              Join care circle
            </button>
            <span> · </span>
            <a href="/ui/index.html?preview=1#/home">Open preview</a>
          </Notice>
        )}
        <ScreenBoundary resetKey={location.pathname}>
          <Suspense
            fallback={
              <div className="empty-state" role="status">
                <span className="spinner" />
                Opening screen…
              </div>
            }
          >
            {loading && !standalone ? (
              <div className="empty-state" role="status">
                <span className="spinner" />
                Connecting to Nightfall…
              </div>
            ) : (
              <Routes>
                <Route path="/" element={<Navigate to="/home" replace />} />
                <Route path="/home" element={<HomePage />} />
                <Route path="/setup/:step" element={<SetupPage />} />
                <Route
                  path="/setup"
                  element={<Navigate to="/setup/profile" replace />}
                />
                <Route path="/care" element={<CarePage />} />
                <Route path="/join" element={<JoinPage />} />
                <Route path="/voice/:step?" element={<VoicePage />} />
                <Route path="/incident" element={<AlertPage />} />
                <Route path="/incident/respond" element={<ResponsePage />} />
                <Route path="/incident/call" element={<CallPage />} />
                <Route path="/door" element={<DoorPage />} />
                <Route path="/brief/:token?" element={<BriefPage />} />
                <Route
                  path="*"
                  element={
                    <div className="empty-state">
                      <h1>Page not found</h1>
                      <Button onClick={() => navigate("/home")}>Go Home</Button>
                    </div>
                  }
                />
              </Routes>
            )}
          </Suspense>
        </ScreenBoundary>
      </main>
      {!navHidden && (
        <nav aria-label="Main navigation" className={`${styles.nav} no-print`}>
          {[
            ["/home", "Home", "home"],
            ["/incident", "Alerts", "alert"],
            ["/care", "Care", "care"],
          ].map(([path, label, icon]) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) =>
                `${styles.tab} ${isActive ? styles.active : ""}`
              }
            >
              <img
                src={`/ui/assets/icon-${icon}.svg`}
                alt=""
                width="22"
                height="22"
              />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      )}
      {scenarioOpen && (
        <Sheet title="Choose a scenario" onClose={() => setScenarioOpen(false)}>
          <p className="caption muted">
            Explore the complete flow using sample data.
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setScenarioOpen(false);
              navigate("/setup/profile");
            }}
          >
            Start with setup
          </Button>
          {scenarios.map(([value, title, detail]) => (
            <button
              key={value}
              className={styles.scenario}
              onClick={() => {
                setDismissed("");
                setScenario(value);
                setScenarioOpen(false);
                navigate(
                  ["responding", "other-family", "returned"].includes(value)
                    ? "/incident/respond"
                    : ["ringing", "emergency", "help"].includes(value)
                      ? "/incident"
                      : "/home",
                );
              }}
            >
              <strong>{title}</strong>
              <span>{detail}</span>
            </button>
          ))}
          <a href="/ui/index.html#/home" className="caption">
            Switch to connected app
          </a>
        </Sheet>
      )}
      {incident?.state === "VISITOR" &&
        dismissedVisitor !== incident.id &&
        location.pathname !== "/door" && (
          <Sheet
            title="Someone is at the door"
            onClose={() => setDismissedVisitor(incident.id)}
          >
            <Badge>Visitor check-in</Badge>
            <p>
              {visitorMessage ||
                "Nightfall is asking who is there. Open the camera to listen or speak."}
            </p>
            <Button
              onClick={() => {
                setDismissedVisitor(incident.id);
                navigate("/door");
              }}
            >
              Open door camera
            </Button>
            <Button
              variant="quiet"
              onClick={() => setDismissedVisitor(incident.id)}
            >
              Not now
            </Button>
          </Sheet>
        )}
      {showIncoming && (
        <Sheet
          title={`${state.household.person_name} needs you`}
          onClose={() => {
            silenceRing();
            setDismissed(incident.id);
          }}
        >
          <Badge tone="danger">
            Family call ·{" "}
            {state.household.tree.find((m) => m.id === memberId)?.name ||
              "Your phone"}
          </Badge>
          <h2>
            {isHelpIncident(incident)
              ? "Help requested at the door"
              : lastSeen(incident.exited_at, state.household.person_name)}
          </h2>
          <p className="muted">
            {isHelpIncident(incident)
              ? "Check the camera and speak to Dad. A departure has not been confirmed."
              : "Nightfall has the latest photo and nearby places ready."}
          </p>
          {answerError && <Notice tone="danger">{answerError}</Notice>}
          <Button onClick={() => void answer()} disabled={answering}>
            {answering ? "Connecting…" : "Answer"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              silenceRing();
              setDismissed(incident.id);
              navigate("/brief");
            }}
          >
            Open brief
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              silenceRing();
              setDismissed(incident.id);
              navigate("/incident");
            }}
          >
            Not now
          </Button>
          <p className="caption muted">
            Answering starts the conversation. Other calls stop when you confirm
            you’re on it.
          </p>
        </Sheet>
      )}
    </div>
  );
}

function lastSeen(time: string | null, name: string) {
  return time
    ? `${name} left home at ${new Date(time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
    : "Help was requested at the door";
}
