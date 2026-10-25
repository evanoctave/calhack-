import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  Notice,
  PageHeader,
  Row,
  Sheet,
} from "../../components/ui";
import { CameraFeed } from "../../components/CameraFeed";
import MapView from "../../components/MapView";
import { api, ApiError } from "../../data/api";
import type { Brief, Place } from "../../data/types";
import { useNightfall } from "../../state/NightfallProvider";
import {
  canRespond,
  canShowEmergency,
  confirmedReturned,
  isHelpIncident,
  isResolvedIncident,
} from "../incident/incidentView";
import styles from "./Brief.module.css";

export function briefToken(link: string): string {
  try {
    return new URL(link, window.location.origin).hash.slice(1);
  } catch {
    return "";
  }
}

export function BriefPage() {
  const { token: routeToken } = useParams();
  const { state, preview, memberId, setMember, mutate, lastEvent } =
    useNightfall();
  const navigate = useNavigate(),
    client = useQueryClient();
  // Backend mints a different signed URL on every snapshot. Keep it stable for this incident/viewer.
  const incidentId = state?.incident?.id;
  const hasBrief = !!state?.incident?.brief_link;
  const derivedToken = useMemo(
    () =>
      briefToken(state?.incident?.brief_link || "") ||
      (preview ? "preview-brief" : ""),
    [incidentId, memberId, preview, hasBrief],
  );
  const token = routeToken || derivedToken;
  const query = useQuery({
    queryKey: ["brief", preview, token],
    queryFn: ({ signal }) =>
      api.get<Brief>(`/brief/${encodeURIComponent(token)}`, { signal }),
    enabled: !!token,
    retry: false,
    refetchInterval: preview ? false : 8000,
  });
  const [imageOpen, setImageOpen] = useState<{
      src: string;
      reference: boolean;
    } | null>(null),
    [callPlace, setCallPlace] = useState<Place | null>(null),
    [notice, setNotice] = useState(""),
    [ackBusy, setAckBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const timeOffset = useMemo(
    () => (state?.now ? new Date(state.now).getTime() - Date.now() : 0),
    [state?.now],
  );
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (
      lastEvent?.type === "brief_updated" ||
      lastEvent?.type === "returned" ||
      lastEvent?.type === "acked"
    )
      void client.invalidateQueries({ queryKey: ["brief", preview, token] });
  }, [lastEvent, client, preview, token]);
  const b = query.data;
  const current = !!b && state?.incident?.id === b.incident_id;
  const incident = current ? (state?.incident ?? null) : null;
  const viewer = b?.viewer;
  const knownViewer =
    !!viewer && !!state?.household.tree.some((m) => m.id === viewer);
  useEffect(() => {
    if (knownViewer && viewer !== memberId) setMember(viewer!);
  }, [knownViewer, viewer, memberId, setMember]);
  const acknowledge = async () => {
    if (!b || ackBusy || !current || !knownViewer || !canRespond(incident))
      return;
    setAckBusy(true);
    setNotice("");
    try {
      await mutate("/ack", { incident_id: b.incident_id, member_id: viewer });
      navigate("/incident/respond");
    } catch (e) {
      setNotice(
        e instanceof ApiError && e.status === 404
          ? "The incident changed. Current status has been refreshed; check it before responding again."
          : e instanceof Error
            ? e.message
            : "Could not confirm your response.",
      );
    } finally {
      setAckBusy(false);
    }
  };
  if (!token)
    return (
      <div className="screen">
        <PageHeader back="/incident" title="Caregiver brief" />
        <Notice>A brief will be ready after an exit or a help request.</Notice>
        <Button variant="secondary" onClick={() => navigate("/home")}>
          Back to Home
        </Button>
      </div>
    );
  if (query.isPending)
    return (
      <div className="empty-state" role="status">
        <span className="spinner" />
        Opening the brief…
      </div>
    );
  if (query.error) {
    const status = query.error instanceof ApiError ? query.error.status : 0;
    return (
      <div className="screen">
        <PageHeader
          back="/incident"
          eyebrow="Caregiver brief"
          title={
            status === 410
              ? "This link has expired"
              : status === 404
                ? "This link is not valid"
                : "The brief couldn’t load"
          }
          description={
            status === 410
              ? "Ask someone in the care circle to send a current brief."
              : status === 404
                ? "Check that you opened the complete link from the family message."
                : "Check your connection and try again."
          }
        />
        {![404, 410].includes(status) && (
          <Button onClick={() => void query.refetch()}>Try again</Button>
        )}
        <Button variant="secondary" onClick={() => navigate("/home")}>
          Back to Home
        </Button>
      </div>
    );
  }
  if (!b) return null;
  const seconds = Math.max(
    0,
    Math.ceil((new Date(b.deadline_at).getTime() - clock - timeOffset) / 1000),
  );
  const time = new Date(b.last_seen_at).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const help = isHelpIncident(b) || isHelpIncident(incident);
  const returned = confirmedReturned(incident);
  const watching = incident?.state === "WATCHING";
  const resolved = !!incident && isResolvedIncident(incident);
  const checkinResolved = incident?.checkin === "self_other";
  const responding = !!incident?.acked_by;
  const actionable = canRespond(incident);
  const emergencyEligible = canShowEmergency(incident);
  const showEmergencyAction =
    emergencyEligible &&
    (state?.call_911 ||
      incident?.emergency.option_shown ||
      (!help && seconds === 0));
  const photos = [...new Set(b.exit_frames.slice(0, 3).filter(Boolean))];
  const validPhone = (value: string) => value.replace(/[^+\d]/g, "");
  const description = Object.entries(b.description).filter(([, value]) =>
    value.trim(),
  );
  const history = b.history;
  const hasHistory = history && (history.count > 0 || history.last.length > 0);
  return (
    <div className={`screen ${styles.brief}`}>
      <PageHeader
        back="/incident"
        eyebrow={
          help
            ? "Caregiver brief · Help request"
            : "Caregiver brief · Last seen"
        }
        title={
          returned
            ? `${b.person_name} is back inside`
            : watching
              ? `Watching a check-in at ${time}`
              : resolved
                ? "This check-in has ended"
                : help
                  ? `Help requested at the door at ${time}`
                  : `${b.person_name} left home at ${time}`
        }
        description={`${b.person_full_name}, ${b.person_age} · ${b.address}`}
      />
      {!current ? (
        <Notice>
          This is an earlier brief, or the current incident is not yet
          confirmed. Check Home before responding.
        </Notice>
      ) : returned ? (
        <Notice tone="success">
          {b.person_name} is back inside. Calls have stopped.
        </Notice>
      ) : watching ? (
        <Notice>
          Watching this check-in. Nightfall has not started family calls.
        </Notice>
      ) : resolved ? (
        <Notice tone="success">
          {checkinResolved
            ? `${incident?.checkin_who || "A family member"} checked in. The alert ended; ${b.person_name}’s location is not confirmed.`
            : "This check-in has ended. No family response is needed for this brief."}
        </Notice>
      ) : help ? (
        <Notice tone="warning">
          Help was requested at the door. A departure has not been confirmed.
        </Notice>
      ) : emergencyEligible ? (
        <Notice tone="danger">
          <strong className="tabular">
            {seconds > 0
              ? `Emergency recommendation in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
              : "15 minutes have passed. Consider calling 911."}
          </strong>
          <p className="caption">
            You can choose to call sooner. Nightfall never calls on its own.
          </p>
        </Notice>
      ) : null}
      {showEmergencyAction &&
        (preview ? (
          <Button
            variant="danger"
            onClick={() =>
              setNotice("Preview only. No emergency call will be placed.")
            }
          >
            Call 911
          </Button>
        ) : (
          <a className={`${styles.call} ${styles.emergency}`} href="tel:911">
            Call 911
          </a>
        ))}
      <h2>{help ? "Door camera captures" : "Exit camera captures"}</h2>
      {photos[0] ? (
        <button
          className="camera-link"
          aria-label="View camera capture"
          onClick={() => setImageOpen({ src: photos[0], reference: false })}
        >
          <CameraFeed
            src={photos[0]}
            aspect="square"
            caption={
              preview
                ? "Recorded camera image · Simulated home scenario"
                : help
                  ? "Captured at the door · Verify the clothing against this image"
                  : "Captured at exit · Verify the clothing against this image"
            }
          />
        </button>
      ) : (
        <Notice>
          No {help ? "door" : "exit"} camera capture is available for this
          incident.
        </Notice>
      )}
      {photos.length > 1 && (
        <div className={styles.photos}>
          {photos.slice(1).map((photo, i) => (
            <button
              key={photo}
              onClick={() => setImageOpen({ src: photo, reference: false })}
            >
              <img
                src={photo}
                alt={`${help ? "Door" : "Exit"} capture ${i + 2}`}
              />
            </button>
          ))}
        </div>
      )}
      <Card>
        <h2>
          {b.clothing_line === "see photo"
            ? "Clothing still being checked"
            : b.clothing_line}
        </h2>
        <p className="caption muted" style={{ marginTop: 8 }}>
          {preview || b.clothing.source === "mock"
            ? "Sample description"
            : "AI-described"}{" "}
          · Verify against the photo.
        </p>
        {b.clothing.confidence > 0 && (
          <p className="caption muted">
            {b.clothing.source === "mock"
              ? "Sample confidence"
              : "Model confidence"}
            : {Math.round(b.clothing.confidence * 100)}%
          </p>
        )}
        {preview && (
          <p className="caption muted" style={{ marginTop: 8 }}>
            Demo participant shown. Dad’s details are sample data.
          </p>
        )}
      </Card>
      <p className="muted">
        {help
          ? "Contact the family and check the door camera to understand what help is needed."
          : checkinResolved
            ? "The family identified who was at the door. The saved details below are kept for reference."
            : b.prose}
      </p>
      <h2>{help ? "Nearby places, if needed" : "Where should we look?"}</h2>
      <MapView
        home={b.home}
        hazards={b.hazards}
        callFirst={b.call_first}
        familiar={b.familiar}
        preview={preview}
      />
      <p className="sponsor">
        Nearby search · Apify{" "}
        {b.places_source === "preview" ||
        ["fixture", "mock"].includes(b.places_source)
          ? "· Sample places"
          : ""}
      </p>
      <p className="caption muted">
        Hazards · OpenStreetMap. Familiar places · From the care profile.
      </p>
      <PlaceList title="Check first" places={b.hazards} tone="danger" />
      <PlaceList
        title="Call first"
        places={b.call_first}
        tone="success"
        onChoose={setCallPlace}
      />
      <PlaceList title="Familiar places" places={b.familiar} tone="info" />
      <Card>
        <details>
          <summary>Care details & contacts</summary>
          <div className="stack">
            {b.photo && (
              <section className="stack gap-sm">
                <h3>Reference photo</h3>
                <button
                  className={styles.referencePhoto}
                  aria-label="View reference photo"
                  onClick={() =>
                    setImageOpen({ src: b.photo, reference: true })
                  }
                >
                  <img
                    src={b.photo}
                    alt={`Care profile photo of ${b.person_name}`}
                  />
                </button>
                <p className="caption muted">
                  From the care profile. This is not an incident camera capture.
                </p>
              </section>
            )}
            {description.length > 0 && (
              <section>
                <h3>Physical description</h3>
                {description.map(([key, value]) => (
                  <Row key={key} title={descriptionLabel(key)} detail={value} />
                ))}
              </section>
            )}
            {b.diagnosis && <Row title="Diagnosis" detail={b.diagnosis} />}
            <h3>Medications</h3>
            {b.medications.length ? (
              b.medications.map((m, i) => (
                <Row
                  key={i}
                  title={m.name}
                  detail={`${m.dose} · ${m.note || ""}`}
                />
              ))
            ) : (
              <p className="caption muted">No medications shared.</p>
            )}
            {(b.doctor.name || b.doctor.phone) && (
              <section>
                <h3>Doctor</h3>
                <Row
                  title={b.doctor.name || "Doctor contact"}
                  trailing={
                    b.doctor.phone && !preview ? (
                      <a href={`tel:${validPhone(b.doctor.phone)}`}>
                        {b.doctor.phone}
                      </a>
                    ) : (
                      <span className="caption muted">
                        {b.doctor.phone || "No number shared"}
                      </span>
                    )
                  }
                />
              </section>
            )}
            <Row title="Recorded direction" detail={headingLabel(b.heading)} />
            <h3>Habits</h3>
            {b.habits.map((h, i) => (
              <p key={i} className="caption">
                {h.text}
              </p>
            ))}
            {hasHistory && (
              <section>
                <h3>Previous incidents</h3>
                <p className="caption">
                  {history.count} recorded{" "}
                  {history.count === 1 ? "incident" : "incidents"}
                  {history.typical_minutes > 0
                    ? ` · Average recorded duration ${history.typical_minutes} min`
                    : ""}
                </p>
                {history.headings.length > 0 && (
                  <p className="caption muted">
                    Previous directions:{" "}
                    {history.headings.map(headingLabel).join(", ")}
                  </p>
                )}
                {history.last.map((item, i) => (
                  <Row
                    key={item.id || i}
                    title={outcomeLabel(item.outcome)}
                    detail={[
                      item.exited_at
                        ? new Date(item.exited_at).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })
                        : "Time not recorded",
                      item.minutes_out != null ? `${item.minutes_out} min` : "",
                      item.heading && item.heading !== "unknown"
                        ? headingLabel(item.heading)
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  />
                ))}
              </section>
            )}
            <h3>Contacts</h3>
            {b.contacts.map((c, i) => (
              <Row
                key={i}
                title={c.name}
                detail={c.note}
                trailing={
                  c.phone && !preview ? (
                    <a href={`tel:${validPhone(c.phone)}`}>{c.phone}</a>
                  ) : (
                    <span className="caption muted">
                      {c.phone || "No number"}
                    </span>
                  )
                }
              />
            ))}
          </div>
        </details>
      </Card>
      <Card>
        <details>
          <summary>
            {resolved || !current
              ? "Saved dispatcher summary"
              : "Read to the dispatcher"}
          </summary>
          {(resolved || !current) && (
            <p className="caption muted">
              This summary was prepared earlier. Verify the current situation
              before sharing it.
            </p>
          )}
          <p>
            {b.police_report || "A dispatcher summary is not available yet."}
          </p>
          <Button
            variant="quiet"
            onClick={() =>
              void (
                navigator.clipboard
                  ? navigator.clipboard.writeText(b.police_report || "")
                  : Promise.reject(new Error("Clipboard unavailable"))
              )
                .then(() => setNotice("Copied."))
                .catch(() =>
                  setNotice(
                    "Copy is unavailable here. Select the text to copy it.",
                  ),
                )
            }
          >
            Copy summary
          </Button>
        </details>
      </Card>
      {notice && <Notice>{notice}</Notice>}
      <Button variant="secondary" className="no-print" onClick={printBrief}>
        Print / Save as PDF
      </Button>
      <div
        className={`${styles.fixedAction} ${routeToken ? styles.standalone : ""}`}
      >
        {!current || resolved ? (
          <Button onClick={() => navigate("/home")}>Back to Home</Button>
        ) : responding ? (
          <Button onClick={() => navigate("/incident/respond")}>
            View response
          </Button>
        ) : actionable ? (
          <Button
            onClick={() => void acknowledge()}
            disabled={ackBusy || !knownViewer}
          >
            {ackBusy ? "Confirming…" : "I’ve got him"}
          </Button>
        ) : (
          <Button onClick={() => navigate("/incident")}>
            View current check-in
          </Button>
        )}
      </div>
      {imageOpen && (
        <Sheet
          title={imageOpen.reference ? "Reference photo" : "Camera capture"}
          onClose={() => setImageOpen(null)}
        >
          {imageOpen.reference ? (
            <img
              className={styles.referenceFull}
              src={imageOpen.src}
              alt={`Care profile photo of ${b.person_name}`}
            />
          ) : (
            <CameraFeed src={imageOpen.src} aspect="square" />
          )}
          <p className="caption muted">
            {imageOpen.reference
              ? "From the care profile. This is not an incident camera capture."
              : "Recorded incident image. This is not a current location."}
          </p>
        </Sheet>
      )}
      {callPlace && (
        <Sheet title={callPlace.name} onClose={() => setCallPlace(null)}>
          <p className="muted">
            Ask whether they have seen {b.person_name}. Describe the clothing
            shown in the photo.
          </p>
          {callPlace.phone && !preview ? (
            <a
              className={styles.call}
              href={`tel:${validPhone(callPlace.phone)}`}
            >
              Call {callPlace.phone}
            </a>
          ) : (
            <Notice>
              {preview
                ? "Preview only. No phone call will be placed."
                : "A phone number is not available for this place."}
            </Notice>
          )}
        </Sheet>
      )}
    </div>
  );
}

function descriptionLabel(key: string): string {
  const labels: Record<string, string> = {
    sex: "Sex",
    height: "Height",
    weight: "Weight",
    hair: "Hair",
    eyes: "Eyes",
    build: "Build",
    marks: "Identifying marks",
  };
  return (
    labels[key] ||
    key.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase())
  );
}

function headingLabel(heading: string): string {
  const labels: Record<string, string> = {
    left: "Left of the door camera",
    right: "Right of the door camera",
    away: "Away from the camera",
    toward: "Toward the camera",
    unknown: "Direction not seen",
  };
  return labels[heading] || heading || "Direction not seen";
}

function outcomeLabel(outcome: string): string {
  const labels: Record<string, string> = {
    returned: "Return confirmed",
    acked: "Family responded",
    exhausted: "Escalation reached the final stage",
    stand_down: "Alert stood down",
    watch_only: "Observed without family calls",
    visitor: "Visitor check-in",
    sos: "Help requested",
    closed: "Check-in closed",
  };
  return labels[outcome] || outcome.replace(/_/g, " ");
}

function printBrief() {
  const closed = [
    ...document.querySelectorAll<HTMLDetailsElement>("details:not([open])"),
  ];
  closed.forEach((detail) => {
    detail.open = true;
  });
  window.addEventListener(
    "afterprint",
    () =>
      closed.forEach((detail) => {
        detail.open = false;
      }),
    { once: true },
  );
  window.print();
}

function PlaceList({
  title,
  places,
  tone,
  onChoose,
}: {
  title: string;
  places: Place[];
  tone: "info" | "danger" | "success";
  onChoose?: (place: Place) => void;
}) {
  return (
    <section className="stack gap-sm">
      <h2>{title}</h2>
      <Card>
        {places.length ? (
          places.map((p, i) => (
            <Row
              key={p.id || `${p.name}-${i}`}
              title={
                <span className="inline">
                  <Badge tone={tone}>{i + 1}</Badge>
                  {p.name}
                </span>
              }
              detail={`${p.category || p.note || ""}${p.distance_mi != null ? ` · ${p.distance_mi} mi` : ""}${p.open_now === true ? " · Open now" : p.open_now === false ? " · Closed" : ""}`}
              onClick={onChoose ? () => onChoose(p) : undefined}
            />
          ))
        ) : (
          <p className="caption muted">No places listed for this area.</p>
        )}
      </Card>
    </section>
  );
}
