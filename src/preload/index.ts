import { contextBridge, ipcRenderer } from "electron";

import { IPC, type SliverDesktopAPI, type SliverSnapshot } from "../shared/contracts.js";

const api: SliverDesktopAPI = {
  chooseConfig: () => ipcRenderer.invoke(IPC.chooseConfig),
  listSavedConfigs: () => ipcRenderer.invoke(IPC.listSavedConfigs),
  connectSavedConfig: (id) => ipcRenderer.invoke(IPC.connectSavedConfig, id),
  disconnect: () => ipcRenderer.invoke(IPC.disconnect),
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
  openWindow: (input) => ipcRenderer.invoke(IPC.openWindow, input),
  chooseCertificatePair: () => ipcRenderer.invoke(IPC.chooseCertificatePair),
  startListener: (input) => ipcRenderer.invoke(IPC.startListener, input),
  killJob: (jobId) => ipcRenderer.invoke(IPC.killJob, jobId),
  killAllJobs: () => ipcRenderer.invoke(IPC.killAllJobs),
  generate: (input) => ipcRenderer.invoke(IPC.generate, input),
  generateFromProfile: (input) => ipcRenderer.invoke(IPC.generateFromProfile, input),
  downloadBuild: (buildName) => ipcRenderer.invoke(IPC.downloadBuild, buildName),
  deleteBuild: (buildName) => ipcRenderer.invoke(IPC.deleteBuild, buildName),
  setStagedBuilds: (buildNames) => ipcRenderer.invoke(IPC.setStagedBuilds, buildNames),
  saveProfile: (input) => ipcRenderer.invoke(IPC.saveProfile, input),
  deleteProfile: (profileName) => ipcRenderer.invoke(IPC.deleteProfile, profileName),
  onSnapshotChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: SliverSnapshot) => listener(snapshot);
    ipcRenderer.on(IPC.snapshotChanged, handler);
    return () => ipcRenderer.removeListener(IPC.snapshotChanged, handler);
  },
};

contextBridge.exposeInMainWorld("sliver", Object.freeze(api));
