import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { DEFAULT_APPLICATION_SETTINGS_STATE, type ApplicationSettingsState } from "../shared/application-settings-contracts.js";
import {
  ARMORY_IPC_EVENTS,
  ARMORY_IPC_INVOKE,
  parseArmoryChooseLocalInput,
  parseArmoryCopyPublicKeyInput,
  parseArmoryInstallBundleInput,
  parseArmoryInstallInput,
  parseArmoryOpenRepositoryInput,
  parseArmoryRemoveSourceInput,
  parseArmorySaveSourceInput,
  parseArmoryUninstallInput,
  type ArmoryTabId,
  type ArmoryProgress,
} from "../shared/armory-contracts.js";
import type { ArmoryService } from "./armory-service.js";
import { normalizeArmoryPublicKey } from "./armory-signature.js";
import type { TrustedWindowIdentity } from "./ipc.js";
import { isSameRendererDocument } from "./security.js";
import { externalWebHref } from "./external-web-url.js";

export interface ArmoryIpcServices {
  readonly manager: Pick<ArmoryService, "snapshot" | "refreshCatalog" | "updateAll" | "install" | "installBundle" | "uninstall" | "saveSource" | "removeSource" | "installLocal">;
  readonly getTab: () => ArmoryTabId;
  readonly getApplicationSettings: () => ApplicationSettingsState;
  readonly changed: () => void;
  readonly writeClipboardText: (text: string) => void;
  readonly openExternal: (url: string) => Promise<unknown>;
}

export function registerArmoryIpcHandlers(
  services: ArmoryIpcServices,
  rendererUrl: string,
  authorizeWindow: (identity: TrustedWindowIdentity, window: BrowserWindow) => boolean,
): void {
  let mutationPending = false;
  function trustedWindow(event: IpcMainInvokeEvent): BrowserWindow {
    const { sender, senderFrame } = event;
    const window = BrowserWindow.fromWebContents(sender);
    if (!window || window.isDestroyed() || sender.isDestroyed() || !senderFrame || senderFrame.isDestroyed() ||
        senderFrame.processId !== sender.mainFrame.processId || senderFrame.frameToken !== sender.mainFrame.frameToken ||
        !isSameRendererDocument(sender.getURL(), rendererUrl) || !isSameRendererDocument(senderFrame.url, rendererUrl) ||
        !authorizeWindow({ contentsId: sender.id, rendererProcessId: senderFrame.processId, rendererFrameToken: senderFrame.frameToken }, window)) {
      throw new Error("Untrusted Armory renderer");
    }
    return window;
  }
  async function withProgress<T>(window: BrowserWindow, event: IpcMainInvokeEvent,
    action: (notify: (progress: ArmoryProgress) => void) => Promise<T>): Promise<T> {
    let active = true;
    try {
      return await action((progress) => {
        if (!active) return;
        try {
          if (trustedWindow(event) !== window || window.webContents.isDestroyed()) return;
          window.webContents.send(ARMORY_IPC_EVENTS.progress, progress);
        } catch { /* A closed or navigated renderer does not affect the install. */ }
      });
    } finally { active = false; }
  }
  function handle<T>(channel: string, parse: (args: unknown[]) => T, action: (input: T, window: BrowserWindow, event: IpcMainInvokeEvent) => unknown, mutation = false, emptyResult = false): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      let ownsMutation = false;
      try {
        const window = trustedWindow(event);
        const input = parse(args);
        if (mutation) {
          if (mutationPending) return { ok: false, error: "Another Armory operation is in progress" };
          ownsMutation = mutationPending = true;
        }
        const value = await action(input, window, event);
        if (mutation && value !== undefined) services.changed();
        return emptyResult ? { ok: true } : { ok: true, value };
      } catch (error) {
        // Backend errors are deliberately operator-safe and contain no source credentials.
        return { ok: false, error: error instanceof Error ? error.message : "The Armory request failed" };
      } finally {
        if (ownsMutation) mutationPending = false;
      }
    });
  }
  handle(ARMORY_IPC_INVOKE.getContext, none, () => ({ tab: services.getTab() }));
  handle(ARMORY_IPC_INVOKE.snapshot, none, () => services.manager.snapshot());
  handle(ARMORY_IPC_INVOKE.refreshCatalog, none, () => services.manager.refreshCatalog(), true);
  handle(ARMORY_IPC_INVOKE.updateAll, none, (_input, window, event) => withProgress(window, event, (notify) => services.manager.updateAll(notify)), true);
  handle(ARMORY_IPC_INVOKE.install, one(parseArmoryInstallInput), (input, window, event) => withProgress(window, event, (notify) => services.manager.install(input, notify)), true);
  handle(ARMORY_IPC_INVOKE.installBundle, one(parseArmoryInstallBundleInput), (input, window, event) => withProgress(window, event, (notify) => services.manager.installBundle(input, notify)), true);
  handle(ARMORY_IPC_INVOKE.uninstall, one(parseArmoryUninstallInput), (input) => services.manager.uninstall(input), true);
  handle(ARMORY_IPC_INVOKE.saveSource, one(parseArmorySaveSourceInput), (input) => services.manager.saveSource(input), true);
  handle(ARMORY_IPC_INVOKE.removeSource, one(parseArmoryRemoveSourceInput), (input) => services.manager.removeSource(input), true);
  handle(ARMORY_IPC_INVOKE.copyPublicKey, one(parseArmoryCopyPublicKeyInput), (input) => {
    let publicKey: string;
    try { publicKey = normalizeArmoryPublicKey(input.publicKey); }
    catch { throw new Error("The package public key is invalid"); }
    try { services.writeClipboardText(publicKey); }
    catch { throw new Error("The public key could not be copied to the clipboard"); }
  }, false, true);
  handle(ARMORY_IPC_INVOKE.openRepository, one(parseArmoryOpenRepositoryInput), async (input) => {
    const href = externalWebHref(input.url);
    if (!href) throw new Error("Repository links must use an absolute HTTP or HTTPS URL without embedded credentials");
    try { await services.openExternal(href); }
    catch { throw new Error("The repository could not be opened in your browser"); }
  }, false, true);
  handle(ARMORY_IPC_INVOKE.installLocal, one(parseArmoryChooseLocalInput), async (input, window, event) => {
    const archive = await dialog.showOpenDialog(window, {
      title: "Choose Armory Package", properties: ["openFile"], filters: [{ name: "Package Archive", extensions: ["gz"] }],
    });
    if (archive.canceled) return undefined;
    if (archive.filePaths.length !== 1) throw new Error("Choose one Armory archive");
    trustedWindow(event);
    const signature = await dialog.showOpenDialog(window, {
      title: "Choose Package Signature", properties: ["openFile"], filters: [{ name: "Minisign Signature", extensions: ["minisig"] }],
    });
    if (signature.canceled) return undefined;
    if (signature.filePaths.length !== 1) throw new Error("Choose one Armory signature");
    trustedWindow(event);
    return services.manager.installLocal({ ...input, archivePath: archive.filePaths[0]!, signaturePath: signature.filePaths[0]! });
  }, true);
  ipcMain.handle(ARMORY_IPC_INVOKE.getApplicationSettings, (event, ...args: unknown[]) => {
    try {
      trustedWindow(event);
      none(args);
      return services.getApplicationSettings();
    } catch { return DEFAULT_APPLICATION_SETTINGS_STATE; }
  });
}

export function unregisterArmoryIpcHandlers(): void {
  for (const channel of Object.values(ARMORY_IPC_INVOKE)) ipcMain.removeHandler(channel);
}
function none(args: unknown[]): undefined {
  if (args.length !== 0) throw new TypeError("Unexpected Armory arguments");
  return undefined;
}
function one<T>(parse: (value: unknown) => T): (args: unknown[]) => T {
  return (args) => {
    if (args.length !== 1) throw new TypeError("A single Armory argument is required");
    return parse(args[0]);
  };
}
