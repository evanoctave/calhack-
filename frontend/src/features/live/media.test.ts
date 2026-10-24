import { describe, expect, it } from "vitest";
import { toPcm16 } from "./media";

describe("door PCM protocol", () => {
  it("converts 48 kHz samples to 16 kHz signed mono PCM with clipped extrema", () => {
    const input = new Float32Array([1, 1, 1, -1, -1, -1, 2, 2, 2, -2, -2, -2]);
    expect(Array.from(toPcm16(input, 48000))).toEqual([
      32767, -32768, 32767, -32768,
    ]);
  });
  it("averages source samples instead of dropping every other sample", () => {
    expect(
      Array.from(toPcm16(new Float32Array([1, -1, 1, -1]), 32000)),
    ).toEqual([0, 0]);
  });
  it("preserves duration at the Web Audio 44.1 kHz rate", () => {
    expect(toPcm16(new Float32Array(44100), 44100)).toHaveLength(16000);
  });
});
