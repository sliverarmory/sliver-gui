import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
import type { BeagleService } from "./beagle-service.js";
import type { TrustedWindowIdentity } from "./ipc.js";
import { isSameRendererDocument } from "./security.js";

export interface BeagleIpcServices {
  readonly manager: Pick<BeagleService, "getState" | "createProject" | "selectProject" | "configureBinary" |
    "importFiles" | "analyze" | "query" | "getQueries" | "runSavedQuery" | "search" | "entity" |
    "neighborhood" | "paths" | "tag" | "compose" | "exportGraph">;
  readonly getApplicationSettings: () => ApplicationSettingsState;
}

export function registerBeagleIpcHandlers(
  services: BeagleIpcServices,
  rendererUrl: string,
  authorizeWindow: (identity: TrustedWindowIdentity, window: BrowserWindow) => boolean,
): void {
  // Includes the lifetime of native file dialogs so a queued project switch
  // cannot redirect an import or export to a different project.
  let operationPending = false;
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
    action: (input: T, window: BrowserWindow, event: IpcMainInvokeEvent) => unknown, exclusive = true): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      let ownsOperation = false;
      try {
        const window = trustedWindow(event);
        const input = parse(args);
        if (exclusive) {
          if (operationPending) throw new Error("Another AD Explorer operation is in progress");
          ownsOperation = operationPending = true;
        }
        const value = await action(input, window, event);
        trustedWindow(event);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "The AD Explorer request failed" };
      } finally {
        if (ownsOperation) operationPending = false;
      }
    });
  }
  const manager = services.manager;
  handle(BEAGLE_IPC_INVOKE.getState, none, () => manager.getState(), false);
  handle(BEAGLE_IPC_INVOKE.getQueries, none, () => manager.getQueries(), false);
  handle(BEAGLE_IPC_INVOKE.createProject, one(parseBeagleCreateProjectInput), (input) => manager.createProject(input));
  handle(BEAGLE_IPC_INVOKE.selectProject, one(parseBeagleSelectProjectInput), (input) => manager.selectProject(input));
  handle(BEAGLE_IPC_INVOKE.query, one(parseBeagleQueryInput), (input) => manager.query(input), false);
  handle(BEAGLE_IPC_INVOKE.runSavedQuery, one(parseBeagleSavedQueryInput), (input) => manager.runSavedQuery(input), false);
  handle(BEAGLE_IPC_INVOKE.search, one(parseBeagleSearchInput), (input) => manager.search(input), false);
  handle(BEAGLE_IPC_INVOKE.entity, one(parseBeagleEntityInput), (input) => manager.entity(input), false);
  handle(BEAGLE_IPC_INVOKE.neighborhood, one(parseBeagleNeighborhoodInput), (input) => manager.neighborhood(input), false);
  handle(BEAGLE_IPC_INVOKE.paths, one(parseBeaglePathsInput), (input) => manager.paths(input), false);
  handle(BEAGLE_IPC_INVOKE.tag, one(parseBeagleTagInput), (input) => manager.tag(input));
  handle(BEAGLE_IPC_INVOKE.compose, one(parseBeagleComposeInput), (input) => manager.compose(input), false);
  handle(BEAGLE_IPC_INVOKE.analyze, none, () => manager.analyze());
  handle(BEAGLE_IPC_INVOKE.chooseBinary, none, async (_input, window, event) => {
    const selection = await dialog.showOpenDialog(window, { title: "Choose Beagle Executable", properties: ["openFile"] });
    trustedWindow(event);
    if (selection.canceled) return manager.getState();
    if (selection.filePaths.length !== 1) throw new Error("Choose one Beagle executable");
    return manager.configureBinary(selection.filePaths[0]!);
  });
  handle(BEAGLE_IPC_INVOKE.importFiles, none, async (_input, window, event) => {
    const selection = await dialog.showOpenDialog(window, {
      title: "Import SharpHound Collection", properties: ["openFile", "multiSelections"],
      filters: [{ name: "SharpHound Collection", extensions: ["zip", "json"] }],
    });
    trustedWindow(event);
    if (selection.canceled) return { state: await manager.getState(), report: null };
    return manager.importFiles(selection.filePaths);
  });
  handle(BEAGLE_IPC_INVOKE.exportGraph, none, async (_input, window, event) => {
    const selection = await dialog.showSaveDialog(window, {
      title: "Export AD Graph", defaultPath: "ad-graph.json", filters: [{ name: "Graph JSON", extensions: ["json"] }],
    });
    trustedWindow(event);
    if (selection.canceled || !selection.filePath) return { cancelled: true };
    const graph = await manager.exportGraph();
    trustedWindow(event);
    const temporaryPath = join(dirname(selection.filePath), `.${basename(selection.filePath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, JSON.stringify(graph), { mode: 0o600, flag: "wx" });
      trustedWindow(event);
      await rename(temporaryPath, selection.filePath);
    } finally { await unlink(temporaryPath).catch(() => undefined); }
    return { cancelled: false };
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
