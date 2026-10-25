import { beforeEach, describe, expect, it } from "vitest";
import {
  editSetupPath,
  rememberSetupStep,
  resumedSetupStep,
  returnDestination,
} from "./setupFlow";

beforeEach(() => sessionStorage.clear());
describe("setup navigation", () => {
  it("allowlists return destinations instead of accepting external or arbitrary routes", () => {
    expect(returnDestination("?returnTo=/home")).toBe("/home");
    expect(returnDestination("?returnTo=/setup/connect")).toBe(
      "/setup/connect",
    );
    expect(returnDestination("?returnTo=https://example.com")).toBe("/care");
    expect(returnDestination("?returnTo=/incident/call")).toBe("/care");
    expect(editSetupPath("contacts", "/home")).toBe(
      "/setup/contacts?mode=edit&returnTo=%2Fhome",
    );
  });
  it("remembers navigation per member and mode without storing readiness or personal details", () => {
    rememberSetupStep("contacts", false, "TM-1");
    expect(resumedSetupStep(false, "TM-1")).toBe("contacts");
    expect(resumedSetupStep(true, "TM-1")).toBe("profile");
    expect(resumedSetupStep(false, "TM-2")).toBe("profile");
    expect(Object.values(sessionStorage)).toEqual(["contacts"]);
  });
});
