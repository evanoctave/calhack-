import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDoorVideo } from "./useDoorVideo";

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  binaryType = "";
  readyState = FakeSocket.OPEN;
  send = vi.fn();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeSocket.all.push(this);
  }
}
const snapshot = () => ({
  ok: true,
  headers: new Headers({ "X-Frame-Age": "4" }),
  blob: async () => new Blob(["snapshot"], { type: "image/jpeg" }),
});
let fetchMock: ReturnType<typeof vi.fn>;
const revoke = vi.fn<(url: string) => void>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  FakeSocket.all = [];
  let id = 0;
  revoke.mockClear();
  const NativeURL = URL;
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static createObjectURL = () => `blob:frame-${++id}`;
      static revokeObjectURL(url: string) {
        revoke(url);
      }
    },
  );
  vi.stubGlobal("WebSocket", FakeSocket);
  fetchMock = vi.fn().mockResolvedValue(snapshot());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("door camera freshness", () => {
  it("acknowledges each accepted JPEG for old and backpressure-aware servers", async () => {
    const hook = renderHook(() => useDoorVideo("TM-SARAH", false));
    await act(async () => {
      await Promise.resolve();
    });
    const socket = FakeSocket.all[0];
    act(() => {
      socket.onmessage?.({
        data: new Blob(["frame 1"], { type: "image/jpeg" }),
      });
      socket.onmessage?.({
        data: new Blob(["frame 2"], { type: "image/jpeg" }),
      });
      socket.onmessage?.({ data: "status" });
      socket.onmessage?.({ data: new Blob([]) });
    });
    expect(socket.send.mock.calls).toEqual([["a"], ["a"]]);
    expect(hook.result.current.live).toBe(true);
    const lateMessage = socket.onmessage;
    hook.unmount();
    act(() => lateMessage?.({ data: new Blob(["late frame"]) }));
    expect(socket.send).toHaveBeenCalledTimes(2);
  });

  it("does not acknowledge or display frames from a replaced connection", async () => {
    const hook = renderHook(({ member }) => useDoorVideo(member, false), {
      initialProps: { member: "TM-SARAH" },
    });
    await act(async () => {
      await Promise.resolve();
    });
    const oldSocket = FakeSocket.all[0];
    hook.rerender({ member: "TM-MIKE" });
    await act(async () => {
      await Promise.resolve();
    });
    const currentSocket = FakeSocket.all[1];
    const currentFrame = hook.result.current.src;
    act(() => oldSocket.onmessage?.({ data: new Blob(["old member frame"]) }));
    expect(oldSocket.send).not.toHaveBeenCalled();
    expect(hook.result.current.src).toBe(currentFrame);
    act(() =>
      currentSocket.onmessage?.({ data: new Blob(["current member frame"]) }),
    );
    expect(currentSocket.send).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("labels a JPEG fallback as a snapshot, never Live", async () => {
    const hook = renderHook(() => useDoorVideo("TM-SARAH", false));
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.src).toBe("blob:frame-1");
    expect(hook.result.current.live).toBe(false);
    expect(hook.result.current.status).toContain("Not a live stream");
  });
  it("marks only fresh websocket frames Live, clears stale stream data, and falls back to snapshots", async () => {
    const hook = renderHook(() => useDoorVideo("TM-SARAH", false));
    await act(async () => {
      await Promise.resolve();
    });
    act(() =>
      FakeSocket.all[0].onmessage?.({
        data: new Blob(["frame"], { type: "image/jpeg" }),
      }),
    );
    expect(hook.result.current.live).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(hook.result.current.live).toBe(false);
    expect(hook.result.current.src).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(hook.result.current.src).toBeTruthy();
    expect(hook.result.current.live).toBe(false);
    expect(hook.result.current.status).toContain("snapshot");
  });
  it("does not let a delayed fallback overwrite a recovered live stream", async () => {
    let resolve: (response: ReturnType<typeof snapshot>) => void = () =>
      undefined;
    fetchMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const hook = renderHook(() => useDoorVideo("TM-SARAH", false));
    act(() => FakeSocket.all[0].onmessage?.({ data: new Blob(["live"]) }));
    await act(async () => {
      resolve(snapshot());
      await Promise.resolve();
    });
    expect(hook.result.current.live).toBe(true);
    expect(hook.result.current.status).toBe("Live · Front door camera");
    hook.unmount();
    expect(FakeSocket.all[0].close).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalled();
  });
});
