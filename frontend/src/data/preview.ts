import type {
  Brief,
  Household,
  Incident,
  NearbyStatus,
  NightfallState,
  SampleKind,
  TreeMember,
} from "./types";

export const PREVIEW_SCENARIOS = [
  "watching",
  "approach",
  "countdown",
  "ringing",
  "returned",
  "responding",
  "other-family",
  "visitor",
  "help",
  "emergency",
] as const;
export type PreviewScenario = (typeof PREVIEW_SCENARIOS)[number];
export const CAMERA_DEMO = "/ui/assets/camera-demo.png";

export function isPreviewMode(): boolean {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("preview") === "1"
  );
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const household: Household = {
  person_name: "Dad",
  person_full_name: "Robert Miller",
  person_age: 78,
  caregiver_name: "Sarah",
  address: "San Francisco Marina",
  photo: CAMERA_DEMO,
  radius_mi: 1.5,
  home: { lat: 37.8022, lng: -122.4382 },
  tree: [
    { id: "TM-SARAH", name: "Sarah", phone: "web", tier: 1 },
    { id: "TM-MIKE", name: "Mike", phone: "web", tier: 2 },
    { id: "TM-LINDA", name: "Linda (neighbor)", phone: "web", tier: 3 },
  ],
  familiar_places: [
    {
      name: "Palace of Fine Arts",
      lat: 37.8029,
      lng: -122.4484,
      distance_mi: 0.6,
      note: "Morning walks",
    },
    {
      name: "Old flat on Chestnut St",
      lat: 37.8001,
      lng: -122.435,
      distance_mi: 0.2,
      note: "A former home",
    },
    {
      name: "Corner church",
      lat: 37.8006,
      lng: -122.4315,
      distance_mi: 0.4,
      note: "Sunday routine",
    },
  ],
  notes: [
    {
      text: "Often talks about his old home on Chestnut Street.",
      kind: "habit",
    },
  ],
  medications: [
    { name: "donepezil", dose: "10 mg", note: "nightly" },
    { name: "metoprolol", dose: "50 mg", note: "morning" },
  ],
  contacts: [
    {
      name: "Family contact",
      phone: "",
      note: "Demo contact — no call will be placed",
    },
  ],
  description: {},
  diagnosis: "",
  doctor: {},
};

export function createPreviewState(
  scenario: string = "watching",
  memberId = "TM-SARAH",
  now = Date.now(),
): NightfallState {
  const value = PREVIEW_SCENARIOS.includes(scenario as PreviewScenario)
    ? scenario
    : "watching";
  const exited = [
    "ringing",
    "responding",
    "other-family",
    "emergency",
    "help",
  ].includes(value);
  const secondsOut = value === "emergency" ? 15 * 60 : 90;
  const exitAt = new Date(now - secondsOut * 1000).toISOString();
  const stateByScenario: Record<string, Incident["state"]> = {
    approach: "CONVERSATION",
    countdown: "DOOR_OPEN",
    ringing: "ESCALATING",
    returned: "RETURNED",
    responding: "ACKED",
    "other-family": "ACKED",
    visitor: "VISITOR",
    help: "ESCALATING",
    emergency: "EXHAUSTED",
  };
  const acknowledged = value === "responding" || value === "other-family";
  const ackId = value === "other-family" ? "TM-MIKE" : memberId;
  const ackName =
    household.tree.find((member) => member.id === ackId)?.name || "You";
  const incident: Incident | null =
    value === "watching"
      ? null
      : {
          id: "PREVIEW-INCIDENT",
          cause: value === "help" ? "help" : "door",
          state: stateByScenario[value],
          opened_at: new Date(
            now - (exited ? secondsOut + 30 : 10) * 1000,
          ).toISOString(),
          exited_at: exited ? exitAt : null,
          minutes_since_exit: exited ? secondsOut / 60 : null,
          deadline_at: exited
            ? new Date(
                new Date(exitAt).getTime() + 15 * 60 * 1000,
              ).toISOString()
            : null,
          acked_by: acknowledged ? ackId : null,
          acked_by_name: acknowledged ? ackName : null,
          lines_spoken: value === "visitor" ? 0 : 2,
          person_in_frame: ["approach", "returned", "visitor"].includes(value),
          door_opened_at:
            value === "countdown" ? new Date(now - 5000).toISOString() : null,
          heading: exited ? "away" : "unknown",
          visitor: value === "visitor",
          identity: value === "visitor" ? "unknown" : "person",
          direction: exited ? "out" : "unknown",
          checkin: "",
          checkin_who: "",
          wander: {
            score: exited ? 4 : 0,
            action: exited ? "escalate" : "watch",
            reasons: exited ? ["Out of view at night"] : [],
          },
          emergency: {
            called: false,
            option_shown: ["ringing", "emergency"].includes(value),
            option_after_s: 45,
            deadline_hhmm: "2:18 AM",
            text: "You decide whether to call. Nightfall never dials 911 on its own.",
          },
          brief_link: exited
            ? `/brief.html#preview-brief-${encodeURIComponent(memberId)}`
            : "",
          exit_frame: CAMERA_DEMO,
          clothing_line:
            "Light gray shirt; lower body and footwear not visible",
          clothing: {
            confidence: 0,
            source: "preview",
            top: "light gray shirt",
            bottom: "unknown",
            footwear: "unknown",
          },
          police_report:
            "Preview: Robert Miller, 78, was last seen at the door. Verify the photograph and clothing before sharing.",
          history: { count: 0, last: [], typical_minutes: 0, headings: [] },
        };
  return {
    now: new Date(now).toISOString(),
    night_mode: true,
    household: copy(household),
    incident,
    rings: exited
      ? [{ tier: 1, members: ["Sarah"], member_ids: ["TM-SARAH"] }]
      : [],
    ladder_step_s: 60,
    door_wait_s: 20,
    takeover_by: null,
    live_by: null,
    call_911: ["ringing", "emergency"].includes(value),
    voice: {
      voice_id: "preview-voice",
      source: "preview",
      name: "Sarah",
      mock: true,
      samples: { introduction: true, reassurance: false, everyday: false },
      style: [1, "happy"],
    },
    memory_source: "preview",
    places_source: "preview",
    live_frame: false,
  };
}

export function createPreviewNearby(state: NightfallState): NearbyStatus {
  return {
    apify: "done",
    address: state.household.address,
    hazards: 2,
    open: 1,
    error: "",
    home: { ...state.household.home, radius_mi: state.household.radius_mi },
    hazards_ranked: [
      {
        name: "Marina waterfront",
        lat: 37.806,
        lng: -122.4402,
        category: "water",
        distance_mi: 0.3,
        source: "preview",
      },
      {
        name: "Lombard Street crossing",
        lat: 37.799,
        lng: -122.4364,
        category: "road",
        distance_mi: 0.2,
        source: "preview",
      },
    ],
    call_first: [
      {
        name: "Nearby hotel reception",
        lat: 37.7999,
        lng: -122.433,
        category: "hotel",
        distance_mi: 0.3,
        open_now: true,
        phone: "",
        source: "preview",
      },
    ],
    familiar: copy(state.household.familiar_places),
    places_source: "preview",
    total: 3,
  };
}

export function createPreviewBrief(
  state: NightfallState,
  viewer = "TM-SARAH",
): Brief {
  const incident = state.incident || createPreviewState("ringing").incident!;
  const nearby = createPreviewNearby(state);
  return {
    incident_id: incident.id,
    cause: incident.cause,
    viewer,
    person_name: state.household.person_name,
    person_full_name: state.household.person_full_name,
    person_age: state.household.person_age,
    photo: state.household.photo,
    exit_frames: [CAMERA_DEMO],
    clothing: incident.clothing!,
    clothing_line: incident.clothing_line,
    medications: copy(state.household.medications),
    last_seen_at: incident.exited_at || state.now,
    deadline_at: incident.deadline_at || state.now,
    last_seen_hhmm: "2:03 AM",
    deadline_hhmm: "2:18 AM",
    home: { ...state.household.home, radius_mi: state.household.radius_mi },
    hazards: nearby.hazards_ranked,
    call_first: nearby.call_first,
    familiar: nearby.familiar,
    contacts: copy(state.household.contacts),
    prose:
      incident.cause === "help"
        ? "Help was requested at the door. Check the camera and speak to Dad; a departure is not confirmed."
        : "Dad was last seen at the door. Start with nearby risks, then check familiar places.",
    places_source: "preview",
    habits: copy(state.household.notes),
    memory_source: "preview",
    description: copy(state.household.description),
    diagnosis: state.household.diagnosis,
    doctor: copy(state.household.doctor),
    address: state.household.address,
    heading: incident.heading,
    history: incident.history!,
    police_report: incident.police_report,
  };
}

let session: NightfallState | null = null;
const listeners = new Set<() => void>();
export function getPreviewState(memberId?: string): NightfallState {
  if (!session) {
    const scenario =
      typeof window === "undefined"
        ? "watching"
        : new URLSearchParams(window.location.search).get("scenario") ||
          "watching";
    session = createPreviewState(scenario);
  }
  const snapshot = copy(session);
  if (memberId && snapshot.incident?.brief_link)
    snapshot.incident.brief_link = `/brief.html#preview-brief-${encodeURIComponent(memberId)}`;
  return snapshot;
}
export function setPreviewScenario(
  scenario: string,
  memberId = "TM-SARAH",
): void {
  const old = session;
  session = createPreviewState(scenario, memberId);
  if (old) {
    session.household = old.household;
    session.voice = old.voice;
  }
  listeners.forEach((listener) => listener());
}
export function subscribePreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function resetPreview(): void {
  session = null;
  listeners.forEach((listener) => listener());
}

class PreviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function emit(): void {
  listeners.forEach((listener) => listener());
}

/** All preview network operations terminate here, including direct api calls from feature screens. */
export async function previewRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const current = session || (session = getPreviewState());
  const url = new URL(path, "http://preview.invalid");
  const method = init.method || "GET";
  const data =
    typeof init.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : {};
  let result: unknown = { ok: true, preview: true };
  if (method === "GET") {
    if (url.pathname === "/app/state" || url.pathname === "/state")
      result = getPreviewState(url.searchParams.get("member") || undefined);
    else if (url.pathname === "/health")
      result = {
        ok: true,
        now: current.now,
        night_mode: current.night_mode,
        mock: {
          cartesia: true,
          anthropic: true,
          apify: true,
          twilio: true,
          moss: true,
        },
      };
    else if (url.pathname === "/setup/status")
      result = createPreviewNearby(current);
    else if (url.pathname === "/enroll") result = { faces: [] };
    else if (url.pathname.startsWith("/brief/")) {
      if (url.pathname.includes("expired"))
        throw new PreviewError(410, "This link has expired.");
      if (url.pathname.includes("invalid"))
        throw new PreviewError(404, "This link is not valid.");
      const token = decodeURIComponent(url.pathname.slice("/brief/".length));
      const viewer = token.startsWith("preview-brief-")
        ? decodeURIComponent(token.slice("preview-brief-".length))
        : "TM-SARAH";
      result = createPreviewBrief(current, viewer);
    } else if (url.pathname === "/voice/current")
      result = {
        ...current.voice,
        speed: current.voice.style[0],
        emotion: current.voice.style[1],
      };
    else if (url.pathname === "/samples/index.json")
      result = [
        {
          id: "preview-natural",
          name: "Natural voice",
          variant: "natural",
          file: "",
          gen: { speed: 1 },
        },
        {
          id: "preview-warm",
          name: "Warm voice",
          variant: "warm",
          file: "",
          gen: { speed: 1, emotion: "happy" },
        },
      ];
    else if (url.pathname.startsWith("/agent/opening/"))
      result = {
        say: "Dad was last seen at the door. Check the photo, then the nearby waterfront. Tell me when you are on your way.",
        audio: {},
        preview: true,
      };
    else throw new PreviewError(404, "This preview data is not available.");
    return copy(result) as T;
  }

  if (url.pathname === "/preview/profile") {
    // Deliberately preview-only drafts for fields whose backend write contract is not present.
    const allowed = [
      "photo",
      "medications",
      "familiar_places",
      "notes",
      "contacts",
      "tree",
    ];
    for (const key of allowed)
      if (data[key] !== undefined)
        Object.assign(current.household, { [key]: copy(data[key]) });
    result = { ok: true, preview: true, household: current.household };
  } else if (url.pathname === "/profile") {
    const previousName = current.household.caregiver_name;
    const allowed = [
      "person_full_name",
      "person_name",
      "person_age",
      "caregiver_name",
      "address",
      "description",
      "diagnosis",
      "doctor",
    ];
    for (const key of allowed)
      if (data[key] !== undefined)
        Object.assign(current.household, { [key]: data[key] });
    if (data.caregiver_name)
      current.household.tree = current.household.tree.map((member) =>
        member.name === previousName
          ? { ...member, name: String(data.caregiver_name) }
          : member,
      );
    result = { ok: true, preview: true, household: current.household, geo: {} };
  } else if (url.pathname === "/tree") {
    const name = String(data.name || "Family member");
    const existing = current.household.tree.find(
      (member) => member.name.toLowerCase() === name.toLowerCase(),
    );
    const member: TreeMember = existing || {
      id: `PREVIEW-MEMBER-${current.household.tree.length}`,
      name,
      phone: String(data.phone || "web"),
      tier: Number(data.tier || 1),
    };
    if (!existing) current.household.tree.push(member);
    result = {
      member_id: member.id,
      phone_url: `/ui/?preview=1&member=${member.id}#/join`,
      existing: Boolean(existing),
      preview: true,
    };
  } else if (url.pathname === "/arm") current.night_mode = Boolean(data.on);
  else if (url.pathname === "/ack") {
    const memberId = String(data.member_id || "TM-SARAH");
    if (current.incident) {
      const first = !current.incident.acked_by;
      if (first) {
        current.incident.acked_by = memberId;
        current.incident.acked_by_name =
          current.household.tree.find((member) => member.id === memberId)
            ?.name || "You";
        current.incident.state = "ACKED";
      }
      // Acknowledged is not physical return; do not modify person_in_frame.
      result = {
        ok: true,
        first,
        acked_by: current.incident.acked_by,
        preview: true,
      };
    } else throw new PreviewError(404, "No incident to acknowledge.");
  } else if (url.pathname === "/takeover")
    current.takeover_by =
      data.on === false ? null : String(data.member_id || "TM-SARAH");
  else if (url.pathname === "/setup/address") {
    current.household.address = String(
      data.address || current.household.address,
    );
    current.household.radius_mi = Number(
      data.radius_mi || current.household.radius_mi,
    );
    result = {
      ...current.household.home,
      display_name: current.household.address,
      hazards: createPreviewNearby(current).hazards_ranked,
      apify: "done",
      preview: true,
    };
  } else if (url.pathname.startsWith("/voice/samples/")) {
    const kind = url.pathname.split("/").at(-1) as SampleKind;
    if (!(kind in current.voice.samples))
      throw new PreviewError(404, "Unknown sample kind.");
    current.voice.samples[kind] = method !== "DELETE";
    result = { ok: true, preview: true, kind, seconds: 8, url: "" };
  } else if (url.pathname === "/voice/clone") {
    current.voice.name = String(data.name || current.household.caregiver_name);
    current.voice.source = "preview";
    result = {
      ok: true,
      source: "mock",
      voice_id: "preview-voice",
      seconds: 8,
      preview: true,
    };
  } else if (url.pathname === "/voice/select") {
    current.voice.voice_id = String(data.voice_id || "preview-voice");
    current.voice.style = [
      Number(data.speed || 1),
      String(data.emotion || "happy"),
    ];
    result = { ok: true, ...data, preview: true };
  } else if (url.pathname === "/voice/preview")
    result = {
      text: "Hi Dad, it is Sarah. Let’s head back inside together.",
      line_source: "preview",
      audio: {},
      preview: true,
    };
  else if (url.pathname === "/agent/turn")
    result = {
      say: "Start with the waterfront, then the familiar places in the brief. Verify the photo before sharing.",
      intent: "search",
      ack: false,
      done: false,
      audio: {},
      preview: true,
    };
  else if (url.pathname === "/say")
    result = {
      ok: true,
      audio: { mode: "preview", source: "preview" },
      preview: true,
    };
  else if (url.pathname === "/reset") setPreviewScenario("watching");
  else if (url.pathname === "/event") {
    const next: Record<string, string> = {
      person_enter: "approach",
      person_lost: "countdown",
      person_back: "returned",
      sos: "help",
    };
    if (!next[String(data.kind)])
      throw new PreviewError(
        422,
        "This event is not available in the preview.",
      );
    setPreviewScenario(next[String(data.kind)]);
  } else if (
    ["/answer", "/door/command", "/door/telemetry", "/say/clip"].includes(
      url.pathname,
    )
  ) {
    // Explicit known no-op transports: preview does not start hardware, calls, or playback.
    result = { ok: true, preview: true };
  } else if (
    url.pathname === "/enroll" ||
    (method === "DELETE" && url.pathname.startsWith("/enroll/"))
  ) {
    result = { ok: true, count: 0, preview: true };
  } else
    throw new PreviewError(
      404,
      "This action is not implemented in the preview.",
    );
  emit();
  return copy(result) as T;
}
