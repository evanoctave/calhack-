import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NightfallContextValue } from "../../state/NightfallProvider";
import { ApiError } from "../../data/api";
import { createPreviewBrief, createPreviewState } from "../../data/preview";
import { BriefPage } from "./BriefPage";

const mocks = vi.hoisted(() => ({
  useNightfall: vi.fn(),
  get: vi.fn(),
  mutate: vi.fn(),
  setMember: vi.fn(),
}));
vi.mock("../../state/NightfallProvider", () => ({
  useNightfall: mocks.useNightfall,
}));
vi.mock("../../data/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../data/api")>();
  return { ...original, api: { ...original.api, get: mocks.get } };
});
vi.mock("../../components/MapView", () => ({
  default: () => <div>Search map</div>,
}));
vi.mock("../../components/CameraFeed", () => ({
  CameraFeed: ({ src, caption }: { src?: string; caption?: string }) => (
    <figure>
      <img src={src} alt="Incident capture" />
      <figcaption>{caption}</figcaption>
    </figure>
  ),
}));

let client: QueryClient;
let context: Partial<NightfallContextValue>;
const originalShowModal = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
const originalClose = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "close",
);
function Tree({ entry = "/brief/signed-token" }: { entry?: string }) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/brief/:token?" element={<BriefPage />} />
          <Route path="/incident/respond" element={<p>Response screen</p>} />
          <Route path="/home" element={<p>Home screen</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const state = createPreviewState("ringing");
  context = {
    state,
    preview: false,
    memberId: "TM-SARAH",
    mutate: mocks.mutate,
    setMember: mocks.setMember,
    lastEvent: null,
  };
  mocks.useNightfall.mockImplementation(() => context);
  mocks.get.mockResolvedValue(createPreviewBrief(state));
  mocks.mutate.mockResolvedValue({ ok: true, first: true });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  if (originalShowModal)
    Object.defineProperty(
      HTMLDialogElement.prototype,
      "showModal",
      originalShowModal,
    );
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalClose)
    Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

describe("brief recipient and incident binding", () => {
  it("does not acknowledge an old incident even when its signed brief still opens", async () => {
    const brief = createPreviewBrief(context.state!);
    mocks.get.mockResolvedValue({ ...brief, incident_id: "OLD-INCIDENT" });
    render(<Tree />);
    await screen.findByText(/This is an earlier brief/);
    expect(
      screen.queryByRole("button", { name: "I’ve got him" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to Home" }));
    await screen.findByText("Home screen");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("binds the verified token recipient and acknowledges as that member, not the default member", async () => {
    mocks.get.mockResolvedValue(createPreviewBrief(context.state!, "TM-MIKE"));
    render(<Tree />);
    const button = await screen.findByRole("button", { name: "I’ve got him" });
    await waitFor(() =>
      expect(mocks.setMember).toHaveBeenCalledWith("TM-MIKE"),
    );
    fireEvent.click(button);
    await screen.findByText("Response screen");
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith("/ack", {
      incident_id: "PREVIEW-INCIDENT",
      member_id: "TM-MIKE",
    });
  });

  it("does not substitute the default member when a response has no verified viewer", async () => {
    mocks.get.mockResolvedValue({
      ...createPreviewBrief(context.state!),
      viewer: undefined,
    });
    render(<Tree />);
    expect(
      await screen.findByRole("button", { name: "I’ve got him" }),
    ).toBeDisabled();
    expect(mocks.setMember).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it.each([
    [404, "This link is not valid"],
    [410, "This link has expired"],
  ] as const)(
    "renders the %i token error without offering acknowledgement",
    async (status, title) => {
      mocks.get.mockRejectedValue(new ApiError(status, "token unavailable"));
      render(<Tree />);
      expect(await screen.findByRole("heading", { name: title })).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "I’ve got him" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Try again" }),
      ).not.toBeInTheDocument();
      expect(mocks.mutate).not.toHaveBeenCalled();
    },
  );

  it("keeps the in-app token stable when the same incident snapshot contains a newly minted link", async () => {
    context.state!.incident!.brief_link = "/brief.html#first-token";
    const view = render(<Tree entry="/brief" />);
    await screen.findByRole("button", { name: "I’ve got him" });
    expect(mocks.get.mock.calls[0][0]).toBe("/brief/first-token");
    context = {
      ...context,
      state: {
        ...context.state!,
        now: new Date().toISOString(),
        incident: {
          ...context.state!.incident!,
          brief_link: "/brief.html#fresh-token",
        },
      },
    };
    view.rerender(<Tree entry="/brief" />);
    expect(screen.getByRole("button", { name: "I’ve got him" })).toBeVisible();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(
      mocks.get.mock.calls.some(([path]) => path === "/brief/fresh-token"),
    ).toBe(false);
  });

  it("opens the first available brief when its link arrives later for the same incident", async () => {
    context.state!.incident!.brief_link = "";
    const view = render(<Tree entry="/brief" />);
    expect(
      screen.getByText(
        "A brief will be ready after an exit or a help request.",
      ),
    ).toBeVisible();
    expect(mocks.get).not.toHaveBeenCalled();
    context = {
      ...context,
      state: {
        ...context.state!,
        incident: {
          ...context.state!.incident!,
          brief_link: "/brief.html#newly-ready-token",
        },
      },
    };
    view.rerender(<Tree entry="/brief" />);
    expect(
      await screen.findByRole("button", { name: "I’ve got him" }),
    ).toBeVisible();
    expect(mocks.get.mock.calls[0][0]).toBe("/brief/newly-ready-token");
  });

  it("opens and closes photo details without acknowledging or answering", async () => {
    render(<Tree />);
    fireEvent.click(
      await screen.findByRole("button", { name: "View camera capture" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Camera capture" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "I’ve got him" })).toBeEnabled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("uses incident captures as the main photo and labels the profile photo separately", async () => {
    const brief = createPreviewBrief(context.state!);
    mocks.get.mockResolvedValue({
      ...brief,
      photo: "/profile-reference.jpg",
      exit_frames: ["/exit-first.jpg", "/exit-second.jpg"],
    });
    render(<Tree />);
    expect(await screen.findByAltText("Incident capture")).toHaveAttribute(
      "src",
      "/exit-first.jpg",
    );
    fireEvent.click(screen.getByText("Care details & contacts"));
    expect(screen.getByAltText("Care profile photo of Dad")).toHaveAttribute(
      "src",
      "/profile-reference.jpg",
    );
    expect(
      screen.getByText(
        "From the care profile. This is not an incident camera capture.",
      ),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "View reference photo" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Reference photo" }),
    ).toBeVisible();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("does not substitute a profile photo when no incident capture exists", async () => {
    mocks.get.mockResolvedValue({
      ...createPreviewBrief(context.state!),
      photo: "/profile-reference.jpg",
      exit_frames: [],
    });
    render(<Tree />);
    expect(
      await screen.findByText(
        "No exit camera capture is available for this incident.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "View camera capture" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByAltText("Incident capture")).not.toBeInTheDocument();
  });

  it.each([
    ["RETURNED", "self_other", "The alert ended"],
    ["RETURNED", "none", "Calls have stopped"],
    ["WATCHING", "none", "has not started family calls"],
    ["CLOSED", "none", "No family response is needed"],
  ] as const)(
    "does not invite a response or show emergency controls for %s / %s",
    async (state, checkin, message) => {
      context.state!.incident!.state = state;
      context.state!.incident!.checkin = checkin;
      context.state!.incident!.checkin_who = "Mike";
      render(<Tree />);
      expect(await screen.findByText(new RegExp(message))).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "I’ve got him" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "Call 911" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Emergency recommendation in/),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Back to Home" }));
      expect(mocks.mutate).not.toHaveBeenCalled();
    },
  );

  it("labels a door help request without claiming an exit or showing an exit countdown", async () => {
    context.state!.incident!.cause = "help";
    mocks.get.mockResolvedValue({
      ...createPreviewBrief(context.state!),
      cause: "help",
    });
    render(<Tree />);
    expect(
      await screen.findByRole("heading", {
        name: /Help requested at the door at/,
      }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Help was requested at the door. A departure has not been confirmed.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: /left home/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Emergency recommendation in/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Call 911" })).toHaveAttribute(
      "href",
      "tel:911",
    );
    expect(screen.getByRole("button", { name: "I’ve got him" })).toBeEnabled();
  });

  it.each([
    ["RETURNED", "Dad is back inside"],
    ["CLOSED", "This check-in has ended"],
  ] as const)(
    "prioritizes the %s result over a previous help request in the heading",
    async (state, heading) => {
      context.state!.incident!.state = state;
      context.state!.incident!.cause = "help";
      context.state!.incident!.acked_by = "TM-SARAH";
      mocks.get.mockResolvedValue({
        ...createPreviewBrief(context.state!),
        cause: "help",
      });
      render(<Tree />);
      expect(
        await screen.findByRole("heading", { name: heading }),
      ).toBeVisible();
      expect(
        screen.queryByRole("heading", {
          name: /Help requested at the door at/,
        }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "Call 911" }),
      ).not.toBeInTheDocument();
    },
  );

  it("keeps supported structured care and previous incident facts in a compact disclosure", async () => {
    mocks.get.mockResolvedValue({
      ...createPreviewBrief(context.state!),
      description: { height: "5 ft 9 in", marks: "Scar on left hand" },
      diagnosis: "Alzheimer’s disease",
      doctor: { name: "Dr. Chen", phone: "+14155550123" },
      heading: "left",
      history: {
        count: 2,
        typical_minutes: 7,
        headings: ["right"],
        last: [
          {
            outcome: "returned",
            exited_at: "2026-10-23T02:03:00-07:00",
            minutes_out: 6,
            heading: "right",
          },
        ],
      },
    });
    render(<Tree />);
    fireEvent.click(await screen.findByText("Care details & contacts"));
    expect(screen.getByText("5 ft 9 in")).toBeVisible();
    expect(screen.getByText("Scar on left hand")).toBeVisible();
    expect(screen.getByText("Alzheimer’s disease")).toBeVisible();
    expect(screen.getByText("Dr. Chen")).toBeVisible();
    expect(screen.getByRole("link", { name: "+14155550123" })).toHaveAttribute(
      "href",
      "tel:+14155550123",
    );
    expect(screen.getByText("Left of the door camera")).toBeVisible();
    expect(screen.getByText(/2 recorded incidents/)).toBeVisible();
    expect(screen.getByText("Return confirmed")).toBeVisible();
  });
});
