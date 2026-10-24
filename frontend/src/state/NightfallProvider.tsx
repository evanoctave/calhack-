import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../data/api";
import {
  getPreviewState,
  isPreviewMode,
  setPreviewScenario,
  subscribePreview,
} from "../data/preview";
import type { NightfallEvent, NightfallState } from "../data/types";

export interface NightfallContextValue {
  state: NightfallState | null;
  memberId: string;
  preview: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  mutate: <T>(path: string, body?: unknown) => Promise<T>;
  setMember: (id: string) => void;
  setScenario: (scenario: string) => void;
  soundEnabled: boolean;
  enableSound: () => Promise<void>;
  stopRinging: () => void;
  silenceRing: () => void;
  ringSuppressed: boolean;
  shouldRing: boolean;
  lastEvent: NightfallEvent | null;
  doorSpeech?: { text: string; ts?: string; incident_id?: string } | null;
  visitorMessage?: string;
}

const NightfallContext = createContext<NightfallContextValue | null>(null);
const snapshotKey = (preview: boolean, memberId: string) =>
  ["nightfall-state", preview, memberId] as const;

export function isMemberRinging(
  state: NightfallState | undefined,
  memberId: string,
): boolean {
  const incident = state?.incident;
  if (
    !incident ||
    incident.acked_by ||
    !["ESCALATING", "EXHAUSTED"].includes(incident.state)
  )
    return false;
  if (incident.checkin === "self_other") return false;
  if (incident.cause === "help")
    return Boolean(
      state?.household.tree.some((member) => member.id === memberId),
    );
  const rings = state?.rings.filter(
    (ring) => !ring.incident_id || ring.incident_id === incident.id,
  );
  return Boolean(rings?.at(-1)?.member_ids.includes(memberId));
}

function initialMember(): string {
  if (typeof window === "undefined") return "TM-SARAH";
  const query = new URLSearchParams(window.location.search).get("member");
  if (query) return query;
  if (isPreviewMode()) return "TM-SARAH";
  try {
    return window.localStorage.getItem("nightfall-member") || "TM-SARAH";
  } catch {
    return "TM-SARAH";
  }
}

export function NightfallProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 1000, refetchOnWindowFocus: true },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <NightfallSession>{children}</NightfallSession>
    </QueryClientProvider>
  );
}

function NightfallSession({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [preview] = useState(isPreviewMode);
  const [explicitMember] = useState(
    () =>
      typeof window !== "undefined" &&
      Boolean(new URLSearchParams(window.location.search).get("member")),
  );
  const [memberId, updateMember] = useState(initialMember);
  const [lastEvent, setLastEvent] = useState<NightfallEvent | null>(null);
  const [speechEvent, setSpeechEvent] =
    useState<NightfallContextValue["doorSpeech"]>(null);
  const [visitorEvent, setVisitorEvent] = useState<NightfallEvent | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const soundRef = useRef(false);
  const audioRef = useRef<AudioContext | null>(null);
  const ringRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const answeredLocally = useRef(new Set<string>());
  const [suppressionRevision, setSuppressionRevision] = useState(0);
  const ringIncident = useRef<string | null>(null);
  const stateRef = useRef<NightfallState | undefined>(undefined);
  const currentMember = useRef(memberId);
  currentMember.current = memberId;
  const query = useQuery({
    queryKey: snapshotKey(preview, memberId),
    queryFn: ({ signal }) =>
      api.get<NightfallState>(
        `/app/state?member=${encodeURIComponent(memberId)}`,
        { signal },
      ),
    // Polling repairs a missed SSE event and keeps countdown timestamps authoritative.
    refetchInterval: preview ? false : 4000,
    refetchIntervalInBackground: false,
    retry: preview ? false : 1,
  });
  stateRef.current = query.data;
  const memberValid = Boolean(
    query.data?.household.tree.some((member) => member.id === memberId),
  );
  const firstMember = query.data?.household.tree
    .slice()
    .sort((a, b) => a.tier - b.tier)[0]?.id;
  const choosingMember = Boolean(
    query.data && !memberValid && !explicitMember && firstMember && !preview,
  );
  const membershipError =
    query.data && !memberValid && !choosingMember
      ? explicitMember
        ? "This invitation’s family member is not in the current care circle. Open a current invitation or join the care circle."
        : "No family member is available. Join the care circle to continue."
      : null;

  const stopRing = useCallback(() => {
    if (ringRef.current) clearInterval(ringRef.current);
    ringRef.current = null;
  }, []);
  const suppressRing = useCallback((member: string, incidentId: string) => {
    const key = `${member}:${incidentId}`;
    if (answeredLocally.current.has(key)) return;
    answeredLocally.current.add(key);
    setSuppressionRevision((value) => value + 1);
  }, []);
  const clearSuppression = useCallback(() => {
    if (!answeredLocally.current.size) return;
    answeredLocally.current.clear();
    setSuppressionRevision((value) => value + 1);
  }, []);
  const chime = useCallback(() => {
    const ctx = audioRef.current;
    if (!soundRef.current || !ctx || ctx.state !== "running") return;
    const gain = ctx.createGain(),
      osc = ctx.createOscillator();
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
    osc.start();
    osc.stop(ctx.currentTime + 0.55);
  }, []);
  const ring = useCallback(() => {
    if (!soundRef.current || !audioRef.current || ringRef.current) return;
    const playPulse = () => {
      const ctx = audioRef.current;
      if (!ctx || ctx.state !== "running") return;
      const gain = ctx.createGain();
      const osc = ctx.createOscillator();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    };
    playPulse();
    ringRef.current = setInterval(playPulse, 1600);
  }, []);

  const stopRinging = useCallback(() => {
    const incidentId = stateRef.current?.incident?.id || ringIncident.current;
    if (incidentId) suppressRing(currentMember.current, incidentId);
    stopRing();
  }, [stopRing, suppressRing]);

  useEffect(() => {
    const incidentId = query.data?.incident?.id;
    const answered =
      incidentId && answeredLocally.current.has(`${memberId}:${incidentId}`);
    if (!memberValid || !isMemberRinging(query.data, memberId) || answered)
      stopRing();
    else if (soundEnabled) {
      ringIncident.current = incidentId || null;
      ring();
    }
  }, [query.data, memberId, memberValid, soundEnabled, ring, stopRing]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: snapshotKey(preview, currentMember.current),
      exact: true,
    });
  }, [queryClient, preview]);

  const setMember = useCallback(
    (id: string) => {
      if (!id.trim() || id === currentMember.current) return;
      const oldKey = snapshotKey(preview, currentMember.current);
      void queryClient.cancelQueries({ queryKey: oldKey, exact: true });
      // A member selection starts from a new snapshot, never another person's cached state.
      queryClient.removeQueries({
        queryKey: snapshotKey(preview, id),
        exact: true,
      });
      currentMember.current = id;
      ringIncident.current = null;
      setLastEvent(null);
      setSpeechEvent(null);
      setVisitorEvent(null);
      stopRing();
      updateMember(id);
      if (!preview) {
        try {
          window.localStorage.setItem("nightfall-member", id);
        } catch {
          /* Storage is optional. */
        }
      }
    },
    [preview, queryClient, stopRing],
  );

  useEffect(() => {
    if (choosingMember && firstMember) setMember(firstMember);
  }, [choosingMember, firstMember, setMember]);

  useEffect(() => {
    if (!preview) return;
    return subscribePreview(() => {
      queryClient.setQueryData(
        snapshotKey(true, currentMember.current),
        getPreviewState(currentMember.current),
      );
    });
  }, [preview, queryClient]);

  useEffect(() => {
    // Do not subscribe as a hard-coded/stale identity before the household snapshot resolves it.
    if (preview || !memberValid || typeof EventSource === "undefined") return;
    let active = true;
    const es = new EventSource(`/sse/phone/${encodeURIComponent(memberId)}`);
    const sync = () => {
      if (active)
        void queryClient.invalidateQueries({
          queryKey: snapshotKey(false, memberId),
          exact: true,
        });
    };
    es.onopen = sync; // Native EventSource reconnects itself; repair anything missed while offline.
    es.addEventListener("hello", sync);
    es.onmessage = (message) => {
      if (!active) return;
      let event: NightfallEvent;
      try {
        event = JSON.parse(message.data) as NightfallEvent;
      } catch {
        return;
      }
      if (!event || typeof event.type !== "string") return;
      if (
        ["ring", "answered"].includes(event.type) &&
        event.member_id &&
        event.member_id !== memberId
      )
        return;
      setLastEvent(event);
      if (event.type === "speak" && typeof event.text === "string")
        setSpeechEvent({
          text: event.text,
          ts: event.ts,
          incident_id: event.incident_id,
        });
      if (event.type === "visitor_said") setVisitorEvent(event);
      if (event.type === "visitor") chime();
      if (event.type === "reset") {
        setSpeechEvent(null);
        setVisitorEvent(null);
        clearSuppression();
      }
      if (event.type === "ring" || event.type === "sos") {
        ringIncident.current = event.incident_id || null;
        if (
          !event.incident_id ||
          !answeredLocally.current.has(`${memberId}:${event.incident_id}`)
        )
          ring();
      }
      if (["acked", "returned", "stand_down", "reset"].includes(event.type))
        stopRing();
      if (event.type === "answered" && event.member_id === memberId) {
        if (event.incident_id) suppressRing(memberId, event.incident_id);
        stopRing();
      }
      sync();
    };
    // Keep the last confirmed data visible on a stream hiccup; snapshot polling reports outages.
    es.onerror = sync;
    return () => {
      active = false;
      es.onopen = es.onmessage = es.onerror = null;
      es.removeEventListener("hello", sync);
      es.close();
      stopRing();
    };
  }, [
    memberId,
    memberValid,
    preview,
    queryClient,
    ring,
    stopRing,
    suppressRing,
    chime,
    clearSuppression,
  ]);

  const enableSound = useCallback(async () => {
    const Audio =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Audio) throw new Error("Sound is not supported in this browser.");
    const ctx = audioRef.current || new Audio();
    audioRef.current = ctx;
    await ctx.resume();
    if (ctx.state !== "running")
      throw new Error("Tap Enable sound again to allow audio.");
    const source = ctx.createBufferSource();
    source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    source.connect(ctx.destination);
    source.start();
    source.onended = () => source.disconnect();
    soundRef.current = true;
    setSoundEnabled(true);
  }, []);

  const mutate = useCallback(
    async <T,>(path: string, body?: unknown): Promise<T> => {
      try {
        const result = await api.post<T>(path, body);
        if (path === "/answer") {
          const target = body as
            { incident_id?: string; member_id?: string } | undefined;
          if (
            target?.member_id === currentMember.current &&
            target.incident_id
          ) {
            suppressRing(target.member_id, target.incident_id);
            stopRing();
          }
        }
        if (["/ack", "/reset"].includes(path)) stopRing();
        if (path === "/reset") clearSuppression();
        return result;
      } finally {
        // Repair the snapshot after both successful and failed actions.
        await refresh();
      }
    },
    [refresh, stopRing, suppressRing, clearSuppression],
  );

  const setScenario = useCallback(
    (scenario: string) => {
      if (!preview) return;
      stopRing();
      clearSuppression();
      ringIncident.current = null;
      setLastEvent(null);
      setSpeechEvent(null);
      setVisitorEvent(null);
      setPreviewScenario(scenario, currentMember.current);
      queryClient.setQueryData(
        snapshotKey(true, currentMember.current),
        getPreviewState(currentMember.current),
      );
    },
    [preview, queryClient, stopRing, clearSuppression],
  );

  useEffect(
    () => () => {
      stopRing();
      void audioRef.current?.close();
      audioRef.current = null;
    },
    [stopRing],
  );

  const ringSuppressed = useMemo(
    () =>
      Boolean(
        query.data?.incident &&
        answeredLocally.current.has(`${memberId}:${query.data.incident.id}`),
      ),
    [memberId, query.data?.incident?.id, suppressionRevision],
  );
  const shouldRing =
    memberValid && isMemberRinging(query.data, memberId) && !ringSuppressed;
  const currentIncidentId = query.data?.incident?.id;
  const savedSpeech = query.data?.door_speech;
  const eventMatches = Boolean(
    currentIncidentId && speechEvent?.incident_id === currentIncidentId,
  );
  const savedMatches = Boolean(
    currentIncidentId && savedSpeech?.incident_id === currentIncidentId,
  );
  const snapshotIsNewer =
    savedMatches &&
    eventMatches &&
    savedSpeech?.ts &&
    speechEvent?.ts &&
    Date.parse(savedSpeech.ts) > Date.parse(speechEvent.ts);
  const doorSpeech =
    eventMatches && !snapshotIsNewer
      ? speechEvent
      : savedMatches
        ? savedSpeech
        : preview && query.data?.incident?.state === "CONVERSATION"
          ? {
              text: "Hi Dad. It's Sarah. Let's head back inside.",
              incident_id: currentIncidentId,
            }
          : null;
  const visitorMessage =
    visitorEvent?.incident_id === currentIncidentId && currentIncidentId
      ? String(visitorEvent?.said || "")
      : "";
  const value = useMemo<NightfallContextValue>(
    () => ({
      state: memberValid ? (query.data ?? null) : null,
      memberId,
      preview,
      loading: query.isPending || choosingMember,
      error:
        membershipError ||
        (query.error instanceof Error ? query.error.message : null),
      refresh,
      mutate,
      setMember,
      setScenario,
      soundEnabled,
      enableSound,
      stopRinging,
      silenceRing: stopRinging,
      ringSuppressed,
      shouldRing,
      lastEvent,
      doorSpeech,
      visitorMessage,
    }),
    [
      query.data,
      query.isPending,
      query.error,
      memberId,
      memberValid,
      choosingMember,
      membershipError,
      preview,
      refresh,
      mutate,
      setMember,
      setScenario,
      soundEnabled,
      enableSound,
      stopRinging,
      ringSuppressed,
      shouldRing,
      lastEvent,
      doorSpeech,
      visitorMessage,
    ],
  );
  return (
    <NightfallContext.Provider value={value}>
      {children}
    </NightfallContext.Provider>
  );
}

export function useNightfall(): NightfallContextValue {
  const value = useContext(NightfallContext);
  if (!value)
    throw new Error("useNightfall must be used inside NightfallProvider.");
  return value;
}
