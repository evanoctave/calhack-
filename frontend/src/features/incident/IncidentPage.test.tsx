import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createPreviewState } from "../../data/preview";
import type { NightfallState } from "../../data/types";
import { AlertPage } from "./IncidentPage";

const { context } = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock("../../state/NightfallProvider", () => ({ useNightfall: context }));

function show(state: NightfallState, extra = {}) {
  context.mockReturnValue({
    state,
    memberId: "TM-SARAH",
    preview: true,
    ...extra,
  });
  return render(
    <MemoryRouter>
      <AlertPage />
    </MemoryRouter>,
  );
}

describe("current incident presentation", () => {
  it("does not retain a 911 call after a confirmed return, even if the server flag remains set", () => {
    const state = createPreviewState("returned");
    state.call_911 = true;
    state.incident!.emergency.option_shown = true;
    show(state);
    expect(
      screen.getByRole("heading", { name: "Dad is back inside" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Call 911" }),
    ).not.toBeInTheDocument();
  });
  it("keeps a help request separate from an exit and its 15-minute search timer", () => {
    const state = createPreviewState("help");
    state.incident!.cause = "help";
    state.call_911 = true;
    show(state);
    expect(
      screen.getByRole("heading", { name: "Help requested at the door" }),
    ).toBeVisible();
    expect(
      screen.queryByText(/Dad is still out of view/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/15-minute mark in/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Call 911" })).toBeVisible();
    expect(screen.getAllByText("Phone alerted · Help requested")).toHaveLength(
      3,
    );
  });
  it("uses retained door speech and visitor text instead of the most recent unrelated phone event", () => {
    const state = createPreviewState("visitor");
    show(state, {
      lastEvent: { type: "ring" },
      doorSpeech: { text: "How can I help?", incident_id: state.incident!.id },
      visitorMessage: "I have a delivery.",
    });
    expect(screen.getByText("I have a delivery.")).toBeVisible();
    expect(screen.getByText("Nightfall: How can I help?")).toBeVisible();
  });
});
