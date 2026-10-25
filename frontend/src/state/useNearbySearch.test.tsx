import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../data/api";
import {
  createPreviewNearby,
  createPreviewState,
  resetPreview,
} from "../data/preview";
import type { NearbyStatus } from "../data/types";
import { resetNearbySearchForTests, useNearbySearch } from "./useNearbySearch";

const mocks = vi.hoisted(() => ({
  context: {} as Record<string, unknown>,
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock("./NightfallProvider", () => ({ useNightfall: () => mocks.context }));
vi.mock("../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/api")>();
  return { ...actual, api: { get: mocks.get, post: mocks.post } };
});

const input = { address: "Home address", radius_mi: 1.5 };
function status(overrides: Partial<NearbyStatus> = {}): NearbyStatus {
  return {
    ...createPreviewNearby(createPreviewState()),
    address: "",
    places_source: "apify",
    results_verified: true,
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T19:00:00Z"));
  vi.clearAllMocks();
  resetNearbySearchForTests();
  resetPreview();
  const state = createPreviewState();
  state.household.address = input.address;
  mocks.context = {
    state,
    preview: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  mocks.get.mockReset().mockResolvedValue(status());
  mocks.post
    .mockReset()
    .mockResolvedValue({ ...status().home, apify: "running" });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
});
afterEach(() => {
  cleanup();
  resetNearbySearchForTests();
  expect(fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared nearby search", () => {
  it("hydrates matching live results after restart and reuses them without a paid POST", async () => {
    const { result } = renderHook(useNearbySearch);
    await flush();
    expect(result.current).toMatchObject({
      phase: "ready",
      saved: true,
      completedAt: null,
      input,
    });
    act(() => result.current.start({ ...input, address: " Home address " }));
    expect(api.post).not.toHaveBeenCalled();
    expect(result.current.completedAt).toBeNull();
    act(() => result.current.setDraft({ ...input, radius_mi: 2 }));
    expect(result.current.saved).toBe(false);
  });

  it("starts immediately, deduplicates across routes, and waits for the POST before reading new status", async () => {
    const post = deferred<{ lat: number; lng: number; apify: "running" }>();
    mocks.post.mockReturnValueOnce(post.promise);
    const first = renderHook(useNearbySearch);
    await flush();
    const next = { address: "New home", radius_mi: 2 };
    let returned: unknown = "not called";
    act(() => {
      returned = first.result.current.start(next);
    });
    expect(returned).toBeUndefined();
    expect(first.result.current).toMatchObject({
      phase: "locating",
      input: next,
      draft: next,
      data: null,
      saved: false,
    });
    first.unmount();
    const second = renderHook(useNearbySearch);
    act(() =>
      second.result.current.start(
        { address: "Another home", radius_mi: 3 },
        { force: true },
      ),
    );
    act(() => second.result.current.reload());
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/setup/address", {
      ...next,
      google: true,
    });
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(second.result.current.draft).toEqual(next);
    const nextStatus = status({
      home: { lat: 38, lng: -121, radius_mi: 2 },
      apify: "running",
    });
    mocks.get
      .mockResolvedValueOnce(nextStatus)
      .mockResolvedValueOnce({ ...nextStatus, apify: "done" });
    await act(async () =>
      post.resolve({ lat: 38, lng: -121, apify: "running" }),
    );
    expect(second.result.current.phase).toBe("searching");
    second.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const third = renderHook(useNearbySearch);
    expect(third.result.current).toMatchObject({
      phase: "ready",
      data: { home: nextStatus.home },
      input: next,
      saved: true,
    });
    expect(third.result.current.completedAt).not.toBeNull();
    const completedAt = third.result.current.completedAt;
    act(() => third.result.current.start(next));
    expect(third.result.current.completedAt).toBe(completedAt);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("ignores a hydration response that resolves during a newer POST", async () => {
    const old = deferred<NearbyStatus>();
    const post = deferred<{ lat: number; lng: number; apify: "running" }>();
    mocks.get.mockReturnValueOnce(old.promise);
    mocks.post.mockReturnValueOnce(post.promise);
    const { result } = renderHook(useNearbySearch);
    act(() => result.current.start({ address: "New home", radius_mi: 2 }));
    await act(async () => old.resolve(status({ apify: "cancelled" })));
    expect(result.current).toMatchObject({
      phase: "locating",
      data: null,
      error: null,
    });
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("does not accept status from another home or radius after the POST", async () => {
    const { result } = renderHook(useNearbySearch);
    await flush();
    const next = { address: "New home", radius_mi: 2 };
    mocks.post.mockResolvedValueOnce({ lat: 38, lng: -121, apify: "running" });
    mocks.get
      .mockResolvedValueOnce(status({ apify: "done" }))
      .mockResolvedValueOnce(
        status({ home: { lat: 38, lng: -121, radius_mi: 1.5 } }),
      )
      .mockResolvedValueOnce(
        status({ home: { lat: 38, lng: -121, radius_mi: 2 } }),
      );
    act(() => result.current.start(next));
    await flush();
    expect(result.current).toMatchObject({
      phase: "searching",
      data: null,
      saved: false,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.data).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current).toMatchObject({
      phase: "ready",
      saved: true,
      input: next,
    });
  });

  it("keeps same-area data on status failure and reloads without repeating the POST", async () => {
    const { result } = renderHook(useNearbySearch);
    await flush();
    const prior = result.current.data;
    mocks.get.mockRejectedValueOnce(new Error("Connection lost"));
    act(() => result.current.start(input, { force: true }));
    await flush();
    expect(result.current).toMatchObject({
      phase: "error",
      error: "Connection lost",
      saved: false,
      data: prior,
      draft: input,
    });
    mocks.get
      .mockResolvedValueOnce(status({ apify: "running" }))
      .mockResolvedValueOnce(status());
    act(() => result.current.retry());
    await flush();
    expect(result.current.phase).toBe("searching");
    expect(api.post).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.phase).toBe("ready");
  });

  it("retains the draft after a rejected address and POSTs again only on explicit retry", async () => {
    const { result } = renderHook(useNearbySearch);
    await flush();
    const next = { address: "Unknown home", radius_mi: 2 };
    mocks.post.mockRejectedValueOnce(new ApiError(404, "Address not found"));
    act(() => result.current.start(next));
    await flush();
    expect(result.current).toMatchObject({
      phase: "error",
      error: "Address not found",
      draft: next,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(api.post).toHaveBeenCalledTimes(1);
    act(() => result.current.retry());
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it("does not treat fixtures or wrong-home status as reusable saved results", async () => {
    mocks.get.mockResolvedValueOnce(status({ places_source: "fixture" }));
    const { result } = renderHook(useNearbySearch);
    await flush();
    expect(result.current).toMatchObject({
      phase: "idle",
      saved: false,
      completedAt: null,
    });
    act(() => result.current.start(input));
    expect(api.post).toHaveBeenCalledTimes(1);
    await flush();
  });

  it.each([false, undefined])(
    "does not reuse live rows without verified address metadata (%s)",
    async (results_verified) => {
      mocks.get.mockResolvedValue(status({ results_verified }));
      const { result } = renderHook(useNearbySearch);
      await flush();
      expect(result.current).toMatchObject({ phase: "idle", saved: false });
      expect(api.post).not.toHaveBeenCalled();
      act(() => result.current.start(input));
      expect(api.post).toHaveBeenCalledTimes(1);
      await flush();
      expect(result.current.saved).toBe(false);
    },
  );

  it("forgets a reusable cache when the server can no longer verify it", async () => {
    const { result } = renderHook(useNearbySearch);
    await flush();
    expect(result.current.saved).toBe(true);
    mocks.get.mockResolvedValue(status({ results_verified: false }));
    act(() => result.current.reload());
    await flush();
    expect(result.current.saved).toBe(false);
    act(() => result.current.start(input));
    expect(api.post).toHaveBeenCalledTimes(1);
    await flush();
  });

  it("isolates household scopes and preserves an edited draft across navigation", async () => {
    const first = renderHook(useNearbySearch);
    await flush();
    const draft = { address: "Typed, not submitted", radius_mi: 2.5 };
    act(() => first.result.current.setDraft(draft));
    first.unmount();
    const again = renderHook(useNearbySearch);
    expect(again.result.current.draft).toEqual(draft);
    const other = createPreviewState();
    mocks.context = {
      ...mocks.context,
      state: {
        ...other,
        household: {
          ...other.household,
          id: "other-household",
          address: "Another home",
        },
      },
    };
    again.rerender();
    await flush();
    expect(again.result.current.draft.address).toBe("Another home");
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("clears the former home cache when authoritative household location changes", async () => {
    const view = renderHook(useNearbySearch);
    await flush();
    const other = createPreviewState();
    other.household.address = "New saved home";
    other.household.home = { lat: 38, lng: -121 };
    mocks.context = { ...mocks.context, state: other };
    mocks.get.mockResolvedValueOnce(
      status({ home: { ...other.household.home, radius_mi: 1.5 } }),
    );
    view.rerender();
    await flush();
    expect(view.result.current).toMatchObject({
      saved: true,
      input: { address: "New saved home", radius_mi: 1.5 },
    });
    act(() => view.result.current.start(input));
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("keeps preview searches isolated even without a preview URL parameter", async () => {
    mocks.context = {
      ...mocks.context,
      preview: true,
      state: createPreviewState(),
    };
    const { result } = renderHook(useNearbySearch);
    await flush();
    act(() =>
      result.current.start({ address: "Preview address", radius_mi: 2 }),
    );
    await flush();
    expect(result.current).toMatchObject({
      phase: "ready",
      saved: false,
      data: { places_source: "preview" },
    });
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each(["idle", "skipped"] as const)(
    "does not mark %s stored results as a fresh completed search",
    async (apify) => {
      const { result } = renderHook(useNearbySearch);
      await flush();
      mocks.post.mockResolvedValueOnce({ ...status().home, apify });
      mocks.get.mockResolvedValueOnce(status({ apify }));
      act(() => result.current.start(input, { force: true }));
      await flush();
      expect(result.current.phase).toBe("ready");
      expect(result.current.completedAt).toBeNull();
    },
  );

  it("shows a confirmed zero-result search as complete without repeating it on reopen", async () => {
    const { result } = renderHook(useNearbySearch);
    await flush();
    mocks.get.mockResolvedValueOnce(
      status({
        apify: "done",
        places_source: "none",
        total: 0,
        hazards: 0,
        open: 0,
        hazards_ranked: [],
        call_first: [],
      }),
    );
    act(() => result.current.start(input, { force: true }));
    await flush();
    expect(result.current).toMatchObject({
      phase: "ready",
      saved: true,
      data: { total: 0 },
    });
    expect(result.current.completedAt).not.toBeNull();
    act(() => result.current.start(input));
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("bounds background polling and checks status rather than starting a duplicate job", async () => {
    const { result } = renderHook(useNearbySearch);
    await flush();
    mocks.get.mockResolvedValue(status({ apify: "running" }));
    act(() => result.current.start(input, { force: true }));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000 * 241);
    });
    expect(result.current.phase).toBe("error");
    expect(result.current.error).toContain("longer than expected");
    const count = mocks.get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(api.get).toHaveBeenCalledTimes(count);
    expect(api.post).toHaveBeenCalledTimes(1);
    act(() => result.current.retry());
    await flush();
    expect(result.current.phase).toBe("searching");
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});
