import { contextBridge, ipcRenderer } from "electron";

import type { ApplicationSettingsState } from "../shared/application-settings-contracts.js";
import type {
  NetworkForwardingAPI,
  NetworkTabId,
} from "../shared/network-forwarding-contracts.js";

// Keep this sandboxed preload single-file: Electron's sandboxed `require` does
// not load Rollup chunks. Main repeats strict runtime validation for every
// request; this bridge only exposes the fixed Network capability surface.
const CHANNELS = Object.freeze({
  getContext: "sliver:network-forwarding:context:get",
  list: "sliver:network-forwarding:list",
  startPortForward: "sliver:network-forwarding:port-forward:start",
  stopPortForward: "sliver:network-forwarding:port-forward:stop",
  startReversePortForward: "sliver:network-forwarding:reverse-port-forward:start",
  stopReversePortForward: "sliver:network-forwarding:reverse-port-forward:stop",
  startSocks5Proxy: "sliver:network-forwarding:socks5:start",
  stopSocks5Proxy: "sliver:network-forwarding:socks5:stop",
  getApplicationSettings: "sliver:network-forwarding:application-settings:get",
  changed: "sliver:network-forwarding:changed",
  snapshotChanged: "sliver:snapshot:changed",
  navigationRequested: "sliver:network-forwarding:navigation-requested",
  applicationSettingsChanged: "sliver:application-settings:changed",
});

const NETWORK_TABS = new Set<NetworkTabId>([
  "port-forward",
  "reverse-port-forward",
  "socks5",
]);

const navigationListeners = new Set<(tab: NetworkTabId) => void>();
let pendingNavigationTab: NetworkTabId | undefined;

ipcRenderer.on(CHANNELS.navigationRequested, (_event, ...payload: unknown[]) => {
  const tab = payload.length === 1 && NETWORK_TABS.has(payload[0] as NetworkTabId)
    ? payload[0] as NetworkTabId
    : undefined;
  if (!tab) return;
  if (navigationListeners.size === 0) {
    pendingNavigationTab = tab;
    return;
  }
  pendingNavigationTab = undefined;
  for (const listener of navigationListeners) listener(tab);
});

const api: NetworkForwardingAPI = {
  getContext: () => ipcRenderer.invoke(CHANNELS.getContext),
  list: (input) => ipcRenderer.invoke(CHANNELS.list, input),
  startPortForward: (input) => ipcRenderer.invoke(CHANNELS.startPortForward, input),
  stopPortForward: (id) => ipcRenderer.invoke(CHANNELS.stopPortForward, id),
  startReversePortForward: (input) => ipcRenderer.invoke(CHANNELS.startReversePortForward, input),
  stopReversePortForward: (input) => ipcRenderer.invoke(CHANNELS.stopReversePortForward, input),
  startSocks5Proxy: (input) => ipcRenderer.invoke(CHANNELS.startSocks5Proxy, input),
  stopSocks5Proxy: (id) => ipcRenderer.invoke(CHANNELS.stopSocks5Proxy, id),
  getApplicationSettings: () => ipcRenderer.invoke(CHANNELS.getApplicationSettings),
  onChanged: (listener) => {
    if (typeof listener !== "function") throw new TypeError("change listener must be a function");
    const handler = (): void => listener();
    ipcRenderer.on(CHANNELS.changed, handler);
    ipcRenderer.on(CHANNELS.snapshotChanged, handler);
    return () => {
      ipcRenderer.removeListener(CHANNELS.changed, handler);
      ipcRenderer.removeListener(CHANNELS.snapshotChanged, handler);
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

contextBridge.exposeInMainWorld("network", Object.freeze(api));
