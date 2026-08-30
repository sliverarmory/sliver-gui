import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SliverDesktopAPI } from "../../../shared/contracts";
import type {
  ExecutionActionPlan,
  ExecutionCapability,
  ExecutionCatalog,
  ExecutionOperationId,
} from "../../../shared/execution-contracts";
import { EXECUTION_OPERATION_IDS } from "../../../shared/execution-contracts";
import type {
  BeaconSummary,
  SessionSummary,
  TargetRef,
  TargetSummary,
} from "../../../shared/target-contracts";
import { TargetExecutionWorkbench } from "./TargetExecutionWorkbench";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Element.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(Element.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  Reflect.deleteProperty(Element.prototype, "setPointerCapture");
  Reflect.deleteProperty(Element.prototype, "releasePointerCapture");
});

afterEach(() => {
  cleanup();
});

const target: SessionSummary = {
  mode: "session",
  id: "session-execution-1",
  name: "build-host",
  hostname: "linux-build-01",
  hostId: "host-1",
  username: "operator",
  os: "linux",
  arch: "amd64",
  transport: "mtls",
  remoteAddress: "10.0.0.8:4444",
  activeC2: "mtls://10.0.0.8:4444",
  executable: "/tmp/implant",
  version: "1.7.6",
  locale: "en-US",
  integrity: "user",
  burned: false,
  pid: 4221,
  liveness: "active",
};

const targetRef: TargetRef = {
  mode: "session",
  id: target.id,
  backendEpoch: 7,
  domainRevision: 3,
  fingerprint: "a".repeat(64),
};

const beaconTarget: BeaconSummary = {
  mode: "beacon",
  id: "beacon-execution-1",
  name: "build-host-beacon",
  hostname: "linux-build-01",
  hostId: "host-1",
  username: "operator",
  os: "linux",
  arch: "amd64",
  transport: "mtls",
  remoteAddress: "10.0.0.8:4444",
  activeC2: "mtls://10.0.0.8:4444",
  executable: "/tmp/implant",
  version: "1.7.6",
  locale: "en-US",
  integrity: "user",
  burned: false,
  pid: 4221,
  checkinStatus: "on-time",
  intervalMs: 60_000,
  jitterMs: 0,
};

const beaconRef: TargetRef = {
  mode: "beacon",
  id: beaconTarget.id,
  backendEpoch: 7,
  domainRevision: 5,
  fingerprint: "b".repeat(64),
};

const backend = {
  configId: "config-1",
  configName: "Production",
  server: "127.0.0.1:53137",
  operator: "m4-test",
  epoch: 7,
};

function capability(
  operationId: ExecutionOperationId,
  overrides: Partial<ExecutionCapability> = {},
): ExecutionCapability {
  return {
    operationId,
    available: true,
    modes: ["session"],
    platforms: ["linux"],
    risk: operationId === "execution.children" || operationId === "privilege.get" ? "read-only" : "mutating",
    confirmationRequired: operationId !== "execution.children" && operationId !== "privilege.get",
    credentialBearing: false,
    artifacts: [],
    ...overrides,
  };
}

function catalog(
  capabilities: ExecutionCapability[],
  catalogTarget: TargetSummary = target,
  ref: TargetRef = targetRef,
): ExecutionCatalog {
  return { target: catalogTarget, targetRef: ref, backend, capabilities };
}

function plan(
  operationId: ExecutionOperationId,
  overrides: Partial<ExecutionActionPlan> = {},
): ExecutionActionPlan {
  return {
    token: `plan-${operationId}`,
    operationId,
    expiresAt: "2026-08-15T23:00:00.000Z",
    risk: "mutating",
    target: { backend, target, fingerprint: targetRef.fingerprint },
    warning: "This operation changes the selected target.",
    fields: [],
    artifacts: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function installAPI(executionCatalog: ExecutionCatalog) {
  let beaconTasksInvalidatedListener: ((target: TargetRef) => void) | undefined;
  const api = {
    listExecutionCatalog: vi.fn().mockResolvedValue({ ok: true, value: executionCatalog }),
    runExecutionRead: vi.fn().mockResolvedValue({ ok: false, error: "No read configured" }),
    prepareExecutionAction: vi.fn().mockResolvedValue({ ok: false, error: "No plan configured" }),
    executeExecutionPlan: vi.fn().mockResolvedValue({ ok: false, error: "No execution configured" }),
    discardExecutionPlan: vi.fn().mockResolvedValue({ ok: true }),
    getExecutionResult: vi.fn().mockResolvedValue({ ok: false, error: "No result configured" }),
    saveExecutionResult: vi.fn().mockResolvedValue({ ok: false, error: "No save configured" }),
    onBeaconTasksInvalidated: vi.fn((listener: (target: TargetRef) => void) => {
      beaconTasksInvalidatedListener = listener;
      return () => {
        if (beaconTasksInvalidatedListener === listener) beaconTasksInvalidatedListener = undefined;
      };
    }),
    emitBeaconTasksInvalidated: (invalidatedTarget: TargetRef) => {
      beaconTasksInvalidatedListener?.(invalidatedTarget);
    },
  };
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: api as unknown as SliverDesktopAPI,
  });
  return api;
}

describe("TargetExecutionWorkbench", () => {
  it("uses the main catalog as authority, preserves unavailable reasons, and omits structural mismatches", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([
      capability("execution.process"),
      capability("execution.children", {
        available: false,
        reason: { code: "dependency-unavailable", message: "Background tracking is disabled by this server." },
      }),
      capability("execution.psexec", { platforms: ["windows"] }),
      capability("execution.ssh"),
      capability("privilege.get", { platforms: ["windows"] }),
      capability("privilege.revert", { modes: ["beacon"] }),
    ]));

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-a" />);

    expect(await screen.findByRole("heading", { name: "Execution workbench" })).toBeInTheDocument();
    expect(api.listExecutionCatalog).toHaveBeenCalledOnce();
    expect(screen.getByRole("radio", { name: "Process" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Payloads" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Remote" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Identity" })).toBeInTheDocument();
    expect(screen.getByText("Execute process")).toBeInTheDocument();
    expect(screen.getByText("Background tracking is disabled by this server.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unavailable: Background children" })).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: "Remote" }));
    expect(screen.getByText("SSH command")).toBeInTheDocument();
    expect(screen.queryByText("Remote service")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Identity" }));
    expect(screen.getByText("No identity actions support this target")).toBeInTheDocument();
    expect(screen.queryByText("Inspect privileges")).not.toBeInTheDocument();
  });

  it("opens a typed configuration surface for every catalog action capability", async () => {
    const user = userEvent.setup();
    const windowsTarget: SessionSummary = { ...target, os: "windows", arch: "amd64" };
    const windowsRef: TargetRef = { ...targetRef, fingerprint: "f".repeat(64) };
    const apiCapabilities = EXECUTION_OPERATION_IDS.map((operationId) => capability(operationId, { platforms: ["windows"] }));
    installAPI(catalog(apiCapabilities, windowsTarget, windowsRef));
    const actionGroups = [
      { category: "Process", labels: ["Execute process", "Migrate process"] },
      {
        category: "Payloads",
        labels: [
          "Execute assembly",
          "Execute shellcode",
          "Sideload library",
          "Spawn reflective DLL",
          "Run Metasploit payload",
          "Inject Metasploit payload",
          "Backdoor executable",
          "DLL hijack",
        ],
      },
      { category: "Remote", labels: ["Remote service", "SSH command"] },
      {
        category: "Identity",
        labels: ["Run as user", "Make token", "Impersonate user", "Revert identity", "Get SYSTEM"],
      },
    ] as const;

    render(<TargetExecutionWorkbench expectedTarget={windowsRef} targetIdentity="target-windows-all" />);
    await screen.findByRole("heading", { name: "Execution workbench" });
    for (const group of actionGroups) {
      await user.click(screen.getByRole("radio", { name: group.category }));
      for (const label of group.labels) {
        await user.click(screen.getByRole("button", { name: `Open: ${label}` }));
        const dialog = await screen.findByRole("dialog", { name: label });
        expect(within(dialog).getByRole("button", { name: "Review" })).toHaveAttribute("type", "submit");
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("dialog", { name: label })).not.toBeInTheDocument());
      }
    }
  });

  it("omits the Windows-only process parent PID modifier on Linux", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("execution.process")]));
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: plan("execution.process") });

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-linux-process" />);
    await screen.findByRole("heading", { name: "Execution workbench" });
    await user.click(screen.getByRole("button", { name: "Open: Execute process" }));
    await user.click(screen.getByText("Advanced"));

    expect(screen.queryByRole("spinbutton", { name: "Parent process ID" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Executable path" }), "/usr/bin/id");
    await user.click(screen.getByRole("button", { name: "Review" }));

    await waitFor(() => expect(api.prepareExecutionAction).toHaveBeenCalledOnce());
    expect(api.prepareExecutionAction.mock.calls[0]?.[0].draft).not.toHaveProperty("parentPid");
  });

  it("advances an exact submitted beacon execution from its task invalidation and saves output natively", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([
      capability("execution.process", { modes: ["beacon"] }),
    ], beaconTarget, beaconRef));
    const reviewedPlan = plan("execution.process", {
      target: { backend, target: beaconTarget, fingerprint: beaconRef.fingerprint },
      fields: [
        { label: "Executable", value: "/usr/bin/id", sensitive: false },
        { label: "Capture output", value: "yes", sensitive: false },
      ],
    });
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: reviewedPlan });
    api.executeExecutionPlan.mockResolvedValue({
      ok: true,
      value: {
        requestId: "request-process-1",
        operationId: "execution.process",
        state: "submitted",
        message: "Process submitted.",
        taskId: "task-1",
        output: [{
          handle: "output-1",
          suggestedFileName: "id.txt",
          mediaType: "text/plain",
          size: 42,
          expiresAt: "2026-08-15T23:05:00.000Z",
          stream: "combined",
          truncated: false,
        }],
      },
    });
    api.getExecutionResult.mockResolvedValue({
      ok: true,
      value: {
        requestId: "request-process-1",
        operationId: "execution.process",
        state: "completed",
        message: "Process completed.",
        pid: 812,
        output: [{
          handle: "output-1",
          suggestedFileName: "id.txt",
          mediaType: "text/plain",
          size: 42,
          expiresAt: "2026-08-15T23:05:00.000Z",
          stream: "combined",
          truncated: false,
        }],
      },
    });
    api.saveExecutionResult.mockResolvedValue({ ok: true, value: { saved: true, fileName: "id.txt" } });

    render(<TargetExecutionWorkbench expectedTarget={beaconRef} targetIdentity="target-beacon-a" />);
    await screen.findByRole("heading", { name: "Execution workbench" });
    await user.click(screen.getByRole("button", { name: "Open: Execute process" }));
    await user.type(screen.getByRole("textbox", { name: "Executable path" }), "/usr/bin/id");
    await user.click(screen.getByRole("button", { name: "Review" }));

    await waitFor(() => expect(api.prepareExecutionAction).toHaveBeenCalledOnce());
    expect(api.prepareExecutionAction).toHaveBeenCalledWith({
      draft: expect.objectContaining({
        operationId: "execution.process",
        path: "/usr/bin/id",
        args: [],
        captureOutput: true,
        background: false,
        inheritEnvironment: false,
        environment: [],
        timeoutSeconds: 60,
      }),
    });
    const dialog = await screen.findByRole("alertdialog", { name: "Execute this reviewed action?" });
    expect(dialog).toHaveTextContent(beaconRef.fingerprint);
    expect(dialog).toHaveTextContent("/usr/bin/id");

    await user.click(screen.getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(api.executeExecutionPlan).toHaveBeenCalledExactlyOnceWith({ token: reviewedPlan.token }));
    expect(await screen.findByText("Process submitted.")).toBeInTheDocument();
    expect(api.discardExecutionPlan).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();

    act(() => api.emitBeaconTasksInvalidated({
      ...beaconRef,
      fingerprint: "c".repeat(64),
    }));
    expect(api.getExecutionResult).not.toHaveBeenCalled();

    act(() => api.emitBeaconTasksInvalidated({
      ...beaconRef,
      domainRevision: beaconRef.domainRevision + 1,
    }));
    await waitFor(() => expect(api.getExecutionResult).toHaveBeenCalledExactlyOnceWith({ requestId: "request-process-1" }));
    expect(await screen.findByText("Process completed.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save combined" }));
    await waitFor(() => expect(api.saveExecutionResult).toHaveBeenCalledExactlyOnceWith({ requestId: "request-process-1", stream: "combined" }));
  });

  it("discards a canceled review before returning focus to the originating action", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("privilege.revert", { platforms: ["linux"] })]));
    const reviewedPlan = plan("privilege.revert");
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: reviewedPlan });

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-a" />);
    await screen.findByRole("heading", { name: "Execution workbench" });
    await user.click(screen.getByRole("radio", { name: "Identity" }));
    const origin = screen.getByRole("button", { name: "Open: Revert identity" });
    await user.click(origin);
    await user.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByRole("alertdialog", { name: "Execute this reviewed action?" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(api.discardExecutionPlan).toHaveBeenCalledExactlyOnceWith({ token: reviewedPlan.token }));
    await waitFor(() => expect(origin).toHaveFocus());
  });

  it("retires a consumed review after main rejects execution and restores action focus", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("privilege.revert", { platforms: ["linux"] })]));
    const reviewedPlan = plan("privilege.revert");
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: reviewedPlan });
    api.executeExecutionPlan.mockResolvedValue({ ok: false, error: "The selected target changed before execution dispatch" });

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-a" />);
    await screen.findByRole("heading", { name: "Execution workbench" });
    await user.click(screen.getByRole("radio", { name: "Identity" }));
    const origin = screen.getByRole("button", { name: "Open: Revert identity" });
    await user.click(origin);
    await user.click(screen.getByRole("button", { name: "Review" }));
    const review = await screen.findByRole("alertdialog", { name: "Execute this reviewed action?" });
    await user.click(within(review).getByRole("button", { name: "Execute" }));

    await waitFor(() => expect(api.executeExecutionPlan).toHaveBeenCalledExactlyOnceWith({ token: reviewedPlan.token }));
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Execute this reviewed action?" })).not.toBeInTheDocument());
    await waitFor(() => expect(origin).toHaveFocus());
    expect(api.discardExecutionPlan).not.toHaveBeenCalled();
  });

  it("keeps a review available when execution invocation throws before delivery is known", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("privilege.revert", { platforms: ["linux"] })]));
    const reviewedPlan = plan("privilege.revert");
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: reviewedPlan });
    api.executeExecutionPlan.mockRejectedValue(new Error("IPC delivery failed"));

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-a" />);
    await screen.findByRole("heading", { name: "Execution workbench" });
    await user.click(screen.getByRole("radio", { name: "Identity" }));
    await user.click(screen.getByRole("button", { name: "Open: Revert identity" }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    const review = await screen.findByRole("alertdialog", { name: "Execute this reviewed action?" });
    await user.click(within(review).getByRole("button", { name: "Execute" }));

    await waitFor(() => expect(api.executeExecutionPlan).toHaveBeenCalledExactlyOnceWith({ token: reviewedPlan.token }));
    expect(screen.getByRole("alertdialog", { name: "Execute this reviewed action?" })).toBeInTheDocument();
    expect(within(review).getByRole("button", { name: "Execute" })).toBeEnabled();
  });

  it("advances an exact queued beacon read from its task invalidation", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([
      capability("execution.children", { modes: ["beacon"] }),
    ], beaconTarget, beaconRef));
    api.runExecutionRead
      .mockResolvedValueOnce({
        ok: true,
        value: {
          operationId: "execution.children",
          state: "submitted",
          taskId: "beacon-task-8",
          items: [],
          total: 0,
          truncated: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          operationId: "execution.children",
          state: "completed",
          items: [{
            pid: 991,
            path: "/usr/bin/sleep",
            args: ["30"],
            exited: false,
            stdoutBytes: 0,
            stderrBytes: 0,
          }],
          total: 1,
          truncated: false,
        },
      });

    render(<TargetExecutionWorkbench expectedTarget={beaconRef} targetIdentity="target-beacon-a" />);
    await screen.findByRole("heading", { name: "Execution workbench" });
    await user.click(screen.getByRole("button", { name: "Open: Background children" }));
    expect(await screen.findByText("Background children queued")).toBeInTheDocument();
    expect(screen.getByText("Task beacon-task-8")).toBeInTheDocument();
    expect(screen.queryByRole("grid", { name: "Background child processes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();

    act(() => api.emitBeaconTasksInvalidated({
      ...beaconRef,
      fingerprint: "c".repeat(64),
    }));
    expect(api.runExecutionRead).toHaveBeenCalledOnce();

    act(() => api.emitBeaconTasksInvalidated({
      ...beaconRef,
      domainRevision: beaconRef.domainRevision + 1,
    }));
    expect(await screen.findByText("/usr/bin/sleep")).toBeInTheDocument();
    expect(api.runExecutionRead).toHaveBeenNthCalledWith(2, {
      operationId: "execution.children",
      taskId: "beacon-task-8",
      limit: 100,
    });
  });

  it("keeps credentials uncontrolled, clears them immediately, and discards a stale prepared plan", async () => {
    const user = userEvent.setup();
    const windowsTarget: SessionSummary = { ...target, os: "windows", arch: "amd64", hostname: "win-01" };
    const windowsRef: TargetRef = { ...targetRef, fingerprint: "c".repeat(64) };
    const replacementRef: TargetRef = { ...windowsRef, domainRevision: 4, fingerprint: "d".repeat(64) };
    const runAs = capability("privilege.run-as", {
      platforms: ["windows"],
      risk: "credential-bearing",
      credentialBearing: true,
    });
    const api = installAPI(catalog([runAs], windowsTarget, windowsRef));
    const pending = deferred<{ ok: true; value: ExecutionActionPlan }>();
    let capturedPassword = "";
    api.prepareExecutionAction.mockImplementation(({ draft }) => {
      if (draft.operationId === "privilege.run-as") capturedPassword = new TextDecoder().decode(new Uint8Array(draft.password));
      return pending.promise;
    });
    api.listExecutionCatalog
      .mockResolvedValueOnce({ ok: true, value: catalog([runAs], windowsTarget, windowsRef) })
      .mockResolvedValueOnce({ ok: true, value: catalog([runAs], windowsTarget, replacementRef) });

    const { rerender } = render(<TargetExecutionWorkbench expectedTarget={windowsRef} targetIdentity="target-windows-a" />);
    await screen.findByRole("heading", { name: "Execution workbench" });
    await user.click(screen.getByRole("radio", { name: "Identity" }));
    await user.click(screen.getByRole("button", { name: "Open: Run as user" }));
    await user.type(screen.getByRole("textbox", { name: "Username" }), "CORP\\alice");
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    await user.type(password, "one-operation-secret");
    await user.type(screen.getByRole("textbox", { name: "Process" }), "cmd.exe");
    await user.click(screen.getByRole("button", { name: "Review" }));

    await waitFor(() => expect(api.prepareExecutionAction).toHaveBeenCalledOnce());
    expect(capturedPassword).toBe("one-operation-secret");
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("cleared from the form");
    const invokedDraft = api.prepareExecutionAction.mock.calls[0]?.[0].draft;
    expect(invokedDraft?.operationId).toBe("privilege.run-as");
    if (invokedDraft?.operationId === "privilege.run-as") expect([...invokedDraft.password]).toEqual(new Array(invokedDraft.password.length).fill(0));

    rerender(<TargetExecutionWorkbench expectedTarget={replacementRef} targetIdentity="target-windows-a" />);
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    const stalePlan = plan("privilege.run-as", {
      token: "stale-credential-plan",
      target: { backend, target: windowsTarget, fingerprint: windowsRef.fingerprint },
    });
    await act(async () => {
      pending.resolve({ ok: true, value: stalePlan });
      await pending.promise;
    });
    await waitFor(() => expect(api.discardExecutionPlan).toHaveBeenCalledWith({ token: stalePlan.token }));
    expect(screen.queryByRole("alertdialog", { name: "Execute this reviewed action?" })).not.toBeInTheDocument();
  });

  it("keeps native paths in main and shows only sanitized file metadata during Review", async () => {
    const user = userEvent.setup();
    const assembly = capability("execution.assembly", {
      artifacts: [{
        role: "assembly",
        label: ".NET assembly",
        required: true,
        maximumBytes: 4_194_304,
        acceptedExtensions: [".exe", ".dll"],
      }],
    });
    const api = installAPI(catalog([assembly]));
    api.prepareExecutionAction.mockResolvedValue({
      ok: true,
      value: plan("execution.assembly", {
        artifacts: [{
          role: "assembly",
          fileName: "Seatbelt.exe",
          mediaType: "application/vnd.microsoft.portable-executable",
          size: 524_288,
          sha256: "e".repeat(64),
        }],
      }),
    });

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-a" />);
    await screen.findByRole("heading", { name: "Execution workbench" });
    await user.click(screen.getByRole("radio", { name: "Payloads" }));
    await user.click(screen.getByRole("button", { name: "Open: Execute assembly" }));
    expect(screen.getByRole("region", { name: "Native file selection" })).toHaveTextContent("Native files are chosen during Review");
    expect(screen.queryByDisplayValue(/Users|Desktop|Seatbelt/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Execute this reviewed action?" });
    expect(dialog).toHaveTextContent("Seatbelt.exe");
    expect(dialog).toHaveTextContent("512.0 KiB");
    expect(dialog).toHaveTextContent(`SHA-256 ${"e".repeat(64)}`);
  });
});
