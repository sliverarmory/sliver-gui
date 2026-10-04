import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toast, toast } from "@heroui/react";
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
  toast.clear();
  vi.restoreAllMocks();
});

describe("OperationsPage listener modal", () => {
  it("keeps stop actions pinned and accessible in a compact fixed column", () => {
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { managedServer: null, status: "connected" };
    snapshot.jobs = [
      { id: 4, name: "mtls", description: "mTLS listener", protocol: "mtls", port: 8888, domains: [], profileName: "" },
      { id: 9, name: "https", description: "HTTPS listener", protocol: "https", port: 443, domains: ["c2.example.test"], profileName: "" },
    ];

    render(<OperationsPage snapshot={snapshot} />);

    const grid = screen.getByRole("grid", { name: "Active Sliver jobs" });
    const actionHeader = within(grid).getByRole("columnheader", { name: "Actions" });
    const stopJob4 = within(grid).getByRole("button", { name: "Stop job 4" });
    const stopJob9 = within(grid).getByRole("button", { name: "Stop job 9" });

    expect(grid.closest('[data-slot="data-grid"]')).toHaveClass("[--background:var(--surface)]");
    expect(actionHeader).toHaveAttribute("data-pinned", "end");
    expect(stopJob4.closest('[role="gridcell"]')).toHaveAttribute("data-pinned", "end");
    expect(stopJob9.closest('[role="gridcell"]')).toHaveAttribute("data-pinned", "end");
  });

  it("lays out form sections vertically so the body gap separates each row", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { managedServer: null, status: "connected" };

    render(<OperationsPage snapshot={snapshot} />);
    await user.click(screen.getByRole("button", { name: "New listener" }));

    const dialog = await screen.findByRole("dialog", { name: "Start a listener" });
    const body = dialog.querySelector("[data-slot='modal-body']");
    const header = dialog.querySelector("[data-slot='modal-header']");

    expect(body).not.toBeNull();
    expect(body).toHaveClass("flex", "flex-col", "gap-5");
    expect(header).toHaveClass("flex-row", "items-start");
    expect(header?.children[0]).toHaveAttribute("data-slot", "modal-icon");
    expect(header?.children[1]?.querySelector("[data-slot='modal-heading']")).toHaveTextContent(
      "Start a listener",
    );
    const subtitle = within(dialog).getByText("Authenticated Sliver transport over mutual TLS.");
    expect(header).toContainElement(subtitle);
    expect(within(dialog).getAllByText("Authenticated Sliver transport over mutual TLS.")).toHaveLength(1);
    expect(within(dialog).queryByText("Mutual authentication")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText(
        "Sliver provisions the listener certificate material and requires authenticated implant clients.",
      ),
    ).not.toBeInTheDocument();
  });

  it("accepts complete listener port values through 65535", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { managedServer: null, status: "connected" };
    const startListener = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        job: {
          id: 7,
          name: "mtls",
          description: "mTLS listener",
          protocol: "mtls",
          port: 65_535,
          domains: [],
          profileName: "",
        },
        firewall: { status: "not-requested", ruleCount: 0 },
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
    expect(screen.queryByRole("switch", { name: "Add cloud firewall rule" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start listener" }));

    expect(startListener).toHaveBeenCalledOnce();
    expect(startListener).toHaveBeenCalledWith({
      listener: { kind: "mtls", host: "0.0.0.0", port: 65_535 },
      addManagedFirewallRule: false,
    });
  });

  it("preserves and rejects a listener port above 65535 instead of silently clamping it", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { managedServer: null, status: "connected" };
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

  it("offers a default-on cloud firewall rule for a managed listener", async () => {
    const user = userEvent.setup();
    const showSuccess = vi.spyOn(toast, "success");
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      managedServer: { deploymentId: "deployment-1", provider: "aws", name: "team-c2" },
      status: "connected",
    };
    const startListener = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        job: {
          id: 17,
          name: "mtls",
          description: "mTLS listener",
          protocol: "mtls",
          port: 8888,
          domains: [],
          profileName: "",
        },
        firewall: { status: "applied", ruleCount: 1 },
      },
    });
    Object.defineProperty(window, "sliver", {
      configurable: true,
      value: { startListener } as Partial<SliverDesktopAPI> as SliverDesktopAPI,
    });

    const view = render(
      <>
        <OperationsPage snapshot={snapshot} />
        <Toast.Provider maxVisibleToasts={4} placement="bottom" />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "New listener" }));

    const firewallSwitch = await screen.findByRole("switch", { name: "Add cloud firewall rule" });
    expect(firewallSwitch).toBeChecked();
    expect(
      screen.getByText("Allow internet traffic to TCP port 8888 (0.0.0.0/0) on team-c2."),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Start listener" }));

    expect(startListener).toHaveBeenNthCalledWith(1, {
      listener: { kind: "mtls", host: "0.0.0.0", port: 8888 },
      addManagedFirewallRule: true,
    });
    expect(showSuccess).toHaveBeenCalledWith(
      "mTLS listener started as job #17. Cloud firewall rule added.",
      { timeout: 20_000 },
    );
    const successToast = screen.getByText(
      "mTLS listener started as job #17. Cloud firewall rule added.",
    );
    expect(successToast).toBeVisible();
    expect(view.container.querySelector("section")).not.toContainElement(successToast);

    await user.click(screen.getByRole("button", { name: "New listener" }));
    const reopenedFirewallSwitch = await screen.findByRole("switch", {
      name: "Add cloud firewall rule",
    });
    expect(reopenedFirewallSwitch).toBeChecked();
    await user.click(reopenedFirewallSwitch);
    expect(reopenedFirewallSwitch).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Start listener" }));
    expect(startListener).toHaveBeenNthCalledWith(2, {
      listener: { kind: "mtls", host: "0.0.0.0", port: 8888 },
      addManagedFirewallRule: false,
    });
  });

  it("offers removal of the exact app-managed firewall rule for a single stop plan", async () => {
    const user = userEvent.setup();
    const showSuccess = vi.spyOn(toast, "success");
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      managedServer: { deploymentId: "deployment-1", provider: "aws", name: "team-c2" },
      status: "connected",
      server: "127.0.0.1:31337",
      epoch: 7,
    };
    const job = {
      id: 4,
      name: "mtls",
      description: "mTLS listener",
      protocol: "mtls",
      port: 8888,
      domains: [],
      profileName: "",
    };
    snapshot.jobs = [job];
    const plan: JobStopPlan = {
      token: "managed-plan-token",
      expiresAt: "2099-08-09T12:00:00.000Z",
      impact: {
        backend: {
          server: "127.0.0.1:31337",
          operator: "alice",
          configName: "Production",
          epoch: 7,
          sharedWindowCount: 1,
        },
        jobs: [job],
        managedFirewall: {
          server: snapshot.connection.managedServer!,
          protocol: "tcp",
          port: 8888,
        },
        stopsAll: false,
        warning: "This server-owned listener may be shared with other operators.",
      },
    };
    const prepareStopJob = vi.fn().mockResolvedValue({ ok: true, value: plan });
    const executeStopPlan = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          stoppedJobIds: [4],
          failedJobIds: [],
          firewall: {
            status: "failed",
            ruleCount: 0,
            error: "AWS rejected the change.",
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          stoppedJobIds: [4],
          failedJobIds: [],
          firewall: { status: "not-requested", ruleCount: 0 },
        },
      });
    Object.defineProperty(window, "sliver", {
      configurable: true,
      value: { prepareStopJob, executeStopPlan } as Partial<SliverDesktopAPI> as SliverDesktopAPI,
    });

    const view = render(<OperationsPage snapshot={snapshot} />);
    await user.click(screen.getByRole("button", { name: "Stop job 4" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Stop this reviewed server job?" });
    const firewallSwitch = within(dialog).getByRole("switch", { name: "Remove cloud firewall rule" });
    expect(firewallSwitch).toBeChecked();
    expect(dialog).toHaveTextContent(
      "Remove the app-managed TCP port 8888 firewall rule from team-c2.",
    );

    await user.click(within(dialog).getByRole("button", { name: "Stop job #4" }));

    expect(executeStopPlan).toHaveBeenCalledWith({
      token: "managed-plan-token",
      removeManagedFirewallRule: true,
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    const firewallFailure = screen.getByText(
      "Job #4 stopped. However, the cloud firewall rule could not be removed. AWS rejected the change.",
    );
    expect(firewallFailure).toBeVisible();
    expect(firewallFailure.closest('[role="alert"]')).not.toBeNull();
    expect(view.container.querySelector("section")).toContainElement(firewallFailure);

    await user.click(screen.getByRole("button", { name: "Stop job 4" }));
    const reopenedDialog = await screen.findByRole("alertdialog", {
      name: "Stop this reviewed server job?",
    });
    const reopenedRemovalSwitch = within(reopenedDialog).getByRole("switch", {
      name: "Remove cloud firewall rule",
    });
    expect(reopenedRemovalSwitch).toBeChecked();
    await user.click(reopenedRemovalSwitch);
    expect(reopenedRemovalSwitch).not.toBeChecked();
    await user.click(within(reopenedDialog).getByRole("button", { name: "Stop job #4" }));
    expect(executeStopPlan).toHaveBeenNthCalledWith(2, {
      token: "managed-plan-token",
      removeManagedFirewallRule: false,
    });
    expect(showSuccess).toHaveBeenCalledWith("Job #4 stopped.", { timeout: 20_000 });
  });

  it("reviews the exact backend and jobs before executing a stop-all plan", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { managedServer: null, status: "connected", server: "127.0.0.1:31337", epoch: 7 };
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
        managedFirewall: null,
        stopsAll: true,
        warning: "These server-owned listeners may be shared with other operators.",
      },
    };
    const prepareStopAllJobs = vi.fn().mockResolvedValue({ ok: true, value: plan });
    const executeStopPlan = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        stoppedJobIds: [4, 9],
        failedJobIds: [],
        firewall: { status: "not-requested", ruleCount: 0 },
      },
    });
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
    expect(executeStopPlan).toHaveBeenCalledWith({
      token: "plan-token",
      removeManagedFirewallRule: false,
    });
  });
});
