import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";

import { IPC, type OperationResult } from "../shared/contracts.js";
import {
  parseAdCollectorRunInput,
  parseAdDomain,
  parseAdTargetRef,
  parseAdExplorerOpenInput,
  RUSTHOUND_ARMORY_COLLECTOR_ID,
  type AdCollectorRunResult,
  type AdCollectionSummary,
  type AdExplorerOpenInput,
} from "../shared/ad-explorer-contracts.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import { BeaglePostCommitError } from "./beagle-service.js";
import type { TrustedWindowIdentity } from "./ipc.js";
import { isSameRendererDocument } from "./security.js";

export interface AdExplorerIpcServices {
  registry: Pick<ConnectionRegistry, "listAdCollectors" | "getAdTargetDomain" | "runAdCollector">;
  listCollections: () => Promise<AdCollectionSummary[]>;
  importCollectedData: (input: { domain: string; path: string }) => Promise<{ projectId?: string }>;
  openBeagleWindow: (input?: AdExplorerOpenInput) => Promise<void>;
  openAdCollectorArmory: () => Promise<void>;
}

export function registerAdExplorerIpcHandlers(
  services: AdExplorerIpcServices,
  rendererUrl: string,
  authorizeWindow: (identity: TrustedWindowIdentity, window: BrowserWindow) => boolean,
): void {
  function trustedWindow(event: IpcMainInvokeEvent): BrowserWindow {
    const { sender, senderFrame } = event;
    const window = BrowserWindow.fromWebContents(sender);
    if (!window || window.isDestroyed() || sender.isDestroyed() || !senderFrame || senderFrame.isDestroyed() ||
        senderFrame.processId !== sender.mainFrame.processId || senderFrame.frameToken !== sender.mainFrame.frameToken ||
        !isSameRendererDocument(sender.getURL(), rendererUrl) || !isSameRendererDocument(senderFrame.url, rendererUrl) ||
        !authorizeWindow({ contentsId: sender.id, rendererProcessId: senderFrame.processId, rendererFrameToken: senderFrame.frameToken }, window)) {
      throw new Error("Untrusted AD Explorer workspace renderer");
    }
    return window;
  }

  ipcMain.handle(IPC.listAdCollections, async (event, ...args: unknown[]): Promise<OperationResult<AdCollectionSummary[]>> => {
    try {
      trustedWindow(event);
      if (args.length !== 0) throw new TypeError("List AD Explorer collections takes no arguments");
      const collections = await services.listCollections();
      trustedWindow(event);
      return { ok: true, value: collections };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "AD Explorer collections unavailable" };
    }
  });

  ipcMain.handle(IPC.listAdCollectors, async (event, ...args: unknown[]) => {
    try {
      trustedWindow(event);
      if (args.length !== 1) throw new TypeError("Choose one AD Explorer target");
      const target = parseAdTargetRef(args[0]);
      const result = await services.registry.listAdCollectors(event.sender.id, target);
      trustedWindow(event);
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "AD collector catalog unavailable" };
    }
  });

  ipcMain.handle(IPC.getAdTargetDomain, async (event, ...args: unknown[]): Promise<OperationResult<{ domain?: string }>> => {
    try {
      trustedWindow(event);
      if (args.length !== 1) throw new TypeError("Choose one AD Explorer target");
      const target = parseAdTargetRef(args[0]);
      const result = await services.registry.getAdTargetDomain(event.sender.id, target);
      trustedWindow(event);
      if (!result.ok) return result;
      return { ok: true, value: result.value.domain ? { domain: parseAdDomain(result.value.domain) } : {} };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "AD target domain unavailable" };
    }
  });

  ipcMain.handle(IPC.runAdCollector, async (event, ...args: unknown[]): Promise<OperationResult<AdCollectorRunResult>> => {
    try {
      const window = trustedWindow(event);
      if (args.length !== 1) throw new TypeError("Choose one AD collector request");
      const input = parseAdCollectorRunInput(args[0]);
      const collectorName = input.collectorId === RUSTHOUND_ARMORY_COLLECTOR_ID ? "RustHound" : "SharpHound";
      let collectorPath: string | undefined;
      if (["sharphound:verified:file", "sharphound:verified:script", "sharphound:custom:file", "sharphound:custom:script"].includes(input.collectorId)) {
        const script = input.collectorId === "sharphound:custom:script" || input.collectorId === "sharphound:verified:script";
        const selection = await dialog.showOpenDialog(window, {
          title: input.collectorId === "sharphound:verified:script" ? "Choose verified SharpHound CE 2.17.1 PowerShell script" :
            script ? "Choose Invoke-BloodHound PowerShell script" :
            input.collectorId === "sharphound:verified:file" ? "Choose verified SharpHound CE 2.17.1 executable" :
              "Choose operator-supplied SharpHound-compatible executable",
          properties: ["openFile"],
          filters: [script
            ? { name: "Invoke-BloodHound script", extensions: ["ps1"] }
            : { name: "SharpHound executable", extensions: ["exe"] }],
        });
        trustedWindow(event);
        if (selection.canceled) return { ok: true, value: {
          state: "cancelled", collectorId: input.collectorId, targetId: input.target.id,
          domain: input.domain, message: "Collector selection was cancelled.",
        } };
        if (selection.filePaths.length !== 1) throw new Error("Choose one collector file");
        collectorPath = selection.filePaths[0]!;
      }
      const collected = await services.registry.runAdCollector(event.sender.id, input, collectorPath);
      if (!collected.ok) return collected;
      trustedWindow(event);
      let imported: { projectId?: string };
      try {
        imported = await services.importCollectedData({ domain: collected.value.domain, path: collected.value.path });
      } catch (error) {
        if (error instanceof BeaglePostCommitError) {
          await services.openBeagleWindow(error.projectId ? { projectId: error.projectId } : undefined).catch(() => undefined);
          return { ok: true, value: {
            state: "imported", collectorId: input.collectorId, targetId: input.target.id,
            domain: input.domain,
            message: "Graph data was imported, but Beagle could not save project metadata. Reload the project and run Analyze to recover diagnostics.",
            ...(error.projectId ? { projectId: error.projectId } : {}),
          } };
        }
        return { ok: true, value: {
          state: "saved", collectorId: input.collectorId, targetId: input.target.id,
          domain: input.domain,
          message: `The collection ZIP was saved, but Beagle did not import it. ${safeBeagleImportReason(error)}`,
        } };
      }
      trustedWindow(event);
      try {
        await services.openBeagleWindow(imported.projectId ? { projectId: imported.projectId } : undefined);
        trustedWindow(event);
      } catch {
        return { ok: true, value: {
          state: "imported", collectorId: input.collectorId, targetId: input.target.id,
          domain: input.domain,
          message: `${collectorName} data was saved and imported, but the AD Explorer window could not be opened. Open it from the View menu.`,
          ...(imported.projectId ? { projectId: imported.projectId } : {}),
        } };
      }
      return { ok: true, value: {
        state: "imported", collectorId: input.collectorId, targetId: input.target.id,
        domain: input.domain, message: `${collectorName} data was saved and imported into AD Explorer.`,
        ...(imported.projectId ? { projectId: imported.projectId } : {}),
      } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "AD collection failed" };
    }
  });

  ipcMain.handle(IPC.openBeagleWindow, async (event, ...args: unknown[]): Promise<OperationResult> => {
    try {
      trustedWindow(event);
      if (args.length > 1) throw new TypeError("Choose one AD Explorer collection");
      const input = args.length === 0 ? undefined : parseAdExplorerOpenInput(args[0]);
      await services.openBeagleWindow(input);
      trustedWindow(event);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "AD Explorer could not be opened" };
    }
  });

  ipcMain.handle(IPC.openAdCollectorArmory, async (event, ...args: unknown[]): Promise<OperationResult> => {
    try {
      trustedWindow(event);
      if (args.length !== 0) throw new TypeError("Opening the Armory install tab takes no arguments");
      await services.openAdCollectorArmory();
      trustedWindow(event);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Armory could not be opened" };
    }
  });
}

export function unregisterAdExplorerIpcHandlers(): void {
  for (const channel of [IPC.listAdCollections, IPC.listAdCollectors, IPC.getAdTargetDomain, IPC.runAdCollector, IPC.openBeagleWindow, IPC.openAdCollectorArmory]) ipcMain.removeHandler(channel);
}

function safeBeagleImportReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const version = /unsupported SharpHound version (\d{1,3})/iu.exec(message)?.[1];
  if (version) return `The collector produced SharpHound schema ${version}; Beagle supports schemas 5 and 6.`;
  if (/unsupported collection type/iu.test(message)) return "The collector produced a collection type Beagle does not support.";
  if (/no SharpHound JSON|missing meta object|invalid SharpHound collection|decoding .*\.json/iu.test(message)) {
    return "The ZIP does not contain Beagle-compatible SharpHound AD JSON.";
  }
  return "Open AD Explorer and import the saved ZIP to review the validation error.";
}
