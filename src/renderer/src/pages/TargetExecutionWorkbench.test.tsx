import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SliverDesktopAPI } from "../../../shared/contracts";
import type {
  ExecutionActionPlan,
  ExecutionActionResult,
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
import { clearProcessExecution } from "./process-execution-history";
import { TargetExecutionWorkbench } from "./TargetExecutionWorkbench";

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
  clearProcessExecution(JSON.stringify([
    backend.configId,
    backend.epoch,
    "session",
    target.id,
    targetRef.fingerprint,
  ]));
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

function installAPI(executionCatalog: ExecutionCatalog) {
  let beaconTasksInvalidatedListener: ((target: TargetRef) => void) | undefined;
  const api = {
    listExecutionCatalog: vi.fn().mockResolvedValue({ ok: true, value: executionCatalog }),
    runExecutionRead: vi.fn().mockResolvedValue({ ok: false, error: "No read configured" }),
    prepareExecutionAction: vi.fn().mockResolvedValue({ ok: false, error: "No plan configured" }),
    executeExecutionPlan: vi.fn().mockResolvedValue({ ok: false, error: "No execution configured" }),
    discardExecutionPlan: vi.fn().mockResolvedValue({ ok: true }),
    getExecutionResult: vi.fn().mockResolvedValue({ ok: false, error: "No result configured" }),
    readExecutionOutput: vi.fn().mockResolvedValue({ ok: false, error: "No output configured" }),
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

    const executionOperations = await screen.findByRole("region", { name: "Execution operations" });
    expect(executionOperations).toBeInTheDocument();
    expect(within(executionOperations).queryByRole("heading", { name: "Execution workbench" })).not.toBeInTheDocument();
    expect(within(executionOperations).queryByText("Configure one typed operation, review the exact target and native files, then execute a short-lived main-owned plan.")).not.toBeInTheDocument();
    expect(within(executionOperations).queryByText("session", { exact: true })).not.toBeInTheDocument();
    expect(within(executionOperations).getByText("linux/amd64")).toBeInTheDocument();
    expect(api.listExecutionCatalog).toHaveBeenCalledOnce();
    expect(screen.getByRole("radio", { name: "Process" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Payloads" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Remote" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Identity" })).toBeInTheDocument();
    const processForm = screen.getByRole("region", { name: "Run a process" });
    const outputPanel = screen.getByRole("region", { name: "Process execution history and output" });
    expect(processForm.compareDocumentPosition(outputPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(processForm).getByRole("textbox", { name: "Executable path" })).toHaveValue("/bin/sh");
    expect(within(processForm).getByRole("textbox", { name: "Arguments" })).toBeInTheDocument();
    expect(within(processForm).getByRole("button", { name: "Execution options" })).toBeInTheDocument();
    expect(within(processForm).queryByRole("switch", { name: /Capture output/u })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review command" })).toHaveAttribute("type", "submit");
    expect(screen.queryByText("Background tracking is disabled by this server.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unavailable: Background children" })).not.toBeInTheDocument();

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
    await screen.findByRole("region", { name: "Execution operations" });
    const processForm = screen.getByRole("region", { name: "Run a process" });
    expect(within(processForm).getByRole("textbox", { name: "Executable path" })).toHaveValue("C:\\Windows\\System32\\cmd.exe");
    expect(within(processForm).getByRole("textbox", { name: "Arguments" })).toBeInTheDocument();
    await user.click(within(processForm).getByRole("button", { name: "Execution options" }));
    const options = await screen.findByRole("dialog", { name: "Execution options" });
    expect(within(options).getByRole("switch", { name: /Capture output/u })).toBeChecked();
    expect(within(options).getByRole("switch", { name: /Use current token/u })).toBeInTheDocument();
    expect(within(options).getByRole("switch", { name: /Hide window/u })).toBeInTheDocument();
    expect(within(options).getByRole("spinbutton", { name: "Parent process ID" })).toBeInTheDocument();
    await user.click(within(options).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Execution options" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Review command" })).toHaveAttribute("type", "submit");
    expect(screen.queryByRole("button", { name: "Open: Migrate process" })).not.toBeInTheDocument();
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
    await screen.findByRole("region", { name: "Execution operations" });
    await user.click(screen.getByRole("button", { name: "Execution options" }));
    const options = await screen.findByRole("dialog", { name: "Execution options" });
    expect(within(options).getByRole("switch", { name: /Capture output/u })).toBeChecked();
    expect(within(options).getByRole("spinbutton", { name: "Timeout seconds" })).toBeInTheDocument();
    expect(within(options).queryByRole("spinbutton", { name: "Parent process ID" })).not.toBeInTheDocument();
    await user.click(within(options).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Execution options" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Review command" }));

    await waitFor(() => expect(api.prepareExecutionAction).toHaveBeenCalledOnce());
    expect(api.prepareExecutionAction.mock.calls[0]?.[0].draft).not.toHaveProperty("parentPid");
    expect(api.prepareExecutionAction.mock.calls[0]?.[0].draft).toMatchObject({ path: "/bin/sh" });
  });

  it("keeps command fields inline and retains modal execution options in the reviewed draft", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("execution.process")]));
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: plan("execution.process") });

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-process-options" />);
    const form = await screen.findByRole("region", { name: "Run a process" });
    const executable = within(form).getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, "/usr/bin/env");
    const argumentsField = within(form).getByRole("textbox", { name: "Arguments" });
    expect(argumentsField.tagName).toBe("INPUT");
    await user.type(argumentsField, 'alpha "two words" three\\ four ""');
    expect(within(form).queryByRole("switch", { name: /Run in background/u })).not.toBeInTheDocument();
    expect(within(form).queryByRole("textbox", { name: "Environment overrides" })).not.toBeInTheDocument();

    await user.click(within(form).getByRole("button", { name: "Execution options" }));
    let options = await screen.findByRole("dialog", { name: "Execution options" });
    expect(within(options).getByRole("switch", { name: /Capture output/u })).toBeChecked();
    await user.click(within(options).getByRole("switch", { name: /Run in background/u }));
    expect(within(options).getByRole("switch", { name: /Capture output/u })).not.toBeChecked();
    await user.type(within(options).getByRole("textbox", { name: "Environment overrides" }), "MODE=trace");
    const timeout = within(options).getByRole("spinbutton", { name: "Timeout seconds" });
    await user.clear(timeout);
    await user.type(timeout, "15");
    await user.click(within(options).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Execution options" })).not.toBeInTheDocument());

    await user.click(within(form).getByRole("button", { name: "Execution options" }));
    options = await screen.findByRole("dialog", { name: "Execution options" });
    expect(within(options).getByRole("switch", { name: /Run in background/u })).toBeChecked();
    expect(within(options).getByRole("textbox", { name: "Environment overrides" })).toHaveValue("MODE=trace");
    expect(within(options).getByRole("spinbutton", { name: "Timeout seconds" })).toHaveValue(15);
    await user.click(within(options).getByRole("button", { name: "Done" }));
    await user.click(within(form).getByRole("button", { name: "Review command" }));

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
    api.readExecutionOutput.mockImplementation(async ({ requestId }: { requestId: string }) => ({
      ok: true,
      value: {
        data: new TextEncoder().encode(requestId === "process-first" ? firstOutput : secondOutput),
        truncated: false,
      },
    }));

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-history" />);
    const processForm = await screen.findByRole("region", { name: "Run a process" });
    expect(within(processForm).getByRole("button", { name: "Execution options" })).toBeInTheDocument();

    const executable = within(processForm).getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, "/usr/bin/first");
    await user.click(within(processForm).getByRole("button", { name: "Review command" }));
    let review = await screen.findByRole("alertdialog", { name: "Execute this reviewed action?" });
    await user.click(within(review).getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(api.readExecutionOutput).toHaveBeenCalledWith({ requestId: "process-first", stream: "stdout" }));
    expect(await screen.findByLabelText("Execution output transcript")).toHaveTextContent("first process output");
    let details = screen.getByLabelText("Execution details");
    expect(within(details).getByText("7")).toBeInTheDocument();
    expect(within(details).getByText("101")).toBeInTheDocument();

    await user.clear(executable);
    await user.type(executable, "/usr/bin/second");
    await user.click(within(processForm).getByRole("button", { name: "Review command" }));
    review = await screen.findByRole("alertdialog", { name: "Execute this reviewed action?" });
    await user.click(within(review).getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(api.readExecutionOutput).toHaveBeenCalledWith({ requestId: "process-second", stream: "stdout" }));
    expect(await screen.findByLabelText("Execution output transcript")).toHaveTextContent("second process output");
    const history = screen.getByRole("navigation", { name: "Process execution history" });
    expect(within(history).getAllByRole("button")).toHaveLength(2);
    details = screen.getByLabelText("Execution details");
    expect(within(details).getByText("0")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Older" }));
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("first process output");
    expect(within(screen.getByLabelText("Execution details")).getByText("7")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Newer" }));
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("second process output");

    await user.click(screen.getByRole("button", { name: "Clear selected" }));
    expect(within(history).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("first process output");
    await user.click(screen.getByRole("button", { name: "Clear history" }));
    expect(screen.queryByRole("navigation", { name: "Process execution history" })).not.toBeInTheDocument();
    expect(screen.getByText("Run a process to see its output and execution history here.")).toBeInTheDocument();
    expect(api.executeExecutionPlan).toHaveBeenNthCalledWith(1, { token: "process-plan-first" });
    expect(api.executeExecutionPlan).toHaveBeenNthCalledWith(2, { token: "process-plan-second" });
  });

  it("keeps the session's in-memory process history after the workbench remounts", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("execution.process")]));
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: plan("execution.process") });
    api.executeExecutionPlan.mockResolvedValue({
      ok: true,
      value: completedProcessResult("process-remount", 515, 3, "retained output"),
    });
    api.readExecutionOutput.mockResolvedValue({
      ok: true,
      value: { data: new TextEncoder().encode("retained output"), truncated: false },
    });

    const mounted = render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-remount" />);
    const processForm = await screen.findByRole("region", { name: "Run a process" });
    const executable = within(processForm).getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, "/usr/bin/retained");
    await user.click(within(processForm).getByRole("button", { name: "Review command" }));
    const review = await screen.findByRole("alertdialog", { name: "Execute this reviewed action?" });
    await user.click(within(review).getByRole("button", { name: "Execute" }));
    expect(await screen.findByLabelText("Execution output transcript")).toHaveTextContent("retained output");
    mounted.unmount();

    render(<TargetExecutionWorkbench expectedTarget={targetRef} targetIdentity="target-remount" />);
    const history = await screen.findByRole("navigation", { name: "Process execution history" });
    expect(within(history).getByRole("button", { name: /\/usr\/bin\/retained/u })).toBeInTheDocument();
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("retained output");
    expect(within(screen.getByLabelText("Execution details")).getByText("3")).toBeInTheDocument();
    expect(api.readExecutionOutput).toHaveBeenCalledExactlyOnceWith({ requestId: "process-remount", stream: "stdout" });
  });

  it("saves and adds the selected invocation's retained stdout to Loot", async () => {
    const user = userEvent.setup();
    const api = installAPI(catalog([capability("execution.process")]));
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: plan("execution.process") });
    api.executeExecutionPlan.mockResolvedValue({
      ok: true,
      value: completedProcessResult("process-loot", 616, 0, "captured output"),
    });
    api.readExecutionOutput.mockResolvedValue({
      ok: true,
      value: { data: new TextEncoder().encode("captured output"), truncated: false },
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
    const processForm = await screen.findByRole("region", { name: "Run a process" });
    const executable = within(processForm).getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, "/usr/bin/printf");
    await user.click(within(processForm).getByRole("button", { name: "Review command" }));
    const review = await screen.findByRole("alertdialog", { name: "Execute this reviewed action?" });
    await user.click(within(review).getByRole("button", { name: "Execute" }));
    await screen.findByLabelText("Execution output transcript");

    await user.click(screen.getByRole("button", { name: "Save stdout" }));
    await waitFor(() => expect(api.saveExecutionResult).toHaveBeenCalledExactlyOnceWith({
      requestId: "process-loot",
      stream: "stdout",
    }));

    await user.type(screen.getByRole("textbox", { name: "Loot name (optional)" }), "Process log");
    await user.click(screen.getByRole("button", { name: "Add stdout to Loot" }));
    await waitFor(() => expect(api.addExecutionOutputToLoot).toHaveBeenCalledExactlyOnceWith({
      requestId: "process-loot",
      stream: "stdout",
      name: "Process log",
    }));
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
    await screen.findByRole("region", { name: "Execution operations" });
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
    await screen.findByRole("region", { name: "Execution operations" });
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
    await screen.findByRole("region", { name: "Execution operations" });
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
    await screen.findByRole("region", { name: "Execution operations" });
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
