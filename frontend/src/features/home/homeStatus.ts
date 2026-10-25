import type { Incident, NightfallState } from "../../data/types";

export interface HomeStatus {
  title: string;
  reason: string;
  action: { label: string; path: string };
}

export function hasConfirmedReturn(incident: Incident | null): boolean {
  return Boolean(
    incident?.state === "RETURNED" &&
    incident.checkin !== "self_other" &&
    incident.identity !== "other",
  );
}

/** Describe the server state, without treating an acknowledgement as a return. */
export function getHomeStatus(
  state: NightfallState,
  soundEnabled: boolean,
  preview: boolean,
): HomeStatus {
  const incident = state.incident;
  const name = state.household.person_name;
  const camera = { label: "Open door camera", path: "/door" };
  const response = { label: "View response", path: "/incident/respond" };
  const help = incident?.cause === "help";
  const latestRing = incident
    ? state.rings
        .filter((ring) => !ring.incident_id || ring.incident_id === incident.id)
        .at(-1)
    : undefined;
  const ringNames = latestRing?.members.filter((member) => member.trim()) || [];
  const contactReason = ringNames.length
    ? `${new Intl.ListFormat("en-US", { style: "long", type: "conjunction" }).format(ringNames)} ${ringNames.length === 1 ? "is" : "are"} being contacted.`
    : "Nightfall is contacting the care circle.";

  if (incident?.state === "RETURNED") {
    if (hasConfirmedReturn(incident))
      return {
        title: `${name} is back inside`,
        reason: `${name} is back inside. Family calls have stopped.`,
        action: { label: "View return details", path: "/incident/respond" },
      };
    return {
      title: "Check-in resolved",
      reason: `${incident.checkin_who || "Another person"} was identified at the door. This does not confirm ${name} returned.`,
      action: { label: "View check-in details", path: "/incident/respond" },
    };
  }
  if (incident?.state === "WATCHING")
    return {
      title: "Watching",
      reason: "This check-in is observation only. Family calls are not active.",
      action: camera,
    };
  if (incident?.state === "VISITOR")
    return {
      title: "Someone is at the door",
      reason:
        "Nightfall is checking who is there. This is a visitor check-in, not a confirmed exit.",
      action: camera,
    };
  if (incident?.state === "CONVERSATION")
    return {
      title:
        incident.identity === "other" ? "Voice check-in" : `Talking to ${name}`,
      reason:
        "Nightfall started a voice check-in based on the door camera’s signals.",
      action: camera,
    };
  if (incident?.state === "DOOR_OPEN")
    return {
      title: "Checking for a return",
      reason: "Nightfall is checking for a return before calling family.",
      action: { label: "Watch the door", path: "/door" },
    };
  if (
    incident &&
    ["ESCALATING", "EXHAUSTED", "ACKED"].includes(incident.state)
  ) {
    if (incident.acked_by || incident.state === "ACKED")
      return {
        title: `${incident.acked_by_name || "Family"} is on it`,
        reason: help
          ? "A family member is handling the help request. Other phones stopped ringing."
          : `Other phones stopped ringing. ${name}’s return is not confirmed.`,
        action: response,
      };
    return {
      title:
        incident.state === "EXHAUSTED"
          ? "No family response yet"
          : "Calling family",
      reason:
        incident.state === "EXHAUSTED"
          ? help
            ? "The help request is unresolved. The current call order has finished without a response."
            : `${name}’s return is not confirmed. The current call order has finished without a response.`
          : help
            ? `Help was requested at the door. ${contactReason}`
            : `${name}’s return is not confirmed. ${contactReason}`,
      action: { label: "Talk to Nightfall", path: "/incident/call" },
    };
  }

  const needsConnectionCheck =
    !soundEnabled ||
    !state.household.tree.length ||
    !state.voice.voice_id ||
    (!preview && (state.voice.mock || state.voice.source === "mock")) ||
    (!preview && !state.live_frame);
  return {
    title: state.night_mode ? "Watching" : "Night watch is off",
    reason: state.night_mode
      ? incident?.state === "CLOSED"
        ? "The previous check-in is closed. Nightfall is watching for new activity."
        : "Night watch is enabled. A person entering the door camera’s view can start a voice check-in."
      : "Automatic night watch is paused. You can still open the door camera.",
    action: needsConnectionCheck
      ? { label: "Check connections", path: "/setup/connect" }
      : camera,
  };
}

export function doorDecisionFacts(
  incident: Incident,
  personName: string,
): string[] {
  if (incident.cause === "help")
    return [
      "The Help button requested family assistance.",
      "This does not establish who is at the door or whether anyone left home.",
    ];
  const identity =
    incident.identity === "match"
      ? `The camera reports a match for ${personName}.`
      : incident.identity === "other"
        ? `The camera reports someone other than ${personName}.`
        : "The person’s identity is not confirmed.";
  const direction =
    incident.direction === "exit"
      ? "Movement is outward through the door zone."
      : incident.direction === "entry"
        ? "Movement is inward through the door zone."
        : "Movement direction has not been determined.";
  const decision =
    incident.wander?.action === "escalate"
      ? "The current rule allows a voice check-in, then family calls if the exit check completes."
      : incident.wander?.action === "speak_only"
        ? "The current rule allows a voice check-in without starting family calls."
        : incident.wander?.action === "ignore"
          ? "The current signals do not start family calls."
          : "A response decision is not available yet.";
  const facts = [identity, direction, decision];
  if (incident.checkin === "self_other")
    facts.push(
      `${incident.checkin_who || "A care-circle member"} identified themselves in a reply.`,
    );
  if (incident.wander?.reasons.some((reason) => reason.startsWith("attire:")))
    facts.push("Nightwear or bare feet were reported as an additional signal.");
  return facts;
}
