import { readFileSync } from "node:fs";
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
  session,
  shell,
} from "electron";

import {
  IPC,
  type OpenSessionShellWindowInput,
  type OperationResult,
  type SliverSnapshot,
  type WindowLaunchContext,
} from "../shared/contracts.js";
import type { ApplicationUpdateState } from "../shared/application-update-contracts.js";
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
import {
  createApplicationUpdater,
  type ApplicationUpdater,
} from "./application-updater.js";
import { ApplicationShutdownCoordinator } from "./application-shutdown.js";
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
  interactionWindowOptions,
  mainWindowOptions,
  sessionShellWindowOptions,
} from "./window-options.js";

const APPLICATION_DISPLAY_NAME = "Sliver Desktop";

export interface StartApplicationOptions {
  registry?: ConnectionRegistry;
  rendererEntryPath?: string;
  preloadPath?: string;
  developmentRendererUrl?: string;
  applicationAssetsDirectory?: string;
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
  const interactionWindowsByContentsId = new Map<number, InteractionWindowRecord>();
  const pendingWindowCleanup = new Set<Promise<void>>();
  let releaseCatalog: ReleaseMenuCatalog = { status: "loading" };
  let releaseDownloader: SliverReleaseDownloader | undefined;
  let applicationUpdater: ApplicationUpdater | undefined;
  let applicationUpdateState: ApplicationUpdateState | undefined;
  const shutdown = new ApplicationShutdownCoordinator({
    stopReleaseDownloads: () => releaseDownloader?.stop(),
    disposeApplicationUpdater: () => applicationUpdater?.dispose(),
  });

  async function loadRenderer(
    window: BrowserWindow,
    surface?: "interaction" | "managed-shells",
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
        if (interactionWindowRecord && completedInitialLoad) resetInteractionWindowClaim(interactionWindowRecord);
      }
    });
    window.webContents.on("render-process-gone", () => {
      void registry.closeWindowStreams(contentsId, "renderer-gone").catch(() => undefined);
      if (sessionShellRecord) retireSessionShellWindow(sessionShellRecord);
      if (interactionWindowRecord) resetInteractionWindowClaim(interactionWindowRecord);
    });
    window.webContents.on("did-fail-load", (_event, _errorCode, _errorDescription, _url, isMainFrame) => {
      if (sessionShellRecord && isMainFrame) retireSessionShellWindow(sessionShellRecord);
      if (interactionWindowRecord && isMainFrame) resetInteractionWindowClaim(interactionWindowRecord);
    });
    window.webContents.on("destroyed", () => {
      void registry.closeWindowStreams(contentsId, "renderer-gone").catch(() => undefined);
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
      const cleanup = registry.unregisterWindow(contentsId).catch(() => undefined);
      pendingWindowCleanup.add(cleanup);
      void cleanup.finally(() => pendingWindowCleanup.delete(cleanup));
    });
  }

  function createWindow(inheritFromContentsId?: number): BrowserWindow {
    const window = new BrowserWindow(mainWindowOptions(preloadPath, process.platform, runtimeIconPath));
    trackWindow(window, inheritFromContentsId);
    void loadRenderer(window);
    return window;
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

      window = new BrowserWindow(interactionWindowOptions(preloadPath, process.platform, runtimeIconPath));
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

  function installMenu(): void {
    const template = buildApplicationMenuTemplate(process.platform, APPLICATION_DISPLAY_NAME, {
      newWindow: () => createWindow(),
      duplicateConnectedWindow: () => createWindow(BrowserWindow.getFocusedWindow()?.webContents.id),
      openDocumentation: () => void shell.openExternal("https://sliver.sh/docs"),
      showAboutPanel: () => app.showAboutPanel(),
      downloadRelease: (target) => startReleaseDownload(target),
      checkForApplicationUpdates: () => void applicationUpdater?.checkForUpdates(),
      restartToApplyApplicationUpdate: () => {
        void confirmApplicationUpdateRestart();
      },
    }, releaseCatalog, applicationUpdateState);
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  function beginShutdown(): void {
    shutdown.beginQuit();
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
  const onBeforeQuit = (): void => beginShutdown();
  const onBeforeQuitForUpdate = (): void => beginShutdown();

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

function applicationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (
    error.message === "The source window changed before managed shells could be popped out" ||
    error.message === "Select an active session before popping out managed shells"
  ) return error.message;
  return fallback;
}
