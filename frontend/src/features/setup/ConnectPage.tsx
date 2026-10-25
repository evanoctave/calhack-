import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CameraFeed } from "../../components/CameraFeed";
import {
  Badge,
  Button,
  Card,
  Notice,
  PageHeader,
  Progress,
  Row,
} from "../../components/ui";
import type { AudioRef } from "../../data/types";
import { useNightfall } from "../../state/NightfallProvider";
import { useNearbySearch } from "../../state/useNearbySearch";
import { useDoorVideo } from "../live/useDoorVideo";
import styles from "./ConnectPage.module.css";

const TEST_LINE = "This is Nightfall. The door speaker is ready.";
const ACTIVE_STATES = new Set([
  "CONVERSATION",
  "DOOR_OPEN",
  "ESCALATING",
  "EXHAUSTED",
  "ACKED",
  "VISITOR",
  "WATCHING",
]);
const normalAddress = (address: string) => address.trim().toLowerCase();

export function ConnectPage() {
  const {
    state,
    memberId,
    preview,
    loading,
    error: connectionError,
    soundEnabled,
    testSound,
    mutate,
  } = useNightfall();
  const nearby = useNearbySearch();
  const navigate = useNavigate();
  const household = state?.household;
  const member = household?.tree.find((person) => person.id === memberId);
  const video = useDoorVideo(member ? memberId : "", preview);
  const incident = state?.incident;
  const activeIncident = Boolean(
    incident &&
    incident.checkin !== "self_other" &&
    ACTIVE_STATES.has(incident.state),
  );
  const voice = state?.voice;
  const voiceReady = Boolean(
    !preview &&
    voice?.voice_id &&
    !voice.mock &&
    !["mock", "preview", "none"].includes(voice.source),
  );
  const cameraReady = Boolean(!preview && state?.live_frame && video.src);
  const profileReady = Boolean(
    household?.caregiver_name.trim() &&
    (household?.person_full_name.trim() || household?.person_name.trim()),
  );
  const savedMatches = (input: { address: string; radius_mi: number } | null) =>
    !input ||
    Boolean(
      household &&
      normalAddress(input.address) === normalAddress(household.address) &&
      input.radius_mi === household.radius_mi,
    );
  const addressReady = Boolean(
    household?.address.trim() &&
    Number.isFinite(household.home?.lat) &&
    Number.isFinite(household.home?.lng) &&
    household.radius_mi > 0 &&
    nearby.phase !== "locating" &&
    savedMatches(nearby.input) &&
    savedMatches(nearby.draft),
  );
  const identity = `${preview}:${memberId}:${voice?.voice_id || ""}:${voice?.source || ""}:${voice?.mock ?? true}:${voice?.style?.[0] ?? ""}:${voice?.style?.[1] ?? ""}`;
  const [phoneTested, setPhoneTested] = useState(false);
  const [doorResult, setDoorResult] = useState<{
    identity: string;
    realVoice: boolean;
  } | null>(null);
  const [heardIdentity, setHeardIdentity] = useState<string | null>(null);
  const [busy, setBusy] = useState<"phone" | "door" | "arm" | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const latest = useRef({
    identity,
    activeIncident,
    cameraReady,
    connectionError,
  });
  latest.current = { identity, activeIncident, cameraReady, connectionError };
  useEffect(() => {
    generation.current++;
    setDoorResult(null);
    setHeardIdentity(null);
    setBusy(null);
    setError("");
    return () => {
      generation.current++;
    };
  }, [identity, cameraReady, activeIncident, connectionError]);
  useEffect(() => {
    if (!soundEnabled) setPhoneTested(false);
  }, [soundEnabled]);
  const requestCurrent = (id: number) =>
    generation.current === id &&
    !latest.current.activeIncident &&
    !latest.current.connectionError;
  const phoneReady = phoneTested && soundEnabled;
  const heard = heardIdentity === identity && cameraReady && !connectionError;
  const allReady = Boolean(
    !preview &&
    state &&
    !connectionError &&
    !activeIncident &&
    profileReady &&
    addressReady &&
    member &&
    voiceReady &&
    cameraReady &&
    phoneReady &&
    heard,
  );

  async function playPhoneTest() {
    if (preview || activeIncident || connectionError || busy) return;
    const id = generation.current;
    setBusy("phone");
    setError("");
    try {
      await testSound();
      if (requestCurrent(id)) setPhoneTested(true);
    } catch (cause) {
      if (requestCurrent(id))
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not play phone sound. Try again.",
        );
    } finally {
      if (requestCurrent(id)) setBusy(null);
    }
  }
  async function playDoorTest() {
    if (
      preview ||
      activeIncident ||
      connectionError ||
      busy ||
      !member ||
      !voiceReady ||
      !cameraReady
    )
      return;
    const id = generation.current;
    setBusy("door");
    setDoorResult(null);
    setHeardIdentity(null);
    setError("");
    try {
      const result = await mutate<{ ok?: boolean; audio?: AudioRef }>("/say", {
        member_id: memberId,
        text: TEST_LINE,
      });
      if (!requestCurrent(id)) return;
      if (result.ok !== true)
        throw new Error("The door did not accept the test. Try again.");
      setDoorResult({
        identity,
        realVoice:
          result.audio?.mode === "cartesia" &&
          result.audio.source === "cartesia" &&
          Boolean(result.audio.url),
      });
    } catch (cause) {
      if (requestCurrent(id))
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not send the door voice test.",
        );
    } finally {
      if (requestCurrent(id)) setBusy(null);
    }
  }
  async function startWatch() {
    if (!allReady || busy || state?.night_mode) return;
    const id = generation.current;
    setBusy("arm");
    setError("");
    try {
      const result = await mutate<{ night_mode?: boolean }>("/arm", {
        on: true,
      });
      if (!requestCurrent(id)) return;
      if (result.night_mode !== true)
        throw new Error(
          "Night watch did not turn on. Check the connection and try again.",
        );
      navigate("/home");
    } catch (cause) {
      if (requestCurrent(id))
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not start night watch.",
        );
    } finally {
      if (requestCurrent(id)) setBusy(null);
    }
  }
  const status = (ready: boolean, otherwise = "Needed") => (
    <Badge tone={ready ? "success" : "neutral"}>
      {ready ? "Ready" : otherwise}
    </Badge>
  );
  const currentResult =
    !connectionError && doorResult?.identity === identity ? doorResult : null;

  return (
    <div className={styles.page}>
      <Progress step={4} total={4} />
      <PageHeader
        title="Connect & start"
        description="Check the camera, door speaker, and this phone before the first night."
        back="/setup/voice"
      />
      {preview && (
        <Notice>
          Preview only. Device checks and night watch require the connected app.
        </Notice>
      )}
      {loading && !state && <Notice>Loading your saved setup…</Notice>}
      {connectionError && <Notice tone="danger">{connectionError}</Notice>}
      {activeIncident ? (
        <Notice tone="warning">
          Nightfall is handling an active event. Device tests are paused.{" "}
          <Link to="/incident">Open the alert</Link>
        </Notice>
      ) : (
        state?.night_mode && (
          <Notice tone="success">
            Night watch is already on. You can check the devices below or go
            home.
          </Notice>
        )
      )}
      <Card>
        <h2>Saved setup</h2>
        <Row
          title="Care details"
          detail={
            profileReady
              ? `${household?.person_full_name || household?.person_name} · ${household?.caregiver_name}`
              : "Save the person’s name and your name."
          }
          trailing={status(profileReady)}
        />
        <Row
          title="Home address"
          detail={
            addressReady
              ? household?.address
              : nearby.phase === "locating"
                ? "The address is still being checked."
                : "Save your current address and search area."
          }
          trailing={status(
            addressReady,
            nearby.phase === "locating" ? "Checking" : "Needed",
          )}
        />
        <Row
          title="This family member"
          detail={member?.name || "Join the current care circle."}
          trailing={status(Boolean(member))}
        />
        <Row
          title="Selected voice"
          detail={
            voiceReady
              ? voice?.source === "clone"
                ? voice.name || "Family AI voice"
                : "Ready-made voice"
              : "Choose or create a connected voice."
          }
          trailing={status(voiceReady)}
        />
        <div className={styles.links}>
          {!member && <Link to="/join">Join the care circle</Link>}
          <Link to="/setup/profile?mode=edit&returnTo=/setup/connect">
            Edit care details
          </Link>
          <Link to="/setup/voice">Change voice</Link>
        </div>
        {nearby.phase === "searching" && addressReady && (
          <p className="caption muted">
            Nearby businesses are still loading. Your address is saved, so you
            can continue these checks.
          </p>
        )}
        {nearby.error && (
          <p className="caption muted">
            Nearby search: {nearby.error}{" "}
            <Link to="/setup/places?mode=edit&returnTo=/setup/connect">
              Review search
            </Link>
          </p>
        )}
      </Card>
      <Card>
        <div className="inline spread">
          <h2>Door camera</h2>
          {status(cameraReady, "No recent image")}
        </div>
        <CameraFeed
          src={cameraReady ? video.src : undefined}
          live={cameraReady && video.live}
          caption={
            cameraReady
              ? video.live
                ? "Live door camera"
                : "Recent door image"
              : video.status
          }
        />
        <p className="caption muted">
          On the camera device, open the door page and enable the camera and
          speaker. Keep that page open.
        </p>
        <div className={styles.links}>
          <a href="/door" target="_blank" rel="noreferrer">
            Open door camera page ↗
          </a>
          <Link to="/setup/camera?mode=edit&returnTo=/setup/connect">
            Camera settings
          </Link>
        </div>
      </Card>
      {!activeIncident && (
        <>
          <Card>
            <div className="inline spread">
              <h2>This phone’s sound</h2>
              {status(phoneReady, "Not tested")}
            </div>
            <p className="muted">Turn up the volume, then play a short tone.</p>
            <Button
              variant="secondary"
              onClick={() => void playPhoneTest()}
              disabled={
                preview || !state || Boolean(connectionError) || Boolean(busy)
              }
            >
              {busy === "phone" ? "Playing…" : "Test phone sound"}
            </Button>
            {phoneReady && (
              <p className="caption muted">
                Test tone played. Keep this app open for live demo ringing; this
                does not enable lock-screen alerts.
              </p>
            )}
          </Card>
          <Card>
            <div className="inline spread">
              <h2>Door speaker</h2>
              {status(heard, "Not confirmed")}
            </div>
            <p className="muted">
              Listen at the door to confirm the selected voice plays there.
            </p>
            <Button
              variant="secondary"
              onClick={() => void playDoorTest()}
              disabled={
                preview ||
                !member ||
                !voiceReady ||
                !cameraReady ||
                Boolean(connectionError) ||
                Boolean(busy)
              }
            >
              {busy === "door" ? "Sending…" : "Play voice at the door"}
            </Button>
            {currentResult && (
              <Notice tone={currentResult.realVoice ? "info" : "warning"}>
                {currentResult.realVoice
                  ? "Sent to the door. Confirm only if you heard the selected voice, not a generic device voice."
                  : "Sent using a browser/device voice fallback. The selected voice was not verified. Check the voice connection and try again."}
              </Notice>
            )}
            {currentResult?.realVoice && cameraReady && (
              <Button
                variant={heard ? "secondary" : "primary"}
                onClick={() => {
                  if (!connectionError) setHeardIdentity(identity);
                }}
                disabled={Boolean(connectionError) || Boolean(busy)}
              >
                {heard
                  ? "Selected voice heard ✓"
                  : "I heard the selected voice"}
              </Button>
            )}
          </Card>
        </>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="actions">
        {state?.night_mode ? (
          <Button onClick={() => navigate("/home")}>Go home</Button>
        ) : (
          <Button
            disabled={!allReady || Boolean(busy)}
            onClick={() => void startWatch()}
          >
            {busy === "arm" ? "Starting…" : "Start night watch"}
          </Button>
        )}
        <Button variant="quiet" onClick={() => navigate("/home")}>
          Connect later
        </Button>
      </div>
      {!state?.night_mode && !allReady && !activeIncident && (
        <p className="caption muted">
          Complete the checks above to start night watch.
        </p>
      )}
    </div>
  );
}
