// @vitest-environment node

import type { BrowserWindow, IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";
import { ARMORY_IPC_INVOKE, type ArmorySnapshot } from "../shared/armory-contracts.js";
import { registerArmoryIpcHandlers, unregisterArmoryIpcHandlers, type ArmoryIpcServices } from "./armory-ipc.js";
import type { TrustedWindowIdentity } from "./ipc.js";

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  fromWebContents: vi.fn(),
  showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  dialog: { showOpenDialog: electronMocks.showOpenDialog },
  ipcMain: { handle: electronMocks.handle, removeHandler: electronMocks.removeHandler },
}));

const RENDERER_URL = "sliver://app/index.html?surface=armory";
const SNAPSHOT: ArmorySnapshot = {
  rootPath: "/operator/.sliver-client", sources: [], installed: [], packages: [], bundles: [],
  refreshedAt: null, warnings: [],
};
const currentWindow = { isDestroyed: vi.fn(() => false) } as unknown as BrowserWindow;
const IDENTITY: TrustedWindowIdentity = { contentsId: 77, rendererProcessId: 100, rendererFrameToken: "main-frame" };

beforeEach(() => {
  vi.resetAllMocks();
  electronMocks.handlers.clear();
  electronMocks.handle.mockImplementation((channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    electronMocks.handlers.set(channel, handler);
  });
  electronMocks.removeHandler.mockImplementation((channel: string) => electronMocks.handlers.delete(channel));
  electronMocks.fromWebContents.mockReturnValue(currentWindow);
  vi.mocked(currentWindow.isDestroyed).mockReturnValue(false);
});

afterEach(() => unregisterArmoryIpcHandlers());

describe("Armory IPC boundary", () => {
  it("registers and removes only dedicated local package-management handlers", () => {
    registerArmoryIpcHandlers(servicesMock(), RENDERER_URL, authorizeCurrentWindow);
    expect([...electronMocks.handlers.keys()].sort()).toEqual(Object.values(ARMORY_IPC_INVOKE).sort());
    unregisterArmoryIpcHandlers();
    expect(electronMocks.handlers.size).toBe(0);
    expect(electronMocks.removeHandler.mock.calls.map(([channel]) => channel).sort())
      .toEqual(Object.values(ARMORY_IPC_INVOKE).sort());
  });

  it("authorizes the exact window and main-frame identity before dispatching validated requests", async () => {
    const services = servicesMock();
    const authorize = vi.fn(authorizeCurrentWindow);
    registerArmoryIpcHandlers(services, RENDERER_URL, authorize);
    const { event } = invokeEvent();
    const requests = [
      [ARMORY_IPC_INVOKE.refreshCatalog, []],
      [ARMORY_IPC_INVOKE.install, [{ packageId: "package", replace: false }]],
      [ARMORY_IPC_INVOKE.installBundle, [{ bundleId: "bundle", replace: true }]],
      [ARMORY_IPC_INVOKE.uninstall, [{ installedId: "installed" }]],
      [ARMORY_IPC_INVOKE.saveSource, [{ name: "Example", repoUrl: "https://example.test/index", publicKey: "key", enabled: true }]],
      [ARMORY_IPC_INVOKE.removeSource, [{ sourceId: "source" }]],
    ] as const;
    await expect(invoke(ARMORY_IPC_INVOKE.getContext, event)).resolves.toEqual({ ok: true, value: { tab: "manage" } });
    await expect(invoke(ARMORY_IPC_INVOKE.snapshot, event)).resolves.toEqual({ ok: true, value: SNAPSHOT });
    await expect(invoke(ARMORY_IPC_INVOKE.getApplicationSettings, event)).resolves.toBe(DEFAULT_APPLICATION_SETTINGS_STATE);
    for (const [channel, args] of requests) await expect(invoke(channel, event, ...args)).resolves.toEqual({ ok: true, value: SNAPSHOT });
    expect(services.manager.install).toHaveBeenCalledExactlyOnceWith({ packageId: "package", replace: false });
    expect(services.manager.installBundle).toHaveBeenCalledExactlyOnceWith({ bundleId: "bundle", replace: true });
    expect(services.manager.uninstall).toHaveBeenCalledExactlyOnceWith({ installedId: "installed" });
    expect(services.manager.saveSource).toHaveBeenCalledExactlyOnceWith(requests[4][1][0]);
    expect(services.manager.removeSource).toHaveBeenCalledExactlyOnceWith({ sourceId: "source" });
    expect(services.changed).toHaveBeenCalledTimes(6);
    expect(authorize).toHaveBeenCalledWith(IDENTITY, currentWindow);
  });

  it.each([
    ["workspace", "sliver://app/index.html"],
    ["another surface", "sliver://app/index.html?surface=network"],
    ["origin impostor", "sliver://app.evil.test/index.html?surface=armory"],
    ["surface suffix", "sliver://app/index.html?surface=armory-extra"],
    ["extra query", "sliver://app/index.html?surface=armory&admin=true"],
    ["untrusted website", "https://example.test/index.html?surface=armory"],
  ])("rejects %s documents in both sender and frame URLs", async (_label, url) => {
    const services = servicesMock();
    registerArmoryIpcHandlers(services, RENDERER_URL, authorizeCurrentWindow);
    for (const which of ["sender", "frame"] as const) {
      const fixture = invokeEvent();
      if (which === "sender") fixture.sender.getURL = () => url;
      else fixture.mainFrame.url = url;
      await expect(invoke(ARMORY_IPC_INVOKE.install, fixture.event, { packageId: "package" }))
        .resolves.toEqual({ ok: false, error: "Untrusted Armory renderer" });
    }
    expect(services.manager.install).not.toHaveBeenCalled();
    expect(services.changed).not.toHaveBeenCalled();
  });

  it("rejects child/stale frames, missing/destroyed surfaces, and revoked identities", async () => {
    const services = servicesMock();
    const authorize = vi.fn(authorizeCurrentWindow);
    registerArmoryIpcHandlers(services, RENDERER_URL, authorize);
    const reject = async (event: IpcMainInvokeEvent): Promise<void> => {
      await expect(invoke(ARMORY_IPC_INVOKE.snapshot, event)).resolves.toMatchObject({ ok: false });
    };
    const child = invokeEvent();
    Object.defineProperty(child.event, "senderFrame", { value: { ...child.mainFrame, frameToken: "child-frame" } });
    await reject(child.event);
    const oldProcess = invokeEvent();
    Object.defineProperty(oldProcess.event, "senderFrame", { value: { ...oldProcess.mainFrame, processId: 101 } });
    await reject(oldProcess.event);
    const missingFrame = invokeEvent();
    Object.defineProperty(missingFrame.event, "senderFrame", { value: null });
    await reject(missingFrame.event);
    const deadFrame = invokeEvent();
    deadFrame.mainFrame.isDestroyed = () => true;
    await reject(deadFrame.event);
    const deadContents = invokeEvent();
    deadContents.sender.isDestroyed = () => true;
    await reject(deadContents.event);
    vi.mocked(currentWindow.isDestroyed).mockReturnValueOnce(true);
    await reject(invokeEvent().event);
    electronMocks.fromWebContents.mockReturnValueOnce(null);
    await reject(invokeEvent().event);
    electronMocks.fromWebContents.mockReturnValueOnce({ isDestroyed: () => false });
    await reject(invokeEvent().event);
    authorize.mockReturnValueOnce(false);
    await reject(invokeEvent().event);
    expect(services.manager.snapshot).not.toHaveBeenCalled();
  });

  it("rejects malformed counts, unknown fields, filesystem paths and execution requests before dispatch", async () => {
    const services = servicesMock();
    registerArmoryIpcHandlers(services, RENDERER_URL, authorizeCurrentWindow);
    const { event } = invokeEvent();
    const malformed: ReadonlyArray<readonly [string, readonly unknown[]]> = [
      [ARMORY_IPC_INVOKE.getContext, [null]], [ARMORY_IPC_INVOKE.snapshot, [{}]],
      [ARMORY_IPC_INVOKE.refreshCatalog, [{ ignoreSignatures: true }]],
      [ARMORY_IPC_INVOKE.install, []], [ARMORY_IPC_INVOKE.install, [{ packageId: "package" }, "extra"]],
      [ARMORY_IPC_INVOKE.install, [{ packageId: "package", sessionId: "session" }]],
      [ARMORY_IPC_INVOKE.installBundle, [{ bundleId: "bundle", replace: "true" }]],
      [ARMORY_IPC_INVOKE.uninstall, [{ installedId: "installed", installPath: "/tmp/arbitrary" }]],
      [ARMORY_IPC_INVOKE.saveSource, [{ name: "source", repoUrl: "https://example.test", publicKey: "key", enabled: true, authorization_cmd: "arbitrary-command" }]],
      [ARMORY_IPC_INVOKE.removeSource, [{ sourceId: "source", configPath: "/tmp/arbitrary" }]],
      [ARMORY_IPC_INVOKE.installLocal, [{ publicKey: "key", archivePath: "/tmp/arbitrary.tar.gz" }]],
      [ARMORY_IPC_INVOKE.installLocal, [{ publicKey: "key", signaturePath: "/tmp/arbitrary.minisig" }]],
      [ARMORY_IPC_INVOKE.installLocal, [{ publicKey: "key", execute: true }]],
    ];
    for (const [channel, args] of malformed) await expect(invoke(channel, event, ...args)).resolves.toMatchObject({ ok: false });
    for (const method of Object.values(services.manager)) expect(method).not.toHaveBeenCalled();
    expect(electronMocks.showOpenDialog).not.toHaveBeenCalled();
    expect(services.changed).not.toHaveBeenCalled();
  });

  it("returns default settings for rejected reads without revealing service state", async () => {
    const services = servicesMock();
    registerArmoryIpcHandlers(services, RENDERER_URL, authorizeCurrentWindow);
    const invalid = invokeEvent();
    invalid.sender.getURL = () => "sliver://app/index.html";
    await expect(invoke(ARMORY_IPC_INVOKE.getApplicationSettings, invalid.event)).resolves.toBe(DEFAULT_APPLICATION_SETTINGS_STATE);
    await expect(invoke(ARMORY_IPC_INVOKE.getApplicationSettings, invokeEvent().event, {})).resolves.toBe(DEFAULT_APPLICATION_SETTINGS_STATE);
    expect(services.getApplicationSettings).not.toHaveBeenCalled();
  });

  it("uses main-owned native dialog selections and reauthorizes before local installation", async () => {
    const services = servicesMock();
    const authorize = vi.fn(authorizeCurrentWindow);
    registerArmoryIpcHandlers(services, RENDERER_URL, authorize);
    electronMocks.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: ["/chosen/package.tar.gz"] })
      .mockResolvedValueOnce({ canceled: false, filePaths: ["/chosen/package.minisig"] });
    await expect(invoke(ARMORY_IPC_INVOKE.installLocal, invokeEvent().event, { publicKey: "key", replace: true }))
      .resolves.toEqual({ ok: true, value: SNAPSHOT });
    expect(electronMocks.showOpenDialog).toHaveBeenNthCalledWith(1, currentWindow, expect.objectContaining({ properties: ["openFile"] }));
    expect(electronMocks.showOpenDialog).toHaveBeenNthCalledWith(2, currentWindow, expect.objectContaining({ filters: [{ name: "Minisign Signature", extensions: ["minisig"] }] }));
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(services.manager.installLocal).toHaveBeenCalledExactlyOnceWith({
      publicKey: "key", replace: true, archivePath: "/chosen/package.tar.gz", signaturePath: "/chosen/package.minisig",
    });
    expect(services.changed).toHaveBeenCalledOnce();
  });

  it.each(["archive", "signature"] as const)("does not write when the frame changes during the %s dialog", async (phase) => {
    const services = servicesMock();
    registerArmoryIpcHandlers(services, RENDERER_URL, authorizeCurrentWindow);
    const fixture = invokeEvent();
    if (phase === "signature") electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/chosen/package.tar.gz"] });
    electronMocks.showOpenDialog.mockImplementationOnce(async () => {
      fixture.sender.mainFrame = { ...fixture.mainFrame, frameToken: "replacement-frame" } as WebFrameMain;
      return { canceled: false, filePaths: ["/chosen/file"] };
    });
    await expect(invoke(ARMORY_IPC_INVOKE.installLocal, fixture.event, { publicKey: "key" }))
      .resolves.toEqual({ ok: false, error: "Untrusted Armory renderer" });
    expect(services.manager.installLocal).not.toHaveBeenCalled();
    expect(services.changed).not.toHaveBeenCalled();
    expect(electronMocks.showOpenDialog).toHaveBeenCalledTimes(phase === "archive" ? 1 : 2);
  });

  it("does not write after the window lease is revoked while choosing a signature", async () => {
    const services = servicesMock();
    const authorize = vi.fn(authorizeCurrentWindow);
    registerArmoryIpcHandlers(services, RENDERER_URL, authorize);
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/chosen/package.tar.gz"] });
    electronMocks.showOpenDialog.mockImplementationOnce(async () => {
      authorize.mockReturnValue(false);
      return { canceled: false, filePaths: ["/chosen/package.minisig"] };
    });
    await expect(invoke(ARMORY_IPC_INVOKE.installLocal, invokeEvent().event, { publicKey: "key" }))
      .resolves.toEqual({ ok: false, error: "Untrusted Armory renderer" });
    expect(services.manager.installLocal).not.toHaveBeenCalled();
  });

  it.each([
    ["archive", { canceled: true, filePaths: [] }],
    ["archive", { canceled: false, filePaths: [] }],
    ["archive", { canceled: false, filePaths: ["/first", "/second"] }],
    ["signature", { canceled: true, filePaths: [] }],
    ["signature", { canceled: false, filePaths: [] }],
    ["signature", { canceled: false, filePaths: ["/first", "/second"] }],
  ] as const)("cancels invalid %s selections without installation", async (phase, selection) => {
    const services = servicesMock();
    registerArmoryIpcHandlers(services, RENDERER_URL, authorizeCurrentWindow);
    if (phase === "signature") electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/chosen/package.tar.gz"] });
    electronMocks.showOpenDialog.mockResolvedValueOnce(selection);
    const expected = selection.canceled
      ? { ok: true, value: undefined }
      : { ok: false, error: `Choose one Armory ${phase}` };
    await expect(invoke(ARMORY_IPC_INVOKE.installLocal, invokeEvent().event, { publicKey: "key" })).resolves.toEqual(expected);
    expect(services.manager.installLocal).not.toHaveBeenCalled();
    expect(services.changed).not.toHaveBeenCalled();
    await expect(invoke(ARMORY_IPC_INVOKE.install, invokeEvent().event, { packageId: "package" })).resolves.toMatchObject({ ok: true });
  });

  it("serializes mutations while allowing inventory reads and releases ownership after failure", async () => {
    const services = servicesMock();
    const pending = deferred<ArmorySnapshot>();
    services.manager.install.mockImplementationOnce(() => pending.promise);
    registerArmoryIpcHandlers(services, RENDERER_URL, authorizeCurrentWindow);
    const { event } = invokeEvent();
    const first = invoke(ARMORY_IPC_INVOKE.install, event, { packageId: "package" });
    await expect(invoke(ARMORY_IPC_INVOKE.uninstall, event, { installedId: "installed" }))
      .resolves.toEqual({ ok: false, error: "Another Armory operation is in progress" });
    await expect(invoke(ARMORY_IPC_INVOKE.refreshCatalog, event))
      .resolves.toEqual({ ok: false, error: "Another Armory operation is in progress" });
    await expect(invoke(ARMORY_IPC_INVOKE.snapshot, event)).resolves.toMatchObject({ ok: true });
    expect(services.manager.uninstall).not.toHaveBeenCalled();
    pending.reject(new Error("The package signature is invalid"));
    await expect(first).resolves.toEqual({ ok: false, error: "The package signature is invalid" });
    expect(services.changed).not.toHaveBeenCalled();
    await expect(invoke(ARMORY_IPC_INVOKE.uninstall, event, { installedId: "installed" })).resolves.toMatchObject({ ok: true });
    expect(services.manager.uninstall).toHaveBeenCalledOnce();
    expect(services.changed).toHaveBeenCalledOnce();
  });
});

function servicesMock() {
  return {
    manager: {
      snapshot: vi.fn(async () => SNAPSHOT), refreshCatalog: vi.fn(async () => SNAPSHOT),
      install: vi.fn(async (_input: unknown) => SNAPSHOT), installBundle: vi.fn(async (_input: unknown) => SNAPSHOT),
      uninstall: vi.fn(async (_input: unknown) => SNAPSHOT), saveSource: vi.fn(async (_input: unknown) => SNAPSHOT),
      removeSource: vi.fn(async (_input: unknown) => SNAPSHOT), installLocal: vi.fn(async (_input: unknown) => SNAPSHOT),
    },
    getTab: vi.fn(() => "manage" as const),
    getApplicationSettings: vi.fn(() => DEFAULT_APPLICATION_SETTINGS_STATE),
    changed: vi.fn(),
  } satisfies ArmoryIpcServices;
}

function authorizeCurrentWindow(identity: TrustedWindowIdentity, window: BrowserWindow): boolean {
  return window === currentWindow && identity.contentsId === IDENTITY.contentsId &&
    identity.rendererProcessId === IDENTITY.rendererProcessId && identity.rendererFrameToken === IDENTITY.rendererFrameToken;
}

function invokeEvent() {
  const mainFrame = { processId: 100, frameToken: "main-frame", url: RENDERER_URL, isDestroyed: () => false };
  const sender = { id: 77, mainFrame: mainFrame as WebFrameMain, getURL: () => RENDERER_URL, isDestroyed: () => false };
  const event = { sender: sender as WebContents, senderFrame: mainFrame as WebFrameMain } as IpcMainInvokeEvent;
  return { event, sender, mainFrame };
}

async function invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler(event, ...args);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
