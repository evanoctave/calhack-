import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Link,
  Navigate,
  useNavigate,
  useParams,
  useLocation,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { api } from "../../data/api";
import type { Household, TreeMember } from "../../data/types";
import { useNightfall } from "../../state/NightfallProvider";
import { useNearbySearch } from "../../state/useNearbySearch";
import { editSetupPath, returnDestination } from "../../state/setupFlow";
import { NearbySearchProgress } from "../../components/NearbySearchProgress";
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
  const location = useLocation();
  const editing = new URLSearchParams(location.search).get("mode") === "edit";
  if (step === "voice") return <Navigate to="/setup/voice" replace />;
  if (step === "ready") return <Navigate to="/setup/connect" replace />;
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
    profile: <ProfileStep household={state.household} editing={editing} />,
    contacts: <ContactsStep editing={editing} />,
    places: <PlacesStep />,
    nearby: <NearbyStep />,
    camera: <CameraStep />,
    sound: <SoundStep />,
  }[step];
  if (!page) return <Navigate to="/setup/profile" replace />;
  return (
    <div className={styles.setup} data-figma-page="detailed-archive">
      {step === "profile" && !editing && <Progress step={1} total={4} />}
      {step === "contacts" && !editing && <Progress step={2} total={4} />}
      {page}
    </div>
  );
}

function ProfileStep({
  household,
  editing,
}: {
  household: Household;
  editing: boolean;
}) {
  const { mutate } = useNightfall();
  const search = useNearbySearch();
  const navigate = useNavigate();
  const location = useLocation();
  const destination = returnDestination(location.search);
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
  const alive = useRef(true);
  const saving = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving.current) return;
    setError("");
    const clean = {
      ...draft,
      person_full_name: draft.person_full_name.trim(),
      person_name:
        draft.person_name.trim() || draft.person_full_name.trim().split(" ")[0],
      caregiver_name: draft.caregiver_name.trim(),
      description: Object.fromEntries(
        Object.entries(draft.description).map(([k, v]) => [k, v.trim()]),
      ),
      diagnosis: draft.diagnosis.trim(),
      doctor: Object.fromEntries(
        Object.entries(draft.doctor).map(([k, v]) => [k, v.trim()]),
      ),
    };
    const address = search.draft.address.trim();
    if (
      !clean.person_full_name ||
      !clean.person_name ||
      !clean.caregiver_name ||
      !address
    ) {
      setError(
        "Enter the care recipient’s name, your name and a home address.",
      );
      return;
    }
    if (
      !Number.isFinite(clean.person_age) ||
      clean.person_age < 0 ||
      clean.person_age > 120
    ) {
      setError("Enter an age between 0 and 120.");
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      const changes = Object.fromEntries(
        Object.entries(clean).filter(
          ([key, value]) =>
            JSON.stringify(value) !==
            JSON.stringify(household[key as keyof Household]),
        ),
      );
      // Address goes through the shared search once, never through /profile as well.
      if (Object.keys(changes).length) {
        const result = await mutate<{ ok: boolean }>("/profile", changes);
        if (!result?.ok)
          throw new Error(
            "Your care details were not confirmed saved. Please try again.",
          );
      }
      if (!alive.current) return;
      const sameRequest =
        search.input?.address.trim().toLowerCase() === address.toLowerCase() &&
        search.input?.radius_mi === search.draft.radius_mi;
      const sameSavedAddress =
        household.address.trim().toLowerCase() === address.toLowerCase() &&
        household.radius_mi === search.draft.radius_mi;
      // A name-only edit must not trigger a paid search. A failed status read also
      // cannot establish that the saved address needs a new search job.
      if (
        !search.busy &&
        !(editing && sameSavedAddress) &&
        !(search.phase === "error" && (sameRequest || sameSavedAddress))
      ) {
        search.start({ address, radius_mi: search.draft.radius_mi });
      }
      navigate(editing ? destination : "/setup/contacts");
    } catch (cause) {
      if (alive.current) setError(err(cause));
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="You & home"
        description="A few essentials. Everything else can wait."
        back={editing ? destination : "/home"}
      />
      <form className="stack" onSubmit={save}>
        <Card>
          <div className="stack">
            <Field
              label="Who do you care for?"
              required
              maxLength={80}
              value={draft.person_full_name}
              onChange={(e) =>
                setDraft({ ...draft, person_full_name: e.target.value })
              }
            />
            <button
              type="button"
              className={styles.profilePhoto}
              aria-label={
                household.photo ? "Photo: change photo" : "Photo: add photo"
              }
              onClick={() => setUnsupported("Photo")}
            >
              <span className={styles.profilePhotoHeading}>
                <strong>Photo</strong>
                <span>{household.photo ? "Change photo" : "Add photo"}</span>
              </span>
              <span className={styles.profilePhotoImage}>
                {household.photo ? (
                  <img src={household.photo} alt={household.person_full_name} />
                ) : (
                  <img
                    className={styles.profilePhotoPlaceholder}
                    src={cameraIcon}
                    width={36}
                    height={36}
                    alt=""
                  />
                )}
              </span>
            </button>
            <Field
              label="Your name"
              required
              maxLength={80}
              value={draft.caregiver_name}
              onChange={(e) =>
                setDraft({ ...draft, caregiver_name: e.target.value })
              }
            />
            <Field
              label="Home address"
              required
              maxLength={240}
              value={search.draft.address}
              disabled={search.busy}
              onChange={(e) =>
                search.setDraft({ ...search.draft, address: e.target.value })
              }
            />
          </div>
          <p className={`${styles.dividerNote} caption muted`}>
            Nearby places and hazards are found automatically from your home
            address.
          </p>
        </Card>
        <details className={styles.optionalDetails}>
          <summary>
            More care details <span className="caption muted">· Optional</span>
          </summary>
          <div className="stack">
            <Card>
              <div className="stack">
                <Field
                  label="Name used at the door"
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
                  value={draft.person_age}
                  onChange={(e) =>
                    setDraft({ ...draft, person_age: Number(e.target.value) })
                  }
                />
              </div>
            </Card>
            <details className={styles.optionalDetails}>
              <summary>Search & medical details</summary>
              <div className="stack">
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
            <Card>
              <h2>Medications</h2>
              {household.medications.map((m, i) => (
                <Row
                  key={`${m.name}-${i}`}
                  title={m.name}
                  detail={m.note}
                  trailing={m.dose}
                />
              ))}
              {!household.medications.length && (
                <p className="caption muted">No medications added.</p>
              )}
              <Button
                variant="quiet"
                onClick={() => setUnsupported("Medications")}
              >
                Medication details
              </Button>
            </Card>
          </div>
        </details>
        {search.busy && (
          <Notice>
            {search.phase === "locating"
              ? "Saving the home address…"
              : "Address saved. Preparing nearby places…"}
          </Notice>
        )}
        {search.error && (
          <Notice tone="warning">
            {search.error} You can continue; check Home & nearby places to
            retry.
          </Notice>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="actions">
          <Button
            type="submit"
            disabled={busy || (search.loading && !search.busy)}
          >
            {busy
              ? "Saving…"
              : search.loading && !search.busy
                ? "Checking saved places…"
                : editing
                  ? "Save changes"
                  : "Continue"}
          </Button>
        </div>
      </form>
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

function ContactsStep({ editing }: { editing: boolean }) {
  const destination = returnDestination(useLocation().search);
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
        description="Your family’s current call order. Add someone if needed."
        back={editing ? destination : "/setup/profile"}
      />
      <Card>
        {!members.length && (
          <p className="muted">
            Add a family member to receive Nightfall’s calls.
          </p>
        )}
        {members.map((member, i) => (
          <div key={member.id} className={styles.contact}>
            <span className={styles.number}>{member.tier}</span>
            <div className={styles.contactName}>
              <strong>{member.name}</strong>
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
        <Button
          disabled={!editing && !members.length}
          onClick={() => navigate(editing ? destination : "/setup/voice")}
        >
          {editing ? "Done" : "Next: Voice"}
        </Button>
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
  const destination = returnDestination(useLocation().search);
  const { state, preview } = useNightfall();
  const search = useNearbySearch();
  const navigate = useNavigate();
  const hh = state!.household;
  const { address, radius_mi: radius } = search.draft;
  const [edit, setEdit] = useState(false);
  function prepare(e: FormEvent) {
    e.preventDefault();
    search.start({ address: address.trim(), radius_mi: radius });
    navigate(editSetupPath("nearby", destination));
  }
  return (
    <>
      <PageHeader
        title="Home & familiar places"
        description="Prepare where to look, before your family needs it."
        back={destination}
      />
      <form className="stack" onSubmit={prepare}>
        <Card>
          <Field
            label="Home address"
            required
            value={address}
            onChange={(e) =>
              search.setDraft({ address: e.target.value, radius_mi: radius })
            }
            disabled={search.busy}
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
            onChange={(e) =>
              search.setDraft({ address, radius_mi: Number(e.target.value) })
            }
            disabled={search.busy}
          />
          <p className="caption muted">
            Nearby water, roads, and places open at night are included in the
            search brief.
          </p>
          {!preview && (
            <p className="caption muted">
              We’ll check this address and prepare nearby places. You can keep
              setting up while the search runs.
            </p>
          )}
        </Card>
        <p className="caption muted">
          Nearby business data · Apify
          <br />
          Hazards · OpenStreetMap
        </p>
        {search.saved && !search.busy && (
          <Notice tone="success">
            Saved results are available for this address and radius. Opening
            them does not start another search.
          </Notice>
        )}
        {search.error && !search.busy && (
          <Notice tone="warning">{search.error}</Notice>
        )}
        <div className="actions">
          <Button disabled={search.loading && !search.busy} type="submit">
            {search.busy
              ? "View search progress"
              : search.loading
                ? "Checking saved places…"
                : search.saved
                  ? "View saved places"
                  : "Prepare nearby places"}
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
  const destination = returnDestination(useLocation().search);
  const { preview, state } = useNightfall();
  const search = useNearbySearch();
  const navigate = useNavigate();
  const data = search.data;
  const showResults =
    data &&
    data.total > 0 &&
    (preview || ["apify", "overpass"].includes(data.places_source));
  const place = search.input || search.draft;
  return (
    <>
      <PageHeader
        title={
          search.busy ? "We’re preparing nearby places" : "Your search area"
        }
        description={`${place.address || state?.household.address || "Home"} · ${place.radius_mi} mi around home`}
        back={editSetupPath("places", destination)}
        eyebrow="Home and places"
      />
      {search.loading && !search.busy && (
        <Notice>Checking saved places…</Notice>
      )}
      {(search.phase === "locating" || search.phase === "searching") && (
        <NearbySearchProgress
          phase={search.phase}
          startedAt={search.startedAt}
        />
      )}
      {search.phase === "error" && (
        <Notice tone="danger">
          <p>
            {search.error ||
              "The search could not finish. Your address is still here."}
          </p>
          <p className="caption">
            Your entered address is kept. Check the status before starting
            another search.
          </p>
          <Button variant="quiet" onClick={search.reload}>
            Check status
          </Button>
          <Button variant="secondary" onClick={search.retry}>
            Try again
          </Button>
        </Notice>
      )}
      {!search.busy &&
        search.phase === "ready" &&
        !search.loading &&
        data?.total === 0 && (
          <Notice>
            No nearby places were returned for this search. You can change the
            address or radius and try again.
          </Notice>
        )}
      {!search.busy &&
        search.phase !== "error" &&
        search.phase !== "ready" &&
        !search.loading &&
        !showResults && (
          <Card>
            <h2>Prepare your nearby places</h2>
            <p className="caption muted">
              Find nearby risks and places your family can call. You can
              continue setup while we prepare them.
            </p>
            <Button onClick={() => search.start(search.draft)}>
              Start search
            </Button>
          </Card>
        )}
      {showResults && (
        <>
          <div className="inline spread">
            <Badge
              tone={
                search.busy || search.phase === "error" ? "neutral" : "success"
              }
            >
              {preview
                ? "Preview · Sample places"
                : search.busy || search.phase === "error"
                  ? "Previously available places"
                  : search.completedAt
                    ? "Search complete"
                    : "Saved results"}
            </Badge>
            {!search.busy && (
              <Button
                variant="quiet"
                className={styles.inlineButton}
                onClick={() => search.start(place, { force: true })}
                disabled={search.loading}
              >
                Refresh
              </Button>
            )}
          </div>
          {(search.busy || search.phase === "error") && (
            <p className="caption muted">
              These places are from the previous result. They have not been
              updated by this search.
            </p>
          )}
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
          <p className="caption muted">
            Familiar places stay separate from nearby risks. This map is a
            search reference, not a live location.
          </p>
          <p className="caption muted">
            Nearby businesses · Apify
            <br />
            Nearby risks · OpenStreetMap
          </p>
        </>
      )}
      <div className="actions">
        <Button onClick={() => navigate(destination)}>Done</Button>
        <Button variant="quiet" onClick={() => navigate("/home")}>
          Go to Home
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
  const destination = returnDestination(useLocation().search);
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
        back={destination}
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
        <Button onClick={() => navigate(destination)}>Done</Button>
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
  const destination = returnDestination(useLocation().search);
  const { state, memberId, soundEnabled, testSound } = useNightfall();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const member = state?.household.tree.find((m) => m.id === memberId);
  return (
    <>
      <PageHeader
        title="Let this phone ring"
        description="Tap once to enable Nightfall’s alert sound."
        back={destination}
        eyebrow="This phone"
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
            void testSound().catch((e) => setError(err(e)));
          }}
        >
          Test phone sound
        </Button>
        <Button variant="quiet" onClick={() => navigate(destination)}>
          Done
        </Button>
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
            window.location.hash = editSetupPath("profile");
          }}
        />
      </Card>
      <Card>
        <Link className={styles.linkRow} to="/voice?returnTo=/care">
          <strong>Voice at the door</strong>
          <span>Your selected voice, recordings and previews →</span>
        </Link>
        <Link className={styles.linkRow} to={editSetupPath("contacts")}>
          <strong>Who gets called first</strong>
        </Link>
        <Link className={styles.linkRow} to={editSetupPath("places")}>
          <strong>Home & nearby places</strong>
          <span>{state.household.address}</span>
        </Link>
        <Link className={styles.linkRow} to={editSetupPath("camera")}>
          <strong>Door camera</strong>
          <span>Camera position and face registration →</span>
        </Link>
        <Link className={styles.linkRow} to={editSetupPath("sound")}>
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
