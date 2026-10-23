import { randomUUID } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";

import { DEFAULT_APPLICATION_SETTINGS_STATE, type ApplicationSettingsState } from "../shared/application-settings-contracts.js";
import {
  BEAGLE_IPC_INVOKE,
  parseBeagleCreateProjectInput,
  parseBeagleSelectProjectInput,
  parseBeagleQueryInput,
  parseBeagleSavedQueryInput,
  parseBeagleSearchInput,
  parseBeagleEntityInput,
  parseBeagleNeighborhoodInput,
  parseBeaglePathsInput,
  parseBeagleTagInput,
  parseBeagleComposeInput,
} from "../shared/beagle-contracts.js";
import { parseBeagleCleanupInput, parseBeagleImportInput, parseBeagleProjectIdInput, parseBeagleRenameProjectInput, parseBeagleRetentionInput } from "../shared/beagle-projects.js";
import { parseBeagleRulesInput } from "../shared/beagle-rules.js";
import { parseBeagleCancelOperationInput, parseBeagleExportQueriesInput, parseBeagleExportResultInput, parseBeagleSaveWorkspaceInput } from "../shared/beagle-workspace-inputs.js";
import type { BeagleService } from "./beagle-service.js";
import type { TrustedWindowIdentity } from "./ipc.js";
import { isSameRendererDocument } from "./security.js";

export type BeagleIpcManager = Pick<BeagleService, "getState" | "createProject" | "selectProject" | "configureBinary" |
    "importFiles" | "analyze" | "query" | "getQueries" | "runSavedQuery" | "search" | "entity" |
    "neighborhood" | "paths" | "tag" | "compose" | "exportGraphToFile" | "renameProject" | "archiveProject" |
    "restoreArchivedProject" | "cleanup" | "setRetention" | "backupProject" | "restoreProject" | "getWorkspace" |
    "saveWorkspace" | "importQueries" | "exportQueries" | "exportResult" | "relayTargets" | "aclOrigins" |
    "getRules" | "previewRules" | "applyRules" | "getOperation" | "cancelOperation">;
export interface BeagleIpcServices {
  readonly getManager: (window: BrowserWindow) => BeagleIpcManager | undefined;
  readonly getApplicationSettings: () => ApplicationSettingsState;
}

export function registerBeagleIpcHandlers(
  services: BeagleIpcServices,
  rendererUrl: string,
  authorizeWindow: (identity: TrustedWindowIdentity, window: BrowserWindow) => boolean,
): void {
  // Includes the lifetime of native file dialogs so a queued project switch
  // cannot redirect an import or export to a different project.
  const pendingWindows = new WeakSet<BrowserWindow>();
  function trustedWindow(event: IpcMainInvokeEvent): BrowserWindow {
    const { sender, senderFrame } = event;
    const window = BrowserWindow.fromWebContents(sender);
    if (!window || window.isDestroyed() || sender.isDestroyed() || !senderFrame || senderFrame.isDestroyed() ||
      senderFrame.processId !== sender.mainFrame.processId || senderFrame.frameToken !== sender.mainFrame.frameToken ||
      !isSameRendererDocument(sender.getURL(), rendererUrl) || !isSameRendererDocument(senderFrame.url, rendererUrl) ||
      !authorizeWindow({ contentsId: sender.id, rendererProcessId: senderFrame.processId, rendererFrameToken: senderFrame.frameToken }, window)) {
      throw new Error("Untrusted AD Explorer renderer");
    }
    return window;
  }
  function handle<T>(channel: string, parse: (args: unknown[]) => T,
    action: (input: T, window: BrowserWindow, event: IpcMainInvokeEvent, manager: BeagleIpcManager) => unknown, exclusive = true): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      let operationWindow: BrowserWindow | undefined;
      try {
        const window = trustedWindow(event);
        const manager = services.getManager(window);
        if (!manager) throw new Error("AD Explorer workspace is unavailable");
        const input = parse(args);
        if (exclusive) {
          if (pendingWindows.has(window)) throw new Error("Another AD Explorer operation is in progress");
          pendingWindows.add(window);
          operationWindow = window;
        }
        const value = await action(input, window, event, manager);
        trustedWindow(event);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "The AD Explorer request failed" };
      } finally {
        if (operationWindow) pendingWindows.delete(operationWindow);
      }
    });
  }
  async function publishFile(path: string, event: IpcMainInvokeEvent, write: (temporaryPath: string) => Promise<unknown>): Promise<{ cancelled: false }> {
    // Keep the extension for the selected JSON/ZIP encoder. The service opens
    // this unpredictable sibling with wx and private permissions.
    const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp${extname(path)}`);
    try {
      await write(temporaryPath);
      trustedWindow(event);
      await rename(temporaryPath, path);
    } finally { await unlink(temporaryPath).catch(() => undefined); }
    return { cancelled: false };
  }
  handle(BEAGLE_IPC_INVOKE.getState, none, (_input, _window, _event, manager) => manager.getState(), false);
  handle(BEAGLE_IPC_INVOKE.getQueries, none, (_input, _window, _event, manager) => manager.getQueries(), false);
  handle(BEAGLE_IPC_INVOKE.createProject, one(parseBeagleCreateProjectInput), (input, _window, _event, manager) => manager.createProject(input));
  handle(BEAGLE_IPC_INVOKE.selectProject, one(parseBeagleSelectProjectInput), (input, _window, _event, manager) => manager.selectProject(input));
  handle(BEAGLE_IPC_INVOKE.renameProject, one(parseBeagleRenameProjectInput), (input, _window, _event, manager) => manager.renameProject(input));
  handle(BEAGLE_IPC_INVOKE.archiveProject, one(parseBeagleProjectIdInput), (input, _window, _event, manager) => manager.archiveProject(input));
  handle(BEAGLE_IPC_INVOKE.restoreArchivedProject, one(parseBeagleProjectIdInput), (input, _window, _event, manager) => manager.restoreArchivedProject(input));
  handle(BEAGLE_IPC_INVOKE.cleanup, one(parseBeagleCleanupInput), (input, _window, _event, manager) => manager.cleanup(input));
  handle(BEAGLE_IPC_INVOKE.setRetention, one(parseBeagleRetentionInput), (input, _window, _event, manager) => manager.setRetention(input));
  handle(BEAGLE_IPC_INVOKE.getWorkspace, none, (_input, _window, _event, manager) => manager.getWorkspace(), false);
  // Autosaves can overlap each other and foreground operations. The service
  // queues them in order and checks the project again before its atomic write.
  handle(BEAGLE_IPC_INVOKE.saveWorkspace, one(parseBeagleSaveWorkspaceInput), (input, _window, _event, manager) => manager.saveWorkspace(input), false);
  handle(BEAGLE_IPC_INVOKE.getOperation, none, (_input, _window, _event, manager) => manager.getOperation(), false);
  handle(BEAGLE_IPC_INVOKE.cancelOperation, one(parseBeagleCancelOperationInput), (input, _window, _event, manager) => manager.cancelOperation(input), false);
  handle(BEAGLE_IPC_INVOKE.query, one(parseBeagleQueryInput), (input, _window, _event, manager) => manager.query(input), false);
  handle(BEAGLE_IPC_INVOKE.runSavedQuery, one(parseBeagleSavedQueryInput), (input, _window, _event, manager) => manager.runSavedQuery(input), false);
  handle(BEAGLE_IPC_INVOKE.search, one(parseBeagleSearchInput), (input, _window, _event, manager) => manager.search(input), false);
  handle(BEAGLE_IPC_INVOKE.entity, one(parseBeagleEntityInput), (input, _window, _event, manager) => manager.entity(input), false);
  handle(BEAGLE_IPC_INVOKE.neighborhood, one(parseBeagleNeighborhoodInput), (input, _window, _event, manager) => manager.neighborhood(input), false);
  handle(BEAGLE_IPC_INVOKE.paths, one(parseBeaglePathsInput), (input, _window, _event, manager) => manager.paths(input), false);
  handle(BEAGLE_IPC_INVOKE.tag, one(parseBeagleTagInput), (input, _window, _event, manager) => manager.tag(input));
  handle(BEAGLE_IPC_INVOKE.compose, one(parseBeagleComposeInput), (input, _window, _event, manager) => manager.compose(input), false);
  handle(BEAGLE_IPC_INVOKE.relayTargets, one(parseBeagleComposeInput), (input, _window, _event, manager) => manager.relayTargets(input), false);
  handle(BEAGLE_IPC_INVOKE.aclOrigins, one(parseBeagleComposeInput), (input, _window, _event, manager) => manager.aclOrigins(input), false);
  handle(BEAGLE_IPC_INVOKE.getRules, none, (_input, _window, _event, manager) => manager.getRules(), false);
  handle(BEAGLE_IPC_INVOKE.previewRules, one(parseBeagleRulesInput), (input, _window, _event, manager) => manager.previewRules(input), false);
  handle(BEAGLE_IPC_INVOKE.applyRules, one(parseBeagleRulesInput), (input, _window, _event, manager) => manager.applyRules(input));
  handle(BEAGLE_IPC_INVOKE.analyze, none, (_input, _window, _event, manager) => manager.analyze());
  handle(BEAGLE_IPC_INVOKE.chooseBinary, none, async (_input, window, event, manager) => {
    const selection = await dialog.showOpenDialog(window, { title: "Choose Beagle Executable", properties: ["openFile"] });
    trustedWindow(event);
    if (selection.canceled) return manager.getState();
    if (selection.filePaths.length !== 1) throw new Error("Choose one Beagle executable");
    return manager.configureBinary(selection.filePaths[0]!);
  });
  handle(BEAGLE_IPC_INVOKE.importFiles, optional(parseBeagleImportInput), async (input, window, event, manager) => {
    const selection = await dialog.showOpenDialog(window, {
      title: "Import SharpHound Collection", properties: ["openFile", "multiSelections"],
      filters: [{ name: "SharpHound Collection", extensions: ["zip", "json"] }],
    });
    trustedWindow(event);
    if (selection.canceled) return { state: await manager.getState(), report: null };
    return input ? manager.importFiles(selection.filePaths, input) : manager.importFiles(selection.filePaths);
  });
  handle(BEAGLE_IPC_INVOKE.exportGraph, none, async (_input, window, event, manager) => {
    const selection = await dialog.showSaveDialog(window, {
      title: "Export AD Graph", defaultPath: "ad-graph.json", filters: [{ name: "Graph JSON", extensions: ["json"] }],
    });
    trustedWindow(event);
    if (selection.canceled || !selection.filePath) return { cancelled: true };
    return publishFile(selection.filePath, event, (path) => manager.exportGraphToFile(path));
  });
  handle(BEAGLE_IPC_INVOKE.backupProject, none, async (_input, window, event, manager) => {
    const selection = await dialog.showSaveDialog(window, { title: "Back Up AD Project", defaultPath: "ad-project.beagle", filters: [{ name: "Beagle Project Backup", extensions: ["beagle"] }] });
    trustedWindow(event);
    if (selection.canceled || !selection.filePath) return { cancelled: true };
    return publishFile(selection.filePath, event, (path) => manager.backupProject(path));
  });
  handle(BEAGLE_IPC_INVOKE.restoreProject, none, async (_input, window, event, manager) => {
    const selection = await dialog.showOpenDialog(window, { title: "Restore AD Project Backup", properties: ["openFile"], filters: [{ name: "Beagle Project Backup", extensions: ["beagle"] }] });
    trustedWindow(event);
    if (selection.canceled) return manager.getState();
    if (selection.filePaths.length !== 1) throw new Error("Choose one project backup");
    return manager.restoreProject(selection.filePaths[0]!);
  });
  handle(BEAGLE_IPC_INVOKE.importQueries, none, async (_input, window, event, manager) => {
    const selection = await dialog.showOpenDialog(window, { title: "Import Saved Queries", properties: ["openFile"], filters: [{ name: "Query Library", extensions: ["json", "zip"] }] });
    trustedWindow(event);
    if (selection.canceled) return { cancelled: true, queries: [] };
    if (selection.filePaths.length !== 1) throw new Error("Choose one query library");
    return { cancelled: false, queries: await manager.importQueries(selection.filePaths[0]!) };
  });
  handle(BEAGLE_IPC_INVOKE.exportQueries, one(parseBeagleExportQueriesInput), async (input, window, event, manager) => {
    const selection = await dialog.showSaveDialog(window, { title: "Export Saved Queries", defaultPath: "ad-queries.json", filters: [{ name: "Query Library JSON", extensions: ["json"] }, { name: "Query Library ZIP", extensions: ["zip"] }] });
    trustedWindow(event);
    if (selection.canceled || !selection.filePath) return { cancelled: true };
    return publishFile(selection.filePath, event, (path) => manager.exportQueries(path, input));
  });
  handle(BEAGLE_IPC_INVOKE.exportResult, one(parseBeagleExportResultInput), async (input, window, event, manager) => {
    const selection = await dialog.showSaveDialog(window, { title: "Export Current Result", defaultPath: `ad-result.${input.format}`, filters: [{ name: input.format === "csv" ? "Result Table CSV" : "Result JSON", extensions: [input.format] }] });
    trustedWindow(event);
    if (selection.canceled || !selection.filePath) return { cancelled: true };
    return publishFile(selection.filePath, event, (path) => manager.exportResult(path, input));
  });
  ipcMain.handle(BEAGLE_IPC_INVOKE.getApplicationSettings, (event, ...args: unknown[]) => {
    try { trustedWindow(event); none(args); return services.getApplicationSettings(); }
    catch { return DEFAULT_APPLICATION_SETTINGS_STATE; }
  });
}

export function unregisterBeagleIpcHandlers(): void {
  for (const channel of Object.values(BEAGLE_IPC_INVOKE)) ipcMain.removeHandler(channel);
}
function none(args: unknown[]): undefined {
  if (args.length) throw new TypeError("Unexpected AD Explorer arguments");
  return undefined;
}
function one<T>(parse: (value: unknown) => T): (args: unknown[]) => T {
  return (args) => {
    if (args.length !== 1) throw new TypeError("A single AD Explorer argument is required");
    return parse(args[0]);
  };
}
function optional<T>(parse: (value: unknown) => T): (args: unknown[]) => T | undefined {
  return (args) => args.length === 0 ? undefined : one(parse)(args);
}
