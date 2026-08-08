import { contextBridge, ipcRenderer } from "electron";

import {
  IPC,
  IPC_INVOKE,
  type SliverDesktopAPI,
  type SliverDesktopInvokeAPI,
  type SliverSnapshot,
} from "../shared/contracts.js";

function createInvokeApi(): SliverDesktopInvokeAPI {
  // Generate routes from the shared method-to-channel map so methods cannot be
  // wired to a different same-signature channel. Electron leaves invoke results
  // unconstrained, so keep the transport assertion isolated in this adapter.
  return Object.fromEntries(
    Object.entries(IPC_INVOKE).map(([method, channel]) => [
      method,
      (...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
    ]),
  ) as SliverDesktopInvokeAPI;
}

const api: SliverDesktopAPI = {
  ...createInvokeApi(),
  onSnapshotChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: SliverSnapshot) => listener(snapshot);
    ipcRenderer.on(IPC.snapshotChanged, handler);
    return () => ipcRenderer.removeListener(IPC.snapshotChanged, handler);
  },
};

contextBridge.exposeInMainWorld("sliver", Object.freeze(api));
