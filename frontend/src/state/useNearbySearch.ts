import { useEffect, useSyncExternalStore } from "react";
import { api, ApiError } from "../data/api";
import { previewRequest } from "../data/preview";
import type { Household, NearbyStatus } from "../data/types";
import { useNightfall } from "./NightfallProvider";

export interface NearbyInput {
  address: string;
  radius_mi: number;
}
export interface NearbySearchState {
  phase: "idle" | "locating" | "searching" | "ready" | "error";
  data: NearbyStatus | null;
  dataInput: NearbyInput | null;
  input: NearbyInput | null;
  draft: NearbyInput;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
  saved: boolean;
  loading: boolean;
  busy: boolean;
}
type Home = { lat: number; lng: number; radius_mi: number };
type AddressResult = {
  lat: number;
  lng: number;
  display_name?: string;
  apify: NearbyStatus["apify"];
};
const POLL_MS = 3000;
const MAX_POLLS = 240;
const GET_TIMEOUT_MS = 20000;
const normalize = (input: NearbyInput): NearbyInput => ({
  address: input.address.trim(),
  radius_mi: input.radius_mi,
});
const sameInput = (a: NearbyInput | null, b: NearbyInput | null) =>
  Boolean(
    a &&
    b &&
    a.address.trim().toLowerCase() === b.address.trim().toLowerCase() &&
    a.radius_mi === b.radius_mi,
  );
const matchesHome = (data: NearbyStatus, home: Home | null) =>
  Boolean(
    home &&
    Math.abs(data.home.lat - home.lat) < 0.00001 &&
    Math.abs(data.home.lng - home.lng) < 0.00001 &&
    Math.abs(data.home.radius_mi - home.radius_mi) < 0.00001,
  );
const liveSource = (data: NearbyStatus) =>
  ["apify", "overpass"].includes(data.places_source);
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Could not check nearby places.";

class NearbySearchStore {
  snapshot: NearbySearchState = {
    phase: "idle",
    data: null,
    dataInput: null,
    input: null,
    draft: { address: "", radius_mi: 1.5 },
    error: null,
    startedAt: null,
    completedAt: null,
    saved: false,
    loading: false,
    busy: false,
  };
  private listeners = new Set<() => void>();
  private initialized = false;
  private generation = 0;
  private postPending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | null = null;
  private polls = 0;
  private expected: Home | null = null;
  private household: Household | null = null;
  private verified: {
    input: NearbyInput;
    data: NearbyStatus;
    completedAt: number | null;
  } | null = null;
  private submitted = false;
  private jobMayBeRunning = false;
  private disposed = false;
  refresh = async () => {};

  constructor(private preview: boolean) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private update(patch: Partial<NearbySearchState>) {
    if (this.disposed) return;
    const next = { ...this.snapshot, ...patch };
    next.busy = next.phase === "locating" || next.phase === "searching";
    next.saved =
      !this.preview &&
      next.phase === "ready" &&
      Boolean(this.verified) &&
      sameInput(next.draft, this.verified?.input || null) &&
      sameInput(next.input, this.verified?.input || null);
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
  configure(household: Household) {
    const previous = this.household;
    this.household = household;
    if (this.initialized) {
      const home = { ...household.home, radius_mi: household.radius_mi };
      const changed =
        previous &&
        (previous.address !== household.address ||
          previous.radius_mi !== household.radius_mi ||
          previous.home.lat !== household.home.lat ||
          previous.home.lng !== household.home.lng);
      if (
        changed &&
        !this.postPending &&
        !this.snapshot.busy &&
        (!this.snapshot.input ||
          !sameInput(this.snapshot.input, {
            address: household.address,
            radius_mi: household.radius_mi,
          }) ||
          Boolean(
            this.expected &&
            (this.expected.lat !== home.lat ||
              this.expected.lng !== home.lng ||
              this.expected.radius_mi !== home.radius_mi),
          ))
      ) {
        const keepDraft = !sameInput(this.snapshot.draft, {
          address: previous.address,
          radius_mi: previous.radius_mi,
        });
        this.verified = null;
        this.expected = home;
        this.submitted = false;
        this.jobMayBeRunning = false;
        this.update({
          phase: "idle",
          input: null,
          data: null,
          dataInput: null,
          startedAt: null,
          completedAt: null,
          ...(!keepDraft
            ? {
                draft: {
                  address: household.address,
                  radius_mi: household.radius_mi,
                },
              }
            : {}),
        });
        this.reload();
      }
      return;
    }
    this.initialized = true;
    this.expected = { ...household.home, radius_mi: household.radius_mi };
    this.update({
      draft: { address: household.address, radius_mi: household.radius_mi },
    });
    this.reload();
  }
  setDraft = (input: NearbyInput) => {
    this.update({ draft: { ...input } });
  };
  private cancelRead() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = null;
  }
  private current(run: number) {
    return !this.disposed && run === this.generation;
  }
  private notifyHousehold() {
    // Snapshot repair must not delay the transition to the progress/results screen.
    void Promise.resolve()
      .then(() => this.refresh())
      .catch(() => {});
  }
  start = (raw: NearbyInput, options: { force?: boolean } = {}): void => {
    if (this.postPending || this.snapshot.busy) return;
    const input = normalize(raw);
    if (
      !input.address ||
      !Number.isFinite(input.radius_mi) ||
      input.radius_mi <= 0.25 ||
      input.radius_mi > 5
    ) {
      this.update({
        phase: "error",
        draft: input,
        error: "Enter a home address and a radius between 0.3 and 5 miles.",
      });
      return;
    }
    if (
      !options.force &&
      this.verified &&
      sameInput(input, this.verified.input) &&
      matchesHome(this.verified.data, this.expected)
    ) {
      this.update({
        phase: "ready",
        draft: input,
        input,
        data: this.verified.data,
        dataInput: input,
        error: null,
        completedAt: this.verified.completedAt,
        loading: false,
      });
      return;
    }
    // A confirmed empty result is still a completed search; reopening it is free.
    if (
      !options.force &&
      this.snapshot.phase === "ready" &&
      (this.preview || this.snapshot.data?.results_verified === true) &&
      this.snapshot.data?.apify === "done" &&
      this.snapshot.data.total === 0 &&
      sameInput(input, this.snapshot.dataInput) &&
      matchesHome(this.snapshot.data, this.expected)
    ) {
      this.update({ input, draft: input, error: null });
      return;
    }
    this.cancelRead();
    const run = ++this.generation;
    const keepData = sameInput(input, this.snapshot.dataInput);
    this.verified = null;
    this.expected = null;
    this.submitted = true;
    this.postPending = true;
    this.jobMayBeRunning = true;
    this.polls = 0;
    this.update({
      phase: "locating",
      input,
      draft: input,
      error: null,
      startedAt: Date.now(),
      completedAt: null,
      loading: false,
      ...(!keepData ? { data: null, dataInput: null } : {}),
    });
    void this.submit(input, run);
  };
  private async submit(input: NearbyInput, run: number) {
    try {
      const body = { ...input, google: true };
      const result = this.preview
        ? await previewRequest<AddressResult>("/setup/address", {
            method: "POST",
            body: JSON.stringify(body),
          })
        : await api.post<AddressResult>("/setup/address", body);
      if (!this.current(run)) return;
      if (!Number.isFinite(result.lat) || !Number.isFinite(result.lng))
        throw new Error(
          "The saved home location could not be confirmed. Check its status before searching again.",
        );
      this.expected = {
        lat: result.lat,
        lng: result.lng,
        radius_mi: input.radius_mi,
      };
      this.jobMayBeRunning = result.apify === "running";
      this.update({ phase: "searching" });
    } catch (error) {
      if (!this.current(run)) return;
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500
      )
        this.jobMayBeRunning = false;
      this.update({
        phase: "error",
        error: errorMessage(error),
        loading: false,
      });
      return;
    } finally {
      this.postPending = false;
      if (this.current(run)) this.notifyHousehold();
    }
    if (this.current(run)) void this.readStatus(run);
  }
  private schedule(run: number) {
    if (!this.current(run)) return;
    if (++this.polls > MAX_POLLS) {
      this.update({
        phase: "error",
        loading: false,
        error:
          "The search is taking longer than expected. Check status again; no new search has been started.",
      });
      return;
    }
    this.timer = setTimeout(() => {
      void this.readStatus(run);
    }, POLL_MS);
  }
  private async readStatus(run: number) {
    if (!this.current(run) || this.postPending) return;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), GET_TIMEOUT_MS);
    this.update({ loading: true });
    try {
      const data = this.preview
        ? await previewRequest<NearbyStatus>("/setup/status", { method: "GET" })
        : await api.get<NearbyStatus>("/setup/status", {
            signal: controller.signal,
          });
      if (!this.current(run) || this.postPending) return;
      if (!matchesHome(data, this.expected)) {
        this.update({ loading: false });
        if (this.submitted) this.schedule(run);
        else this.update({ phase: "idle" });
        return;
      }
      const input =
        this.snapshot.input ||
        (this.household
          ? {
              address: this.household.address,
              radius_mi: this.household.radius_mi,
            }
          : this.snapshot.draft);
      this.verified = null;
      this.update({ data, dataInput: input, loading: false });
      if (data.apify === "running") {
        this.jobMayBeRunning = true;
        this.update({ phase: "searching", input, error: null });
        this.schedule(run);
        return;
      }
      this.jobMayBeRunning = false;
      if (["failed", "cancelled", "no token"].includes(data.apify)) {
        this.update({
          phase: "error",
          error:
            data.error ||
            "Nearby business search is unavailable. Previously available places are shown.",
        });
        return;
      }
      const completedAt =
        this.submitted && data.apify === "done"
          ? (this.snapshot.completedAt ?? Date.now())
          : null;
      const emptySuccess =
        data.apify === "done" &&
        data.places_source === "none" &&
        data.total === 0;
      const verifiedResults =
        data.results_verified === true && (liveSource(data) || emptySuccess);
      const ready = this.preview || verifiedResults;
      if (!this.preview && verifiedResults)
        this.verified = { input, data, completedAt };
      this.update({
        phase: ready ? "ready" : "idle",
        input,
        completedAt: ready ? completedAt : null,
        error: null,
      });
    } catch (error) {
      if (!this.current(run)) return;
      this.update({
        phase: "error",
        loading: false,
        error: controller.signal.aborted
          ? "Checking search status timed out. Check again to retrieve the existing search."
          : errorMessage(error),
      });
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
    }
  }
  reload = (): void => {
    if (this.postPending || !this.household) return;
    this.cancelRead();
    const run = ++this.generation;
    this.polls = 0;
    if (!this.expected) {
      const saved = {
        address: this.household.address,
        radius_mi: this.household.radius_mi,
      };
      if (this.snapshot.input && !sameInput(saved, this.snapshot.input)) {
        this.update({
          phase: "error",
          error:
            "The requested home has not been confirmed. Check the address before starting a new search.",
        });
        this.notifyHousehold();
        return;
      }
      this.expected = {
        ...this.household.home,
        radius_mi: this.household.radius_mi,
      };
    }
    this.update({ error: null });
    void this.readStatus(run);
  };
  retry = (): void => {
    if (this.postPending || this.snapshot.busy) return;
    if (!this.submitted || this.jobMayBeRunning || !this.snapshot.input)
      this.reload();
    else this.start(this.snapshot.input, { force: true });
  };
  dispose() {
    this.disposed = true;
    this.generation++;
    this.cancelRead();
    this.listeners.clear();
  }
}

const stores = new Map<string, NearbySearchStore>();

export function useNearbySearch() {
  const { state, preview, refresh } = useNightfall();
  const household = state?.household;
  const householdId =
    (household as (Household & { id?: string }) | undefined)?.id ||
    "current-household";
  const origin =
    typeof window === "undefined" ? "server" : window.location.origin;
  const key = `${origin}|${preview ? "preview" : "connected"}|${householdId}`;
  let store = stores.get(key);
  if (!store) {
    store = new NearbySearchStore(preview);
    stores.set(key, store);
  }
  store.refresh = refresh;
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  useEffect(() => {
    if (household) store.configure(household);
  }, [store, household]);
  return {
    ...snapshot,
    setDraft: store.setDraft,
    start: store.start,
    retry: store.retry,
    reload: store.reload,
  };
}

/** Isolate hook tests without touching backend state or a live search. */
export function resetNearbySearchForTests() {
  stores.forEach((store) => store.dispose());
  stores.clear();
}
