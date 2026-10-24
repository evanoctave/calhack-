import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { api } from "../../data/api";
import type { Household, NearbyStatus, TreeMember } from "../../data/types";
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
  Sheet,
} from "../../components/ui";
import MapView from "../../components/MapView";
import cameraIcon from "./assets/camera.svg";
import styles from "./SetupPage.module.css";

const STEPS = ["profile", "voice", "contacts", "places", "camera", "sound"];
const DESCRIPTION_FIELDS = [
  ["sex", "Sex"],
  ["height", "Height"],
  ["weight", "Weight"],
  ["hair", "Hair"],
  ["eyes", "Eyes"],
  ["build", "Build"],
  ["marks", "Distinguishing marks, glasses or gait"],
] as const;
const err = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong. Please try again.";
const initialCaps = (name: string) =>
  name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("");

export function SetupPage() {
  const { step = "profile" } = useParams();
  const { state, loading, error } = useNightfall();
  if (step === "voice") return <Navigate to="/voice/samples" replace />;
  if (!state)
    return (
      <Notice tone={error ? "danger" : "info"}>
        {error ||
          (loading
            ? "Loading your care setup…"
            : "Your care setup is unavailable.")}
      </Notice>
    );
  const page = {
    profile: <ProfileStep household={state.household} />,
    contacts: <ContactsStep />,
    places: <PlacesStep />,
    nearby: <NearbyStep />,
    camera: <CameraStep />,
    sound: <SoundStep />,
    ready: <ReadyStep />,
  }[step];
  if (!page) return <Navigate to="/setup/profile" replace />;
  return (
    <div className={styles.setup} data-figma-page="detailed-archive">
      {STEPS.includes(step) && (
        <Progress step={STEPS.indexOf(step) + 1} total={6} />
      )}
      {page}
    </div>
  );
}

function ProfileStep({ household }: { household: Household }) {
  const { preview, mutate } = useNightfall();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [searchDetailsOpen, setSearchDetailsOpen] = useState(false);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    person_full_name: household.person_full_name,
    person_name: household.person_name,
    person_age: household.person_age,
    caregiver_name: household.caregiver_name,
    description: { ...household.description },
    diagnosis: household.diagnosis || "",
    doctor: { ...household.doctor },
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const clean = {
      ...draft,
      person_full_name: draft.person_full_name.trim(),
      person_name: draft.person_name.trim(),
      caregiver_name: draft.caregiver_name.trim(),
      description: Object.fromEntries(
        Object.entries(draft.description).map(([key, value]) => [
          key,
          value.trim(),
        ]),
      ),
      diagnosis: draft.diagnosis.trim(),
      doctor: Object.fromEntries(
        Object.entries(draft.doctor).map(([key, value]) => [key, value.trim()]),
      ),
    };
    if (
      !clean.person_full_name ||
      !clean.person_name ||
      !clean.caregiver_name
    ) {
      setError("Enter a name in each field.");
      setBusy(false);
      return;
    }
    try {
      await mutate("/profile", clean);
      setEditing(false);
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="Who are we caring for?"
        description={`Start with ${household.person_name}’s details and your relationship.`}
        back="/care"
      />
      <Card>
        <p className="caption muted">Person you care for</p>
        <div className={styles.identity}>
          <button
            className={styles.photoButton}
            onClick={() => setUnsupported("Photo")}
            aria-label={`Add ${household.person_name}’s photo`}
          >
            {household.photo ? (
              <img
                className={`${styles.portrait} ${household.photo.includes("camera-demo.png") ? styles.portraitDemo : ""}`}
                src={household.photo}
                alt={household.person_full_name}
              />
            ) : (
              <>
                <img src={cameraIcon} alt="" width="24" height="24" />
                <span>Add photo</span>
              </>
            )}
          </button>
          <button
            className={styles.identityEdit}
            onClick={() => setEditing(true)}
          >
            <strong>
              {household.person_name} ({household.person_full_name})
            </strong>
            <span className="caption muted">
              {household.person_age} years old
            </span>
            <span className={styles.editLabel}>Edit details</span>
          </button>
        </div>
        <p className={`${styles.dividerNote} caption muted`}>
          Use a clear, recent photo to help your family recognize them.
        </p>
      </Card>
      <Card>
        <Row
          title="Your information"
          detail={`${household.caregiver_name} · Primary caregiver`}
          trailing="Edit"
          onClick={() => setEditing(true)}
        />
        <Row
          title="Search & medical details"
          detail="Physical description, diagnosis and doctor"
          trailing="Edit"
          onClick={() => {
            setSearchDetailsOpen(true);
            setEditing(true);
          }}
        />
      </Card>
      <Card>
        <div className="inline spread">
          <h2>Medications</h2>
          <Button
            className={styles.inlineButton}
            variant="quiet"
            onClick={() => setUnsupported("Medications")}
          >
            {preview ? "Edit" : "Details"}
          </Button>
        </div>
        {household.medications.length ? (
          household.medications.map((m, i) => (
            <Row
              key={`${m.name}-${i}`}
              title={m.name}
              detail={m.note}
              trailing={m.dose}
            />
          ))
        ) : (
          <p className="caption muted">No medications added.</p>
        )}
      </Card>
      <div className="actions">
        <Button onClick={() => navigate("/voice/samples")}>Continue</Button>
      </div>
      {editing && (
        <Sheet title="Care details" onClose={() => setEditing(false)}>
          <form className="stack" onSubmit={save}>
            <Field
              label="Full name"
              required
              maxLength={80}
              value={draft.person_full_name}
              onChange={(e) =>
                setDraft({ ...draft, person_full_name: e.target.value })
              }
            />
            <Field
              label="Name used at the door"
              required
              maxLength={40}
              value={draft.person_name}
              onChange={(e) =>
                setDraft({ ...draft, person_name: e.target.value })
              }
            />
            <Field
              label="Age"
              type="number"
              min={0}
              max={120}
              required
              value={draft.person_age}
              onChange={(e) =>
                setDraft({ ...draft, person_age: Number(e.target.value) })
              }
            />
            <Field
              label="Your name"
              required
              maxLength={80}
              value={draft.caregiver_name}
              onChange={(e) =>
                setDraft({ ...draft, caregiver_name: e.target.value })
              }
            />
            <details
              className={styles.optionalDetails}
              open={searchDetailsOpen}
              onToggle={(e) => setSearchDetailsOpen(e.currentTarget.open)}
            >
              <summary>Search & medical details</summary>
              <div className="stack">
                <p className="caption muted">
                  Optional details your family can share when asking for help.
                </p>
                <div className={styles.descriptionFields}>
                  {DESCRIPTION_FIELDS.map(([key, label]) => (
                    <Field
                      key={key}
                      label={label}
                      maxLength={key === "marks" ? 240 : 80}
                      value={draft.description[key] || ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          description: {
                            ...draft.description,
                            [key]: e.target.value,
                          },
                        })
                      }
                    />
                  ))}
                </div>
                <Field
                  label="Diagnosis"
                  maxLength={300}
                  value={draft.diagnosis}
                  onChange={(e) =>
                    setDraft({ ...draft, diagnosis: e.target.value })
                  }
                />
                <Field
                  label="Doctor or clinic"
                  maxLength={120}
                  value={draft.doctor.name || ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      doctor: { ...draft.doctor, name: e.target.value },
                    })
                  }
                />
                <Field
                  label="Doctor’s phone"
                  type="tel"
                  maxLength={40}
                  value={draft.doctor.phone || ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      doctor: { ...draft.doctor, phone: e.target.value },
                    })
                  }
                />
              </div>
            </details>
            {error && <Notice tone="danger">{error}</Notice>}
            {preview && (
              <p className="caption muted">
                Changes apply only to this preview session.
              </p>
            )}
            <Button disabled={busy} type="submit">
              {busy ? "Saving…" : preview ? "Update preview" : "Save details"}
            </Button>
          </form>
        </Sheet>
      )}
      {unsupported && (
        <DraftSheet
          kind={unsupported}
          household={household}
          onClose={() => setUnsupported(null)}
        />
      )}
    </>
  );
}

function DraftSheet({
  kind,
  household,
  onClose,
}: {
  kind: string;
  household: Household;
  onClose: () => void;
}) {
  const { preview, mutate } = useNightfall();
  const [value, setValue] = useState(
    kind === "Medications"
      ? household.medications
          .map((m) => `${m.name} | ${m.dose} | ${m.note || ""}`)
          .join("\n")
      : household.familiar_places
          .map((p) => `${p.name} | ${p.note || ""}`)
          .join("\n"),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (kind === "Photo") {
        onClose();
        return;
      }
      const body =
        kind === "Medications"
          ? {
              medications: value
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                  const [name = "", dose = "", note = ""] = line
                    .split("|")
                    .map((s) => s.trim());
                  return { name, dose, note };
                }),
            }
          : {
              familiar_places: value
                .split("\n")
                .filter(Boolean)
                .map((line, i) => {
                  const [name = "", note = ""] = line
                    .split("|")
                    .map((s) => s.trim());
                  return {
                    name,
                    note,
                    lat:
                      household.familiar_places[i]?.lat || household.home.lat,
                    lng:
                      household.familiar_places[i]?.lng || household.home.lng,
                  };
                }),
            };
      await mutate("/preview/profile", body);
      onClose();
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title={kind} onClose={onClose}>
      {!preview ? (
        <Notice>
          Editing isn’t available yet. Your existing {kind.toLowerCase()} can
          still be used in the brief.
        </Notice>
      ) : (
        <form className="stack" onSubmit={save}>
          <Notice>Preview changes stay in this browser session.</Notice>
          {kind === "Photo" ? (
            <PhotoDraft />
          ) : (
            <label className={styles.textField}>
              <span>
                {kind === "Medications"
                  ? "One medication per line: name | dose | note"
                  : "One place per line: name | note"}
              </span>
              <textarea
                rows={5}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
          )}
          {error && <Notice tone="danger">{error}</Notice>}
          {kind !== "Photo" && (
            <Button type="submit" disabled={busy}>
              {busy ? "Updating…" : "Update preview"}
            </Button>
          )}
        </form>
      )}
    </Sheet>
  );
}
function PhotoDraft() {
  const { mutate } = useNightfall();
  const [error, setError] = useState("");
  return (
    <>
      <Field
        label="Choose a photo"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (file.size > 4 * 1024 * 1024) {
            setError("Choose a photo smaller than 4 MB.");
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            void mutate("/preview/profile", { photo: reader.result }).catch(
              (e) => setError(err(e)),
            );
          };
          reader.onerror = () => setError("This photo could not be read.");
          reader.readAsDataURL(file);
        }}
      />
      {error && <Notice tone="danger">{error}</Notice>}
    </>
  );
}

function ContactsStep() {
  const { state, preview, mutate } = useNightfall();
  const navigate = useNavigate();
  const [invite, setInvite] = useState(false);
  const [error, setError] = useState("");
  const members = [...(state?.household.tree || [])].sort(
    (a, b) => a.tier - b.tier,
  );
  async function move(index: number, offset: number) {
    const next = [...members];
    const item = next.splice(index, 1)[0];
    next.splice(index + offset, 0, item);
    try {
      await mutate("/preview/profile", {
        tree: next.map((member, i) => ({
          ...member,
          tier: Math.min(i + 1, 3),
        })),
      });
    } catch (e) {
      setError(err(e));
    }
  }
  return (
    <>
      <PageHeader
        title="Who should we call?"
        description="Choose who hears from Nightfall first."
        back="/voice/samples"
      />
      <Card>
        {members.map((member, i) => (
          <div key={member.id} className={styles.contact}>
            <span className={styles.number}>{member.tier}</span>
            <div className={styles.contactName}>
              <strong>{member.name}</strong>
              <span className="caption muted">
                {member.tier === 1
                  ? "Call first"
                  : member.tier === 2
                    ? "Next if no answer"
                    : "Third contact"}
              </span>
            </div>
            {preview && (
              <div className={styles.move}>
                <button
                  aria-label={`Move ${member.name} up`}
                  disabled={i === 0}
                  onClick={() => void move(i, -1)}
                >
                  ↑
                </button>
                <button
                  aria-label={`Move ${member.name} down`}
                  disabled={i === members.length - 1}
                  onClick={() => void move(i, 1)}
                >
                  ↓
                </button>
              </div>
            )}
          </div>
        ))}
      </Card>
      <Button variant="secondary" onClick={() => setInvite(true)}>
        Invite a family member
      </Button>
      <p className="caption muted">
        No answer after {state?.ladder_step_s || 60} seconds? Nightfall calls
        the next priority group.
      </p>
      {!preview && (
        <p className="caption muted">
          Editing, deleting and reordering contacts isn’t available yet. New
          contacts join this server session.
        </p>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="actions">
        <Button onClick={() => navigate("/setup/places")}>Continue</Button>
      </div>
      {invite && <InvitationSheet onClose={() => setInvite(false)} />}
    </>
  );
}
function InvitationSheet({ onClose }: { onClose: () => void }) {
  const { preview, mutate } = useNightfall();
  const [qr, setQr] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [tier, setTier] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const url = `${window.location.origin}/ui/index.html${preview ? "?preview=1" : ""}#/join`;
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(url, { width: 216, margin: 2, errorCorrectionLevel: "M" })
      .then((data) => {
        if (active) setQr(data);
      })
      .catch(() =>
        setError("The QR code could not be created. Share the link instead."),
      );
    return () => {
      active = false;
    };
  }, [url]);
  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Enter the contact’s name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await mutate<{ existing?: boolean }>("/tree", {
        name: name.trim(),
        phone: phone.trim() || "web",
        tier,
      });
      setMessage(
        r.existing
          ? `${name} is already in the care circle.`
          : `${name} was added ${preview ? "to this preview" : "for this server session"}.`,
      );
      setName("");
      setPhone("");
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="Invite a family member" onClose={onClose}>
      <div className="stack">
        <div className={styles.qr}>
          {qr && (
            <img
              src={qr}
              alt="Scan to open the care circle invitation"
              width={216}
              height={216}
            />
          )}
          {preview && <Badge tone="info">Example · Preview</Badge>}
        </div>
        <p className="caption muted">
          Scan to join the care circle on another phone.
        </p>
        {/localhost|127\.0\.0\.1/.test(window.location.hostname) && (
          <Notice tone="warning">
            This local address works only on this computer. Open Nightfall’s
            shared HTTPS address before sharing the QR code.
          </Notice>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            if (!navigator.clipboard) {
              setError("Copy is unavailable. Use the link below.");
              return;
            }
            navigator.clipboard
              .writeText(url)
              .then(() => setMessage("Invitation link copied."))
              .catch(() =>
                setError("Copy is unavailable. Use the link below."),
              );
          }}
        >
          Copy invitation link
        </Button>
        <a className={styles.url} href={url}>
          {url}
        </a>
        <form className="stack" onSubmit={add}>
          <h2>Or add a contact</h2>
          <Field
            label="Name"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Field
            label="Phone (optional)"
            type="tel"
            placeholder="+1… or leave empty for web"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <label className={styles.textField}>
            Call priority
            <select
              value={tier}
              onChange={(e) => setTier(Number(e.target.value))}
            >
              <option value={1}>1 · First</option>
              <option value={2}>2 · Next</option>
              <option value={3}>3 · Third</option>
            </select>
          </label>
          <Button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add contact"}
          </Button>
        </form>
        {message && <Notice tone="success">{message}</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Sheet>
  );
}

function PlacesStep() {
  const { state, preview, mutate } = useNightfall();
  const navigate = useNavigate();
  const hh = state!.household;
  const [address, setAddress] = useState(hh.address);
  const [radius, setRadius] = useState(hh.radius_mi);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState(false);
  async function search(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await mutate("/setup/address", {
        address: address.trim(),
        radius_mi: radius,
        google: true,
      });
      navigate("/setup/nearby");
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="Home & familiar places"
        description="Help your family know where to look."
        back="/setup/contacts"
      />
      <form className="stack" onSubmit={search}>
        <Card>
          <Field
            label="Home address"
            required
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            autoComplete="street-address"
          />
        </Card>
        <Card>
          <div className="inline spread">
            <h2>Familiar places</h2>
            <Button
              className={styles.inlineButton}
              variant="quiet"
              onClick={() => setEdit(true)}
              type="button"
            >
              {preview ? "Edit" : "Details"}
            </Button>
          </div>
          {hh.familiar_places.map((place, i) => (
            <Row
              key={`${place.name}-${i}`}
              title={place.name}
              detail={place.note || "A familiar place"}
            />
          ))}
          {!hh.familiar_places.length && (
            <p className="caption muted">No familiar places added.</p>
          )}
        </Card>
        <Card>
          <Field
            label="Search radius (mi)"
            type="number"
            min={0.3}
            max={5}
            step={0.1}
            required
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
          />
          <p className="caption muted">
            Nearby water, roads, and places open at night are included in the
            search brief.
          </p>
          {!preview && (
            <p className="caption muted">
              Your home address and search radius are saved when you find nearby
              places.
            </p>
          )}
        </Card>
        <p className="caption muted">
          Nearby business data · Apify
          <br />
          Hazards · OpenStreetMap
        </p>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="actions">
          <Button disabled={busy} type="submit">
            {busy ? "Finding nearby places…" : "Find nearby places"}
          </Button>
        </div>
      </form>
      {edit && (
        <DraftSheet
          kind="Familiar places"
          household={hh}
          onClose={() => setEdit(false)}
        />
      )}
    </>
  );
}
function NearbyStep() {
  const { preview } = useNightfall();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ["nearby", preview],
    queryFn: ({ signal }) => api.get<NearbyStatus>("/setup/status", { signal }),
    refetchInterval: (query) =>
      query.state.data?.apify === "running" ? 3000 : false,
  });
  const data = query.data;
  return (
    <>
      <PageHeader
        title="Know the area first"
        description={
          data
            ? `${data.address || "Home"} · ${data.home.radius_mi} mi around home`
            : "Finding the places that matter."
        }
        back="/setup/places"
        eyebrow="Home and places"
      />
      {query.isPending && <Notice>Finding nearby places…</Notice>}
      {query.error && (
        <Notice tone="danger">
          {err(query.error)}{" "}
          <Button variant="quiet" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </Notice>
      )}
      {data && (
        <>
          <MapView
            home={data.home}
            hazards={data.hazards_ranked}
            callFirst={data.call_first}
            familiar={data.familiar}
            preview={preview}
          />
          <Card>
            <Row
              title="Places to check first"
              detail="Waterfront and nearby hazards"
              trailing={String(data.hazards_ranked.length)}
            />
            <Row
              title="Places to call"
              detail="Open late or open now"
              trailing={String(data.call_first.length)}
            />
          </Card>
          {data.apify === "running" && (
            <Notice>
              Business search is still running. Nearby hazards are ready; more
              results will appear here.
            </Notice>
          )}
          {["failed", "no token", "cancelled"].includes(data.apify) && (
            <Notice tone="warning">
              Nearby business search is unavailable. Showing the places already
              available. {data.error}
            </Notice>
          )}
          <p className="caption muted">
            Familiar places stay separate from nearby risks. This map is a
            search reference, not a live location.
          </p>
          <p className="caption muted">
            Nearby business data · Apify
            <br />
            Source: {data.places_source}
          </p>
        </>
      )}
      <div className="actions">
        <Button onClick={() => navigate("/setup/camera")} disabled={!data}>
          Use these nearby places
        </Button>
      </div>
    </>
  );
}

interface EnrollmentRequest {
  name: string;
  label: string;
  startedAt: number;
  alreadyRegistered: boolean;
}

function CameraStep() {
  const { state, preview, memberId, mutate, lastEvent } = useNightfall();
  const navigate = useNavigate();
  const [edge, setEdge] = useState("far");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [faceName, setFaceName] = useState("");
  const [showOther, setShowOther] = useState(false);
  const [frame, setFrame] = useState(`/cam/latest.jpg?t=${Date.now()}`);
  const [frameError, setFrameError] = useState(false);
  const [pendingEnrollment, setPendingEnrollment] =
    useState<EnrollmentRequest | null>(null);
  const [retryEnrollment, setRetryEnrollment] =
    useState<EnrollmentRequest | null>(null);
  const submittedEvent = useRef(lastEvent);
  const commandVersion = useRef(0);
  const faces = useQuery({
    queryKey: ["faces", preview],
    queryFn: () =>
      api.get<{ faces: Array<{ name: string; label: string }> }>("/enroll"),
    refetchInterval: pendingEnrollment && !preview ? 5000 : false,
  });
  useEffect(() => {
    if (preview) return;
    const id = setInterval(() => {
      setFrame(`/cam/latest.jpg?t=${Date.now()}`);
    }, 2500);
    return () => clearInterval(id);
  }, [preview]);
  useEffect(() => {
    if (
      !pendingEnrollment ||
      lastEvent === submittedEvent.current ||
      lastEvent?.type !== "door"
    )
      return;
    if (
      lastEvent.name !== pendingEnrollment.name ||
      lastEvent.label !== pendingEnrollment.label
    )
      return;
    if (lastEvent.event === "enroll_success") {
      commandVersion.current += 1;
      setBusy(false);
      setMessage(`${pendingEnrollment.name}’s face is registered.`);
      setError("");
      setRetryEnrollment(null);
      setPendingEnrollment(null);
      void faces.refetch();
    } else if (lastEvent.event === "enroll_error") {
      commandVersion.current += 1;
      setBusy(false);
      setError(
        String(
          lastEvent.detail ||
            "Registration did not finish. Face the camera and try again.",
        ),
      );
      setMessage("");
      setRetryEnrollment(pendingEnrollment);
      setPendingEnrollment(null);
    }
  }, [lastEvent, pendingEnrollment]);
  useEffect(() => {
    // A pre-existing face is not evidence that a new registration succeeded.
    if (!pendingEnrollment || pendingEnrollment.alreadyRegistered) return;
    if (
      faces.data?.faces.some(
        (face) =>
          face.name === pendingEnrollment.name &&
          face.label === pendingEnrollment.label,
      )
    ) {
      commandVersion.current += 1;
      setBusy(false);
      setMessage(`${pendingEnrollment.name}’s face is registered.`);
      setError("");
      setRetryEnrollment(null);
      setPendingEnrollment(null);
    }
  }, [faces.data, pendingEnrollment]);
  useEffect(() => {
    if (!pendingEnrollment) return;
    const timer = setTimeout(
      () => {
        commandVersion.current += 1;
        setBusy(false);
        setMessage("");
        setError(
          "No registration confirmation yet. Check that the door screen is open and the person is facing the camera, then try again.",
        );
        setRetryEnrollment(pendingEnrollment);
        setPendingEnrollment(null);
      },
      Math.max(0, pendingEnrollment.startedAt + 20_000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [pendingEnrollment]);
  async function command(body: Record<string, string>) {
    if (pendingEnrollment || busy) return;
    const version = ++commandVersion.current;
    const enrollment =
      body.cmd === "enroll"
        ? {
            name: body.name.trim(),
            label: body.label,
            startedAt: Date.now(),
            alreadyRegistered:
              !faces.data ||
              Boolean(
                faces.data.faces.some(
                  (face) =>
                    face.name === body.name.trim() && face.label === body.label,
                ),
              ),
          }
        : null;
    if (enrollment && !enrollment.name) {
      setError("Enter a name before registering a face.");
      return;
    }
    setBusy(true);
    setError("");
    setRetryEnrollment(null);
    submittedEvent.current = lastEvent;
    if (enrollment && !preview) setPendingEnrollment(enrollment);
    setMessage(
      preview
        ? "Preview only — no command was sent to a camera."
        : enrollment
          ? `Waiting for the door camera to register ${enrollment.name}…`
          : "Door edge request sent. Check the door screen to confirm the change.",
    );
    try {
      await mutate("/door/command", { ...body, member_id: memberId });
    } catch (e) {
      if (version !== commandVersion.current) return;
      setError(err(e));
      setMessage("");
      setPendingEnrollment(null);
      if (enrollment) setRetryEnrollment(enrollment);
    } finally {
      if (version === commandVersion.current) setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="Set up the door camera"
        description="Keep the computer facing the entrance."
        back="/setup/nearby"
        eyebrow="Device setup"
      />
      <div className={styles.camera}>
        {preview ? (
          <img
            className={styles.cameraPreview}
            src="/ui/assets/camera-demo.png"
            alt="Recorded demo capture of a person in the camera"
          />
        ) : (
          <>
            <img
              src={frame}
              alt="Latest door camera frame"
              onLoad={() => setFrameError(false)}
              onError={() => setFrameError(true)}
              hidden={frameError}
            />
            {frameError && (
              <div className={styles.cameraMissing}>
                No live frame yet.
                <br />
                Open the door screen on the computer and tap Start.
              </div>
            )}
          </>
        )}
      </div>
      <p className="caption muted">
        {preview
          ? "Recorded demo capture"
          : state?.live_frame
            ? "Recent frame from the door camera"
            : "Waiting for the door camera"}
      </p>
      <Card>
        <h2>Which edge leads outside?</h2>
        <div className={styles.segments}>
          {["far", "left", "right", "top"].map((value) => (
            <button
              key={value}
              aria-pressed={edge === value}
              disabled={busy || Boolean(pendingEnrollment)}
              onClick={() => {
                setEdge(value);
                void command({ cmd: "door_edge", edge: value });
              }}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      </Card>
      <Card>
        <Row
          title={state!.household.person_full_name}
          detail="Person we are watching"
          trailing={
            faces.data?.faces.some(
              (f) =>
                f.label === "person" &&
                f.name.toLowerCase() ===
                  state!.household.person_full_name.toLowerCase(),
            )
              ? "Registered"
              : "Not registered"
          }
        />
        <p className="caption muted">
          Ask them to face the door camera. Registration runs on the computer
          after you send the request.
        </p>
        <Button
          variant="secondary"
          disabled={busy || Boolean(pendingEnrollment)}
          onClick={() =>
            void command({
              cmd: "enroll",
              label: "person",
              name: state!.household.person_full_name,
            })
          }
        >
          Register {state!.household.person_name}’s face
        </Button>
        <Button
          variant="quiet"
          disabled={busy || Boolean(pendingEnrollment)}
          onClick={() => setShowOther(true)}
        >
          Register another household member
        </Button>
      </Card>
      {faces.error && (
        <Notice tone="warning">Face registrations could not be checked.</Notice>
      )}
      {message && <Notice>{message}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      {retryEnrollment && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void command({
              cmd: "enroll",
              name: retryEnrollment.name,
              label: retryEnrollment.label,
            })
          }
        >
          Try registration again
        </Button>
      )}
      <div className="actions">
        <Button onClick={() => navigate("/setup/sound")}>Continue</Button>
      </div>
      {showOther && (
        <Sheet title="Household member" onClose={() => setShowOther(false)}>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void command({
                cmd: "enroll",
                label: "other",
                name: faceName.trim(),
              });
              setShowOther(false);
            }}
          >
            <Field
              label="Name"
              required
              value={faceName}
              onChange={(e) => setFaceName(e.target.value)}
            />
            <p className="caption muted">
              Have this person face the door camera.
            </p>
            <Button type="submit" disabled={busy}>
              Send registration request
            </Button>
          </form>
        </Sheet>
      )}
    </>
  );
}
function SoundStep() {
  const { state, memberId, soundEnabled, enableSound } = useNightfall();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const member = state?.household.tree.find((m) => m.id === memberId);
  return (
    <>
      <PageHeader
        title="Let this phone ring"
        description="Tap once to enable Nightfall’s alert sound."
        back="/setup/camera"
        eyebrow="Last step"
      />
      <Card>
        <div className={styles.soundIcon} aria-hidden="true">
          ♪
        </div>
        <h2>
          {member?.name || "This phone"}
          {member ? ` · Priority ${member.tier}` : ""}
        </h2>
        <p>
          When {state?.household.person_name || "Dad"} leaves and does not
          return, Nightfall calls the care circle.
        </p>
        <p className={`${styles.dividerNote} caption muted`}>
          Keep this page open and your volume on. This enables sound in the open
          web app; it does not enable iPhone lock-screen push notifications.
        </p>
      </Card>
      {soundEnabled && (
        <Notice tone="success">Sound is enabled on this page.</Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="actions">
        <Button
          onClick={() => {
            void enableSound()
              .then(() => navigate("/setup/ready"))
              .catch((e) => setError(err(e)));
          }}
        >
          Enable sound and finish
        </Button>
        <Button variant="quiet" onClick={() => navigate("/setup/ready")}>
          Continue without sound
        </Button>
      </div>
    </>
  );
}
function ReadyStep() {
  const { state, soundEnabled } = useNightfall();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="Your care circle is ready"
        description="You can change your care setup any time."
        eyebrow="Setup complete"
      />
      <Card>
        <Row
          title="Care details"
          detail={state!.household.person_full_name}
          trailing="✓"
        />
        <Row
          title="Family voice"
          detail={
            state!.voice.mock
              ? "Demo voice mode"
              : state!.voice.voice_id
                ? "Selected voice"
                : "No voice selected"
          }
        />
        <Row
          title="Call order"
          detail={state!.household.tree
            .map((m) => `${m.tier} ${m.name}`)
            .join(" → ")}
        />
        <Row
          title="Phone sound"
          detail={
            soundEnabled ? "Enabled while this page is open" : "Not enabled"
          }
        />
      </Card>
      <div className="actions">
        <Button onClick={() => navigate("/home")}>Go to Night watch</Button>
      </div>
    </>
  );
}

export function JoinPage() {
  const { state, mutate, setMember, preview, enableSound, soundEnabled } =
    useNightfall();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function join(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Enter your name to join.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await mutate<{ member_id: string }>("/tree", {
        name: name.trim(),
        phone: "web",
        tier: 1,
      });
      setMember(result.member_id);
      setJoined(true);
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.setup}>
      <PageHeader
        title={
          joined
            ? "You’re in the care circle"
            : `Join ${state?.household.person_name || "Dad"}’s care circle`
        }
        description={
          joined
            ? "Keep this page open to receive the web demo call."
            : "You opened the family invitation link."
        }
        eyebrow="Family invitation"
      />
      {!joined ? (
        <form className="stack" onSubmit={join}>
          <Card>
            <Field
              label="Your name"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
            />
            <Row
              title="Call priority"
              detail="1 · First group to hear from Nightfall"
            />
          </Card>
          <p className="caption muted">
            New members join the first priority group. If your name is already
            in the circle, your existing priority stays the same.
          </p>
          {preview && (
            <Notice>
              Example invitation — this joins the isolated preview.
            </Notice>
          )}
          <div className="actions">
            <Button type="submit" disabled={busy}>
              {busy ? "Joining…" : "Join as #1"}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <Card>
            <div className={styles.soundIcon}>{initialCaps(name)}</div>
            <h2>{name}</h2>
            <p className="caption muted">
              Tap below once to allow the alert sound.
            </p>
          </Card>
          {soundEnabled && <Notice tone="success">Sound is enabled.</Notice>}
          <div className="actions">
            <Button
              onClick={() => {
                void enableSound()
                  .then(() => navigate("/home"))
                  .catch((e) => setError(err(e)));
              }}
            >
              Enable sound and open Night watch
            </Button>
            <Button variant="secondary" onClick={() => navigate("/home")}>
              Continue without sound
            </Button>
          </div>
        </>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

export function CarePage() {
  const { state, preview, memberId, setMember } = useNightfall();
  if (!state) return <Notice>Loading your care setup…</Notice>;
  return (
    <div className="stack">
      <PageHeader
        title="Your care circle"
        description="The familiar details that help Nightfall care."
        eyebrow="Care"
      />
      <Card>
        <Row
          title={state.household.person_full_name}
          detail={`${state.household.person_age} years old · ${state.household.caregiver_name}`}
          trailing="Edit"
          onClick={() => {
            window.location.hash = "/setup/profile";
          }}
        />
      </Card>
      <Card>
        <Link className={styles.linkRow} to="/voice/samples">
          <strong>Family AI voice</strong>
          <span>Samples, voice library and preview →</span>
        </Link>
        <Link className={styles.linkRow} to="/setup/contacts">
          <strong>Who gets called first</strong>
          <span>{state.household.tree.map((m) => m.name).join(" → ")}</span>
        </Link>
        <Link className={styles.linkRow} to="/setup/places">
          <strong>Home & nearby places</strong>
          <span>{state.household.address}</span>
        </Link>
        <Link className={styles.linkRow} to="/setup/camera">
          <strong>Door camera</strong>
          <span>Camera position and face registration →</span>
        </Link>
        <Link className={styles.linkRow} to="/setup/sound">
          <strong>This phone’s sound</strong>
          <span>Allow Nightfall to ring →</span>
        </Link>
      </Card>
      <Card>
        <label className={styles.textField}>
          Using this phone as
          <select value={memberId} onChange={(e) => setMember(e.target.value)}>
            {state.household.tree.map((m: TreeMember) => (
              <option value={m.id} key={m.id}>
                {m.name} · Priority {m.tier}
              </option>
            ))}
          </select>
        </label>
        <p className="caption muted">
          {preview
            ? "Switch preview family member."
            : "Demo identity selection. Use the invitation link on each family phone."}
        </p>
      </Card>
    </div>
  );
}
