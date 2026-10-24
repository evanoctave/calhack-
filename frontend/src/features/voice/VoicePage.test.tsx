import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewState } from "../../data/preview";
import { api } from "../../data/api";
import { VoicePage } from "./VoicePage";

const context = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../state/NightfallProvider", () => ({
  useNightfall: () => context.current,
}));
vi.mock("../../data/api", async () => {
  const actual = await vi.importActual("../../data/api");
  return { ...actual, api: { upload: vi.fn(), delete: vi.fn(), get: vi.fn() } };
});

function mount(path = "/voice/record?kind=introduction") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/voice/:step" element={<VoicePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  context.current = {
    state: createPreviewState(),
    preview: false,
    mutate: vi.fn(),
    refresh: vi.fn(),
  };
  vi.restoreAllMocks();
});

describe("Voice recording lifecycle", () => {
  it("previews an available non-introduction sample and its matching prompt", async () => {
    const state = createPreviewState();
    state.voice.samples = {
      introduction: false,
      reassurance: true,
      everyday: false,
    };
    context.current = { ...context.current, state };
    const sources: string[] = [];
    vi.stubGlobal(
      "Audio",
      class {
        constructor(src: string) {
          sources.push(src);
        }
        play = vi.fn().mockResolvedValue(undefined);
        pause = vi.fn();
      },
    );
    mount("/voice/preview");
    expect(
      screen.getByText(/Take your time. There’s no rush/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Hi Dad. It’s Sarah/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Listen to sample" }));
    await waitFor(() =>
      expect(sources).toEqual(["/voice/samples/reassurance.wav"]),
    );
  });

  it("opens a selected voice preview without cloning it again", async () => {
    const state = createPreviewState();
    state.voice.voice_id = "existing-voice-id";
    state.voice.samples = {
      introduction: false,
      reassurance: false,
      everyday: false,
    };
    const mutate = vi
      .fn()
      .mockResolvedValue({
        text: "Come inside.",
        line_source: "script",
        audio: { source: "mock" },
      });
    context.current = { ...context.current, state, mutate };
    mount("/voice/samples");
    fireEvent.click(
      screen.getByRole("button", { name: "Preview current voice" }),
    );
    expect(
      screen.getByRole("heading", { name: "Preview your voice" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Listen to sample" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate a preview" }));
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith("/voice/preview", expect.any(Object)),
    );
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("requires consent before opening the microphone and explains a permission denial", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal("MediaRecorder", class {});
    mount();
    const button = screen.getByRole("button", { name: "Record voice sample" });
    expect(button).toBeDisabled();
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Microphone access was not allowed",
    );
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it("stops a microphone granted after the recording screen has unmounted", async () => {
    let resolve!: (value: MediaStream) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((yes) => {
          resolve = yes;
        }),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal("MediaRecorder", class {});
    const stop = vi.fn();
    const capture = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const ui = mount();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Record voice sample" }),
    );
    ui.unmount();
    resolve(capture);
    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it("keeps the sample local for review until Save is pressed", async () => {
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi
          .fn()
          .mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
      },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        static isTypeSupported() {
          return true;
        }
        state = "inactive";
        mimeType = "audio/mp4";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob([new Uint8Array(2000)]) });
          this.onstop?.();
        }
      },
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:sample"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.mocked(api.upload).mockResolvedValue({ ok: true });
    mount();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Record voice sample" }),
    );
    await screen.findByRole("button", { name: "Stop & review" });
    clock.mockReturnValue(5000);
    fireEvent.click(screen.getByRole("button", { name: "Stop & review" }));
    await screen.findByRole("heading", { name: "Review your voice sample" });
    expect(api.upload).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Save sample" }));
    await waitFor(() => expect(api.upload).toHaveBeenCalledOnce());
    expect(vi.mocked(api.upload).mock.calls[0][0]).toBe(
      "/voice/samples/introduction",
    );
    expect(vi.mocked(api.upload).mock.calls[0][1]).toBeInstanceOf(FormData);
  });

  it("does not claim a recording still exists after reloading review", () => {
    mount("/voice/review");
    expect(
      screen.getByText(/unsaved recording is no longer available/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save sample" }),
    ).not.toBeInTheDocument();
  });
});
