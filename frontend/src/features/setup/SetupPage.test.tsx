import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewState } from "../../data/preview";
import { api } from "../../data/api";
import { JoinPage, SetupPage } from "./SetupPage";
const context = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const nearby = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../state/NightfallProvider", () => ({
  useNightfall: () => context.current,
}));
vi.mock("../../state/useNearbySearch", async () => {
  const { useState } = await import("react");
  return {
    useNearbySearch: () => {
      const [draft, setDraft] = useState(nearby.current.draft);
      return { ...nearby.current, draft, setDraft };
    },
  };
});
vi.mock("../../components/MapView", () => ({ default: () => <div>Map</div> }));
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,example") },
}));
vi.mock("../../data/api", async () => {
  const actual = await vi.importActual("../../data/api");
  return { ...actual, api: { get: vi.fn() } };
});

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {
      this.removeAttribute("open");
    },
  });
  vi.mocked(api.get).mockResolvedValue({ faces: [] });
  context.current = {
    state: createPreviewState(),
    preview: false,
    mutate: vi.fn().mockResolvedValue({ ok: true }),
    setMember: vi.fn(),
    loading: false,
    error: null,
  };
  nearby.current = {
    phase: "idle",
    data: null,
    input: null,
    error: null,
    draft: { address: createPreviewState().household.address, radius_mi: 1.5 },
    busy: false,
    loading: false,
    saved: false,
    startedAt: null,
    completedAt: null,
    start: vi.fn(),
    retry: vi.fn(),
    reload: vi.fn(),
  };
});
afterEach(() => vi.useRealTimers());

function mountCamera() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const page = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/setup/camera"]}>
        <Routes>
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const ui = render(page());
  return { client, rerender: () => ui.rerender(page()) };
}

describe("Setup actions", () => {
  it("saves the profile once, then goes through contacts before voice without duplicate writes or search", async () => {
    const mutate = vi.fn().mockResolvedValue({ ok: true });
    context.current = { ...context.current, mutate };
    render(
      <MemoryRouter initialEntries={["/setup/profile"]}>
        <Routes>
          <Route path="/setup/voice" element={<p>Voice step</p>} />
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      screen.getByLabelText("Set up Nightfall, step 1 of 4"),
    ).toBeVisible();
    expect(
      screen.getByText(/More care details/).closest("details"),
    ).not.toHaveAttribute("open");
    fireEvent.change(screen.getByLabelText("Your name"), {
      target: { value: "Alex" },
    });
    fireEvent.change(screen.getByLabelText("Home address"), {
      target: { value: "123 New Street" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { name: "Who should we call?" }),
    ).toBeVisible();
    expect(
      screen.getByLabelText("Set up Nightfall, step 2 of 4"),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /Back/ })).toHaveAttribute(
      "href",
      "/setup/profile",
    );
    fireEvent.click(screen.getByRole("button", { name: "Next: Voice" }));
    expect(await screen.findByText("Voice step")).toBeVisible();
    expect(mutate).toHaveBeenCalledExactlyOnceWith("/profile", {
      caregiver_name: "Alex",
    });
    expect(nearby.current.start).toHaveBeenCalledExactlyOnceWith({
      address: "123 New Street",
      radius_mi: 1.5,
    });
  });

  it("shows Photo and automatic nearby search without manual places in the main profile", () => {
    render(
      <MemoryRouter initialEntries={["/setup/profile"]}>
        <Routes>
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const photo = screen.getByRole("button", { name: /^Photo/ });
    const details = screen.getByText(/More care details/).closest("details")!;
    expect(photo).toBeVisible();
    expect(photo.closest("details")).toBeNull();
    expect(screen.queryByText("Familiar places")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Place details" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Nearby places and hazards are found automatically/),
    ).toBeVisible();
    expect(
      screen.queryByText("A recent photo helps family recognize them."),
    ).not.toBeInTheDocument();
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("Medications")).not.toBeVisible();
    expect(screen.queryByText("First contact")).not.toBeInTheDocument();
    expect(screen.queryByText("Care circle")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /^(Add|Invite).*(family|contact)/i,
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/More care details/));
    expect(screen.queryByText("Familiar places")).not.toBeInTheDocument();
    expect(screen.getAllByText("Photo")).toHaveLength(1);
    expect(screen.queryByText("Care circle")).not.toBeInTheDocument();
  });

  it("keeps unsupported live photo edits honest without sending save requests", async () => {
    render(
      <MemoryRouter initialEntries={["/setup/profile"]}>
        <Routes>
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Photo/ }));
    expect(
      await screen.findByText(/Editing isn’t available yet/),
    ).toHaveTextContent("photo");
    expect(screen.queryByLabelText("Choose a photo")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(
      screen.queryByRole("button", { name: "Place details" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Save|Update preview/ }),
    ).not.toBeInTheDocument();
    expect(context.current.mutate).not.toHaveBeenCalled();
    expect(nearby.current.start).not.toHaveBeenCalled();
  });

  it("reuses unchanged details and returns a profile edit to Home", async () => {
    render(
      <MemoryRouter
        initialEntries={["/setup/profile?mode=edit&returnTo=/home"]}
      >
        <Routes>
          <Route path="/home" element={<p>Home again</p>} />
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      screen.queryByLabelText(/Set up Nightfall, step/),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Home again")).toBeVisible();
    expect(context.current.mutate).not.toHaveBeenCalled();
    expect(nearby.current.start).not.toHaveBeenCalled();
  });

  it("does not launch a new search when the initial status lookup failed for the saved address", async () => {
    nearby.current = {
      ...nearby.current,
      phase: "error",
      input: null,
      error: "Could not load the existing search",
    };
    render(
      <MemoryRouter initialEntries={["/setup/profile"]}>
        <Routes>
          <Route path="/setup/voice" element={<p>Voice step</p>} />
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { name: "Who should we call?" }),
    ).toBeVisible();
    expect(nearby.current.start).not.toHaveBeenCalled();
  });

  it("saves a name-only edit without rerunning the saved address search", async () => {
    render(
      <MemoryRouter
        initialEntries={["/setup/profile?mode=edit&returnTo=/home"]}
      >
        <Routes>
          <Route path="/home" element={<p>Home again</p>} />
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Your name"), {
      target: { value: "Alex" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Home again")).toBeVisible();
    expect(context.current.mutate).toHaveBeenCalledExactlyOnceWith("/profile", {
      caregiver_name: "Alex",
    });
    expect(nearby.current.start).not.toHaveBeenCalled();
  });

  it("stays on the first step when profile persistence fails and does not start address search", async () => {
    context.current = {
      ...context.current,
      mutate: vi.fn().mockRejectedValue(new Error("Could not save profile")),
    };
    render(
      <MemoryRouter initialEntries={["/setup/profile"]}>
        <Routes>
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Your name"), {
      target: { value: "Alex" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save profile",
    );
    expect(nearby.current.start).not.toHaveBeenCalled();
  });

  it("does not restart an uncertain failed address request just to move to the contact step", async () => {
    nearby.current = {
      ...nearby.current,
      phase: "error",
      error: "Connection lost",
      input: nearby.current.draft,
    };
    render(
      <MemoryRouter initialEntries={["/setup/profile"]}>
        <Routes>
          <Route path="/setup/voice" element={<p>Voice step</p>} />
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { name: "Who should we call?" }),
    ).toBeVisible();
    expect(nearby.current.start).not.toHaveBeenCalled();
  });

  it("finishes contact editing at its source instead of pushing another setup step", () => {
    render(
      <MemoryRouter
        initialEntries={["/setup/contacts?mode=edit&returnTo=/home"]}
      >
        <Routes>
          <Route path="/home" element={<p>Home again</p>} />
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      screen.queryByLabelText(/Set up Nightfall, step/),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("Home again")).toBeVisible();
    expect(context.current.mutate).not.toHaveBeenCalled();
  });

  it("uses the existing add-contact API only from the dedicated contact step", async () => {
    render(
      <MemoryRouter initialEntries={["/setup/contacts"]}>
        <Routes>
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      screen.getByLabelText("Set up Nightfall, step 2 of 4"),
    ).toBeVisible();
    const contacts = [...createPreviewState().household.tree].sort(
      (a, b) => a.tier - b.tier,
    );
    for (const member of contacts) {
      const card = screen.getByText(member.name).parentElement!.parentElement!;
      expect(within(card).getByText(String(member.tier))).toBeVisible();
    }
    expect(context.current.mutate).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Invite a family member" }),
    );
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Robin" },
    });
    fireEvent.change(screen.getByLabelText("Call priority"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
    await screen.findByText(/Robin was added/);
    expect(context.current.mutate).toHaveBeenCalledExactlyOnceWith("/tree", {
      name: "Robin",
      phone: "web",
      tier: 2,
    });
    expect(nearby.current.start).not.toHaveBeenCalled();
  });

  it("does not fabricate a first contact when the care circle is empty", () => {
    const emptyState = createPreviewState();
    emptyState.household.tree = [];
    context.current = { ...context.current, state: emptyState };
    render(
      <MemoryRouter initialEntries={["/setup/contacts"]}>
        <Routes>
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Next: Voice" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Invite a family member" }),
    ).toBeEnabled();
    expect(context.current.mutate).not.toHaveBeenCalled();
  });

  it("saves optional physical, diagnosis and doctor details using the supported profile fields", async () => {
    const mutate = vi.fn().mockResolvedValue({ ok: true });
    context.current = { ...context.current, mutate };
    render(
      <MemoryRouter initialEntries={["/setup/profile"]}>
        <Routes>
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText(/More care details/));
    fireEvent.click(screen.getByText("Search & medical details"));
    fireEvent.change(screen.getByLabelText("Height"), {
      target: { value: " 5 ft 8 in " },
    });
    fireEvent.change(screen.getByLabelText("Diagnosis"), {
      target: { value: " Alzheimer’s " },
    });
    fireEvent.change(screen.getByLabelText("Doctor or clinic"), {
      target: { value: " Dr. Lee " },
    });
    fireEvent.change(screen.getByLabelText("Doctor’s phone"), {
      target: { value: " 555-0100 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(
        "/profile",
        expect.objectContaining({
          description: expect.objectContaining({ height: "5 ft 8 in" }),
          diagnosis: "Alzheimer’s",
          doctor: { name: "Dr. Lee", phone: "555-0100" },
        }),
      ),
    );
    expect(mutate.mock.calls[0][1]).not.toHaveProperty("medications");
  });

  it("only accepts enrollment feedback for the requested person and offers retry on error", async () => {
    context.current = {
      ...context.current,
      mutate: vi.fn().mockResolvedValue({ ok: true }),
    };
    const ui = mountCamera();
    await waitFor(() =>
      expect(ui.client.getQueryData(["faces", false])).toEqual({ faces: [] }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Register Dad’s face" }),
    );
    await screen.findByText(/Waiting for the door camera to register/);
    context.current = {
      ...context.current,
      lastEvent: {
        type: "door",
        event: "enroll_success",
        name: "Someone else",
        label: "person",
      },
    };
    ui.rerender();
    expect(
      screen.getByText(/Waiting for the door camera to register/),
    ).toBeInTheDocument();
    context.current = {
      ...context.current,
      lastEvent: {
        type: "door",
        event: "enroll_error",
        name: "Robert Miller",
        label: "person",
        detail: "No face found. Face the camera and try again.",
      },
    };
    ui.rerender();
    expect(await screen.findByRole("alert")).toHaveTextContent("No face found");
    expect(
      screen.queryByText(/Waiting for the door camera to register/),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Try registration again" }),
    );
    expect(
      screen.getByText(/Waiting for the door camera to register/),
    ).toBeInTheDocument();
    context.current = {
      ...context.current,
      lastEvent: {
        type: "door",
        event: "enroll_success",
        name: "Robert Miller",
        label: "person",
      },
    };
    ui.rerender();
    expect(
      await screen.findByText("Robert Miller’s face is registered."),
    ).toBeInTheDocument();
  });

  it("does not mistake an existing face for a fresh registration and times out with retry", async () => {
    vi.mocked(api.get).mockResolvedValue({
      faces: [{ name: "Robert Miller", label: "person" }],
    });
    context.current = {
      ...context.current,
      mutate: vi.fn(() => new Promise(() => {})),
    };
    const ui = mountCamera();
    await screen.findByText("Registered");
    vi.useFakeTimers();
    fireEvent.click(
      screen.getByRole("button", { name: "Register Dad’s face" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_001);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "No registration confirmation yet",
    );
    expect(
      screen.getByRole("button", { name: "Try registration again" }),
    ).toBeEnabled();
    expect(
      screen.queryByText("Robert Miller’s face is registered."),
    ).not.toBeInTheDocument();
    ui.client.clear();
  });

  it("joins through the existing tree API and selects the returned member", async () => {
    const mutate = vi.fn().mockResolvedValue({ member_id: "TM-NEW" });
    const setMember = vi.fn();
    context.current = { ...context.current, mutate, setMember };
    render(
      <MemoryRouter>
        <JoinPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Your name"), {
      target: { value: "Alex" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join as #1" }));
    await screen.findByText("You’re in the care circle");
    expect(mutate).toHaveBeenCalledWith("/tree", {
      name: "Alex",
      phone: "web",
      tier: 1,
    });
    expect(setMember).toHaveBeenCalledWith("TM-NEW");
  });
  it("opens progress immediately without waiting for the shared address search", async () => {
    const start = vi.fn(() => new Promise(() => {}));
    nearby.current = { ...nearby.current, start };
    render(
      <MemoryRouter initialEntries={["/setup/places"]}>
        <Routes>
          <Route path="/setup/nearby" element={<p>Nearby results</p>} />
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Home address"), {
      target: { value: "New home address" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Prepare nearby places" }),
    );
    expect(start).toHaveBeenCalledExactlyOnceWith({
      address: "New home address",
      radius_mi: 1.5,
    });
    expect(screen.getByText("Nearby results")).toBeVisible();
    expect(context.current.mutate).not.toHaveBeenCalled();
  });

  it("returns to settings while the address request is pending, without showing fixture places", () => {
    nearby.current = {
      ...nearby.current,
      phase: "locating",
      busy: true,
      startedAt: Date.now(),
      data: { total: 11, places_source: "fixture" },
    };
    render(
      <MemoryRouter initialEntries={["/setup/nearby"]}>
        <Routes>
          <Route path="/care" element={<p>Care settings</p>} />
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(/has not been confirmed saved yet/)).toBeVisible();
    expect(screen.queryByText("Map")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("Care settings")).toBeVisible();
    expect(nearby.current.start).not.toHaveBeenCalled();
  });

  it("labels retained results while refreshing and only starts a fresh search on Refresh", () => {
    const data = {
      total: 2,
      places_source: "apify",
      home: { lat: 37.8, lng: -122.44, radius_mi: 1.5 },
      hazards_ranked: [],
      call_first: [],
      familiar: [],
    };
    nearby.current = {
      ...nearby.current,
      phase: "searching",
      busy: true,
      data,
    };
    // Params are required to select the nearby setup screen.
    const page = () => (
      <MemoryRouter initialEntries={["/setup/nearby"]}>
        <Routes>
          <Route path="/setup/:step" element={<SetupPage />} />
        </Routes>
      </MemoryRouter>
    );
    const view = render(page());
    expect(screen.getByText("Previously available places")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Refresh" }),
    ).not.toBeInTheDocument();
    nearby.current = {
      ...nearby.current,
      phase: "ready",
      busy: false,
      saved: true,
    };
    view.rerender(page());
    expect(screen.getByText("Saved results")).toBeVisible();
    expect(nearby.current.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(nearby.current.start).toHaveBeenCalledWith(nearby.current.draft, {
      force: true,
    });
  });
});
