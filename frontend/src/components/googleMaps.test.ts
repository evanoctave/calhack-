import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ setOptions: vi.fn(), importLibrary: vi.fn() }));
vi.mock("@googlemaps/js-api-loader", () => sdk);
const originalAuth = (window as Window & { gm_authFailure?: () => void })
  .gm_authFailure;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "test-map-key");
  vi.stubEnv("VITE_GOOGLE_MAPS_MAP_ID", "");
  sdk.importLibrary.mockImplementation(async (name: string) => ({
    library: name,
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  (window as Window & { gm_authFailure?: () => void }).gm_authFailure =
    originalAuth;
});

describe("Google Maps SDK loader", () => {
  it("rejects a missing key before requesting any Google library", async () => {
    vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "  ");
    const { loadGoogleMaps } = await import("./googleMaps");
    await expect(loadGoogleMaps()).rejects.toThrow("not configured");
    expect(sdk.setOptions).not.toHaveBeenCalled();
    expect(sdk.importLibrary).not.toHaveBeenCalled();
  });

  it("shares one SDK request across concurrent and subsequent maps", async () => {
    const { loadGoogleMaps } = await import("./googleMaps");
    const first = loadGoogleMaps();
    const second = loadGoogleMaps();
    expect(first).toBe(second);
    await first;
    await loadGoogleMaps();
    expect(sdk.setOptions).toHaveBeenCalledExactlyOnceWith({
      key: "test-map-key",
      v: "weekly",
      language: "en",
      region: "US",
    });
    expect(sdk.importLibrary.mock.calls.map(([name]) => name)).toEqual([
      "maps",
      "marker",
      "core",
    ]);
  });

  it("allows retry after a library request fails without configuring the SDK twice", async () => {
    sdk.importLibrary.mockRejectedValueOnce(new Error("Network unavailable"));
    const { loadGoogleMaps } = await import("./googleMaps");
    await expect(loadGoogleMaps()).rejects.toThrow("Network unavailable");
    await expect(loadGoogleMaps()).resolves.toMatchObject({
      maps: { library: "maps" },
    });
    expect(sdk.setOptions).toHaveBeenCalledTimes(1);
  });

  it("remembers authentication failures for later routes and releases removed subscribers", async () => {
    const previous = vi.fn();
    const host = window as Window & { gm_authFailure?: () => void };
    host.gm_authFailure = previous;
    const { onGoogleMapsAuthFailure } = await import("./googleMaps");
    const removed = vi.fn(),
      current = vi.fn(),
      nextRoute = vi.fn();
    const unsubscribe = onGoogleMapsAuthFailure(removed);
    onGoogleMapsAuthFailure(current);
    unsubscribe();
    host.gm_authFailure?.();
    expect(removed).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledTimes(1);
    onGoogleMapsAuthFailure(nextRoute);
    expect(nextRoute).toHaveBeenCalledTimes(1);
  });
});
