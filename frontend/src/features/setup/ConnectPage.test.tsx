import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewState } from "../../data/preview";
import type { NightfallState } from "../../data/types";
import type { NearbySearchState } from "../../state/useNearbySearch";
import { ConnectPage } from "./ConnectPage";

const mocks = vi.hoisted(() => ({
  provider: vi.fn(),
  nearby: vi.fn(),
  video: vi.fn(),
  mutate: vi.fn(),
  testSound: vi.fn(),
}));
vi.mock("../../state/NightfallProvider", () => ({
  useNightfall: mocks.provider,
}));
vi.mock("../../state/useNearbySearch", () => ({
  useNearbySearch: mocks.nearby,
}));
vi.mock("../live/useDoorVideo", () => ({ useDoorVideo: mocks.video }));
let state: NightfallState;
let nearby: NearbySearchState;
let preview: boolean;
let memberId: string;
let soundEnabled: boolean;
let connectionError: string | null;
const realAudio = {
  ok: true,
  audio: { mode: "cartesia", source: "cartesia", url: "/voice/test.wav" },
};
function contents() {
  return (
    <MemoryRouter initialEntries={["/setup/connect"]}>
      <Routes>
        <Route path="/setup/connect" element={<ConnectPage />} />
        <Route path="/home" element={<p>Home destination</p>} />
      </Routes>
    </MemoryRouter>
  );
}
const mount = () => render(contents());
const start = () => screen.getByRole("button", { name: "Start night watch" });
const play = () =>
  screen.getByRole("button", { name: "Play voice at the door" });
async function finishChecks() {
  fireEvent.click(screen.getByRole("button", { name: "Test phone sound" }));
  await screen.findByText(/Test tone played/);
  fireEvent.click(play());
  fireEvent.click(
    await screen.findByRole("button", { name: "I heard the selected voice" }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  state = createPreviewState("watching");
  state.incident = null;
  state.night_mode = false;
  state.live_frame = true;
  state.voice = {
    ...state.voice,
    voice_id: "real-selected-voice",
    source: "clone",
    name: "Sarah",
    mock: false,
  };
  preview = false;
  memberId = "TM-SARAH";
  soundEnabled = true;
  connectionError = null;
  nearby = {
    phase: "ready",
    data: null,
    dataInput: null,
    input: null,
    draft: {
      address: state.household.address,
      radius_mi: state.household.radius_mi,
    },
    error: null,
    startedAt: null,
    completedAt: null,
    saved: true,
    loading: false,
    busy: false,
  };
  mocks.provider.mockImplementation(() => ({
    state,
    memberId,
    preview,
    loading: false,
    error: connectionError,
    soundEnabled,
    testSound: mocks.testSound,
    mutate: mocks.mutate,
  }));
  mocks.nearby.mockImplementation(() => nearby);
  mocks.video.mockReturnValue({
    src: "blob:recent-camera",
    live: true,
    status: "Live door camera",
  });
  mocks.mutate.mockImplementation(async (path: string) =>
    path === "/say" ? realAudio : { night_mode: true },
  );
  mocks.testSound.mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected real network request");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("connection setup checks", () => {
  it("does not auto-arm, distinguishes sent from heard, and sends only the explicit target actions", async () => {
    mount();
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.testSound).not.toHaveBeenCalled();
    expect(start()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Test phone sound" }));
    await screen.findByText(/Test tone played/);
    fireEvent.click(play());
    await screen.findByText(/Sent to the door/);
    expect(start()).toBeDisabled();
    expect(mocks.mutate.mock.calls).toEqual([
      [
        "/say",
        {
          member_id: "TM-SARAH",
          text: "This is Nightfall. The door speaker is ready.",
        },
      ],
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "I heard the selected voice" }),
    );
    expect(start()).toBeEnabled();
    fireEvent.click(start());
    await screen.findByText("Home destination");
    expect(mocks.mutate.mock.calls).toEqual([
      [
        "/say",
        {
          member_id: "TM-SARAH",
          text: "This is Nightfall. The door speaker is ready.",
        },
      ],
      ["/arm", { on: true }],
    ]);
  });
  it("does not let browser fallback verify the selected voice", async () => {
    mocks.mutate.mockResolvedValue({
      ok: true,
      audio: { mode: "browser_tts", source: "mock", url: "" },
    });
    mount();
    fireEvent.click(play());
    await screen.findByText(/browser\/device voice fallback/);
    expect(
      screen.queryByRole("button", { name: "I heard the selected voice" }),
    ).not.toBeInTheDocument();
    expect(start()).toBeDisabled();
  });
  it("requires a successful send before accepting hearing confirmation", async () => {
    mocks.mutate.mockResolvedValue({ ...realAudio, ok: false });
    mount();
    fireEvent.click(play());
    await screen.findByText(/did not accept the test/);
    expect(
      screen.queryByRole("button", { name: "I heard the selected voice" }),
    ).not.toBeInTheDocument();
  });
  it("invalidates confirmation on disconnect, voice change, and member change", async () => {
    const view = mount();
    await finishChecks();
    expect(start()).toBeEnabled();
    mocks.video.mockReturnValue({
      src: undefined,
      live: false,
      status: "Camera disconnected",
    });
    view.rerender(contents());
    expect(start()).toBeDisabled();
    mocks.video.mockReturnValue({
      src: "blob:new-frame",
      live: true,
      status: "Live door camera",
    });
    view.rerender(contents());
    expect(
      screen.queryByText("Selected voice heard ✓"),
    ).not.toBeInTheDocument();
    await finishChecks();
    state.voice.voice_id = "different-real-voice";
    view.rerender(contents());
    expect(
      screen.queryByText("Selected voice heard ✓"),
    ).not.toBeInTheDocument();
    await finishChecks();
    memberId = "TM-MIKE";
    view.rerender(contents());
    expect(
      screen.queryByText("Selected voice heard ✓"),
    ).not.toBeInTheDocument();
  });
  it("ignores a late response for the old family member", async () => {
    let resolve!: (value: typeof realAudio) => void;
    mocks.mutate.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = mount();
    fireEvent.click(play());
    memberId = "TM-MIKE";
    view.rerender(contents());
    await act(async () => resolve(realAudio));
    expect(screen.queryByText(/Sent to the door/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "I heard the selected voice" }),
    ).not.toBeInTheDocument();
  });
  it.each(["speed", "emotion"])(
    "requires a new door test after the same voice’s %s changes",
    async (setting) => {
      const view = mount();
      const originalId = state.voice.voice_id;
      await finishChecks();
      expect(start()).toBeEnabled();
      state.voice.style =
        setting === "speed"
          ? [state.voice.style[0] + 0.1, state.voice.style[1]]
          : [state.voice.style[0], "warm"];
      view.rerender(contents());
      expect(state.voice.voice_id).toBe(originalId);
      expect(
        screen.queryByText("Selected voice heard ✓"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/Sent to the door/)).not.toBeInTheDocument();
      expect(start()).toBeDisabled();
    },
  );
  it("clears Sent and Heard on connection failure and requires retesting after reconnect", async () => {
    const view = mount();
    await finishChecks();
    expect(start()).toBeEnabled();
    const calls = mocks.mutate.mock.calls.length;
    connectionError = "Connection lost";
    view.rerender(contents());
    expect(play()).toBeDisabled();
    expect(
      screen.queryByText("Selected voice heard ✓"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "I heard the selected voice" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Sent to the door/)).not.toBeInTheDocument();
    fireEvent.click(play());
    expect(mocks.mutate).toHaveBeenCalledTimes(calls);
    connectionError = null;
    view.rerender(contents());
    expect(play()).toBeEnabled();
    expect(start()).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "I heard the selected voice" }),
    ).not.toBeInTheDocument();
  });
  it("ignores a pre-disconnection send response even after reconnecting", async () => {
    let resolve!: (value: typeof realAudio) => void;
    mocks.mutate.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = mount();
    fireEvent.click(play());
    connectionError = "Connection lost";
    view.rerender(contents());
    connectionError = null;
    view.rerender(contents());
    await act(async () => resolve(realAudio));
    expect(screen.queryByText(/Sent to the door/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "I heard the selected voice" }),
    ).not.toBeInTheDocument();
    expect(play()).toBeEnabled();
  });
  it.each([
    "CONVERSATION",
    "DOOR_OPEN",
    "ESCALATING",
    "EXHAUSTED",
    "ACKED",
    "VISITOR",
    "WATCHING",
  ] as const)("lets an active %s event take precedence", (incidentState) => {
    state.incident = createPreviewState("ringing").incident!;
    state.incident.state = incidentState;
    mount();
    expect(
      screen.getByRole("link", { name: "Open the alert" }),
    ).toHaveAttribute("href", "/incident");
    expect(
      screen.queryByRole("button", { name: "Test phone sound" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Play voice at the door" }),
    ).not.toBeInTheDocument();
    expect(start()).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it.each(["RETURNED", "CLOSED", "self_other"])(
    "allows checks for resolved %s",
    (outcome) => {
      state.incident = createPreviewState("ringing").incident!;
      if (outcome === "self_other") state.incident.checkin = "self_other";
      else state.incident.state = outcome as "RETURNED" | "CLOSED";
      mount();
      expect(
        screen.getByRole("button", { name: "Test phone sound" }),
      ).toBeEnabled();
      expect(
        screen.queryByRole("link", { name: "Open the alert" }),
      ).not.toBeInTheDocument();
    },
  );
  it("accepts the saved address while nearby businesses are still searching", async () => {
    nearby.phase = "searching";
    nearby.busy = true;
    nearby.input = { ...nearby.draft };
    mount();
    await finishChecks();
    expect(
      screen.getByText(/Nearby businesses are still loading/),
    ).toBeInTheDocument();
    expect(start()).toBeEnabled();
  });
  it.each([
    "locating",
    "changed draft",
    "changed input",
    "missing coordinates",
  ])("blocks when the address is %s", async (reason) => {
    if (reason === "locating") nearby.phase = "locating";
    if (reason === "changed draft") nearby.draft.address = "Different address";
    if (reason === "changed input")
      nearby.input = { ...nearby.draft, radius_mi: 5 };
    if (reason === "missing coordinates") state.household.home.lat = NaN;
    mount();
    await finishChecks();
    expect(start()).toBeDisabled();
  });
  it("requires a recent rendered camera image and a nonmock voice", () => {
    state.live_frame = false;
    const view = mount();
    expect(play()).toBeDisabled();
    state.live_frame = true;
    state.voice.mock = true;
    view.rerender(contents());
    expect(play()).toBeDisabled();
    state.voice.mock = false;
    mocks.video.mockReturnValue({
      src: undefined,
      live: false,
      status: "Waiting for image",
    });
    view.rerender(contents());
    expect(play()).toBeDisabled();
  });
  it("requires another phone test after browser audio suspension", async () => {
    const view = mount();
    await finishChecks();
    soundEnabled = false;
    view.rerender(contents());
    expect(start()).toBeDisabled();
    soundEnabled = true;
    view.rerender(contents());
    expect(start()).toBeDisabled();
  });
  it("does not navigate home on an unsuccessful arm response", async () => {
    mocks.mutate.mockImplementation(async (path: string) =>
      path === "/say" ? realAudio : { night_mode: false },
    );
    mount();
    await finishChecks();
    fireEvent.click(start());
    await screen.findByText(/Night watch did not turn on/);
    expect(screen.queryByText("Home destination")).not.toBeInTheDocument();
  });
  it("goes home when already armed without another arm command", async () => {
    state.night_mode = true;
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Go home" }));
    await screen.findByText("Home destination");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("keeps preview isolated and always permits Connect later", async () => {
    preview = true;
    mount();
    expect(
      screen.getByRole("button", { name: "Test phone sound" }),
    ).toBeDisabled();
    expect(play()).toBeDisabled();
    expect(start()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Connect later" }));
    await screen.findByText("Home destination");
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.testSound).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
