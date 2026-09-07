import { contextBridge, ipcRenderer } from "electron";

import type { CloudDeploymentAPI } from "../shared/cloud-deployment-ipc.js";

// Keep this sandboxed preload single-file: Electron's sandboxed `require` does
// not load Rollup chunks. The preload test locks this literal to the shared
// main-process contract.
const CHANNELS = Object.freeze({
  getSnapshot: "sliver:cloud-deployment:snapshot:get",
  getProvisioningTranscripts: "sliver:cloud-deployment:transcripts:get",
  getTerminalRuntime: "sliver:cloud-deployment:terminal-runtime:get",
  detectCurrentEgressIpv4: "sliver:cloud-deployment:egress-ipv4:detect",
  chooseSshPrivateKey: "sliver:cloud-deployment:ssh-key:choose",
  createCredential: "sliver:cloud-deployment:credential:create",
  deleteCredential: "sliver:cloud-deployment:credential:delete",
  testCredential: "sliver:cloud-deployment:credential:test",
  discoverAwsOptions: "sliver:cloud-deployment:aws:options:discover",
  createDeployment: "sliver:cloud-deployment:create",
  runLifecycleAction: "sliver:cloud-deployment:lifecycle",
  updateFirewall: "sliver:cloud-deployment:firewall:update",
  listFirewallRules: "sliver:cloud-deployment:firewall-rules:list",
  createFirewallRule: "sliver:cloud-deployment:firewall-rule:create",
  updateFirewallRule: "sliver:cloud-deployment:firewall-rule:update",
  deleteFirewallRule: "sliver:cloud-deployment:firewall-rule:delete",
  prepareDestroyDeployment: "sliver:cloud-deployment:destroy:prepare",
  executeDestroyDeployment: "sliver:cloud-deployment:destroy:execute",
  changed: "sliver:cloud-deployment:changed",
  themeChanged: "sliver:cloud-deployment:theme-changed",
});

const listeners = new Set<(dark: boolean) => void>();
let latestTheme: boolean | undefined;

ipcRenderer.on(CHANNELS.themeChanged, (_event, ...payload: unknown[]) => {
  if (payload.length !== 1 || typeof payload[0] !== "boolean") return;
  latestTheme = payload[0];
  for (const listener of listeners) listener(latestTheme);
});

const api: CloudDeploymentAPI = {
  getSnapshot: () => ipcRenderer.invoke(CHANNELS.getSnapshot),
  getProvisioningTranscripts: () => ipcRenderer.invoke(CHANNELS.getProvisioningTranscripts),
  getTerminalRuntime: () => ipcRenderer.invoke(CHANNELS.getTerminalRuntime),
  detectCurrentEgressIpv4: () => ipcRenderer.invoke(CHANNELS.detectCurrentEgressIpv4),
  chooseSshPrivateKey: () => ipcRenderer.invoke(CHANNELS.chooseSshPrivateKey),
  createCredential: (input) => ipcRenderer.invoke(CHANNELS.createCredential, input),
  deleteCredential: (input) => ipcRenderer.invoke(CHANNELS.deleteCredential, input),
  testCredential: (input) => ipcRenderer.invoke(CHANNELS.testCredential, input),
  discoverAwsOptions: (input) => ipcRenderer.invoke(CHANNELS.discoverAwsOptions, input),
  createDeployment: (input) => ipcRenderer.invoke(CHANNELS.createDeployment, input),
  runLifecycleAction: (input) => ipcRenderer.invoke(CHANNELS.runLifecycleAction, input),
  updateFirewall: (input) => ipcRenderer.invoke(CHANNELS.updateFirewall, input),
  listFirewallRules: (input) => ipcRenderer.invoke(CHANNELS.listFirewallRules, input),
  createFirewallRule: (input) => ipcRenderer.invoke(CHANNELS.createFirewallRule, input),
  updateFirewallRule: (input) => ipcRenderer.invoke(CHANNELS.updateFirewallRule, input),
  deleteFirewallRule: (input) => ipcRenderer.invoke(CHANNELS.deleteFirewallRule, input),
  prepareDestroyDeployment: (input) => ipcRenderer.invoke(CHANNELS.prepareDestroyDeployment, input),
  executeDestroyDeployment: (input) => ipcRenderer.invoke(CHANNELS.executeDestroyDeployment, input),
  onChanged: (listener) => {
    if (typeof listener !== "function") throw new TypeError("change listener must be a function");
    const handler = (_event: Electron.IpcRendererEvent, ...payload: unknown[]): void => {
      if (
        payload.length !== 1 ||
        (payload[0] !== "snapshot" && payload[0] !== "transcripts")
      ) return;
      listener(payload[0]);
    };
    ipcRenderer.on(CHANNELS.changed, handler);
    return () => ipcRenderer.removeListener(CHANNELS.changed, handler);
  },
  onThemeChanged: (listener) => {
    if (typeof listener !== "function") throw new TypeError("theme listener must be a function");
    listeners.add(listener);
    if (latestTheme !== undefined) {
      queueMicrotask(() => {
        if (listeners.has(listener) && latestTheme !== undefined) listener(latestTheme);
      });
    }
    return () => listeners.delete(listener);
  },
};

contextBridge.exposeInMainWorld("cloudDeployment", Object.freeze(api));
