import { ARMORY_IPC_EVENTS, type ArmoryTabId } from "../shared/armory-contracts.js";
import { ArmoryService } from "./armory-service.js";
import { registerArmoryIpcHandlers, unregisterArmoryIpcHandlers } from "./armory-ipc.js";
import { ARMORY_SESSION_PARTITION, armoryWindowOptions } from "./window-options.js";
import { readFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  net,
  nativeTheme,
  protocol,
  safeStorage,
  session,
  shell,
  systemPreferences,
  type MessageEvent as ElectronMessageEvent,
  type MessagePortMain,
} from "electron";

import {
  IPC,
  type OpenSessionShellWindowInput,
  type OperationResult,
  type SliverSnapshot,
  type WindowLaunchContext,
} from "../shared/contracts.js";
import {
  CONSOLE_MAX_TABS_PER_WINDOW,
  type ConsoleAttachRequest,
  type ConsoleTabCloseResult,
  type ConsoleTabLaunchContext,
  type ConsoleCloseReason,
  type ConsoleWindowLaunchContext,
} from "../shared/console-contracts.js";
import type { ApplicationUpdateState } from "../shared/application-update-contracts.js";
import type {
  ApplicationSettingsState,
  ApplicationSettingsUpdateInput,
} from "../shared/application-settings-contracts.js";
import {
  SSH_MAX_TABS_PER_WINDOW,
  type ManagedSshTarget,
  type SshHostKeyReview,
  type SshOpenTabResult,
  type SshWindowLaunchContext,
} from "../shared/ssh-contracts.js";
import type { TargetRef } from "../shared/target-contracts.js";
import {
  NETWORK_FORWARDING_IPC_EVENTS,
  type NetworkTabId,
} from "../shared/network-forwarding-contracts.js";
import type {
  SliverReleaseDownloadEvent,
  SliverReleaseTarget,
} from "../shared/release-contracts.js";
import {
  buildApplicationMenuTemplate,
  commandPaletteShortcutDispositionForInput,
  consoleTabShortcutIndexForInput,
  isApplicationShortcutInput,
  isConsoleNewTabShortcutInput,
  serverRefreshShortcutDispositionForInput,
  type CloudMenuDeployment,
  type ReleaseMenuCatalog,
} from "./application-menus.js";
import {
  KEYBOARD_SHORTCUT_DEFINITIONS,
  keyboardShortcutConflict,
  resolveKeyboardShortcut,
} from "../shared/keyboard-shortcuts.js";
import { ApplicationContextMenuController } from "./application-context-menu.js";
import {
  createApplicationUpdater,
  type ApplicationUpdater,
} from "./application-updater.js";
import { ApplicationShutdownCoordinator } from "./application-shutdown.js";
import { ApplicationSettingsStore } from "./application-settings.js";
import { captureReportScreenshots } from "./report-screenshot.js";
import { TextEditorSettingsStore } from "./text-editor-settings.js";
import { ApplicationIconController } from "./application-icon.js";
import { createSystemIconAppearance } from "./system-icon-appearance.js";
import {
  ConnectionRegistry,
  type ManagedListenerFirewallController,
} from "./connection-registry.js";
import { resolveDownloadsDirectory } from "./download-directory.js";
import {
  registerIpcHandlers,
  unregisterIpcHandlers,
  type TrustedWindowIdentity,
} from "./ipc.js";
import { configureSessionSecurity, hardenWindow, isTrustedRendererUrl, isSameRendererDocument } from "./security.js";
import { installApplicationNavigationSecurity } from "./navigation-security.js";
import { APP_RENDERER_URL, APP_SCHEME, APP_SCHEME_PRIVILEGES, createAppProtocolHandler } from "./app-protocol.js";
import {
  CrackstationReleaseDownloader,
  SliverReleaseDownloader,
} from "./sliver-release-download.js";
import {
  CLOUD_DEPLOYMENT_IPC_EVENTS,
  type CloudDeploymentChangeScope,
  type CloudDeploymentNavigationRequest,
} from "../shared/cloud-deployment-ipc.js";
import {
  registerCloudDeploymentIpcHandlers,
  unregisterCloudDeploymentIpcHandlers,
  type CloudDeploymentController,
} from "./cloud-deployment-ipc.js";
import { CloudDeploymentService } from "./cloud-deployment-service.js";
import { detectCurrentEgressIpv4 } from "./cloud/current-egress-ipv4.js";
import type { MaterializedSshIdentity } from "./ssh-identity-store.js";
import { formatSshCommand } from "./ssh-command.js";
import {
  CLOUD_DEPLOYMENT_SESSION_PARTITION,
  NETWORK_SESSION_PARTITION,
  SCRIPT_TASK_MANAGER_SESSION_PARTITION,
  scriptTaskManagerWindowOptions,
  cloudDeploymentWindowOptions,
  consoleWindowOptions,
  interactionWindowOptions,
  mainWindowOptions,
  nativeWindowBackgroundColor,
  networkWindowOptions,
  sessionShellWindowOptions,
  sshWindowOptions,
  titleBarSymbolColor,
} from "./window-options.js";
import {
  ConsolePortSession,
  type ConsoleAttachmentPort,
} from "./console-port-session.js";
import {
  consoleWindowOpenError,
  type ConsoleWindowOpenFailureKind,
} from "./console-window-open-errors.js";
import {
  SliverConsoleRuntime,
  type NativePtyFactory,
} from "./console-runtime.js";
import {
  registerSshIpcHandlers,
  SSH_IPC_EVENTS,
  unregisterSshIpcHandlers,
} from "./ssh-ipc.js";
import {
  SshSessionRegistry,
  type StartedManagedSshSession,
} from "./ssh-session-registry.js";
import {
  registerNetworkForwardingIpcHandlers,
  unregisterNetworkForwardingIpcHandlers,
} from "./network-forwarding-ipc.js";

import { ScriptTaskManagerRelay } from "./script-task-manager.js";
import { registerScriptTaskManagerIpc, unregisterScriptTaskManagerIpc } from "./script-task-manager-ipc.js";
import type { ScriptSummary } from "../shared/script-contracts.js";
import { ScriptStore } from "./script-store.js";
import { ScriptEditorCloseGuard } from "./script-editor-close-guard.js";
import { confirmDiscardScriptChanges } from "./script-editor-close-dialog.js";
import { exportScriptFile, importScriptFile } from "./script-file-dialogs.js";
import { RemoteTextEditorError, TextEditorWindows } from "./text-editor-windows.js";
import { TEXT_EDITOR_SESSION_PARTITION } from "./window-options.js";

const APPLICATION_DISPLAY_NAME = "Sliver Desktop";
const APPLICATION_SETTINGS_FILE_NAME = "application-settings.json";
const TEXT_EDITOR_SETTINGS_FILE_NAME = "text-editor-settings.json";

// Scheme privileges must be declared synchronously before Electron is ready,
// including when a test entry imports this application module.
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }]);

type NativeWindowSurface =
  | "armory"
  | "workspace"
  | "cloud-deployment"
  | "interaction"
  | "managed-shells"
  | "console"
  | "network"
  | "script-task-manager"
  | "text-editor"
  | "ssh";

export interface StartApplicationOptions {
  registry?: ConnectionRegistry;
  rendererEntryPath?: string;
  preloadPath?: string;
  cloudDeploymentPreloadPath?: string;
  networkPreloadPath?: string;
  armoryPreloadPath?: string;
  sshPreloadPath?: string;
  scriptTaskManagerPreloadPath?: string;
  textEditorPreloadPath?: string;
  applicationAssetsDirectory?: string;
  consoleClientExecutable?: string;
  consoleClientRootDirectory?: string;
  consolePtyFactory?: NativePtyFactory;
  startConsoleRuntime?: typeof SliverConsoleRuntime.start;
  /** Test/embedding override. Production creates the main-owned service. */
  cloudDeploymentController?: ApplicationCloudDeploymentController;
}

export interface ApplicationCloudDeploymentController
  extends CloudDeploymentController, ManagedListenerFirewallController {
  subscribe?(listener: (scope: CloudDeploymentChangeScope) => void): () => void;
  dispose?(): void;
  listSshTargets?(): Promise<OperationResult<readonly ManagedSshTarget[]>>;
  startSshSession?(
    deploymentId: string,
  ): Promise<OperationResult<StartedManagedSshSession | SshHostKeyReview>>;
  approveSshHostKey?(token: string): Promise<OperationResult<StartedManagedSshSession>>;
  materializeSshIdentity?(
    target: ManagedSshTarget,
  ): Promise<OperationResult<MaterializedSshIdentity>>;
}

export interface ApplicationHandle {
  createWindow(inheritFromContentsId?: number): BrowserWindow;
  stop(): Promise<void>;
}

interface SessionShellWindowRecord {
  readonly key: string;
  readonly window: BrowserWindow;
  readonly source: TrustedWindowIdentity;
  readonly target: TargetRef;
  preferredResourceId?: string;
  claimedBy?: TrustedWindowIdentity;
  claimedContext?: WindowLaunchContext;
  finalizing: boolean;
}

interface InteractionWindowRecord {
  readonly window: BrowserWindow;
  readonly source: TrustedWindowIdentity;
  target: TargetRef;
  connectionIncarnation: number;
  claimedBy?: TrustedWindowIdentity;
  generation: number;
  transition: Promise<void>;
}

interface ConsoleWindowRecord {
  readonly key: string;
  readonly window: BrowserWindow;
  readonly source: TrustedWindowIdentity;
  readonly connectionIncarnation: number;
  claimedBy?: TrustedWindowIdentity;
  claimedContext?: ConsoleWindowLaunchContext;
  claimingBy?: TrustedWindowIdentity;
  claimPromise?: Promise<OperationResult<ConsoleWindowLaunchContext>>;
  openPromise?: Promise<OperationResult>;
  closePromise?: Promise<void>;
  configName?: string;
  readonly tabsById: Map<string, ConsoleTabRecord>;
  readonly tabsByAttachmentToken: Map<string, ConsoleTabRecord>;
  nextTabOrdinal: number;
  hiddenByUser: boolean;
  finalizing: boolean;
}

interface ConsoleTabRecord {
  readonly id: string;
  readonly ordinal: number;
  startPromise?: Promise<StartedConsoleTab>;
  closePromise?: Promise<void>;
  runtime?: SliverConsoleRuntime;
  portSession?: ConsolePortSession;
  finalizing: boolean;
}

interface StartedConsoleTab {
  readonly context: ConsoleTabLaunchContext;
  readonly configName: string;
}

interface NetworkWindowRecord {
  readonly key: string;
  readonly contentsId: number;
  readonly window: BrowserWindow;
  readonly source: TrustedWindowIdentity;
  readonly connectionIncarnation: number;
  rendererReady: boolean;
  pendingTab?: NetworkTabId;
}

/**
 * Compose the trusted Electron main process. Tests may inject an in-memory
 * backend by importing this module from a test-only main entry; the production
 * entrypoint always uses the real ConnectionRegistry defaults.
 */
export async function startApplication(options: StartApplicationOptions = {}): Promise<ApplicationHandle> {
  // Install synchronously before any windows, sessions, or asynchronous startup.
  const preloadPath = options.preloadPath ?? join(import.meta.dirname, "../preload/index.cjs");
  installApplicationNavigationSecurity(app, join(dirname(preloadPath), "navigation.cjs"));
  const mainBundleDirectory = import.meta.dirname;
  const applicationAssetsDirectory = options.applicationAssetsDirectory ?? join(mainBundleDirectory, "../../build");
  const runtimeIconPath = app.isPackaged
    ? join(process.resourcesPath, "sliver-desktop.png")
    : join(applicationAssetsDirectory, "about-icon.png");
  const applicationIcons = new ApplicationIconController({
    platform: process.platform,
    assetsDirectory: app.isPackaged ? join(process.resourcesPath, "app-icons") : applicationAssetsDirectory,
    ...(process.platform === "darwin" ? { setDockIcon: (path: string) => app.dock?.setIcon(path) } : {}),
  });
  const systemIconAppearance = createSystemIconAppearance({ nativeTheme, systemPreferences });
  const rendererEntryPath = options.rendererEntryPath ?? join(mainBundleDirectory, "../renderer/index.html");
  const cloudDeploymentPreloadPath = options.cloudDeploymentPreloadPath ?? join(
    mainBundleDirectory,
    "../preload/cloud-deployment.cjs",
  );
  const armoryPreloadPath = options.armoryPreloadPath ?? join(mainBundleDirectory, "../preload/armory.cjs");
  const networkPreloadPath = options.networkPreloadPath ?? join(
    mainBundleDirectory,
    "../preload/network.cjs",
  );
  const sshPreloadPath = options.sshPreloadPath ?? join(
    mainBundleDirectory,
    "../preload/ssh.cjs",
  );
  const scriptTaskManagerPreloadPath = options.scriptTaskManagerPreloadPath ?? join(mainBundleDirectory, "../preload/script-task-manager.cjs");
  const consoleClientExecutable = options.consoleClientExecutable ?? resolveConsoleClientExecutable(
    app.isPackaged,
    process.resourcesPath,
    mainBundleDirectory,
    process.platform,
  );
  const consoleClientRootDirectory = resolve(options.consoleClientRootDirectory ?? (process.env["SLIVER_CLIENT_ROOT_DIR"] || undefined) ?? join(
    homedir(),
    ".sliver-client",
  ));
  const registry = options.registry ?? new ConnectionRegistry({
    savedConfigDirectory: join(consoleClientRootDirectory, "configs"),
    managedConfigDirectory: join(consoleClientRootDirectory, "gui"),
  });
  const startConsoleRuntime = options.startConsoleRuntime ?? SliverConsoleRuntime.start;
  // Every application build uses the bundled protocol entry. Environment
  // variables must never redirect renderer navigation or IPC trust.
  const rendererUrl = APP_RENDERER_URL;
  let initializedWorkspaceZoom = false;
  const cloudDeploymentRendererUrl = rendererUrlForSurface(rendererUrl, "cloud-deployment");
  const armoryRendererUrl = rendererUrlForSurface(rendererUrl, "armory");
  const armoryService = new ArmoryService({ rootPath: consoleClientRootDirectory });
  let armoryWindow: BrowserWindow | undefined;
  let armoryTab: ArmoryTabId = "manage";
  let armoryRendererReady = false;
  const networkRendererUrl = rendererUrlForSurface(rendererUrl, "network");
  const sshRendererUrl = rendererUrlForSurface(rendererUrl, "ssh");
  const scriptTaskManagerRendererUrl = rendererUrlForSurface(rendererUrl, "script-task-manager");
  const textEditorRendererUrl = rendererUrlForSurface(rendererUrl, "text-editor");
  const windows = new Set<BrowserWindow>();
  const nativeWindowSurfaces = new Map<BrowserWindow, NativeWindowSurface>();
  const windowsByContentsId = new Map<number, BrowserWindow>();
  const scriptManagerWindows = new Map<number, { window: BrowserWindow; owner: TrustedWindowIdentity }>();
  const openingScriptManagers = new Map<number, Promise<OperationResult>>();
  const scriptTaskRelay = new ScriptTaskManagerRelay((contentsId, channel, ...payload) => {
    const window = windowsByContentsId.get(contentsId);
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    try { window.webContents.send(channel, ...payload); } catch { /* A retiring document cannot receive relay data. */ }
  });
  let scriptMenuCatalog: ScriptSummary[] = [];
  let scriptMenuRefresh = 0;
  const scriptCloseGuard = new ScriptEditorCloseGuard((contentsIds) => confirmDiscardScriptChanges(contentsIds, {
    getWindow: (id) => {
      const window = windowsByContentsId.get(id);
      return window && nativeWindowSurfaces.get(window) === "workspace" ? window : undefined;
    },
    getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
    showDialog: (owner) => {
      const prompt = {
        type: "warning" as const,
        title: "Unsaved scripts",
        message: "Discard unsaved script changes?",
        detail: "Your unsaved editor drafts will be lost. Saved scripts remain on disk.",
        buttons: ["Keep Editing", "Discard Changes"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      return owner ? dialog.showMessageBoxSync(owner, prompt) : dialog.showMessageBoxSync(prompt);
    },
  }));
  // Native Scripts menu and the editor share the main-owned saved catalog.
  const scriptStore = new ScriptStore(join(consoleClientRootDirectory, "gui", "scripts"), () => {
    for (const window of windows) {
      if (window.isDestroyed() || window.webContents.isDestroyed() || nativeWindowSurfaces.get(window) !== "workspace") continue;
      try { window.webContents.send(IPC.scriptsChanged); } catch { /* A closing window reloads the catalog on its next visit. */ }
    }
    void refreshScriptMenu();
  });
  const sessionShellWindowsByKey = new Map<string, SessionShellWindowRecord>();
  const sessionShellWindowsByContentsId = new Map<number, SessionShellWindowRecord>();
  const interactionWindowsByContentsId = new Map<number, InteractionWindowRecord>();
  const consoleWindowsByKey = new Map<string, ConsoleWindowRecord>();
  const consoleWindowsByContentsId = new Map<number, ConsoleWindowRecord>();
  const networkWindowsByKey = new Map<string, NetworkWindowRecord>();
  const networkWindowsByContentsId = new Map<number, NetworkWindowRecord>();
  let cloudDeploymentWindow: BrowserWindow | undefined;
  let cloudDeploymentRendererReady = false;
  let pendingCloudDeploymentNavigationRequest: CloudDeploymentNavigationRequest | undefined;
  const pendingWindowCleanup = new Set<Promise<void>>();
  let releaseCatalog: ReleaseMenuCatalog = { status: "loading" };
  let releaseDownloader: SliverReleaseDownloader | undefined;
  let crackstationReleaseCatalog: ReleaseMenuCatalog = { status: "loading" };
  let crackstationReleaseDownloader: CrackstationReleaseDownloader | undefined;
  let applicationUpdater: ApplicationUpdater | undefined;
  let applicationUpdateState: ApplicationUpdateState | undefined;
  let applicationSettingsStore: ApplicationSettingsStore | undefined;
  let textEditorWindows: TextEditorWindows | undefined;
  const shortcutRecordingWindows = new Set<BrowserWindow>();
  let applicationContextMenus: ApplicationContextMenuController | undefined;
  let cloudDeploymentController = options.cloudDeploymentController;
  let sshWindow: BrowserWindow | undefined;
  let sshWindowClaimedBy: TrustedWindowIdentity | undefined;
  let sshWindowClaimChain: Promise<void> = Promise.resolve();
  let sshSessions: SshSessionRegistry | undefined;
  let cloudMenuDeployments: readonly CloudMenuDeployment[] = [];
  let cloudDeploymentMenuSignature = "[]";
  let cloudDeploymentMenuRefreshSequence = 0;
  let unsubscribeCloudDeployment: (() => void) | undefined;
  let cloudDeploymentDisposed = false;
  const shutdown = new ApplicationShutdownCoordinator({
    stopReleaseDownloads: () => {
      releaseDownloader?.stop();
      crackstationReleaseDownloader?.stop();
    },
    disposeApplicationUpdater: () => applicationUpdater?.dispose(),
  });

  function publishCloudDeploymentChanged(scope: CloudDeploymentChangeScope): void {
    if (shutdown.isStopping) return;
    if (scope === "snapshot") {
      registry.refreshManagedServerMetadata();
      void refreshCloudDeploymentMenu();
    }
    const window = cloudDeploymentWindow;
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      nativeWindowSurfaces.get(window) !== "cloud-deployment"
    ) return;
    try {
      window.webContents.send(CLOUD_DEPLOYMENT_IPC_EVENTS.changed, scope);
    } catch {
      // The window may be navigating or closing; it reads a fresh snapshot on
      // the next trusted load.
    }
  }

  function flushCloudDeploymentNavigation(window: BrowserWindow): void {
    const request = pendingCloudDeploymentNavigationRequest;
    if (
      !request ||
      !cloudDeploymentRendererReady ||
      window !== cloudDeploymentWindow ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    ) return;
    try {
      window.webContents.send(CLOUD_DEPLOYMENT_IPC_EVENTS.navigationRequested, request);
      if (pendingCloudDeploymentNavigationRequest === request) {
        pendingCloudDeploymentNavigationRequest = undefined;
      }
    } catch {
      // Retain the latest request for the next trusted renderer load/focus.
    }
  }

  function disposeCloudDeployment(): void {
    if (cloudDeploymentDisposed) return;
    cloudDeploymentDisposed = true;
    unsubscribeCloudDeployment?.();
    unsubscribeCloudDeployment = undefined;
    cloudDeploymentController?.dispose?.();
  }

  async function loadRenderer(
    window: BrowserWindow,
    surface?: "armory" | "cloud-deployment" | "console" | "interaction" | "managed-shells" | "network" | "ssh" | "script-task-manager",
  ): Promise<void> {
    const url = new URL(rendererUrl);
    if (surface) url.searchParams.set("surface", surface);
    await window.loadURL(url.href);
  }

  function trackWindow(
    window: BrowserWindow,
    inheritFromContentsId?: number,
    sessionShellRecord?: SessionShellWindowRecord,
    interactionWindowRecord?: InteractionWindowRecord,
    consoleWindowRecord?: ConsoleWindowRecord,
    explicitSurface?: NativeWindowSurface,
    registerWithConnectionRegistry = true,
  ): void {
    const contentsId = window.webContents.id;
    const surface: NativeWindowSurface = explicitSurface ?? (
      consoleWindowRecord
        ? "console"
        : interactionWindowRecord
          ? "interaction"
          : sessionShellRecord
            ? "managed-shells"
            : "workspace"
    );
    const retireFailedCloudDeploymentWindow = (): void => {
      if (surface !== "cloud-deployment") return;
      if (cloudDeploymentWindow === window) cloudDeploymentWindow = undefined;
      if (!window.isDestroyed()) window.destroy();
    };
    windows.add(window);
    nativeWindowSurfaces.set(window, surface);
    windowsByContentsId.set(contentsId, window);
    applyNativeThemeToWindow(window, surface);
    if (registerWithConnectionRegistry) {
      registry.registerWindow(contentsId);
      if (inheritFromContentsId !== undefined) registry.inheritConnection(inheritFromContentsId, contentsId);
    }

    hardenWindow(
      window,
      rendererUrl,
      surface === "armory"
        ? armoryRendererUrl
        : surface === "cloud-deployment"
        ? cloudDeploymentRendererUrl
        : surface === "network"
          ? networkRendererUrl
        : surface === "script-task-manager"
          ? scriptTaskManagerRendererUrl
        : surface === "text-editor"
          ? textEditorRendererUrl
        : surface === "ssh"
          ? sshRendererUrl
          : undefined,
    );
    if (!applicationContextMenus) throw new Error("Application context menus are not initialized");
    applicationContextMenus.install(window.webContents);
    if (registerWithConnectionRegistry && surface !== "network") window.webContents.on("before-input-event", (event, input) => {
      if (shortcutRecordingWindows.has(window)) return;
      const commandPaletteDisposition = applicationSettingsStore
        ? commandPaletteShortcutDispositionForInput(
            process.platform,
            applicationSettingsStore.getState().commandPaletteShortcut,
            input,
          )
        : undefined;
      if (!commandPaletteDisposition) return;

      // Claim the configured application chord before an embedded terminal can
      // interpret it as PTY input. Utility windows return to their trusted
      // source workspace instead of gaining generic navigation capabilities.
      event.preventDefault();
      if (commandPaletteDisposition !== "request") return;
      const sourceContentsId = sessionShellRecord?.source.contentsId ??
        interactionWindowRecord?.source.contentsId ??
        consoleWindowRecord?.source.contentsId;
      const paletteWindow = sourceContentsId === undefined
        ? window
        : windowsByContentsId.get(sourceContentsId);
      if (!paletteWindow || paletteWindow.isDestroyed() || paletteWindow.webContents.isDestroyed()) return;
      if (paletteWindow !== window) {
        paletteWindow.show();
        paletteWindow.focus();
      }
      paletteWindow.webContents.send(IPC.commandPaletteRequested);
    });
    if (surface === "workspace") {
      window.webContents.on("before-input-event", (event, input) => {
        if (shortcutRecordingWindows.has(window)) return;
        const disposition = serverRefreshShortcutDispositionForInput(input, process.platform, applicationSettingsStore?.getState());
        if (!disposition) return;
        // Refresh reconciles the trusted snapshot. An unassigned F5 stays
        // suppressed so it cannot reload the renderer and tear down UI state.
        event.preventDefault();
        if (disposition === "refresh") {
          void registry.refresh(contentsId).catch(() => undefined);
        }
      });
    }
    if (consoleWindowRecord) {
      window.webContents.on("before-input-event", (event, input) => {
        const settings = applicationSettingsStore?.getState();
        const index = consoleTabShortcutIndexForInput(process.platform, input, settings);
        const requestsNewTab = isConsoleNewTabShortcutInput(process.platform, input, settings);
        const requestsCloseTab = isApplicationShortcutInput("terminalCloseTab", process.platform, input, settings);
        const requestsSettings = isApplicationShortcutInput("terminalSettings", process.platform, input, settings);
        const requestsCloseWindow = isApplicationShortcutInput("terminalCloseWindow", process.platform, input, settings);
        if (
          (index === undefined && !requestsNewTab && !requestsCloseTab && !requestsSettings && !requestsCloseWindow) ||
          !isClaimedConsoleWindow(consoleWindowRecord)
        ) return;
        // Ghostty consumes terminal key events before Electron's menu accelerator
        // dispatch. This trusted event originates from this exact webContents,
        // so claim the chord before it reaches the renderer or its PTY.
        event.preventDefault();
        if (input.isAutoRepeat) return;
        if (requestsNewTab) {
          sendConsoleMenuEventFromInput(consoleWindowRecord, IPC.consoleNewTabRequested);
        } else if (requestsCloseTab) {
          sendConsoleMenuEventFromInput(consoleWindowRecord, IPC.consoleCloseTabRequested);
        } else if (requestsSettings) {
          sendConsoleMenuEventFromInput(consoleWindowRecord, IPC.consoleSettingsRequested);
        } else if (requestsCloseWindow) {
          window.close();
        } else if (index !== undefined) {
          sendConsoleTabSelectionFromInput(consoleWindowRecord, index);
        }
      });
    }
    window.on("focus", installMenu);
    window.on("blur", () => stopKeyboardShortcutRecording(window));
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) stopKeyboardShortcutRecording(window);
    });
    window.webContents.on("render-process-gone", () => stopKeyboardShortcutRecording(window));
    window.once("ready-to-show", () => {
      if (!consoleWindowRecord?.hiddenByUser) window.show();
    });
    let completedInitialLoad = false;
    window.webContents.once("did-finish-load", () => {
      completedInitialLoad = true;
    });
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        if (registerWithConnectionRegistry) {
          void registry.closeWindowStreams(contentsId, "navigation").catch(() => undefined);
        }
        if (surface === "workspace" && completedInitialLoad) retireScriptHost(contentsId);
        if (sessionShellRecord && completedInitialLoad) retireSessionShellWindow(sessionShellRecord);
        if (interactionWindowRecord && completedInitialLoad) resetInteractionWindowClaim(interactionWindowRecord);
        if (consoleWindowRecord && completedInitialLoad) retireConsoleWindow(consoleWindowRecord, "navigation");
      }
    });
    window.webContents.on("render-process-gone", () => {
      if (surface === "workspace") retireScriptHost(contentsId);
      if (registerWithConnectionRegistry) {
        void registry.closeWindowStreams(contentsId, "renderer-gone").catch(() => undefined);
      }
      if (sessionShellRecord) retireSessionShellWindow(sessionShellRecord);
      if (interactionWindowRecord) resetInteractionWindowClaim(interactionWindowRecord);
      if (consoleWindowRecord) retireConsoleWindow(consoleWindowRecord, "renderer-gone");
      retireFailedCloudDeploymentWindow();
    });
    window.webContents.on("did-fail-load", (_event, _errorCode, _errorDescription, _url, isMainFrame) => {
      if (sessionShellRecord && isMainFrame) retireSessionShellWindow(sessionShellRecord);
      if (interactionWindowRecord && isMainFrame) resetInteractionWindowClaim(interactionWindowRecord);
      if (consoleWindowRecord && isMainFrame) retireConsoleWindow(consoleWindowRecord, "renderer-gone");
      if (isMainFrame) retireFailedCloudDeploymentWindow();
    });
    window.webContents.on("destroyed", () => {
      if (registerWithConnectionRegistry) {
        void registry.closeWindowStreams(contentsId, "renderer-gone").catch(() => undefined);
      }
    });
    if (consoleWindowRecord) {
      window.on("close", (event) => {
        if (
          shutdown.isStopping || scriptCloseGuard.isQuitRequested ||
          consoleWindowRecord.finalizing ||
          (consoleWindowRecord.tabsById.size === 0 && !consoleWindowRecord.claimPromise)
        ) return;
        // Keep the renderer and its terminals intact, including scrollback,
        // unfinished input, tab names and selection. Only an explicit tab
        // close (or application teardown) should stop a live console client.
        event.preventDefault();
        consoleWindowRecord.hiddenByUser = true;
        window.hide();
      });
    }
    if (sessionShellRecord) {
      window.on("close", (event) => {
        if (
          shutdown.isStopping || scriptCloseGuard.isQuitRequested ||
          sessionShellRecord.finalizing ||
          !sessionShellRecord.claimedBy
        ) return;
        event.preventDefault();
        sessionShellRecord.finalizing = true;
        void returnSessionShellWindow(sessionShellRecord).then((returned) => {
          if (returned || !sourceCanReceiveSessionShells(sessionShellRecord)) {
            if (!window.isDestroyed()) window.destroy();
            return;
          }
          sessionShellRecord.finalizing = false;
          if (window.isDestroyed()) return;
          window.show();
          window.focus();
          void dialog.showMessageBox(window, {
            type: "warning",
            title: "Managed shells are still open",
            message: "Managed shells could not be returned to the session workspace.",
            detail: "The source window does not currently have enough managed-shell capacity. Close an unneeded source shell, then close this window again.",
            buttons: ["OK"],
            defaultId: 0,
            noLink: true,
          });
        }).catch(() => {
          if (!window.isDestroyed()) window.destroy();
        });
      });
    }
    window.on("closed", () => {
      if (surface === "workspace") retireScriptHost(contentsId);
      scriptCloseGuard.forget(contentsId);
      shortcutRecordingWindows.delete(window);
      windows.delete(window);
      nativeWindowSurfaces.delete(window);
      windowsByContentsId.delete(contentsId);
      if (sessionShellRecord) {
        sessionShellWindowsByContentsId.delete(contentsId);
        if (sessionShellWindowsByKey.get(sessionShellRecord.key) === sessionShellRecord) {
          sessionShellWindowsByKey.delete(sessionShellRecord.key);
        }
      }
      if (interactionWindowRecord && interactionWindowsByContentsId.get(contentsId) === interactionWindowRecord) {
        interactionWindowsByContentsId.delete(contentsId);
      }
      if (consoleWindowRecord) {
        consoleWindowsByContentsId.delete(contentsId);
        if (consoleWindowsByKey.get(consoleWindowRecord.key) === consoleWindowRecord) {
          consoleWindowsByKey.delete(consoleWindowRecord.key);
        }
      }
      const networkWindowRecord = networkWindowsByContentsId.get(contentsId);
      if (networkWindowRecord) retireNetworkWindow(networkWindowRecord);
      const cleanup = Promise.all([
        registerWithConnectionRegistry
          ? registry.unregisterWindow(contentsId).catch(() => undefined)
          : Promise.resolve(),
        consoleWindowRecord
          ? closeConsoleWindow(consoleWindowRecord, "window-closed")
          : Promise.resolve(),
      ]).then(() => undefined);
      pendingWindowCleanup.add(cleanup);
      void cleanup.finally(() => pendingWindowCleanup.delete(cleanup));
      if (!shutdown.isStopping) setTimeout(installMenu, 0);
    });
  }

  function createWindow(inheritFromContentsId?: number): BrowserWindow {
    const window = new BrowserWindow(mainWindowOptions(
      preloadPath,
      process.platform,
      applicationIcons.getIconPath(),
      nativeTheme.shouldUseDarkColors,
    ));
    trackWindow(window, inheritFromContentsId);
    window.webContents.once("dom-ready", () => {
      if (initializedWorkspaceZoom) return;
      initializedWorkspaceZoom = true;
      // Restore 100% after Chromium applies any saved per-origin zoom. Do this
      // once per launch so reloads and additional windows preserve manual zoom.
      window.webContents.setZoomFactor(1);
    });
    window.on("close", (event) => {
      if (!scriptCloseGuard.allowClose(window.webContents.id)) event.preventDefault();
    });
    window.webContents.on("will-prevent-unload", (event) => {
      // Electron defaults to retaining the document. preventDefault here means
      // the operator explicitly approved discarding this beforeunload veto.
      if (scriptCloseGuard.allowClose(window.webContents.id, true)) event.preventDefault();
    });
    window.webContents.on("did-finish-load", () => {
      scriptCloseGuard.forget(window.webContents.id);
      scriptTaskRelay.registerOwner(window.webContents.id);
    });
    void loadRenderer(window);
    return window;
  }

  function retireScriptHost(ownerId: number): void {
    const managerId = scriptTaskRelay.removeOwner(ownerId);
    if (managerId === undefined) return;
    const record = scriptManagerWindows.get(managerId);
    scriptManagerWindows.delete(managerId);
    if (record && !record.window.isDestroyed()) record.window.destroy();
  }

  function scriptWorkspace(sourceWindow?: BrowserWindow): BrowserWindow {
    const focused = sourceWindow ?? BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed() && !focused.webContents.isDestroyed()) {
      if (nativeWindowSurfaces.get(focused) === "workspace") return focused;
      const record = scriptManagerWindows.get(focused.webContents.id);
      const owner = record && windowsByContentsId.get(record.owner.contentsId);
      if (record && owner && sameWindowIdentity(record.owner, identityForWindow(owner))) return owner;
    }
    return [...windows].reverse().find((window) => nativeWindowSurfaces.get(window) === "workspace" &&
      !window.isDestroyed() && !window.webContents.isDestroyed()) ?? createWindow();
  }

  async function readyScriptWorkspace(sourceWindow?: BrowserWindow): Promise<BrowserWindow> {
    const owner = scriptWorkspace(sourceWindow);
    if (!isSameRendererDocument(owner.webContents.getURL(), rendererUrl) || owner.webContents.isLoadingMainFrame()) {
      await new Promise<void>((resolveReady, reject) => {
        const contents = owner.webContents;
        const dispose = (): void => {
          clearTimeout(timeout);
          contents.removeListener("did-finish-load", ready);
          contents.removeListener("destroyed", failed);
          contents.removeListener("render-process-gone", failed);
        };
        const ready = (): void => { dispose(); resolveReady(); };
        const failed = (): void => { dispose(); reject(new Error("The script workspace closed while loading")); };
        const timeout = setTimeout(failed, 15_000);
        contents.once("did-finish-load", ready);
        contents.once("destroyed", failed);
        contents.once("render-process-gone", failed);
      });
    }
    if (owner.isDestroyed() || owner.webContents.isDestroyed() || !isSameRendererDocument(owner.webContents.getURL(), rendererUrl)) {
      throw new Error("The script workspace is unavailable");
    }
    scriptTaskRelay.registerOwner(owner.webContents.id);
    return owner;
  }

  async function openScriptTaskManager(sourceWindow?: BrowserWindow): Promise<OperationResult> {
    if (shutdown.isStopping) return { ok: false, error: "Script Task Manager is unavailable while the application is closing" };
    try {
      const owner = await readyScriptWorkspace(sourceWindow);
      if (shutdown.isStopping) return { ok: false, error: "Script Task Manager is unavailable while the application is closing" };
      const ownerId = owner.webContents.id;
      const opening = openingScriptManagers.get(ownerId);
      if (opening) return await opening;
      const pending = createScriptTaskManager(owner);
      openingScriptManagers.set(ownerId, pending);
      try { return await pending; } finally {
        if (openingScriptManagers.get(ownerId) === pending) openingScriptManagers.delete(ownerId);
      }
    } catch (error) {
      return { ok: false, error: applicationErrorMessage(error, "Script Task Manager could not be opened") };
    }
  }

  async function createScriptTaskManager(owner: BrowserWindow): Promise<OperationResult> {
    const ownerIdentity = identityForWindow(owner);
    if (!ownerIdentity) throw new Error("The script workspace is unavailable");
    const existingId = scriptTaskRelay.managerForOwner(ownerIdentity.contentsId);
    const existing = existingId === undefined ? undefined : scriptManagerWindows.get(existingId);
    if (existing && !existing.window.isDestroyed() && !existing.window.webContents.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.show();
      existing.window.focus();
      return { ok: true };
    }
    if (existingId !== undefined) scriptTaskRelay.detachManager(existingId);
    const window = new BrowserWindow(scriptTaskManagerWindowOptions(
      scriptTaskManagerPreloadPath, process.platform, applicationIcons.getIconPath(), nativeTheme.shouldUseDarkColors,
    ));
    const managerId = window.webContents.id;
    const record = { window, owner: ownerIdentity };
    scriptManagerWindows.set(managerId, record);
    window.on("closed", () => {
      if (scriptManagerWindows.get(managerId) === record) scriptManagerWindows.delete(managerId);
      scriptTaskRelay.detachManager(managerId);
    });
    window.webContents.on("render-process-gone", () => { if (!window.isDestroyed()) window.destroy(); });
    window.webContents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame && !window.isDestroyed()) window.destroy();
    });
    try {
      trackWindow(window, undefined, undefined, undefined, undefined, "script-task-manager", false);
      scriptTaskRelay.attachManager(ownerIdentity.contentsId, managerId);
      await loadRenderer(window, "script-task-manager");
      if (window.isDestroyed() || !sameWindowIdentity(ownerIdentity, identityForWindow(owner))) throw new Error("The script workspace closed while loading");
      window.setTitle("Script Task Manager");
      window.show();
      window.focus();
      return { ok: true };
    } catch (error) {
      scriptTaskRelay.detachManager(managerId);
      scriptManagerWindows.delete(managerId);
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  async function editScriptFromMenu(id: string, sourceWindow?: BrowserWindow): Promise<OperationResult> {
    if (shutdown.isStopping) return { ok: false, error: "The script editor is unavailable while the application is closing" };
    try {
      // Recheck disk availability because native menu items may outlive a catalog refresh.
      await scriptStore.read({ id });
      const owner = await readyScriptWorkspace(sourceWindow);
      if (shutdown.isStopping) return { ok: false, error: "The script editor is unavailable while the application is closing" };
      if (owner.isMinimized()) owner.restore();
      owner.show();
      owner.focus();
      scriptTaskRelay.requestEdit(owner.webContents.id, id);
      return { ok: true };
    } catch (error) {
      void refreshScriptMenu();
      return { ok: false, error: applicationErrorMessage(error, "The script could not be opened") };
    }
  }

  function reportScriptMenuError(result: OperationResult): void {
    if (!result.ok && !shutdown.isStopping) dialog.showErrorBox("Scripts unavailable", result.error);
  }

  async function refreshScriptMenu(): Promise<void> {
    const request = ++scriptMenuRefresh;
    try {
      const catalog = await scriptStore.list();
      if (request !== scriptMenuRefresh || shutdown.isStopping) return;
      scriptMenuCatalog = catalog.scripts;
      installMenu();
    } catch {
      if (request !== scriptMenuRefresh || shutdown.isStopping) return;
      scriptMenuCatalog = [];
      installMenu();
    }
  }

  function publishArmoryChanged(): void {
    if (shutdown.isStopping || !armoryWindow || armoryWindow.isDestroyed() || armoryWindow.webContents.isDestroyed()) return;
    try { armoryWindow.webContents.send(ARMORY_IPC_EVENTS.changed); } catch { /* Closing renderer. */ }
  }

  async function openArmoryWindow(tab: ArmoryTabId): Promise<void> {
    if (shutdown.isStopping) return;
    armoryTab = tab;
    let createdWindow: BrowserWindow | undefined;
    try {
      if (armoryWindow && !armoryWindow.isDestroyed() && !armoryWindow.webContents.isDestroyed()) {
        if (armoryWindow.isMinimized()) armoryWindow.restore();
        armoryWindow.show();
        armoryWindow.focus();
        if (armoryRendererReady) armoryWindow.webContents.send(ARMORY_IPC_EVENTS.navigationRequested, armoryTab);
        return;
      }
      const window = new BrowserWindow(armoryWindowOptions(
        armoryPreloadPath, process.platform, applicationIcons.getIconPath(), nativeTheme.shouldUseDarkColors,
      ));
      createdWindow = armoryWindow = window;
      armoryRendererReady = false;
      window.on("closed", () => {
        if (armoryWindow === window) { armoryWindow = undefined; armoryRendererReady = false; }
      });
      window.webContents.on("did-start-loading", () => { if (armoryWindow === window) armoryRendererReady = false; });
      window.webContents.on("did-finish-load", () => {
        if (armoryWindow !== window || window.isDestroyed() || window.webContents.isDestroyed()) return;
        armoryRendererReady = true;
        window.setTitle("Armory");
        window.webContents.send(ARMORY_IPC_EVENTS.navigationRequested, armoryTab);
      });
      window.webContents.on("render-process-gone", () => { if (!window.isDestroyed()) window.destroy(); });
      trackWindow(window, undefined, undefined, undefined, undefined, "armory", false);
      await loadRenderer(window, "armory");
    } catch {
      if (armoryWindow === createdWindow) armoryWindow = undefined;
      if (createdWindow && !createdWindow.isDestroyed()) createdWindow.destroy();
      if (!shutdown.isStopping) dialog.showErrorBox("Armory unavailable", "The Armory window could not be opened");
    }
  }

  function flushNetworkNavigation(record: NetworkWindowRecord): void {
    const { window } = record;
    const pendingTab = record.pendingTab;
    if (
      !pendingTab ||
      !record.rendererReady ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      networkWindowsByContentsId.get(window.webContents.id) !== record
    ) return;
    try {
      window.webContents.send(NETWORK_FORWARDING_IPC_EVENTS.navigationRequested, pendingTab);
      if (record.pendingTab === pendingTab) delete record.pendingTab;
    } catch {
      // The buffered tab remains available for the next trusted renderer load.
    }
  }

  function retireNetworkWindow(record: NetworkWindowRecord): void {
    if (networkWindowsByContentsId.get(record.contentsId) === record) {
      networkWindowsByContentsId.delete(record.contentsId);
    }
    if (networkWindowsByKey.get(record.key) === record) {
      networkWindowsByKey.delete(record.key);
    }
  }

  function showNetworkWindow(record: NetworkWindowRecord, tab: NetworkTabId): void {
    record.pendingTab = tab;
    if (record.window.isMinimized()) record.window.restore();
    record.window.show();
    record.window.focus();
    flushNetworkNavigation(record);
  }

  async function openNetworkWindow(
    tab: NetworkTabId,
    sourceWindow?: BrowserWindow,
  ): Promise<OperationResult> {
    if (shutdown.isStopping) {
      return { ok: false, error: "Network forwarding is unavailable while the application is closing" };
    }

    const focused = sourceWindow ?? BrowserWindow.getFocusedWindow();
    if (!focused || focused.isDestroyed() || focused.webContents.isDestroyed()) {
      return { ok: false, error: "Focus a connected Sliver window first" };
    }
    const focusedRecord = networkWindowsByContentsId.get(focused.webContents.id);
    if (focusedRecord) {
      showNetworkWindow(focusedRecord, tab);
      return { ok: true };
    }

    const source = identityForWindow(focused);
    if (!source || !nativeWindowSurfaces.has(focused)) {
      return { ok: false, error: "Focus a connected Sliver window first" };
    }
    let snapshot: SliverSnapshot;
    try {
      snapshot = registry.snapshot(source.contentsId);
    } catch {
      return { ok: false, error: "Focus a connected Sliver window first" };
    }
    const epoch = snapshot.connection.epoch;
    const incarnation = snapshot.connection.incarnation;
    if (
      !["connected", "degraded", "reconnecting"].includes(snapshot.connection.status) ||
      !Number.isSafeInteger(epoch) ||
      !Number.isSafeInteger(incarnation)
    ) {
      return { ok: false, error: "Connect to a Sliver server before opening Network" };
    }

    const key = String(epoch);
    const existing = networkWindowsByKey.get(key);
    if (existing && !existing.window.isDestroyed() && !existing.window.webContents.isDestroyed()) {
      showNetworkWindow(existing, tab);
      return { ok: true };
    }
    if (existing) retireNetworkWindow(existing);

    let createdWindow: BrowserWindow | undefined;
    let createdRecord: NetworkWindowRecord | undefined;
    try {
      const window = new BrowserWindow(networkWindowOptions(
        networkPreloadPath,
        process.platform,
        applicationIcons.getIconPath(),
        nativeTheme.shouldUseDarkColors,
      ));
      createdWindow = window;
      const record: NetworkWindowRecord = {
        key,
        contentsId: window.webContents.id,
        window,
        source,
        connectionIncarnation: incarnation!,
        rendererReady: false,
        pendingTab: tab,
      };
      createdRecord = record;
      networkWindowsByKey.set(key, record);
      networkWindowsByContentsId.set(window.webContents.id, record);
      window.on("close", () => retireNetworkWindow(record));
      window.webContents.on("did-start-loading", () => {
        if (networkWindowsByContentsId.get(window.webContents.id) === record) {
          record.rendererReady = false;
        }
      });
      window.webContents.on("did-finish-load", () => {
        if (
          networkWindowsByContentsId.get(window.webContents.id) !== record ||
          window.isDestroyed() ||
          window.webContents.isDestroyed()
        ) return;
        record.rendererReady = true;
        window.setTitle("Network");
        flushNetworkNavigation(record);
      });
      const retireFailedNetworkWindow = (): void => {
        if (networkWindowsByContentsId.get(window.webContents.id) !== record) return;
        if (!window.isDestroyed()) window.destroy();
      };
      window.webContents.on("render-process-gone", retireFailedNetworkWindow);
      window.webContents.on(
        "did-fail-load",
        (_event, _errorCode, _errorDescription, _url, isMainFrame) => {
          if (isMainFrame) retireFailedNetworkWindow();
        },
      );
      trackWindow(window, source.contentsId, undefined, undefined, undefined, "network");
      await loadRenderer(window, "network");
      if (window.isDestroyed()) throw new Error("The Network window closed while loading");
      if (!record.rendererReady) {
        record.rendererReady = true;
        window.setTitle("Network");
      }
      flushNetworkNavigation(record);
      return { ok: true };
    } catch (error) {
      if (createdRecord) retireNetworkWindow(createdRecord);
      if (createdWindow && !createdWindow.isDestroyed()) createdWindow.destroy();
      return {
        ok: false,
        error: applicationErrorMessage(error, "Network could not be opened"),
      };
    }
  }

  async function openCloudDeploymentWindow(
    navigationRequest?: CloudDeploymentNavigationRequest,
  ): Promise<OperationResult> {
    if (shutdown.isStopping) {
      return { ok: false, error: "Cloud Deployment is unavailable while the application is closing" };
    }
    if (navigationRequest) pendingCloudDeploymentNavigationRequest = navigationRequest;
    let createdWindow: BrowserWindow | undefined;
    try {
      const existing = cloudDeploymentWindow;
      if (existing && !existing.isDestroyed() && !existing.webContents.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.show();
        existing.focus();
        flushCloudDeploymentNavigation(existing);
        return { ok: true };
      }

      const window = new BrowserWindow(cloudDeploymentWindowOptions(
        cloudDeploymentPreloadPath,
        process.platform,
        applicationIcons.getIconPath(),
        nativeTheme.shouldUseDarkColors,
      ));
      createdWindow = window;
      cloudDeploymentWindow = window;
      cloudDeploymentRendererReady = false;
      window.on("closed", () => {
        if (cloudDeploymentWindow === window) {
          cloudDeploymentWindow = undefined;
          cloudDeploymentRendererReady = false;
          pendingCloudDeploymentNavigationRequest = undefined;
        }
      });
      window.webContents.on("did-start-loading", () => {
        if (cloudDeploymentWindow === window) cloudDeploymentRendererReady = false;
      });
      window.webContents.on("did-finish-load", () => {
        if (
          cloudDeploymentWindow !== window ||
          window.isDestroyed() ||
          window.webContents.isDestroyed()
        ) return;
        cloudDeploymentRendererReady = true;
        window.setTitle("Cloud Deployment");
        window.webContents.send(
          CLOUD_DEPLOYMENT_IPC_EVENTS.themeChanged,
          nativeTheme.shouldUseDarkColors,
        );
        flushCloudDeploymentNavigation(window);
      });
      trackWindow(
        window,
        undefined,
        undefined,
        undefined,
        undefined,
        "cloud-deployment",
        false,
      );
      await loadRenderer(window, "cloud-deployment");
      if (window.isDestroyed()) {
        throw new Error("The Cloud Deployment window closed while its renderer was loading");
      }
      if (!cloudDeploymentRendererReady) {
        cloudDeploymentRendererReady = true;
        window.setTitle("Cloud Deployment");
        window.webContents.send(
          CLOUD_DEPLOYMENT_IPC_EVENTS.themeChanged,
          nativeTheme.shouldUseDarkColors,
        );
      }
      flushCloudDeploymentNavigation(window);
      return { ok: true };
    } catch (error) {
      if (cloudDeploymentWindow === createdWindow) {
        cloudDeploymentWindow = undefined;
        cloudDeploymentRendererReady = false;
        pendingCloudDeploymentNavigationRequest = undefined;
      }
      if (createdWindow && !createdWindow.isDestroyed()) createdWindow.destroy();
      return {
        ok: false,
        error: applicationErrorMessage(error, "Cloud Deployment could not be opened"),
      };
    }
  }

  function openCloudDeploymentWindowFromRenderer(
    source: TrustedWindowIdentity,
    request?: CloudDeploymentNavigationRequest,
  ): Promise<OperationResult> | OperationResult {
    const sourceWindow = windowsByContentsId.get(source.contentsId);
    if (
      !sourceWindow ||
      sourceWindow.isDestroyed() ||
      !sameWindowIdentity(source, identityForWindow(sourceWindow)) ||
      nativeWindowSurfaces.get(sourceWindow) !== "workspace"
    ) {
      return { ok: false, error: "Cloud Deployment can only be opened from a workspace window" };
    }
    return openCloudDeploymentWindow(request);
  }

  async function openManagedSshWindow(
    deploymentId: string,
  ): Promise<OperationResult<SshOpenTabResult>> {
    if (shutdown.isStopping || !sshSessions) {
      return { ok: false, error: "SSH sessions are unavailable while the application is closing" };
    }
    try {
      const owner = currentSshWindowOwner();
      const result = await sshSessions.openTarget(deploymentId, owner);
      if (shutdown.isStopping) {
        return { ok: false, error: "SSH sessions are unavailable while the application is closing" };
      }
      if (!result.ok || !result.value || result.value.status === "host-key-review") return result;
      return await presentManagedSshWindow(result.value);
    } catch (error) {
      return { ok: false, error: applicationErrorMessage(error, "The SSH session could not be opened") };
    }
  }

  async function approveManagedSshHostKey(
    token: string,
  ): Promise<OperationResult<SshOpenTabResult>> {
    if (shutdown.isStopping || !sshSessions) {
      return { ok: false, error: "SSH sessions are unavailable while the application is closing" };
    }
    try {
      const result = await sshSessions.approveHostKey(token, currentSshWindowOwner());
      if (shutdown.isStopping) {
        return { ok: false, error: "SSH sessions are unavailable while the application is closing" };
      }
      if (!result.ok || !result.value || result.value.status === "host-key-review") return result;
      return await presentManagedSshWindow(result.value);
    } catch (error) {
      return { ok: false, error: applicationErrorMessage(error, "The SSH host key could not be approved") };
    }
  }

  async function presentManagedSshWindow(
    opened: Extract<SshOpenTabResult, { status: "opened" }>,
  ): Promise<OperationResult<SshOpenTabResult>> {
    if (shutdown.isStopping) {
      return { ok: false, error: "SSH sessions are unavailable while the application is closing" };
    }
    const existing = sshWindow;
    if (existing && !existing.isDestroyed() && !existing.webContents.isDestroyed()) {
      if (opened.context) {
        existing.webContents.send(SSH_IPC_EVENTS.tabOpened, opened.context);
      } else if (sshWindowClaimedBy && sshSessions) {
        const index = sshSessions.indexOf(opened.tabId);
        if (index !== undefined) existing.webContents.send(SSH_IPC_EVENTS.selectTabRequested, index);
      }
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return { ok: true, value: opened };
    }

    let window: BrowserWindow | undefined;
    try {
      if (shutdown.isStopping) {
        return { ok: false, error: "SSH sessions are unavailable while the application is closing" };
      }
      window = new BrowserWindow(sshWindowOptions(
        sshPreloadPath,
        process.platform,
        applicationIcons.getIconPath(),
        nativeTheme.shouldUseDarkColors,
      ));
      sshWindow = window;
      sshWindowClaimedBy = undefined;
      installSshWindowLifecycle(window);
      trackWindow(window, undefined, undefined, undefined, undefined, "ssh", false);
      await loadRenderer(window, "ssh");
      if (window.isDestroyed() || sshWindow !== window) {
        throw new Error("The SSH window closed while its renderer was loading");
      }
      window.setTitle("SSH");
      return { ok: true, value: opened };
    } catch (error) {
      if (window) retireSshWindow(window, "renderer-gone");
      return { ok: false, error: applicationErrorMessage(error, "The SSH window could not be opened") };
    }
  }

  function installSshWindowLifecycle(window: BrowserWindow): void {
    let completedInitialLoad = false;
    window.webContents.once("did-finish-load", () => {
      completedInitialLoad = true;
    });
    window.webContents.on("did-start-navigation", (details) => {
      if (completedInitialLoad && details.isMainFrame && !details.isSameDocument) {
        retireSshWindow(window, "navigation");
      }
    });
    window.webContents.on("render-process-gone", () => retireSshWindow(window, "renderer-gone"));
    window.webContents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame) retireSshWindow(window, "renderer-gone");
    });
    window.webContents.on("before-input-event", (event, input) => {
      if (!isCurrentClaimedSshWindow(window)) return;
      const settings = applicationSettingsStore?.getState();
      const index = consoleTabShortcutIndexForInput(process.platform, input, settings);
      const requestsNewTab = isConsoleNewTabShortcutInput(process.platform, input, settings);
      const requestsCloseTab = isApplicationShortcutInput("terminalCloseTab", process.platform, input, settings);
      const requestsSettings = isApplicationShortcutInput("terminalSettings", process.platform, input, settings);
      const requestsCloseWindow = isApplicationShortcutInput("terminalCloseWindow", process.platform, input, settings);
      if (index === undefined && !requestsNewTab && !requestsCloseTab && !requestsSettings && !requestsCloseWindow) return;
      event.preventDefault();
      if (input.isAutoRepeat) return;
      if (requestsCloseWindow) {
        window.close();
        return;
      }
      window.webContents.send(
        requestsNewTab ? SSH_IPC_EVENTS.newTabRequested
          : requestsCloseTab ? SSH_IPC_EVENTS.closeTabRequested
            : requestsSettings ? SSH_IPC_EVENTS.settingsRequested : SSH_IPC_EVENTS.selectTabRequested,
        ...(index === undefined ? [] : [index]),
      );
    });
    window.on("closed", () => {
      if (sshWindow !== window) return;
      const cleanup = detachSshWindow(window, "window-closed");
      sshWindow = undefined;
      trackPendingCleanup(cleanup);
    });
  }

  function currentSshWindowOwner(): TrustedWindowIdentity | undefined {
    const window = sshWindow;
    const owner = sshWindowClaimedBy;
    return window && owner && isCurrentClaimedSshWindow(window) ? owner : undefined;
  }

  function claimManagedSshWindow(
    owner: TrustedWindowIdentity,
  ): Promise<OperationResult<SshWindowLaunchContext>> {
    const operation = sshWindowClaimChain.then(async () => {
      const window = sshWindow;
      if (
        shutdown.isStopping ||
        !sshSessions ||
        !window ||
        window.isDestroyed() ||
        window.webContents.isDestroyed() ||
        nativeWindowSurfaces.get(window) !== "ssh" ||
        !sameWindowIdentity(owner, identityForWindow(window)) ||
        !isSshSurfaceUrl(window.webContents.getURL(), rendererUrl)
      ) return { ok: false as const, error: "This window is not authorized to host SSH sessions" };

      const result = await sshSessions.claim(owner);
      if (!result.ok) return result;
      if (
        shutdown.isStopping ||
        sshWindow !== window ||
        window.isDestroyed() ||
        window.webContents.isDestroyed() ||
        nativeWindowSurfaces.get(window) !== "ssh" ||
        !sameWindowIdentity(owner, identityForWindow(window)) ||
        !isSshSurfaceUrl(window.webContents.getURL(), rendererUrl)
      ) {
        await sshSessions.detach(owner, "renderer-gone");
        return { ok: false as const, error: "The SSH window closed while sessions were attaching" };
      }
      sshWindowClaimedBy = owner;
      return result;
    });
    sshWindowClaimChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  function isCurrentClaimedSshWindow(window: BrowserWindow): boolean {
    return sshWindow === window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      nativeWindowSurfaces.get(window) === "ssh" &&
      sshWindowClaimedBy !== undefined &&
      sameWindowIdentity(sshWindowClaimedBy, identityForWindow(window)) &&
      isSshSurfaceUrl(window.webContents.getURL(), rendererUrl);
  }

  function detachSshWindow(
    window: BrowserWindow,
    reason: "window-closed" | "renderer-gone" | "navigation",
  ): Promise<void> {
    if (sshWindow !== window) return Promise.resolve();
    const owner = sshWindowClaimedBy;
    sshWindowClaimedBy = undefined;
    return owner && sshSessions ? sshSessions.detach(owner, reason) : Promise.resolve();
  }

  function retireSshWindow(
    window: BrowserWindow,
    reason: "window-closed" | "renderer-gone" | "navigation",
  ): void {
    if (sshWindow !== window) return;
    const cleanup = detachSshWindow(window, reason);
    sshWindow = undefined;
    trackPendingCleanup(cleanup);
    if (!window.isDestroyed()) window.destroy();
  }

  function trackPendingCleanup(cleanup: Promise<void>): void {
    pendingWindowCleanup.add(cleanup);
    void cleanup.finally(() => pendingWindowCleanup.delete(cleanup));
  }

  async function openInteractionWindow(source: TrustedWindowIdentity): Promise<OperationResult> {
    let window: BrowserWindow | undefined;
    let interactionRecord: InteractionWindowRecord | undefined;
    try {
      const sourceWindow = windowsByContentsId.get(source.contentsId);
      if (!sourceWindow || sourceWindow.isDestroyed() || !sameWindowIdentity(source, identityForWindow(sourceWindow))) {
        throw new Error("The source window changed before the interaction could be popped out");
      }
      if (interactionWindowsByContentsId.has(source.contentsId)) {
        throw new Error("A dedicated interaction window cannot pop out another interaction window");
      }
      const sourceSnapshot = registry.snapshot(source.contentsId);
      const target = sourceSnapshot.targetContext.activeTarget;
      const summary = sourceSnapshot.targetContext.activeTargetSummary;
      if (!target || !summary || target.mode !== summary.mode || target.id !== summary.id) {
        throw new Error("Select a session or beacon before popping out its interaction workspace");
      }

      window = new BrowserWindow(interactionWindowOptions(
        preloadPath,
        process.platform,
        applicationIcons.getIconPath(),
        nativeTheme.shouldUseDarkColors,
      ));
      interactionRecord = {
        window,
        source,
        target,
        connectionIncarnation: 0,
        generation: 0,
        transition: Promise.resolve(),
      };
      interactionWindowsByContentsId.set(window.webContents.id, interactionRecord);
      trackWindow(window, source.contentsId, undefined, interactionRecord);
      const selected = await registry.selectTarget(window.webContents.id, target);
      if (
        interactionWindowsByContentsId.get(window.webContents.id) !== interactionRecord ||
        window.isDestroyed()
      ) throw new Error("The dedicated interaction window closed while its target was being selected");
      if (!selected.ok || !selected.value) {
        throw new Error(selected.error ?? "The target could not be selected in the dedicated window");
      }
      const selectedTarget = selected.value.targetContext.activeTarget;
      const selectedSummary = selected.value.targetContext.activeTargetSummary;
      if (
        !selectedTarget ||
        !sameTargetIdentity(selectedTarget, target) ||
        !selectedSummary ||
        selectedSummary.mode !== target.mode ||
        selectedSummary.id !== target.id
      ) {
        throw new Error("The target changed before the dedicated interaction window was ready");
      }
      interactionRecord.target = selectedTarget;
      interactionRecord.connectionIncarnation = selected.value.connection.incarnation ?? 0;
      const targetName = selectedSummary.name || selectedSummary.hostname || selectedSummary.id;
      window.setTitle(`Interact — ${targetName}`);
      await loadRenderer(window, "interaction");
      if (
        interactionWindowsByContentsId.get(window.webContents.id) !== interactionRecord ||
        window.isDestroyed()
      ) throw new Error("The dedicated interaction window closed while its renderer was loading");
      return { ok: true };
    } catch (error) {
      if (
        window &&
        interactionRecord &&
        interactionWindowsByContentsId.get(window.webContents.id) === interactionRecord
      ) interactionWindowsByContentsId.delete(window.webContents.id);
      if (window && !window.isDestroyed()) window.destroy();
      return { ok: false, error: applicationErrorMessage(error, "The interaction could not be popped out") };
    }
  }

  async function claimInteractionWindow(
    destination: TrustedWindowIdentity,
  ): Promise<OperationResult<WindowLaunchContext>> {
    const record = interactionWindowsByContentsId.get(destination.contentsId);
    if (!record || record.window.isDestroyed()) {
      return { ok: false, error: "This window is not authorized to host an interaction workspace" };
    }
    const generation = record.generation;
    return serializeInteractionTransition<OperationResult<WindowLaunchContext>>(record, async () => {
      if (
        !isCurrentInteractionDestination(
          record,
          destination,
          interactionWindowsByContentsId.get(destination.contentsId),
          generation,
        ) ||
        !isInteractionSurfaceUrl(record.window.webContents.getURL(), rendererUrl)
      ) {
        return { ok: false, error: "The interaction window changed before its authority could be claimed" };
      }
      if (record.claimedBy && !sameWindowIdentity(record.claimedBy, destination)) {
        return { ok: false, error: "The interaction window authority belongs to a different renderer frame" };
      }

      const currentSnapshot = registry.snapshot(destination.contentsId);
      if ((currentSnapshot.connection.incarnation ?? 0) !== record.connectionIncarnation) {
        return { ok: false, error: "The interaction window connection changed before its authority could be claimed" };
      }
      const freshTarget = freshTargetIdentity(currentSnapshot, record.target);
      if (!freshTarget) {
        return { ok: false, error: "The interaction target is no longer available on this backend" };
      }
      const selected = await registry.selectTarget(destination.contentsId, freshTarget);
      if (!isCurrentInteractionDestination(
        record,
        destination,
        interactionWindowsByContentsId.get(destination.contentsId),
        generation,
      )) {
        return { ok: false, error: "The interaction window changed while its target was being restored" };
      }
      if (!selected.ok || !selected.value) return selected;
      if ((selected.value.connection.incarnation ?? 0) !== record.connectionIncarnation) {
        return { ok: false, error: "The interaction window connection changed while its target was being restored" };
      }
      const selectedTarget = selected.value.targetContext.activeTarget;
      const selectedSummary = selected.value.targetContext.activeTargetSummary;
      if (
        !selectedTarget ||
        !sameTargetIdentity(selectedTarget, record.target) ||
        !selectedSummary ||
        selectedSummary.mode !== record.target.mode ||
        selectedSummary.id !== record.target.id
      ) {
        return { ok: false, error: "The interaction target changed while its authority was being claimed" };
      }

      record.target = selectedTarget;
      record.claimedBy = destination;
      setInteractionWindowTitle(record.window, selected.value);
      return {
        ok: true,
        value: Object.freeze({
          kind: "interaction" as const,
          snapshot: selected.value,
          target: selectedTarget,
        }),
      };
    }).catch((): OperationResult<WindowLaunchContext> => ({
      ok: false,
      error: "The dedicated interaction context could not be restored",
    }));
  }

  async function selectInteractionWindowTarget(
    destination: TrustedWindowIdentity,
    target: TargetRef,
  ): Promise<OperationResult<SliverSnapshot>> {
    const record = interactionWindowsByContentsId.get(destination.contentsId);
    if (!record) return registry.selectTarget(destination.contentsId, target);
    const generation = record.generation;
    return serializeInteractionTransition<OperationResult<SliverSnapshot>>(record, async () => {
      if (
        !isCurrentInteractionDestination(
          record,
          destination,
          interactionWindowsByContentsId.get(destination.contentsId),
          generation,
        ) ||
        !isInteractionSurfaceUrl(record.window.webContents.getURL(), rendererUrl)
      ) {
        return { ok: false, error: "The interaction window changed before the target could be selected" };
      }
      if (!record.claimedBy || !sameWindowIdentity(record.claimedBy, destination)) {
        return { ok: false, error: "Claim this interaction window before changing its session" };
      }
      if ((registry.snapshot(destination.contentsId).connection.incarnation ?? 0) !== record.connectionIncarnation) {
        return { ok: false, error: "The interaction window connection changed before its session could be selected" };
      }
      if (record.target.mode !== "session" || target.mode !== "session") {
        return { ok: false, error: "A dedicated interaction window cannot change target modes or retarget a beacon" };
      }

      const selected = await registry.selectTarget(destination.contentsId, target);
      if (!isCurrentInteractionDestination(
        record,
        destination,
        interactionWindowsByContentsId.get(destination.contentsId),
        generation,
      )) {
        return { ok: false, error: "The interaction window changed while its session was being selected" };
      }
      if (!selected.ok || !selected.value) return selected;
      if ((selected.value.connection.incarnation ?? 0) !== record.connectionIncarnation) {
        return { ok: false, error: "The interaction window connection changed while its session was being selected" };
      }
      const selectedTarget = selected.value.targetContext.activeTarget;
      const selectedSummary = selected.value.targetContext.activeTargetSummary;
      if (
        selectedTarget?.mode !== "session" ||
        !sameTargetIdentity(selectedTarget, target) ||
        selectedSummary?.mode !== "session" ||
        selectedSummary.id !== target.id
      ) {
        return { ok: false, error: "The backend did not confirm the selected session" };
      }

      record.target = selectedTarget;
      record.claimedBy = destination;
      setInteractionWindowTitle(record.window, selected.value);
      return selected;
    }).catch((): OperationResult<SliverSnapshot> => ({
      ok: false,
      error: "The interaction session could not be selected",
    }));
  }

  async function openSessionShellWindow(
    source: TrustedWindowIdentity,
    input: OpenSessionShellWindowInput,
  ): Promise<OperationResult> {
    try {
      const sourceWindow = windowsByContentsId.get(source.contentsId);
      if (!sourceWindow || sourceWindow.isDestroyed() || !sameWindowIdentity(source, identityForWindow(sourceWindow))) {
        throw new Error("The source window changed before managed shells could be popped out");
      }
      const snapshot = registry.snapshot(source.contentsId);
      const target = snapshot.targetContext.activeTarget;
      const summary = snapshot.targetContext.activeTargetSummary;
      if (!target || target.mode !== "session" || summary?.mode !== "session" || summary.liveness !== "active") {
        throw new Error("Select an active session before popping out managed shells");
      }

      const key = sessionShellWindowKey(source.contentsId, target);
      const existing = sessionShellWindowsByKey.get(key);
      if (existing && !existing.window.isDestroyed()) {
        if (existing.finalizing) {
          throw new Error("The dedicated managed-shell window is still closing");
        }
        if (!existing.claimedBy) {
          if (input.preferredResourceId !== undefined) {
            existing.preferredResourceId = input.preferredResourceId;
          }
        } else {
          const destination = identityForWindow(existing.window);
          if (!destination || !sameWindowIdentity(existing.claimedBy, destination)) {
            retireSessionShellWindow(existing);
            throw new Error("The dedicated managed-shell window changed; open it again");
          }
          const result = await registry.claimSessionShellWindow(
            source.contentsId,
            source.rendererProcessId,
            source.rendererFrameToken,
            destination.contentsId,
            destination.rendererProcessId,
            destination.rendererFrameToken,
            target,
            input.preferredResourceId,
          );
          if (!result.ok) return { ok: false, error: result.error };
          if (!result.value || result.value.kind !== "session-shell") {
            return { ok: false, error: "The managed-shell window returned an invalid launch context" };
          }
          existing.claimedContext = result.value;
          if (input.preferredResourceId !== undefined) {
            existing.preferredResourceId = input.preferredResourceId;
          }
          sourceWindow.webContents.send(IPC.sessionShellsChanged);
          existing.window.webContents.send(IPC.sessionShellsChanged, input.preferredResourceId);
        }
        if (existing.window.isMinimized()) existing.window.restore();
        existing.window.show();
        existing.window.focus();
        return { ok: true };
      }

      const window = new BrowserWindow(sessionShellWindowOptions(
        preloadPath,
        process.platform,
        applicationIcons.getIconPath(),
        nativeTheme.shouldUseDarkColors,
      ));
      const record: SessionShellWindowRecord = {
        key,
        window,
        source,
        target,
        ...(input.preferredResourceId === undefined
          ? {}
          : { preferredResourceId: input.preferredResourceId }),
        finalizing: false,
      };
      sessionShellWindowsByKey.set(key, record);
      sessionShellWindowsByContentsId.set(window.webContents.id, record);
      trackWindow(window, source.contentsId, record);
      void loadRenderer(window, "managed-shells");
      return { ok: true };
    } catch (error) {
      return { ok: false, error: applicationErrorMessage(error, "Managed shells could not be popped out") };
    }
  }

  async function claimSessionShellWindow(
    destination: TrustedWindowIdentity,
  ): Promise<OperationResult<WindowLaunchContext>> {
    const record = sessionShellWindowsByContentsId.get(destination.contentsId);
    if (!record || record.window.isDestroyed() || record.finalizing) {
      return { ok: false, error: "This window is not authorized to host managed shells" };
    }
    if (record.claimedBy) {
      if (sameWindowIdentity(record.claimedBy, destination) && record.claimedContext) {
        return { ok: true, value: record.claimedContext };
      }
      return { ok: false, error: "The managed-shell window authority has already been claimed" };
    }

    const sourceWindow = windowsByContentsId.get(record.source.contentsId);
    if (!sourceWindow || sourceWindow.isDestroyed() ||
      !sameWindowIdentity(record.source, identityForWindow(sourceWindow))) {
      retireSessionShellWindow(record);
      return { ok: false, error: "The source window changed before managed shells could be transferred" };
    }
    const result = await registry.claimSessionShellWindow(
      record.source.contentsId,
      record.source.rendererProcessId,
      record.source.rendererFrameToken,
      destination.contentsId,
      destination.rendererProcessId,
      destination.rendererFrameToken,
      record.target,
      record.preferredResourceId,
    );
    if (!result.ok || !result.value) {
      retireSessionShellWindow(record);
      return result;
    }
    if (result.value.kind !== "session-shell") {
      retireSessionShellWindow(record);
      return { ok: false, error: "The managed-shell window returned an invalid launch context" };
    }
    record.claimedBy = destination;
    record.claimedContext = result.value;
    sourceWindow.webContents.send(IPC.sessionShellsChanged);
    const sessionName = result.value.snapshot.targetContext.activeTargetSummary?.name;
    record.window.setTitle(sessionName ? `Managed Shells — ${sessionName}` : "Managed Shells");
    return result;
  }

  async function returnSessionShellWindow(record: SessionShellWindowRecord): Promise<boolean> {
    const claimedBy = record.claimedBy;
    if (!claimedBy) return false;
    const sourceWindow = windowsByContentsId.get(record.source.contentsId);
    if (!sourceWindow || sourceWindow.isDestroyed()) return false;
    const source = identityForWindow(sourceWindow);
    if (!source) return false;
    const returned = await registry.returnSessionShellWindow(
      claimedBy.contentsId,
      claimedBy.rendererProcessId,
      claimedBy.rendererFrameToken,
      source.contentsId,
      source.rendererProcessId,
      source.rendererFrameToken,
      record.target,
    ).catch(() => false);
    if (returned && !sourceWindow.isDestroyed()) {
      sourceWindow.webContents.send(IPC.sessionShellsChanged);
    }
    return returned;
  }

  function sourceCanReceiveSessionShells(record: SessionShellWindowRecord): boolean {
    const sourceWindow = windowsByContentsId.get(record.source.contentsId);
    if (!sourceWindow || sourceWindow.isDestroyed()) return false;
    try {
      const targetContext = registry.snapshot(record.source.contentsId).targetContext;
      const active = targetContext.activeTarget;
      const summary = targetContext.activeTargetSummary;
      return active !== null &&
        sameTargetIdentity(active, record.target) &&
        summary?.mode === "session" &&
        summary.id === active.id &&
        summary.liveness === "active";
    } catch {
      return false;
    }
  }

  function retireSessionShellWindow(record: SessionShellWindowRecord): void {
    if (record.finalizing) return;
    record.finalizing = true;
    sessionShellWindowsByContentsId.delete(record.window.webContents.id);
    if (sessionShellWindowsByKey.get(record.key) === record) {
      sessionShellWindowsByKey.delete(record.key);
    }
    if (!record.window.isDestroyed()) record.window.destroy();
  }

  async function openConsoleWindow(source: TrustedWindowIdentity): Promise<OperationResult> {
    let failureKind: ConsoleWindowOpenFailureKind = "application-stopping";
    let candidateWindow: BrowserWindow | undefined;
    let candidateRecord: ConsoleWindowRecord | undefined;
    try {
      if (shutdown.isStopping) throw new Error("Application stopping");
      failureKind = "source-changed";
      const sourceWindow = windowsByContentsId.get(source.contentsId);
      if (
        !sourceWindow ||
        sourceWindow.isDestroyed() ||
        !sameWindowIdentity(source, identityForWindow(sourceWindow)) ||
        consoleWindowsByContentsId.has(source.contentsId)
      ) {
        throw new Error("The source window changed before its console could be opened");
      }
      failureKind = "connection-inspection-failed";
      const snapshot = registry.snapshot(source.contentsId);
      const incarnation = snapshot.connection.incarnation;
      failureKind = "connection-required";
      if (
        typeof incarnation !== "number" ||
        !Number.isSafeInteger(incarnation) ||
        !snapshot.connection.configName ||
        !["connected", "degraded", "reconnecting"].includes(snapshot.connection.status)
      ) {
        throw new Error("Connect to a Sliver server before opening its console");
      }

      const key = `${source.contentsId}:${incarnation}`;
      const existing = consoleWindowsByKey.get(key);
      if (existing && !existing.window.isDestroyed() && !existing.finalizing) {
        if (existing.openPromise && !existing.hiddenByUser) return existing.openPromise;
        failureKind = "window-restore-failed";
        // A failed native show/focus must leave retained clients available
        // for another attempt, rather than rolling back their live window.
        showConsoleWindow(existing);
        return existing.openPromise ?? { ok: true };
      }
      if (existing) retireConsoleWindow(existing, "window-closed");

      failureKind = "window-create-failed";
      const window = new BrowserWindow(consoleWindowOptions(
        preloadPath,
        process.platform,
        applicationIcons.getIconPath(),
        nativeTheme.shouldUseDarkColors,
      ));
      candidateWindow = window;
      const record: ConsoleWindowRecord = {
        key,
        window,
        source,
        connectionIncarnation: incarnation,
        tabsById: new Map(),
        tabsByAttachmentToken: new Map(),
        nextTabOrdinal: 1,
        hiddenByUser: false,
        finalizing: false,
      };
      candidateRecord = record;
      consoleWindowsByKey.set(key, record);
      consoleWindowsByContentsId.set(window.webContents.id, record);
      failureKind = "window-register-failed";
      trackWindow(window, source.contentsId, undefined, undefined, record);
      const openPromise = finishConsoleWindowOpen(record);
      record.openPromise = openPromise;
      return openPromise;
    } catch {
      if (candidateWindow) await rollbackConsoleWindowOpen(candidateWindow, candidateRecord);
      return consoleWindowOpenFailure(failureKind);
    }
  }

  function showConsoleWindow(record: ConsoleWindowRecord): void {
    if (record.window.isMinimized()) record.window.restore();
    record.window.show();
    record.hiddenByUser = false;
    record.window.focus();
  }

  async function finishConsoleWindowOpen(record: ConsoleWindowRecord): Promise<OperationResult> {
    try {
      await loadRenderer(record.window, "console");
      if (
        record.window.isDestroyed() ||
        record.finalizing ||
        consoleWindowsByKey.get(record.key) !== record ||
        consoleWindowsByContentsId.get(record.window.webContents.id) !== record
      ) {
        throw new Error("The console window changed while its renderer was loading");
      }
      return { ok: true };
    } catch {
      await rollbackConsoleWindowOpen(record.window, record);
      return consoleWindowOpenFailure("renderer-load-failed");
    } finally {
      delete record.openPromise;
    }
  }

  function consoleWindowOpenFailure(kind: ConsoleWindowOpenFailureKind): OperationResult {
    const error = consoleWindowOpenError(kind);
    try {
      process.stderr.write(`[sliver-console] ${error}\n`);
    } catch {
      // Diagnostics are best-effort and must not replace the stable IPC result.
    }
    return { ok: false, error };
  }

  async function rollbackConsoleWindowOpen(
    window: BrowserWindow,
    record: ConsoleWindowRecord | undefined,
  ): Promise<void> {
    const contentsId = window.webContents.id;
    if (record) {
      retireConsoleWindow(record, "window-closed");
      if (!window.isDestroyed()) window.destroy();
      await record.closePromise?.catch(() => undefined);
    } else if (!window.isDestroyed()) {
      window.destroy();
    }
    windows.delete(window);
    nativeWindowSurfaces.delete(window);
    windowsByContentsId.delete(contentsId);
    if (record && consoleWindowsByContentsId.get(contentsId) === record) {
      consoleWindowsByContentsId.delete(contentsId);
    }
    if (record && consoleWindowsByKey.get(record.key) === record) {
      consoleWindowsByKey.delete(record.key);
    }
    await registry.unregisterWindow(contentsId).catch(() => undefined);
  }

  async function claimConsoleWindow(
    destination: TrustedWindowIdentity,
  ): Promise<OperationResult<ConsoleWindowLaunchContext>> {
    const record = consoleWindowsByContentsId.get(destination.contentsId);
    if (shutdown.isStopping) {
      if (record) retireConsoleWindow(record, "application-shutdown");
      return { ok: false, error: "The application is shutting down" };
    }
    if (
      !record ||
      record.window.isDestroyed() ||
      record.finalizing ||
      !sameWindowIdentity(destination, identityForWindow(record.window)) ||
      !isConsoleSurfaceUrl(record.window.webContents.getURL(), rendererUrl)
    ) {
      return { ok: false, error: "This window is not authorized to host a Sliver console" };
    }
    if (record.claimedBy) {
      if (sameWindowIdentity(record.claimedBy, destination) && record.claimedContext) {
        return { ok: true, value: record.claimedContext };
      }
      return { ok: false, error: "The Sliver console authority has already been claimed" };
    }
    if (record.claimPromise) {
      if (record.claimingBy && sameWindowIdentity(record.claimingBy, destination)) {
        return record.claimPromise;
      }
      return { ok: false, error: "The Sliver console authority is already being claimed" };
    }

    record.claimingBy = destination;
    const claimPromise = performConsoleWindowClaim(record, destination);
    record.claimPromise = claimPromise;
    try {
      return await claimPromise;
    } finally {
      if (record.claimPromise === claimPromise) {
        delete record.claimPromise;
        delete record.claimingBy;
      }
    }
  }

  async function performConsoleWindowClaim(
    record: ConsoleWindowRecord,
    destination: TrustedWindowIdentity,
  ): Promise<OperationResult<ConsoleWindowLaunchContext>> {
    try {
      assertConsoleWindowLease(record, destination);
    } catch {
      retireConsoleWindow(record, "window-closed");
      return { ok: false, error: "The active Sliver connection changed before its console started" };
    }

    try {
      const initialTab = await beginConsoleTab(record, destination);
      const context = Object.freeze({
        kind: "console" as const,
        configName: initialTab.configName,
        shortcutModifier: process.platform === "darwin" ? "Command" as const : "Control" as const,
        initialTab: initialTab.context,
      });
      record.configName = initialTab.configName;
      record.claimedBy = destination;
      record.claimedContext = context;
      record.window.setTitle(`Sliver Console — ${initialTab.configName}`);
      return { ok: true, value: context };
    } catch {
      retireConsoleWindow(record, "transport-error");
      return { ok: false, error: "The active Sliver console could not be started" };
    }
  }

  async function createConsoleTab(
    destination: TrustedWindowIdentity,
  ): Promise<OperationResult<ConsoleTabLaunchContext>> {
    const record = authorizedConsoleWindow(destination);
    if (!record) {
      return { ok: false, error: "This window is not authorized to create a Sliver console tab" };
    }
    if (record.tabsById.size >= CONSOLE_MAX_TABS_PER_WINDOW) {
      return { ok: false, error: `A Sliver console window supports at most ${CONSOLE_MAX_TABS_PER_WINDOW} tabs` };
    }
    try {
      const started = await beginConsoleTab(record, destination);
      return { ok: true, value: started.context };
    } catch {
      return { ok: false, error: "The Sliver console tab could not be started" };
    }
  }

  async function closeConsoleTab(
    destination: TrustedWindowIdentity,
    tabId: string,
  ): Promise<OperationResult<ConsoleTabCloseResult>> {
    const record = authorizedConsoleWindow(destination);
    const tab = record?.tabsById.get(tabId);
    if (!record || !tab || tab.finalizing) {
      return { ok: false, error: "This Sliver console tab is unavailable" };
    }
    await closeConsoleTabRecord(record, tab, "operator-close");
    const value = Object.freeze({ remainingTabs: record.tabsById.size });
    // An empty console window remains a stable, authorized tab host. This lets
    // the renderer offer an explicit New Tab action and avoids racing a later
    // open/create request against deferred window destruction. Close Window
    // remains available through the native menu.
    return { ok: true, value };
  }

  function beginConsoleTab(
    record: ConsoleWindowRecord,
    destination: TrustedWindowIdentity,
  ): Promise<StartedConsoleTab> {
    assertConsoleWindowLease(record, destination);
    if (record.tabsById.size >= CONSOLE_MAX_TABS_PER_WINDOW) {
      throw new Error("The console tab limit was reached");
    }
    const tab: ConsoleTabRecord = {
      id: createConsoleTabId(record),
      ordinal: record.nextTabOrdinal,
      finalizing: false,
    };
    record.nextTabOrdinal += 1;
    record.tabsById.set(tab.id, tab);
    const startPromise = performConsoleTabStart(record, tab, destination)
      .catch((error: unknown) => {
        if (record.tabsById.get(tab.id) === tab) record.tabsById.delete(tab.id);
        if (tab.portSession) record.tabsByAttachmentToken.delete(tab.portSession.attachmentToken);
        throw error;
      })
      .finally(() => {
        if (tab.startPromise === startPromise) delete tab.startPromise;
      });
    tab.startPromise = startPromise;
    return startPromise;
  }

  async function performConsoleTabStart(
    record: ConsoleWindowRecord,
    tab: ConsoleTabRecord,
    destination: TrustedWindowIdentity,
  ): Promise<StartedConsoleTab> {
    let configBytes: Buffer | undefined;
    let runtime: SliverConsoleRuntime | undefined;
    let portSession: ConsolePortSession | undefined;
    const assertSpawnLease = (): void => {
      assertConsoleWindowLease(record, destination);
      if (tab.finalizing || record.tabsById.get(tab.id) !== tab) {
        throw new Error("The Sliver console tab changed before it started");
      }
    };
    try {
      // Load the native PTY binding before copying profile material. The
      // synchronous lease below is then the final operation before spawn.
      const ptyFactory = options.consolePtyFactory ?? await loadNodePtyFactory();
      const material = await registry.copyActiveConfig(record.source.contentsId);
      configBytes = material.configBytes;
      assertSpawnLease();
      if (record.configName !== undefined && material.configName !== record.configName) {
        throw new Error("The active Sliver configuration changed before the console tab started");
      }
      runtime = await startConsoleRuntime({
        clientExecutable: consoleClientExecutable,
        clientRootDirectory: consoleClientRootDirectory,
        configBytes,
        ptyFactory,
        assertSpawnLease,
      });
      configBytes = undefined; // Runtime consumed and zeroized the transferred buffer.
      assertSpawnLease();

      portSession = new ConsolePortSession(runtime, destination);
      if (record.tabsByAttachmentToken.has(portSession.attachmentToken)) {
        throw new Error("The console attachment capability collided");
      }
      const context = Object.freeze({
        tabId: tab.id,
        attachmentToken: portSession.attachmentToken,
        label: `Console ${tab.ordinal}`,
      });
      tab.runtime = runtime;
      tab.portSession = portSession;
      record.tabsByAttachmentToken.set(portSession.attachmentToken, tab);
      return Object.freeze({ context, configName: material.configName });
    } catch (error) {
      configBytes?.fill(0);
      if (portSession) await portSession.close("transport-error").catch(() => undefined);
      else await runtime?.close().catch(() => undefined);
      throw error;
    }
  }

  function createConsoleTabId(record: ConsoleWindowRecord): string {
    let id: string;
    do id = randomBytes(32).toString("base64url");
    while (record.tabsById.has(id));
    return id;
  }

  function assertConsoleWindowLease(
    record: ConsoleWindowRecord,
    destination: TrustedWindowIdentity,
  ): void {
    const sourceWindow = windowsByContentsId.get(record.source.contentsId);
    const destinationOwner = record.claimedBy ?? record.claimingBy;
    if (
      !sourceWindow ||
      sourceWindow.isDestroyed() ||
      !sameWindowIdentity(record.source, identityForWindow(sourceWindow)) ||
      !destinationOwner ||
      !sameWindowIdentity(destinationOwner, destination) ||
      record.finalizing ||
      record.window.isDestroyed() ||
      consoleWindowsByContentsId.get(destination.contentsId) !== record ||
      !sameWindowIdentity(destination, identityForWindow(record.window)) ||
      registry.snapshot(record.source.contentsId).connection.incarnation !== record.connectionIncarnation
    ) {
      throw new Error("The active Sliver connection changed before its console started");
    }
  }

  function authorizedConsoleWindow(destination: TrustedWindowIdentity): ConsoleWindowRecord | undefined {
    const record = consoleWindowsByContentsId.get(destination.contentsId);
    return record &&
      !record.finalizing &&
      !record.window.isDestroyed() &&
      record.claimedBy &&
      sameWindowIdentity(record.claimedBy, destination) &&
      sameWindowIdentity(destination, identityForWindow(record.window)) &&
      isConsoleSurfaceUrl(record.window.webContents.getURL(), rendererUrl)
      ? record
      : undefined;
  }

  function attachConsoleWindow(
    destination: TrustedWindowIdentity,
    request: ConsoleAttachRequest,
    port: MessagePortMain,
  ): void {
    const record = authorizedConsoleWindow(destination);
    try {
      const tab = record?.tabsByAttachmentToken.get(request.attachmentToken);
      if (
        !record ||
        !tab ||
        tab.finalizing ||
        !tab.portSession
      ) {
        throw new Error("The console stream is unavailable for this renderer");
      }
      // The attachment capability is single-use even if the attempted attach fails.
      record.tabsByAttachmentToken.delete(request.attachmentToken);
      tab.portSession.attach(destination, request.attachmentToken, consoleAttachmentPort(port));
    } catch (error) {
      try {
        port.close();
      } catch {
        // The transferred capability may already have been rejected and closed.
      }
      throw error;
    }
  }

  function retireConsoleWindow(record: ConsoleWindowRecord, reason: ConsoleCloseReason): void {
    if (record.finalizing) return;
    record.finalizing = true;
    consoleWindowsByContentsId.delete(record.window.webContents.id);
    if (consoleWindowsByKey.get(record.key) === record) consoleWindowsByKey.delete(record.key);
    void closeConsoleWindow(record, reason);
    if (!record.window.isDestroyed()) record.window.destroy();
  }

  async function closeConsoleWindow(
    record: ConsoleWindowRecord,
    reason: ConsoleCloseReason,
  ): Promise<void> {
    if (record.closePromise) return record.closePromise;
    record.finalizing = true;
    const closePromise = (async (): Promise<void> => {
      await record.claimPromise?.catch(() => undefined);
      await Promise.all(
        [...record.tabsById.values()].map((tab) => closeConsoleTabRecord(record, tab, reason)),
      );
    })();
    record.closePromise = closePromise;
    pendingWindowCleanup.add(closePromise);
    void closePromise.finally(() => pendingWindowCleanup.delete(closePromise));
    return closePromise;
  }

  async function closeConsoleTabRecord(
    record: ConsoleWindowRecord,
    tab: ConsoleTabRecord,
    reason: ConsoleCloseReason,
  ): Promise<void> {
    if (tab.closePromise) return tab.closePromise;
    tab.finalizing = true;
    const closePromise = (async (): Promise<void> => {
      await tab.startPromise?.catch(() => undefined);
      if (tab.portSession) record.tabsByAttachmentToken.delete(tab.portSession.attachmentToken);
      if (tab.portSession) await tab.portSession.close(reason).catch(() => undefined);
      else await tab.runtime?.close().catch(() => undefined);
      // Keep closing tabs admitted against the per-window cap until their
      // native runtimes are actually gone; a hostile renderer cannot cycle
      // close/create calls to exceed the bounded process count.
      if (record.tabsById.get(tab.id) === tab) record.tabsById.delete(tab.id);
    })();
    tab.closePromise = closePromise;
    return closePromise;
  }

  function installMenu(): void {
    if (shutdown.isStopping) return;
    const focusedConsole = focusedConsoleWindow();
    const focusedSsh = focusedSshWindow();
    const terminalActions = focusedConsole
      ? {
          newTab: () => sendConsoleMenuEvent(focusedConsole, IPC.consoleNewTabRequested),
          closeTab: () => sendConsoleMenuEvent(focusedConsole, IPC.consoleCloseTabRequested),
          selectTab: (index: number) => sendConsoleTabSelectionEvent(focusedConsole, index),
          closeWindow: () => {
            if (focusedConsoleWindow() === focusedConsole && !focusedConsole.window.isDestroyed()) {
              focusedConsole.window.close();
            }
          },
          showSettings: () => sendConsoleMenuEvent(focusedConsole, IPC.consoleSettingsRequested),
        }
      : focusedSsh
        ? {
            newTab: () => sendSshMenuEvent(focusedSsh, SSH_IPC_EVENTS.newTabRequested),
            closeTab: () => sendSshMenuEvent(focusedSsh, SSH_IPC_EVENTS.closeTabRequested),
            selectTab: (index: number) => sendSshTabSelectionEvent(focusedSsh, index),
            closeWindow: () => {
              if (focusedSshWindow() === focusedSsh && !focusedSsh.isDestroyed()) focusedSsh.close();
            },
            showSettings: () => sendSshMenuEvent(focusedSsh, SSH_IPC_EVENTS.settingsRequested),
          }
        : undefined;
    const template = buildApplicationMenuTemplate(
      process.platform,
      APPLICATION_DISPLAY_NAME,
      {
        newWindow: () => createWindow(),
        openTextEditor: () => {
          if (shutdown.isStopping) return;
          void textEditorWindows?.open().catch(() => {
            dialog.showErrorBox("Text Editor unavailable", "The text editor window could not be opened.");
          });
        },
        duplicateConnectedWindow: () => createWindow(BrowserWindow.getFocusedWindow()?.webContents.id),
        reportScreenshot: () => {
          void reportScreenshot().then((result) => {
            if (shutdown.isStopping) return;
            if (!result.ok) {
              dialog.showErrorBox("Report Screenshot failed", result.error);
              return;
            }
            void dialog.showMessageBox({
              type: "info",
              title: "Report Screenshot",
              message: `Saved ${result.value.files.length} screenshot${result.value.files.length === 1 ? "" : "s"}`,
              detail: result.value.directory,
            });
          });
        },
        openCloudDeployment: (request) => void openCloudDeploymentWindow(request),
        openArmory: (tab) => void openArmoryWindow(tab),
        openNetwork: (tab, sourceWindow) => {
          void openNetworkWindow(
            tab,
            sourceWindow instanceof BrowserWindow ? sourceWindow : undefined,
          ).then((result) => {
            if (!result.ok && !shutdown.isStopping) {
              dialog.showErrorBox("Network unavailable", result.error);
            }
          });
        },
        openScriptTaskManager: (sourceWindow) => {
          void openScriptTaskManager(sourceWindow instanceof BrowserWindow ? sourceWindow : undefined).then(reportScriptMenuError);
        },
        editScript: (id, sourceWindow) => {
          void editScriptFromMenu(id, sourceWindow instanceof BrowserWindow ? sourceWindow : undefined).then(reportScriptMenuError);
        },
        openDocumentation: () => void shell.openExternal("https://sliver.sh/docs"),
        showAboutPanel: () => app.showAboutPanel(),
        downloadRelease: (target) => startReleaseDownload(target),
        checkForApplicationUpdates: () => void applicationUpdater?.checkForUpdates(),
        restartToApplyApplicationUpdate: () => {
          void confirmApplicationUpdateRestart();
        },
      },
      releaseCatalog,
      applicationUpdateState,
      terminalActions,
      cloudMenuDeployments,
      true,
      crackstationReleaseCatalog,
      applicationSettingsStore?.getState(),
      scriptMenuCatalog,
    );
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  function focusedConsoleWindow(): ConsoleWindowRecord | undefined {
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused || focused.isDestroyed() || focused.webContents.isDestroyed()) return undefined;
    const record = consoleWindowsByContentsId.get(focused.webContents.id);
    return record &&
      !record.finalizing &&
      record.window === focused &&
      isConsoleSurfaceUrl(focused.webContents.getURL(), rendererUrl)
      ? record
      : undefined;
  }

  function focusedSshWindow(): BrowserWindow | undefined {
    const focused = BrowserWindow.getFocusedWindow();
    return focused && isCurrentClaimedSshWindow(focused) ? focused : undefined;
  }

  function sendSshMenuEvent(window: BrowserWindow, channel: string): void {
    if (focusedSshWindow() !== window || window.webContents.isDestroyed()) return;
    window.webContents.send(channel);
  }

  function sendSshTabSelectionEvent(window: BrowserWindow, index: number): void {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= SSH_MAX_TABS_PER_WINDOW ||
      focusedSshWindow() !== window ||
      window.webContents.isDestroyed()
    ) return;
    window.webContents.send(SSH_IPC_EVENTS.selectTabRequested, index);
  }

  function isClaimedConsoleWindow(record: ConsoleWindowRecord): boolean {
    if (
      record.finalizing ||
      record.window.isDestroyed() ||
      record.window.webContents.isDestroyed() ||
      consoleWindowsByContentsId.get(record.window.webContents.id) !== record ||
      !record.claimedBy ||
      !sameWindowIdentity(record.claimedBy, identityForWindow(record.window))
    ) return false;
    return isConsoleSurfaceUrl(record.window.webContents.getURL(), rendererUrl);
  }

  function sendConsoleMenuEvent(record: ConsoleWindowRecord, channel: string): void {
    if (focusedConsoleWindow() !== record || record.window.webContents.isDestroyed()) return;
    record.window.webContents.send(channel);
  }

  function sendConsoleMenuEventFromInput(record: ConsoleWindowRecord, channel: string): void {
    if (!isClaimedConsoleWindow(record)) return;
    record.window.webContents.send(channel);
  }

  function sendConsoleTabSelectionEvent(record: ConsoleWindowRecord, index: number): void {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= CONSOLE_MAX_TABS_PER_WINDOW ||
      focusedConsoleWindow() !== record ||
      record.window.webContents.isDestroyed()
    ) return;
    record.window.webContents.send(IPC.consoleSelectTabRequested, index);
  }

  function sendConsoleTabSelectionFromInput(record: ConsoleWindowRecord, index: number): void {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= CONSOLE_MAX_TABS_PER_WINDOW ||
      !isClaimedConsoleWindow(record)
    ) return;
    record.window.webContents.send(IPC.consoleSelectTabRequested, index);
  }

  function beginShutdown(): void {
    systemIconAppearance.dispose();
    if (!shutdown.isStopping) {
      armoryService.dispose();
      const sshCleanup = sshSessions?.dispose();
      if (sshCleanup) {
        const cleanup = sshCleanup.finally(disposeCloudDeployment);
        trackPendingCleanup(cleanup);
      } else {
        disposeCloudDeployment();
      }
      for (const record of consoleWindowsByContentsId.values()) {
        void closeConsoleWindow(record, "application-shutdown");
      }
    }
    shutdown.beginQuit();
  }

  function applyNativeThemeToWindow(
    window: BrowserWindow,
    surface: NativeWindowSurface,
  ): void {
    if (window.isDestroyed()) return;
    applicationIcons.applyToWindow(window);
    const dark = nativeTheme.shouldUseDarkColors;
    try {
      if (surface === "workspace") {
        window.setBackgroundColor("#00000000");
        if (process.platform !== "darwin") {
          window.setTitleBarOverlay({
            color: "#00000000",
            symbolColor: titleBarSymbolColor(dark),
            height: 72,
          });
        }
      } else {
        window.setBackgroundColor(nativeWindowBackgroundColor(dark));
      }
    } catch {
      // A native window can enter teardown while the operating-system theme
      // changes. Its renderer has either already gone or will read the current
      // theme on the next trusted load.
    }
  }

  function applyNativeWindowTheme(): void {
    for (const [window, surface] of nativeWindowSurfaces) {
      applyNativeThemeToWindow(window, surface);
    }
    const cloudWindow = cloudDeploymentWindow;
    if (
      cloudWindow &&
      !cloudWindow.isDestroyed() &&
      !cloudWindow.webContents.isDestroyed()
    ) {
      cloudWindow.webContents.send(
        CLOUD_DEPLOYMENT_IPC_EVENTS.themeChanged,
        nativeTheme.shouldUseDarkColors,
      );
    }
  }

  function applyApplicationIcon(): void {
    if (shutdown.isStopping) return;
    applicationIcons.update(applicationSettingsStore?.getState().appIcon ?? "auto", systemIconAppearance.isDark());
    for (const window of nativeWindowSurfaces.keys()) applicationIcons.applyToWindow(window);
    const icon = applicationIcons.getResolvedIcon();
    for (const [window, surface] of nativeWindowSurfaces) {
      if (surface !== "workspace" || window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        window.webContents.send(IPC.applicationIconChanged, icon);
      } catch {
        // A renderer can navigate or close during an OS appearance update.
        // Its next trusted load reads the current icon through the getter.
      }
    }
  }

  function publishApplicationSettingsState(state: ApplicationSettingsState): void {
    if (shutdown.isStopping) return;
    for (const window of windows) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        window.webContents.send(IPC.applicationSettingsChanged, state);
      } catch {
        // Navigation and renderer teardown can race a main-process event. The
        // next trusted renderer reads the current persisted snapshot.
      }
    }
  }

  async function updateApplicationSettings(
    input: ApplicationSettingsUpdateInput,
  ): Promise<OperationResult<ApplicationSettingsState>> {
    if (!applicationSettingsStore) {
      return { ok: false, error: "Application settings are unavailable" };
    }
    const previous = applicationSettingsStore.getState();
    for (const { id } of KEYBOARD_SHORTCUT_DEFINITIONS) {
      const shortcut = resolveKeyboardShortcut(id, input.settings, process.platform === "darwin");
      if (shortcut === resolveKeyboardShortcut(id, previous, process.platform === "darwin")) continue;
      const conflict = keyboardShortcutConflict(id, shortcut, input.settings, process.platform === "darwin");
      if (conflict) return { ok: false, error: conflict };
    }
    const result = await applicationSettingsStore.update(input);
    if (!result.ok || !result.value) return result;
    nativeTheme.themeSource = result.value.theme;
    applyApplicationIcon();
    applyNativeWindowTheme();
    installMenu();
    publishApplicationSettingsState(result.value);
    return result;
  }

  async function chooseReportScreenshotDirectory(
    source: TrustedWindowIdentity,
  ): Promise<OperationResult<{ directory: string }>> {
    const owner = windowsByContentsId.get(source.contentsId);
    if (
      !owner || owner.isDestroyed() || owner.webContents.isDestroyed() ||
      nativeWindowSurfaces.get(owner) !== "workspace" ||
      !sameWindowIdentity(source, identityForWindow(owner))
    ) return { ok: false, error: "This window cannot choose a screenshot directory" };

    try {
      const selected = await dialog.showOpenDialog(owner, {
        title: "Choose screenshot directory",
        defaultPath: applicationSettingsStore?.getState().reportScreenshotDirectory ?? app.getPath("desktop"),
        properties: ["openDirectory", "createDirectory"],
      });
      if (selected.canceled || selected.filePaths.length === 0) return { ok: false, error: "cancelled" };
      if (
        owner.isDestroyed() || owner.webContents.isDestroyed() ||
        !sameWindowIdentity(source, identityForWindow(owner))
      ) return { ok: false, error: "The screenshot directory selection is no longer current" };
      const chosen = selected.filePaths[0];
      if (!chosen || !isAbsolute(chosen)) return { ok: false, error: "Choose an absolute screenshot directory" };
      const directory = await realpath(chosen);
      if (!(await lstat(directory)).isDirectory()) return { ok: false, error: "Choose a directory" };
      return { ok: true, value: { directory } };
    } catch {
      return { ok: false, error: "The screenshot directory could not be selected" };
    }
  }

  async function reportScreenshot(): Promise<OperationResult<{ directory: string; files: string[] }>> {
    if (shutdown.isStopping) return { ok: false, error: "The application is closing" };
    try {
      const directory = applicationSettingsStore?.getState().reportScreenshotDirectory ?? app.getPath("desktop");
      const result = await captureReportScreenshots(directory);
      if (result.failures.length > 0) {
        return {
          ok: false,
          error: `Saved ${result.savedPaths.length} of ${result.windowCount} screenshots to ${result.directory}. ` +
            `${result.failures.length} windows could not be captured.`,
        };
      }
      return { ok: true, value: { directory: result.directory, files: result.savedPaths } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Screenshots could not be saved" };
    }
  }

  function stopKeyboardShortcutRecording(window: BrowserWindow): void {
    if (!shortcutRecordingWindows.delete(window)) return;
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.setIgnoreMenuShortcuts(false);
    }
  }

  function setKeyboardShortcutRecording(source: TrustedWindowIdentity, isRecording: boolean): void {
    const window = windowsByContentsId.get(source.contentsId);
    if (
      !window || window.isDestroyed() || window.webContents.isDestroyed() ||
      nativeWindowSurfaces.get(window) !== "workspace" ||
      !sameWindowIdentity(source, identityForWindow(window))
    ) throw new Error("This window is not authorized to configure keyboard shortcuts");
    if (!isRecording) {
      stopKeyboardShortcutRecording(window);
      return;
    }
    // A delayed renderer request after blur must not suppress a different
    // window's native shortcuts or outlive the focus-bound recorder UI.
    if (!window.isFocused()) throw new Error("Focus this window to record a keyboard shortcut");
    window.webContents.setIgnoreMenuShortcuts(true);
    shortcutRecordingWindows.add(window);
  }

  function publishApplicationUpdateState(state: ApplicationUpdateState): void {
    if (shutdown.isStopping) return;
    const previousMenuState = applicationUpdateState
      ? applicationUpdateMenuSignature(applicationUpdateState)
      : undefined;
    applicationUpdateState = state;
    if (previousMenuState !== applicationUpdateMenuSignature(state)) installMenu();
    // Disabled states are published only by an explicit menu check. Keep that
    // result attached to the window where the operator requested it instead
    // of surprising every open workspace with the same toast.
    const updateWindows = state.status === "disabled"
      ? [BrowserWindow.getFocusedWindow()].filter(
          (window): window is BrowserWindow => window !== null && windows.has(window),
        )
      : windows;
    for (const window of updateWindows) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        window.webContents.send(IPC.applicationUpdateChanged, state);
      } catch {
        // Navigation and renderer teardown can race a main-process event. The
        // next trusted renderer can always read the current updater snapshot.
      }
    }
  }

  async function confirmApplicationUpdateRestart(): Promise<void> {
    const window = BrowserWindow.getFocusedWindow();
    const options = {
      type: "warning" as const,
      title: "Restart to apply the update?",
      message: "Restart Sliver Desktop and apply the downloaded update?",
      detail: "Restarting closes every Sliver Desktop window and all managed shells. Save any terminal output and finish in-flight work before continuing.",
      buttons: ["Later", "Restart and Update"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const result = window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    if (result.response === 1) restartApplicationForUpdate();
  }

  function restartApplicationForUpdate(): OperationResult {
    if (!allowEditorQuit()) return { ok: false, error: "Restart canceled to keep unsaved changes" };
    const result = applicationUpdater?.restartToApply() ?? { ok: false, error: "Application updates are unavailable" };
    if (!result.ok) {
      scriptCloseGuard.cancelQuit();
      textEditorWindows?.cancelQuit();
    }
    return result;
  }

  function startReleaseDownload(target: SliverReleaseTarget): void {
    const window = BrowserWindow.getFocusedWindow();
    if (!window || window.isDestroyed()) return;
    const downloader = target.artifact === "crackstation"
      ? crackstationReleaseDownloader
      : releaseDownloader;
    if (!downloader) return;
    trackPendingCleanup(
      downloader.download(target, (event) => sendReleaseDownloadEvent(window, event)),
    );
  }

  function sendReleaseDownloadEvent(window: BrowserWindow, event: SliverReleaseDownloadEvent): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    try {
      window.webContents.send(IPC.releaseDownloadChanged, event);
    } catch {
      // A renderer can close between the liveness check and event delivery;
      // the main-owned download and its cleanup must continue independently.
    }
  }

  async function refreshReleaseMenu(): Promise<void> {
    try {
      const catalog = await releaseDownloader?.latestRelease();
      if (!catalog || shutdown.isStopping) return;
      releaseCatalog = {
        status: "ready",
        version: catalog.version,
        targets: catalog.assets.map(({ artifact, os, arch }) => ({ artifact, os, arch })),
      };
    } catch {
      if (shutdown.isStopping) return;
      releaseCatalog = { status: "unavailable" };
    }
    installMenu();
  }

  async function refreshCrackstationReleaseMenu(): Promise<void> {
    try {
      const catalog = await crackstationReleaseDownloader?.latestRelease();
      if (!catalog || shutdown.isStopping) return;
      crackstationReleaseCatalog = {
        status: "ready",
        version: catalog.version,
        targets: catalog.assets.map(({ artifact, os, arch }) => ({ artifact, os, arch })),
      };
    } catch {
      if (shutdown.isStopping) return;
      crackstationReleaseCatalog = { status: "unavailable" };
    }
    installMenu();
  }

  async function refreshCloudDeploymentMenu(): Promise<void> {
    if (shutdown.isStopping) return;
    const sequence = cloudDeploymentMenuRefreshSequence + 1;
    cloudDeploymentMenuRefreshSequence = sequence;
    let next: readonly CloudMenuDeployment[];
    try {
      const result = await cloudDeploymentController?.getSnapshot();
      if (!result?.ok || !result.value) return;
      next = result.value.state.deployments.map((deployment): CloudMenuDeployment => {
        const hasSshCredential = result.value.credentials.some(({ id, provider }) => (
          id === deployment.credentialId && provider === deployment.provider
        ));
        const sshHost = deployment.provider === "azure"
          ? deployment.spec.usePublicIp
            ? deployment.runtime.publicIpAddress
            : deployment.runtime.privateIpAddress
          : deployment.runtime.publicIpAddress ??
            deployment.runtime.privateIpAddress ??
            deployment.remoteHost;
        const resourceId = deployment.provider === "aws"
          ? deployment.runtime.instanceId
          : deployment.runtime.vmId;
        const hasFirewall = deployment.provider === "aws"
          ? deployment.runtime.securityGroupIds.length > 0 ||
            deployment.managedAssets.some(({ resourceType }) => resourceType === "ec2-security-group")
          : deployment.runtime.networkSecurityGroupId !== null ||
            deployment.managedAssets.some(({ resourceType }) => resourceType === "azure-network-security-group");
        return {
          id: deployment.id,
          provider: deployment.provider,
          name: deployment.name,
          resourceId,
          status: deployment.status,
          hasSsh: hasSshCredential && Boolean(sshHost?.trim()),
          hasFirewall,
        };
      });
    } catch {
      // Retain the last known menu while a transient snapshot read is unavailable.
      return;
    }
    if (shutdown.isStopping || sequence !== cloudDeploymentMenuRefreshSequence) return;
    const nextSignature = JSON.stringify(next);
    if (nextSignature === cloudDeploymentMenuSignature) return;
    cloudMenuDeployments = next;
    cloudDeploymentMenuSignature = nextSignature;
    installMenu();
  }

  const onActivate = (): void => {
    if (shutdown.isStopping) return;
    if (windows.size === 0) {
      createWindow();
      return;
    }
    if ([...windows].some((window) => !window.isDestroyed() && window.isVisible())) return;
    // A retained console can outlive its source workspace. Dock activation
    // must still make its tabs reachable when every visible window is closed.
    const retainedConsole = [...consoleWindowsByContentsId.values()].reverse().find((record) =>
      record.hiddenByUser && !record.finalizing && !record.window.isDestroyed());
    if (retainedConsole) showConsoleWindow(retainedConsole);
  };
  const onWindowAllClosed = (): void => {
    if (process.platform !== "darwin") app.quit();
  };
  let quitCleanupComplete = false;
  let quitCleanupBarrier: Promise<void> | undefined;
  function allowEditorQuit(): boolean {
    if (textEditorWindows?.allowQuit() !== false && scriptCloseGuard.allowQuit()) return true;
    textEditorWindows?.cancelQuit();
    scriptCloseGuard.cancelQuit();
    return false;
  }
  const onBeforeQuit = (event: Electron.Event): void => {
    if (!allowEditorQuit()) event.preventDefault();
  };
  const onWillQuit = (event: Electron.Event): void => {
    // Do not stop services until every document has accepted closing. This also
    // covers a beforeunload veto that raced its dirty-state IPC notification.
    beginShutdown();
    if (quitCleanupComplete) return;
    event.preventDefault();
    quitCleanupBarrier ??= Promise.allSettled([...pendingWindowCleanup, scriptStore.flush()])
      .then(() => {
        quitCleanupComplete = true;
        // Resolved cleanup can finish in a microtask inside Electron's current
        // will-quit stack. Retry on a later turn after the canceled quit resets.
        setImmediate(() => app.quit());
      });
  };
  const onNativeThemeUpdated = (): void => applyNativeWindowTheme();

  await app.whenReady();
  applicationContextMenus = new ApplicationContextMenuController();
  const loadedApplicationSettingsStore = await ApplicationSettingsStore.load(
    join(consoleClientRootDirectory, "gui", APPLICATION_SETTINGS_FILE_NAME),
  );
  const loadedTextEditorSettingsStore = await TextEditorSettingsStore.load(
    join(consoleClientRootDirectory, "gui", TEXT_EDITOR_SETTINGS_FILE_NAME),
  );
  applicationSettingsStore = loadedApplicationSettingsStore;
  systemIconAppearance.start(applyApplicationIcon);
  applyApplicationIcon();
  nativeTheme.themeSource = loadedApplicationSettingsStore.getState().theme;
  nativeTheme.on("updated", onNativeThemeUpdated);
  app.setAboutPanelOptions({
    applicationName: APPLICATION_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: "Licensed under GPLv3",
    credits: "Bred as living shields, these slivers have proven unruly-they know they cannot be caught.",
    authors: ["Sliver Armory"],
    website: "https://github.com/sliverarmory/sliver-gui",
    iconPath: runtimeIconPath,
  });
  releaseDownloader = new SliverReleaseDownloader({
    downloadsDirectory: resolveDownloadsDirectory((name) => app.getPath(name)),
    fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
  });
  crackstationReleaseDownloader = new CrackstationReleaseDownloader({
    downloadsDirectory: resolveDownloadsDirectory((name) => app.getPath(name)),
    fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
  });
  if (!cloudDeploymentController) {
    try {
      cloudDeploymentController = await CloudDeploymentService.create({
        rootDirectory: join(consoleClientRootDirectory, "gui", "cloud-deployment", "v1"),
        operatorConfigDirectory: join(consoleClientRootDirectory, "configs"),
        safeStorage,
        openExternal: (url) => shell.openExternal(url),
        egressIpv4Detector: () => detectCurrentEgressIpv4(
          (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
        ),
      });
    } catch (error) {
      cloudDeploymentController = unavailableCloudDeploymentController(
        applicationErrorMessage(error, "Cloud Deployment could not be initialized"),
      );
    }
  }
  const activeCloudDeploymentController = cloudDeploymentController;
  registry.setManagedServerResolver((digest) => activeCloudDeploymentController.resolveManagedServer?.(digest) ?? null);
  registry.setManagedListenerFirewallController(activeCloudDeploymentController);
  sshSessions = new SshSessionRegistry({
    listSshTargets: async () => activeCloudDeploymentController.listSshTargets?.() ?? {
      ok: false,
      error: "Managed SSH servers are unavailable",
    },
    materializeSshIdentity: async (target) =>
      activeCloudDeploymentController.materializeSshIdentity?.(target) ?? {
        ok: false,
        error: "Managed SSH identity files are unavailable",
      },
    startSshSession: async (deploymentId) =>
      activeCloudDeploymentController.startSshSession?.(deploymentId) ?? {
        ok: false,
        error: "Managed SSH sessions are unavailable",
      },
    approveSshHostKey: async (token) =>
      activeCloudDeploymentController.approveSshHostKey?.(token) ?? {
        ok: false,
        error: "SSH host-key approval is unavailable",
      },
  });
  unsubscribeCloudDeployment = cloudDeploymentController.subscribe?.(publishCloudDeploymentChanged);
  void refreshCloudDeploymentMenu();
  applicationUpdater = createApplicationUpdater({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    portableExecutableFile: process.env["PORTABLE_EXECUTABLE_FILE"],
    appImageFile: process.env["APPIMAGE"],
    linuxPackageType: readLinuxPackageType(),
  });
  applicationUpdateState = applicationUpdater.getState();
  applicationUpdater.subscribe(publishApplicationUpdateState);
  configureSessionSecurity(session.defaultSession, undefined, rendererUrl);
  const cloudDeploymentSession = session.fromPartition(CLOUD_DEPLOYMENT_SESSION_PARTITION);
  configureSessionSecurity(cloudDeploymentSession);
  const networkSession = session.fromPartition(NETWORK_SESSION_PARTITION);
  configureSessionSecurity(networkSession);
  const armorySession = session.fromPartition(ARMORY_SESSION_PARTITION);
  configureSessionSecurity(armorySession);
  const scriptTaskManagerSession = session.fromPartition(SCRIPT_TASK_MANAGER_SESSION_PARTITION);
  configureSessionSecurity(scriptTaskManagerSession, undefined, scriptTaskManagerRendererUrl);
  const textEditorSession = session.fromPartition(TEXT_EDITOR_SESSION_PARTITION);
  configureSessionSecurity(textEditorSession, undefined, textEditorRendererUrl);
  const appProtocolSessions = new Set([session.defaultSession, cloudDeploymentSession, networkSession, armorySession, scriptTaskManagerSession, textEditorSession]);
  for (const rendererSession of appProtocolSessions) {
    rendererSession.protocol.handle(
      APP_SCHEME,
      createAppProtocolHandler(dirname(rendererEntryPath), (url) => net.fetch(url)),
    );
  }
  textEditorWindows = new TextEditorWindows({
    rendererUrl: textEditorRendererUrl,
    preloadPath: options.textEditorPreloadPath ?? join(mainBundleDirectory, "../preload/text-editor.cjs"),
    getApplicationSettings: () => loadedApplicationSettingsStore.getState(),
    getEditorSettings: () => loadedTextEditorSettingsStore.getState(),
    updateEditorSettings: (input) => loadedTextEditorSettingsStore.update(input),
    prepareWindow: (window) => trackWindow(window, undefined, undefined, undefined, undefined, "text-editor", false),
    icon: applicationIcons.getIconPath(),
    remote: {
      load: async (source, remotePath) => {
        try { return await registry.loadRemoteTextEditor(source, remotePath); }
        catch (error) {
          throw new RemoteTextEditorError(error instanceof Error ? error.message : "The remote file could not be opened");
        }
      },
      save: async (binding, remotePath, expectedSha256, text, confirm) => {
        try { return await registry.saveRemoteTextEditor(binding, remotePath, expectedSha256, text, confirm); }
        catch (error) {
          throw new RemoteTextEditorError(error instanceof Error ? error.message : "The remote file could not be saved");
        }
      },
    },
  });
  registerIpcHandlers(
    registry,
    (inheritFromContentsId) => createWindow(inheritFromContentsId),
    rendererUrl,
    {
      open: openSessionShellWindow,
      claim: claimSessionShellWindow,
    },
    () => app.quit(),
    {
      open: openInteractionWindow,
      claim: claimInteractionWindow,
      selectTarget: selectInteractionWindowTarget,
    },
    {
      getState: () => applicationUpdater!.getState(),
      checkForUpdates: () => applicationUpdater!.checkForUpdates(),
      restartToApply: restartApplicationForUpdate,
    },
    {
      open: openConsoleWindow,
      claim: claimConsoleWindow,
      createTab: createConsoleTab,
      closeTab: closeConsoleTab,
      attach: attachConsoleWindow,
    },
    {
      getState: () => loadedApplicationSettingsStore.getState(),
      getIcon: () => applicationIcons.getResolvedIcon(),
      update: updateApplicationSettings,
      setKeyboardShortcutRecording,
      chooseReportScreenshotDirectory,
      reportScreenshot,
    },
    {
      open: openCloudDeploymentWindowFromRenderer,
    },
    {
      commandForDeployment: async (deploymentId) => {
        const targets = await activeCloudDeploymentController.listSshTargets?.() ?? {
          ok: false as const,
          error: "Managed SSH servers are unavailable",
        };
        if (!targets.ok) return targets;
        const target = targets.value.find((candidate) => candidate.deploymentId === deploymentId);
        if (!target) return { ok: false, error: "The managed SSH server is unavailable" };
        const identity = await activeCloudDeploymentController.materializeSshIdentity?.(target) ?? {
          ok: false as const,
          error: "Managed SSH identity files are unavailable",
        };
        if (!identity.ok) return identity;
        try {
          return { ok: true, value: formatSshCommand(target, identity.value.commandPath) };
        } catch {
          return { ok: false, error: "The SSH command is unavailable" };
        }
      },
    },
    {
      store: scriptStore,
      exportScript: async (identity, input, authorize) => {
        const window = windowsByContentsId.get(identity.contentsId);
        if (!window || window.isDestroyed() || window.webContents.isDestroyed() ||
          nativeWindowSurfaces.get(window) !== "workspace" || !sameWindowIdentity(identity, identityForWindow(window))) {
          return { ok: false, error: "This window does not host a script editor" };
        }
        return exportScriptFile(window, input, authorize);
      },
      importScript: async (identity, authorize) => {
        const window = windowsByContentsId.get(identity.contentsId);
        if (!window || window.isDestroyed() || window.webContents.isDestroyed() ||
          nativeWindowSurfaces.get(window) !== "workspace" || !sameWindowIdentity(identity, identityForWindow(window))) {
          return { ok: false, error: "This window does not host a script editor" };
        }
        return importScriptFile(window, scriptStore, authorize);
      },
      setEditorDirty: (identity, isDirty) => {
        const window = windowsByContentsId.get(identity.contentsId);
        if (!window || nativeWindowSurfaces.get(window) !== "workspace" || !sameWindowIdentity(identity, identityForWindow(window))) {
          return { ok: false, error: "This window does not host a script editor" };
        }
        scriptCloseGuard.setDirty(identity.contentsId, isDirty);
        return { ok: true };
      },
    },
    {
      open: async (source, remotePath) => {
        const owner = windowsByContentsId.get(source.id);
        if (!owner || owner.webContents !== source || owner.isDestroyed() ||
          nativeWindowSurfaces.get(owner) !== "workspace" || !textEditorWindows) {
          throw new Error("This window cannot open a remote text editor");
        }
        await textEditorWindows.openRemote(source, remotePath);
      },
    },
  );
  registerScriptTaskManagerIpc({
    relay: scriptTaskRelay,
    workspaceUrl: rendererUrl,
    managerUrl: scriptTaskManagerRendererUrl,
    authorize: (window, identity) => {
      if (!sameWindowIdentity(identity, identityForWindow(window))) return undefined;
      if (nativeWindowSurfaces.get(window) === "workspace") {
        scriptTaskRelay.registerOwner(identity.contentsId);
        return { role: "owner", ownerId: identity.contentsId };
      }
      const record = scriptManagerWindows.get(identity.contentsId);
      const owner = record && windowsByContentsId.get(record.owner.contentsId);
      if (!record || record.window !== window || !owner || nativeWindowSurfaces.get(window) !== "script-task-manager" ||
        !sameWindowIdentity(record.owner, identityForWindow(owner)) ||
        scriptTaskRelay.ownerForManager(identity.contentsId) !== record.owner.contentsId) return undefined;
      return { role: "manager", ownerId: record.owner.contentsId };
    },
    open: (window) => openScriptTaskManager(window),
    settings: () => loadedApplicationSettingsStore.getState(),
  });
  registerCloudDeploymentIpcHandlers(
    cloudDeploymentController,
    cloudDeploymentRendererUrl,
    (identity, window) =>
      cloudDeploymentWindow === window &&
      nativeWindowSurfaces.get(window) === "cloud-deployment" &&
      sameWindowIdentity(identity, identityForWindow(window)),
    {
      open: openManagedSshWindow,
      approveHostKey: approveManagedSshHostKey,
    },
  );
  registerArmoryIpcHandlers({
    manager: armoryService,
    writeClipboardText: (text) => clipboard.writeText(text),
    openExternal: (url) => shell.openExternal(url),
    getTab: () => armoryTab,
    getApplicationSettings: () => loadedApplicationSettingsStore.getState(),
    changed: publishArmoryChanged,
  }, armoryRendererUrl, (identity, window) =>
    !shutdown.isStopping && armoryWindow === window && nativeWindowSurfaces.get(window) === "armory" &&
    sameWindowIdentity(identity, identityForWindow(window)),
  );
  registerNetworkForwardingIpcHandlers(
    {
      forwarding: {
        getContext: (contentsId) => registry.networkContext(contentsId),
        list: (contentsId, input) => registry.listNetworkForwards(contentsId, input),
        startPortForward: (contentsId, input) => registry.startNetworkPortForward(contentsId, input),
        stopPortForward: (contentsId, id) => registry.stopNetworkPortForward(contentsId, id),
        startReversePortForward: (contentsId, input) =>
          registry.startNetworkReversePortForward(contentsId, input),
        stopReversePortForward: (contentsId, input) =>
          registry.stopNetworkReversePortForward(contentsId, input),
        startSocks5Proxy: (contentsId, input) => registry.startNetworkSocks5Proxy(contentsId, input),
        stopSocks5Proxy: (contentsId, id) => registry.stopNetworkSocks5Proxy(contentsId, id),
      },
      applicationSettings: {
        getState: () => loadedApplicationSettingsStore.getState(),
      },
    },
    networkRendererUrl,
    (identity, window) => {
      const record = networkWindowsByContentsId.get(identity.contentsId);
      return record !== undefined &&
        record.window === window &&
        nativeWindowSurfaces.get(window) === "network" &&
        sameWindowIdentity(identity, identityForWindow(window));
    },
  );
  registerSshIpcHandlers(
    {
      sessions: {
        claim: claimManagedSshWindow,
        listTargets: (owner) => sshSessions!.listTargets(owner),
        createTarget: (deploymentId, owner) => sshSessions!.createTarget(deploymentId, owner),
        reattachTab: (owner, tabId) => sshSessions!.reattachTab(owner, tabId),
        approveNewHostKey: (token, owner) => sshSessions!.approveNewHostKey(token, owner),
        closeTab: (owner, tabId) => sshSessions!.closeTab(owner, tabId),
        selectTab: (owner, tabId) => sshSessions!.selectTab(owner, tabId),
        commandForTab: (owner, tabId) => sshSessions!.commandForTab(owner, tabId),
        renameTab: (owner, tabId, label) => sshSessions!.renameTab(owner, tabId, label),
        attach: (owner, attachmentToken, port) =>
          sshSessions!.attach(owner, attachmentToken, port),
      },
      getTerminalRuntime: () => activeCloudDeploymentController.getTerminalRuntime(),
      applicationSettings: {
        getState: () => loadedApplicationSettingsStore.getState(),
        update: updateApplicationSettings,
      },
    },
    sshRendererUrl,
    (identity, window) =>
      sshWindow === window &&
      nativeWindowSurfaces.get(window) === "ssh" &&
      sameWindowIdentity(identity, identityForWindow(window)),
  );
  installMenu();
  void refreshScriptMenu();
  void refreshReleaseMenu();
  void refreshCrackstationReleaseMenu();
  app.on("activate", onActivate);
  app.on("window-all-closed", onWindowAllClosed);
  app.on("before-quit", onBeforeQuit);
  app.on("will-quit", onWillQuit);
  createWindow();
  applicationUpdater.start();

  return {
    createWindow,
    async stop(): Promise<void> {
      beginShutdown();
      // A real application quit keeps the updater subscription alive through
      // Electron's later `quit` event: electron-updater performs an
      // autoInstallOnAppQuit installation there and may still emit `error`.
      // The explicit test/embedding teardown does not quit Electron, so it
      // owns the final updater disposal instead.
      shutdown.disposeForEmbedding();
      app.removeListener("activate", onActivate);
      app.removeListener("window-all-closed", onWindowAllClosed);
      app.removeListener("before-quit", onBeforeQuit);
      app.removeListener("will-quit", onWillQuit);
      nativeTheme.removeListener("updated", onNativeThemeUpdated);
      systemIconAppearance.dispose();
      applicationContextMenus?.dispose();
      applicationContextMenus = undefined;
      unregisterCloudDeploymentIpcHandlers();
      unregisterNetworkForwardingIpcHandlers();
      unregisterArmoryIpcHandlers();
      unregisterSshIpcHandlers();
      unregisterScriptTaskManagerIpc();
      textEditorWindows?.dispose();
      unregisterIpcHandlers();
      for (const window of [...windows]) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
        await registry.closeWindowStreams(window.webContents.id, "application-shutdown").catch(() => undefined);
        window.close();
      }
      await Promise.allSettled([...pendingWindowCleanup, scriptStore.flush()]);
      for (const rendererSession of appProtocolSessions) {
        rendererSession.protocol.unhandle(APP_SCHEME);
        appProtocolSessions.delete(rendererSession);
      }
    },
  };
}

function applicationUpdateMenuSignature(state: ApplicationUpdateState): string {
  switch (state.status) {
    case "available":
    case "ready":
      return `${state.status}:${state.availableVersion}`;
    case "downloading":
      return `${state.status}:${state.availableVersion}:${Math.round(state.progressPercent)}`;
    case "disabled":
      return `${state.status}:${state.disabledReason}`;
    case "idle":
    case "up-to-date":
    case "error":
      return "check-available";
    case "checking":
      return state.status;
  }
}

function readLinuxPackageType(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return readFileSync(join(process.resourcesPath, "package-type"), "utf8").trim();
  } catch {
    return undefined;
  }
}

function rendererUrlForSurface(
  rendererUrl: string,
  surface: "armory" | "cloud-deployment" | "console" | "interaction" | "managed-shells" | "network" | "ssh" | "script-task-manager" | "text-editor",
): string {
  const url = new URL(rendererUrl);
  url.searchParams.set("surface", surface);
  return url.href;
}

function identityForWindow(window: BrowserWindow): TrustedWindowIdentity | undefined {
  try {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return undefined;
    const frame = window.webContents.mainFrame;
    if (frame.isDestroyed()) return undefined;
    return {
      contentsId: window.webContents.id,
      rendererProcessId: frame.processId,
      rendererFrameToken: frame.frameToken,
    };
  } catch {
    return undefined;
  }
}

function sameWindowIdentity(
  left: TrustedWindowIdentity,
  right: TrustedWindowIdentity | undefined,
): boolean {
  return right !== undefined &&
    left.contentsId === right.contentsId &&
    left.rendererProcessId === right.rendererProcessId &&
    left.rendererFrameToken === right.rendererFrameToken;
}

function sessionShellWindowKey(sourceContentsId: number, target: TargetRef): string {
  return `${sourceContentsId}:${target.backendEpoch}:${target.id.length}:${target.id}:${target.fingerprint}`;
}

function sameTargetIdentity(left: TargetRef, right: TargetRef): boolean {
  return left.mode === right.mode &&
    left.id === right.id &&
    left.backendEpoch === right.backendEpoch &&
    left.fingerprint === right.fingerprint;
}

function freshTargetIdentity(snapshot: SliverSnapshot, expected: TargetRef): TargetRef | undefined {
  const active = snapshot.targetContext.activeTarget;
  if (active && sameTargetIdentity(active, expected)) return active;
  return snapshot.targetContext.selectableTargets.find((target) => sameTargetIdentity(target, expected));
}

function isCurrentInteractionDestination(
  record: InteractionWindowRecord,
  destination: TrustedWindowIdentity,
  registeredRecord: InteractionWindowRecord | undefined,
  generation: number,
): boolean {
  return registeredRecord === record &&
    record.generation === generation &&
    !record.window.isDestroyed() &&
    record.window.webContents.id === destination.contentsId &&
    sameWindowIdentity(destination, identityForWindow(record.window));
}

function resetInteractionWindowClaim(record: InteractionWindowRecord): void {
  record.generation += 1;
  delete record.claimedBy;
}

function isInteractionSurfaceUrl(candidateUrl: string, rendererUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    return isTrustedRendererUrl(candidate.href, rendererUrl) &&
      candidate.search === "?surface=interaction" &&
      candidate.hash === "";
  } catch {
    return false;
  }
}

function isConsoleSurfaceUrl(candidateUrl: string, rendererUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    return isTrustedRendererUrl(candidate.href, rendererUrl) &&
      candidate.search === "?surface=console" &&
      candidate.hash === "";
  } catch {
    return false;
  }
}

function isSshSurfaceUrl(candidateUrl: string, rendererUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    return isTrustedRendererUrl(candidate.href, rendererUrl) &&
      candidate.search === "?surface=ssh" &&
      candidate.hash === "";
  } catch {
    return false;
  }
}

export function resolveConsoleClientExecutable(
  packaged: boolean,
  resourcesDirectory: string,
  mainBundleDirectory: string,
  platform: NodeJS.Platform,
): string {
  const fileName = platform === "win32" ? "sliver-client.exe" : "sliver-client";
  const root = packaged
    ? resourcesDirectory
    : join(mainBundleDirectory, "../..", "native");
  return join(root, "sliver-console", fileName);
}

async function loadNodePtyFactory(): Promise<NativePtyFactory> {
  const loaded = await import("node-pty");
  const spawn = loaded.spawn;
  if (typeof spawn !== "function") throw new Error("The native PTY runtime is unavailable");
  const factory: NativePtyFactory = {
    spawn(file, args, options) {
      return spawn(file, args, {
        name: options.name,
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        env: { ...options.env },
      });
    },
  };
  return Object.freeze(factory);
}

function consoleAttachmentPort(port: MessagePortMain): ConsoleAttachmentPort {
  return {
    postMessage: (frame) => port.postMessage(frame),
    onMessage: (listener) => {
      const handler = (event: ElectronMessageEvent): void => listener(event.data);
      port.on("message", handler);
      return () => port.removeListener("message", handler);
    },
    onClose: (listener) => {
      port.on("close", listener);
      return () => port.removeListener("close", listener);
    },
    start: () => port.start(),
    close: () => port.close(),
  };
}

function serializeInteractionTransition<T>(
  record: InteractionWindowRecord,
  transition: () => Promise<T>,
): Promise<T> {
  const result = record.transition.then(transition, transition);
  record.transition = result.then(() => undefined, () => undefined);
  return result;
}

function setInteractionWindowTitle(window: BrowserWindow, snapshot: SliverSnapshot): void {
  if (window.isDestroyed()) return;
  const summary = snapshot.targetContext.activeTargetSummary;
  if (!summary) return;
  window.setTitle(`Interact — ${summary.name || summary.hostname || summary.id}`);
}

function unavailableCloudDeploymentController(
  message: string,
): ApplicationCloudDeploymentController {
  const controller: ApplicationCloudDeploymentController = {
    getSnapshot: () => ({ ok: false, error: message }),
    refreshDeployments: () => ({ ok: false, error: message }),
    getProvisioningTranscripts: () => ({ ok: false, error: message }),
    getTerminalRuntime: () => ({ ok: false, error: message }),
    detectCurrentEgressIpv4: () => ({ ok: false, error: message }),
    chooseSshPrivateKey: () => ({ ok: false, error: message }),
    createCredential: () => ({ ok: false, error: message }),
    loginAwsCredential: () => ({ ok: false, error: message }),
    beginAzureLogin: () => ({ ok: false, error: message }),
    loginAzureCredential: () => ({ ok: false, error: message }),
    cancelAzureLogin: () => undefined,
    deleteCredential: () => ({ ok: false, error: message }),
    testCredential: () => ({ ok: false, error: message }),
    discoverAwsOptions: () => ({ ok: false, error: message }),
    discoverAzureAccounts: () => ({ ok: false, error: message }),
    discoverAzureOptions: () => ({ ok: false, error: message }),
    listDnsZones: () => ({ ok: false, error: message }),
    listDnsRecords: () => ({ ok: false, error: message }),
    createDnsRecord: () => ({ ok: false, error: message }),
    updateDnsRecord: () => ({ ok: false, error: message }),
    deleteDnsRecord: () => ({ ok: false, error: message }),
    createDeployment: () => ({ ok: false, error: message }),
    generateOperatorConfig: () => ({ ok: false, error: message, mutationState: "not-started" }),
    runLifecycleAction: () => ({ ok: false, error: message }),
    renameDeployment: () => ({ ok: false, error: message }),
    updateFirewall: () => ({ ok: false, error: message }),
    listFirewallRules: () => ({ ok: false, error: message }),
    createFirewallRule: () => ({ ok: false, error: message }),
    updateFirewallRule: () => ({ ok: false, error: message }),
    deleteFirewallRule: () => ({ ok: false, error: message }),
    ensureIngress: async () => ({ ok: false, error: message }),
    removeIngress: async () => ({ ok: false, error: message }),
    prepareDestroyDeployment: () => ({ ok: false, error: message }),
    executeDestroyDeployment: () => ({ ok: false, error: message }),
  };
  return Object.freeze(controller);
}

function applicationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (
    error.message === "The source window changed before managed shells could be popped out" ||
    error.message === "Select an active session before popping out managed shells"
  ) return error.message;
  return fallback;
}
