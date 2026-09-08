// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { ApplicationCloudDeploymentController } from "./application.js";
import type { ConsolePortRuntime } from "./console-port-session.js";

const harness = vi.hoisted(() => ({
  windows: [] as any[],
  focusedWindow: undefined as any,
  nextContentsId: 100,
  cloudSshWindows: undefined as any,
  sshServices: undefined as any,
  sshAuthorizer: undefined as any,
  hardenedWindows: [] as any[],
  updater: {
    getState: vi.fn(() => ({ status: "idle" })),
    subscribe: vi.fn(() => () => undefined),
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    checkForUpdates: vi.fn(async () => ({ ok: true })),
    restartToApply: vi.fn(),
  },
  settingsStore: {
    getState: vi.fn(() => ({
      v: 3,
      revision: 0,
      theme: "dark",
      appIcon: "auto",
      reduceMotion: false,
      commandPaletteShortcut: "mod+k",
      terminal: {
        fontId: "fira-code",
        fontSize: 13,
        cursorStyle: "block",
        cursorBlink: true,
        smoothScrolling: false,
      },
    })),
    update: vi.fn(async () => ({ ok: false, error: "not used by this test" })),
  },
}));

vi.mock("electron", () => {
  class FakeEmitter {
    readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

    on(event: string, listener: (...args: any[]) => void): this {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: (...args: any[]) => void): this {
      const onceListener = (...args: any[]): void => {
        this.removeListener(event, onceListener);
        listener(...args);
      };
      return this.on(event, onceListener);
    }

    removeListener(event: string, listener: (...args: any[]) => void): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: any[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
  }

  class FakeWebContents extends FakeEmitter {
    readonly id: number;
    readonly mainFrame: {
      processId: number;
      frameToken: string;
      isDestroyed: () => boolean;
    };
    readonly send = vi.fn();
    readonly copyImageAt = vi.fn();
    readonly inspectElement = vi.fn();
    readonly replaceMisspelling = vi.fn();
    destroyed = false;
    url = "";

    constructor() {
      super();
      this.id = harness.nextContentsId;
      harness.nextContentsId += 1;
      this.mainFrame = {
        processId: this.id + 1_000,
        frameToken: `frame-${this.id}`,
        isDestroyed: () => this.destroyed,
      };
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    getURL(): string {
      return this.url;
    }
  }

  class FakeBrowserWindow extends FakeEmitter {
    static getFocusedWindow(): FakeBrowserWindow | null {
      return harness.focusedWindow ?? null;
    }

    readonly webContents = new FakeWebContents();
    readonly options: Record<string, unknown>;
    readonly show = vi.fn(() => {
      harness.focusedWindow = this;
    });
    readonly focus = vi.fn(() => {
      harness.focusedWindow = this;
    });
    readonly restore = vi.fn();
    readonly setTitle = vi.fn();
    readonly setIcon = vi.fn();
    readonly setBackgroundColor = vi.fn();
    readonly setTitleBarOverlay = vi.fn();
    destroyed = false;

    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      harness.windows.push(this);
    }

    async loadURL(url: string): Promise<void> {
      this.webContents.url = url;
      this.webContents.emit("did-finish-load");
      this.emit("ready-to-show");
    }

    async loadFile(filePath: string, options?: { query?: Record<string, string> }): Promise<void> {
      const url = new URL(`file://${filePath}`);
      for (const [key, value] of Object.entries(options?.query ?? {})) {
        url.searchParams.set(key, value);
      }
      await this.loadURL(url.href);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    isMinimized(): boolean {
      return false;
    }

    close(): void {
      if (this.destroyed) return;
      let prevented = false;
      this.emit("close", { preventDefault: () => { prevented = true; } });
      if (prevented) return;
      this.destroy();
    }

    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.webContents.destroyed = true;
      if (harness.focusedWindow === this) harness.focusedWindow = undefined;
      this.emit("closed");
    }
  }

  const application = new FakeEmitter() as FakeEmitter & Record<string, any>;
  Object.assign(application, {
    isPackaged: false,
    whenReady: vi.fn(async () => undefined),
    getPath: vi.fn(() => "/tmp/sliver-gui-ssh-application-test"),
    getVersion: vi.fn(() => "0.0.0-test"),
    setAboutPanelOptions: vi.fn(),
    showAboutPanel: vi.fn(),
    quit: vi.fn(),
  });
  const nativeUpdater = new FakeEmitter();
  const theme = new FakeEmitter() as FakeEmitter & Record<string, any>;
  Object.assign(theme, { shouldUseDarkColors: true, themeSource: "dark" });

  return {
    app: application,
    autoUpdater: nativeUpdater,
    BrowserWindow: FakeBrowserWindow,
    clipboard: { writeText: vi.fn() },
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 0 })),
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    },
    ipcMain: Object.assign(new FakeEmitter(), {
      handle: vi.fn(),
      removeHandler: vi.fn(),
    }),
    Menu: {
      buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
      setApplicationMenu: vi.fn(),
    },
    nativeTheme: theme,
    systemPreferences: {
      getUserDefault: vi.fn(() => "Dark"),
      subscribeNotification: vi.fn(() => 1),
      unsubscribeNotification: vi.fn(),
    },
    net: { fetch: vi.fn() },
    safeStorage: {},
    session: { defaultSession: {}, fromPartition: vi.fn(() => ({})) },
    shell: { openExternal: vi.fn(async () => undefined) },
  };
});

vi.mock("./application-settings.js", () => ({
  ApplicationSettingsStore: {
    load: vi.fn(async () => harness.settingsStore),
  },
}));

vi.mock("./application-updater.js", () => ({
  createApplicationUpdater: vi.fn(() => harness.updater),
}));

vi.mock("./cloud-deployment-ipc.js", () => ({
  registerCloudDeploymentIpcHandlers: vi.fn(
    (_controller: unknown, _url: string, _authorize: unknown, sshWindows: unknown) => {
      harness.cloudSshWindows = sshWindows;
    },
  ),
  unregisterCloudDeploymentIpcHandlers: vi.fn(),
}));

vi.mock("./cloud-deployment-service.js", () => ({
  CloudDeploymentService: { create: vi.fn() },
}));

vi.mock("./cloud/current-egress-ipv4.js", () => ({
  detectCurrentEgressIpv4: vi.fn(),
}));

vi.mock("./connection-registry.js", () => ({
  ConnectionRegistry: class {},
}));

vi.mock("./download-directory.js", () => ({
  resolveDownloadsDirectory: vi.fn(() => "/tmp"),
}));

vi.mock("./ipc.js", () => ({
  registerIpcHandlers: vi.fn(),
  unregisterIpcHandlers: vi.fn(),
}));

vi.mock("./security.js", () => ({
  configureSessionSecurity: vi.fn(),
  hardenWindow: vi.fn((window: unknown, rendererUrl: string, utilityUrl?: string) => {
    harness.hardenedWindows.push({ window, rendererUrl, utilityUrl });
  }),
  secureWebPreferences: vi.fn((preload: string) => ({
    preload,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
  })),
  isTrustedRendererUrl: vi.fn((candidateUrl: string, trustedUrl: string) => {
    const candidate = new URL(candidateUrl);
    const trusted = new URL(trustedUrl);
    return candidate.origin === trusted.origin && candidate.pathname === trusted.pathname;
  }),
}));

vi.mock("./sliver-release-download.js", () => ({
  SliverReleaseDownloader: class {
    readonly stop = vi.fn();
    readonly download = vi.fn(async () => undefined);
    readonly latestRelease = vi.fn(async () => ({ version: "v0.0.0", assets: [] }));
  },
}));

vi.mock("./ssh-ipc.js", () => ({
  SSH_IPC_EVENTS: {
    attach: "sliver:ssh:stream:attach",
    newTabRequested: "sliver:ssh:new-tab-requested",
    closeTabRequested: "sliver:ssh:close-tab-requested",
    selectTabRequested: "sliver:ssh:select-tab-requested",
    settingsRequested: "sliver:ssh:settings-requested",
    tabOpened: "sliver:ssh:tab-opened",
    applicationSettingsChanged: "sliver:application-settings:changed",
  },
  registerSshIpcHandlers: vi.fn((services: unknown, _url: string, authorize: unknown) => {
    harness.sshServices = services;
    harness.sshAuthorizer = authorize;
  }),
  unregisterSshIpcHandlers: vi.fn(),
}));

describe("SSH application window lifecycle", () => {
  it("uses a dedicated trusted surface while sessions survive window replacement and close explicitly", async () => {
    const runtimes = new Map<string, ReturnType<typeof fakeRuntime>>();
    const startSshSession = vi.fn(async (deploymentId: string) => {
      const runtime = fakeRuntime();
      runtimes.set(deploymentId, runtime);
      return {
        ok: true as const,
        value: {
          target: managedTarget(deploymentId),
          runtime,
        },
      };
    });
    const disposeCloudDeployment = vi.fn();
    const controller = {
      getSnapshot: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      getTerminalRuntime: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      startSshSession,
      approveSshHostKey: vi.fn(),
      dispose: disposeCloudDeployment,
    } as unknown as ApplicationCloudDeploymentController;
    const connectionRegistry = fakeConnectionRegistry();
    const { startApplication } = await import("./application.js");
    const application = await startApplication({
      cloudDeploymentController: controller,
      registry: connectionRegistry as never,
      developmentRendererUrl: "http://127.0.0.1:5173/",
      sshPreloadPath: "/test/ssh-preload.cjs",
    });

    const firstDeploymentId = "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0001";
    const firstOpen = await harness.cloudSshWindows.open(firstDeploymentId);
    expect(firstOpen).toMatchObject({
      ok: true,
      value: { status: "opened", created: true },
    });
    const firstTabId = firstOpen.value.tabId as string;
    const firstSshWindow = sshWindows().at(-1)!;
    expect(firstSshWindow.options).toMatchObject({
      title: "SSH",
      webPreferences: {
        preload: "/test/ssh-preload.cjs",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    expect(firstSshWindow.webContents.getURL()).toBe("http://127.0.0.1:5173/?surface=ssh");
    expect(harness.hardenedWindows).toContainEqual({
      window: firstSshWindow,
      rendererUrl: "http://127.0.0.1:5173/",
      utilityUrl: "http://127.0.0.1:5173/?surface=ssh",
    });

    const firstOwner = identityFor(firstSshWindow);
    const forgedOwner = { ...firstOwner, rendererFrameToken: "forged-frame" };
    expect(harness.sshAuthorizer(forgedOwner, firstSshWindow)).toBe(false);
    expect(await harness.sshServices.sessions.claim(forgedOwner)).toEqual({
      ok: false,
      error: "This window is not authorized to host SSH sessions",
    });
    expect(harness.sshAuthorizer(firstOwner, firstSshWindow)).toBe(true);
    const firstClaim = await harness.sshServices.sessions.claim(firstOwner);
    expect(firstClaim).toMatchObject({
      ok: true,
      value: { tabs: [{ tabId: firstTabId }] },
    });
    const firstAttachmentToken = firstClaim.value.tabs[0].attachmentToken;
    expect(await harness.sshServices.sessions.renameTab(firstOwner, firstTabId, "Primary gateway")).toEqual({
      ok: true,
      value: { tabId: firstTabId, label: "Primary gateway" },
    });

    firstSshWindow.close();
    await settleLifecycle();
    expect(runtimes.get(firstDeploymentId)!.close).not.toHaveBeenCalled();

    const reopened = await harness.cloudSshWindows.open(firstDeploymentId);
    expect(reopened).toEqual({
      ok: true,
      value: { status: "opened", tabId: firstTabId, created: false },
    });
    expect(startSshSession).toHaveBeenCalledTimes(1);
    const secondSshWindow = sshWindows().at(-1)!;
    expect(secondSshWindow).not.toBe(firstSshWindow);
    const secondOwner = identityFor(secondSshWindow);
    expect(harness.sshAuthorizer(firstOwner, secondSshWindow)).toBe(false);
    const secondClaim = await harness.sshServices.sessions.claim(secondOwner);
    expect(secondClaim).toMatchObject({
      ok: true,
      value: { tabs: [{ tabId: firstTabId, label: "Primary gateway" }] },
    });
    expect(secondClaim.value.tabs[0].attachmentToken).not.toBe(firstAttachmentToken);

    expect(await harness.sshServices.sessions.closeTab(secondOwner, firstTabId)).toEqual({
      ok: true,
      value: { remainingTabs: 0 },
    });
    expect(runtimes.get(firstDeploymentId)!.close).toHaveBeenCalledOnce();

    const shutdownDeploymentId = "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0002";
    expect(await harness.cloudSshWindows.open(shutdownDeploymentId)).toMatchObject({
      ok: true,
      value: { status: "opened", created: true },
    });
    expect(runtimes.get(shutdownDeploymentId)!.close).not.toHaveBeenCalled();

    await application.stop();
    expect(runtimes.get(shutdownDeploymentId)!.close).toHaveBeenCalledOnce();
    expect(disposeCloudDeployment).toHaveBeenCalledOnce();
  });

  it("cleans up a claim that finishes after its window closes so a replacement can claim", async () => {
    const runtime = fakeRuntime();
    const startSshSession = vi.fn(async (deploymentId: string) => ({
      ok: true as const,
      value: { target: managedTarget(deploymentId), runtime },
    }));
    const controller = {
      getSnapshot: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      getTerminalRuntime: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      startSshSession,
      approveSshHostKey: vi.fn(),
      dispose: vi.fn(),
    } as unknown as ApplicationCloudDeploymentController;
    const registryModule = await import("./ssh-session-registry.js");
    const originalClaim = registryModule.SshSessionRegistry.prototype.claim;
    const registryClaimCompleted = deferred<void>();
    const releaseClaim = deferred<void>();
    const claimSpy = vi.spyOn(registryModule.SshSessionRegistry.prototype, "claim")
      .mockImplementationOnce(function (this: any, owner: any) {
        return originalClaim.call(this, owner).then(async (result) => {
          registryClaimCompleted.resolve();
          await releaseClaim.promise;
          return result;
        });
      });
    const { startApplication } = await import("./application.js");
    const sshWindowBaseline = sshWindows().length;
    let application: Awaited<ReturnType<typeof startApplication>> | undefined;

    try {
      application = await startApplication({
        cloudDeploymentController: controller,
        registry: fakeConnectionRegistry() as never,
        developmentRendererUrl: "http://127.0.0.1:5173/",
        sshPreloadPath: "/test/ssh-preload.cjs",
      });

      const deploymentId = "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0003";
      const opened = await harness.cloudSshWindows.open(deploymentId);
      expect(opened).toMatchObject({
        ok: true,
        value: { status: "opened", created: true },
      });
      const tabId = opened.value.tabId as string;
      const firstWindow = sshWindows()[sshWindowBaseline]!;
      const staleOwner = identityFor(firstWindow);

      const inFlightClaim = harness.sshServices.sessions.claim(staleOwner);
      await registryClaimCompleted.promise;
      firstWindow.close();
      releaseClaim.resolve();

      expect(await inFlightClaim).toEqual({
        ok: false,
        error: "The SSH window closed while sessions were attaching",
      });
      await expect(harness.sshServices.sessions.listTargets(staleOwner)).rejects.toThrow(
        "not authorized",
      );
      expect(runtime.close).not.toHaveBeenCalled();

      expect(await harness.cloudSshWindows.open(deploymentId)).toEqual({
        ok: true,
        value: { status: "opened", tabId, created: false },
      });
      expect(startSshSession).toHaveBeenCalledOnce();
      const replacementWindow = sshWindows()[sshWindowBaseline + 1]!;
      const replacementOwner = identityFor(replacementWindow);
      expect(harness.sshAuthorizer(staleOwner, replacementWindow)).toBe(false);
      expect(await harness.sshServices.sessions.claim(replacementOwner)).toMatchObject({
        ok: true,
        value: { tabs: [{ tabId }] },
      });
      expect(runtime.close).not.toHaveBeenCalled();

      await application.stop();
      application = undefined;
      expect(runtime.close).toHaveBeenCalledOnce();
    } finally {
      releaseClaim.resolve();
      await application?.stop();
      claimSpy.mockRestore();
    }
  });

  it("publishes a fresh tab context when cloud open repairs a failed attachment", async () => {
    const runtime = fakeRuntime();
    const startSshSession = vi.fn(async (deploymentId: string) => ({
      ok: true as const,
      value: { target: managedTarget(deploymentId), runtime },
    }));
    const controller = {
      getSnapshot: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      getTerminalRuntime: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      startSshSession,
      approveSshHostKey: vi.fn(),
      dispose: vi.fn(),
    } as unknown as ApplicationCloudDeploymentController;
    const { startApplication } = await import("./application.js");
    const application = await startApplication({
      cloudDeploymentController: controller,
      registry: fakeConnectionRegistry() as never,
      developmentRendererUrl: "http://127.0.0.1:5173/",
      sshPreloadPath: "/test/ssh-preload.cjs",
    });

    try {
      const deploymentId = "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0004";
      const opened = await harness.cloudSshWindows.open(deploymentId);
      const tabId = opened.value.tabId as string;
      const window = sshWindows().at(-1)!;
      const owner = identityFor(window);
      const claimed = await harness.sshServices.sessions.claim(owner);
      const staleContext = claimed.value.tabs[0];
      const failedPort = failingAttachmentPort();

      expect(() => harness.sshServices.sessions.attach(
        owner,
        staleContext.attachmentToken,
        failedPort,
      )).toThrow("simulated port startup failure");
      window.webContents.send.mockClear();

      const repaired = await harness.cloudSshWindows.open(deploymentId);

      expect(repaired).toMatchObject({
        ok: true,
        value: {
          status: "opened",
          tabId,
          created: false,
          context: { tabId },
        },
      });
      expect(repaired.value.context.attachmentToken).not.toBe(staleContext.attachmentToken);
      expect(window.webContents.send).toHaveBeenCalledWith(
        "sliver:ssh:tab-opened",
        repaired.value.context,
      );
      expect(window.webContents.send).not.toHaveBeenCalledWith(
        "sliver:ssh:select-tab-requested",
        expect.anything(),
      );
      expect(startSshSession).toHaveBeenCalledOnce();
      expect(runtime.close).not.toHaveBeenCalled();
    } finally {
      await application.stop();
    }
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("does not create a late SSH window when deferred startup resolves during shutdown", async () => {
    const runtime = fakeRuntime();
    const startup = deferred<{
      ok: true;
      value: { target: ReturnType<typeof managedTarget>; runtime: typeof runtime };
    }>();
    const startSshSession = vi.fn((_deploymentId: string) => startup.promise);
    const disposeCloudDeployment = vi.fn();
    const controller = {
      getSnapshot: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      getTerminalRuntime: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      startSshSession,
      approveSshHostKey: vi.fn(),
      dispose: disposeCloudDeployment,
    } as unknown as ApplicationCloudDeploymentController;
    const { startApplication } = await import("./application.js");
    const application = await startApplication({
      cloudDeploymentController: controller,
      registry: fakeConnectionRegistry() as never,
      developmentRendererUrl: "http://127.0.0.1:5173/",
      sshPreloadPath: "/test/ssh-preload.cjs",
    });
    const deploymentId = "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0005";
    const sshWindowBaseline = sshWindows().length;
    const inFlightOpen = harness.cloudSshWindows.open(deploymentId);
    await vi.waitFor(() => expect(startSshSession).toHaveBeenCalledWith(deploymentId));

    const stopping = application.stop();
    startup.resolve({
      ok: true,
      value: { target: managedTarget(deploymentId), runtime },
    });

    expect(await inFlightOpen).toEqual({
      ok: false,
      error: "SSH sessions are unavailable while the application is closing",
    });
    await stopping;
    expect(sshWindows()).toHaveLength(sshWindowBaseline);
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(disposeCloudDeployment).toHaveBeenCalledOnce();
  });
});

function managedTarget(deploymentId: string) {
  return {
    deploymentId,
    name: deploymentId.endsWith("1") ? "test1" : "test2",
    provider: "aws" as const,
    host: "44.240.136.251",
    port: 22,
    username: "ubuntu",
    status: "running" as const,
    connectable: true,
  };
}

function fakeRuntime(): ConsolePortRuntime & { close: ReturnType<typeof vi.fn> } {
  return {
    subscribe: vi.fn(() => () => undefined),
    write: vi.fn(),
    resize: vi.fn(),
    pauseOutput: vi.fn(),
    resumeOutput: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

function failingAttachmentPort() {
  return {
    postMessage: vi.fn(),
    onMessage: vi.fn(() => () => undefined),
    onClose: vi.fn(() => () => undefined),
    start: vi.fn(() => {
      throw new Error("simulated port startup failure");
    }),
    close: vi.fn(),
  };
}

function fakeConnectionRegistry() {
  return {
    registerWindow: vi.fn(),
    inheritConnection: vi.fn(),
    closeWindowStreams: vi.fn(async () => undefined),
    unregisterWindow: vi.fn(async () => undefined),
  };
}

function sshWindows(): any[] {
  return harness.windows.filter(({ options }) => options.title === "SSH");
}

function identityFor(window: any) {
  return {
    contentsId: window.webContents.id,
    rendererProcessId: window.webContents.mainFrame.processId,
    rendererFrameToken: window.webContents.mainFrame.frameToken,
  };
}

async function settleLifecycle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
