import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isMemberRinging,
  NightfallProvider,
  useNightfall,
} from "./NightfallProvider";
import { api, ApiError } from "../data/api";
import { createPreviewState, resetPreview } from "../data/preview";
import type { Brief, NightfallState } from "../data/types";

class TestEventSource {
  static instances: TestEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  constructor(url: string) {
    this.url = url;
    TestEventSource.instances.push(this);
  }
}

class TestAudioContext {
  static starts = 0;
  state = "running";
  sampleRate = 44100;
  currentTime = 0;
  destination = {};
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createBuffer = vi.fn(() => ({}));
  createBufferSource = vi.fn(() => ({
    buffer: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    onended: null,
  }));
  createGain = vi.fn(() => ({
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createOscillator = vi.fn(() => ({
    frequency: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: () => {
      TestAudioContext.starts++;
    },
    stop: vi.fn(),
    onended: null,
  }));
}

function Probe() {
  const {
    state,
    memberId,
    error,
    setMember,
    setScenario,
    mutate,
    lastEvent,
    enableSound,
    ringSuppressed,
    shouldRing,
    silenceRing,
  } = useNightfall();
  return (
    <div>
      <span data-testid="member">{memberId}</span>
      <span data-testid="error">{error || "none"}</span>
      <span data-testid="snapshot">
        {state?.household.caregiver_name || "loading"}
      </span>
      <span data-testid="status">{state?.incident?.state || "watching"}</span>
      <span data-testid="person-visible">
        {String(state?.incident?.person_in_frame ?? false)}
      </span>
      <span data-testid="event">{lastEvent?.type || "none"}</span>
      <span data-testid="suppressed">{String(ringSuppressed)}</span>
      <span data-testid="should-ring">{String(shouldRing)}</span>
      <button onClick={() => setMember("TM-MIKE")}>Switch member</button>
      <button onClick={() => setScenario("ringing")}>Show ringing</button>
      <button onClick={() => void enableSound()}>Enable sound</button>
      <button onClick={silenceRing}>Not now</button>
      <button
        onClick={() =>
          void mutate("/answer", {
            incident_id: "PREVIEW-INCIDENT",
            member_id: memberId,
          })
        }
      >
        Answer
      </button>
      <button
        onClick={() =>
          void mutate("/ack", {
            incident_id: "PREVIEW-INCIDENT",
            member_id: memberId,
          })
        }
      >
        Acknowledge
      </button>
    </div>
  );
}

beforeEach(() => {
  window.history.replaceState({}, "", "/ui/");
  window.localStorage.clear();
  TestEventSource.instances = [];
  TestAudioContext.starts = 0;
  vi.stubGlobal("EventSource", TestEventSource);
  vi.stubGlobal("AudioContext", TestAudioContext);
  resetPreview();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("explicit isolated preview", () => {
  it("never contacts the backend and distinguishes answer, acknowledgement, and physical return", async () => {
    window.history.replaceState({}, "", "/ui/?preview=1");
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    render(
      <NightfallProvider>
        <Probe />
      </NightfallProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("snapshot").textContent).toBe("Sarah"),
    );
    fireEvent.click(screen.getByText("Show ringing"));
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ESCALATING"),
    );
    fireEvent.click(screen.getByText("Answer"));
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ESCALATING"),
    );
    fireEvent.click(screen.getByText("Acknowledge"));
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ACKED"),
    );
    expect(screen.getByTestId("person-visible").textContent).toBe("false");
    expect(network).not.toHaveBeenCalled();
    expect(TestEventSource.instances).toHaveLength(0);
  });

  it("isolates direct feature API calls too, including uploads and invalid brief links", async () => {
    window.history.replaceState({}, "", "/ui/?preview=1");
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const form = new FormData();
    form.append("clip", new Blob(["sample"]), "sample.webm");
    const saved = await api.upload<{ preview: boolean }>(
      "/voice/samples/reassurance",
      form,
    );
    expect(saved.preview).toBe(true);
    await expect(api.get("/brief/expired-preview")).rejects.toMatchObject({
      status: 410,
    });
    await api.post("/profile", { caregiver_name: "Preview Person" });
    await expect(api.post("/unsupported/reorder", {})).rejects.toMatchObject({
      status: 404,
    });
    expect(network).not.toHaveBeenCalled();
  });

  it("binds a preview brief to its recipient ID without substituting the current default member", async () => {
    window.history.replaceState({}, "", "/ui/?preview=1&scenario=ringing");
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const state = await api.get<NightfallState>("/app/state?member=TM-MIKE");
    const token = state.incident!.brief_link.split("#")[1];
    const brief = await api.get<Brief>(`/brief/${encodeURIComponent(token)}`);
    expect(brief.viewer).toBe("TM-MIKE");
    const sarah = await api.get<NightfallState>("/app/state?member=TM-SARAH");
    expect(sarah.incident?.brief_link).toContain("TM-SARAH");
    expect(network).not.toHaveBeenCalled();
  });
});

describe("connected snapshots and stream lifecycle", () => {
  it("resolves a missing default identity from the current household before opening a phone stream", async () => {
    const state = createPreviewState("watching");
    state.household.tree = [
      { id: "TM-SECOND", name: "Second contact", phone: "", tier: 2 },
      { id: "TM-FIRST", name: "First contact", phone: "", tier: 1 },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(state), { status: 200 })),
    );
    render(
      <NightfallProvider>
        <Probe />
      </NightfallProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("member").textContent).toBe("TM-FIRST"),
    );
    await waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
    expect(TestEventSource.instances[0].url).toBe("/sse/phone/TM-FIRST");
    expect(screen.getByTestId("error").textContent).toBe("none");
  });

  it("replaces a stale stored identity with a member that still belongs to the care circle", async () => {
    window.localStorage.setItem("nightfall-member", "TM-REMOVED");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(createPreviewState("watching")), {
            status: 200,
          }),
      ),
    );
    render(
      <NightfallProvider>
        <Probe />
      </NightfallProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("member").textContent).toBe("TM-SARAH"),
    );
    await waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
    expect(TestEventSource.instances[0].url).toBe("/sse/phone/TM-SARAH");
    expect(window.localStorage.getItem("nightfall-member")).toBe("TM-SARAH");
  });

  it("does not silently substitute another identity for an invalid explicit invitation member", async () => {
    window.history.replaceState({}, "", "/ui/?member=TM-REMOVED");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(createPreviewState("ringing")), {
            status: 200,
          }),
      ),
    );
    render(
      <NightfallProvider>
        <Probe />
      </NightfallProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).toContain(
        "not in the current care circle",
      ),
    );
    expect(screen.getByTestId("member").textContent).toBe("TM-REMOVED");
    expect(screen.getByTestId("snapshot").textContent).toBe("loading");
    expect(screen.getByTestId("should-ring").textContent).toBe("false");
    expect(TestEventSource.instances).toHaveLength(0);
  });

  it("uses live APIs by default, repairs snapshots on reconnect and closes streams on member switch", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        calls++;
        const state = createPreviewState("watching");
        state.household.caregiver_name = path.includes("TM-MIKE")
          ? "Mike snapshot"
          : `Sarah snapshot ${calls}`;
        return new Response(JSON.stringify(state), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const { unmount } = render(
      <NightfallProvider>
        <Probe />
      </NightfallProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("snapshot").textContent).toBe(
        "Sarah snapshot 1",
      ),
    );
    const first = TestEventSource.instances[0];
    expect(first.url).toBe("/sse/phone/TM-SARAH");
    act(() => first.onopen?.());
    await waitFor(() => expect(calls).toBe(2));
    act(() =>
      first.onmessage?.({ data: JSON.stringify({ type: "brief_updated" }) }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("event").textContent).toBe("brief_updated"),
    );
    fireEvent.click(screen.getByText("Switch member"));
    expect(screen.getByTestId("snapshot").textContent).not.toContain("Sarah");
    await waitFor(() =>
      expect(screen.getByTestId("snapshot").textContent).toBe("Mike snapshot"),
    );
    expect(first.close).toHaveBeenCalledOnce();
    expect(screen.getByTestId("event").textContent).toBe("none");
    expect(TestEventSource.instances.at(-1)?.url).toBe("/sse/phone/TM-MIKE");
    unmount();
    expect(TestEventSource.instances.at(-1)?.close).toHaveBeenCalledOnce();
  });

  it("preserves API status for expired links and errors rather than reporting success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "expired" }), { status: 410 }),
      ),
    );
    const error = await api.get("/brief/old-token").catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError))
      throw new Error("Expected the API error to preserve its type.");
    expect(error.status).toBe(410);
    expect(error.message).toBe("expired");
  });

  it("refetches current status after a failed acknowledgement", async () => {
    let didAcknowledge = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init: RequestInit) => {
        if (init.method === "POST") {
          didAcknowledge = true;
          return new Response(JSON.stringify({ detail: "no such incident" }), {
            status: 404,
          });
        }
        return new Response(
          JSON.stringify(
            createPreviewState(didAcknowledge ? "responding" : "ringing"),
          ),
          { status: 200 },
        );
      }),
    );
    const { result } = renderHook(() => useNightfall(), {
      wrapper: NightfallProvider,
    });
    await waitFor(() =>
      expect(result.current.state?.incident?.state).toBe("ESCALATING"),
    );
    await act(async () => {
      await expect(
        result.current.mutate("/ack", {
          incident_id: "old-incident",
          member_id: "TM-SARAH",
        }),
      ).rejects.toMatchObject({ status: 404 });
    });
    await waitFor(() =>
      expect(result.current.state?.incident?.state).toBe("ACKED"),
    );
  });

  it("starts sound for the current target only after consent, and stops when a reconnect snapshot reports return", async () => {
    let scenario = "ringing";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(createPreviewState(scenario)), {
            status: 200,
          }),
      ),
    );
    const clear = vi.spyOn(globalThis, "clearInterval");
    render(
      <NightfallProvider>
        <Probe />
      </NightfallProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ESCALATING"),
    );
    expect(TestAudioContext.starts).toBe(0);
    fireEvent.click(screen.getByText("Enable sound"));
    await waitFor(() => expect(TestAudioContext.starts).toBe(1));
    const before = clear.mock.calls.length;
    act(() =>
      TestEventSource.instances[0].onmessage?.({
        data: JSON.stringify({
          type: "answered",
          member_id: "TM-MIKE",
          incident_id: "PREVIEW-INCIDENT",
        }),
      }),
    );
    expect(clear.mock.calls.length).toBe(before);
    scenario = "returned";
    act(() => TestEventSource.instances[0].onopen?.());
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("RETURNED"),
    );
    expect(clear.mock.calls.length).toBeGreaterThan(before);
  });

  it("does not restart local ringing after answering even when the server is still escalating", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_path: string, init: RequestInit) =>
          new Response(
            JSON.stringify(
              init.method === "POST"
                ? { ok: true }
                : createPreviewState("ringing"),
            ),
            { status: 200 },
          ),
      ),
    );
    render(
      <NightfallProvider>
        <Probe />
      </NightfallProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ESCALATING"),
    );
    fireEvent.click(screen.getByText("Enable sound"));
    await waitFor(() => expect(TestAudioContext.starts).toBe(1));
    fireEvent.click(screen.getByText("Answer"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    act(() => TestEventSource.instances[0].onopen?.());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(TestAudioContext.starts).toBe(1);
    expect(screen.getByTestId("status").textContent).toBe("ESCALATING");
    expect(screen.getByTestId("suppressed").textContent).toBe("true");
    expect(screen.getByTestId("should-ring").textContent).toBe("false");
  });

  it("publishes a local decline immediately without sending answer or acknowledgement", async () => {
    const network = vi.fn(
      async () =>
        new Response(JSON.stringify(createPreviewState("ringing")), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", network);
    render(
      <NightfallProvider>
        <Probe />
      </NightfallProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("should-ring").textContent).toBe("true"),
    );
    fireEvent.click(screen.getByText("Not now"));
    expect(screen.getByTestId("suppressed").textContent).toBe("true");
    expect(screen.getByTestId("should-ring").textContent).toBe("false");
    expect(network.mock.calls).toHaveLength(1);
    expect(screen.getByTestId("status").textContent).toBe("ESCALATING");
  });

  it("never targets a different member or a terminal incident from a historical ring", () => {
    const state = createPreviewState("ringing");
    expect(isMemberRinging(state, "TM-SARAH")).toBe(true);
    expect(isMemberRinging(state, "TM-MIKE")).toBe(false);
    for (const scenario of [
      "watching",
      "returned",
      "responding",
      "other-family",
      "visitor",
    ]) {
      expect(isMemberRinging(createPreviewState(scenario), "TM-SARAH")).toBe(
        false,
      );
    }
  });
});

describe("phone event corrections", () => {
  it("keeps every valid family phone eligible for help after snapshot refresh", () => {
    const state = createPreviewState("help");
    expect(isMemberRinging(state, "TM-SARAH")).toBe(true);
    expect(isMemberRinging(state, "TM-MIKE")).toBe(true);
    expect(isMemberRinging(state, "TM-LINDA")).toBe(true);
    expect(isMemberRinging(state, "not-a-member")).toBe(false);
    state.incident!.checkin = "self_other";
    expect(isMemberRinging(state, "TM-MIKE")).toBe(false);
  });
  it("ignores ring history belonging to a previous incident", () => {
    const state = createPreviewState("ringing");
    state.rings[0].incident_id = "older-incident";
    expect(isMemberRinging(state, "TM-SARAH")).toBe(false);
  });
  it("retains door subtitles and visitor speech across unrelated events, but not a new incident", async () => {
    let state = createPreviewState("visitor");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(state), { status: 200 })),
    );
    const { result } = renderHook(() => useNightfall(), {
      wrapper: NightfallProvider,
    });
    await waitFor(() =>
      expect(result.current.state?.incident?.id).toBe("PREVIEW-INCIDENT"),
    );
    const stream = TestEventSource.instances[0];
    const event = (value: object) =>
      act(() => stream.onmessage?.({ data: JSON.stringify(value) }));
    event({
      type: "speak",
      text: "Who is at the door?",
      incident_id: "PREVIEW-INCIDENT",
    });
    event({
      type: "visitor_said",
      said: "A package for Robert",
      incident_id: "PREVIEW-INCIDENT",
    });
    event({
      type: "door",
      event: "enroll_success",
      name: "Robert",
      label: "person",
    });
    expect(result.current.doorSpeech?.text).toBe("Who is at the door?");
    expect(result.current.visitorMessage).toBe("A package for Robert");
    state = createPreviewState("approach");
    state.incident!.id = "new-incident";
    act(() => stream.onopen?.());
    await waitFor(() =>
      expect(result.current.state?.incident?.id).toBe("new-incident"),
    );
    expect(result.current.doorSpeech).toBeNull();
    expect(result.current.visitorMessage).toBe("");
    event({
      type: "speak",
      text: "Late old speech",
      incident_id: "PREVIEW-INCIDENT",
    });
    expect(result.current.doorSpeech).toBeNull();
  });
  it("recovers the current subtitle from the server snapshot and plays one consented visitor chime", async () => {
    const state = createPreviewState("visitor");
    state.door_speech = {
      text: "Hello. Who is there?",
      incident_id: state.incident!.id,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(state), { status: 200 })),
    );
    const { result } = renderHook(() => useNightfall(), {
      wrapper: NightfallProvider,
    });
    await waitFor(() =>
      expect(result.current.doorSpeech?.text).toBe("Hello. Who is there?"),
    );
    const stream = TestEventSource.instances[0];
    act(() =>
      stream.onmessage?.({
        data: JSON.stringify({
          type: "visitor",
          incident_id: state.incident!.id,
        }),
      }),
    );
    expect(TestAudioContext.starts).toBe(0);
    await act(async () => result.current.enableSound());
    act(() =>
      stream.onmessage?.({
        data: JSON.stringify({
          type: "visitor",
          incident_id: state.incident!.id,
        }),
      }),
    );
    expect(TestAudioContext.starts).toBe(1);
  });
});

it("replaces an older stream subtitle with a newer reconnect snapshot", async () => {
  const state = createPreviewState("approach");
  state.door_speech = {
    text: "First line",
    incident_id: state.incident!.id,
    ts: "2026-10-24T02:00:00Z",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(state), { status: 200 })),
  );
  const { result } = renderHook(() => useNightfall(), {
    wrapper: NightfallProvider,
  });
  await waitFor(() =>
    expect(result.current.doorSpeech?.text).toBe("First line"),
  );
  const stream = TestEventSource.instances[0];
  act(() =>
    stream.onmessage?.({
      data: JSON.stringify({ type: "speak", ...state.door_speech }),
    }),
  );
  state.door_speech = {
    text: "Newer line during disconnect",
    incident_id: state.incident!.id,
    ts: "2026-10-24T02:00:20Z",
  };
  act(() => stream.onopen?.());
  await waitFor(() =>
    expect(result.current.doorSpeech?.text).toBe(
      "Newer line during disconnect",
    ),
  );
});
