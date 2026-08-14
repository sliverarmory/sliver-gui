import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, clipboard, dialog, Menu, net, session, shell } from "electron";

import {
  IPC,
  type OpenSessionShellWindowInput,
  type OperationResult,
  type WindowLaunchContext,
} from "../shared/contracts.js";
import type { TargetRef } from "../shared/target-contracts.js";
import type {
  SliverReleaseDownloadEvent,
  SliverReleaseTarget,
} from "../shared/release-contracts.js";
import {
  buildApplicationMenuTemplate,
  buildContextMenuTemplate,
  type ReleaseMenuCatalog,
} from "./application-menus.js";
import { ConnectionRegistry } from "./connection-registry.js";
import { resolveDownloadsDirectory } from "./download-directory.js";
import {
  registerIpcHandlers,
  unregisterIpcHandlers,
  type TrustedWindowIdentity,
} from "./ipc.js";
import { configureSessionSecurity, hardenWindow } from "./security.js";
import { SliverReleaseDownloader } from "./sliver-release-download.js";
import { mainWindowOptions, sessionShellWindowOptions } from "./window-options.js";

const APPLICATION_DISPLAY_NAME = "Sliver Desktop";

export interface StartApplicationOptions {
  registry?: ConnectionRegistry;
  rendererEntryPath?: string;
  preloadPath?: string;
  developmentRendererUrl?: string;
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

/**
 * Compose the trusted Electron main process. Tests may inject an in-memory
 * backend by importing this module from a test-only main entry; the production
 * entrypoint always uses the real ConnectionRegistry defaults.
 */
export async function startApplication(options: StartApplicationOptions = {}): Promise<ApplicationHandle> {
  const registry = options.registry ?? new ConnectionRegistry();
  const mainBundleDirectory = import.meta.dirname;
  const runtimeIconPath = app.isPackaged
    ? join(process.resourcesPath, "sliver-desktop.png")
    : join(mainBundleDirectory, "../../build/about-icon.png");
  const developmentDockIconPath = join(mainBundleDirectory, "../../build/icon.png");
  const rendererEntryPath = options.rendererEntryPath ?? join(mainBundleDirectory, "../renderer/index.html");
  const preloadPath = options.preloadPath ?? join(mainBundleDirectory, "../preload/index.cjs");
  // Packaged applications always trust their immutable file entry. A caller's
  // inherited environment must never redirect production IPC trust to even a
  // loopback web origin.
  const developmentRendererUrl = app.isPackaged
    ? undefined
    : options.developmentRendererUrl ?? readDevelopmentRendererUrl();
  const rendererUrl = developmentRendererUrl ?? pathToFileURL(rendererEntryPath).href;
  const windows = new Set<BrowserWindow>();
  const windowsByContentsId = new Map<number, BrowserWindow>();
  const sessionShellWindowsByKey = new Map<string, SessionShellWindowRecord>();
  const sessionShellWindowsByContentsId = new Map<number, SessionShellWindowRecord>();
  const pendingWindowCleanup = new Set<Promise<void>>();
  let releaseCatalog: ReleaseMenuCatalog = { status: "loading" };
  let releaseDownloader: SliverReleaseDownloader | undefined;
  let stopping = false;

  function loadRenderer(window: BrowserWindow, surface?: "managed-shells"): void {
    if (developmentRendererUrl) {
      const url = new URL(developmentRendererUrl);
      if (surface) url.searchParams.set("surface", surface);
      void window.loadURL(url.href);
      return;
    }
    if (surface) void window.loadFile(rendererEntryPath, { query: { surface } });
    else void window.loadFile(rendererEntryPath);
  }

  function trackWindow(
    window: BrowserWindow,
    inheritFromContentsId?: number,
    sessionShellRecord?: SessionShellWindowRecord,
  ): void {
    const contentsId = window.webContents.id;
    windows.add(window);
    windowsByContentsId.set(contentsId, window);
    registry.registerWindow(contentsId);
    if (inheritFromContentsId !== undefined) registry.inheritConnection(inheritFromContentsId, contentsId);

    hardenWindow(window, rendererUrl);
    installContextMenu(window);
    window.once("ready-to-show", () => window.show());
    let completedInitialLoad = false;
    window.webContents.once("did-finish-load", () => {
      completedInitialLoad = true;
    });
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        void registry.closeWindowStreams(contentsId, "navigation").catch(() => undefined);
        if (sessionShellRecord && completedInitialLoad) retireSessionShellWindow(sessionShellRecord);
      }
    });
    window.webContents.on("render-process-gone", () => {
      void registry.closeWindowStreams(contentsId, "renderer-gone").catch(() => undefined);
      if (sessionShellRecord) retireSessionShellWindow(sessionShellRecord);
    });
    window.webContents.on("did-fail-load", (_event, _errorCode, _errorDescription, _url, isMainFrame) => {
      if (sessionShellRecord && isMainFrame) retireSessionShellWindow(sessionShellRecord);
    });
    window.webContents.on("destroyed", () => {
      void registry.closeWindowStreams(contentsId, "renderer-gone").catch(() => undefined);
    });
    if (sessionShellRecord) {
      window.on("close", (event) => {
        if (
          stopping ||
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
      windowsByContentsId.delete(contentsId);
      if (sessionShellRecord) {
        sessionShellWindowsByContentsId.delete(contentsId);
        if (sessionShellWindowsByKey.get(sessionShellRecord.key) === sessionShellRecord) {
          sessionShellWindowsByKey.delete(sessionShellRecord.key);
        }
      }
      const cleanup = registry.unregisterWindow(contentsId).catch(() => undefined);
      pendingWindowCleanup.add(cleanup);
      void cleanup.finally(() => pendingWindowCleanup.delete(cleanup));
    });
  }

  function createWindow(inheritFromContentsId?: number): BrowserWindow {
    const window = new BrowserWindow(mainWindowOptions(preloadPath, process.platform, runtimeIconPath));
    trackWindow(window, inheritFromContentsId);
    loadRenderer(window);
    return window;
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

      const window = new BrowserWindow(sessionShellWindowOptions(preloadPath, process.platform, runtimeIconPath));
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
      loadRenderer(window, "managed-shells");
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

  function installMenu(): void {
    const template = buildApplicationMenuTemplate(process.platform, APPLICATION_DISPLAY_NAME, {
      newWindow: () => createWindow(),
      duplicateConnectedWindow: () => createWindow(BrowserWindow.getFocusedWindow()?.webContents.id),
      openDocumentation: () => void shell.openExternal("https://sliver.sh/docs"),
      showAboutPanel: () => app.showAboutPanel(),
      downloadRelease: (target) => startReleaseDownload(target),
    }, releaseCatalog);
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
      if (!catalog || stopping) return;
      releaseCatalog = {
        status: "ready",
        version: catalog.version,
        targets: catalog.assets.map(({ artifact, os, arch }) => ({ artifact, os, arch })),
      };
    } catch {
      if (stopping) return;
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

  await app.whenReady();
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
  configureSessionSecurity(session.defaultSession, developmentRendererUrl, rendererUrl);
  registerIpcHandlers(
    registry,
    (inheritFromContentsId) => createWindow(inheritFromContentsId),
    rendererUrl,
    {
      open: openSessionShellWindow,
      claim: claimSessionShellWindow,
    },
    () => {
      stopping = true;
      releaseDownloader?.stop();
      app.quit();
    },
  );
  installMenu();
  void refreshReleaseMenu();
  app.on("activate", onActivate);
  app.on("window-all-closed", onWindowAllClosed);
  createWindow();

  return {
    createWindow,
    async stop(): Promise<void> {
      stopping = true;
      releaseDownloader?.stop();
      app.removeListener("activate", onActivate);
      app.removeListener("window-all-closed", onWindowAllClosed);
      unregisterIpcHandlers();
      for (const window of [...windows]) {
        await registry.closeWindowStreams(window.webContents.id, "application-shutdown").catch(() => undefined);
        window.close();
      }
      await Promise.allSettled([...pendingWindowCleanup]);
    },
  };
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

function applicationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (
    error.message === "The source window changed before managed shells could be popped out" ||
    error.message === "Select an active session before popping out managed shells"
  ) return error.message;
  return fallback;
}
