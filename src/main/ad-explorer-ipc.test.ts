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
  return { sender: { id: 12, mainFrame: frame, getURL: () => url, isDestroyed: () => false }, senderFrame: frame } as unknown as IpcMainInvokeEvent;
}

function services(): AdExplorerIpcServices {
  return {
    registry: {
      listAdCollectors: vi.fn(async () => ({ ok: true as const, value: { target, collectors: [] } })),
      runAdCollector: vi.fn(async () => ({ ok: true as const, value: {
        path: "/private/client/gui/ad-explorer/collections/example.local/collection.zip",
        domain: "example.local", collectorId: "sharphound:verified:file", targetId: "session-1",
      } })),
    } as unknown as AdExplorerIpcServices["registry"],
    listCollections: vi.fn(async () => [{ id: projectId, name: "example.local", createdAt: "2026-10-23T10:00:00.000Z" }]),
    importCollectedData: vi.fn(async () => ({ projectId })),
    openBeagleWindow: vi.fn(async () => undefined),
  };
}

function invoke(channel: string, fixture: IpcMainInvokeEvent, ...args: unknown[]): unknown {
  return mocks.handlers.get(channel)!(fixture, ...args);
}

beforeEach(() => { vi.resetAllMocks(); mocks.handlers.clear(); mocks.fromWebContents.mockReturnValue(window); });

describe("AD Explorer IPC", () => {
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
    }, "/operator/SharpHound.exe");
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
    }, undefined);
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
    }), "/operator/Invoke-BloodHound.ps1");
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
      expect.objectContaining({ collectorId: "sharphound:verified:script" }), "/operator/SharpHound.ps1");
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
