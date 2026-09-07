import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  net,
  nativeTheme,
  safeStorage,
  session,
  shell,
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
import type { TargetRef } from "../shared/target-contracts.js";
import type {
  SliverReleaseDownloadEvent,
  SliverReleaseTarget,
} from "../shared/release-contracts.js";
import {
  buildApplicationMenuTemplate,
  buildContextMenuTemplate,
  commandPaletteShortcutDispositionForInput,
  consoleTabShortcutIndexForInput,
  isConsoleNewTabShortcutInput,
  serverRefreshShortcutDispositionForInput,
  type ReleaseMenuCatalog,
} from "./application-menus.js";
import {
  createApplicationUpdater,
  type ApplicationUpdater,
} from "./application-updater.js";
import { ApplicationShutdownCoordinator } from "./application-shutdown.js";
import { ApplicationSettingsStore } from "./application-settings.js";
import { ConnectionRegistry } from "./connection-registry.js";
import { resolveDownloadsDirectory } from "./download-directory.js";
import {
  registerIpcHandlers,
  unregisterIpcHandlers,
  type TrustedWindowIdentity,
} from "./ipc.js";
import { configureSessionSecurity, hardenWindow, isTrustedRendererUrl } from "./security.js";
import { SliverReleaseDownloader } from "./sliver-release-download.js";
import {
  CLOUD_DEPLOYMENT_IPC_EVENTS,
  type CloudDeploymentChangeScope,
} from "../shared/cloud-deployment-ipc.js";
import {
  registerCloudDeploymentIpcHandlers,
  unregisterCloudDeploymentIpcHandlers,
  type CloudDeploymentController,
} from "./cloud-deployment-ipc.js";
import { CloudDeploymentService } from "./cloud-deployment-service.js";
import { detectCurrentEgressIpv4 } from "./cloud/current-egress-ipv4.js";
import {
  CLOUD_DEPLOYMENT_SESSION_PARTITION,
  cloudDeploymentWindowOptions,
  consoleWindowOptions,
  interactionWindowOptions,
  mainWindowOptions,
  nativeWindowBackgroundColor,
  sessionShellWindowOptions,
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

const APPLICATION_DISPLAY_NAME = "Sliver Desktop";
const APPLICATION_SETTINGS_FILE_NAME = "application-settings.json";

type NativeWindowSurface =
  | "workspace"
  | "cloud-deployment"
  | "interaction"
  | "managed-shells"
  | "console";

export interface StartApplicationOptions {
  registry?: ConnectionRegistry;
  rendererEntryPath?: string;
  preloadPath?: string;
  cloudDeploymentPreloadPath?: string;
  developmentRendererUrl?: string;
  applicationAssetsDirectory?: string;
  consoleClientExecutable?: string;
  consoleClientRootDirectory?: string;
  consolePtyFactory?: NativePtyFactory;
  startConsoleRuntime?: typeof SliverConsoleRuntime.start;
  /** Test/embedding override. Production creates the main-owned service. */
  cloudDeploymentController?: ApplicationCloudDeploymentController;
}

export interface ApplicationCloudDeploymentController extends CloudDeploymentController {
  subscribe?(listener: (scope: CloudDeploymentChangeScope) => void): () => void;
  dispose?(): void;
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

/**
 * Compose the trusted Electron main process. Tests may inject an in-memory
 * backend by importing this module from a test-only main entry; the production
 * entrypoint always uses the real ConnectionRegistry defaults.
 */
export async function startApplication(options: StartApplicationOptions = {}): Promise<ApplicationHandle> {
  const registry = options.registry ?? new ConnectionRegistry();
  const mainBundleDirectory = import.meta.dirname;
  const applicationAssetsDirectory = options.applicationAssetsDirectory ?? join(mainBundleDirectory, "../../build");
  const runtimeIconPath = app.isPackaged
    ? join(process.resourcesPath, "sliver-desktop.png")
    : join(applicationAssetsDirectory, "about-icon.png");
  const developmentDockIconPath = join(applicationAssetsDirectory, "icon.png");
  const rendererEntryPath = options.rendererEntryPath ?? join(mainBundleDirectory, "../renderer/index.html");
  const preloadPath = options.preloadPath ?? join(mainBundleDirectory, "../preload/index.cjs");
  const cloudDeploymentPreloadPath = options.cloudDeploymentPreloadPath ?? join(
    mainBundleDirectory,
    "../preload/cloud-deployment.cjs",
  );
  const consoleClientExecutable = options.consoleClientExecutable ?? resolveConsoleClientExecutable(
    app.isPackaged,
    process.resourcesPath,
    mainBundleDirectory,
    process.platform,
  );
  const consoleClientRootDirectory = options.consoleClientRootDirectory ?? join(
    homedir(),
    ".sliver-client",
  );
  const startConsoleRuntime = options.startConsoleRuntime ?? SliverConsoleRuntime.start;
  // Packaged applications always trust their immutable file entry. A caller's
  // inherited environment must never redirect production IPC trust to even a
  // loopback web origin.
  const developmentRendererUrl = app.isPackaged
    ? undefined
    : options.developmentRendererUrl ?? readDevelopmentRendererUrl();
  const rendererUrl = developmentRendererUrl ?? pathToFileURL(rendererEntryPath).href;
  const cloudDeploymentRendererUrl = rendererUrlForSurface(rendererUrl, "cloud-deployment");
  const windows = new Set<BrowserWindow>();
  const nativeWindowSurfaces = new Map<BrowserWindow, NativeWindowSurface>();
  const windowsByContentsId = new Map<number, BrowserWindow>();
  const sessionShellWindowsByKey = new Map<string, SessionShellWindowRecord>();
  const sessionShellWindowsByContentsId = new Map<number, SessionShellWindowRecord>();
  const interactionWindowsByContentsId = new Map<number, InteractionWindowRecord>();
  const consoleWindowsByKey = new Map<string, ConsoleWindowRecord>();
  const consoleWindowsByContentsId = new Map<number, ConsoleWindowRecord>();
  let cloudDeploymentWindow: BrowserWindow | undefined;
  const pendingWindowCleanup = new Set<Promise<void>>();
  let releaseCatalog: ReleaseMenuCatalog = { status: "loading" };
  let releaseDownloader: SliverReleaseDownloader | undefined;
  let applicationUpdater: ApplicationUpdater | undefined;
  let applicationUpdateState: ApplicationUpdateState | undefined;
  let applicationSettingsStore: ApplicationSettingsStore | undefined;
  let cloudDeploymentController = options.cloudDeploymentController;
  let unsubscribeCloudDeployment: (() => void) | undefined;
  let cloudDeploymentDisposed = false;
  const shutdown = new ApplicationShutdownCoordinator({
    stopReleaseDownloads: () => releaseDownloader?.stop(),
    disposeApplicationUpdater: () => applicationUpdater?.dispose(),
  });

  function publishCloudDeploymentChanged(scope: CloudDeploymentChangeScope): void {
    const window = cloudDeploymentWindow;
    if (
      shutdown.isStopping ||
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

  function disposeCloudDeployment(): void {
    if (cloudDeploymentDisposed) return;
    cloudDeploymentDisposed = true;
    unsubscribeCloudDeployment?.();
    unsubscribeCloudDeployment = undefined;
    cloudDeploymentController?.dispose?.();
  }

  async function loadRenderer(
    window: BrowserWindow,
    surface?: "cloud-deployment" | "console" | "interaction" | "managed-shells",
  ): Promise<void> {
    if (developmentRendererUrl) {
      const url = new URL(developmentRendererUrl);
      if (surface) url.searchParams.set("surface", surface);
      await window.loadURL(url.href);
      return;
    }
    if (surface) await window.loadFile(rendererEntryPath, { query: { surface } });
    else await window.loadFile(rendererEntryPath);
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
      surface === "cloud-deployment" ? cloudDeploymentRendererUrl : undefined,
    );
    installContextMenu(window);
    if (registerWithConnectionRegistry) window.webContents.on("before-input-event", (event, input) => {
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
        const disposition = serverRefreshShortcutDispositionForInput(input);
        if (!disposition) return;
        // F5 reconciles the trusted backend snapshot; it must never reload the
        // renderer and tear down active UI state.
        event.preventDefault();
        if (disposition === "refresh") {
          void registry.refresh(contentsId).catch(() => undefined);
        }
      });
    }
    if (consoleWindowRecord) {
      window.webContents.on("before-input-event", (event, input) => {
        const index = consoleTabShortcutIndexForInput(process.platform, input);
        const requestsNewTab = isConsoleNewTabShortcutInput(process.platform, input);
        if (
          (index === undefined && !requestsNewTab) ||
          !isClaimedConsoleWindow(consoleWindowRecord)
        ) return;
        // Ghostty consumes terminal key events before Electron's menu accelerator
        // dispatch. This trusted event originates from this exact webContents,
        // so claim the chord before it reaches the renderer or its PTY.
        event.preventDefault();
        if (input.isAutoRepeat) return;
        if (requestsNewTab) {
          sendConsoleMenuEventFromInput(consoleWindowRecord, IPC.consoleNewTabRequested);
        } else if (index !== undefined) {
          sendConsoleTabSelectionFromInput(consoleWindowRecord, index);
        }
      });
    }
    window.on("focus", installMenu);
    window.once("ready-to-show", () => window.show());
    let completedInitialLoad = false;
    window.webContents.once("did-finish-load", () => {
      completedInitialLoad = true;
    });
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        if (registerWithConnectionRegistry) {
          void registry.closeWindowStreams(contentsId, "navigation").catch(() => undefined);
        }
        if (sessionShellRecord && completedInitialLoad) retireSessionShellWindow(sessionShellRecord);
        if (interactionWindowRecord && completedInitialLoad) resetInteractionWindowClaim(interactionWindowRecord);
        if (consoleWindowRecord && completedInitialLoad) retireConsoleWindow(consoleWindowRecord, "navigation");
      }
    });
    window.webContents.on("render-process-gone", () => {
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
    if (sessionShellRecord) {
      window.on("close", (event) => {
        if (
          shutdown.isStopping ||
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
      runtimeIconPath,
      nativeTheme.shouldUseDarkColors,
    ));
    trackWindow(window, inheritFromContentsId);
    void loadRenderer(window);
    return window;
  }

  async function openCloudDeploymentWindow(): Promise<OperationResult> {
    if (shutdown.isStopping) {
      return { ok: false, error: "Cloud Deployment is unavailable while the application is closing" };
    }
    let createdWindow: BrowserWindow | undefined;
    try {
      const existing = cloudDeploymentWindow;
      if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.show();
        existing.focus();
        return { ok: true };
      }

      createdWindow = new BrowserWindow(cloudDeploymentWindowOptions(
        cloudDeploymentPreloadPath,
        process.platform,
        runtimeIconPath,
        nativeTheme.shouldUseDarkColors,
      ));
      cloudDeploymentWindow = createdWindow;
      createdWindow.on("closed", () => {
        if (cloudDeploymentWindow === createdWindow) cloudDeploymentWindow = undefined;
      });
      trackWindow(
        createdWindow,
        undefined,
        undefined,
        undefined,
        undefined,
        "cloud-deployment",
        false,
      );
      await loadRenderer(createdWindow, "cloud-deployment");
      if (createdWindow.isDestroyed()) {
        throw new Error("The Cloud Deployment window closed while its renderer was loading");
      }
      createdWindow.setTitle("Cloud Deployment");
      createdWindow.webContents.send(
        CLOUD_DEPLOYMENT_IPC_EVENTS.themeChanged,
        nativeTheme.shouldUseDarkColors,
      );
      return { ok: true };
    } catch (error) {
      if (cloudDeploymentWindow === createdWindow) cloudDeploymentWindow = undefined;
      if (createdWindow && !createdWindow.isDestroyed()) createdWindow.destroy();
      return {
        ok: false,
        error: applicationErrorMessage(error, "Cloud Deployment could not be opened"),
      };
    }
  }

  function openCloudDeploymentWindowFromRenderer(
    source: TrustedWindowIdentity,
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
    return openCloudDeploymentWindow();
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
        runtimeIconPath,
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
        runtimeIconPath,
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
        if (existing.openPromise) return existing.openPromise;
        failureKind = "window-restore-failed";
        candidateWindow = existing.window;
        candidateRecord = existing;
        if (existing.window.isMinimized()) existing.window.restore();
        existing.window.show();
        existing.window.focus();
        return { ok: true };
      }
      if (existing) retireConsoleWindow(existing, "window-closed");

      failureKind = "window-create-failed";
      const window = new BrowserWindow(consoleWindowOptions(
        preloadPath,
        process.platform,
        runtimeIconPath,
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
    const template = buildApplicationMenuTemplate(process.platform, APPLICATION_DISPLAY_NAME, {
      newWindow: () => createWindow(),
      duplicateConnectedWindow: () => createWindow(BrowserWindow.getFocusedWindow()?.webContents.id),
      openCloudDeployment: () => void openCloudDeploymentWindow(),
      openDocumentation: () => void shell.openExternal("https://sliver.sh/docs"),
      showAboutPanel: () => app.showAboutPanel(),
      downloadRelease: (target) => startReleaseDownload(target),
      checkForApplicationUpdates: () => void applicationUpdater?.checkForUpdates(),
      restartToApplyApplicationUpdate: () => {
        void confirmApplicationUpdateRestart();
      },
    }, releaseCatalog, applicationUpdateState, focusedConsole
      ? {
          newTab: () => sendConsoleMenuEvent(focusedConsole, IPC.consoleNewTabRequested),
          closeTab: () => sendConsoleMenuEvent(focusedConsole, IPC.consoleCloseTabRequested),
          selectTab: (index) => sendConsoleTabSelectionEvent(focusedConsole, index),
          closeWindow: () => {
            if (focusedConsoleWindow() === focusedConsole && !focusedConsole.window.isDestroyed()) {
              focusedConsole.window.close();
            }
          },
          showSettings: () => sendConsoleMenuEvent(focusedConsole, IPC.consoleSettingsRequested),
        }
      : undefined);
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
    if (!shutdown.isStopping) {
      disposeCloudDeployment();
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
    const result = await applicationSettingsStore.update(input);
    if (!result.ok || !result.value) return result;
    nativeTheme.themeSource = result.value.theme;
    applyNativeWindowTheme();
    publishApplicationSettingsState(result.value);
    return result;
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
    if (result.response === 1) applicationUpdater?.restartToApply();
  }

  function startReleaseDownload(target: SliverReleaseTarget): void {
    const window = BrowserWindow.getFocusedWindow();
    if (!window || window.isDestroyed() || !releaseDownloader) return;
    void releaseDownloader.download(target, (event) => sendReleaseDownloadEvent(window, event));
  }

  function sendReleaseDownloadEvent(window: BrowserWindow, event: SliverReleaseDownloadEvent): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(IPC.releaseDownloadChanged, event);
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

  function installContextMenu(window: BrowserWindow): void {
    window.webContents.on("context-menu", (_event, params) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return;
      const template = buildContextMenuTemplate(params, {
        copyImageAt: (x, y) => window.webContents.copyImageAt(x, y),
        copyText: (text) => clipboard.writeText(text),
        inspectElement: (x, y) => window.webContents.inspectElement(x, y),
        openExternal: (url) => void shell.openExternal(url),
        replaceMisspelling: (text) => window.webContents.replaceMisspelling(text),
      });
      Menu.buildFromTemplate(template).popup({ window });
    });
  }

  const onActivate = (): void => {
    if (windows.size === 0) createWindow();
  };
  const onWindowAllClosed = (): void => {
    if (process.platform !== "darwin") app.quit();
  };
  let quitCleanupComplete = false;
  let quitCleanupBarrier: Promise<void> | undefined;
  const onBeforeQuit = (event: Electron.Event): void => {
    beginShutdown();
    if (quitCleanupComplete) return;
    event.preventDefault();
    quitCleanupBarrier ??= Promise.allSettled([...pendingWindowCleanup])
      .then(() => {
        quitCleanupComplete = true;
        app.quit();
      });
  };
  const onBeforeQuitForUpdate = (): void => beginShutdown();
  const onNativeThemeUpdated = (): void => applyNativeWindowTheme();

  await app.whenReady();
  const loadedApplicationSettingsStore = await ApplicationSettingsStore.load(
    join(app.getPath("userData"), APPLICATION_SETTINGS_FILE_NAME),
  );
  applicationSettingsStore = loadedApplicationSettingsStore;
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
  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    app.dock.setIcon(developmentDockIconPath);
  }
  releaseDownloader = new SliverReleaseDownloader({
    downloadsDirectory: resolveDownloadsDirectory((name) => app.getPath(name)),
    fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
  });
  if (!cloudDeploymentController) {
    try {
      cloudDeploymentController = await CloudDeploymentService.create({
        rootDirectory: join(consoleClientRootDirectory, "gui", "cloud-deployment", "v1"),
        operatorConfigDirectory: join(consoleClientRootDirectory, "configs"),
        safeStorage,
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
  unsubscribeCloudDeployment = cloudDeploymentController.subscribe?.(publishCloudDeploymentChanged);
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
  configureSessionSecurity(session.defaultSession, developmentRendererUrl, rendererUrl);
  configureSessionSecurity(
    session.fromPartition(CLOUD_DEPLOYMENT_SESSION_PARTITION),
    developmentRendererUrl,
  );
  registerIpcHandlers(
    registry,
    (inheritFromContentsId) => createWindow(inheritFromContentsId),
    rendererUrl,
    {
      open: openSessionShellWindow,
      claim: claimSessionShellWindow,
    },
    () => {
      beginShutdown();
      app.quit();
    },
    {
      open: openInteractionWindow,
      claim: claimInteractionWindow,
      selectTarget: selectInteractionWindowTarget,
    },
    applicationUpdater,
    {
      open: openConsoleWindow,
      claim: claimConsoleWindow,
      createTab: createConsoleTab,
      closeTab: closeConsoleTab,
      attach: attachConsoleWindow,
    },
    {
      getState: () => loadedApplicationSettingsStore.getState(),
      update: updateApplicationSettings,
    },
    {
      open: openCloudDeploymentWindowFromRenderer,
    },
  );
  registerCloudDeploymentIpcHandlers(
    cloudDeploymentController,
    cloudDeploymentRendererUrl,
    (identity, window) =>
      cloudDeploymentWindow === window &&
      nativeWindowSurfaces.get(window) === "cloud-deployment" &&
      sameWindowIdentity(identity, identityForWindow(window)),
  );
  installMenu();
  void refreshReleaseMenu();
  app.on("activate", onActivate);
  app.on("window-all-closed", onWindowAllClosed);
  app.on("before-quit", onBeforeQuit);
  nativeAutoUpdater.on("before-quit-for-update", onBeforeQuitForUpdate);
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
      nativeAutoUpdater.removeListener("before-quit-for-update", onBeforeQuitForUpdate);
      nativeTheme.removeListener("updated", onNativeThemeUpdated);
      unregisterCloudDeploymentIpcHandlers();
      unregisterIpcHandlers();
      for (const window of [...windows]) {
        await registry.closeWindowStreams(window.webContents.id, "application-shutdown").catch(() => undefined);
        window.close();
      }
      await Promise.allSettled([...pendingWindowCleanup]);
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

export function readDevelopmentRendererUrl(): string | undefined {
  const value = process.env.ELECTRON_RENDERER_URL?.trim();
  if (!value) return undefined;

  const url = new URL(value);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !loopbackHosts.has(url.hostname) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("ELECTRON_RENDERER_URL must be an HTTP(S) loopback URL");
  }
  return url.href;
}

function rendererUrlForSurface(
  rendererUrl: string,
  surface: "cloud-deployment" | "console" | "interaction" | "managed-shells",
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
    getProvisioningTranscripts: () => ({ ok: false, error: message }),
    getTerminalRuntime: () => ({ ok: false, error: message }),
    detectCurrentEgressIpv4: () => ({ ok: false, error: message }),
    chooseSshPrivateKey: () => ({ ok: false, error: message }),
    createCredential: () => ({ ok: false, error: message }),
    deleteCredential: () => ({ ok: false, error: message }),
    testCredential: () => ({ ok: false, error: message }),
    discoverAwsOptions: () => ({ ok: false, error: message }),
    createDeployment: () => ({ ok: false, error: message }),
    runLifecycleAction: () => ({ ok: false, error: message }),
    updateFirewall: () => ({ ok: false, error: message }),
    listFirewallRules: () => ({ ok: false, error: message }),
    createFirewallRule: () => ({ ok: false, error: message }),
    updateFirewallRule: () => ({ ok: false, error: message }),
    deleteFirewallRule: () => ({ ok: false, error: message }),
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
