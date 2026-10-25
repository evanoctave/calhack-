import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleMapLibraries } from "./googleMaps";
import MapView from "./MapView";

const mocks = vi.hoisted(() => ({
  key: vi.fn(),
  load: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("./googleMaps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./googleMaps")>()),
  googleMapsKey: mocks.key,
  loadGoogleMaps: mocks.load,
  onGoogleMapsAuthFailure: mocks.subscribe,
}));

const home = { lat: 37.8, lng: -122.44, radius_mi: 1.5 };
const hazard = {
  name: "Waterfront",
  lat: 37.81,
  lng: -122.43,
  distance_mi: 0.5,
};
let authFailure: (() => void) | undefined;

function createSdk() {
  const maps: FakeMap[] = [];
  const circles: FakeCircle[] = [];
  const pins: FakeMarker[] = [];
  const windows: FakeInfoWindow[] = [];
  const clearInstanceListeners = vi.fn();
  class FakeMap {
    fitBounds = vi.fn();
    constructor(
      public element: HTMLElement,
      public options: google.maps.MapOptions,
    ) {
      maps.push(this);
    }
  }
  class FakeCircle {
    setMap = vi.fn();
    getBounds = vi.fn(() => ({
      area: this.options.center,
      radius: this.options.radius,
    }));
    constructor(public options: google.maps.CircleOptions) {
      circles.push(this);
    }
  }
  class FakeInfoWindow {
    content: HTMLElement | null = null;
    open = vi.fn();
    close = vi.fn();
    setContent = vi.fn((value: HTMLElement) => {
      this.content = value;
    });
    constructor() {
      windows.push(this);
    }
  }
  class FakePin {
    element = document.createElement("span");
    constructor(public options: google.maps.marker.PinElementOptions) {}
  }
  class FakeMarker {
    map: unknown;
    callbacks = new Map<string, () => void>();
    removers: ReturnType<typeof vi.fn>[] = [];
    constructor(
      public options: google.maps.marker.AdvancedMarkerElementOptions,
    ) {
      this.map = options.map;
      pins.push(this);
    }
    addListener(event: string, callback: () => void) {
      this.callbacks.set(event, callback);
      const remove = vi.fn(() => this.callbacks.delete(event));
      this.removers.push(remove);
      return { remove };
    }
  }
  const libraries = {
    maps: { Map: FakeMap, Circle: FakeCircle, InfoWindow: FakeInfoWindow },
    marker: { PinElement: FakePin, AdvancedMarkerElement: FakeMarker },
    core: { event: { clearInstanceListeners } },
  } as unknown as GoogleMapLibraries;
  return { maps, circles, pins, windows, clearInstanceListeners, libraries };
}
let sdk: ReturnType<typeof createSdk>;

beforeEach(() => {
  vi.clearAllMocks();
  sdk = createSdk();
  mocks.key.mockReturnValue("test-map-key");
  mocks.load.mockResolvedValue(sdk.libraries);
  mocks.subscribe.mockImplementation((listener: () => void) => {
    authFailure = listener;
    return () => {
      authFailure = undefined;
    };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function ready() {
  return screen.findByRole("button", { name: "Show search area" });
}

describe("Google Maps search area", () => {
  it("does not load an SDK or show the former map screenshot when no key is configured", () => {
    mocks.key.mockReturnValue("");
    render(<MapView home={home} preview />);
    expect(screen.getByText("Google Maps is not connected yet")).toBeVisible();
    expect(
      screen.getByText("You can still use the place details below."),
    ).toBeVisible();
    expect(
      screen.getByText(/Sample places.*not Dad’s live location/),
    ).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("blocks invalid home coordinates without contacting the map provider", () => {
    render(<MapView home={{ lat: 100, lng: -122 }} />);
    expect(screen.getByText("Home location is unavailable")).toBeVisible();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("uses the real map adapter in preview with a radius and categorized valid pins", async () => {
    render(
      <MapView
        home={home}
        preview
        hazards={[hazard, { name: "Invalid", lat: NaN, lng: 0 }]}
        callFirst={[{ name: "Cafe", lat: 37.799, lng: -122.441 }]}
        familiar={[{ name: "Church", lat: 37.79, lng: -122.44 }]}
      />,
    );
    await ready();
    expect(sdk.maps).toHaveLength(1);
    expect(sdk.circles[0].options.radius).toBeCloseTo(1.5 * 1609.344);
    expect(sdk.pins.map((pin) => pin.options.title)).toEqual([
      "Home · Home",
      "Hazard · Waterfront",
      "Call first · Cafe",
      "Familiar place · Church",
    ]);
    expect(
      screen.getByRole("region", { name: "Google Maps search area" }),
    ).toBeVisible();
    expect(
      screen.getByText(/Sample places.*not Dad’s live location/),
    ).toBeVisible();
  });

  it("renders untrusted place names as text and opens directions for verified coordinates", async () => {
    const name = '<img src=x onerror="alert(1)">';
    render(
      <MapView
        home={home}
        preview
        hazards={[{ ...hazard, name, maps_url: "javascript:alert(1)" }]}
      />,
    );
    await ready();
    act(() => sdk.pins[1].callbacks.get("click")?.());
    const popup = sdk.windows[0].content!;
    expect(popup.querySelector("strong")?.textContent).toBe(name);
    expect(popup.querySelector("img")).toBeNull();
    expect(popup.textContent).toContain("Sample place");
    const link = popup.querySelector("a")!;
    const url = new URL(link.href);
    expect(url.origin).toBe("https://www.google.com");
    expect(url.searchParams.get("destination")).toBe("37.81,-122.43");
    expect(link.rel).toBe("noopener noreferrer");
    expect(sdk.windows[0].open).toHaveBeenCalled();
  });

  it("refreshes places without recreating the map or resetting the viewport", async () => {
    const view = render(<MapView home={home} hazards={[hazard]} />);
    await ready();
    const originalPins = [...sdk.pins];
    expect(sdk.maps[0].fitBounds).toHaveBeenCalledTimes(1);
    view.rerender(
      <MapView
        home={{ ...home }}
        hazards={[{ ...hazard, name: "Updated waterfront" }]}
      />,
    );
    await waitFor(() =>
      expect(sdk.pins.at(-1)?.options.title).toBe(
        "Hazard · Updated waterfront",
      ),
    );
    expect(sdk.maps).toHaveLength(1);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(sdk.maps[0].fitBounds).toHaveBeenCalledTimes(1);
    expect(originalPins.every((pin) => pin.map === null)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show search area" }));
    expect(sdk.maps[0].fitBounds).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(sdk.pins.every((pin) => pin.map === null)).toBe(true);
    expect(sdk.clearInstanceListeners).toHaveBeenCalledWith(sdk.maps[0]);
  });

  it("does not create a map after navigating away while the SDK is loading", async () => {
    let resolve!: (value: GoogleMapLibraries) => void;
    const loading = new Promise<GoogleMapLibraries>((done) => {
      resolve = done;
    });
    mocks.load.mockReturnValue(loading);
    const view = render(<MapView home={home} />);
    view.unmount();
    await act(async () => {
      resolve(sdk.libraries);
      await loading;
    });
    expect(sdk.maps).toHaveLength(0);
    expect(authFailure).toBeUndefined();
  });

  it("keeps place guidance available on load failure and supports an explicit retry", async () => {
    mocks.load.mockRejectedValueOnce(new Error("Offline"));
    render(<MapView home={home} />);
    expect(await screen.findByText("Google Maps couldn’t load")).toBeVisible();
    expect(
      screen.getByText("You can still use the place details below."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(sdk.maps).toHaveLength(1);
  });

  it("stops presenting a loaded map as available when Google rejects authentication", async () => {
    render(<MapView home={home} />);
    await ready();
    act(() => authFailure?.());
    expect(screen.getByText("Google Maps couldn’t load")).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Google Maps search area" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show search area" }),
    ).not.toBeInTheDocument();
  });
});
