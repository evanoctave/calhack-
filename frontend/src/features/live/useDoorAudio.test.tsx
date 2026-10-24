import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDoorAudio } from "./useDoorAudio";

const { getMicrophone, makeContext } = vi.hoisted(() => ({
  getMicrophone: vi.fn(),
  makeContext: vi.fn(),
}));
vi.mock("./media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media")>()),
  getMicrophone,
  audioContext: makeContext,
}));

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  close = vi.fn();
  send = vi.fn();
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
}
const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
let stopTrack: ReturnType<typeof vi.fn>, closeContext: ReturnType<typeof vi.fn>;
let buffers: Float32Array[], speakers: ReturnType<typeof node>[];
beforeEach(() => {
  vi.clearAllMocks();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  stopTrack = vi.fn();
  buffers = [];
  speakers = [];
  closeContext = vi.fn().mockResolvedValue(undefined);
  getMicrophone.mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  makeContext.mockImplementation(() => ({
    state: "running",
    sampleRate: 48000,
    destination: {},
    currentTime: 0,
    resume: vi.fn().mockResolvedValue(undefined),
    close: closeContext,
    createMediaStreamSource: node,
    createScriptProcessor: node,
    createGain: () => ({ ...node(), gain: { value: 1 } }),
    createBuffer: (_channels: number, size: number, rate: number) => {
      const data = new Float32Array(size);
      buffers.push(data);
      return { getChannelData: () => data, duration: size / rate };
    },
    createBufferSource: () => {
      const speaker = { ...node(), start: vi.fn(), onended: null };
      speakers.push(speaker);
      return speaker;
    },
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("door audio resource ownership", () => {
  it("closes microphone, socket and AudioContext when the page unmounts", async () => {
    const hook = renderHook(() => useDoorAudio("TM-SARAH", false));
    await act(() => hook.result.current.start("talking"));
    expect(getMicrophone).toHaveBeenCalledTimes(1);
    hook.unmount();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(FakeSocket.all[0].close).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
  });
  it("stops a microphone permission result that arrives after cancellation", async () => {
    let resolve: (stream: unknown) => void = () => undefined;
    getMicrophone.mockReturnValueOnce(
      new Promise((value) => {
        resolve = value;
      }),
    );
    const hook = renderHook(() => useDoorAudio("TM-SARAH", false));
    let starting: Promise<void>;
    await act(async () => {
      starting = hook.result.current.start("talking");
      await Promise.resolve();
    });
    act(() => hook.result.current.stop());
    await act(async () => {
      resolve({ getTracks: () => [{ stop: stopTrack }] });
      await starting;
    });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(FakeSocket.all).toHaveLength(0);
    expect(hook.result.current.channels.talking).toBe("off");
  });
  it("never opens a microphone or WebSocket in preview", async () => {
    const hook = renderHook(() => useDoorAudio("TM-SARAH", true));
    await act(() => hook.result.current.start("talking"));
    await act(() => hook.result.current.start("listening"));
    expect(getMicrophone).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(0);
    expect(hook.result.current.error).toContain("Preview only");
  });

  it("keeps Listen connected while Talk starts and stops independently", async () => {
    const hook = renderHook(() => useDoorAudio("TM-SARAH", false));
    await act(() => hook.result.current.start("listening"));
    const listen = FakeSocket.all[0];
    act(() => listen.onopen?.());
    await act(() => hook.result.current.start("talking"));
    const talk = FakeSocket.all[1];
    act(() => talk.onopen?.());
    expect(listen.url).toContain("/ws/listen/TM-SARAH");
    expect(talk.url).toContain("/ws/talk/TM-SARAH");
    expect(hook.result.current.channels).toEqual({
      talking: "on",
      listening: "on",
    });
    expect(listen.close).not.toHaveBeenCalled();
    act(() => hook.result.current.stop("talking"));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(talk.close).toHaveBeenCalledOnce();
    expect(listen.close).not.toHaveBeenCalled();
    expect(hook.result.current.channels).toEqual({
      talking: "off",
      listening: "on",
    });
    hook.unmount();
    expect(listen.close).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledTimes(2);
  });

  it("isolates a Listen failure and ignores callbacks from that old connection", async () => {
    const stopped = vi.fn();
    const hook = renderHook(() => useDoorAudio("TM-SARAH", false, stopped));
    await act(() => hook.result.current.start("talking"));
    const talk = FakeSocket.all[0];
    act(() => talk.onopen?.());
    await act(() => hook.result.current.start("listening"));
    const listen = FakeSocket.all[1],
      lateOpen = listen.onopen,
      lateClose = listen.onclose;
    act(() => listen.onerror?.());
    expect(hook.result.current.error).toContain("Could not connect Listen");
    expect(talk.close).not.toHaveBeenCalled();
    expect(stopTrack).not.toHaveBeenCalled();
    await act(() => hook.result.current.start("listening"));
    const replacement = FakeSocket.all[2];
    act(() => {
      lateOpen?.();
      lateClose?.();
    });
    expect(hook.result.current.channels.listening).toBe("connecting");
    expect(replacement.close).not.toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledOnce();
    hook.unmount();
  });

  it("stops both channels when the member or preview mode changes", async () => {
    const hook = renderHook(
      ({ member, preview }) => useDoorAudio(member, preview),
      {
        initialProps: { member: "TM-SARAH", preview: false },
      },
    );
    await act(() => hook.result.current.start("talking"));
    await act(() => hook.result.current.start("listening"));
    hook.rerender({ member: "TM-MIKE", preview: false });
    expect(
      FakeSocket.all.every((socket) => socket.close.mock.calls.length === 1),
    ).toBe(true);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(hook.result.current.channels).toEqual({
      talking: "off",
      listening: "off",
    });
    await act(() => hook.result.current.start("listening"));
    expect(FakeSocket.all[2].url).toContain("TM-MIKE");
    hook.rerender({ member: "TM-MIKE", preview: true });
    expect(FakeSocket.all[2].close).toHaveBeenCalledOnce();
    hook.unmount();
  });

  it("releases both channels when the phone page becomes hidden", async () => {
    const hook = renderHook(() => useDoorAudio("TM-SARAH", false));
    await act(() => hook.result.current.start("talking"));
    await act(() => hook.result.current.start("listening"));
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledTimes(2);
    expect(hook.result.current.channels).toEqual({
      talking: "off",
      listening: "off",
    });
    hidden.mockRestore();
    hook.unmount();
  });

  it("plays incoming PCM alongside Talk and rejects invalid or stale Listen frames", async () => {
    const hook = renderHook(() => useDoorAudio("TM-SARAH", false));
    await act(() => hook.result.current.start("talking"));
    await act(() => hook.result.current.start("listening"));
    const listen = FakeSocket.all[1],
      receive = listen.onmessage;
    act(() => receive?.({ data: new Int16Array([32767, -32768, 0]).buffer }));
    expect(buffers).toHaveLength(1);
    expect(Array.from(buffers[0])).toEqual([32767 / 32768, -1, 0]);
    expect(speakers[0].connect).toHaveBeenCalledOnce();
    act(() => {
      receive?.({ data: new ArrayBuffer(1) });
      receive?.({ data: "ping" });
    });
    expect(buffers).toHaveLength(1);
    act(() => hook.result.current.stop("listening"));
    await act(() => hook.result.current.start("listening"));
    act(() => receive?.({ data: new Int16Array([99]).buffer }));
    expect(buffers).toHaveLength(1);
    expect(FakeSocket.all[0].close).not.toHaveBeenCalled();
    expect(stopTrack).not.toHaveBeenCalled();
    hook.unmount();
  });
});
