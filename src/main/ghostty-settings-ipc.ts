import { dirname } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { GHOSTTY_SETTINGS_IPC, type GhosttySettingsSnapshot } from "../shared/ghostty-settings-contracts.js";
import type { GhosttyConfigStore } from "./ghostty-config.js";
import { isSameRendererDocument } from "./security.js";
import { supportsTerminalTransparency } from "./window-options.js";

interface GhosttySettingsIpcOptions {
  readonly store: GhosttyConfigStore;
  readonly resolveWindow: (event: IpcMainInvokeEvent) => { window: BrowserWindow; rendererUrl: string } | undefined;
  readonly windows: () => readonly BrowserWindow[];
  readonly editConfig: () => Promise<void>;
  readonly onChanged: () => void;
}

/** A small appearance-only authority, shared by workspace and terminal preloads. */
export function registerGhosttySettingsIpc(options: GhosttySettingsIpcOptions): {
  reload(): Promise<GhosttySettingsSnapshot>;
  dispose(): void;
} {
  let disposed = false;
  let reloadPending: Promise<GhosttySettingsSnapshot> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const watchers: FSWatcher[] = [];
  const snapshot = (): GhosttySettingsSnapshot => ({ ...options.store.getState(), nativeTerminalTransparency: supportsTerminalTransparency() });
  const publish = (): void => {
    if (disposed) return;
    options.onChanged();
    const state = snapshot();
    for (const window of options.windows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try { window.webContents.send(GHOSTTY_SETTINGS_IPC.changed, state); }
      catch { /* A closing renderer reads the latest snapshot on its next load. */ }
    }
  };
  const reload = (): Promise<GhosttySettingsSnapshot> => {
    if (disposed) return Promise.resolve(snapshot());
    return reloadPending ??= (async () => {
      const revision = options.store.getState().revision;
      await options.store.reload();
      if (revision !== options.store.getState().revision) publish();
      return snapshot();
    })().finally(() => { reloadPending = undefined; });
  };
  const requireSender = (event: IpcMainInvokeEvent): void => {
    const resolved = options.resolveWindow(event);
    const frame = event.senderFrame;
    if (disposed || !resolved || resolved.window.isDestroyed() || event.sender.isDestroyed() ||
        resolved.window.webContents !== event.sender || !frame || frame.isDestroyed() ||
        event.sender.mainFrame.isDestroyed() || event.sender.mainFrame.processId !== frame.processId ||
        event.sender.mainFrame.frameToken !== frame.frameToken ||
        !isSameRendererDocument(event.sender.getURL(), resolved.rendererUrl) ||
        !isSameRendererDocument(frame.url, resolved.rendererUrl)) {
      throw new Error("This window cannot access terminal appearance settings");
    }
  };
  const channels = [GHOSTTY_SETTINGS_IPC.get, GHOSTTY_SETTINGS_IPC.reload, GHOSTTY_SETTINGS_IPC.setTheme, GHOSTTY_SETTINGS_IPC.edit];
  for (const channel of channels) ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    requireSender(event);
    if (channel === GHOSTTY_SETTINGS_IPC.setTheme) {
      if (args.length !== 1 || typeof args[0] !== "string" || args[0].length > 4096 || /[\u0000-\u001f\u007f]/u.test(args[0])) {
        throw new TypeError("Invalid Ghostty theme");
      }
      const result = await options.store.setTheme(args[0]);
      if (!result.ok) return result;
      publish();
      return { ok: true, value: snapshot() };
    }
    if (args.length !== 0) throw new TypeError("Unexpected terminal appearance arguments");
    if (channel === GHOSTTY_SETTINGS_IPC.get) return snapshot();
    if (channel === GHOSTTY_SETTINGS_IPC.reload) return reload();
    try {
      await options.store.ensureConfig();
      requireSender(event);
      await options.editConfig();
      return { ok: true };
    } catch {
      return { ok: false, error: "The Ghostty configuration could not be opened" };
    }
  });
  for (const directory of [options.store.themesDirectory, dirname(options.store.configPath)]) {
    try {
      const watcher = watch(directory, { persistent: false }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => { void reload().catch(() => undefined); }, 150);
        debounce.unref();
      });
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch { /* Reload remains available when the filesystem cannot be watched. */ }
  }
  return {
    reload,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (debounce) clearTimeout(debounce);
      for (const watcher of watchers) watcher.close();
      for (const channel of channels) ipcMain.removeHandler(channel);
    },
  };
}
