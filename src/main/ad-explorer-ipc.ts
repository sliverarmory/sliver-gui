import { randomUUID } from "node:crypto";
import type { AdCollectionStore } from "./ad-collection-store.js";
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";

import { IPC, type OperationResult } from "../shared/contracts.js";
import {
  parseAdCollectorRunInput,
  parseAdCollectorCancelInput,
  parseAdCollectionArtifactInput,
  type AdCollectorProgress,
  type AdCollectionArtifact,
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
  artifacts: Pick<AdCollectionStore, "remember" | "list" | "resolve" | "imported">;
  revealCollectedFile: (path: string) => void;
}

export interface AdCollectorLifecycle {
  hasActive(contentsId: number): boolean;
  cancelAndWait(contentsId?: number): Promise<void>;
}
let activeLifecycle: AdCollectorLifecycle | undefined;

export function registerAdExplorerIpcHandlers(
  services: AdExplorerIpcServices,
  rendererUrl: string,
  authorizeWindow: (identity: TrustedWindowIdentity, window: BrowserWindow) => boolean,
): AdCollectorLifecycle {
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

  interface Job {
    event: IpcMainInvokeEvent;
    controller: AbortController;
    progress: AdCollectorProgress;
    active: boolean;
    cancellationSupported: boolean;
    done: Promise<void>;
    finish: () => void;
  }
  const jobs = new Map<number, Job>();
  const publish = (job: Job, update: Partial<AdCollectorProgress>): void => {
    job.progress = { ...job.progress, ...update };
    try { trustedWindow(job.event); job.event.sender.send(IPC.adCollectorProgress, job.progress); } catch { /* Closing document; snapshot remains available. */ }
  };
  const begin = (event: IpcMainInvokeEvent, targetId: string, cancellable: boolean): Job => {
    if (jobs.get(event.sender.id)?.active) throw new Error("A collection is already running in this workspace");
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const job: Job = { event, controller: new AbortController(), active: true, cancellationSupported: cancellable, done, finish,
      progress: { runId: randomUUID(), targetId, phase: "preparing", message: "Preparing collection", transferredBytes: 0, cancellable } };
    if (!jobs.has(event.sender.id)) event.sender.once?.("destroyed", () => { jobs.get(event.sender.id)?.controller.abort(); jobs.delete(event.sender.id); });
    jobs.set(event.sender.id, job);
    publish(job, {});
    return job;
  };
  const complete = (job: Job, result: AdCollectorRunResult): OperationResult<AdCollectorRunResult> => {
    job.active = false; job.finish();
    publish(job, { phase: result.state === "cancelled" ? "cancelled" : "complete", message: result.message, cancellable: false, result });
    return { ok: true, value: result };
  };
  const failed = (job: Job | undefined, error: unknown): OperationResult<AdCollectorRunResult> => {
    const message = error instanceof Error ? error.message : "AD collection failed";
    if (job) { job.active = false; job.finish(); publish(job, { phase: "failed", message, cancellable: false }); }
    return { ok: false, error: message };
  };
  const importing = new Set<string>();
  const importArtifact = async (job: Job, artifact: AdCollectionArtifact & { path: string }): Promise<AdCollectorRunResult> => {
    if (importing.has(artifact.collectionId)) throw new Error("This saved collection is already being imported");
    importing.add(artifact.collectionId);
    try { return await performImport(job, artifact); }
    finally { importing.delete(artifact.collectionId); }
  };
  const performImport = async (job: Job, artifact: AdCollectionArtifact & { path: string }): Promise<AdCollectorRunResult> => {
    const base = { collectorId: artifact.collectorId, targetId: artifact.targetId, domain: artifact.domain, collectionId: artifact.collectionId };
    const collectorName = artifact.collectorId === RUSTHOUND_ARMORY_COLLECTOR_ID ? "RustHound" : "SharpHound";
    publish(job, { phase: "importing", message: "Importing and analyzing collection", cancellable: false });
    let imported: { projectId?: string };
    try { imported = await services.importCollectedData({ domain: artifact.domain, path: artifact.path }); }
    catch (error) {
      if (error instanceof BeaglePostCommitError) {
        await services.artifacts.imported(artifact.collectionId).catch(() => undefined);
        if (!job.controller.signal.aborted) {
          try { trustedWindow(job.event); await services.openBeagleWindow(error.projectId ? { projectId: error.projectId } : undefined); } catch { /* Imported data remains available. */ }
        }
        return { ...base, state: "imported", message: "Graph data was imported, but Beagle could not save project metadata. Reload the project and run Analyze to recover diagnostics.",
          ...(error.projectId ? { projectId: error.projectId } : {}) };
      }
      return { ...base, state: "saved", message: `The collection ZIP was saved, but Beagle did not import it. ${safeBeagleImportReason(error)}` };
    }
    // Import is committed; a failure to clear recovery metadata must not imply data loss.
    await services.artifacts.imported(artifact.collectionId).catch(() => undefined);
    if (job.controller.signal.aborted) {
      return { ...base, state: "imported", message: `${collectorName} data was saved and imported. Open the collection in AD Explorer.`,
        ...(imported.projectId ? { projectId: imported.projectId } : {}) };
    }
    publish(job, { phase: "opening", message: "Opening the collected directory graph", cancellable: false });
    try { trustedWindow(job.event); await services.openBeagleWindow(imported.projectId ? { projectId: imported.projectId } : undefined); }
    catch {
      return { ...base, state: "imported", message: `${collectorName} data was saved and imported, but the AD Explorer window could not be opened. Open it from the View menu.`,
        ...(imported.projectId ? { projectId: imported.projectId } : {}) };
    }
    return { ...base, state: "imported", message: `${collectorName} data was saved and imported into AD Explorer.`,
      ...(imported.projectId ? { projectId: imported.projectId } : {}) };
  };

  ipcMain.handle(IPC.getAdCollectorProgress, (event, ...args: unknown[]) => {
    try { trustedWindow(event); if (args.length) throw new TypeError("Progress takes no arguments");
      const job = jobs.get(event.sender.id); if (job) job.event = event;
      return { ok: true, value: job?.progress ?? null };
    } catch (error) { return failed(undefined, error); }
  });
  ipcMain.handle(IPC.cancelAdCollector, (event, ...args: unknown[]) => {
    try {
      trustedWindow(event); if (args.length !== 1) throw new TypeError("Choose one collection run");
      const { runId } = parseAdCollectorCancelInput(args[0]); const job = jobs.get(event.sender.id);
      if (!job?.active || job.progress.runId !== runId || !job.progress.cancellable) throw new Error("This collection can no longer be cancelled");
      job.event = event; publish(job, { phase: "cancelling", message: "Cancelling collection and releasing target resources", cancellable: false });
      job.controller.abort(); return { ok: true };
    } catch (error) { return failed(undefined, error); }
  });
  ipcMain.handle(IPC.listAdCollectionArtifacts, async (event, ...args: unknown[]) => {
    try { trustedWindow(event); if (args.length) throw new TypeError("Saved collection listing takes no arguments");
      const value = await services.artifacts.list(); trustedWindow(event); return { ok: true, value };
    } catch (error) { return failed(undefined, error); }
  });
  ipcMain.handle(IPC.revealAdCollection, async (event, ...args: unknown[]) => {
    try { trustedWindow(event); if (args.length !== 1) throw new TypeError("Choose one saved collection");
      const { collectionId } = parseAdCollectionArtifactInput(args[0]); const artifact = await services.artifacts.resolve(collectionId);
      trustedWindow(event); services.revealCollectedFile(artifact.path); return { ok: true };
    } catch (error) { return failed(undefined, error); }
  });
  ipcMain.handle(IPC.retryAdCollectionImport, async (event, ...args: unknown[]) => {
    let job: Job | undefined;
    try { trustedWindow(event); if (args.length !== 1) throw new TypeError("Choose one saved collection");
      const { collectionId } = parseAdCollectionArtifactInput(args[0]);
      if (importing.has(collectionId)) throw new Error("This saved collection is already being imported");
      importing.add(collectionId);
      try {
        const artifact = await services.artifacts.resolve(collectionId);
        trustedWindow(event); job = begin(event, artifact.targetId, false);
        return complete(job, await performImport(job, artifact));
      } finally { importing.delete(collectionId); }
    } catch (error) { return failed(job, error); }
  });

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
    let job: Job | undefined;
    try {
      const window = trustedWindow(event);
      if (args.length !== 1) throw new TypeError("Choose one AD collector request");
      const input = parseAdCollectorRunInput(args[0]);
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
          domain: input.domain ?? "", message: "Collector selection was cancelled.",
        } };
        if (selection.filePaths.length !== 1) throw new Error("Choose one collector file");
        collectorPath = selection.filePaths[0]!;
      }
      trustedWindow(event);
      job = begin(event, input.target.id, input.collectorId === RUSTHOUND_ARMORY_COLLECTOR_ID);
      const activeJob = job;
      let cancelled = false;
      const collected = await services.registry.runAdCollector(event.sender.id, input, collectorPath, {
        signal: job.controller.signal,
        onCancelled: () => { cancelled = true; },
        onProgress: (progress) => {
          if (activeJob.controller.signal.aborted) return;
          const message = { registering: "Loading RustHound on the target", collecting: "Collecting Active Directory data",
            transferring: "Transferring collection ZIP", saving: "Verifying and saving collection ZIP" }[progress.phase];
          publish(activeJob, { ...progress, message });
        },
      });
      if (!collected.ok) {
        if (cancelled) return complete(job, { state: "cancelled", collectorId: input.collectorId, targetId: input.target.id,
          domain: input.domain ?? "", message: "Collection cancelled; target resources were released." });
        throw new Error(collected.error);
      }
      const artifact = await services.artifacts.remember({ ...collected.value, collectorId: input.collectorId, targetId: input.target.id });
      if (job.controller.signal.aborted) return complete(job, { state: "saved", collectorId: artifact.collectorId, targetId: artifact.targetId, domain: artifact.domain, collectionId: artifact.collectionId,
        message: "The collection ZIP was saved. Import was cancelled; retry it from Saved collections." });
      trustedWindow(job.event);
      return complete(job, await importArtifact(job, { ...artifact, path: collected.value.path }));
    } catch (error) { return failed(job, error); }
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
  const lifecycle: AdCollectorLifecycle = {
    hasActive: (contentsId) => { const job = jobs.get(contentsId); return Boolean(job?.active && job.cancellationSupported); },
    cancelAndWait: async (contentsId) => {
      const selected = [...jobs.values()].filter((job) => job.active && job.cancellationSupported && (contentsId === undefined || job.event.sender.id === contentsId));
      for (const job of selected) {
        publish(job, { phase: "cancelling", message: "Cancelling collection before closing", cancellable: false });
        job.controller.abort();
      }
      await Promise.allSettled(selected.map((job) => job.done));
    },
  };
  activeLifecycle = lifecycle;
  return lifecycle;
}

export function unregisterAdExplorerIpcHandlers(): void {
  void activeLifecycle?.cancelAndWait();
  activeLifecycle = undefined;
  for (const channel of [IPC.listAdCollections, IPC.listAdCollectors, IPC.getAdTargetDomain, IPC.runAdCollector, IPC.getAdCollectorProgress, IPC.cancelAdCollector, IPC.listAdCollectionArtifacts, IPC.retryAdCollectionImport, IPC.revealAdCollection, IPC.openBeagleWindow, IPC.openAdCollectorArmory]) ipcMain.removeHandler(channel);
}

function safeBeagleImportReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const version = /unsupported SharpHound version (\d{1,3})/iu.exec(message)?.[1];
  if (version) return `The collector produced SharpHound schema ${version}; Beagle supports schemas 5 and 6.`;
  if (/unsupported collection type/iu.test(message)) return "The collector produced a collection type Beagle does not support.";
  if (/no SharpHound JSON|missing meta object|invalid SharpHound collection|decoding .*\.json/iu.test(message)) {
    return "The ZIP does not contain Beagle-compatible SharpHound AD JSON.";
  }
  return "Retry the import, or show the saved collection to inspect it in AD Explorer.";
}
