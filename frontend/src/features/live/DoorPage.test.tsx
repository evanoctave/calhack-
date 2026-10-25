import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewState } from "../../data/preview";
import { DoorPage } from "./DoorPage";

const mocks = vi.hoisted(() => ({
  provider: vi.fn(),
  audio: vi.fn(),
  video: vi.fn(),
  mutate: vi.fn(),
  refresh: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  upload: vi.fn(),
  microphone: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("../../state/NightfallProvider", () => ({
  useNightfall: mocks.provider,
}));
vi.mock("./useDoorAudio", () => ({ useDoorAudio: mocks.audio }));
vi.mock("./useDoorVideo", () => ({ useDoorVideo: mocks.video }));
vi.mock("../../data/api", () => ({ api: { upload: mocks.upload } }));
vi.mock("./media", () => ({
  getMicrophone: mocks.microphone,
  supportedRecordingType: () => "audio/webm",
  userMediaError: (cause: unknown) => String(cause),
}));

type Direction = "talking" | "listening";
let channels: Record<Direction, "off" | "on">;
let expectedMicrophoneRequests = 0;
const originalShowModal = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
const originalClose = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "close",
);

function renderDoor() {
  return render(
    <MemoryRouter initialEntries={["/door"]}>
      <DoorPage />
    </MemoryRouter>,
  );
}

function expectOnlyTalkStopped() {
  expect(mocks.stop.mock.calls).toEqual([["talking"]]);
  expect(channels).toEqual({ talking: "off", listening: "on" });
  expect(
    screen.getByRole("button", { name: "Stop listening" }),
  ).toHaveAttribute("aria-pressed", "true");
}

beforeEach(() => {
  vi.clearAllMocks();
  expectedMicrophoneRequests = 0;
  // Keep the real controls and sheet; only the transport/media hooks are mocked.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockRejectedValue(new Error("Unexpected network request"));
  mocks.microphone.mockRejectedValue(
    new Error("Unexpected microphone request"),
  );
  mocks.upload.mockRejectedValue(new Error("Unexpected recording upload"));
  channels = { talking: "on", listening: "on" };
  mocks.stop.mockImplementation((direction?: Direction) => {
    // Model the hook contract so an accidental stop() also turns Listen off.
    if (direction) channels[direction] = "off";
    else channels.talking = channels.listening = "off";
  });
  mocks.start.mockImplementation(async (direction: Direction) => {
    channels[direction] = "on";
  });
  mocks.audio.mockImplementation(() => ({
    channels,
    error: "",
    start: mocks.start,
    stop: mocks.stop,
  }));
  mocks.video.mockReturnValue({
    src: undefined,
    live: false,
    status: "No camera",
  });
  mocks.mutate.mockResolvedValue({ ok: true, audio: { mode: "mock" } });
  mocks.refresh.mockResolvedValue(undefined);
  mocks.provider.mockReturnValue({
    state: createPreviewState("ringing"),
    memberId: "TM-SARAH",
    preview: false,
    mutate: mocks.mutate,
    refresh: mocks.refresh,
    doorSpeech: null,
    visitorMessage: "",
  });
});

afterEach(() => {
  cleanup();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.microphone).toHaveBeenCalledTimes(expectedMicrophoneRequests);
  expect(mocks.upload).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, original] of [
    ["showModal", originalShowModal],
    ["close", originalClose],
  ] as const) {
    if (original)
      Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

describe("independent door Talk and Listen controls", () => {
  it("keeps Listen on when sending a prepared AI phrase", async () => {
    renderDoor();
    fireEvent.click(
      screen.getByRole("button", { name: "▷ Please come back inside." }),
    );
    await screen.findByText(
      "Phrase sent using a browser/device voice fallback. Your selected AI voice was unavailable.",
    );
    expect(mocks.mutate).toHaveBeenCalledWith("/say", {
      member_id: "TM-SARAH",
      text: "Please come back inside.",
    });
    expectOnlyTalkStopped();
  });

  it.each([
    { mode: "browser_tts", source: "mock", url: "" },
    { mode: "cartesia", source: "mock", url: "" },
  ])("labels the backend voice fallback accurately: %j", async (audio) => {
    mocks.mutate.mockResolvedValue({ ok: true, audio });
    renderDoor();
    fireEvent.click(
      screen.getByRole("button", { name: "▷ Please come back inside." }),
    );
    await screen.findByText(/browser\/device voice fallback/);
    expect(
      screen.queryByText("Phrase sent to the door speaker."),
    ).not.toBeInTheDocument();
  });

  it("reports real Cartesia delivery separately", async () => {
    mocks.mutate.mockResolvedValue({
      ok: true,
      audio: { mode: "cartesia", source: "cartesia", url: "/voice/real.wav" },
    });
    renderDoor();
    fireEvent.click(
      screen.getByRole("button", { name: "▷ Please come back inside." }),
    );
    await screen.findByText("Phrase sent to the door speaker.");
    expect(
      screen.queryByText(/browser\/device voice fallback/),
    ).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "ignores an old member's phrase %s result and keeps the new text",
    async (reject) => {
      let finish!: (value: unknown) => void;
      let fail!: (reason: unknown) => void;
      mocks.mutate.mockReturnValue(
        new Promise((resolve, rejectRequest) => {
          finish = resolve;
          fail = rejectRequest;
        }),
      );
      const view = renderDoor();
      fireEvent.click(
        screen.getByRole("button", { name: "More voice controls" }),
      );
      fireEvent.change(screen.getByLabelText("Say in the family voice"), {
        target: { value: "Old phrase" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Speak this phrase" }),
      );
      const context = mocks.provider.getMockImplementation()!();
      mocks.provider.mockReturnValue({ ...context, memberId: "TM-MIKE" });
      view.rerender(
        <MemoryRouter initialEntries={["/door"]}>
          <DoorPage />
        </MemoryRouter>,
      );
      fireEvent.change(screen.getByLabelText("Say in the family voice"), {
        target: { value: "New member draft" },
      });
      await act(async () => {
        if (reject) fail(new Error("Old request failed"));
        else
          finish({
            ok: true,
            audio: {
              mode: "cartesia",
              source: "cartesia",
              url: "/voice/old.wav",
            },
          });
      });
      expect(screen.getByLabelText("Say in the family voice")).toHaveValue(
        "New member draft",
      );
      expect(
        screen.queryByText("Phrase sent to the door speaker."),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Old request failed")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Speak this phrase" }),
      ).toBeEnabled();
    },
  );

  it("does not open takeover controls from a previous member's late response", async () => {
    let finish!: (value: unknown) => void;
    mocks.mutate.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = renderDoor();
    fireEvent.click(
      screen.getByRole("button", { name: "Take over the voice" }),
    );
    const context = mocks.provider.getMockImplementation()!();
    mocks.provider.mockReturnValue({ ...context, memberId: "TM-MIKE" });
    view.rerender(
      <MemoryRouter initialEntries={["/door"]}>
        <DoorPage />
      </MemoryRouter>,
    );
    await act(async () => finish({ ok: true }));
    expect(
      screen.queryByText(/You have the door voice. Automatic speech/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Take over the voice" }),
    ).toBeEnabled();
  });

  it("keeps typed text when the door does not confirm acceptance", async () => {
    mocks.mutate.mockResolvedValue({ ok: false });
    renderDoor();
    fireEvent.click(
      screen.getByRole("button", { name: "More voice controls" }),
    );
    fireEvent.change(screen.getByLabelText("Say in the family voice"), {
      target: { value: "Please wait here" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Speak this phrase" }));
    await screen.findAllByText(/The door did not accept this phrase/);
    expect(screen.getByLabelText("Say in the family voice")).toHaveValue(
      "Please wait here",
    );
    expect(
      screen.queryByText("Phrase sent to the door speaker."),
    ).not.toBeInTheDocument();
  });

  it("keeps Listen on when sending a typed AI phrase", async () => {
    renderDoor();
    fireEvent.click(
      screen.getByRole("button", { name: "More voice controls" }),
    );
    fireEvent.change(screen.getByLabelText("Say in the family voice"), {
      target: { value: "Dad, please wait by the door." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Speak this phrase" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Say in the family voice")).toHaveValue(""),
    );
    expect(mocks.mutate).toHaveBeenCalledWith("/say", {
      member_id: "TM-SARAH",
      text: "Dad, please wait by the door.",
    });
    expectOnlyTalkStopped();
  });

  it.each([true, false])(
    "keeps Listen on when setting explicit takeover to %s",
    async (on) => {
      const context = mocks.provider.getMockImplementation()!();
      context.state.takeover_by = on ? null : "TM-SARAH";
      renderDoor();
      fireEvent.click(
        screen.getByRole("button", {
          name: on ? "Take over the voice" : "Hand back to Nightfall",
        }),
      );
      await waitFor(() => {
        expect(mocks.mutate).toHaveBeenCalledWith("/takeover", {
          member_id: "TM-SARAH",
          on,
        });
        expect(screen.queryByRole("button", { name: "Updating…" })).toBeNull();
      });
      expectOnlyTalkStopped();
    },
  );

  it("starts Talk without stopping Listen", async () => {
    channels.talking = "off";
    renderDoor();
    fireEvent.click(
      screen.getByRole("button", { name: "Talk through the door" }),
    );
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith("talking"));
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(channels).toEqual({ talking: "on", listening: "on" });
    expect(
      screen.getByRole("button", { name: "Stop listening" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("stops Talk without stopping Listen", async () => {
    renderDoor();
    fireEvent.click(screen.getByRole("button", { name: "Stop talking" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(mocks.start).not.toHaveBeenCalled();
    expectOnlyTalkStopped();
  });

  it("discards a pending recording stream when the family member changes", async () => {
    let resolveMicrophone!: (stream: MediaStream) => void;
    mocks.microphone.mockReturnValueOnce(
      new Promise<MediaStream>((resolve) => {
        resolveMicrophone = resolve;
      }),
    );
    expectedMicrophoneRequests = 1;
    const stopTrack = vi.fn();
    const oldStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const recorderConstructor = vi.fn();
    vi.stubGlobal("MediaRecorder", recorderConstructor);
    const view = renderDoor();
    fireEvent.click(
      screen.getByRole("button", { name: "More voice controls" }),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Hold to talk" }), {
      key: " ",
    });
    expect(mocks.microphone).toHaveBeenCalledOnce();

    const context = mocks.provider.getMockImplementation()!();
    mocks.provider.mockReturnValue({ ...context, memberId: "TM-MIKE" });
    view.rerender(
      <MemoryRouter initialEntries={["/door"]}>
        <DoorPage />
      </MemoryRouter>,
    );
    await act(async () => {
      resolveMicrophone(oldStream);
      await Promise.resolve();
    });

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(recorderConstructor).not.toHaveBeenCalled();
    expect(screen.queryByText(/Recording your real voice/)).toBeNull();
    expect(screen.getByRole("button", { name: "Hold to talk" })).toBeEnabled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
