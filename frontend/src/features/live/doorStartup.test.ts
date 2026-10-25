import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const door = readFileSync(
  resolve(process.cwd(), "../static/door.html"),
  "utf8",
);
const startup = door.slice(
  door.indexOf("async function startDoor()"),
  door.indexOf("// Live voice from the phone"),
);
const playback = door.slice(
  door.indexOf("async function playAtDoor(e)"),
  door.indexOf("function testSpeaker()"),
);

afterEach(() => vi.useRealTimers());

describe("door startup", () => {
  it("starts camera and relay while browser audio unlock is still pending", async () => {
    const startCam = vi.fn(),
      doorConnect = vi.fn(),
      micConnect = vi.fn(),
      videoConnect = vi.fn();
    const requestFullscreen = vi.fn();
    const Out = { started: false, ctx: null };
    const resume = vi.fn(() => new Promise(() => {}));
    const context = {
      Out,
      Cam: { armAt: 0 },
      ARM_DELAY_MS: 5000,
      $: () => ({ classList: { add: vi.fn() } }),
      window: {
        AudioContext: class {
          resume = resume;
        },
      },
      Audio: class {
        volume = 1;
        play = () => new Promise(() => {});
      },
      document: { documentElement: { requestFullscreen } },
      navigator: { userAgent: "test" },
      tele: vi.fn(),
      earStart: vi.fn(),
      startCam,
      doorConnect,
      micConnect,
      videoConnect,
    };
    const start = runInNewContext(`${startup}; startDoor`, context);
    const result = await Promise.race([
      start().then(() => "started"),
      new Promise((r) => setTimeout(() => r("blocked"), 50)),
    ]);
    expect(result).toBe("started");
    expect(resume).toHaveBeenCalledOnce();
    for (const connect of [startCam, doorConnect, micConnect, videoConnect])
      expect(connect).toHaveBeenCalledOnce();
    expect(requestFullscreen).not.toHaveBeenCalled();
    await start();
    expect(startCam).toHaveBeenCalledOnce();
  });

  it("falls back to audio playback when AudioContext resume never settles", async () => {
    vi.useFakeTimers();
    const play = vi.fn().mockResolvedValue(undefined);
    const decode = vi.fn();
    const context = {
      Out: {
        started: true,
        ctx: {
          state: "suspended",
          resume: () => new Promise(() => {}),
          decodeAudioData: decode,
        },
      },
      Cur: { live: false, audio: null },
      last: null,
      audioOk: false,
      fetch: vi
        .fn()
        .mockResolvedValue({ ok: true, blob: async () => ({ size: 100 }) }),
      URL: { createObjectURL: () => "blob:voice" },
      Audio: class {
        volume = 1;
        play = play;
      },
      showSpeak: vi.fn(),
      cutAudio: vi.fn(),
      tele: vi.fn(),
      speak: vi.fn(),
      $: () => ({}),
      setTimeout,
    };
    const playbackFn = runInNewContext(`${playback}; playAtDoor`, context);
    const pending = playbackFn({
      url: "/voice/example.wav",
      text: "Hi Dad",
      mode: "cartesia",
    });
    await vi.advanceTimersByTimeAsync(301);
    await pending;
    expect(play).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
  });
});
