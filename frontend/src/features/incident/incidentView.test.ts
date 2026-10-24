import { describe, expect, it } from "vitest";
import type { Incident } from "../../data/types";
import {
  canRespond,
  canShowEmergency,
  confirmedReturned,
  countdown,
  incidentTitle,
  isHelpIncident,
  isResolvedIncident,
} from "./incidentView";

describe("caregiver incident semantics", () => {
  it("does not equate a family acknowledgement with a detected return", () => {
    const incident = {
      state: "ACKED",
      acked_by: "TM-SARAH",
      acked_by_name: "Sarah",
      person_in_frame: false,
    } as Incident;
    expect(confirmedReturned(incident)).toBe(false);
    expect(canRespond(incident)).toBe(false);
    expect(incidentTitle(incident, "Dad")).toBe("Sarah is on it");
  });
  it("allows responding only while the family is being asked to respond", () => {
    expect(canRespond({ state: "ESCALATING" } as Incident)).toBe(true);
    expect(canRespond({ state: "EXHAUSTED" } as Incident)).toBe(true);
    expect(canRespond({ state: "DOOR_OPEN" } as Incident)).toBe(false);
    expect(canRespond({ state: "RETURNED" } as Incident)).toBe(false);
  });
  it("does not call a household member’s self-identification Dad’s return", () => {
    const incident = {
      state: "RETURNED",
      checkin: "self_other",
      checkin_who: "Mike",
    } as Incident;
    expect(confirmedReturned(incident)).toBe(false);
    expect(incidentTitle(incident, "Dad")).toBe("Mike checked in");
  });
  it("clamps elapsed deadlines and uses authoritative timestamps", () => {
    expect(
      countdown("2026-10-24T10:15:00Z", Date.parse("2026-10-24T10:02:20Z")),
    ).toBe("12:40");
    expect(
      countdown("2026-10-24T10:15:00Z", Date.parse("2026-10-24T10:20:00Z")),
    ).toBe("0:00");
    expect(countdown(null, Date.now())).toBe("—");
  });
  it("distinguishes a Help button request from an exit while still allowing a family response", () => {
    const incident = { state: "ESCALATING", cause: "help" } as Incident;
    expect(isHelpIncident(incident)).toBe(true);
    expect(incidentTitle(incident, "Dad")).toBe("Help requested at the door");
    expect(canRespond(incident)).toBe(true);
    expect(canShowEmergency(incident)).toBe(true);
  });
  it.each(["RETURNED", "CLOSED", "WATCHING"])(
    "suppresses stale emergency state for %s",
    (state) => {
      const incident = { state, emergency: { option_shown: true } } as Incident;
      expect(isResolvedIncident(incident)).toBe(true);
      expect(canRespond(incident)).toBe(false);
      expect(canShowEmergency(incident)).toBe(false);
    },
  );
  it("keeps the emergency option eligible after ack until return is confirmed", () => {
    expect(
      canShowEmergency({ state: "ACKED", person_in_frame: false } as Incident),
    ).toBe(true);
    expect(
      canShowEmergency({ state: "ACKED", checkin: "self_other" } as Incident),
    ).toBe(false);
    expect(canShowEmergency({ state: "CONVERSATION" } as Incident)).toBe(false);
    expect(canShowEmergency(null)).toBe(false);
  });
});
