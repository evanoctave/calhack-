import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NightfallContextValue } from "../../state/NightfallProvider";
import type { AgentReply, NightfallState } from "../../data/types";
import { CallPage } from "./CallPage";

const { mockUse, get, mutate } = vi.hoisted(() => ({
  mockUse: vi.fn(),
  get: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("../../state/NightfallProvider", () => ({ useNightfall: mockUse }));
vi.mock("../../data/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../data/api")>();
  return { ...original, api: { ...original.api, get } };
});

const state = {
  household: { person_name: "Dad" },
  incident: { id: "INC-1", state: "ESCALATING", acked_by: null },
} as NightfallState;
function renderCall() {
  return render(
    <MemoryRouter initialEntries={["/incident/call"]}>
      <CallPage />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mockUse.mockReturnValue({
    state,
    memberId: "TM-SARAH",
    preview: true,
    mutate,
    refresh: vi.fn(),
    enableSound: vi.fn().mockResolvedValue(undefined),
  } as Partial<NightfallContextValue>);
  get.mockResolvedValue({
    say: "Dad left home. Where would you like to start?",
    audio: {},
  });
  mutate.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function changeState(view: ReturnType<typeof render>, next: NightfallState) {
  const context = mockUse.mock.results.at(-1)?.value as NightfallContextValue;
  mockUse.mockReturnValue({ ...context, state: next });
  view.rerender(
    <MemoryRouter initialEntries={["/incident/call"]}>
      <CallPage />
    </MemoryRouter>,
  );
}

describe("Nightfall call controls", () => {
  it("answers the call without acknowledging the incident", async () => {
    renderCall();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect to Nightfall" }),
    );
    await screen.findByText("Dad left home. Where would you like to start?");
    expect(mutate).toHaveBeenCalledWith("/answer", {
      incident_id: "INC-1",
      member_id: "TM-SARAH",
    });
    expect(mutate).not.toHaveBeenCalledWith("/ack", expect.anything());
    expect(get).toHaveBeenCalledWith("/agent/opening/INC-1/TM-SARAH");
  });
  it("keeps questions available after an acknowledgement when done is false", async () => {
    renderCall();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect to Nightfall" }),
    );
    await screen.findByText("Ready for your question");
    mutate.mockResolvedValueOnce({
      say: "Other calls stopped. I can still help.",
      ack: true,
      done: false,
      audio: {},
    });
    fireEvent.change(screen.getByLabelText("Ask Nightfall"), {
      target: { value: "I’m on my way. Where should I look?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await screen.findByText("Other calls stopped. I can still help.");
    expect(screen.getByLabelText("Ask Nightfall")).toBeEnabled();
    expect(screen.queryByText("Call ended")).not.toBeInTheDocument();
  });
  it("closes input when the agent explicitly ends the call", async () => {
    renderCall();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect to Nightfall" }),
    );
    await screen.findByText("Ready for your question");
    mutate.mockResolvedValueOnce({
      say: "Thank you. The call is complete.",
      ack: true,
      done: true,
      audio: {},
    });
    fireEvent.change(screen.getByLabelText("Ask Nightfall"), {
      target: { value: "I’ve got him" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Ask Nightfall")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Back to the alert" }),
    ).toBeVisible();
  });
  it("loads an already-answered call in Strict Mode without an opening loop", async () => {
    render(
      <StrictMode>
        <MemoryRouter
          initialEntries={[
            { pathname: "/incident/call", state: { answered: "INC-1" } },
          ]}
        >
          <CallPage />
        </MemoryRouter>
      </StrictMode>,
    );
    await screen.findByText("Dad left home. Where would you like to start?");
    expect(get.mock.calls.length).toBeLessThanOrEqual(2);
    expect(mutate).not.toHaveBeenCalledWith("/answer", expect.anything());
  });
  it("stops accepting questions as soon as the server confirms a return", async () => {
    const view = renderCall();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect to Nightfall" }),
    );
    await screen.findByText("Ready for your question");
    const context = mockUse.mock.results[0].value as NightfallContextValue;
    mockUse.mockReturnValue({
      ...context,
      state: { ...state, incident: { ...state.incident, state: "RETURNED" } },
    });
    view.rerender(
      <MemoryRouter initialEntries={["/incident/call"]}>
        <CallPage />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Ask Nightfall")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/Dad is back inside/)).toBeVisible();
  });
  it("discards an in-flight opening after reset and starts a new incident with no old transcript", async () => {
    let finish: (reply: AgentReply) => void = () => undefined;
    get.mockReturnValueOnce(
      new Promise<AgentReply>((resolve) => {
        finish = resolve;
      }),
    );
    const view = renderCall();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect to Nightfall" }),
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    changeState(view, { ...state, incident: null });
    await act(async () =>
      finish({
        say: "Old incident reply",
        audio: { url: "/old-audio" },
      } as AgentReply),
    );
    expect(
      screen.getByText("There is no current incident to discuss."),
    ).toBeVisible();
    expect(screen.queryByText("Old incident reply")).not.toBeInTheDocument();
    changeState(view, {
      ...state,
      incident: { ...state.incident!, id: "INC-2" },
    });
    expect(
      screen.getByRole("button", { name: "Connect to Nightfall" }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect to Nightfall" }),
    );
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith("/agent/opening/INC-2/TM-SARAH"),
    );
    expect(screen.queryByText("Old incident reply")).not.toBeInTheDocument();
  });
  it("pauses active audio and aborts speech recognition on server reset", async () => {
    const pause = vi.fn(),
      abort = vi.fn();
    vi.stubGlobal(
      "Audio",
      class {
        pause = pause;
        play = vi.fn().mockResolvedValue(undefined);
        onended = null;
        onerror = null;
      },
    );
    vi.stubGlobal(
      "SpeechRecognition",
      class {
        start = vi.fn();
        abort = abort;
        onend = null;
        onresult = null;
        onerror = null;
      },
    );
    mockUse.mockReturnValue({
      ...mockUse.getMockImplementation()?.(),
      preview: false,
    });
    get.mockResolvedValueOnce({
      say: "Opening",
      audio: { url: "/mock-voice.wav" },
    });
    const view = renderCall();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect to Nightfall" }),
    );
    await screen.findByText("Nightfall is speaking…");
    fireEvent.click(screen.getByRole("button", { name: "Speak" }));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Listening…")).toBeVisible();
    changeState(view, { ...state, incident: null });
    expect(abort).toHaveBeenCalledTimes(1);
  });
  it("does not fetch an opening if reset occurs while Answer is pending", async () => {
    let finish: (value: unknown) => void = () => undefined;
    mutate.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = renderCall();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect to Nightfall" }),
    );
    await waitFor(() => expect(mutate).toHaveBeenCalled());
    changeState(view, { ...state, incident: null });
    await act(async () => finish({ ok: true }));
    expect(get).not.toHaveBeenCalled();
  });
  it("stops playing an old incident and requires a fresh connection when its ID changes", async () => {
    const pause = vi.fn();
    vi.stubGlobal(
      "Audio",
      class {
        pause = pause;
        play = vi.fn().mockResolvedValue(undefined);
        onended = null;
        onerror = null;
      },
    );
    mockUse.mockReturnValue({
      ...mockUse.getMockImplementation()?.(),
      preview: false,
    });
    get.mockResolvedValueOnce({
      say: "The first incident briefing",
      audio: { url: "/first.wav" },
    });
    const view = renderCall();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect to Nightfall" }),
    );
    await screen.findByText("Nightfall is speaking…");
    changeState(view, {
      ...state,
      incident: { ...state.incident!, id: "INC-2" },
    });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText("The first incident briefing"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect to Nightfall" }),
    ).toBeEnabled();
    expect(get).toHaveBeenCalledTimes(1);
  });
});

class TestAudio {
  static all: TestAudio[] = [];
  static fail = false;
  pause = vi.fn();
  play = vi.fn(() =>
    TestAudio.fail
      ? Promise.reject(new Error("Playback failed"))
      : Promise.resolve(),
  );
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    TestAudio.all.push(this);
  }
}
class TestRecognition {
  static all: TestRecognition[] = [];
  start = vi.fn();
  abort = vi.fn();
  onresult:
    | ((event: { results: Array<Array<{ transcript: string }>> }) => void)
    | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor() {
    TestRecognition.all.push(this);
  }
}
class TestUtterance {
  static all: TestUtterance[] = [];
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {
    TestUtterance.all.push(this);
  }
}
function mediaHarness({
  preview = false,
  withAudio = true,
  failedAudio = false,
} = {}) {
  vi.useFakeTimers();
  TestAudio.all = [];
  TestAudio.fail = failedAudio;
  TestRecognition.all = [];
  TestUtterance.all = [];
  const synthesis = { speak: vi.fn(), cancel: vi.fn() };
  vi.stubGlobal("Audio", TestAudio);
  vi.stubGlobal("SpeechRecognition", TestRecognition);
  vi.stubGlobal("SpeechSynthesisUtterance", TestUtterance);
  vi.stubGlobal("speechSynthesis", synthesis);
  mockUse.mockReturnValue({ ...mockUse.getMockImplementation()?.(), preview });
  get.mockResolvedValue({
    say: "Current call briefing",
    audio: withAudio ? { url: "/opening.wav" } : {},
    done: false,
  });
  return synthesis;
}
async function connectMedia() {
  const view = renderCall();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Connect to Nightfall" }),
    );
  });
  return view;
}
async function finishAndListen(output: TestUtterance) {
  act(() => output.onend?.());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(350);
  });
}
// Audio elements use onended; browser speech uses onend.
async function finishAudioAndListen(output: TestAudio) {
  act(() => output.onended?.());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(350);
  });
}

describe("automatic call conversation", () => {
  it("waits for playback, sends recognized turns, continues after ack, and stops on done", async () => {
    mediaHarness();
    await connectMedia();
    expect(TestRecognition.all).toHaveLength(0);
    await finishAudioAndListen(TestAudio.all[0]);
    expect(TestRecognition.all[0].start).toHaveBeenCalledTimes(1);
    mutate.mockResolvedValueOnce({
      say: "Other calls stopped. What else?",
      ack: true,
      done: false,
      audio: { url: "/reply.wav" },
    });
    await act(async () =>
      TestRecognition.all[0].onresult?.({
        results: [[{ transcript: "I'm on my way" }]],
      }),
    );
    expect(mutate).toHaveBeenLastCalledWith("/agent/turn", {
      incident_id: "INC-1",
      member_id: "TM-SARAH",
      text: "I'm on my way",
    });
    expect(TestRecognition.all[0].abort).toHaveBeenCalledTimes(1);
    await finishAudioAndListen(TestAudio.all[1]);
    expect(TestRecognition.all).toHaveLength(2);
    mutate.mockResolvedValueOnce({
      say: "All set. Goodbye.",
      ack: true,
      done: true,
      audio: { url: "/done.wav" },
    });
    await act(async () =>
      TestRecognition.all[1].onresult?.({
        results: [[{ transcript: "I've got him" }]],
      }),
    );
    expect(screen.queryByLabelText("Ask Nightfall")).not.toBeInTheDocument();
    await finishAudioAndListen(TestAudio.all[2]);
    expect(TestRecognition.all).toHaveLength(2);
    expect(screen.queryByLabelText("Ask Nightfall")).not.toBeInTheDocument();
  });
  it("pauses automatic listening and ignores an old end callback, while allowing explicit resume", async () => {
    mediaHarness();
    await connectMedia();
    await finishAudioAndListen(TestAudio.all[0]);
    const ended = TestRecognition.all[0].onend;
    fireEvent.click(
      screen.getByRole("button", { name: "Pause automatic listening" }),
    );
    expect(TestRecognition.all[0].abort).toHaveBeenCalledTimes(1);
    act(() => ended?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(TestRecognition.all).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Resume automatic listening" }),
    );
    expect(TestRecognition.all).toHaveLength(2);
    fireEvent.focus(screen.getByLabelText("Ask Nightfall"));
    expect(TestRecognition.all[1].abort).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Resume automatic listening" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Ask Nightfall")).toBeEnabled();
  });
  it("restarts an ended recognition session without speech but pauses on permission rejection", async () => {
    mediaHarness();
    await connectMedia();
    await finishAudioAndListen(TestAudio.all[0]);
    act(() => TestRecognition.all[0].onend?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(TestRecognition.all).toHaveLength(2);
    act(() => TestRecognition.all[1].onerror?.({ error: "not-allowed" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(TestRecognition.all).toHaveLength(2);
    expect(screen.getByText(/Microphone permission is blocked/)).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Resume automatic listening" }),
    );
    expect(TestRecognition.all).toHaveLength(3);
    expect(
      screen.queryByText(/Microphone permission is blocked/),
    ).not.toBeInTheDocument();
  });
  it.each([false, true])(
    "uses a labeled browser voice when provider audio is unavailable (failed=%s)",
    async (failedAudio) => {
      const synthesis = mediaHarness({ withAudio: failedAudio, failedAudio });
      await connectMedia();
      expect(synthesis.speak).toHaveBeenCalledTimes(1);
      expect(
        screen.getByText(
          "Device voice · Browser speech, not your family’s cloned voice.",
        ),
      ).toBeVisible();
      expect(TestRecognition.all).toHaveLength(0);
      await finishAndListen(TestUtterance.all[0]);
      expect(TestRecognition.all).toHaveLength(1);
    },
  );
  it("keeps preview isolated even when browser voice and microphone APIs exist", async () => {
    const synthesis = mediaHarness({ preview: true });
    await connectMedia();
    fireEvent.click(screen.getByRole("button", { name: "Speak" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(TestAudio.all).toHaveLength(0);
    expect(TestRecognition.all).toHaveLength(0);
    expect(TestUtterance.all).toHaveLength(0);
    expect(synthesis.speak).not.toHaveBeenCalled();
  });
  it("cancels browser speech on reset and ignores its saved end callback", async () => {
    const synthesis = mediaHarness({ withAudio: false });
    const view = await connectMedia();
    const ended = TestUtterance.all[0].onend;
    changeState(view, { ...state, incident: null });
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    act(() => ended?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(TestRecognition.all).toHaveLength(0);
  });
  it("pauses on hide and does not restart listening from a pending old audio callback", async () => {
    mediaHarness();
    await connectMedia();
    const ended = TestAudio.all[0].onended;
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(TestAudio.all[0].pause).toHaveBeenCalledTimes(1);
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    act(() => ended?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(TestRecognition.all).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Resume automatic listening" }),
    ).toBeVisible();
  });
  it("clears pending automatic listening when unmounted", async () => {
    mediaHarness();
    const view = await connectMedia();
    act(() => TestAudio.all[0].onended?.());
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(TestRecognition.all).toHaveLength(0);
  });
  it("does not re-answer or restart the old call when the selected member changes", async () => {
    mediaHarness();
    const view = render(
      <MemoryRouter
        initialEntries={[
          { pathname: "/incident/call", state: { answered: "INC-1" } },
        ]}
      >
        <CallPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(get).toHaveBeenCalledTimes(1);
    const ended = TestAudio.all[0].onended;
    const context = mockUse.mock.results.at(-1)?.value as NightfallContextValue;
    mockUse.mockReturnValue({ ...context, memberId: "TM-MIKE" });
    view.rerender(
      <MemoryRouter
        initialEntries={[
          { pathname: "/incident/call", state: { answered: "INC-1" } },
        ]}
      >
        <CallPage />
      </MemoryRouter>,
    );
    act(() => ended?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(TestRecognition.all).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Connect to Nightfall" }),
    ).toBeEnabled();
  });
  it("does not open the microphone if browser speech also fails", async () => {
    mediaHarness({ withAudio: false });
    await connectMedia();
    act(() => TestUtterance.all[0].onerror?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText(/Device voice could not play/)).toBeVisible();
    expect(TestRecognition.all).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Resume automatic listening" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Ask Nightfall")).toBeEnabled();
  });
});
