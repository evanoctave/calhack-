import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewState } from "../../data/preview";
import { api } from "../../data/api";
import { JoinPage, SetupPage } from "./SetupPage";
const context = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../state/NightfallProvider", () => ({
  useNightfall: () => context.current,
}));
vi.mock("../../components/MapView", () => ({ default: () => <div>Map</div> }));
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
    mutate: vi.fn(),
    setMember: vi.fn(),
    loading: false,
    error: null,
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
    fireEvent.click(
      screen.getByRole("button", { name: /Search & medical details/ }),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
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
  it("saves the address and radius with the same request that starts the nearby search", async () => {
    const mutate = vi.fn().mockResolvedValue({});
    context.current = { ...context.current, mutate };
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
    fireEvent.click(screen.getByRole("button", { name: "Find nearby places" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]).toEqual([
      "/setup/address",
      { address: "New home address", radius_mi: 1.5, google: true },
    ]);
  });
});
