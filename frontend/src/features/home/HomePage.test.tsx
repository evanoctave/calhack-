import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewState } from "../../data/preview";
import type { NightfallState } from "../../data/types";
import { HomePage } from "./HomePage";

const { context } = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock("../../state/NightfallProvider", () => ({ useNightfall: context }));
vi.mock("../live/useDoorVideo", () => ({
  useDoorVideo: () => ({
    src: undefined,
    live: false,
    status: "Camera unavailable",
  }),
}));
vi.mock("../../components/CameraFeed", () => ({
  CameraFeed: () => <div>Door camera</div>,
}));

function show(state: NightfallState) {
  context.mockReturnValue({
    state,
    memberId: "TM-SARAH",
    preview: true,
    soundEnabled: true,
  });
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Home current status and contact priority", () => {
  it("shows a confirmed return after an earlier family acknowledgement", () => {
    const state = createPreviewState("returned");
    state.incident!.acked_by = "TM-SARAH";
    state.incident!.acked_by_name = "Sarah";
    show(state);
    expect(
      screen.getByRole("heading", { name: "Dad is back inside" }),
    ).toBeVisible();
    expect(screen.getByText("Return confirmed")).toBeVisible();
    expect(screen.queryByText(/Return not confirmed/)).not.toBeInTheDocument();
  });

  it("ends help instructions when an acknowledged help incident is closed", () => {
    const state = createPreviewState("help");
    state.incident!.state = "CLOSED";
    state.incident!.cause = "help";
    state.incident!.acked_by = "TM-SARAH";
    state.incident!.acked_by_name = "Sarah";
    show(state);
    expect(
      screen.getByRole("heading", { name: "Night watch is on" }),
    ).toBeVisible();
    expect(screen.getByText("Check-in complete")).toBeVisible();
    expect(
      screen.queryByText("Help button pressed · Check the door"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open current alert" }),
    ).not.toBeInTheDocument();
  });

  it("sorts real call tiers and groups family members who ring together", () => {
    const state = createPreviewState("watching");
    const [sarah, mike, linda] = state.household.tree;
    state.household.tree = [
      { ...linda, tier: 3 },
      { ...sarah, tier: 1 },
      { ...mike, tier: 2 },
      { ...sarah, id: "TM-ALEX", name: "Alex", tier: 1 },
    ];
    show(state);
    expect(
      screen.getByText("1 · Sarah + Alex → 2 · Mike → 3 · Linda (neighbor)"),
    ).toBeVisible();
    expect(state.household.tree[0].id).toBe(linda.id);
  });
});
