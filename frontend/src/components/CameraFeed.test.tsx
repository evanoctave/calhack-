import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraFeed } from "./CameraFeed";

const originalShowModal = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
const originalClose = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "close",
);
let previousBodyOverflow = "";

beforeEach(() => {
  previousBodyOverflow = document.body.style.overflow;
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
  document.body.style.overflow = previousBodyOverflow;
  vi.restoreAllMocks();
  for (const [name, original] of [
    ["showModal", originalShowModal],
    ["close", originalClose],
  ] as const) {
    if (original)
      Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

function openCamera() {
  const trigger = screen.getByRole("button", {
    name: "View camera full screen",
  });
  trigger.focus();
  fireEvent.click(trigger);
  return {
    trigger,
    dialog: screen.getByRole("dialog", { name: "Front entrance camera" }),
  };
}

describe("CameraFeed full-screen viewing", () => {
  it("keeps legacy feeds non-interactive so callers can wrap them in a button", () => {
    render(<CameraFeed src="/frames/saved.jpg" />);
    expect(
      screen.getByRole("img", { name: "Recorded camera image" }),
    ).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["monitor", "native"] as const)(
    "opens the %s preview feed accessibly and closes back to its trigger",
    (aspect) => {
      document.body.style.overflow = "auto";
      render(
        <CameraFeed
          src="/ui/assets/camera-demo.png"
          aspect={aspect}
          expandable
        />,
      );
      const { trigger, dialog } = openCamera();
      expect(dialog).toBeVisible();
      expect(
        within(dialog).getByRole("img", { name: "Recorded camera image" }),
      ).toBeVisible();
      expect(document.body.style.overflow).toBe("hidden");
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Close full-screen camera",
        }),
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe("auto");
      expect(trigger).toHaveFocus();
    },
  );

  it("handles the native Escape cancel event and restores focus and scrolling", () => {
    document.body.style.overflow = "scroll";
    render(<CameraFeed src="/frames/door.jpg" expandable />);
    const { trigger, dialog } = openCamera();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("scroll");
    expect(trigger).toHaveFocus();
  });

  it("updates the open viewer with the current frame and stream status without reopening it", () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const view = render(
      <CameraFeed
        src="blob:frame-1"
        live
        caption="Live · Front door camera"
        aspect="native"
        expandable
      />,
    );
    const { dialog } = openCamera();
    expect(
      within(dialog).getByRole("img", {
        name: "Current front entrance camera",
      }),
    ).toHaveAttribute("src", "blob:frame-1");
    view.rerender(
      <CameraFeed
        src="blob:frame-2"
        live={false}
        caption="Recent camera snapshot · Not a live stream"
        aspect="native"
        expandable
      />,
    );
    expect(screen.getByRole("dialog", { name: "Front entrance camera" })).toBe(
      dialog,
    );
    expect(
      within(dialog).getByRole("img", { name: "Recorded camera image" }),
    ).toHaveAttribute("src", "blob:frame-2");
    expect(
      within(dialog).getByText("Recent camera snapshot · Not a live stream"),
    ).toBeVisible();
    expect(screen.queryByText("● Live")).not.toBeInTheDocument();
    expect(showModal).toHaveBeenCalledTimes(1);
  });

  it("removes an expired frame from both views while keeping the viewer open", () => {
    const view = render(<CameraFeed src="blob:frame-1" live expandable />);
    const { trigger, dialog } = openCamera();
    view.rerender(<CameraFeed src={undefined} live={false} expandable />);
    expect(screen.getByRole("dialog", { name: "Front entrance camera" })).toBe(
      dialog,
    );
    expect(
      screen.getAllByText("Camera unavailable", { selector: "strong" }),
    ).toHaveLength(2);
    expect(
      within(dialog).getByText("Camera unavailable", { selector: "header p" }),
    ).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText("● Live")).not.toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close full-screen camera" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("replaces a broken frame with unavailable in both views and recovers on a new frame", () => {
    const view = render(<CameraFeed src="blob:broken" live expandable />);
    const { dialog } = openCamera();
    fireEvent.error(
      within(dialog).getByRole("img", {
        name: "Current front entrance camera",
      }),
    );
    expect(
      screen.getAllByText("Camera unavailable", { selector: "strong" }),
    ).toHaveLength(2);
    expect(
      within(dialog).getByText("Camera unavailable", { selector: "header p" }),
    ).toBeVisible();
    expect(screen.queryByText("● Live")).not.toBeInTheDocument();
    view.rerender(<CameraFeed src="blob:recovered" live expandable />);
    expect(screen.queryByText("Camera unavailable")).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("img", {
        name: "Current front entrance camera",
      }),
    ).toHaveAttribute("src", "blob:recovered");
  });

  it("restores the prior scroll state if the page unmounts with the viewer open", () => {
    document.body.style.overflow = "auto";
    const view = render(<CameraFeed src="/frames/door.jpg" expandable />);
    openCamera();
    expect(document.body.style.overflow).toBe("hidden");
    view.unmount();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("auto");
  });
});
