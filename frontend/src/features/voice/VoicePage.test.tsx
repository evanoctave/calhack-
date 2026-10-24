import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const library = [
  {
    id: "voice-aster-001",
    name: "Aster",
    variant: "natural",
    file: "/samples/aster-natural.wav",
  },
  {
    id: "voice-aster-001",
    name: "Aster",
    variant: "warm",
    file: "/samples/aster-warm.wav",
  },
  {
    id: "voice-birch-002",
    name: "Birch (current)",
    variant: "natural",
    file: "/samples/birch-natural.wav",
  },
  {
    id: "voice-birch-002",
    name: "Birch (current)",
    variant: "warm",
    file: "/samples/birch-warm.wav",
  },
];

describe("Ready-made voice selection", () => {
  it("retains the current choice and style, plays both preview variants, and retries a failed selection", async () => {
    const state = createPreviewState();
    state.voice.voice_id = "voice-birch-002";
    state.voice.style = [1.1, "content"];
    const mutate = vi
      .fn()
      .mockRejectedValueOnce(new Error("Selection failed"))
      .mockResolvedValueOnce({ ok: true });
    context.current = { ...context.current, state, mutate };
    vi.mocked(api.get).mockResolvedValue(library);
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
    mount("/voice/presets");
    expect(await screen.findByRole("radio", { name: /Birch/ })).toBeChecked();
    expect(screen.getByRole("slider")).toHaveValue("1.1");
    expect(screen.getByLabelText("Emotion")).toHaveValue("content");
    fireEvent.click(screen.getByRole("radio", { name: /Aster/ }));
    fireEvent.click(screen.getByRole("button", { name: "Play Aster" }));
    await waitFor(() => expect(sources).toEqual(["/samples/aster-warm.wav"]));
    fireEvent.click(screen.getByRole("button", { name: "Natural" }));
    fireEvent.click(screen.getByRole("button", { name: "Play Aster" }));
    await waitFor(() => expect(sources[1]).toBe("/samples/aster-natural.wav"));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "1.15" } });
    fireEvent.change(screen.getByLabelText("Emotion"), {
      target: { value: "calm" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use Aster" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Selection failed",
    );
    expect(screen.getByRole("radio", { name: /Aster/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Use Aster" }));
    await screen.findByText("Call order");
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenLastCalledWith("/voice/select", {
      voice_id: "voice-aster-001",
      speed: 1.15,
      emotion: "calm",
    });
  });

  it("requires a library choice when the current voice is absent and uses teammate defaults only without style", async () => {
    const state = createPreviewState();
    state.voice.voice_id = "my-cloned-voice";
    state.voice.style = undefined as unknown as [number, string];
    const mutate = vi.fn().mockResolvedValue({ ok: true });
    context.current = { ...context.current, state, mutate };
    vi.mocked(api.get).mockResolvedValue(library);
    mount("/voice/presets");
    await screen.findByRole("radio", { name: /Aster/ });
    expect(
      screen.getByRole("button", { name: "Use selected voice" }),
    ).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Aster/ })).not.toBeChecked();
    expect(screen.getByRole("slider")).toHaveValue("0.95");
    expect(screen.getByLabelText("Emotion")).toHaveValue("calm");
    fireEvent.click(screen.getByRole("radio", { name: /Aster/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use Aster" }));
    await screen.findByText("Call order");
    expect(mutate).toHaveBeenCalledWith("/voice/select", {
      voice_id: "voice-aster-001",
      speed: 0.95,
      emotion: "calm",
    });
  });
});

function mount(path = "/voice/record?kind=introduction") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/voice/:step" element={<VoicePage />} />
          <Route path="/setup/contacts" element={<p>Call order</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(api.upload).mockReset();
  vi.mocked(api.delete).mockReset();
  vi.mocked(api.get).mockReset();
  context.current = {
    state: createPreviewState(),
    preview: false,
    mutate: vi.fn(),
    refresh: vi.fn(),
  };
});
afterEach(() => window.history.replaceState(null, "", "/"));

function prepareRecorder() {
  const stopTrack = vi.fn();
  const getUserMedia = vi
    .fn()
    .mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
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
  return { stopTrack, getUserMedia, clock };
}

async function recordAndStop(
  clock: ReturnType<typeof prepareRecorder>["clock"],
) {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Record voice sample" }));
  await screen.findByRole("button", { name: "Stop & save" });
  clock.mockReturnValue(5000);
  fireEvent.click(screen.getByRole("button", { name: "Stop & save" }));
  await screen.findByRole("heading", { name: "Review your voice sample" });
}

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
    const mutate = vi.fn().mockResolvedValue({
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

  it("uploads on Stop & save, shows progress, and keeps the waveform review for playback and deletion", async () => {
    const { stopTrack, clock } = prepareRecorder();
    let finishUpload!: (value: unknown) => void;
    vi.mocked(api.upload).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpload = resolve;
        }),
    );
    vi.mocked(api.delete).mockResolvedValue({ ok: true });
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
    mount();
    await recordAndStop(clock);
    expect(api.upload).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Uploading your sample",
    );
    expect(
      screen.getByLabelText("Recorded sample waveform"),
    ).toBeInTheDocument();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(vi.mocked(api.upload).mock.calls[0][0]).toBe(
      "/voice/samples/introduction",
    );
    expect(vi.mocked(api.upload).mock.calls[0][1].get("clip")).toBeInstanceOf(
      Blob,
    );
    await act(async () => finishUpload({ ok: true }));
    await screen.findByText(
      "Sample saved. Listen back or record another take.",
    );
    expect(
      screen.getByRole("heading", { name: "Review your voice sample" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "▷ Play sample" }));
    await waitFor(() => expect(sources).toEqual(["blob:sample"]));
    fireEvent.click(screen.getByRole("button", { name: "Delete sample" }));
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith("/voice/samples/introduction"),
    );
    await screen.findByRole("heading", { name: "A familiar AI voice" });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:sample");
  });

  it("retains a failed upload for retry without opening the microphone again", async () => {
    const { clock, getUserMedia } = prepareRecorder();
    vi.mocked(api.upload)
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce({ ok: true });
    mount("/voice/record?kind=reassurance");
    await recordAndStop(clock);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connection lost",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your take is still here",
    );
    expect(
      screen.getByLabelText("Recorded sample waveform"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await screen.findByText(
      "Sample saved. Listen back or record another take.",
    );
    expect(api.upload).toHaveBeenCalledTimes(2);
    for (const [path, data] of vi.mocked(api.upload).mock.calls) {
      expect(path).toBe("/voice/samples/reassurance");
      expect((data.get("clip") as Blob).size).toBe(2000);
    }
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("keeps automatic saving isolated in preview mode", async () => {
    const { clock } = prepareRecorder();
    window.history.replaceState(null, "", "/ui/index.html?preview=1");
    const actual =
      await vi.importActual<typeof import("../../data/api")>("../../data/api");
    vi.mocked(api.upload).mockImplementation(actual.api.upload);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    context.current = { ...context.current, preview: true };
    mount();
    await recordAndStop(clock);
    await screen.findByText("Sample saved to this preview only.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not claim a recording still exists after reloading review", () => {
    const state = createPreviewState();
    state.voice.samples.introduction = false;
    context.current = { ...context.current, state };
    mount("/voice/review");
    expect(
      screen.getByText(/local recording is no longer available/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save sample" }),
    ).not.toBeInTheDocument();
  });
});
