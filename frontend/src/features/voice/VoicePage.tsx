import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../data/api";
import type { AudioRef, SampleKind } from "../../data/types";
import { useNightfall } from "../../state/NightfallProvider";
import {
  Badge,
  Button,
  Card,
  Field,
  Notice,
  PageHeader,
  Progress,
  Row,
} from "../../components/ui";
import styles from "./VoicePage.module.css";

const samples: Record<SampleKind, { title: string; line: string }> = {
  introduction: {
    title: "Introduction",
    line: "Hi Dad. It’s Sarah. I’m here with you.",
  },
  reassurance: {
    title: "Reassurance",
    line: "Take your time. There’s no rush.",
  },
  everyday: {
    title: "Everyday speech",
    line: "Let’s sit down and have some tea.",
  },
};
const kinds = Object.keys(samples) as SampleKind[];
interface Recording {
  blob: Blob;
  url: string;
  seconds: number;
  kind: SampleKind;
  levels: number[];
}
interface CloneResult {
  ok: boolean;
  voice_id: string;
  source: string;
  seconds: number;
}
interface VoicePreview {
  text: string;
  line_source: string;
  audio: AudioRef;
  preview?: boolean;
}
interface Preset {
  id: string;
  name: string;
  variant: string;
  file: string;
  gen?: { speed?: number; emotion?: string };
}
const fail = (e: unknown) =>
  e instanceof ApiError && e.status === 413
    ? "The recording is empty or too large. Record a short sample and try again."
    : e instanceof Error
      ? e.message
      : "Something went wrong. Please try again.";

export function VoicePage() {
  const { step = "samples" } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const { state, preview, mutate, refresh } = useNightfall();
  const selectedKind = search.get("kind");
  const kind: SampleKind = kinds.includes(selectedKind as SampleKind)
    ? (selectedKind as SampleKind)
    : "introduction";
  const [recording, setRecording] = useState<Recording | null>(null);
  const [consent, setConsent] = useState(false);
  const [recordingNow, setRecordingNow] = useState(false);
  const [preparingSample, setPreparingSample] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "uploading" | "saved" | "failed"
  >("idle");
  const [uploadError, setUploadError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [playing, setPlaying] = useState(false);
  const [clone, setClone] = useState<CloneResult | null>(null);
  const [generated, setGenerated] = useState<VoicePreview | null>(null);
  const [situation, setSituation] = useState(
    "He is at the front door at 2 AM and says he needs to go to work.",
  );
  const stepRef = useRef(step);
  stepRef.current = step;
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const pendingUrl = useRef<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const started = useRef(0);
  const live = useRef(true);
  const uploading = useRef(false);
  const previewRun = useRef(0);
  const previewPending = useRef(false);
  const consentRef = useRef(consent);
  consentRef.current = consent;
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const owner = state?.household.caregiver_name || "Sarah";
  const dad = state?.household.person_name || "Dad";
  const voice = state?.voice;
  const familyVoice = voice?.source === "clone" && !voice.mock && !preview;
  const stockVoice = voice?.source === "stock" && !voice.mock && !preview;
  const voiceLabel = familyVoice
    ? "Family AI voice"
    : stockVoice
      ? "Ready-made voice"
      : "Current voice";
  const voiceKey = JSON.stringify([
    preview,
    voice?.voice_id,
    voice?.source,
    voice?.mock,
    voice?.style,
  ]);
  const voiceKeyRef = useRef(voiceKey);
  voiceKeyRef.current = voiceKey;
  const line = (k: SampleKind) =>
    samples[k].line.replace("Sarah", owner).replaceAll("Dad", dad);
  const count = kinds.filter(
    (k) =>
      voice?.samples[k] || (recording?.kind === k && saveState === "saved"),
  ).length;
  const availableSamples = kinds.filter(
    (k) => voice?.samples[k] || recording?.kind === k,
  );
  const referenceKind = availableSamples.includes(selectedKind as SampleKind)
    ? (selectedKind as SampleKind)
    : recording?.kind || availableSamples[0];
  const reviewKind = recording?.kind || kind;
  const reviewSaved = recording
    ? saveState === "saved"
    : Boolean(voice?.samples[kind]);
  function releaseMic() {
    if (capTimer.current) clearTimeout(capTimer.current);
    capTimer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }
  function stopPlayback() {
    audio.current?.pause();
    audio.current = null;
    setPlaying(false);
  }
  function cancelPreviewRequest() {
    previewRun.current++;
    if (previewPending.current) {
      previewPending.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      previewRun.current++;
      previewPending.current = false;
      if (recorder.current) {
        recorder.current.onstop = null;
        if (recorder.current.state !== "inactive") recorder.current.stop();
      }
      releaseMic();
      audio.current?.pause();
      if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
    };
  }, []);
  useEffect(() => {
    setError("");
    setNote("");
    cancelPreviewRequest();
    stopPlayback();
    if (step !== "record" && recorder.current?.state === "recording") {
      recorder.current.onstop = null;
      recorder.current.stop();
      releaseMic();
      setRecordingNow(false);
    }
  }, [step]);
  useEffect(() => {
    cancelPreviewRequest();
    stopPlayback();
    setGenerated(null);
    setClone(null);
  }, [voiceKey]);
  useEffect(() => {
    if (!recordingNow) return;
    const tick = setInterval(
      () => setSeconds((Date.now() - started.current) / 1000),
      200,
    );
    return () => clearInterval(tick);
  }, [recordingNow]);

  async function startRecording() {
    if (!consent || busy || recordingNow) return;
    setError("");
    setBusy(true);
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError("Recording needs a supported browser on HTTPS or localhost.");
      setBusy(false);
      return;
    }
    try {
      const capture = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      if (!live.current || stepRef.current !== "record") {
        capture.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = capture;
      const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(
        (type) => MediaRecorder.isTypeSupported(type),
      );
      const current = new MediaRecorder(
        capture,
        mime ? { mimeType: mime } : undefined,
      );
      recorder.current = current;
      const chunks: BlobPart[] = [];
      const selected = kind;
      current.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      current.onerror = () => {
        current.onstop = null;
        if (current.state !== "inactive") current.stop();
        recorder.current = null;
        releaseMic();
        setRecordingNow(false);
        setBusy(false);
        setError("Recording stopped unexpectedly. Please record again.");
      };
      current.onstop = async () => {
        setBusy(true);
        setPreparingSample(true);
        const duration = (Date.now() - started.current) / 1000;
        releaseMic();
        setRecordingNow(false);
        recorder.current = null;
        const blob = new Blob(chunks, {
          type: current.mimeType || "audio/webm",
        });
        if (!live.current || stepRef.current !== "record") return;
        if (blob.size < 1000 || duration < 0.8) {
          setBusy(false);
          setPreparingSample(false);
          setError(
            "Nothing clear was recorded. Read the sentence for a few seconds, then stop.",
          );
          return;
        }
        if (blob.size > 8 * 1024 * 1024) {
          setBusy(false);
          setPreparingSample(false);
          setError(
            "That sample is too large. Please keep the recording under 60 seconds.",
          );
          return;
        }
        const levels = await waveform(blob);
        if (!live.current || stepRef.current !== "record") {
          if (live.current) {
            setBusy(false);
            setPreparingSample(false);
          }
          return;
        }
        if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
        pendingUrl.current = URL.createObjectURL(blob);
        const take = {
          blob,
          url: pendingUrl.current,
          seconds: duration,
          kind: selected,
          levels,
        };
        setRecording(take);
        setPreparingSample(false);
        navigate(`/voice/review?kind=${selected}`);
        void saveSample(take);
      };
      started.current = Date.now();
      setSeconds(0);
      setRecordingNow(true);
      current.start(250);
      capTimer.current = setTimeout(() => {
        if (current.state === "recording") current.stop();
      }, 60000);
    } catch (e) {
      releaseMic();
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone access was not allowed. Enable it in your browser’s site settings, then try again."
          : fail(e),
      );
    } finally {
      setBusy(false);
    }
  }
  function finishRecording() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }
  async function play(url?: string) {
    stopPlayback();
    setError("");
    if (!url) {
      setNote(
        preview
          ? "This preview has no audio attached."
          : "No audio was returned. The text preview is available below.",
      );
      return;
    }
    const sound = new Audio(url);
    audio.current = sound;
    sound.onended = () => {
      if (audio.current === sound) setPlaying(false);
    };
    sound.onerror = () => {
      if (audio.current !== sound) return;
      setPlaying(false);
      setError("This audio could not be played. Try again.");
    };
    try {
      await sound.play();
      if (audio.current === sound) setPlaying(true);
    } catch {
      if (audio.current === sound)
        setError("Tap Play again to allow sound in this browser.");
    }
  }
  async function saveSample(take = recording) {
    if (!take || uploading.current) return;
    if (!consentRef.current) {
      setSaveState("failed");
      setUploadError(
        "Allow Nightfall to use your voice before saving this sample.",
      );
      setBusy(false);
      return;
    }
    uploading.current = true;
    setSaveState("uploading");
    setUploadError("");
    setBusy(true);
    setError("");
    try {
      const data = new FormData();
      data.append(
        "clip",
        take.blob,
        take.blob.type.includes("mp4") ? "sample.mp4" : "sample.webm",
      );
      await api.upload(`/voice/samples/${take.kind}`, data);
      if (!live.current) return;
      setSaveState("saved");
      try {
        await refresh();
      } catch {
        if (live.current)
          setNote(
            "The sample was saved. The sample list could not refresh yet.",
          );
      }
    } catch (e) {
      if (live.current) {
        setSaveState("failed");
        setUploadError(fail(e));
      }
    } finally {
      uploading.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function cloneVoice() {
    if (busy) return;
    if (!consent) {
      setError(
        "Please give permission to create speech using your voice first.",
      );
      return;
    }
    cancelPreviewRequest();
    stopPlayback();
    setGenerated(null);
    setClone(null);
    setBusy(true);
    setError("");
    try {
      const result = await mutate<CloneResult>("/voice/clone", { name: owner });
      if (!live.current || stepRef.current !== "create") return;
      if (
        !result?.ok ||
        !result.voice_id ||
        !["clone", "mock"].includes(result.source)
      )
        throw new Error(
          "Family voice creation was not confirmed. Your saved samples are still available. Try again.",
        );
      setClone(result);
      if (live.current && stepRef.current === "create")
        navigate("/voice/preview");
    } catch (e) {
      if (live.current && stepRef.current === "create") setError(fail(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function generate() {
    if (busy) return;
    const run = ++previewRun.current;
    const key = voiceKey;
    const isCurrent = () =>
      live.current &&
      run === previewRun.current &&
      key === voiceKeyRef.current &&
      stepRef.current === "preview";
    previewPending.current = true;
    setBusy(true);
    setError("");
    setNote("");
    stopPlayback();
    setGenerated(null);
    try {
      const result = await mutate<VoicePreview>("/voice/preview", {
        situation,
      });
      if (!isCurrent()) return;
      setGenerated(result);
      if (!result.audio?.url)
        setNote(
          preview
            ? "Preview text only — no generated audio."
            : "The server returned a text-only preview. No generated audio is available.",
        );
    } catch (e) {
      if (isCurrent()) setError(fail(e));
    } finally {
      if (isCurrent()) {
        previewPending.current = false;
        setBusy(false);
      }
    }
  }
  async function removeSample(k: SampleKind) {
    setBusy(true);
    setError("");
    try {
      await api.delete(`/voice/samples/${k}`);
      if (recording?.kind === k) {
        stopPlayback();
        if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
        pendingUrl.current = null;
        setRecording(null);
        setSaveState("idle");
        setUploadError("");
      }
      await refresh();
      if (stepRef.current === "review") navigate("/voice/samples");
    } catch (e) {
      setError(fail(e));
    } finally {
      setBusy(false);
    }
  }
  const notices = (
    <>
      {error && <Notice tone="danger">{error}</Notice>}
      {note && <Notice>{note}</Notice>}
    </>
  );
  const permission = (
    <label className={styles.consent}>
      <input
        type="checkbox"
        checked={consent}
        disabled={recordingNow || saveState === "uploading"}
        onChange={(e) => setConsent(e.target.checked)}
      />
      <span>
        I allow Nightfall to generate new speech using my voice for {dad}’s
        check-ins, including words I have not recorded.
      </span>
    </label>
  );
  if (!state) return <Notice>Loading family voice…</Notice>;
  if (step === "presets")
    return <Presets onDone={() => navigate("/setup/contacts")} />;
  if (step === "record")
    return (
      <div className={styles.page}>
        <PageHeader
          title="Record a voice sample"
          description="Use your usual, comfortable voice."
          back="/voice/samples"
        />
        <p className="caption muted">
          Sample {kinds.indexOf(kind) + 1} · Read aloud
        </p>
        <Card>
          <p className={styles.quote}>{line(kind)}</p>
          <p className="caption muted">Sample prompt · Speak naturally</p>
        </Card>
        <div>
          <h2>Your voice is the reference</h2>
          <p className="caption muted">
            AI creates new sentences and chooses the tone for each situation.
          </p>
        </div>
        {permission}
        <p className="caption muted">
          {recordingNow
            ? preview
              ? "Microphone is on. Stopping saves this take to the preview only."
              : "Microphone is on. Tap Stop & save to upload this sample."
            : preview
              ? "Preview mode: recordings stay local to this browser session."
              : "Your microphone turns on only when you tap Record."}
        </p>
        {recordingNow && (
          <div role="status" className={styles.recording}>
            <span />
            Recording · {formatTime(seconds)}
          </div>
        )}
        {notices}
        <div className="actions">
          <Button
            disabled={busy || (!recordingNow && !consent)}
            variant={recordingNow ? "danger" : "primary"}
            onClick={
              recordingNow ? finishRecording : () => void startRecording()
            }
          >
            {preparingSample
              ? "Preparing sample…"
              : busy
                ? "Opening microphone…"
                : recordingNow
                  ? "Stop & save"
                  : "Record voice sample"}
          </Button>
        </div>
      </div>
    );
  if (step === "review")
    return (
      <div className={styles.page}>
        <PageHeader
          title="Review your voice sample"
          description={`Sample ${kinds.indexOf(recording?.kind || kind) + 1} · ${owner}’s voice`}
          back="/voice/samples"
        />
        {recording || voice?.samples[kind] ? (
          <>
            <Card>
              <p className={styles.quote}>“{line(reviewKind)}”</p>
              {recording && (
                <div
                  className={styles.wave}
                  aria-label="Recorded sample waveform"
                >
                  {recording.levels.map((level, i) => (
                    <span
                      key={i}
                      style={{ height: `${Math.max(8, level * 100)}%` }}
                    />
                  ))}
                </div>
              )}
              <div className={styles.playRow}>
                <Button
                  variant="quiet"
                  onClick={() =>
                    playing
                      ? stopPlayback()
                      : void play(
                          recording?.url ||
                            (preview
                              ? undefined
                              : `/voice/samples/${kind}.wav`),
                        )
                  }
                >
                  {playing ? "Ⅱ Pause sample" : "▷ Play sample"}
                </Button>
                <span className="caption muted">
                  {recording ? formatTime(recording.seconds) : "Saved sample"}
                </span>
              </div>
            </Card>
            {saveState === "uploading" && (
              <p role="status" className="caption muted">
                {preview
                  ? "Saving sample to this preview…"
                  : "Uploading your sample…"}
              </p>
            )}
            {reviewSaved && (
              <Notice tone="success">
                {preview
                  ? "Sample saved to this preview only."
                  : "Sample saved. Next, create your family AI voice."}
              </Notice>
            )}
            {uploadError && (
              <Notice tone="danger">
                {uploadError} Your take is still here. Retry saving or record
                again.
              </Notice>
            )}
            <div>
              <h2>Used as a voice reference</h2>
              <p className="caption muted">
                Saving a sample does not change the door voice. Create your
                family AI voice next to use this recording as its reference.
              </p>
            </div>
            {notices}
            {!consent && !reviewSaved && permission}
            <div className="actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => navigate(`/voice/record?kind=${reviewKind}`)}
              >
                Record again
              </Button>
              {reviewSaved ? (
                <Button
                  disabled={busy}
                  onClick={() => navigate("/voice/create")}
                >
                  Continue to create voice
                </Button>
              ) : (
                <Button
                  disabled={busy || !consent}
                  onClick={() => void saveSample()}
                >
                  {saveState === "uploading" ? "Saving sample…" : "Retry save"}
                </Button>
              )}
              <Button
                variant="quiet"
                disabled={busy}
                onClick={() => {
                  if (reviewSaved) void removeSample(reviewKind);
                  else {
                    stopPlayback();
                    if (pendingUrl.current)
                      URL.revokeObjectURL(pendingUrl.current);
                    pendingUrl.current = null;
                    setRecording(null);
                    setSaveState("idle");
                    setUploadError("");
                    navigate("/voice/samples");
                  }
                }}
              >
                {reviewSaved ? "Delete sample" : "Discard local take"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Notice>
              No saved sample was found, and the local recording is no longer
              available. Record a new sample to continue.
            </Notice>
            <Button onClick={() => navigate(`/voice/record?kind=${kind}`)}>
              Record a sample
            </Button>
          </>
        )}
      </div>
    );
  if (step === "create")
    return (
      <div className={styles.page}>
        <PageHeader
          title={
            busy ? "Creating your family voice" : "Create your family voice"
          }
          description="Your approved samples become the voice reference."
          back="/voice/samples"
          eyebrow="Family voice"
        />
        <Card>
          <Row
            title="Samples received"
            detail={`${count} saved sample${count === 1 ? "" : "s"}`}
            trailing={count ? "✓" : "—"}
          />
          <Row
            title="Prepare your voice"
            detail={
              busy
                ? "Waiting for the voice service"
                : "Create a voice from your saved samples"
            }
            trailing={busy ? "…" : "Next"}
          />
          <Row
            title="Generate a preview"
            detail="A new sentence in a reassuring tone"
          />
        </Card>
        <p className="caption muted">
          The words can change. The familiar voice is based on your samples.
        </p>
        {permission}
        {voice?.mock && (
          <Notice tone="warning">
            {preview
              ? "This is an isolated preview. No voice will be cloned."
              : "Voice service is in mock mode. Creating a real family voice requires the configured voice service."}
          </Notice>
        )}
        {notices}
        <div className="actions">
          <Button
            disabled={busy || count === 0 || !consent}
            onClick={() => void cloneVoice()}
          >
            {busy ? "Creating voice…" : "Create family AI voice"}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => navigate("/voice/samples")}
          >
            Add another sample
          </Button>
        </div>
      </div>
    );
  if (step === "preview")
    return (
      <div className={styles.page}>
        <PageHeader
          title={
            familyVoice
              ? "Preview family AI voice"
              : stockVoice
                ? "Preview ready-made voice"
                : "Preview current voice"
          }
          description="Hear how your selected voice responds to a new situation."
          back="/voice/samples"
        />
        {stockVoice && (
          <Notice>
            <p>
              This is a ready-made voice, not your recorded voice. Saving a
              sample does not create a family AI voice.
            </p>
            {count > 0 && (
              <Button disabled={busy} onClick={() => navigate("/voice/create")}>
                Create family AI voice
              </Button>
            )}
          </Notice>
        )}
        {(clone?.source === "mock" || voice?.mock || preview) && (
          <Notice tone="warning">
            {preview
              ? "Preview mode — no cloned voice or generated audio."
              : "The voice service is in mock mode. This does not confirm a voice clone."}
          </Notice>
        )}
        {referenceKind && (
          <Card>
            <p className="caption muted">
              {owner}’s recorded sample · {samples[referenceKind].title}
            </p>
            {availableSamples.length > 1 && (
              <label className={styles.selectField}>
                Reference sample
                <select
                  value={referenceKind}
                  onChange={(e) => setSearch({ kind: e.target.value })}
                >
                  {availableSamples.map((sampleKind) => (
                    <option key={sampleKind} value={sampleKind}>
                      {samples[sampleKind].title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className={styles.quote}>“{line(referenceKind)}”</p>
            <Button
              variant="quiet"
              onClick={() =>
                void play(
                  recording?.kind === referenceKind
                    ? recording.url
                    : preview
                      ? undefined
                      : `/voice/samples/${referenceKind}.wav`,
                )
              }
            >
              Listen to sample
            </Button>
          </Card>
        )}
        <Card>
          <p className={styles.sponsor}>AI-GENERATED SPEECH</p>
          {generated ? (
            <>
              <p className={styles.quote}>“{generated.text}”</p>
              <p className="caption muted">
                Words: {generated.line_source} · Voice: {voiceLabel} ·{" "}
                {generated.audio?.source || generated.audio?.mode || "No audio"}
              </p>
              {generated.audio?.url && (
                <Button
                  variant="quiet"
                  onClick={() =>
                    playing ? stopPlayback() : void play(generated.audio.url)
                  }
                >
                  {playing ? "Pause preview" : "Play generated speech"}
                </Button>
              )}
            </>
          ) : (
            <p className="caption muted">
              Generate a new sentence to hear how Nightfall responds.
            </p>
          )}
          <Field
            label="Situation"
            value={situation}
            onChange={(e) => setSituation(e.target.value)}
          />
          <Button
            variant="secondary"
            disabled={busy || !situation.trim()}
            onClick={() => void generate()}
          >
            {busy ? "Generating…" : "Generate a preview"}
          </Button>
        </Card>
        <p className="caption muted">
          Voice · Cartesia
          <br />
          Dialogue · Claude
        </p>
        {notices}
        <div className="actions">
          <Button
            variant="secondary"
            onClick={() => navigate("/voice/samples")}
          >
            Add another sample
          </Button>
          <Button onClick={() => navigate("/setup/contacts")}>
            {voice?.voice_id && !voice.mock
              ? stockVoice
                ? "Continue with ready-made voice"
                : "Continue with this voice"
              : "Continue setup"}
          </Button>
        </div>
      </div>
    );
  return (
    <div className={styles.page}>
      <Progress step={2} total={6} />
      <PageHeader
        title="A familiar AI voice"
        description="Record a few samples of your voice."
        back="/setup/profile"
      />
      <div className="inline spread">
        <strong>{owner}’s voice</strong>
        <span className="caption muted">
          {count} sample{count === 1 ? "" : "s"}
        </span>
      </div>
      <Card>
        {kinds.map((k, i) => (
          <div className={styles.sample} key={k}>
            <div className="inline spread">
              <strong>{samples[k].title}</strong>
              <Button
                variant="quiet"
                disabled={busy}
                onClick={() => navigate(`/voice/record?kind=${k}`)}
              >
                {voice?.samples[k] ? "Redo" : "Record"}
              </Button>
            </div>
            <p>“{line(k)}”</p>
            <div className="inline spread">
              <span className="caption muted">
                Sample {i + 1} ·{" "}
                {voice?.samples[k] ? "Recorded" : "Not recorded"}
              </span>
              {voice?.samples[k] && (
                <div className={styles.sampleActions}>
                  <Button
                    variant="quiet"
                    onClick={() =>
                      void play(
                        preview
                          ? undefined
                          : `/voice/samples/${k}.wav?t=${Date.now()}`,
                      )
                    }
                  >
                    Play
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={busy}
                    onClick={() => void removeSample(k)}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
      </Card>
      <p className="caption muted">
        AI uses your samples to create new sentences and choose a reassuring
        tone.
      </p>
      <p className="caption muted">Voice · Cartesia / Dialogue · Claude</p>
      {voice?.voice_id && !voice.mock && (
        <Notice tone={stockVoice ? "info" : "success"}>
          {stockVoice
            ? "Ready-made voice selected. Create a family AI voice to use your saved samples."
            : familyVoice
              ? "Family AI voice selected for the door."
              : "A voice is selected for the door."}
        </Notice>
      )}
      {notices}
      <div className="actions">
        {voice?.voice_id && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => navigate("/voice/preview")}
          >
            {stockVoice
              ? "Preview ready-made voice"
              : familyVoice
                ? "Preview family AI voice"
                : "Preview current voice"}
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => navigate("/voice/presets")}
        >
          Choose a ready-made voice
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            navigate(
              count ? "/voice/create" : "/voice/record?kind=introduction",
            )
          }
        >
          {count ? "Create family AI voice" : "Record a voice sample"}
        </Button>
        <Button variant="quiet" onClick={() => navigate("/setup/contacts")}>
          {stockVoice
            ? "Continue with ready-made voice"
            : "Continue with current voice"}
        </Button>
      </div>
    </div>
  );
}

function Presets({ onDone }: { onDone: () => void }) {
  const { state, preview, mutate } = useNightfall();
  const query = useQuery({
    queryKey: ["voice-presets", preview],
    queryFn: ({ signal }) =>
      api.get<Preset[]>("/samples/index.json", { signal }),
  });
  const [selected, setSelected] = useState(state?.voice.voice_id || "");
  const [variant, setVariant] = useState("warm");
  const [speed, setSpeed] = useState(state?.voice.style?.[0] ?? 0.95);
  const [emotion, setEmotion] = useState(state?.voice.style?.[1] || "calm");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [playing, setPlaying] = useState("");
  const sound = useRef<HTMLAudioElement | null>(null);
  const active = useRef(true);
  const presets = [
    ...new Map(
      (query.data || []).map((preset) => [preset.id, preset]),
    ).values(),
  ];
  const current = presets.find((p) => p.id === selected);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      sound.current?.pause();
      sound.current = null;
    };
  }, []);
  async function play(id: string) {
    sound.current?.pause();
    sound.current = null;
    setError("");
    setNote("");
    if (playing === id) {
      setPlaying("");
      return;
    }
    setPlaying("");
    const file = query.data?.find(
      (p) => p.id === id && p.variant === variant,
    )?.file;
    if (!file) {
      setNote("This preview has no audio attached.");
      return;
    }
    const audio = new Audio(file);
    sound.current = audio;
    audio.onended = () => {
      if (sound.current === audio) setPlaying("");
    };
    audio.onerror = () => {
      if (sound.current !== audio) return;
      setPlaying("");
      setError("This voice sample could not be played.");
    };
    try {
      await audio.play();
      if (sound.current === audio) setPlaying(id);
    } catch {
      if (sound.current === audio) setError("Tap Play again to allow sound.");
    }
  }
  async function use() {
    if (!current || busy) return;
    setBusy(true);
    setError("");
    try {
      await mutate("/voice/select", { voice_id: current.id, speed, emotion });
      if (!active.current) return;
      sound.current?.pause();
      sound.current = null;
      onDone();
    } catch (e) {
      if (active.current) setError(fail(e));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className={styles.page}>
      <PageHeader
        title="Choose a voice"
        description="Listen first, then choose the voice Dad hears."
        back="/voice/samples"
        eyebrow="Voice library"
      />
      {query.isPending && <Notice>Loading voice library…</Notice>}
      {query.error && (
        <Notice tone="danger">
          {fail(query.error)}{" "}
          <Button variant="quiet" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </Notice>
      )}
      {query.isSuccess && !presets.length && (
        <Notice>
          No voices are available yet. Try loading the library again.
        </Notice>
      )}
      {query.isSuccess &&
        state?.voice.voice_id &&
        !presets.some((preset) => preset.id === state.voice.voice_id) && (
          <p className="caption muted">
            Your current voice is not in this library. Pick a voice to replace
            it.
          </p>
        )}
      <Card>
        {presets.map((preset) => (
          <div className={styles.preset} key={preset.id}>
            <label>
              <input
                type="radio"
                name="voice"
                checked={current?.id === preset.id}
                disabled={busy}
                onChange={() => setSelected(preset.id)}
              />
              <span>
                <strong>{preset.name.replace(" (current)", "")}</strong>
                <small className="caption muted">
                  English
                  {preset.id === state?.voice.voice_id
                    ? " · Current voice"
                    : ""}
                </small>
              </span>
            </label>
            <Button
              variant="quiet"
              disabled={busy}
              aria-label={`${playing === preset.id ? "Pause" : "Play"} ${preset.name.replace(" (current)", "")}`}
              onClick={() => void play(preset.id)}
            >
              {playing === preset.id ? "Pause" : "Play"}
            </Button>
          </div>
        ))}
      </Card>
      <Card>
        <p className="caption muted">Preview style</p>
        <div className={styles.segments}>
          {["natural", "warm"].map((value) => (
            <button
              key={value}
              aria-pressed={variant === value}
              disabled={busy}
              onClick={() => {
                setVariant(value);
                sound.current?.pause();
                sound.current = null;
                setPlaying("");
              }}
            >
              {value === "natural" ? "Natural" : "Warm"}
            </button>
          ))}
        </div>
        <label className={styles.slider}>
          Speed · {Number(speed.toFixed(2))}×
          <input
            type="range"
            min="0.6"
            max="1.5"
            step="0.05"
            disabled={busy}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          />
        </label>
        <label className={styles.select}>
          Emotion
          <select
            disabled={busy}
            value={emotion}
            onChange={(e) => setEmotion(e.target.value)}
          >
            <option value="neutral">Neutral</option>
            <option value="calm">Calm</option>
            <option value="content">Content</option>
            <option value="happy">Warm</option>
          </select>
        </label>
        <p className="caption muted">
          Library previews are prerecorded. Speed and emotion apply to new
          speech after you choose Use.
        </p>
      </Card>
      {preview && <Badge tone="info">Preview · No generated audio</Badge>}
      {error && <Notice tone="danger">{error}</Notice>}
      {note && <Notice>{note}</Notice>}
      <div className="actions">
        <Button disabled={busy || !current} onClick={() => void use()}>
          {busy
            ? "Selecting…"
            : `Use ${current?.name.replace(" (current)", "") || "selected voice"}`}
        </Button>
      </div>
    </div>
  );
}
function formatTime(value: number) {
  const seconds = Math.round(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
async function waveform(blob: Blob): Promise<number[]> {
  let ctx: AudioContext | undefined;
  try {
    ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const values = decoded.getChannelData(0);
    const chunk = Math.max(1, Math.floor(values.length / 42));
    const levels = Array.from({ length: 42 }, (_, i) => {
      let peak = 0;
      for (let j = i * chunk; j < Math.min((i + 1) * chunk, values.length); j++)
        peak = Math.max(peak, Math.abs(values[j]));
      return peak;
    });
    const max = Math.max(0.001, ...levels);
    return levels.map((v) => v / max);
  } catch {
    return Array.from({ length: 42 }, () => 0.12);
  } finally {
    await ctx?.close();
  }
}
