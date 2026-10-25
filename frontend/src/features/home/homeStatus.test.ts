import { describe, expect, it } from "vitest";
import { createPreviewState } from "../../data/preview";
import { doorDecisionFacts, getHomeStatus } from "./homeStatus";

describe("Home status follows the current incident", () => {
  it("does not treat a family acknowledgement as Dad returning", () => {
    const state = createPreviewState("responding");
    const result = getHomeStatus(state, true, true);
    expect(result.title).toBe("Sarah is on it");
    expect(result.reason).toContain("return is not confirmed");
    expect(result.action.path).toBe("/incident/respond");
  });

  it.each(["self_other", "other_face"])(
    "resolves %s without confirming Dad returned",
    (kind) => {
      const state = createPreviewState("returned");
      if (kind === "self_other") {
        state.incident!.checkin = "self_other";
        state.incident!.checkin_who = "Sarah";
      } else state.incident!.identity = "other";
      const result = getHomeStatus(state, true, true);
      expect(result.title).toBe("Check-in resolved");
      expect(result.reason).toContain("does not confirm Dad returned");
    },
  );

  it("keeps observation-only state ahead of a retained acknowledgement", () => {
    const state = createPreviewState("responding");
    state.incident!.state = "WATCHING";
    const result = getHomeStatus(state, true, true);
    expect(result.title).toBe("Watching");
    expect(result.reason).toContain("Family calls are not active");
    expect(result.action.path).toBe("/door");
  });

  it("describes a help call without asserting an exit", () => {
    const state = createPreviewState("help");
    const result = getHomeStatus(state, true, true);
    expect(result.title).toBe("Calling family");
    expect(result.reason).toContain("Help was requested");
    expect(result.reason).not.toMatch(/return|left home/i);
  });

  it("does not claim calls are still progressing after the ladder is exhausted", () => {
    const state = createPreviewState("ringing");
    state.incident!.state = "EXHAUSTED";
    const result = getHomeStatus(state, true, true);
    expect(result.title).toBe("No family response yet");
    expect(result.reason).toContain("call order has finished");
    expect(result.reason).not.toContain("is contacting");
  });

  it("does not mislabel visitors as Dad", () => {
    const result = getHomeStatus(createPreviewState("visitor"), true, true);
    expect(result.title).toBe("Someone is at the door");
    expect(result.reason).toContain("not a confirmed exit");
  });

  it("keeps an active incident visible after night watch is disabled", () => {
    const state = createPreviewState("ringing");
    state.night_mode = false;
    expect(getHomeStatus(state, true, true).title).toBe("Calling family");
    state.incident = null;
    expect(getHomeStatus(state, true, true).title).toBe("Night watch is off");
  });

  it("offers connection checks when live camera data is missing", () => {
    const state = createPreviewState("watching");
    state.voice.mock = false;
    state.voice.source = "clone";
    state.live_frame = false;
    expect(getHomeStatus(state, true, false).action.path).toBe(
      "/setup/connect",
    );
    state.live_frame = true;
    expect(getHomeStatus(state, true, false).action.path).toBe("/door");
  });

  it.each(["mock", "flag"])(
    "does not treat a %s voice as ready outside Preview",
    (kind) => {
      const state = createPreviewState("watching");
      state.live_frame = true;
      state.voice.mock = kind === "flag";
      state.voice.source = kind === "mock" ? "mock" : "clone";
      expect(getHomeStatus(state, true, false).action.path).toBe(
        "/setup/connect",
      );
    },
  );

  it("names only the latest ring group belonging to the current incident", () => {
    const state = createPreviewState("ringing");
    state.rings = [
      {
        incident_id: state.incident!.id,
        tier: 1,
        members: ["Sarah"],
        member_ids: ["TM-SARAH"],
      },
      {
        incident_id: state.incident!.id,
        tier: 2,
        members: ["Mike", "Linda"],
        member_ids: ["TM-MIKE", "TM-LINDA"],
      },
      {
        incident_id: "old-incident",
        tier: 3,
        members: ["Unrelated person"],
        member_ids: ["OLD"],
      },
    ];
    const result = getHomeStatus(state, true, true);
    expect(result.reason).toContain("Mike and Linda are being contacted.");
    expect(result.reason).not.toMatch(/Sarah|Unrelated person/);
  });

  it("does not invent a recipient when only stale ring entries exist", () => {
    const state = createPreviewState("ringing");
    state.rings = [
      {
        incident_id: "old-incident",
        tier: 1,
        members: ["Sarah"],
        member_ids: ["TM-SARAH"],
      },
    ];
    const result = getHomeStatus(state, true, true);
    expect(result.reason).not.toContain("Sarah");
    expect(result.reason).toContain("Nightfall is contacting the care circle.");
  });

  it("accepts the current unscoped legacy ring group like the provider", () => {
    const state = createPreviewState("ringing");
    state.rings = [{ tier: 1, members: ["Sarah"], member_ids: ["TM-SARAH"] }];
    expect(getHomeStatus(state, true, true).reason).toContain(
      "Sarah is being contacted.",
    );
  });
});

describe("Door explanation uses reported facts", () => {
  it("leaves identity and direction unknown until the server provides them", () => {
    const incident = createPreviewState("approach").incident!;
    incident.identity = "unknown";
    incident.direction = "unknown";
    incident.wander.action = "speak_only";
    expect(doorDecisionFacts(incident, "Dad")).toEqual([
      "The person’s identity is not confirmed.",
      "Movement direction has not been determined.",
      "The current rule allows a voice check-in without starting family calls.",
    ]);
  });

  it("explains direct help requests independently of a wander score", () => {
    const incident = createPreviewState("help").incident!;
    expect(doorDecisionFacts(incident, "Dad")).toEqual([
      "The Help button requested family assistance.",
      "This does not establish who is at the door or whether anyone left home.",
    ]);
  });
});
