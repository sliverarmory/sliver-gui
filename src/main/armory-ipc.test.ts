// @vitest-environment node

import type { BrowserWindow, IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";
import { ARMORY_IPC_EVENTS, ARMORY_IPC_INVOKE, type ArmoryProgress, type ArmorySnapshot } from "../shared/armory-contracts.js";
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
const currentWindow = { isDestroyed: vi.fn(() => false), webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() } } as unknown as BrowserWindow;
const IDENTITY: TrustedWindowIdentity = { contentsId: 77, rendererProcessId: 100, rendererFrameToken: "main-frame" };
const CANONICAL_PUBLIC_KEY = Buffer.concat([Buffer.from("Ed", "ascii"), Buffer.alloc(40, 0x2a)]).toString("base64");
const PROGRESS: ArmoryProgress = { operation: "install", phase: "downloading", packageName: "Package", completedPackages: 0,
  totalPackages: 1, downloadedBytes: 32, currentBytes: 32, currentTotalBytes: null, bytesPerSecond: 128 };

beforeEach(() => {
  vi.resetAllMocks();
  electronMocks.handlers.clear();
  electronMocks.handle.mockImplementation((channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    electronMocks.handlers.set(channel, handler);
  });
  electronMocks.removeHandler.mockImplementation((channel: string) => electronMocks.handlers.delete(channel));
  electronMocks.fromWebContents.mockReturnValue(currentWindow);
  vi.mocked(currentWindow.isDestroyed).mockReturnValue(false);
  vi.mocked(currentWindow.webContents.isDestroyed).mockReturnValue(false);
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
      [ARMORY_IPC_INVOKE.updateAll, []],
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
    expect(services.manager.updateAll).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    expect(services.manager.install).toHaveBeenCalledExactlyOnceWith({ packageId: "package", replace: false }, expect.any(Function));
    expect(services.manager.installBundle).toHaveBeenCalledExactlyOnceWith({ bundleId: "bundle", replace: true }, expect.any(Function));
    expect(services.manager.uninstall).toHaveBeenCalledExactlyOnceWith({ installedId: "installed" });
    expect(services.manager.saveSource).toHaveBeenCalledExactlyOnceWith(requests[5][1][0]);
    expect(services.manager.removeSource).toHaveBeenCalledExactlyOnceWith({ sourceId: "source" });
    expect(services.changed).toHaveBeenCalledTimes(7);
    expect(authorize).toHaveBeenCalledWith(IDENTITY, currentWindow);
  });

  it("sends progress only to the invoking trusted Armory window while its operation is active", async () => {
    const services = servicesMock();
    let notify: ((event: ArmoryProgress) => void) | undefined;
    services.manager.install.mockImplementationOnce(async (_input, progress) => {
      notify = progress;
      progress?.(PROGRESS);
      return SNAPSHOT;
    });
    registerArmoryIpcHandlers(services, RENDERER_URL, authorizeCurrentWindow);
    await expect(invoke(ARMORY_IPC_INVOKE.install, invokeEvent().event, { packageId: "package" }))
      .resolves.toMatchObject({ ok: true });
    expect(currentWindow.webContents.send).toHaveBeenCalledExactlyOnceWith(ARMORY_IPC_EVENTS.progress, PROGRESS);
    notify?.(PROGRESS);
    expect(currentWindow.webContents.send).toHaveBeenCalledTimes(1);
  });

  it("drops progress after trust revocation, navigation, or window closure without failing the download", async () => {
    const services = servicesMock();
    const authorize = vi.fn(authorizeCurrentWindow);
    const pending = deferred<ArmorySnapshot>();
    let notify: ((event: ArmoryProgress) => void) | undefined;
    services.manager.updateAll.mockImplementationOnce(async (progress) => {
      notify = progress;
      return pending.promise;
    });
    registerArmoryIpcHandlers(services, RENDERER_URL, authorize);
    const fixture = invokeEvent();
    const running = invoke(ARMORY_IPC_INVOKE.updateAll, fixture.event);
    const event = { ...PROGRESS, operation: "update-all" as const };
    notify?.(event);
    expect(currentWindow.webContents.send).toHaveBeenCalledExactlyOnceWith(ARMORY_IPC_EVENTS.progress, event);
    authorize.mockReturnValue(false);
    notify?.(event);
    authorize.mockImplementation(authorizeCurrentWindow);
    fixture.sender.getURL = () => "sliver://app/index.html?surface=other";
    notify?.(event);
    fixture.sender.getURL = () => RENDERER_URL;
    vi.mocked(currentWindow.webContents.isDestroyed).mockReturnValue(true);
    notify?.(event);
    expect(currentWindow.webContents.send).toHaveBeenCalledTimes(1);
    pending.resolve(SNAPSHOT);
    await expect(running).resolves.toMatchObject({ ok: true });
  });

  it("copies a validated public key from the trusted Armory main frame without publishing a mutation", async () => {
    const services = servicesMock();
    const authorize = vi.fn(authorizeCurrentWindow);
    registerArmoryIpcHandlers(services, RENDERER_URL, authorize);
    await expect(invoke(ARMORY_IPC_INVOKE.copyPublicKey, invokeEvent().event, { publicKey: `  ${CANONICAL_PUBLIC_KEY}  ` }))
      .resolves.toEqual({ ok: true });
    expect(authorize).toHaveBeenCalledExactlyOnceWith(IDENTITY, currentWindow);
    expect(services.writeClipboardText).toHaveBeenCalledExactlyOnceWith(CANONICAL_PUBLIC_KEY);
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(services.writeClipboardText.mock.invocationCallOrder[0]!);
    expect(services.changed).not.toHaveBeenCalled();
  });

  it("rejects an untrusted public-key copy before reading its input", async () => {
    const services = servicesMock();
    registerArmoryIpcHandlers(services, RENDERER_URL, () => false);
    const readPublicKey = vi.fn(() => CANONICAL_PUBLIC_KEY);
    const input = Object.defineProperty({}, "publicKey", { enumerable: true, get: readPublicKey });
    await expect(invoke(ARMORY_IPC_INVOKE.copyPublicKey, invokeEvent().event, input))
      .resolves.toEqual({ ok: false, error: "Untrusted Armory renderer" });
    expect(readPublicKey).not.toHaveBeenCalled();
    expect(services.writeClipboardText).not.toHaveBeenCalled();
    expect(services.changed).not.toHaveBeenCalled();
  });

  it.each([
    "trusted-public-key",
    `RWQ\u202e${CANONICAL_PUBLIC_KEY.slice(3)}`,
  ])("rejects a non-Minisign package public key without writing it: %s", async (publicKey) => {
    const services = servicesMock();
    registerArmoryIpcHandlers(services, RENDERER_URL, authorizeCurrentWindow);
    await expect(invoke(ARMORY_IPC_INVOKE.copyPublicKey, invokeEvent().event, { publicKey }))
      .resolves.toEqual({ ok: false, error: "The package public key is invalid" });
    expect(services.writeClipboardText).not.toHaveBeenCalled();
    expect(services.changed).not.toHaveBeenCalled();
  });

  it("sanitizes clipboard failures", async () => {
    const services = servicesMock();
    services.writeClipboardText.mockRejectedValueOnce(new Error("PRIVATE_CLIPBOARD_FAILURE"));
    registerArmoryIpcHandlers(services, RENDERER_URL, authorizeCurrentWindow);
    await expect(invoke(ARMORY_IPC_INVOKE.copyPublicKey, invokeEvent().event, { publicKey: CANONICAL_PUBLIC_KEY }))
      .resolves.toEqual({ ok: false, error: "The public key could not be copied to the clipboard" });
    expect(services.writeClipboardText).toHaveBeenCalledExactlyOnceWith(CANONICAL_PUBLIC_KEY);
    expect(services.changed).not.toHaveBeenCalled();
  });

  it("waits for the native clipboard write before reporting success", async () => {
    const services = servicesMock();
    const pending = deferred<void>();
    services.writeClipboardText.mockReturnValueOnce(pending.promise);
    registerArmoryIpcHandlers(services, RENDERER_URL, authorizeCurrentWindow);
    const settled = vi.fn();
    const copying = invoke(ARMORY_IPC_INVOKE.copyPublicKey, invokeEvent().event, { publicKey: CANONICAL_PUBLIC_KEY });
    void copying.then(settled);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    pending.resolve();
    await expect(copying).resolves.toEqual({ ok: true });
  });

  it.each([
    ["https://example.test/repo", "https://example.test/repo"],
    ["http://example.test/repo", "http://example.test/repo"],
    [" HTTPS://Example.test:443/repo?tab=readme#overview ", "https://example.test/repo?tab=readme#overview"],
    ["http://localhost:8080/repo", "http://localhost:8080/repo"],
    ["https://[::1]:8443/repo", "https://[::1]:8443/repo"],
  ])("validates and canonicalizes repository URL %s in main before opening the browser", async (url, expected) => {
    const services = servicesMock();
    const authorize = vi.fn(authorizeCurrentWindow);
    registerArmoryIpcHandlers(services, RENDERER_URL, authorize);
    await expect(invoke(ARMORY_IPC_INVOKE.openRepository, invokeEvent().event, { url })).resolves.toEqual({ ok: true });
    expect(authorize).toHaveBeenCalledExactlyOnceWith(IDENTITY, currentWindow);
    expect(services.openExternal).toHaveBeenCalledExactlyOnceWith(expected);
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(services.openExternal.mock.invocationCallOrder[0]!);
    expect(services.changed).not.toHaveBeenCalled();
  });

  it.each([
    "javascript:alert(1)", "data:text/html,test", "file:///tmp/repository", "ftp://example.test/repo", "sliver://app/index.html",
    "//example.test/repo", "/repo", "example.test/repo", "https://", "https://example.test:65536/repo", "https://bad host/repo",
    "https://username:password@example.test/repo", "https://username@example.test/repo", "https://:password@example.test/repo",
    "https://@example.test/repo", "https:example.test", "https:/example.test", "https:///example.test", "http:\\example.test",
    "https://exam\tple.test/repo", "https://exam\nple.test/repo", "https://example.test\\repo",
  ])("rejects invalid repository target %s without opening anything", async (url) => {
    const services = servicesMock();
    registerArmoryIpcHandlers(services, RENDERER_URL, authorizeCurrentWindow);
    await expect(invoke(ARMORY_IPC_INVOKE.openRepository, invokeEvent().event, { url })).resolves.toMatchObject({ ok: false });
    expect(services.openExternal).not.toHaveBeenCalled();
    expect(services.changed).not.toHaveBeenCalled();
  });

  it.each(["asynchronous", "synchronous"])("returns a safe failure after %s browser rejection", async (failure) => {
    const services = servicesMock();
    services.openExternal.mockImplementation(() => {
      if (failure === "synchronous") throw new Error("PRIVATE_BROWSER_FAILURE");
      return Promise.reject(new Error("PRIVATE_BROWSER_FAILURE"));
    });
    registerArmoryIpcHandlers(services, RENDERER_URL, authorizeCurrentWindow);
    await expect(invoke(ARMORY_IPC_INVOKE.openRepository, invokeEvent().event, { url: "https://example.test/repo" }))
      .resolves.toEqual({ ok: false, error: "The repository could not be opened in your browser" });
    expect(services.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.test/repo");
  });

  it("rejects untrusted repository callers before reading their input", async () => {
    const services = servicesMock();
    const authorize = vi.fn(() => false);
    registerArmoryIpcHandlers(services, RENDERER_URL, authorize);
    const readUrl = vi.fn(() => "https://example.test/repo");
    const input = Object.defineProperty({}, "url", { enumerable: true, get: readUrl });
    await expect(invoke(ARMORY_IPC_INVOKE.openRepository, invokeEvent().event, input))
      .resolves.toEqual({ ok: false, error: "Untrusted Armory renderer" });
    expect(readUrl).not.toHaveBeenCalled();
    expect(services.openExternal).not.toHaveBeenCalled();
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
      await expect(invoke(ARMORY_IPC_INVOKE.openRepository, fixture.event, { url: "https://example.test/repo" }))
        .resolves.toEqual({ ok: false, error: "Untrusted Armory renderer" });
    }
    expect(services.manager.install).not.toHaveBeenCalled();
    expect(services.openExternal).not.toHaveBeenCalled();
    expect(services.changed).not.toHaveBeenCalled();
  });

  it("rejects child/stale frames, missing/destroyed surfaces, and revoked identities", async () => {
    const services = servicesMock();
    const authorize = vi.fn(authorizeCurrentWindow);
    registerArmoryIpcHandlers(services, RENDERER_URL, authorize);
    const reject = async (event: IpcMainInvokeEvent): Promise<void> => {
      await expect(invoke(ARMORY_IPC_INVOKE.snapshot, event)).resolves.toMatchObject({ ok: false });
      await expect(invoke(ARMORY_IPC_INVOKE.openRepository, event, { url: "https://example.test/repo" })).resolves.toMatchObject({ ok: false });
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
    vi.mocked(currentWindow.isDestroyed).mockReturnValueOnce(true).mockReturnValueOnce(true);
    await reject(invokeEvent().event);
    electronMocks.fromWebContents.mockReturnValueOnce(null).mockReturnValueOnce(null);
    await reject(invokeEvent().event);
    electronMocks.fromWebContents.mockReturnValueOnce({ isDestroyed: () => false }).mockReturnValueOnce({ isDestroyed: () => false });
    await reject(invokeEvent().event);
    authorize.mockReturnValue(false);
    await reject(invokeEvent().event);
    expect(services.manager.snapshot).not.toHaveBeenCalled();
    expect(services.openExternal).not.toHaveBeenCalled();
  });

  it("rejects malformed counts, unknown fields, filesystem paths and execution requests before dispatch", async () => {
    const services = servicesMock();
    registerArmoryIpcHandlers(services, RENDERER_URL, authorizeCurrentWindow);
    const { event } = invokeEvent();
    const malformed: ReadonlyArray<readonly [string, readonly unknown[]]> = [
      [ARMORY_IPC_INVOKE.getContext, [null]], [ARMORY_IPC_INVOKE.snapshot, [{}]],
      [ARMORY_IPC_INVOKE.refreshCatalog, [{ ignoreSignatures: true }]],
      [ARMORY_IPC_INVOKE.updateAll, [{ packageIds: ["package"] }]],
      [ARMORY_IPC_INVOKE.install, []], [ARMORY_IPC_INVOKE.install, [{ packageId: "package" }, "extra"]],
      [ARMORY_IPC_INVOKE.install, [{ packageId: "package", sessionId: "session" }]],
      [ARMORY_IPC_INVOKE.installBundle, [{ bundleId: "bundle", replace: "true" }]],
      [ARMORY_IPC_INVOKE.uninstall, [{ installedId: "installed", installPath: "/tmp/arbitrary" }]],
      [ARMORY_IPC_INVOKE.saveSource, [{ name: "source", repoUrl: "https://example.test", publicKey: "key", enabled: true, authorization_cmd: "arbitrary-command" }]],
      [ARMORY_IPC_INVOKE.removeSource, [{ sourceId: "source", configPath: "/tmp/arbitrary" }]],
      [ARMORY_IPC_INVOKE.installLocal, [{ publicKey: "key", archivePath: "/tmp/arbitrary.tar.gz" }]],
      [ARMORY_IPC_INVOKE.installLocal, [{ publicKey: "key", signaturePath: "/tmp/arbitrary.minisig" }]],
      [ARMORY_IPC_INVOKE.installLocal, [{ publicKey: "key", execute: true }]],
      [ARMORY_IPC_INVOKE.copyPublicKey, []], [ARMORY_IPC_INVOKE.copyPublicKey, [{ publicKey: "key" }, "extra"]],
      [ARMORY_IPC_INVOKE.copyPublicKey, [{ publicKey: "key", channel: "arbitrary" }]],
      [ARMORY_IPC_INVOKE.openRepository, []], [ARMORY_IPC_INVOKE.openRepository, [{ url: "https://example.test/repo" }, "extra"]],
      [ARMORY_IPC_INVOKE.openRepository, [{ url: "https://example.test/repo", options: { activate: true } }]],
      [ARMORY_IPC_INVOKE.openRepository, [{ url: "https://example.test/repo", channel: "arbitrary" }]],
    ];
    for (const [channel, args] of malformed) await expect(invoke(channel, event, ...args)).resolves.toMatchObject({ ok: false });
    for (const method of Object.values(services.manager)) expect(method).not.toHaveBeenCalled();
    expect(electronMocks.showOpenDialog).not.toHaveBeenCalled();
    expect(services.changed).not.toHaveBeenCalled();
    expect(services.writeClipboardText).not.toHaveBeenCalled();
    expect(services.openExternal).not.toHaveBeenCalled();
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
    await expect(invoke(ARMORY_IPC_INVOKE.updateAll, event))
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
      updateAll: vi.fn(async (_progress?: (event: ArmoryProgress) => void) => SNAPSHOT),
      install: vi.fn(async (_input: unknown, _progress?: (event: ArmoryProgress) => void) => SNAPSHOT),
      installBundle: vi.fn(async (_input: unknown, _progress?: (event: ArmoryProgress) => void) => SNAPSHOT),
      uninstall: vi.fn(async (_input: unknown) => SNAPSHOT), saveSource: vi.fn(async (_input: unknown) => SNAPSHOT),
      removeSource: vi.fn(async (_input: unknown) => SNAPSHOT), installLocal: vi.fn(async (_input: unknown) => SNAPSHOT),
    },
    getTab: vi.fn(() => "manage" as const),
    getApplicationSettings: vi.fn(() => DEFAULT_APPLICATION_SETTINGS_STATE),
    changed: vi.fn(),
    writeClipboardText: vi.fn(async (_text: string): Promise<void> => undefined),
    openExternal: vi.fn(async (_url: string) => undefined),
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
