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
  constructor() {
    FakeSocket.all.push(this);
  }
}
const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
let stopTrack: ReturnType<typeof vi.fn>, closeContext: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  stopTrack = vi.fn();
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
    expect(hook.result.current.mode).toBe("off");
  });
  it("never opens a microphone or WebSocket in preview", async () => {
    const hook = renderHook(() => useDoorAudio("TM-SARAH", true));
    await act(() => hook.result.current.start("talking"));
    expect(getMicrophone).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(0);
    expect(hook.result.current.error).toContain("Preview only");
  });
});
