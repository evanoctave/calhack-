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
import {
  rememberSetupStep,
  resumedSetupStep,
  type SetupStep,
} from "./state/setupFlow";
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
const ConnectPage = lazy(() =>
  import("./features/setup/ConnectPage").then((m) => ({
    default: m.ConnectPage,
  })),
);

function ResumeSetup() {
  const { preview, memberId } = useNightfall();
  return (
    <Navigate to={`/setup/${resumedSetupStep(preview, memberId)}`} replace />
  );
}
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
    silenceRing,
    shouldRing,
    visitorMessage,
  } = useNightfall();
  const location = useLocation(),
    navigate = useNavigate();
  useEffect(() => {
    if (new URLSearchParams(location.search).get("mode") === "edit") return;
    const step = location.pathname.replace("/setup/", "");
    if (["profile", "contacts", "voice", "connect"].includes(step))
      rememberSetupStep(step as SetupStep, preview, memberId);
  }, [location.pathname, location.search, preview, memberId]);
  const [dismissed, setDismissed] = useState("");
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
        {!preview && (
          <span className={styles.mode}>Caregiver</span>
        )}
      </div>
      <main className={styles.content}>
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
                <Route path="/setup/voice" element={<VoicePage onboarding />} />
                <Route path="/setup/connect" element={<ConnectPage />} />
                <Route path="/setup/:step" element={<SetupPage />} />
                <Route path="/setup" element={<ResumeSetup />} />
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
