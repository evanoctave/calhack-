/** Wire contracts verified against frontend-v1@06869e67. No SDK or API keys in the browser. */
export type SampleKind = "introduction" | "reassurance" | "everyday";
export type IncidentState =
  | "ARMED_OFF"
  | "ARMED_IDLE"
  | "CONVERSATION"
  | "DOOR_OPEN"
  | "ESCALATING"
  | "ACKED"
  | "RETURNED"
  | "EXHAUSTED"
  | "CLOSED"
  | "WATCHING"
  | "VISITOR";
export interface TreeMember {
  id: string;
  name: string;
  phone: string;
  tier: number;
}
export interface Medication {
  name: string;
  dose: string;
  note?: string;
}
export interface Contact {
  name: string;
  phone: string;
  note?: string;
}
export interface Note {
  text: string;
  kind?: string;
  id?: string;
}
export interface Place {
  id?: string;
  name: string;
  lat: number;
  lng: number;
  category?: string;
  distance_mi?: number;
  phone?: string;
  open_now?: boolean | null;
  address?: string;
  note?: string;
  source?: string;
  reason?: string;
  why?: string;
  maps_url?: string;
  opening_hours?: string;
  priority?: number;
}
export interface Household {
  person_name: string;
  person_full_name: string;
  person_age: number;
  caregiver_name: string;
  address: string;
  photo: string;
  radius_mi: number;
  home: { lat: number; lng: number };
  tree: TreeMember[];
  familiar_places: Place[];
  notes: Note[];
  medications: Medication[];
  contacts: Contact[];
  description: Record<string, string>;
  diagnosis: string;
  doctor: Record<string, string>;
}
export interface Clothing {
  confidence: number;
  source?: string;
  top?: string;
  bottom?: string;
  footwear?: string;
  outerwear?: string;
  colors?: string[];
  [key: string]: unknown;
}
export interface Emergency {
  called: false;
  option_shown: boolean;
  option_after_s: number;
  deadline_hhmm: string;
  text: string;
}
export interface HistorySummary {
  count: number;
  typical_minutes: number;
  headings: string[];
  last: Array<{
    id?: string;
    exited_at?: string;
    outcome: string;
    minutes_out?: number;
    heading?: string;
  }>;
}
export interface Incident {
  cause?: "door" | "help";
  id: string;
  state: IncidentState;
  opened_at: string | null;
  exited_at: string | null;
  minutes_since_exit: number | null;
  deadline_at: string | null;
  acked_by: string | null;
  acked_by_name: string | null;
  lines_spoken: number;
  person_in_frame: boolean;
  door_opened_at: string | null;
  heading: string;
  visitor: boolean;
  identity: string;
  direction: string;
  checkin: string;
  checkin_who: string;
  wander: { score: number; action: string; reasons: string[] };
  emergency: Emergency;
  brief_link: string;
  exit_frame: string;
  clothing_line: string;
  clothing: Clothing | null;
  police_report: string;
  history: HistorySummary | null;
}
export interface VoiceState {
  voice_id: string;
  source: string;
  name: string;
  mock: boolean;
  samples: Record<SampleKind, boolean>;
  style: [number, string];
}
export interface NightfallState {
  now: string;
  night_mode: boolean;
  household: Household;
  incident: Incident | null;
  door_speech?: { text: string; ts?: string; incident_id?: string } | null;
  rings: Array<{
    incident_id?: string;
    tier: number;
    members: string[];
    member_ids: string[];
  }>;
  ladder_step_s: number;
  door_wait_s: number;
  takeover_by: string | null;
  live_by: string | null;
  call_911: boolean;
  voice: VoiceState;
  memory_source: string;
  places_source: string;
  live_frame: boolean;
}
export interface Brief {
  cause?: "door" | "help";
  incident_id: string;
  viewer?: string;
  person_name: string;
  person_full_name: string;
  person_age: number;
  photo: string;
  exit_frames: string[];
  clothing: Clothing;
  clothing_line: string;
  medications: Medication[];
  last_seen_at: string;
  deadline_at: string;
  last_seen_hhmm: string;
  deadline_hhmm: string;
  home: { lat: number; lng: number; radius_mi: number };
  hazards: Place[];
  call_first: Place[];
  familiar: Place[];
  contacts: Contact[];
  prose: string;
  places_source: string;
  habits: Note[];
  memory_source: string;
  description: Record<string, string>;
  diagnosis: string;
  doctor: Record<string, string>;
  address: string;
  heading: string;
  history: HistorySummary;
  police_report: string;
}
export interface NearbyStatus {
  apify:
    | "idle"
    | "running"
    | "done"
    | "failed"
    | "cancelled"
    | "skipped"
    | "no token";
  address: string;
  hazards: number;
  open: number;
  error: string;
  lat?: number;
  lng?: number;
  home: { lat: number; lng: number; radius_mi: number };
  hazards_ranked: Place[];
  call_first: Place[];
  familiar: Place[];
  places_source: string;
  total: number;
}
export interface AudioRef {
  url?: string;
  mode?: string;
  source?: string;
}
export interface AgentReply {
  say: string;
  intent?: string;
  done?: boolean;
  ack?: boolean;
  audio: AudioRef;
}
export interface NightfallEvent {
  type: string;
  incident_id?: string;
  member_id?: string;
  by?: string;
  who?: string;
  message?: string;
  detail?: string;
  said?: string;
  link?: string;
  on?: boolean;
  tier?: number;
  out_of_view_s?: number;
  ts?: string;
  [key: string]: unknown;
}
export interface Health {
  ok: boolean;
  mock: Record<string, boolean>;
  now: string;
  night_mode: boolean;
}
export interface VoicePreset {
  id?: string;
  voice_id?: string;
  name: string;
  natural?: string;
  warm?: string;
  samples?: Record<string, string>;
  [key: string]: unknown;
}
