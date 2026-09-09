import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { DEFAULT_APPLICATION_SETTINGS_STATE, type ApplicationSettingsState } from "../shared/application-settings-contracts.js";
import {
  ARMORY_IPC_INVOKE,
  parseArmoryChooseLocalInput,
  parseArmoryInstallBundleInput,
  parseArmoryInstallInput,
  parseArmoryRemoveSourceInput,
  parseArmorySaveSourceInput,
  parseArmoryUninstallInput,
  type ArmoryTabId,
} from "../shared/armory-contracts.js";
import type { ArmoryService } from "./armory-service.js";
import type { TrustedWindowIdentity } from "./ipc.js";
import { isSameRendererDocument } from "./security.js";

export interface ArmoryIpcServices {
  readonly manager: Pick<ArmoryService, "snapshot" | "refreshCatalog" | "install" | "installBundle" | "uninstall" | "saveSource" | "removeSource" | "installLocal">;
  readonly getTab: () => ArmoryTabId;
  readonly getApplicationSettings: () => ApplicationSettingsState;
  readonly changed: () => void;
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
  function handle<T>(channel: string, parse: (args: unknown[]) => T, action: (input: T, window: BrowserWindow, event: IpcMainInvokeEvent) => unknown, mutation = false): void {
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
        return { ok: true, value };
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
  handle(ARMORY_IPC_INVOKE.install, one(parseArmoryInstallInput), (input) => services.manager.install(input), true);
  handle(ARMORY_IPC_INVOKE.installBundle, one(parseArmoryInstallBundleInput), (input) => services.manager.installBundle(input), true);
  handle(ARMORY_IPC_INVOKE.uninstall, one(parseArmoryUninstallInput), (input) => services.manager.uninstall(input), true);
  handle(ARMORY_IPC_INVOKE.saveSource, one(parseArmorySaveSourceInput), (input) => services.manager.saveSource(input), true);
  handle(ARMORY_IPC_INVOKE.removeSource, one(parseArmoryRemoveSourceInput), (input) => services.manager.removeSource(input), true);
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
