import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewState } from "../../data/preview";
import type { NightfallState } from "../../data/types";
import { HomePage } from "./HomePage";

const { context } = vi.hoisted(() => ({ context: vi.fn() }));
const { nearbyContext } = vi.hoisted(() => ({
  nearbyContext: vi.fn(() => ({ phase: "idle", busy: false, saved: false })),
}));
vi.mock("../../state/NightfallProvider", () => ({ useNightfall: context }));
vi.mock("../../state/useNearbySearch", () => ({
  useNearbySearch: nearbyContext,
}));
vi.mock("../live/useDoorVideo", () => ({
  useDoorVideo: () => ({
    src: undefined,
    live: false,
    status: "Camera unavailable",
  }),
}));
vi.mock("../../components/CameraFeed", () => ({
  CameraFeed: () => <div>Door camera</div>,
}));
vi.mock("../live/useDoorAudio", () => ({
  useDoorAudio: () => ({
    channels: { talking: "off", listening: "off" },
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function show(
  state: NightfallState | null,
  extra: Record<string, unknown> = {},
) {
  context.mockReturnValue({
    state,
    memberId: "TM-SARAH",
    preview: true,
    soundEnabled: true,
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...extra,
  });
  return render(
    <MemoryRouter>
      <HomePage />
      <Location />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Home current status and contact priority", () => {
  it("shows a confirmed return after an earlier family acknowledgement", () => {
    const state = createPreviewState("returned");
    state.incident!.acked_by = "TM-SARAH";
    state.incident!.acked_by_name = "Sarah";
    show(state);
    expect(
      screen.getByRole("heading", { name: "Dad is back inside" }),
    ).toBeVisible();
    expect(
      screen.getByText("Dad is back inside. Family calls have stopped."),
    ).toBeVisible();
    expect(
      screen.queryByText(/return is not confirmed/i),
    ).not.toBeInTheDocument();
  });

  it("ends help instructions when an acknowledged help incident is closed", () => {
    const state = createPreviewState("help");
    state.incident!.state = "CLOSED";
    state.incident!.cause = "help";
    state.incident!.acked_by = "TM-SARAH";
    state.incident!.acked_by_name = "Sarah";
    show(state);
    expect(screen.getByRole("heading", { name: "Watching" })).toBeVisible();
    expect(screen.getByText(/previous check-in is closed/)).toBeVisible();
    expect(
      screen.queryByText("Help button pressed · Check the door"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open current alert" }),
    ).not.toBeInTheDocument();
  });

  it("sorts real call tiers and groups family members who ring together", () => {
    const state = createPreviewState("watching");
    const [sarah, mike, linda] = state.household.tree;
    state.household.tree = [
      { ...linda, tier: 3 },
      { ...sarah, tier: 1 },
      { ...mike, tier: 2 },
      { ...sarah, id: "TM-ALEX", name: "Alex", tier: 1 },
    ];
    show(state);
    expect(
      screen.getByText("1 · Sarah + Alex → 2 · Mike → 3 · Linda (neighbor)"),
    ).toBeVisible();
    expect(state.household.tree[0].id).toBe(linda.id);
  });

  it("shows only speech from the current incident, with its event timestamp", () => {
    const state = createPreviewState("approach");
    const ts = "2026-10-24T10:03:00Z";
    show(state, {
      doorSpeech: {
        incident_id: state.incident!.id,
        text: "Please pause at the door.",
        ts,
      },
    });
    const speech = screen.getByText("“Please pause at the door.”");
    expect(speech).toBeVisible();
    expect(document.querySelector("time")?.dateTime).toBe(ts);
    expect(screen.getByText("Sample transcript")).toBeVisible();
    expect(screen.queryByText(/playing now/i)).not.toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Open door camera" });
    expect(
      speech.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it.each(["older-incident", undefined])(
    "does not reuse an unrelated or unscoped transcript (%s)",
    (incident_id) => {
      show(createPreviewState("approach"), {
        doorSpeech: { incident_id, text: "Stale transcript" },
      });
      expect(screen.queryByText(/Stale transcript/)).not.toBeInTheDocument();
    },
  );

  it("labels a human takeover without claiming the AI is playing", () => {
    const state = createPreviewState("approach");
    state.takeover_by = "TM-SARAH";
    show(state);
    expect(
      screen.getByText(
        "Sarah has taken over the door voice. Automatic voice is paused.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(/lines spoken|Cartesia|Claude/),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["Voice at the door", "/voice?returnTo=/home"],
    ["Care circle", "/setup/contacts?mode=edit&returnTo=/home"],
    ["Care profile", "/setup/profile?mode=edit&returnTo=/home"],
    ["Review care setup", "/setup"],
  ])("opens %s in the correct context", (label, path) => {
    show(createPreviewState("watching"));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
    expect(screen.getByTestId("location")).toHaveTextContent(path);
  });

  it("guides an unconnected phone to the connection step, without restarting setup", () => {
    show(createPreviewState("watching"), { soundEnabled: false });
    fireEvent.click(screen.getByRole("button", { name: "Check connections" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/setup/connect");
  });

  it("shows a connection failure instead of a fabricated watching status", () => {
    show(null, { error: "Server unavailable" });
    expect(
      screen.getByRole("heading", { name: "Nightfall is unavailable" }),
    ).toBeVisible();
    expect(screen.getByText("Server unavailable")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Watching" }),
    ).not.toBeInTheDocument();
  });

  it("marks retained state as stale when a refresh fails", () => {
    show(createPreviewState("watching"), { error: "Connection lost" });
    expect(
      screen.getByText("Status may be out of date. Connection lost"),
    ).toBeVisible();
  });
});
