// @vitest-environment node
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC } from "../shared/contracts.js";
import { RUSTHOUND_ARMORY_COLLECTOR_ID } from "../shared/ad-explorer-contracts.js";
import { BeaglePostCommitError } from "./beagle-service.js";
import { registerAdExplorerIpcHandlers, unregisterAdExplorerIpcHandlers, type AdExplorerIpcServices } from "./ad-explorer-ipc.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  fromWebContents: vi.fn(), open: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  dialog: { showOpenDialog: mocks.open },
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => mocks.handlers.set(name, handler),
    removeHandler: (name: string) => mocks.handlers.delete(name),
  },
}));

const url = "sliver://app/index.html?surface=workspace";
const window = { isDestroyed: () => false } as BrowserWindow;
const target = { mode: "session", id: "session-1", backendEpoch: 1, domainRevision: 2, fingerprint: "a".repeat(64) };
const input = { target, collectorId: "sharphound:verified:file", domain: "EXAMPLE.LOCAL", collectionMethod: "Default" };
const projectId = "11111111-1111-4111-8111-111111111111";

function event(): IpcMainInvokeEvent {
  const frame = { processId: 123, frameToken: "workspace-main", url, isDestroyed: () => false };
  return { sender: { id: 12, mainFrame: frame, getURL: () => url, isDestroyed: () => false, send: vi.fn(), once: vi.fn() }, senderFrame: frame } as unknown as IpcMainInvokeEvent;
}

function services(): AdExplorerIpcServices {
  return {
    registry: {
      listAdCollectors: vi.fn(async () => ({ ok: true as const, value: { target, collectors: [] } })),
      getAdTargetDomain: vi.fn(async () => ({ ok: true as const, value: {
        domain: " Corp.Example.COM ", secret: "must-not-cross-ipc",
      } })),
      runAdCollector: vi.fn(async () => ({ ok: true as const, value: {
        path: "/private/client/gui/ad-explorer/collections/example.local/collection.zip",
        domain: "example.local", collectorId: "sharphound:verified:file", targetId: "session-1",
      } })),
    } as unknown as AdExplorerIpcServices["registry"],
    artifacts: {
      remember: vi.fn(async (value) => ({ collectionId: projectId, domain: value.domain, collectorId: value.collectorId, targetId: value.targetId, createdAt: "2026-10-24T00:00:00Z" })),
      list: vi.fn(async () => []),
      resolve: vi.fn(async () => ({ collectionId: projectId, domain: "example.local", collectorId: "sharphound:verified:file", targetId: "session-1", createdAt: "2026-10-24T00:00:00Z", path: "/private/client/gui/ad-explorer/collections/example.local/collection.zip" })),
      imported: vi.fn(async () => undefined),
    },
    revealCollectedFile: vi.fn(),
    listCollections: vi.fn(async () => [{ id: projectId, name: "example.local", createdAt: "2026-10-23T10:00:00.000Z" }]),
    importCollectedData: vi.fn(async () => ({ projectId })),
    openBeagleWindow: vi.fn(async () => undefined),
    openAdCollectorArmory: vi.fn(async () => undefined),
  };
}

function invoke(channel: string, fixture: IpcMainInvokeEvent, ...args: unknown[]): unknown {
  return mocks.handlers.get(channel)!(fixture, ...args);
}

beforeEach(() => { vi.resetAllMocks(); mocks.handlers.clear(); mocks.fromWebContents.mockReturnValue(window); });

describe("AD Explorer IPC", () => {
  it("returns only a validated DNS domain for a trusted, exact target reference", async () => {
    const service = services();
    registerAdExplorerIpcHandlers(service, url, () => true);
    await expect(invoke(IPC.getAdTargetDomain, event(), target)).resolves.toEqual({
      ok: true, value: { domain: "corp.example.com" },
    });
    expect(service.registry.getAdTargetDomain).toHaveBeenCalledExactlyOnceWith(12, target);
    await expect(invoke(IPC.getAdTargetDomain, event(), { ...target, name: "USERDOMAIN" })).resolves.toMatchObject({ ok: false });
    await expect(invoke(IPC.getAdTargetDomain, event(), target, "USERDOMAIN")).resolves.toMatchObject({ ok: false });
    expect(service.registry.getAdTargetDomain).toHaveBeenCalledOnce();
  });

  it("does not expose a missing domain or read from an untrusted renderer", async () => {
    const service = services();
    const authorize = vi.fn().mockReturnValue(true);
    registerAdExplorerIpcHandlers(service, url, authorize);
    vi.mocked(service.registry.getAdTargetDomain).mockResolvedValueOnce({ ok: true, value: {} });
    await expect(invoke(IPC.getAdTargetDomain, event(), target)).resolves.toEqual({ ok: true, value: {} });
    authorize.mockReturnValue(false);
    await expect(invoke(IPC.getAdTargetDomain, event(), target)).resolves.toMatchObject({ ok: false });
    expect(service.registry.getAdTargetDomain).toHaveBeenCalledOnce();
  });

  it("rejects a non-DNS result and drops a result when workspace trust changes", async () => {
    const service = services();
    const authorize = vi.fn().mockReturnValue(true);
    registerAdExplorerIpcHandlers(service, url, authorize);
    vi.mocked(service.registry.getAdTargetDomain).mockResolvedValueOnce({ ok: true, value: { domain: "CORP" } });
    await expect(invoke(IPC.getAdTargetDomain, event(), target)).resolves.toMatchObject({ ok: false });
    authorize.mockReturnValueOnce(true).mockReturnValue(false);
    await expect(invoke(IPC.getAdTargetDomain, event(), target)).resolves.toMatchObject({ ok: false });
    expect(service.registry.getAdTargetDomain).toHaveBeenCalledTimes(2);
  });

  it("lists local collections only for a trusted workspace and rechecks trust after loading", async () => {
    const service = services();
    const authorize = vi.fn().mockReturnValue(true);
    registerAdExplorerIpcHandlers(service, url, authorize);
    await expect(invoke(IPC.listAdCollections, event())).resolves.toMatchObject({ ok: true, value: [{ id: projectId, name: "example.local" }] });
    await expect(invoke(IPC.listAdCollections, event(), { path: "/tmp/projects" })).resolves.toMatchObject({ ok: false });
    expect(service.listCollections).toHaveBeenCalledOnce();
    vi.mocked(service.listCollections).mockImplementation(async () => { authorize.mockReturnValue(false); return []; });
    await expect(invoke(IPC.listAdCollections, event())).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Untrusted") });
    await expect(invoke(IPC.listAdCollections, event())).resolves.toMatchObject({ ok: false });
    expect(service.listCollections).toHaveBeenCalledTimes(2);
  });

  it("opens a validated collection or the default explorer without allowing paths", async () => {
    const service = services();
    registerAdExplorerIpcHandlers(service, url, () => true);
    await expect(invoke(IPC.openBeagleWindow, event())).resolves.toEqual({ ok: true });
    expect(service.openBeagleWindow).toHaveBeenLastCalledWith(undefined);
    await expect(invoke(IPC.openBeagleWindow, event(), { projectId })).resolves.toEqual({ ok: true });
    expect(service.openBeagleWindow).toHaveBeenLastCalledWith({ projectId });
    for (const args of [[{ projectId: "../../database" }], [{ projectId, path: "/tmp/database" }], [{ projectId }, {}]]) {
      await expect(invoke(IPC.openBeagleWindow, event(), ...args)).resolves.toMatchObject({ ok: false });
    }
    expect(service.openBeagleWindow).toHaveBeenCalledTimes(2);
  });

  it("opens the Armory install tab only from a trusted workspace with no arguments", async () => {
    const service = services();
    const authorize = vi.fn().mockReturnValue(true);
    registerAdExplorerIpcHandlers(service, url, authorize);
    await expect(invoke(IPC.openAdCollectorArmory, event())).resolves.toEqual({ ok: true });
    expect(service.openAdCollectorArmory).toHaveBeenCalledOnce();
    await expect(invoke(IPC.openAdCollectorArmory, event(), "sources")).resolves.toMatchObject({ ok: false });
    expect(service.openAdCollectorArmory).toHaveBeenCalledOnce();
    authorize.mockReturnValue(false);
    await expect(invoke(IPC.openAdCollectorArmory, event())).resolves.toMatchObject({ ok: false });
    expect(service.openAdCollectorArmory).toHaveBeenCalledOnce();
  });

  it("authorizes the exact workspace main frame before reading requests", async () => {
    const service = services();
    const authorize = vi.fn().mockReturnValue(false);
    registerAdExplorerIpcHandlers(service, url, authorize);
    const getter = vi.fn();
    const request = Object.defineProperty({}, "target", { enumerable: true, get: getter });
    await expect(invoke(IPC.runAdCollector, event(), request)).resolves.toMatchObject({ ok: false });
    expect(getter).not.toHaveBeenCalled();
    authorize.mockReturnValue(true);
    const fixture = event();
    const childFrame = { ...fixture.senderFrame, frameToken: "child" };
    await expect(invoke(IPC.listAdCollectors, { ...fixture, senderFrame: childFrame } as IpcMainInvokeEvent, target))
      .resolves.toMatchObject({ ok: false });
    expect(service.registry.listAdCollectors).not.toHaveBeenCalled();
    unregisterAdExplorerIpcHandlers();
    expect(mocks.handlers.size).toBe(0);
  });

  it("takes a native collector path only from the picker and keeps saved paths out of renderer results", async () => {
    const service = services();
    registerAdExplorerIpcHandlers(service, url, () => true);
    mocks.open.mockResolvedValue({ canceled: false, filePaths: ["/operator/SharpHound.exe"] });
    await expect(invoke(IPC.runAdCollector, event(), { ...input, path: "/injected.exe" })).resolves.toMatchObject({ ok: false });
    const result = await invoke(IPC.runAdCollector, event(), input);
    expect(result).toMatchObject({ ok: true, value: { state: "imported", projectId, domain: "example.local" } });
    expect(JSON.stringify(result)).not.toContain("/private/client");
    expect(service.registry.runAdCollector).toHaveBeenCalledExactlyOnceWith(12, {
      ...input, domain: "example.local",
    }, "/operator/SharpHound.exe", expect.any(Object));
    expect(service.importCollectedData).toHaveBeenCalledExactlyOnceWith({
      domain: "example.local", path: "/private/client/gui/ad-explorer/collections/example.local/collection.zip",
    });
    expect(service.openBeagleWindow).toHaveBeenCalledExactlyOnceWith({ projectId });
  });

  it("uses the installed RustHound extension without a file picker or credential echo", async () => {
    const service = services();
    registerAdExplorerIpcHandlers(service, url, () => true);
    const request = { ...input, collectorId: RUSTHOUND_ARMORY_COLLECTOR_ID,
      collectionMethod: "LdapOnly", credentials: { username: "alice@example.local", password: "one-use-secret" } };
    const result = await invoke(IPC.runAdCollector, event(), request);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(service.registry.runAdCollector).toHaveBeenCalledWith(12, {
      ...request, domain: "example.local",
    }, undefined, expect.any(Object));
    expect(result).toMatchObject({ ok: true, value: { state: "imported", message: expect.stringContaining("RustHound") } });
    expect(JSON.stringify(result)).not.toContain("one-use-secret");
  });

  it("reports a completed import accurately when the Beagle window fails to open", async () => {
    const service = services();
    vi.mocked(service.openBeagleWindow).mockRejectedValue(new Error("window load failed"));
    registerAdExplorerIpcHandlers(service, url, () => true);
    mocks.open.mockResolvedValue({ canceled: false, filePaths: ["/operator/SharpHound.exe"] });
    await expect(invoke(IPC.runAdCollector, event(), input)).resolves.toMatchObject({
      ok: true, value: { state: "imported", message: expect.stringContaining("window could not be opened") },
    });
    expect(service.importCollectedData).toHaveBeenCalledOnce();
  });

  it("uses a native script picker and reports a rejected collector schema without exposing paths", async () => {
    const service = services();
    vi.mocked(service.importCollectedData).mockRejectedValue(new Error("unsupported SharpHound version 4 in /private/client/collection.zip"));
    registerAdExplorerIpcHandlers(service, url, () => true);
    mocks.open.mockResolvedValue({ canceled: false, filePaths: ["/operator/Invoke-BloodHound.ps1"] });
    const result = await invoke(IPC.runAdCollector, event(), { ...input, collectorId: "sharphound:custom:script" });
    expect(mocks.open).toHaveBeenCalledWith(window, expect.objectContaining({ filters: [{
      name: "Invoke-BloodHound script", extensions: ["ps1"],
    }] }));
    expect(service.registry.runAdCollector).toHaveBeenCalledWith(12, expect.objectContaining({
      collectorId: "sharphound:custom:script",
    }), "/operator/Invoke-BloodHound.ps1", expect.any(Object));
    expect(result).toMatchObject({ ok: true, value: {
      state: "saved", message: expect.stringContaining("schema 4"),
    } });
    expect(JSON.stringify(result)).not.toContain("/private/client");
    expect(service.openBeagleWindow).not.toHaveBeenCalled();
  });

  it("offers the verified PowerShell script through the pinned native picker", async () => {
    const service = services();
    registerAdExplorerIpcHandlers(service, url, () => true);
    mocks.open.mockResolvedValue({ canceled: false, filePaths: ["/operator/SharpHound.ps1"] });
    await expect(invoke(IPC.runAdCollector, event(), { ...input, collectorId: "sharphound:verified:script" }))
      .resolves.toMatchObject({ ok: true, value: { state: "imported" } });
    expect(mocks.open).toHaveBeenCalledWith(window, expect.objectContaining({
      title: "Choose verified SharpHound CE 2.17.1 PowerShell script",
      filters: [{ name: "Invoke-BloodHound script", extensions: ["ps1"] }],
    }));
    expect(service.registry.runAdCollector).toHaveBeenCalledWith(12,
      expect.objectContaining({ collectorId: "sharphound:verified:script" }), "/operator/SharpHound.ps1", expect.any(Object));
  });

  it("reports a committed graph when Beagle metadata saving fails", async () => {
    const service = services();
    vi.mocked(service.importCollectedData).mockRejectedValue(new BeaglePostCommitError("private metadata path", projectId));
    registerAdExplorerIpcHandlers(service, url, () => true);
    mocks.open.mockResolvedValue({ canceled: false, filePaths: ["/operator/SharpHound.exe"] });
    const result = await invoke(IPC.runAdCollector, event(), input);
    expect(result).toMatchObject({ ok: true, value: {
      state: "imported", projectId, message: expect.stringContaining("Graph data was imported"),
    } });
    expect(JSON.stringify(result)).not.toContain("private metadata path");
    expect(service.openBeagleWindow).toHaveBeenCalledExactlyOnceWith({ projectId });
  });

  it("stops after a native dialog when workspace authorization is lost", async () => {
    const service = services();
    const authorize = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    registerAdExplorerIpcHandlers(service, url, authorize);
    mocks.open.mockResolvedValue({ canceled: false, filePaths: ["/operator/SharpHound.exe"] });
    await expect(invoke(IPC.runAdCollector, event(), input)).resolves.toMatchObject({ ok: false });
    expect(service.registry.runAdCollector).not.toHaveBeenCalled();
  });
});

it("publishes collector phases, restores the active job, and only cancels the owning run", async () => {
  const service = services();
  vi.mocked(service.registry.runAdCollector).mockImplementation(async (_owner, _input, _file, controls) => {
    controls?.onProgress?.({ phase: "collecting", transferredBytes: 0 });
    await new Promise<void>((resolve) => controls?.signal?.addEventListener("abort", () => { controls.onCancelled?.(); resolve(); }, { once: true }));
    return { ok: false, error: "AD collection was cancelled." };
  });
  registerAdExplorerIpcHandlers(service, url, () => true);
  const owner = event();
  const pending = invoke(IPC.runAdCollector, owner, { target, collectorId: RUSTHOUND_ARMORY_COLLECTOR_ID, collectionMethod: "LdapOnly" });
  const snapshot = await invoke(IPC.getAdCollectorProgress, owner) as { ok: boolean; value: { runId: string; phase: string } };
  expect(snapshot.value.phase).toBe("collecting");
  const stranger = event(); Object.assign(stranger.sender, { id: 13 });
  expect(await invoke(IPC.cancelAdCollector, stranger, { runId: snapshot.value.runId })).toMatchObject({ ok: false });
  expect(await invoke(IPC.cancelAdCollector, owner, { runId: snapshot.value.runId })).toEqual({ ok: true });
  expect(await pending).toMatchObject({ ok: true, value: { state: "cancelled", domain: "" } });
  expect(service.importCollectedData).not.toHaveBeenCalled();
  expect(await invoke(IPC.getAdCollectorProgress, event())).toMatchObject({ ok: true, value: { phase: "cancelled", cancellable: false } });
});

it("keeps unacknowledged target cancellation as an actionable failure", async () => {
  const service = services();
  vi.mocked(service.registry.runAdCollector).mockImplementation(async (_owner, _input, _file, controls) => {
    await new Promise<void>((resolve) => controls?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    return { ok: false, error: "RustHound cancellation was requested, but target cleanup could not be confirmed." };
  });
  registerAdExplorerIpcHandlers(service, url, () => true);
  const owner = event();
  const pending = invoke(IPC.runAdCollector, owner, { target, collectorId: RUSTHOUND_ARMORY_COLLECTOR_ID, collectionMethod: "LdapOnly" });
  const snapshot = await invoke(IPC.getAdCollectorProgress, owner) as { value: { runId: string } };
  await invoke(IPC.cancelAdCollector, owner, { runId: snapshot.value.runId });
  expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining("could not be confirmed") });
  expect(await invoke(IPC.getAdCollectorProgress, owner)).toMatchObject({ ok: true, value: { phase: "failed" } });
});

it("retries a saved artifact without rerunning the collector and only reveals main-owned paths", async () => {
  const service = services();
  registerAdExplorerIpcHandlers(service, url, () => true);
  expect(await invoke(IPC.retryAdCollectionImport, event(), { collectionId: projectId })).toMatchObject({ ok: true, value: { state: "imported", projectId } });
  expect(service.registry.runAdCollector).not.toHaveBeenCalled();
  expect(service.artifacts.imported).toHaveBeenCalledExactlyOnceWith(projectId);
  expect(await invoke(IPC.revealAdCollection, event(), { collectionId: projectId })).toEqual({ ok: true });
  expect(service.revealCollectedFile).toHaveBeenCalledWith("/private/client/gui/ad-explorer/collections/example.local/collection.zip");
  expect(await invoke(IPC.revealAdCollection, event(), { collectionId: projectId, path: "/private/secret" })).toMatchObject({ ok: false });
  expect(service.revealCollectedFile).toHaveBeenCalledOnce();
});

it("retains a saved recovery handle when import fails and removes it only after a successful retry", async () => {
  const service = services();
  vi.mocked(service.importCollectedData).mockRejectedValueOnce(new Error("unsupported SharpHound version 4"));
  registerAdExplorerIpcHandlers(service, url, () => true);
  const request = { target, collectorId: RUSTHOUND_ARMORY_COLLECTOR_ID, collectionMethod: "LdapOnly" };
  expect(await invoke(IPC.runAdCollector, event(), request)).toMatchObject({ ok: true, value: { state: "saved", collectionId: projectId } });
  expect(service.artifacts.imported).not.toHaveBeenCalled();
  expect(await invoke(IPC.retryAdCollectionImport, event(), { collectionId: projectId })).toMatchObject({ ok: true, value: { state: "imported" } });
  expect(service.artifacts.imported).toHaveBeenCalledOnce();
  expect(service.registry.runAdCollector).toHaveBeenCalledOnce();
});

it("admits only one retry while an artifact is still being resolved", async () => {
  const service = services();
  let release!: () => void;
  const resolve = service.artifacts.resolve;
  vi.mocked(service.artifacts.resolve).mockImplementationOnce(async (id) => {
    await new Promise<void>((done) => { release = done; });
    return resolve(id);
  });
  registerAdExplorerIpcHandlers(service, url, () => true);
  const pending = invoke(IPC.retryAdCollectionImport, event(), { collectionId: projectId });
  const other = event(); Object.assign(other.sender, { id: 13 });
  expect(await invoke(IPC.retryAdCollectionImport, other, { collectionId: projectId })).toMatchObject({ ok: false, error: expect.stringContaining("already being imported") });
  release();
  expect(await pending).toMatchObject({ ok: true, value: { state: "imported" } });
  expect(service.importCollectedData).toHaveBeenCalledOnce();
});

it("finishes an in-flight import before closing without opening another graph window", async () => {
  const service = services();
  let release!: () => void;
  vi.mocked(service.importCollectedData).mockImplementationOnce(async () => {
    await new Promise<void>((done) => { release = done; });
    return { projectId };
  });
  const lifecycle = registerAdExplorerIpcHandlers(service, url, () => true);
  const request = { target, collectorId: RUSTHOUND_ARMORY_COLLECTOR_ID, collectionMethod: "LdapOnly" };
  const pending = invoke(IPC.runAdCollector, event(), request);
  await vi.waitFor(() => expect(service.importCollectedData).toHaveBeenCalledOnce());
  expect(lifecycle.hasActive(12)).toBe(true);
  let closed = false;
  const closing = lifecycle.cancelAndWait(12).then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  expect(await pending).toMatchObject({ ok: true, value: { state: "imported", projectId } });
  await closing;
  expect(lifecycle.hasActive(12)).toBe(false);
  expect(service.artifacts.imported).toHaveBeenCalledOnce();
  expect(service.openBeagleWindow).not.toHaveBeenCalled();
});

it("imports after a trusted replacement document reattaches to the running collection", async () => {
  const service = services();
  const original = event();
  let release!: () => void;
  const collect = service.registry.runAdCollector;
  vi.mocked(service.registry.runAdCollector).mockImplementationOnce(async (...args) => {
    await new Promise<void>((done) => { release = done; });
    return collect(...args);
  });
  registerAdExplorerIpcHandlers(service, url, () => true);
  const pending = invoke(IPC.runAdCollector, original, { target, collectorId: RUSTHOUND_ARMORY_COLLECTOR_ID, collectionMethod: "LdapOnly" });
  Object.assign(original.senderFrame!, { isDestroyed: () => true });
  expect(await invoke(IPC.getAdCollectorProgress, event())).toMatchObject({ ok: true, value: { phase: "preparing" } });
  release();
  expect(await pending).toMatchObject({ ok: true, value: { state: "imported" } });
  expect(service.openBeagleWindow).toHaveBeenCalledOnce();
});
