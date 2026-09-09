import { contextBridge, ipcRenderer } from "electron";

import type { ApplicationSettingsState } from "../shared/application-settings-contracts.js";
import type {
  ArmoryAPI,
  ArmoryTabId,
} from "../shared/armory-contracts.js";

// Keep this sandboxed preload single-file: Electron's sandboxed `require` does
// not load Rollup chunks. Main repeats strict runtime validation for every
// request; this bridge only exposes the fixed Armory capability surface.
const CHANNELS = Object.freeze({
  getContext: "sliver:armory:context:get",
  snapshot: "sliver:armory:snapshot",
  refreshCatalog: "sliver:armory:catalog:refresh",
  install: "sliver:armory:install",
  installBundle: "sliver:armory:bundle:install",
  uninstall: "sliver:armory:uninstall",
  saveSource: "sliver:armory:source:save",
  removeSource: "sliver:armory:source:remove",
  installLocal: "sliver:armory:local:install",
  getApplicationSettings: "sliver:armory:application-settings:get",
  changed: "sliver:armory:changed",
  navigationRequested: "sliver:armory:navigation-requested",
  applicationSettingsChanged: "sliver:application-settings:changed",
});
const ARMORY_TABS = new Set<ArmoryTabId>(["manage", "install", "sources"]);

const navigationListeners = new Set<(tab: ArmoryTabId) => void>();
let pendingNavigationTab: ArmoryTabId | undefined;

ipcRenderer.on(CHANNELS.navigationRequested, (_event, ...payload: unknown[]) => {
  const tab = payload.length === 1 && ARMORY_TABS.has(payload[0] as ArmoryTabId)
    ? payload[0] as ArmoryTabId
    : undefined;
  if (!tab) return;
  if (navigationListeners.size === 0) {
    pendingNavigationTab = tab;
    return;
  }
  pendingNavigationTab = undefined;
  for (const listener of navigationListeners) listener(tab);
});

const api: ArmoryAPI = {
  getContext: () => ipcRenderer.invoke(CHANNELS.getContext),
  snapshot: () => ipcRenderer.invoke(CHANNELS.snapshot),
  refreshCatalog: () => ipcRenderer.invoke(CHANNELS.refreshCatalog),
  install: (input) => ipcRenderer.invoke(CHANNELS.install, input),
  installBundle: (input) => ipcRenderer.invoke(CHANNELS.installBundle, input),
  uninstall: (input) => ipcRenderer.invoke(CHANNELS.uninstall, input),
  saveSource: (input) => ipcRenderer.invoke(CHANNELS.saveSource, input),
  removeSource: (input) => ipcRenderer.invoke(CHANNELS.removeSource, input),
  installLocal: (input) => ipcRenderer.invoke(CHANNELS.installLocal, input),
  getApplicationSettings: () => ipcRenderer.invoke(CHANNELS.getApplicationSettings),
  onChanged: (listener) => {
    if (typeof listener !== "function") throw new TypeError("change listener must be a function");
    const handler = (): void => listener();
    ipcRenderer.on(CHANNELS.changed, handler);
    return () => {
      ipcRenderer.removeListener(CHANNELS.changed, handler);
    };
  },
  onNavigationRequested: (listener) => {
    if (typeof listener !== "function") throw new TypeError("navigation listener must be a function");
    navigationListeners.add(listener);
    const pending = pendingNavigationTab;
    if (pending) {
      queueMicrotask(() => {
        if (navigationListeners.has(listener) && pendingNavigationTab === pending) {
          pendingNavigationTab = undefined;
          listener(pending);
        }
      });
    }
    return () => navigationListeners.delete(listener);
  },
  onApplicationSettingsChanged: (listener) => {
    if (typeof listener !== "function") throw new TypeError("settings listener must be a function");
    const handler = (_event: Electron.IpcRendererEvent, ...payload: unknown[]): void => {
      if (payload.length !== 1 || typeof payload[0] !== "object" || payload[0] === null) return;
      listener(payload[0] as ApplicationSettingsState);
    };
    ipcRenderer.on(CHANNELS.applicationSettingsChanged, handler);
    return () => ipcRenderer.removeListener(CHANNELS.applicationSettingsChanged, handler);
  },
};

contextBridge.exposeInMainWorld("armory", Object.freeze(api));
