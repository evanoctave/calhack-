import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDoorVideo } from "./useDoorVideo";

class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = "";
  onmessage: ((event: { data: Blob }) => void) | null = null;
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
