import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { JobStopPlan, SliverDesktopAPI } from "../../../shared/contracts";
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

  it("accepts complete listener port values through 65535", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { status: "connected" };
    const startListener = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        id: 7,
        name: "mtls",
        description: "mTLS listener",
        protocol: "mtls",
        port: 65_535,
        domains: [],
        profileName: "",
      },
    });
    Object.defineProperty(window, "sliver", {
      configurable: true,
      value: { startListener } as Partial<SliverDesktopAPI> as SliverDesktopAPI,
    });

    render(<OperationsPage snapshot={snapshot} />);
    await user.click(screen.getByRole("button", { name: "New listener" }));

    const portField = await screen.findByRole("textbox", { name: "Listener port" });
    expect(
      portField.closest("[data-slot='number-field']")?.querySelector("[data-slot='number-field-group']"),
    ).toHaveClass("grid-cols-1");
    const hostField = screen.getByRole("textbox", { name: "Bind host" });
    for (const port of ["1", "65", "443"]) {
      await user.clear(portField);
      await user.type(portField, port);
      await user.click(hostField);
      expect(portField).toHaveValue(port);
    }

    await user.clear(portField);
    await user.type(portField, "65535");
    await user.click(screen.getByRole("button", { name: "Start listener" }));

    expect(startListener).toHaveBeenCalledOnce();
    expect(startListener).toHaveBeenCalledWith({ kind: "mtls", host: "0.0.0.0", port: 65_535 });
  });

  it("preserves and rejects a listener port above 65535 instead of silently clamping it", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { status: "connected" };
    const startListener = vi.fn();
    Object.defineProperty(window, "sliver", {
      configurable: true,
      value: { startListener } as Partial<SliverDesktopAPI> as SliverDesktopAPI,
    });

    render(<OperationsPage snapshot={snapshot} />);
    await user.click(screen.getByRole("button", { name: "New listener" }));

    const portField = await screen.findByRole("textbox", { name: "Listener port" });
    await user.clear(portField);
    await user.type(portField, "65536");
    await user.click(screen.getByRole("button", { name: "Start listener" }));

    expect(portField).toHaveValue("65536");
    expect(portField).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Use a whole number from 1 to 65535.")).toBeVisible();
    expect(startListener).not.toHaveBeenCalled();
  });

  it("reviews the exact backend and jobs before executing a stop-all plan", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { status: "connected", server: "127.0.0.1:31337", epoch: 7 };
    snapshot.jobs = [
      { id: 4, name: "mtls", description: "mTLS listener", protocol: "mtls", port: 8888, domains: [], profileName: "" },
      { id: 9, name: "https", description: "HTTPS listener", protocol: "https", port: 443, domains: ["c2.example.test"], profileName: "" },
    ];
    const plan: JobStopPlan = {
      token: "plan-token",
      expiresAt: "2099-08-09T12:00:00.000Z",
      impact: {
        backend: {
          server: "127.0.0.1:31337",
          operator: "alice",
          configName: "Production",
          epoch: 7,
          sharedWindowCount: 2,
        },
        jobs: snapshot.jobs,
        stopsAll: true,
        warning: "These server-owned listeners may be shared with other operators.",
      },
    };
    const prepareStopAllJobs = vi.fn().mockResolvedValue({ ok: true, value: plan });
    const executeStopPlan = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, "sliver", {
      configurable: true,
      value: { prepareStopAllJobs, executeStopPlan } as Partial<SliverDesktopAPI> as SliverDesktopAPI,
    });

    render(<OperationsPage snapshot={snapshot} />);
    await user.click(screen.getByRole("button", { name: "Stop all" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Stop all reviewed server jobs?" });
    expect(dialog).toHaveTextContent("127.0.0.1:31337");
    expect(dialog).toHaveTextContent("alice · Production · connection epoch 7");
    expect(dialog).toHaveTextContent("Shared by 2 application windows");
    expect(dialog).toHaveTextContent("Job #4 · mTLS");
    expect(dialog).toHaveTextContent("Job #9 · HTTPS");
    expect(dialog).toHaveTextContent("all interfaces · port 8888");
    expect(dialog).toHaveTextContent("c2.example.test · port 443");
    expect(prepareStopAllJobs).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Stop 2 jobs" }));
    expect(executeStopPlan).toHaveBeenCalledWith("plan-token");
  });
});
