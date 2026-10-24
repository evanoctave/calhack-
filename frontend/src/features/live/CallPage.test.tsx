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
afterEach(() => vi.unstubAllGlobals());
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
