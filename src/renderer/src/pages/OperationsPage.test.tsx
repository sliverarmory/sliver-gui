import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import { OperationsPage } from "./OperationsPage";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
});

describe("OperationsPage listener modal", () => {
  it("lays out form sections vertically so the body gap separates each row", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { status: "connected" };

    render(<OperationsPage snapshot={snapshot} />);
    await user.click(screen.getByRole("button", { name: "New listener" }));

    const dialog = await screen.findByRole("dialog", { name: "Start a listener" });
    const body = dialog.querySelector("[data-slot='modal-body']");

    expect(body).not.toBeNull();
    expect(body).toHaveClass("flex", "flex-col", "gap-5");
  });
});
