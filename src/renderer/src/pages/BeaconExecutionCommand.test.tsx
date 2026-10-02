import { useState } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SliverDesktopAPI } from "../../../shared/contracts";
import type { ExecutionActionPlan, ExecutionCapability, ExecutionCatalog, ExecutionOperationId } from "../../../shared/execution-contracts";
import type { BeaconSummary, TargetRef } from "../../../shared/target-contracts";
import { renderWithApplicationContextMenu as render } from "../application-context-menu-test-utils";
import { BeaconExecutionCommand, type BeaconExecutionCommandState, type BeaconExecutionSelection } from "./BeaconExecutionCommand";

vi.mock("../components/ExecutionOutputTerminal", () => ({ ExecutionOutputTerminal: () => null }));

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
  Object.defineProperty(Element.prototype, "releasePointerCapture", { configurable: true, value: () => undefined });
});
afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  Reflect.deleteProperty(Element.prototype, "setPointerCapture");
  Reflect.deleteProperty(Element.prototype, "releasePointerCapture");
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "sliver"); });

const target: BeaconSummary = {
  mode: "beacon", id: "beacon-1", name: "build-host", hostname: "build-01", hostId: "host-1", username: "operator",
  os: "linux", arch: "amd64", transport: "mtls", remoteAddress: "10.0.0.8:4444", activeC2: "mtls://10.0.0.8:4444",
  executable: "/tmp/implant", version: "1.7.6", locale: "en-US", integrity: "user", burned: false, pid: 42,
  checkinStatus: "on-time", intervalMs: 60_000, jitterMs: 0,
};
const targetRef: TargetRef = { mode: "beacon", id: target.id, backendEpoch: 7, domainRevision: 5, fingerprint: "b".repeat(64) };
const backend = { configId: "config-1", configName: "Production", server: "127.0.0.1:53137", operator: "test", epoch: 7 };
function capability(operationId: ExecutionOperationId, overrides: Partial<ExecutionCapability> = {}): ExecutionCapability {
  return { operationId, available: true, modes: ["beacon"], platforms: ["linux"], risk: "mutating", confirmationRequired: true, credentialBearing: false, artifacts: [], ...overrides };
}
function catalog(capabilities = [capability("execution.process")], catalogTarget = target, ref = targetRef): ExecutionCatalog {
  return { backend, target: catalogTarget, targetRef: ref, capabilities };
}
function plan(operationId: ExecutionOperationId = "execution.process", overrides: Partial<ExecutionActionPlan> = {}): ExecutionActionPlan {
  return { token: `plan-${operationId}`, operationId, expiresAt: new Date(Date.now() + 60_000).toISOString(), risk: "mutating",
    target: { backend, target, fingerprint: targetRef.fingerprint }, warning: "This action changes the beacon.", fields: [], artifacts: [], ...overrides };
}
function installApi(value = catalog()) {
  const api = {
    listExecutionCatalog: vi.fn().mockResolvedValue({ ok: true, value }),
    runExecutionRead: vi.fn(),
    prepareExecutionAction: vi.fn().mockResolvedValue({ ok: true, value: plan() }),
    executeExecutionPlan: vi.fn().mockResolvedValue({ ok: true, value: { requestId: "execution-1", taskId: "task-1", operationId: "execution.process", state: "submitted", message: "Queued." } }),
    discardExecutionPlan: vi.fn().mockResolvedValue({ ok: true }),
    listInstalledBofs: vi.fn().mockResolvedValue({ ok: true, value: { target: value.targetRef, warnings: [], commands: [] } }),
    listBofExecutionHistory: vi.fn().mockResolvedValue({ ok: true, value: { target: value.targetRef, revision: 0, records: [] } }),
    onBofExecutionHistoryChanged: vi.fn(() => () => undefined),
    listDotNetAssemblies: vi.fn().mockResolvedValue({ ok: true, value: { target: value.targetRef, assemblies: [] } }),
    listDotNetExecutionHistory: vi.fn().mockResolvedValue({ ok: true, value: { target: value.targetRef, revision: 0, records: [] } }),
    onDotNetExecutionHistoryChanged: vi.fn(() => () => undefined),
    chooseDotNetAssemblyFile: vi.fn().mockResolvedValue({ ok: true, value: { token: "assembly-file", fileName: "Tool.exe", size: 256, isDll: false } }),
    runBof: vi.fn(),
  };
  Object.defineProperty(window, "sliver", { configurable: true, value: api as unknown as SliverDesktopAPI });
  return api;
}
function Harness({ expectedTarget = targetRef, onQueuedTask = () => undefined, selection = "execution" }: { expectedTarget?: TargetRef; onQueuedTask?: (id: string) => void; selection?: BeaconExecutionSelection }) {
  const [state, setState] = useState<BeaconExecutionCommandState>({ isPending: false, isAvailable: false });
  return <><button type="submit" form="beacon-execution-test" disabled={!state.isAvailable || state.isPending}>Queue task</button>
    <BeaconExecutionCommand expectedTarget={expectedTarget} targetIdentity={`backend:${expectedTarget.id}`} formId="beacon-execution-test" selection={selection} onQueuedTask={onQueuedTask} onStateChange={setState} /></>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}

describe("beacon execution command", () => {
  it.each([
    ["execution.children", target],
    ["privilege.get", { ...target, os: "windows" }],
  ] as const)("queues the selected %s read with an exact task ID", async (selection, selectedTarget) => {
    const api = installApi(catalog([capability(selection, { platforms: [selectedTarget.os], risk: "read-only", confirmationRequired: false })], selectedTarget));
    api.runExecutionRead.mockResolvedValue({ ok: true, value: {
      operationId: selection, state: "submitted", taskId: `task-${selection}`, total: 0, truncated: false,
      ...(selection === "execution.children" ? { items: [] } : { processName: "", processIntegrity: "", privileges: [] }),
    } });
    const queued = vi.fn();
    render(<Harness selection={selection} onQueuedTask={queued} />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue task" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Queue task" }));
    await waitFor(() => expect(queued).toHaveBeenCalledExactlyOnceWith(`task-${selection}`));
    expect(api.runExecutionRead).toHaveBeenCalledExactlyOnceWith({ operationId: selection, limit: 100 });
    expect(api.prepareExecutionAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab", { name: "Process" })).not.toBeInTheDocument();
  });

  it.each(["privilege.run-as", "privilege.make-token", "privilege.impersonate", "privilege.revert"] as const)(
    "preserves one-use review for the direct Windows identity command %s", async (selection) => {
    const windowsTarget = { ...target, os: "windows" };
    const api = installApi(catalog([capability(selection, {
      platforms: ["windows"], credentialBearing: selection === "privilege.run-as" || selection === "privilege.make-token",
    })], windowsTarget));
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: plan(selection, { target: { backend, target: windowsTarget, fingerprint: targetRef.fingerprint } }) });
    api.executeExecutionPlan.mockResolvedValue({ ok: true, value: { requestId: `${selection}-1`, taskId: `task-${selection}`, operationId: selection, state: "submitted", message: "Queued." } });
    const queued = vi.fn();
    const user = userEvent.setup();
    render(<Harness selection={selection} onQueuedTask={queued} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue task" })).toBeEnabled());
    if (selection === "privilege.run-as" || selection === "privilege.make-token") {
      await user.type(screen.getByRole("textbox", { name: "Username" }), "CORP\\alice");
      await user.type(screen.getByLabelText("Password"), "one-use-secret");
    }
    if (selection === "privilege.run-as") await user.type(screen.getByRole("textbox", { name: "Process" }), "cmd.exe");
    if (selection === "privilege.impersonate") await user.type(screen.getByRole("textbox", { name: "Logged-in username" }), "CORP\\alice");
    await user.click(screen.getByRole("button", { name: "Queue task" }));
    const review = await screen.findByRole("alertdialog", { name: "Execute this reviewed action?" });
    expect(api.executeExecutionPlan).not.toHaveBeenCalled();
    expect(api.prepareExecutionAction).toHaveBeenCalledWith({ draft: expect.objectContaining({ operationId: selection }) });
    await user.click(within(review).getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(queued).toHaveBeenCalledExactlyOnceWith(`task-${selection}`));
    expect(api.executeExecutionPlan).toHaveBeenCalledExactlyOnceWith({ token: `plan-${selection}` });
    if (selection === "privilege.run-as" || selection === "privilege.make-token") {
      expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    }
  });
  it("uses the external form submit and requires process review before dispatch", async () => {
    const api = installApi(); const queued = vi.fn(); const user = userEvent.setup();
    render(<Harness onQueuedTask={queued} />);
    await screen.findByRole("textbox", { name: "Executable path" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue task" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Execute" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Queue task" }));
    const review = await screen.findByRole("alertdialog", { name: "Execute this reviewed action?" });
    expect(api.prepareExecutionAction).toHaveBeenCalledTimes(1);
    expect(api.executeExecutionPlan).not.toHaveBeenCalled();
    await user.click(within(review).getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(queued).toHaveBeenCalledWith("task-1"));
    expect(api.executeExecutionPlan).toHaveBeenCalledWith({ token: "plan-execution.process" });
  });

  it("discards canceled plans and allows a failed preparation to retry", async () => {
    const api = installApi(); const user = userEvent.setup();
    api.prepareExecutionAction.mockResolvedValueOnce({ ok: false, error: "Temporary preparation failure" });
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue task" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Queue task" }));
    await screen.findAllByText("Temporary preparation failure");
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue task" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Queue task" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(api.discardExecutionPlan).toHaveBeenCalledWith({ token: "plan-execution.process" }));
    expect(api.executeExecutionPlan).not.toHaveBeenCalled();
  });

  it("rejects a mismatched backend plan and keeps the form available", async () => {
    const api = installApi(); const user = userEvent.setup();
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: plan("execution.process", { target: { backend: { ...backend, configId: "other-backend" }, target, fingerprint: targetRef.fingerprint } }) });
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue task" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Queue task" }));
    await waitFor(() => expect(api.discardExecutionPlan).toHaveBeenCalledWith({ token: "plan-execution.process" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.executeExecutionPlan).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Queue task" })).toBeEnabled();
  });

  it("discards a late plan after an exact target revision changes", async () => {
    const api = installApi(); const user = userEvent.setup(); const pending = deferred<{ ok: true; value: ExecutionActionPlan }>();
    api.prepareExecutionAction.mockReturnValue(pending.promise);
    const view = render(<Harness />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue task" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Queue task" }));
    const newerRef = { ...targetRef, domainRevision: 6 };
    api.listExecutionCatalog.mockResolvedValue({ ok: true, value: catalog(undefined, target, newerRef) });
    view.rerender(<Harness expectedTarget={newerRef} />);
    await act(async () => pending.resolve({ ok: true, value: plan() }));
    await waitFor(() => expect(api.discardExecutionPlan).toHaveBeenCalledWith({ token: "plan-execution.process" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.executeExecutionPlan).not.toHaveBeenCalled();
  });

  it("filters executable variants by issued mode and platform including unavailable capabilities", async () => {
    installApi(catalog([
      capability("execution.process"), capability("execution.assembly", { platforms: ["windows"] }),
      capability("execution.spawn-dll", { platforms: ["windows"] }), capability("execution.sideload", { modes: ["session"] }),
      capability("execution.shellcode", { available: false, reason: { code: "unsupported-platform", message: "Shellcode is unavailable." } }),
      capability("execution.migrate"), capability("execution.msf"), capability("execution.msf-inject"),
    ]));
    const user = userEvent.setup(); render(<Harness />);
    await screen.findByRole("tab", { name: "Process" });
    expect(screen.queryByRole("tab", { name: ".NET" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Reflective DLL" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Sideload" })).not.toBeInTheDocument();
    for (const name of ["BOFs", "Shellcode", "Migrate", "MSF", "MSF inject"]) expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Shellcode" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue task" })).toBeDisabled());
  });

  it("ignores a stale preparation failure while keeping the same beacon's refreshed form", async () => {
    const api = installApi(); const user = userEvent.setup(); const pending = deferred<never>();
    api.prepareExecutionAction.mockReturnValue(pending.promise);
    const view = render(<Harness />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue task" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Queue task" }));
    const newerRef = { ...targetRef, domainRevision: 6 };
    api.listExecutionCatalog.mockResolvedValue({ ok: true, value: catalog(undefined, target, newerRef) });
    view.rerender(<Harness expectedTarget={newerRef} />);
    await act(async () => pending.reject(new Error("Stale preparation error")));
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue task" })).toBeEnabled());
    expect(screen.queryByText("Stale preparation error")).not.toBeInTheDocument();
    expect(api.executeExecutionPlan).not.toHaveBeenCalled();
  });

  it("preserves direct .NET prepare and execute with the native assembly token", async () => {
    const windowsTarget = { ...target, os: "windows" }; const api = installApi(catalog([capability("execution.process", { platforms: ["windows"] }), capability("execution.assembly", { platforms: ["windows"] })], windowsTarget));
    const queued = vi.fn(); const user = userEvent.setup();
    api.prepareExecutionAction.mockResolvedValue({ ok: true, value: plan("execution.assembly", { target: { backend, target: windowsTarget, fingerprint: targetRef.fingerprint } }) });
    api.executeExecutionPlan.mockResolvedValue({ ok: true, value: { requestId: "assembly-1", taskId: "assembly-task", operationId: "execution.assembly", state: "submitted", message: "Queued." } });
    render(<Harness onQueuedTask={queued} />);
    await user.click(await screen.findByRole("tab", { name: ".NET" }));
    await user.click(await screen.findByRole("button", { name: "Open assembly file" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue task" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Queue task" }));
    await waitFor(() => expect(queued).toHaveBeenCalledWith("assembly-task"));
    expect(api.prepareExecutionAction).toHaveBeenCalledWith(expect.objectContaining({ assemblySource: { kind: "file", token: "assembly-file" }, draft: expect.objectContaining({ operationId: "execution.assembly" }) }));
    expect(api.listDotNetExecutionHistory).not.toHaveBeenCalled();
    expect(api.onDotNetExecutionHistoryChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("queues a supported BOF with the external button and excludes other architectures", async () => {
    const api = installApi(); const user = userEvent.setup(); const queued = vi.fn();
    api.listInstalledBofs.mockResolvedValue({ ok: true, value: { target: targetRef, warnings: [], commands: [
      { id: "linux/info", packageName: "Linux info", commandName: "linux-info", description: "Host info", platformSupported: true, available: true, arguments: [] },
      { id: "windows/info", packageName: "Windows info", commandName: "windows-info", description: "Other OS", platformSupported: false, available: false, arguments: [] },
    ] } });
    api.runBof.mockResolvedValue({ ok: true, value: { id: "bof-run", taskId: "bof-task", startedAt: "2026-09-26T20:00:00.000Z", commandId: "linux/info", commandName: "linux-info", state: "submitted" } });
    render(<Harness onQueuedTask={queued} />);
    await user.click(await screen.findByRole("tab", { name: "BOFs" }));
    const composer = await screen.findByRole("region", { name: "Execute an Armory BOF" });
    const trigger = composer.querySelector<HTMLElement>('[data-slot="autocomplete-trigger"]');
    await user.click(trigger!);
    await screen.findByRole("searchbox", { name: "Search BOFs" });
    expect(screen.queryByRole("option", { name: /windows-info/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: /linux-info/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue task" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Queue task" }));
    await waitFor(() => expect(queued).toHaveBeenCalledWith("bof-task"));
    expect(api.runBof).toHaveBeenCalledWith({ commandId: "linux/info", arguments: [], timeoutSeconds: 60 });
    expect(api.prepareExecutionAction).not.toHaveBeenCalled();
    expect(api.listBofExecutionHistory).not.toHaveBeenCalled();
    expect(api.onBofExecutionHistoryChanged).not.toHaveBeenCalled();
  });
});
