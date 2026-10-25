import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("legacy device voice", () => {
  it.each([
    [
      "app-voice.js",
      "speakThen",
      "function speakThen",
      "async function askAgent",
    ],
    ["phone.html", "speakThen", "function speakThen", "async function main"],
    ["app.js", "speak", "function speak", "\n}"],
  ])(
    "sets English explicitly in %s even on a Korean-language device",
    (file, name, start, end) => {
      const source = readFileSync(
        resolve(process.cwd(), "../static", file),
        "utf8",
      );
      const offset = source.indexOf(start);
      const finish =
        name === "speak"
          ? source.indexOf(end, offset) + 2
          : source.indexOf("\n}", offset) + 2;
      // app-voice.js keeps the whole helper on one line.
      const code =
        file === "app-voice.js"
          ? source.slice(offset, source.indexOf("\n", offset))
          : source.slice(offset, finish);
      const speak = vi.fn();
      const speechSynthesis = {
        speak,
        cancel: vi.fn(),
        getVoices: () => [{ name: "Korean default", lang: "ko-KR" }],
      };
      const say = runInNewContext(`${code}; ${name}`, {
        window: { speechSynthesis },
        speechSynthesis,
        SpeechSynthesisUtterance: class {
          lang = "ko-KR";
          constructor(public text: string) {}
        },
      });
      say("Dad is at the door", vi.fn());
      expect(speak).toHaveBeenCalledWith(
        expect.objectContaining({ lang: "en-US", text: "Dad is at the door" }),
      );
    },
  );
});
