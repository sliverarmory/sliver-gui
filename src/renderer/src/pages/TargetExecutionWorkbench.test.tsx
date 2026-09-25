import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { OperationResult, SliverDesktopAPI } from "../../../shared/contracts";
import type {
  ExecutionActionPlan,
  ExecutionActionResult,
  ExecutionCapability,
  ExecutionCatalog,
  ExecutionOperationId,
  ProcessExecutionHistorySnapshot,
  ProcessExecutionRecord,
} from "../../../shared/execution-contracts";
import { EXECUTION_OPERATION_IDS } from "../../../shared/execution-contracts";
import type {
  BeaconSummary,
  SessionSummary,
  TargetRef,
  TargetSummary,
} from "../../../shared/target-contracts";
import { TargetExecutionWorkbench } from "./TargetExecutionWorkbench";
import { renderWithApplicationContextMenu as render } from "../application-context-menu-test-utils";

vi.mock("../components/ExecutionOutputTerminal", () => ({
  ExecutionOutputTerminal: ({ bytes }: { bytes: Uint8Array }) => (
    <pre aria-label="Execution output transcript">{new TextDecoder().decode(bytes)}</pre>
  ),
}));

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

function completedProcessResult(
  requestId: string,
  pid: number,
  exitCode: number,
  output: string,
): ExecutionActionResult {
  return {
    requestId,
    operationId: "execution.process",
    state: "completed",
    message: "Process completed.",
    pid,
    exitCode,
    output: [{
      handle: `output-${requestId}`,
      suggestedFileName: `${requestId}.txt`,
      mediaType: "application/octet-stream",
      size: new TextEncoder().encode(output).byteLength,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      stream: "stdout",
      truncated: false,
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function selectAdvancedCategory(user: ReturnType<typeof userEvent.setup>, label: "Payloads" | "Remote" | "Identity"): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Advanced actions" }));
  await user.click(await screen.findByRole("menuitem", { name: label }));
}

function installAPI(executionCatalog: ExecutionCatalog) {
  let beaconTasksInvalidatedListener: ((target: TargetRef) => void) | undefined;
  let processHistoryTarget = executionCatalog.targetRef;
  let processHistoryRevision = 0;
  let processHistory: ProcessExecutionRecord[] = [];
  const processHistoryListeners = new Set<(target: TargetRef, revision: number) => void>();
  const api = {
    listExecutionCatalog: vi.fn().mockResolvedValue({ ok: true, value: executionCatalog }),
    listDotNetAssemblies: vi.fn().mockResolvedValue({ ok: true, value: { target: executionCatalog.targetRef, assemblies: [] } }),
    listDotNetExecutionHistory: vi.fn().mockResolvedValue({ ok: true, value: { target: executionCatalog.targetRef, revision: 0, records: [] } }),
    clearDotNetExecutionHistory: vi.fn().mockResolvedValue({ ok: true }),
    onDotNetExecutionHistoryChanged: vi.fn(() => () => undefined),
    chooseDotNetAssemblyFile: vi.fn().mockResolvedValue({ ok: true, value: { token: "assembly-file-token", fileName: "Seatbelt.exe", size: 524_288, isDll: false } }),
    runExecutionRead: vi.fn().mockResolvedValue({ ok: false, error: "No read configured" }),
    prepareExecutionAction: vi.fn().mockResolvedValue({ ok: false, error: "No plan configured" }),
    executeExecutionPlan: vi.fn().mockResolvedValue({ ok: false, error: "No execution configured" }),
    discardExecutionPlan: vi.fn().mockResolvedValue({ ok: true }),
    getExecutionResult: vi.fn().mockResolvedValue({ ok: false, error: "No result configured" }),
    readExecutionOutput: vi.fn().mockResolvedValue({ ok: false, error: "No output configured" }),
    listProcessExecutionHistory: vi.fn<() => Promise<OperationResult<ProcessExecutionHistorySnapshot>>>(async () => ({
      ok: true as const,
      value: { target: processHistoryTarget, revision: processHistoryRevision, records: ipcProcessRecords(processHistory) },
    })),
    clearProcessExecutionHistory: vi.fn(async ({ id }: { id?: string }) => {
      processHistory = id ? processHistory.filter((record) => record.id !== id) : [];
      processHistoryRevision += 1;
      for (const listener of processHistoryListeners) listener(processHistoryTarget, processHistoryRevision);
      return { ok: true as const };
    }),
    onProcessExecutionHistoryChanged: vi.fn((listener: (target: TargetRef, revision: number) => void) => {
      processHistoryListeners.add(listener);
      return () => { processHistoryListeners.delete(listener); };
    }),
    saveExecutionResult: vi.fn().mockResolvedValue({ ok: false, error: "No save configured" }),
    addExecutionOutputToLoot: vi.fn().mockResolvedValue({ ok: false, error: "No loot configured" }),
    onBeaconTasksInvalidated: vi.fn((listener: (target: TargetRef) => void) => {
      beaconTasksInvalidatedListener = listener;
      return () => {
        if (beaconTasksInvalidatedListener === listener) beaconTasksInvalidatedListener = undefined;
      };
    }),
    emitBeaconTasksInvalidated: (invalidatedTarget: TargetRef) => {
      beaconTasksInvalidatedListener?.(invalidatedTarget);
    },
    publishProcessHistory: (records: ProcessExecutionRecord[], changedTarget = processHistoryTarget) => {
      processHistory = records;
      processHistoryTarget = changedTarget;
      processHistoryRevision += 1;
      for (const listener of processHistoryListeners) listener(processHistoryTarget, processHistoryRevision);
    },
  };
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: api as unknown as SliverDesktopAPI,
  });
  return api;
}

function ipcProcessRecords(records: readonly ProcessExecutionRecord[]): ProcessExecutionRecord[] {
  return records.map((record) => ({
    ...record,
    ...(record.stdout ? { stdout: { ...record.stdout, data: Uint8Array.from(record.stdout.data) } } : {}),
    ...(record.stderr ? { stderr: { ...record.stderr, data: Uint8Array.from(record.stderr.data) } } : {}),
  }));
}

function processRecord(
  id: string,
  path: string,
  result?: ExecutionActionResult,
  stdout?: string,
  stderr?: string,
): ProcessExecutionRecord {
  return {
    id,
    startedAt: "2026-09-25T08:12:53.000Z",
    path,
    args: [],
    state: result?.state ?? "running",
    ...(result ? { result } : {}),
    ...(stdout ? { stdout: { data: new TextEncoder().encode(stdout), truncated: false } } : {}),
    ...(stderr ? { stderr: { data: new TextEncoder().encode(stderr), truncated: false } } : {}),
  };
}

describe("TargetExecutionWorkbench", () => {
  it("opens a separate Execution view once per request and hides its pop-out control in dedicated windows", async () => {
    const user = userEvent.setup();
    const opening = deferred<void>();
    const onPopOut = vi.fn(() => opening.promise);
    installAPI(catalog([capability("execution.process")]));

    const { rerender } = render(
      <TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-a" onPopOut={onPopOut} />,
    );
    const trigger = await screen.findByRole("button", { name: "Pop out execution" });
    await user.click(trigger);
    expect(onPopOut).toHaveBeenCalledOnce();
    expect(trigger).toHaveAttribute("data-pending");
    await user.click(trigger);
    expect(onPopOut).toHaveBeenCalledOnce();

    opening.resolve(undefined);
    await waitFor(() => expect(trigger).not.toHaveAttribute("data-pending"));
    rerender(
      <TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-a" onPopOut={onPopOut} presentation="dedicated" />,
    );
    expect(screen.queryByRole("button", { name: "Pop out execution" })).not.toBeInTheDocument();
  });

  it("shows a failed Execution pop-out without replacing the workbench", async () => {
    const user = userEvent.setup();
    const onPopOut = vi.fn().mockRejectedValue(new Error("The session selection changed"));
    installAPI(catalog([capability("execution.process")]));

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-a" onPopOut={onPopOut} />);
    await user.click(await screen.findByRole("button", { name: "Pop out execution" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The session selection changed");
    expect(screen.getByRole("region", { name: "Execution operations" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Execute a subprocess" })).toBeInTheDocument();
  });

  it("keeps the execution pane visible while a revised reference is validated", async () => {
    const user = userEvent.setup();
    const revisedRef = { ...targetRef, domainRevision: targetRef.domainRevision + 1 };
    const revert = capability("privilege.revert", { platforms: ["linux"] });
    const process = capability("execution.process", { platforms: ["linux"] });
    const api = installAPI(catalog([process, revert]));
    const refreshedCatalog = deferred<{ ok: true; value: ExecutionCatalog }>();
    api.listExecutionCatalog
      .mockResolvedValueOnce({ ok: true, value: catalog([process, revert]) })
      .mockReturnValueOnce(refreshedCatalog.promise);
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: plan("privilege.revert") });

    const { rerender } = render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-a" />);
    const operations = await screen.findByRole("region", { name: "Execution operations" });
    await selectAdvancedCategory(user, "Identity");
    expect(screen.getByRole("button", { name: "Open: Revert identity" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Open: Revert identity" }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByRole("alertdialog", { name: "Execute this reviewed action?" });

    rerender(<TargetExecutionWorkbench expectedTarget={revisedRef} targetIdentity="target-a" />);
    await waitFor(() => expect(api.listExecutionCatalog).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.discardExecutionPlan).toHaveBeenCalledWith({ token: "plan-privilege.revert" }));
    expect(screen.queryByRole("alertdialog", { name: "Execute this reviewed action?" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Execution operations" })).toBe(operations);
    expect(screen.getByRole("button", { name: "Advanced actions" })).toHaveTextContent("Identity");
    expect(screen.queryByRole("region", { name: "Loading execution workbench" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open: Revert identity" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Refreshing execution capabilities");
    await user.click(screen.getByRole("radio", { name: "Process" }));
    expect(screen.getByRole("button", { name: "Execute" })).toBeDisabled();
    await selectAdvancedCategory(user, "Identity");

    await act(async () => {
      refreshedCatalog.resolve({ ok: true, value: catalog([process, revert], target, revisedRef) });
      await refreshedCatalog.promise;
    });
    expect(screen.getByRole("region", { name: "Execution operations" })).toBe(operations);
    expect(screen.getByRole("button", { name: "Advanced actions" })).toHaveTextContent("Identity");
    expect(screen.getByRole("button", { name: "Open: Revert identity" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("retries a transient history failure when the target catalog recovers", async () => {
    const revisedRef = { ...targetRef, domainRevision: targetRef.domainRevision + 1 };
    const process = capability("execution.process");
    const api = installAPI(catalog([process]));
    let historyAvailable = false;
    const retained = processRecord(
      "recovered-run",
      "/usr/bin/id",
      completedProcessResult("recovered-run", 4242, 0, "recovered output"),
      "recovered output",
    );
    api.listProcessExecutionHistory.mockImplementation(async () => historyAvailable
      ? { ok: true, value: { target: revisedRef, revision: 1, records: ipcProcessRecords([retained]) } }
      : { ok: false, error: "Target domain is refreshing" });
    api.listExecutionCatalog
      .mockResolvedValueOnce({ ok: true, value: catalog([process]) })
      .mockResolvedValueOnce({ ok: true, value: catalog([process], target, revisedRef) });

    const { rerender } = render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="same-session" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Target domain is refreshing");
    historyAvailable = true;
    rerender(<TargetExecutionWorkbench expectedTarget={revisedRef} targetIdentity="same-session" />);

    expect(await screen.findByLabelText("Execution output transcript")).toHaveTextContent("recovered output");
    expect(screen.queryByText("Target domain is refreshing")).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Process execution history" })).getByRole("row", { name: /\/usr\/bin\/id/u })).toBeInTheDocument();
    expect(api.listProcessExecutionHistory).toHaveBeenCalledTimes(3);
  });

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

    const executionOperations = await screen.findByRole("region", { name: "Execution operations" });
    expect(executionOperations).toBeInTheDocument();
    expect(within(executionOperations).queryByRole("heading", { name: "Execution workbench" })).not.toBeInTheDocument();
    expect(within(executionOperations).queryByText("Configure one typed operation, review the exact target and native files, then execute a short-lived main-owned plan.")).not.toBeInTheDocument();
    expect(within(executionOperations).queryByText("session", { exact: true })).not.toBeInTheDocument();
    expect(within(executionOperations).queryByText("linux/amd64")).not.toBeInTheDocument();
    expect(api.listExecutionCatalog).toHaveBeenCalledOnce();
    expect(screen.getByRole("radio", { name: "Process" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "BOFs" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: ".NET" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Payloads" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Remote" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Identity" })).not.toBeInTheDocument();
    const processWorkspace = screen.getByRole("region", { name: "Process execution history and output" });
    const history = screen.getByRole("navigation", { name: "Process execution history" });
    expect(within(processWorkspace).getByRole("navigation", { name: "Process execution history" })).toBe(history);
    expect(within(history).getByRole("grid", { name: "Process execution history" })).toBeInTheDocument();
    expect(within(history).getAllByRole("row")).toHaveLength(1);
    expect(within(history).getByRole("row", { name: "New Execution" })).toHaveAttribute("aria-selected", "true");
    const processForm = screen.getByRole("region", { name: "Execute a subprocess" });
    expect(within(processWorkspace).getByRole("region", { name: "Execute a subprocess" })).toBe(processForm);
    expect(history.compareDocumentPosition(processForm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByLabelText("Execution details")).not.toBeInTheDocument();
    expect(within(processForm).getByRole("textbox", { name: "Executable path" })).toHaveValue("/bin/sh");
    expect(within(processForm).getByRole("textbox", { name: "Arguments" }))
      .toHaveAttribute("placeholder", "--flag 'value with spaces'");
    expect(within(processForm).queryByRole("button", { name: "Execution options" })).not.toBeInTheDocument();
    expect(within(processForm).getByRole("switch", { name: /Capture output/u })).toBeChecked();
    const execute = within(processForm).getByRole("button", { name: "Execute" });
    expect(execute).toHaveAttribute("type", "submit");
    expect(execute.compareDocumentPosition(within(processForm).getByRole("textbox", { name: "Executable path" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Execution options" })).not.toBeInTheDocument();
    expect(screen.queryByText("Background tracking is disabled by this server.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unavailable: Background children" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: ".NET" }));
    expect(screen.getByRole("region", { name: ".NET assembly execution" })).toBeInTheDocument();
    expect(screen.getByText(".NET execution is unavailable for this target.")).toBeInTheDocument();
  });

  it("opens a typed configuration surface for every catalog action capability", async () => {
    const user = userEvent.setup();
    const windowsTarget: SessionSummary = { ...target, os: "windows", arch: "amd64" };
    const windowsRef: TargetRef = { ...targetRef, fingerprint: "f".repeat(64) };
    const apiCapabilities = EXECUTION_OPERATION_IDS.map((operationId) => capability(operationId, { platforms: ["windows"] }));
    installAPI(catalog(apiCapabilities, windowsTarget, windowsRef));
    const actionGroups = [
      {
        category: "Payloads",
        labels: [
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
    await screen.findByRole("region", { name: "Execution operations" });
    const processForm = screen.getByRole("region", { name: "Execute a subprocess" });
    expect(within(processForm).getByRole("textbox", { name: "Executable path" })).toHaveValue("C:\\Windows\\System32\\cmd.exe");
    expect(within(processForm).getByRole("textbox", { name: "Arguments" }))
      .toHaveAttribute("placeholder", "/d /c dir");
    expect(within(processForm).getByRole("switch", { name: /Capture output/u })).toBeChecked();
    expect(within(processForm).getByRole("switch", { name: /Use current token/u })).toBeInTheDocument();
    expect(within(processForm).getByRole("switch", { name: /Hide window/u })).toBeInTheDocument();
    expect(within(processForm).getByRole("spinbutton", { name: "Parent process ID" })).toBeInTheDocument();
    expect(within(processForm).getByRole("button", { name: "Execute" })).toHaveAttribute("type", "submit");
    expect(screen.queryByRole("dialog", { name: "Execution options" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open: Migrate process" })).not.toBeInTheDocument();
    for (const group of actionGroups) {
      await selectAdvancedCategory(user, group.category);
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
    const form = await screen.findByRole("region", { name: "Execute a subprocess" });
    expect(within(form).getByRole("switch", { name: /Capture output/u })).toBeChecked();
    expect(within(form).getByRole("spinbutton", { name: "Timeout seconds" })).toBeInTheDocument();
    expect(within(form).queryByRole("spinbutton", { name: "Parent process ID" })).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Execute" }));

    await waitFor(() => expect(api.prepareExecutionAction).toHaveBeenCalledOnce());
    expect(api.prepareExecutionAction.mock.calls[0]?.[0].draft).not.toHaveProperty("parentPid");
    expect(api.prepareExecutionAction.mock.calls[0]?.[0].draft).toMatchObject({ path: "/bin/sh" });
    await waitFor(() => expect(api.executeExecutionPlan).toHaveBeenCalledExactlyOnceWith({ token: "plan-execution.process" }));
    expect(screen.queryByRole("alertdialog", { name: "Execute this reviewed action?" })).not.toBeInTheDocument();
  });

  it("keeps command and execution options inline in the directly run draft", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("execution.process")]));
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: plan("execution.process") });

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-process-options" />);
    const form = await screen.findByRole("region", { name: "Execute a subprocess" });
    const executable = within(form).getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, "/usr/bin/env");
    const argumentsField = within(form).getByRole("textbox", { name: "Arguments" });
    expect(argumentsField.tagName).toBe("INPUT");
    await user.type(argumentsField, 'alpha "two words" three\\ four ""');
    expect(within(form).getByRole("switch", { name: /Run in background/u })).not.toBeChecked();
    expect(within(form).getByRole("switch", { name: /Capture output/u })).toBeChecked();
    await user.click(within(form).getByRole("switch", { name: /Run in background/u }));
    expect(within(form).getByRole("switch", { name: /Capture output/u })).not.toBeChecked();
    await user.type(within(form).getByRole("textbox", { name: "Environment overrides" }), "MODE=trace");
    const timeout = within(form).getByRole("spinbutton", { name: "Timeout seconds" });
    await user.clear(timeout);
    await user.type(timeout, "15");
    expect(within(form).getByRole("switch", { name: /Run in background/u })).toBeChecked();
    expect(within(form).getByRole("textbox", { name: "Environment overrides" })).toHaveValue("MODE=trace");
    expect(within(form).getByRole("spinbutton", { name: "Timeout seconds" })).toHaveValue(15);
    expect(screen.queryByRole("dialog", { name: "Execution options" })).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Execute" }));

    await waitFor(() => expect(api.prepareExecutionAction).toHaveBeenCalledOnce());
    expect(api.prepareExecutionAction.mock.calls[0]?.[0].draft).toMatchObject({
      operationId: "execution.process",
      path: "/usr/bin/env",
      args: ["alpha", "two words", "three four", ""],
      background: true,
      captureOutput: false,
      environment: [{ name: "MODE", value: "trace" }],
      timeoutSeconds: 15,
    });
    await waitFor(() => expect(api.executeExecutionPlan).toHaveBeenCalledExactlyOnceWith({ token: "plan-execution.process" }));
    expect(screen.queryByRole("alertdialog", { name: "Execute this reviewed action?" })).not.toBeInTheDocument();
  });

  it("rejects a prepared Process plan for a different target before direct execution", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("execution.process")]));
    const mismatched = plan("execution.process", {
      target: { backend, target, fingerprint: "f".repeat(64) },
    });
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: mismatched });

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-rejected-process" />);
    const form = await screen.findByRole("region", { name: "Execute a subprocess" });
    await user.click(within(form).getByRole("button", { name: "Execute" }));

    expect(await within(form).findByRole("alert")).toHaveTextContent("no longer matches this exact operation and target selection");
    await waitFor(() => expect(api.discardExecutionPlan).toHaveBeenCalledExactlyOnceWith({ token: mismatched.token }));
    expect(api.executeExecutionPlan).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog", { name: "Execute this reviewed action?" })).not.toBeInTheDocument();
  });

  it("keeps an in-flight Windows Process result through a same-target catalog revision", async () => {
    const user = userEvent.setup();
    const windowsTarget: SessionSummary = { ...target, os: "windows", arch: "amd64" };
    const windowsProcess = capability("execution.process", { platforms: ["windows"] });
    const revisedRef: TargetRef = { ...targetRef, domainRevision: targetRef.domainRevision + 1 };
    const originalCatalog = catalog([windowsProcess], windowsTarget, targetRef);
    const revisedCatalog = deferred<{ ok: true; value: ExecutionCatalog }>();
    const pendingExecution = deferred<{ ok: true; value: ExecutionActionResult }>();
    const api = installAPI(originalCatalog);
    api.listExecutionCatalog
      .mockResolvedValueOnce({ ok: true, value: originalCatalog })
      .mockReturnValueOnce(revisedCatalog.promise);
    api.prepareExecutionAction.mockResolvedValue({
      ok: true,
      value: plan("execution.process", {
        target: { backend, target: windowsTarget, fingerprint: targetRef.fingerprint },
      }),
    });
    api.executeExecutionPlan.mockReturnValue(pendingExecution.promise);

    const { rerender } = render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="windows-process-revision" />);
    const form = await screen.findByRole("region", { name: "Execute a subprocess" });
    const executable = within(form).getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, "C:\\Windows\\System32\\tasklist.exe");
    await user.click(within(form).getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(api.executeExecutionPlan).toHaveBeenCalledExactlyOnceWith({ token: "plan-execution.process" }));
    expect(api.prepareExecutionAction.mock.calls[0]?.[0].draft).toMatchObject({ path: "C:\\Windows\\System32\\tasklist.exe" });
    act(() => api.publishProcessHistory([processRecord("windows-tasklist", "C:\\Windows\\System32\\tasklist.exe")]));
    const history = screen.getByRole("navigation", { name: "Process execution history" });
    await waitFor(() => expect(within(history).getByRole("row", { name: /tasklist\.exe/u })).toHaveTextContent("Running"));

    rerender(<TargetExecutionWorkbench expectedTarget={revisedRef} targetIdentity="windows-process-revision" />);
    await waitFor(() => expect(api.listExecutionCatalog).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status")).toHaveTextContent("Refreshing execution capabilities");
    await act(async () => {
      revisedCatalog.resolve({ ok: true, value: catalog([windowsProcess], windowsTarget, revisedRef) });
      await revisedCatalog.promise;
    });
    await waitFor(() => expect(screen.queryByText(/Refreshing execution capabilities/u)).not.toBeInTheDocument());
    await act(async () => {
      pendingExecution.resolve({ ok: true, value: completedProcessResult("windows-tasklist", 932, 0, "tasklist completed\n") });
      await pendingExecution.promise;
    });
    act(() => api.publishProcessHistory([processRecord(
      "windows-tasklist",
      "C:\\Windows\\System32\\tasklist.exe",
      completedProcessResult("windows-tasklist", 932, 0, "tasklist completed\n"),
      "tasklist completed\n",
    )]));

    expect(await screen.findByLabelText("Execution output transcript")).toHaveTextContent("tasklist completed");
    expect(within(history).getByRole("row", { name: /tasklist\.exe/u })).toHaveTextContent("Completed");
    const details = screen.getByLabelText("Execution details");
    expect(within(details).getByText("0")).toBeInTheDocument();
    expect(within(details).getByText("932")).toBeInTheDocument();
    expect(screen.queryByText("Outcome unknown")).not.toBeInTheDocument();
    expect(screen.queryByText("The selected target changed before this result could be associated with it.")).not.toBeInTheDocument();
  });

  it("quarantines a late Process result after the selected target identity actually changes", async () => {
    const user = userEvent.setup();
    const process = capability("execution.process");
    const changedRef: TargetRef = { ...targetRef, fingerprint: "e".repeat(64) };
    const pendingExecution = deferred<{ ok: true; value: ExecutionActionResult }>();
    const api = installAPI(catalog([process]));
    api.listExecutionCatalog
      .mockResolvedValueOnce({ ok: true, value: catalog([process]) })
      .mockResolvedValueOnce({ ok: true, value: catalog([process], target, changedRef) });
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: plan("execution.process") });
    api.executeExecutionPlan.mockReturnValue(pendingExecution.promise);

    const { rerender } = render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-before-change" />);
    const form = await screen.findByRole("region", { name: "Execute a subprocess" });
    await user.click(within(form).getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(api.executeExecutionPlan).toHaveBeenCalledExactlyOnceWith({ token: "plan-execution.process" }));
    act(() => api.publishProcessHistory([processRecord("late-original-target", "/bin/sh")]));
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Process execution history" })).toHaveTextContent("/bin/sh"));

    act(() => api.publishProcessHistory([], changedRef));
    rerender(<TargetExecutionWorkbench expectedTarget={changedRef} targetIdentity="target-after-change" />);
    await waitFor(() => expect(api.listExecutionCatalog).toHaveBeenCalledTimes(2));
    await act(async () => {
      pendingExecution.resolve({ ok: true, value: completedProcessResult("late-original-target", 933, 0, "private original-target output") });
      await pendingExecution.promise;
    });

    expect(api.readExecutionOutput).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Execution output transcript")).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Process execution history" })).getAllByRole("row")).toHaveLength(1);
  });

  it("shows captured stdout and exit code for each invocation, then navigates and clears history", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("execution.process")]));
    const firstOutput = "first process output\n";
    const secondOutput = "second process output\n";
    api.prepareExecutionAction
      .mockResolvedValueOnce({ ok: true, value: plan("execution.process", { token: "process-plan-first" }) })
      .mockResolvedValueOnce({ ok: true, value: plan("execution.process", { token: "process-plan-second" }) });
    api.executeExecutionPlan
      .mockResolvedValueOnce({ ok: true, value: completedProcessResult("process-first", 101, 7, firstOutput) })
      .mockResolvedValueOnce({ ok: true, value: completedProcessResult("process-second", 102, 0, secondOutput) });

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-history" />);
    let processForm = await screen.findByRole("region", { name: "Execute a subprocess" });
    const history = screen.getByRole("navigation", { name: "Process execution history" });
    expect(within(history).getAllByRole("row")).toHaveLength(1);
    expect(within(history).getByRole("row", { name: "New Execution" })).toHaveAttribute("aria-selected", "true");
    expect(within(processForm).getByRole("switch", { name: /Capture output/u })).toBeChecked();

    let executable = within(processForm).getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, "/usr/bin/first");
    await user.click(within(processForm).getByRole("button", { name: "Execute" }));
    expect(screen.queryByRole("alertdialog", { name: "Execute this reviewed action?" })).not.toBeInTheDocument();
    await waitFor(() => expect(api.executeExecutionPlan).toHaveBeenCalledTimes(1));
    act(() => api.publishProcessHistory([processRecord(
      "process-first", "/usr/bin/first", completedProcessResult("process-first", 101, 7, firstOutput), firstOutput,
    )]));
    expect(await screen.findByLabelText("Execution output transcript")).toHaveTextContent("first process output");
    expect(screen.queryByRole("region", { name: "Execute a subprocess" })).not.toBeInTheDocument();
    expect(within(history).getAllByRole("row")).toHaveLength(2);
    expect(within(history).getAllByRole("row")[0]).toHaveTextContent("New Execution");
    expect(within(history).getAllByRole("row")[1]).toHaveTextContent("/usr/bin/first");
    expect(within(history).getAllByRole("row")[1]).toHaveAttribute("aria-selected", "true");
    let details = screen.getByLabelText("Execution details");
    expect(within(details).getByText("7")).toBeInTheDocument();
    expect(within(details).getByText("101")).toBeInTheDocument();

    await user.click(within(history).getByRole("row", { name: "New Execution" }));
    processForm = screen.getByRole("region", { name: "Execute a subprocess" });
    expect(within(history).getByRole("row", { name: "New Execution" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByLabelText("Execution output transcript")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Execution details")).not.toBeInTheDocument();
    executable = within(processForm).getByRole("textbox", { name: "Executable path" });
    expect(executable).toHaveValue("/bin/sh");
    await user.clear(executable);
    await user.type(executable, "/usr/bin/second");
    await user.click(within(processForm).getByRole("button", { name: "Execute" }));
    expect(screen.queryByRole("alertdialog", { name: "Execute this reviewed action?" })).not.toBeInTheDocument();
    await waitFor(() => expect(api.executeExecutionPlan).toHaveBeenCalledTimes(2));
    act(() => api.publishProcessHistory([
      processRecord("process-second", "/usr/bin/second", completedProcessResult("process-second", 102, 0, secondOutput), secondOutput),
      processRecord("process-first", "/usr/bin/first", completedProcessResult("process-first", 101, 7, firstOutput), firstOutput),
    ]));
    expect(await screen.findByLabelText("Execution output transcript")).toHaveTextContent("second process output");
    expect(screen.queryByRole("region", { name: "Execute a subprocess" })).not.toBeInTheDocument();
    expect(within(history).getAllByRole("row")).toHaveLength(3);
    expect(within(history).getAllByRole("row")[0]).toHaveTextContent("New Execution");
    expect(within(history).getAllByRole("row")[1]).toHaveTextContent("/usr/bin/second");
    expect(within(history).getAllByRole("row")[1]).toHaveAttribute("aria-selected", "true");
    expect(within(history).getAllByRole("row")[2]).toHaveTextContent("/usr/bin/first");
    details = screen.getByLabelText("Execution details");
    expect(within(details).getByText("0")).toBeInTheDocument();

    await user.click(within(history).getByRole("row", { name: /\/usr\/bin\/first/u }));
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("first process output");
    expect(within(history).getAllByRole("row")[2]).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByLabelText("Execution details")).getByText("7")).toBeInTheDocument();
    await user.click(within(history).getByRole("row", { name: /\/usr\/bin\/second/u }));
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("second process output");

    await user.click(screen.getByRole("button", { name: "Clear selected" }));
    await waitFor(() => expect(within(history).getAllByRole("row")).toHaveLength(2));
    expect(within(history).getAllByRole("row")[1]).toHaveTextContent("/usr/bin/first");
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("first process output");
    await user.click(screen.getByRole("button", { name: "Clear history" }));
    await waitFor(() => expect(within(history).getAllByRole("row")).toHaveLength(1));
    expect(within(history).getByRole("row", { name: "New Execution" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "Execute a subprocess" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Execution output transcript")).not.toBeInTheDocument();
    expect(api.executeExecutionPlan).toHaveBeenNthCalledWith(1, { token: "process-plan-first" });
    expect(api.executeExecutionPlan).toHaveBeenNthCalledWith(2, { token: "process-plan-second" });
  });

  it("switches the selected execution between captured stdout and stderr", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("execution.process")]));
    const stdout = "captured stdout\n";
    const stderr = "captured stderr\n";
    const completed = completedProcessResult("process-streams", 303, 0, stdout);
    const stdoutHandle = completed.output![0]!;
    const result: ExecutionActionResult = {
      ...completed,
      output: [stdoutHandle, { ...stdoutHandle, handle: "output-process-streams-stderr", stream: "stderr" }],
    };
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: plan("execution.process") });
    api.executeExecutionPlan.mockResolvedValue({ ok: true, value: result });

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-streams" />);
    const form = await screen.findByRole("region", { name: "Execute a subprocess" });
    await user.click(within(form).getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(api.executeExecutionPlan).toHaveBeenCalledOnce());
    act(() => api.publishProcessHistory([processRecord("process-streams", "/bin/sh", result, stdout, stderr)]));

    const streams = await screen.findByRole("radiogroup", { name: "Captured output stream" });
    const stdoutChoice = within(streams).getByRole("radio", { name: "Stdout" });
    const stderrChoice = within(streams).getByRole("radio", { name: "Stderr" });
    expect(stdoutChoice).toBeChecked();
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("captured stdout");

    await user.click(stderrChoice);
    expect(stderrChoice).toBeChecked();
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("captured stderr");

    await user.click(stdoutChoice);
    expect(stdoutChoice).toBeChecked();
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("captured stdout");
  });

  it("hydrates the session's main-owned process history after the workbench remounts", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("execution.process")]));
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: plan("execution.process") });
    api.executeExecutionPlan.mockResolvedValue({
      ok: true,
      value: completedProcessResult("process-remount", 515, 3, "retained output"),
    });

    const mounted = render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-remount" />);
    const processForm = await screen.findByRole("region", { name: "Execute a subprocess" });
    const executable = within(processForm).getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, "/usr/bin/retained");
    await user.click(within(processForm).getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(api.executeExecutionPlan).toHaveBeenCalledOnce());
    act(() => api.publishProcessHistory([processRecord(
      "process-remount", "/usr/bin/retained", completedProcessResult("process-remount", 515, 3, "retained output"), "retained output",
    )]));
    expect(await screen.findByLabelText("Execution output transcript")).toHaveTextContent("retained output");
    mounted.unmount();

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-remount" />);
    const history = await screen.findByRole("navigation", { name: "Process execution history" });
    expect(within(history).getAllByRole("row")).toHaveLength(2);
    expect(within(history).getAllByRole("row")[0]).toHaveTextContent("New Execution");
    expect(within(history).getByRole("row", { name: /\/usr\/bin\/retained/u })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("region", { name: "Execute a subprocess" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("retained output");
    expect(within(screen.getByLabelText("Execution details")).getByText("3")).toBeInTheDocument();
    expect(api.readExecutionOutput).not.toHaveBeenCalled();
  });

  it("saves and adds the selected invocation's retained stdout to Loot", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("execution.process")]));
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: plan("execution.process") });
    api.executeExecutionPlan.mockResolvedValue({
      ok: true,
      value: completedProcessResult("process-loot", 616, 0, "captured output"),
    });
    api.saveExecutionResult.mockResolvedValue({ ok: true, value: { saved: true, fileName: "output.txt" } });
    api.addExecutionOutputToLoot.mockResolvedValue({
      ok: true,
      value: {
        id: "loot-1",
        name: "Process log",
        fileName: "output.txt",
        fileType: "text",
        originHostId: target.hostId,
        sizeBytes: "15",
      },
    });

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-loot" />);
    const processForm = await screen.findByRole("region", { name: "Execute a subprocess" });
    const executable = within(processForm).getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, "/usr/bin/printf");
    await user.click(within(processForm).getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(api.executeExecutionPlan).toHaveBeenCalledOnce());
    act(() => api.publishProcessHistory([processRecord(
      "process-loot", "/usr/bin/printf", completedProcessResult("process-loot", 616, 0, "captured output"), "captured output",
    )]));
    await screen.findByLabelText("Execution output transcript");

    await user.click(screen.getByRole("button", { name: "Save stdout" }));
    await waitFor(() => expect(api.saveExecutionResult).toHaveBeenCalledExactlyOnceWith({
      requestId: "process-loot",
      stream: "stdout",
    }));

    expect(screen.queryByRole("textbox", { name: "Loot name (optional)" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add stdout to Loot" }));
    await waitFor(() => expect(api.addExecutionOutputToLoot).toHaveBeenCalledExactlyOnceWith({
      requestId: "process-loot",
      stream: "stdout",
      name: "",
    }));
  });

  it("uses the right-clicked Process history item for output actions without changing selection", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("execution.process")]));
    const writeText = vi.fn(async (_text: string) => undefined);
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      const view = render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-history-menu" />);
      act(() => api.publishProcessHistory([
        processRecord("first-run", "/usr/bin/first", completedProcessResult("first-run", 100, 0, "first stdout"), "first stdout"),
        processRecord("second-run", "/usr/bin/second", completedProcessResult("second-run", 101, 0, "second stdout"), "second stdout"),
      ]));
      const history = await screen.findByRole("navigation", { name: "Process execution history" });
      const first = await within(history).findByRole("row", { name: /\/usr\/bin\/first/u });
      const second = within(history).getByRole("row", { name: /\/usr\/bin\/second/u });
      await user.click(second);
      expect(second).toHaveAttribute("aria-selected", "true");

      fireEvent.contextMenu(first);
      view.contextMenu.emit([]);
      const copyMenu = await screen.findByRole("menu", { name: "Application context menu" });
      await user.click(within(copyMenu).getByRole("menuitem", { name: "Copy output" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith("first stdout"));
      expect(second).toHaveAttribute("aria-selected", "true");

      fireEvent.contextMenu(first);
      view.contextMenu.emit([]);
      const lootMenu = await screen.findByRole("menu", { name: "Application context menu" });
      await user.click(within(lootMenu).getByRole("menuitem", { name: "Add stdout to Loot" }));
      await waitFor(() => expect(api.addExecutionOutputToLoot).toHaveBeenCalledExactlyOnceWith({
        requestId: "first-run",
        stream: "stdout",
        name: "",
      }));
      expect(second).toHaveAttribute("aria-selected", "true");
    } finally {
      if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("disables Process history output actions when stdout is absent or its Loot handle expired", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("execution.process")]));
    const expiredResult = completedProcessResult("expired-run", 102, 0, "expired stdout");
    expiredResult.output = expiredResult.output!.map((item) => ({
      ...item,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    const view = render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-history-menu-disabled" />);
    act(() => api.publishProcessHistory([
      processRecord("empty-run", "/usr/bin/empty"),
      processRecord("expired-run", "/usr/bin/expired", expiredResult, "expired stdout"),
    ]));
    const history = await screen.findByRole("navigation", { name: "Process execution history" });
    const empty = await within(history).findByRole("row", { name: /\/usr\/bin\/empty/u });
    const expired = within(history).getByRole("row", { name: /\/usr\/bin\/expired/u });
    fireEvent.contextMenu(empty);
    view.contextMenu.emit([]);
    const emptyMenu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(emptyMenu).getByRole("menuitem", { name: "Copy output" })).toHaveAttribute("aria-disabled", "true");
    expect(within(emptyMenu).getByRole("menuitem", { name: "Add stdout to Loot" })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Application context menu" })).not.toBeInTheDocument());

    fireEvent.contextMenu(expired);
    view.contextMenu.emit([]);
    await waitFor(() => {
      const expiredMenu = screen.getByRole("menu", { name: "Application context menu" });
      expect(within(expiredMenu).getByRole("menuitem", { name: "Copy output" })).not.toHaveAttribute("aria-disabled", "true");
      expect(within(expiredMenu).getByRole("menuitem", { name: "Add stdout to Loot" })).toHaveAttribute("aria-disabled", "true");
    });
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
    const executable = screen.getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, "/usr/bin/id");
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
    await screen.findByRole("region", { name: "Execution operations" });
    await selectAdvancedCategory(user, "Identity");
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
    await screen.findByRole("region", { name: "Execution operations" });
    await selectAdvancedCategory(user, "Identity");
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
    await screen.findByRole("region", { name: "Execution operations" });
    await selectAdvancedCategory(user, "Identity");
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
    await screen.findByRole("region", { name: "Execution operations" });
    await selectAdvancedCategory(user, "Identity");
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

  it("executes a local .NET assembly directly while keeping its native path in main", async () => {
    const user = userEvent.setup();
    const windowsTarget: SessionSummary = { ...target, os: "windows", arch: "amd64" };
    const windowsRef: TargetRef = { ...targetRef, fingerprint: "f".repeat(64) };
    const assembly = capability("execution.assembly", {
      platforms: ["windows"],
      artifacts: [{
        role: "assembly",
        label: ".NET assembly",
        required: true,
        maximumBytes: 4_194_304,
        acceptedExtensions: [".exe", ".dll"],
      }],
    });
    const api = installAPI(catalog([assembly], windowsTarget, windowsRef));
    api.prepareExecutionAction.mockResolvedValue({
      ok: true,
      value: plan("execution.assembly", {
        target: { backend, target: windowsTarget, fingerprint: windowsRef.fingerprint },
        artifacts: [{
          role: "assembly",
          fileName: "Seatbelt.exe",
          mediaType: "application/vnd.microsoft.portable-executable",
          size: 524_288,
          sha256: "e".repeat(64),
        }],
      }),
    });
    api.executeExecutionPlan.mockResolvedValue({
      ok: true,
      value: {
        requestId: "assembly-direct-request",
        operationId: "execution.assembly",
        state: "completed",
        message: "Assembly execution completed.",
      },
    });

    render(<TargetExecutionWorkbench expectedTarget={windowsRef} targetIdentity="target-a" />);
    await screen.findByRole("region", { name: "Execution operations" });
    await selectAdvancedCategory(user, "Payloads");
    expect(screen.queryByRole("button", { name: "Open: Execute assembly" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: ".NET" }));
    await user.click(screen.getByRole("button", { name: "Open assembly file" }));
    await waitFor(() => expect(api.chooseDotNetAssemblyFile).toHaveBeenCalledOnce());
    expect(screen.queryByDisplayValue(/Users|Desktop|Seatbelt/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Execute" }));

    await waitFor(() => expect(api.prepareExecutionAction).toHaveBeenCalledWith({
      draft: expect.objectContaining({ operationId: "execution.assembly" }),
      assemblySource: { kind: "file", token: "assembly-file-token" },
    }));
    await waitFor(() => expect(api.executeExecutionPlan).toHaveBeenCalledExactlyOnceWith({ token: "plan-execution.assembly" }));
    expect(screen.queryByRole("alertdialog", { name: "Execute this reviewed action?" })).not.toBeInTheDocument();
    expect(screen.queryByText("Assembly execution completed.", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(/Users|Desktop|Seatbelt/u)).not.toBeInTheDocument();
  });

  it("rejects a mismatched .NET plan before direct execution", async () => {
    const user = userEvent.setup();
    const windowsTarget: SessionSummary = { ...target, os: "windows", arch: "amd64" };
    const windowsRef: TargetRef = { ...targetRef, fingerprint: "f".repeat(64) };
    const assembly = capability("execution.assembly", { platforms: ["windows"] });
    const api = installAPI(catalog([assembly], windowsTarget, windowsRef));
    const mismatched = plan("execution.assembly", {
      target: { backend, target: windowsTarget, fingerprint: "e".repeat(64) },
    });
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: mismatched });

    render(<TargetExecutionWorkbench expectedTarget={windowsRef} targetIdentity="target-mismatched-assembly" />);
    await screen.findByRole("region", { name: "Execution operations" });
    await user.click(screen.getByRole("radio", { name: ".NET" }));
    const form = screen.getByRole("region", { name: "Execute a .NET assembly" });
    await user.click(within(form).getByRole("button", { name: "Open assembly file" }));
    await user.click(within(form).getByRole("button", { name: "Execute" }));

    expect(await within(form).findByRole("alert")).toHaveTextContent("no longer matches this exact operation and target selection");
    await waitFor(() => expect(api.discardExecutionPlan).toHaveBeenCalledExactlyOnceWith({ token: mismatched.token }));
    expect(api.executeExecutionPlan).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog", { name: "Execute this reviewed action?" })).not.toBeInTheDocument();
  });
});
