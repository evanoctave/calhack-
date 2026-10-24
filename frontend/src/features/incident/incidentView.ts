import type { Incident } from "../../data/types";

export function countdown(end: string | null | undefined, now: number): string {
  if (!end) return "—";
  const seconds = Math.max(0, Math.ceil((Date.parse(end) - now) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function incidentTitle(incident: Incident | null, name: string): string {
  switch (incident?.state) {
    case "CONVERSATION":
      return `Talking to ${name}`;
    case "DOOR_OPEN":
      return "The door is open";
    case "WATCHING":
      return "Watching the entrance";
    case "VISITOR":
      return "Someone is at the door";
    case "RETURNED":
      return incident.checkin === "self_other"
        ? `${incident.checkin_who || "A family member"} checked in`
        : `${name} is back inside`;
    case "ACKED":
      return `${incident.acked_by_name || "A family member"} is on it`;
    case "ESCALATING":
    case "EXHAUSTED":
      return isHelpIncident(incident)
        ? "Help requested at the door"
        : `${name} has left home`;
    case "CLOSED":
      return "This check-in is complete";
    default:
      return "No active alert";
  }
}

export function isHelpIncident(
  incident: Pick<Incident, "cause"> | null | undefined,
): boolean {
  return incident?.cause === "help";
}

// WATCHING is observation only: it must not retain an earlier response or emergency action.
export function isResolvedIncident(
  incident: Incident | null | undefined,
): boolean {
  return (
    !incident ||
    ["RETURNED", "CLOSED", "WATCHING"].includes(incident.state) ||
    incident.checkin === "self_other"
  );
}

export function canRespond(incident: Incident | null | undefined): boolean {
  return Boolean(
    incident &&
    !isResolvedIncident(incident) &&
    ["ESCALATING", "EXHAUSTED"].includes(incident.state),
  );
}

export function canShowEmergency(
  incident: Incident | null | undefined,
): boolean {
  return Boolean(
    incident &&
    !isResolvedIncident(incident) &&
    ["ESCALATING", "EXHAUSTED", "ACKED"].includes(incident.state),
  );
}

export function confirmedReturned(incident: Incident | null): boolean {
  // The backend also uses RETURNED for stand-down after another household member checks in.
  return incident?.state === "RETURNED" && incident.checkin !== "self_other";
}
