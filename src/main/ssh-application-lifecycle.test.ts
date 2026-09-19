// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { ApplicationCloudDeploymentController } from "./application.js";
import { IPC, type ManagedServerReference } from "../shared/contracts.js";
import type { ConsolePortRuntime } from "./console-port-session.js";
import { NETWORK_FORWARDING_IPC_EVENTS } from "../shared/network-forwarding-contracts.js";

const harness = vi.hoisted(() => ({
  windows: [] as any[],
  focusedWindow: undefined as any,
  nextContentsId: 100,
  suppressReadyToShow: false,
  cloudSshWindows: undefined as any,
  sshServices: undefined as any,
  sshAuthorizer: undefined as any,
  hardenedWindows: [] as any[],
  sliverReleaseDownloaders: [] as any[],
  crackstationReleaseDownloaders: [] as any[],
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
      v: 4,
      revision: 0,
      theme: "dark",
      appIcon: "auto",
      reduceMotion: false,
      commandPaletteShortcut: "mod+k",
      keyboardShortcuts: {},
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
    readonly setIgnoreMenuShortcuts = vi.fn();
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
      this.visible = true;
      harness.focusedWindow = this;
    });
    readonly hide = vi.fn(() => {
      this.visible = false;
      if (harness.focusedWindow === this) harness.focusedWindow = undefined;
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
    visible = false;

    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      harness.windows.push(this);
    }

    async loadURL(url: string): Promise<void> {
      this.webContents.url = url;
      this.webContents.emit("did-finish-load");
      if (!harness.suppressReadyToShow) this.emit("ready-to-show");
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

    isFocused(): boolean {
      return harness.focusedWindow === this;
    }

    isVisible(): boolean {
      return this.visible && !this.destroyed;
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
      this.visible = false;
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
    protocol: { registerSchemesAsPrivileged: vi.fn() },
    safeStorage: {},
    session: {
      defaultSession: { protocol: { handle: vi.fn(), unhandle: vi.fn() } },
      fromPartition: vi.fn(() => ({ protocol: { handle: vi.fn(), unhandle: vi.fn() } })),
    },
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

    constructor() {
      harness.sliverReleaseDownloaders.push(this);
    }
  },
  CrackstationReleaseDownloader: class {
    readonly stop = vi.fn();
    readonly download = vi.fn(async () => undefined);
    readonly latestRelease = vi.fn(async () => ({
      version: "v0.0.4",
      assets: [{ artifact: "crackstation", os: "windows", arch: "amd64" }],
    }));

    constructor() {
      harness.crackstationReleaseDownloaders.push(this);
    }
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

describe("application protocol lifecycle", () => {
  it("temporarily suspends native shortcuts only for the trusted recording window", async () => {
    const { startApplication } = await import("./application.js");
    const { registerIpcHandlers } = await import("./ipc.js");
    const controller = {
      getSnapshot: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      getTerminalRuntime: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      dispose: vi.fn(),
    } as unknown as ApplicationCloudDeploymentController;
    const application = await startApplication({ cloudDeploymentController: controller, registry: fakeConnectionRegistry() as never });
    const window = harness.windows.at(-1)!;
    const settings = vi.mocked(registerIpcHandlers).mock.calls.at(-1)![8]!;
    const source = identityFor(window);
    const event = { preventDefault: vi.fn() };
    const input = {
      type: "keyDown", key: "k", code: "KeyK", isComposing: false, isAutoRepeat: false,
      shift: false, alt: false, meta: process.platform === "darwin", control: process.platform !== "darwin",
    };
    try {
      settings.setKeyboardShortcutRecording!(source, true);
      expect(window.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
      window.webContents.emit("before-input-event", event, input);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(window.webContents.send).not.toHaveBeenCalledWith(IPC.commandPaletteRequested);

      settings.setKeyboardShortcutRecording!(source, false);
      expect(window.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
      window.webContents.emit("before-input-event", event, input);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(window.webContents.send).toHaveBeenCalledWith(IPC.commandPaletteRequested);

      for (const clear of [
        () => window.emit("blur"),
        () => window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }),
        () => window.webContents.emit("render-process-gone"),
      ]) {
        settings.setKeyboardShortcutRecording!(source, true);
        clear();
        expect(window.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
      }
      expect(() => settings.setKeyboardShortcutRecording!({ ...source, rendererFrameToken: "stale-frame" }, true))
        .toThrow(/not authorized/);
      const anotherWindow = application.createWindow();
      expect(() => settings.setKeyboardShortcutRecording!(source, true)).toThrow(/Focus this window/);
      expect((anotherWindow.webContents as any).setIgnoreMenuShortcuts).not.toHaveBeenCalled();
    } finally {
      await application.stop();
    }
  });

  it("wires local managed metadata and refreshes it on deployment changes only", async () => {
    const { startApplication } = await import("./application.js");
    const registry = fakeConnectionRegistry();
    const reference: ManagedServerReference = {
      deploymentId: "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0010",
      provider: "aws",
      name: "Managed test server",
    };
    const resolveManagedServer = vi.fn(() => reference);
    const ensureIngress = vi.fn(async () => ({
      ok: true as const,
      value: { status: "applied" as const, ruleCount: 1 },
    }));
    const removeIngress = vi.fn(async () => ({
      ok: true as const,
      value: { status: "removed" as const, ruleCount: 1 },
    }));
    const subscribe = vi.fn((_listener: (scope: "snapshot" | "transcripts") => void) => vi.fn());
    const controller = {
      resolveManagedServer,
      ensureIngress,
      removeIngress,
      subscribe,
      getSnapshot: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      getTerminalRuntime: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      dispose: vi.fn(),
    } as unknown as ApplicationCloudDeploymentController;
    const application = await startApplication({ cloudDeploymentController: controller, registry: registry as never });
    try {
      const resolve = registry.setManagedServerResolver.mock.calls[0]![0];
      expect(resolve("config-digest")).toEqual(reference);
      expect(resolveManagedServer).toHaveBeenCalledWith("config-digest");
      expect(registry.setManagedListenerFirewallController).toHaveBeenCalledExactlyOnceWith(controller);
      const changed = subscribe.mock.calls[0]![0];
      changed("transcripts");
      expect(registry.refreshManagedServerMetadata).not.toHaveBeenCalled();
      changed("snapshot");
      expect(registry.refreshManagedServerMetadata).toHaveBeenCalledOnce();
      await application.stop();
      changed("snapshot");
      expect(registry.refreshManagedServerMetadata).toHaveBeenCalledOnce();
    } finally {
      await application.stop();
    }
  });

  it.each([
    "http://127.0.0.1:5173/",
    "https://example.invalid/renderer",
  ])("ignores ELECTRON_RENDERER_URL=%s in unpackaged applications", async (rendererOverride) => {
    vi.stubEnv("ELECTRON_RENDERER_URL", rendererOverride);
    const { app } = await import("electron");
    const { startApplication } = await import("./application.js");
    const { registerIpcHandlers } = await import("./ipc.js");
    const controller = {
      getSnapshot: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      getTerminalRuntime: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      dispose: vi.fn(),
    } as unknown as ApplicationCloudDeploymentController;
    let application: Awaited<ReturnType<typeof startApplication>> | undefined;

    try {
      expect(app.isPackaged).toBe(false);
      application = await startApplication({
        cloudDeploymentController: controller,
        registry: fakeConnectionRegistry() as never,
      });
      expect(harness.windows.at(-1)!.webContents.getURL()).toBe("sliver://app/index.html");
      expect(application.createWindow().webContents.getURL()).toBe("sliver://app/index.html");
      expect(vi.mocked(registerIpcHandlers).mock.calls.at(-1)![2]).toBe("sliver://app/index.html");
    } finally {
      await application?.stop();
      vi.unstubAllEnvs();
    }
  });

  it("routes Crackstation menu downloads to their own downloader and stops both sources", async () => {
    const controller = {
      getSnapshot: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      getTerminalRuntime: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      dispose: vi.fn(),
    } as unknown as ApplicationCloudDeploymentController;
    const { Menu } = await import("electron");
    const { startApplication } = await import("./application.js");
    const sliverIndex = harness.sliverReleaseDownloaders.length;
    const crackstationIndex = harness.crackstationReleaseDownloaders.length;
    const downloadCleanup = deferred<void>();
    vi.mocked(Menu.buildFromTemplate).mockClear();
    const application = await startApplication({
      cloudDeploymentController: controller,
      registry: fakeConnectionRegistry() as never,
    });

    try {
      await settleLifecycle();
      const sliverDownloader = harness.sliverReleaseDownloaders[sliverIndex];
      const crackstationDownloader = harness.crackstationReleaseDownloaders[crackstationIndex];
      const template = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)?.[0] ?? [];
      const crackstationMenu = findTemplateMenuItemByLabel(template, "Download Crackstation");
      const windowsMenu = findTemplateMenuItemByLabel(crackstationMenu?.submenu ?? [], "Windows");
      const amd64Item = findTemplateMenuItemByLabel(windowsMenu?.submenu ?? [], "x86_64 (amd64)");
      expect(amd64Item).toBeDefined();
      crackstationDownloader.download.mockImplementationOnce(() => downloadCleanup.promise);

      Reflect.apply(amd64Item!.click, amd64Item, [amd64Item, harness.focusedWindow, {}]);
      expect(crackstationDownloader.download).toHaveBeenCalledExactlyOnceWith(
        { artifact: "crackstation", os: "windows", arch: "amd64" },
        expect.any(Function),
      );
      expect(sliverDownloader.download).not.toHaveBeenCalled();

      let stopped = false;
      const stopping = application.stop().then(() => {
        stopped = true;
      });
      await settleLifecycle();
      expect(stopped).toBe(false);
      expect(sliverDownloader.stop).toHaveBeenCalledOnce();
      expect(crackstationDownloader.stop).toHaveBeenCalledOnce();
      downloadCleanup.resolve();
      await stopping;
    } finally {
      downloadCleanup.resolve();
      await application.stop();
    }
  });

  it("loads bundled windows through both owned sessions and removes each handler once during teardown", async () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", undefined);
    const controller = {
      getSnapshot: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      getTerminalRuntime: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
      startSshSession: vi.fn(async (deploymentId: string) => ({
        ok: true as const,
        value: { target: managedTarget(deploymentId), runtime: fakeRuntime() },
      })),
      approveSshHostKey: vi.fn(),
      dispose: vi.fn(),
    } as unknown as ApplicationCloudDeploymentController;
    const { Menu, session } = await import("electron");
    const { startApplication } = await import("./application.js");
    const { registerIpcHandlers } = await import("./ipc.js");
    const defaultProtocol = session.defaultSession.protocol;
    vi.mocked(defaultProtocol.handle).mockClear();
    vi.mocked(defaultProtocol.unhandle).mockClear();
    vi.mocked(session.fromPartition).mockClear();
    vi.mocked(Menu.buildFromTemplate).mockClear();
    let application: Awaited<ReturnType<typeof startApplication>> | undefined;

    try {
      const registry = fakeConnectionRegistry();
      application = await startApplication({
        cloudDeploymentController: controller,
        registry: registry as never,
        networkPreloadPath: "/test/network-preload.cjs",
        sshPreloadPath: "/test/ssh-preload.cjs",
      });
      const partitionCalls = vi.mocked(session.fromPartition).mock.calls;
      const cloudPartitionIndex = partitionCalls.findIndex(([name]) => name === "sliver-cloud-deployment");
      const networkPartitionIndex = partitionCalls.findIndex(([name]) => name === "sliver-network");
      expect(cloudPartitionIndex).toBeGreaterThanOrEqual(0);
      expect(networkPartitionIndex).toBeGreaterThanOrEqual(0);
      const cloudPartitionResult = vi.mocked(session.fromPartition).mock.results[cloudPartitionIndex]!;
      const networkPartitionResult = vi.mocked(session.fromPartition).mock.results[networkPartitionIndex]!;
      expect(cloudPartitionResult.type).toBe("return");
      expect(networkPartitionResult.type).toBe("return");
      const cloudProtocol = cloudPartitionResult.value.protocol;
      const networkProtocol = networkPartitionResult.value.protocol;
      for (const ownedProtocol of [defaultProtocol, cloudProtocol, networkProtocol]) {
        expect(ownedProtocol.handle).toHaveBeenCalledExactlyOnceWith("sliver", expect.any(Function));
        expect(ownedProtocol.unhandle).not.toHaveBeenCalled();
      }

      const workspaceWindow = harness.windows.at(-1)!;
      expect(workspaceWindow.webContents.getURL()).toBe("sliver://app/index.html");
      const applicationMenuTemplate = vi.mocked(Menu.buildFromTemplate).mock.calls
        .map(([template]) => template)
        .find((template) => findTemplateMenuItem(template, "network.port-forward"));
      const portForwardMenuItem = findTemplateMenuItem(applicationMenuTemplate ?? [], "network.port-forward");
      expect(portForwardMenuItem).toBeDefined();
      Reflect.apply(portForwardMenuItem!.click, portForwardMenuItem, [portForwardMenuItem, workspaceWindow, {}]);
      await settleLifecycle();

      const networkWindow = harness.windows.at(-1)!;
      expect(networkWindow).not.toBe(workspaceWindow);
      expect(networkWindow.options.webPreferences.partition).toBe("sliver-network");
      expect(networkWindow.options.webPreferences.preload).toBe("/test/network-preload.cjs");
      expect(networkWindow.webContents.getURL()).toBe("sliver://app/index.html?surface=network");
      expect(networkWindow.setTitle).toHaveBeenCalledWith("Network");
      expect(registry.inheritConnection).toHaveBeenCalledWith(
        workspaceWindow.webContents.id,
        networkWindow.webContents.id,
      );
      expect(networkWindow.webContents.send).toHaveBeenCalledExactlyOnceWith(
        NETWORK_FORWARDING_IPC_EVENTS.navigationRequested,
        "port-forward",
      );
      expect(harness.hardenedWindows).toContainEqual({
        window: networkWindow,
        rendererUrl: "sliver://app/index.html",
        utilityUrl: "sliver://app/index.html?surface=network",
      });

      networkWindow.webContents.send.mockClear();
      const windowCount = harness.windows.length;
      const reverseMenuItem = findTemplateMenuItem(applicationMenuTemplate ?? [], "network.reverse-port-forward");
      Reflect.apply(reverseMenuItem!.click, reverseMenuItem, [reverseMenuItem, networkWindow, {}]);
      await settleLifecycle();
      expect(harness.windows).toHaveLength(windowCount);
      expect(harness.focusedWindow).toBe(networkWindow);
      expect(networkWindow.webContents.send).toHaveBeenCalledExactlyOnceWith(
        NETWORK_FORWARDING_IPC_EVENTS.navigationRequested,
        "reverse-port-forward",
      );

      // Electron emits close before closed. A reopen during that gap must not
      // select a native window that is already committed to closing.
      networkWindow.emit("close", { preventDefault: vi.fn() });
      const socksMenuItem = findTemplateMenuItem(applicationMenuTemplate ?? [], "network.socks5");
      Reflect.apply(socksMenuItem!.click, socksMenuItem, [socksMenuItem, workspaceWindow, {}]);
      await settleLifecycle();
      const reopenedNetworkWindow = harness.windows.at(-1)!;
      expect(reopenedNetworkWindow).not.toBe(networkWindow);
      expect(reopenedNetworkWindow.webContents.getURL()).toBe("sliver://app/index.html?surface=network");
      expect(reopenedNetworkWindow.webContents.send).toHaveBeenCalledExactlyOnceWith(
        NETWORK_FORWARDING_IPC_EVENTS.navigationRequested,
        "socks5",
      );
      networkWindow.destroy();

      const registration = vi.mocked(registerIpcHandlers).mock.calls.at(-1)!;
      expect(registration[2]).toBe("sliver://app/index.html");
      const cloudWindowActions = registration[9]!;
      expect(await cloudWindowActions.open(identityFor(workspaceWindow))).toEqual({ ok: true });
      const cloudWindow = harness.windows.at(-1)!;
      expect(cloudWindow.options.webPreferences.partition).toBe("sliver-cloud-deployment");
      expect(cloudWindow.webContents.getURL()).toBe("sliver://app/index.html?surface=cloud-deployment");
      expect(harness.hardenedWindows).toContainEqual({
        window: cloudWindow,
        rendererUrl: "sliver://app/index.html",
        utilityUrl: "sliver://app/index.html?surface=cloud-deployment",
      });

      expect(await harness.cloudSshWindows.open("6f0a80ed-bdd5-4ec0-aa53-7ecca9df0010"))
        .toMatchObject({ ok: true, value: { status: "opened" } });
      const sshWindow = sshWindows().at(-1)!;
      expect(sshWindow.webContents.getURL()).toBe("sliver://app/index.html?surface=ssh");

      await application.stop();
      for (const window of [workspaceWindow, networkWindow, reopenedNetworkWindow, cloudWindow, sshWindow]) {
        expect(window.isDestroyed()).toBe(true);
      }
      for (const ownedProtocol of [defaultProtocol, cloudProtocol, networkProtocol]) {
        expect(ownedProtocol.unhandle).toHaveBeenCalledExactlyOnceWith("sliver");
      }

      await application.stop();
      for (const ownedProtocol of [defaultProtocol, cloudProtocol, networkProtocol]) {
        expect(ownedProtocol.unhandle).toHaveBeenCalledExactlyOnceWith("sliver");
      }
      application = undefined;
    } finally {
      await application?.stop();
      vi.unstubAllEnvs();
    }
  });
});

describe("Console application window lifecycle", () => {
  it("retains tabs in a hidden window until explicit tab close or application shutdown", async () => {
    const fixture = await createConsoleLifecycleFixture();
    const { application, actions, workspaceWindow, runtimes, startConsoleRuntime } = fixture;

    try {
      const source = identityFor(workspaceWindow);
      expect(await actions.open(source)).toEqual({ ok: true });
      const consoleWindow = harness.windows.at(-1)!;
      const owner = identityFor(consoleWindow);
      const claimed = await actions.claim(owner);
      expect(claimed).toMatchObject({ ok: true, value: { kind: "console" } });
      const firstTabId = claimed.value!.initialTab.tabId;
      const second = await actions.createTab(owner);
      expect(second.ok).toBe(true);
      expect(startConsoleRuntime).toHaveBeenCalledTimes(2);
      const windowCount = harness.windows.length;

      consoleWindow.close();
      await settleLifecycle();
      expect(consoleWindow.isVisible()).toBe(false);
      expect(consoleWindow.isDestroyed()).toBe(false);
      expect(consoleWindow.hide).toHaveBeenCalledOnce();
      for (const runtime of runtimes) expect(runtime.close).not.toHaveBeenCalled();

      expect(await actions.open(source)).toEqual({ ok: true });
      expect(harness.windows).toHaveLength(windowCount);
      expect(consoleWindow.isVisible()).toBe(true);
      expect(harness.focusedWindow).toBe(consoleWindow);
      expect(startConsoleRuntime).toHaveBeenCalledTimes(2);
      expect(await actions.claim(owner)).toEqual(claimed);

      expect(await actions.closeTab(owner, firstTabId)).toEqual({
        ok: true,
        value: { remainingTabs: 1 },
      });
      expect(runtimes[0]!.close).toHaveBeenCalledOnce();
      expect(runtimes[1]!.close).not.toHaveBeenCalled();

      consoleWindow.close();
      expect(consoleWindow.isVisible()).toBe(false);
      await application.stop();
      expect(consoleWindow.isDestroyed()).toBe(true);
      for (const runtime of runtimes) expect(runtime.close).toHaveBeenCalledOnce();
    } finally {
      await application.stop();
    }
  });

  it("keeps a console hidden when its initial tab finishes starting before ready-to-show", async () => {
    const startup = deferred<ReturnType<typeof fakeRuntime>>();
    const runtime = fakeRuntime();
    const fixture = await createConsoleLifecycleFixture(() => startup.promise);
    const { application, actions, workspaceWindow, startConsoleRuntime } = fixture;

    try {
      harness.suppressReadyToShow = true;
      const source = identityFor(workspaceWindow);
      expect(await actions.open(source)).toEqual({ ok: true });
      const consoleWindow = harness.windows.at(-1)!;
      const claiming = actions.claim(identityFor(consoleWindow));
      await vi.waitFor(() => expect(startConsoleRuntime).toHaveBeenCalledOnce());

      consoleWindow.close();
      expect(consoleWindow.isDestroyed()).toBe(false);
      startup.resolve(runtime);
      expect(await claiming).toMatchObject({ ok: true, value: { kind: "console" } });
      consoleWindow.emit("ready-to-show");
      expect(consoleWindow.isVisible()).toBe(false);
      expect(consoleWindow.show).not.toHaveBeenCalled();
      expect(runtime.close).not.toHaveBeenCalled();

      expect(await actions.open(source)).toEqual({ ok: true });
      expect(consoleWindow.isVisible()).toBe(true);
      expect(startConsoleRuntime).toHaveBeenCalledOnce();
    } finally {
      harness.suppressReadyToShow = false;
      startup.resolve(runtime);
      await application.stop();
    }
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("preserves a hidden console when showing its retained window fails", async () => {
    const { application, actions, workspaceWindow, runtimes, startConsoleRuntime } =
      await createConsoleLifecycleFixture();

    try {
      const source = identityFor(workspaceWindow);
      expect(await actions.open(source)).toEqual({ ok: true });
      const consoleWindow = harness.windows.at(-1)!;
      expect((await actions.claim(identityFor(consoleWindow))).ok).toBe(true);
      consoleWindow.close();
      consoleWindow.show.mockImplementationOnce(() => {
        throw new Error("simulated native window show failure");
      });

      expect(await actions.open(source)).toMatchObject({ ok: false });
      expect(consoleWindow.isDestroyed()).toBe(false);
      expect(consoleWindow.isVisible()).toBe(false);
      expect(runtimes[0]!.close).not.toHaveBeenCalled();
      expect(await actions.open(source)).toEqual({ ok: true });
      expect(consoleWindow.isVisible()).toBe(true);
      expect(startConsoleRuntime).toHaveBeenCalledOnce();
    } finally {
      await application.stop();
    }
    expect(runtimes[0]!.close).toHaveBeenCalledOnce();
  });

  it("shows a hidden console immediately when reopened before its renderer load promise resolves", async () => {
    const { application, actions, workspaceWindow, runtimes, startConsoleRuntime } =
      await createConsoleLifecycleFixture();
    const { BrowserWindow } = await import("electron");
    const loading = deferred<void>();
    const originalLoadURL = BrowserWindow.prototype.loadURL;
    const loadURL = vi.spyOn(BrowserWindow.prototype, "loadURL").mockImplementationOnce(
      async function (this: Electron.BrowserWindow, url, options) {
        await originalLoadURL.call(this, url, options);
        await loading.promise;
      },
    );

    try {
      const source = identityFor(workspaceWindow);
      const opening = actions.open(source);
      const consoleWindow = harness.windows.at(-1)!;
      expect((await actions.claim(identityFor(consoleWindow))).ok).toBe(true);
      expect(consoleWindow.isVisible()).toBe(true);
      const windowCount = harness.windows.length;
      consoleWindow.close();
      expect(consoleWindow.isVisible()).toBe(false);

      const reopening = Promise.resolve(actions.open(source));
      expect(consoleWindow.isVisible()).toBe(true);
      expect(harness.focusedWindow).toBe(consoleWindow);
      expect(harness.windows).toHaveLength(windowCount);
      expect(startConsoleRuntime).toHaveBeenCalledOnce();
      expect(runtimes[0]!.close).not.toHaveBeenCalled();
      let reopened = false;
      void reopening.then(() => { reopened = true; });
      await settleLifecycle();
      expect(reopened).toBe(false);

      loading.resolve();
      expect(await opening).toEqual({ ok: true });
      expect(await reopening).toEqual({ ok: true });
      expect(consoleWindow.isVisible()).toBe(true);
    } finally {
      loading.resolve();
      loadURL.mockRestore();
      await application.stop();
    }
    expect(runtimes[0]!.close).toHaveBeenCalledOnce();
  });

  it("recovers a hidden console on activation after its source closes and destroys an explicitly emptied host", async () => {
    const fixture = await createConsoleLifecycleFixture();
    const { application, actions, workspaceWindow, runtimes, startConsoleRuntime } = fixture;
    const { app } = await import("electron");

    try {
      expect(await actions.open(identityFor(workspaceWindow))).toEqual({ ok: true });
      const consoleWindow = harness.windows.at(-1)!;
      const owner = identityFor(consoleWindow);
      const claimed = await actions.claim(owner);
      expect(claimed.ok).toBe(true);
      const windowCount = harness.windows.length;

      consoleWindow.close();
      workspaceWindow.close();
      await settleLifecycle();
      expect(workspaceWindow.isDestroyed()).toBe(true);
      expect(consoleWindow.isVisible()).toBe(false);
      expect(runtimes[0]!.close).not.toHaveBeenCalled();

      app.emit("activate");
      expect(harness.windows).toHaveLength(windowCount);
      expect(consoleWindow.isVisible()).toBe(true);
      expect(harness.focusedWindow).toBe(consoleWindow);
      expect(startConsoleRuntime).toHaveBeenCalledOnce();
      expect(await actions.closeTab(owner, claimed.value!.initialTab.tabId)).toEqual({
        ok: true,
        value: { remainingTabs: 0 },
      });
      expect(runtimes[0]!.close).toHaveBeenCalledOnce();
      consoleWindow.close();
      expect(consoleWindow.isDestroyed()).toBe(true);
    } finally {
      await application.stop();
    }
    expect(runtimes[0]!.close).toHaveBeenCalledOnce();
  });
});

describe("SSH application window lifecycle", () => {
  it("uses a dedicated trusted surface while sessions survive window replacement and close explicitly", async () => {
    const runtimes = new Map<string, ReturnType<typeof fakeRuntime>>();
    const firstDeploymentId = "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0001";
    const startSshSession = vi.fn(async (deploymentId: string) => {
      const runtime = fakeRuntime();
      runtimes.set(deploymentId, runtime);
      return {
        ok: true as const,
        value: {
          target: managedTarget(
            deploymentId,
            deploymentId === firstDeploymentId ? "azure" : "aws",
          ),
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
      sshPreloadPath: "/test/ssh-preload.cjs",
    });

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
    expect(firstSshWindow.webContents.getURL()).toBe("sliver://app/index.html?surface=ssh");
    expect(harness.hardenedWindows).toContainEqual({
      window: firstSshWindow,
      rendererUrl: "sliver://app/index.html",
      utilityUrl: "sliver://app/index.html?surface=ssh",
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
      value: { tabs: [{ tabId: firstTabId, target: { provider: "azure" } }] },
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

function managedTarget(deploymentId: string, provider: "aws" | "azure" = "aws") {
  return {
    deploymentId,
    name: deploymentId.endsWith("1") ? "test1" : "test2",
    provider,
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
    setManagedServerResolver: vi.fn((_resolve: (digest: string) => ManagedServerReference | null) => undefined),
    setManagedListenerFirewallController: vi.fn(),
    refreshManagedServerMetadata: vi.fn(),
    registerWindow: vi.fn(),
    inheritConnection: vi.fn(),
    snapshot: vi.fn(() => ({
      connection: { status: "connected", epoch: 7, incarnation: 1 },
    })),
    closeWindowStreams: vi.fn(async () => undefined),
    unregisterWindow: vi.fn(async () => undefined),
  };
}

function findTemplateMenuItem(template: readonly any[], id: string): any | undefined {
  for (const item of template) {
    if (item?.id === id) return item;
    if (Array.isArray(item?.submenu)) {
      const nested = findTemplateMenuItem(item.submenu, id);
      if (nested) return nested;
    }
  }
  return undefined;
}

function findTemplateMenuItemByLabel(template: readonly any[], label: string): any | undefined {
  for (const item of template) {
    if (item?.label === label) return item;
    if (Array.isArray(item?.submenu)) {
      const nested = findTemplateMenuItemByLabel(item.submenu, label);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function createConsoleLifecycleFixture(
  startRuntime: () => Promise<ReturnType<typeof fakeRuntime>> = async () => fakeRuntime(),
) {
  const runtimes: ReturnType<typeof fakeRuntime>[] = [];
  const startConsoleRuntime = vi.fn(async (options: { configBytes: Buffer }) => {
    options.configBytes.fill(0);
    const runtime = await startRuntime();
    runtimes.push(runtime);
    return runtime;
  });
  const registry = {
    ...fakeConnectionRegistry(),
    snapshot: vi.fn(() => ({
      connection: { incarnation: 1, configName: "test-console.cfg", status: "connected" },
    })),
    copyActiveConfig: vi.fn(async () => ({
      configName: "test-console.cfg",
      configBytes: Buffer.from("local console lifecycle fixture"),
    })),
  };
  const controller = {
    getSnapshot: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
    getTerminalRuntime: vi.fn(async () => ({ ok: false as const, error: "not needed" })),
    dispose: vi.fn(),
  } as unknown as ApplicationCloudDeploymentController;
  const { startApplication } = await import("./application.js");
  const { registerIpcHandlers } = await import("./ipc.js");
  const application = await startApplication({
    cloudDeploymentController: controller,
    registry: registry as never,
    consolePtyFactory: {} as never,
    startConsoleRuntime: startConsoleRuntime as never,
  });
  const registration = vi.mocked(registerIpcHandlers).mock.calls.at(-1)!;
  return {
    application,
    actions: registration[7]!,
    workspaceWindow: harness.windows.at(-1)!,
    runtimes,
    startConsoleRuntime,
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
