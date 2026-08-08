import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";

import {
  IPC,
  type GenerateFromProfileInput,
  type GenerateInput,
  type ListenerInput,
  type OpenWindowInput,
  type SaveProfileInput,
} from "../shared/contracts.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import { isTrustedRendererUrl } from "./security.js";

interface TrustedSender {
  sender: WebContents;
  contentsId: number;
}

export function registerIpcHandlers(
  registry: ConnectionRegistry,
  createWindow: (inheritFromContentsId?: number) => void,
  rendererUrl: string,
): void {
  handleTrusted(IPC.chooseConfig, rendererUrl, ({ sender }) => registry.chooseAndConnect(sender));
  handleTrusted(IPC.listSavedConfigs, rendererUrl, ({ contentsId }) => registry.listSavedConfigs(contentsId));
  handleTrusted(IPC.connectSavedConfig, rendererUrl, ({ contentsId }, id: unknown) =>
    registry.connectSavedConfig(contentsId, requireSavedConfigId(id)),
  );
  handleTrusted(IPC.disconnect, rendererUrl, ({ contentsId }) => registry.disconnect(contentsId));
  handleTrusted(IPC.getSnapshot, rendererUrl, ({ contentsId }) => registry.snapshot(contentsId));
  handleTrusted(IPC.refresh, rendererUrl, ({ contentsId }) => registry.refresh(contentsId));
  handleTrusted(IPC.openWindow, rendererUrl, ({ contentsId }, input: OpenWindowInput) => {
    createWindow(input?.inheritConnection === true ? contentsId : undefined);
    return { ok: true };
  });
  handleTrusted(IPC.chooseCertificatePair, rendererUrl, ({ sender }) => registry.chooseCertificatePair(sender));
  handleTrusted(IPC.startListener, rendererUrl, ({ contentsId }, input: ListenerInput) =>
    registry.startListener(contentsId, input),
  );
  handleTrusted(IPC.killJob, rendererUrl, ({ contentsId }, jobId: number) => registry.killJob(contentsId, jobId));
  handleTrusted(IPC.killAllJobs, rendererUrl, ({ contentsId }) => registry.killAllJobs(contentsId));
  handleTrusted(IPC.generate, rendererUrl, ({ sender }, input: GenerateInput) => registry.generate(sender, input));
  handleTrusted(IPC.generateFromProfile, rendererUrl, ({ sender }, input: GenerateFromProfileInput) =>
    registry.generateFromProfile(sender, input),
  );
  handleTrusted(IPC.downloadBuild, rendererUrl, ({ sender }, name: string) => registry.downloadBuild(sender, name));
  handleTrusted(IPC.deleteBuild, rendererUrl, ({ contentsId }, name: string) => registry.deleteBuild(contentsId, name));
  handleTrusted(IPC.setStagedBuilds, rendererUrl, ({ contentsId }, names: string[]) =>
    registry.setStagedBuilds(contentsId, names),
  );
  handleTrusted(IPC.saveProfile, rendererUrl, ({ contentsId }, input: SaveProfileInput) =>
    registry.saveProfile(contentsId, input),
  );
  handleTrusted(IPC.deleteProfile, rendererUrl, ({ contentsId }, name: string) =>
    registry.deleteProfile(contentsId, name),
  );
}

export function unregisterIpcHandlers(): void {
  for (const channel of Object.values(IPC)) {
    if (channel !== IPC.snapshotChanged) ipcMain.removeHandler(channel);
  }
}

export function isTrustedSender(sender: WebContents, rendererUrl: string): boolean {
  try {
    if (sender.isDestroyed() || !BrowserWindow.fromWebContents(sender)) return false;
    return isTrustedRendererUrl(sender.getURL(), rendererUrl);
  } catch {
    return false;
  }
}

function requireTrustedSender(event: IpcMainInvokeEvent, rendererUrl: string): TrustedSender {
  const { sender, senderFrame } = event;
  if (!senderFrame || senderFrame.isDestroyed() || !isTrustedSender(sender, rendererUrl)) {
    throw new Error("Rejected IPC invocation from an untrusted renderer");
  }
  const mainFrame = sender.mainFrame;
  if (
    senderFrame.processId !== mainFrame.processId ||
    senderFrame.frameToken !== mainFrame.frameToken ||
    !isTrustedRendererUrl(senderFrame.url, rendererUrl)
  ) {
    throw new Error("Rejected IPC invocation from an untrusted renderer");
  }
  return { sender, contentsId: sender.id };
}

function handleTrusted<Args extends unknown[], Result>(
  channel: string,
  rendererUrl: string,
  handler: (sender: TrustedSender, ...args: Args) => Result,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) =>
    handler(requireTrustedSender(event, rendererUrl), ...(args as Args)),
  );
}

function requireSavedConfigId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new Error("Rejected invalid saved configuration selection");
  }
  return value;
}
