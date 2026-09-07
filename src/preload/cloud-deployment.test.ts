// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  CLOUD_DEPLOYMENT_IPC_EVENTS,
  CLOUD_DEPLOYMENT_IPC_INVOKE,
  type CloudDeploymentAPI,
} from "../shared/cloud-deployment-ipc.js";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: CloudDeploymentAPI) => void>(),
  invoke: vi.fn(async () => ({ ok: true })),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

await import("./cloud-deployment.js");

describe("Cloud Deployment preload bridge", () => {
  it("exposes only the narrow frozen cloud API and maps every invoke to its fixed channel", async () => {
    const api = exposedApi();
    expect(Object.keys(api)).toEqual([
      "getSnapshot",
      "getProvisioningTranscripts",
      "getTerminalRuntime",
      "detectCurrentEgressIpv4",
      "chooseSshPrivateKey",
      "createCredential",
      "deleteCredential",
      "testCredential",
      "discoverAwsOptions",
      "createDeployment",
      "runLifecycleAction",
      "updateFirewall",
      "prepareDestroyDeployment",
      "executeDestroyDeployment",
      "onChanged",
      "onThemeChanged",
    ]);
    expect(Object.isFrozen(api)).toBe(true);

    await api.getSnapshot();
    await api.getProvisioningTranscripts();
    await api.getTerminalRuntime();
    await api.detectCurrentEgressIpv4();
    await api.chooseSshPrivateKey();
    await api.discoverAwsOptions({
      credentialId: "11111111-1111-4111-8111-111111111111",
      region: "us-west-2",
    });
    expect(electronMocks.invoke.mock.calls.slice(0, 6)).toEqual([
      [CLOUD_DEPLOYMENT_IPC_INVOKE.getSnapshot],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.getProvisioningTranscripts],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.getTerminalRuntime],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.detectCurrentEgressIpv4],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.chooseSshPrivateKey],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.discoverAwsOptions, {
        credentialId: "11111111-1111-4111-8111-111111111111",
        region: "us-west-2",
      }],
    ]);
  });

  it("accepts only typed change signals and removes the exact handler", () => {
    const api = exposedApi();
    const listener = vi.fn();
    const unsubscribe = api.onChanged(listener);
    const eventCall = eventRegistration(CLOUD_DEPLOYMENT_IPC_EVENTS.changed);
    const handler = eventCall[1] as (event: unknown, ...payload: unknown[]) => void;

    handler({});
    expect(listener).not.toHaveBeenCalled();
    handler({}, "unexpected");
    expect(listener).not.toHaveBeenCalled();
    handler({}, "transcripts");
    handler({}, "snapshot");
    expect(listener.mock.calls).toEqual([["transcripts"], ["snapshot"]]);
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      CLOUD_DEPLOYMENT_IPC_EVENTS.changed,
      handler,
    );
  });

  it("validates and replays native theme events", async () => {
    const handler = eventRegistration(CLOUD_DEPLOYMENT_IPC_EVENTS.themeChanged)[1] as (
      event: unknown,
      ...payload: unknown[]
    ) => void;
    handler({}, "dark");
    const api = exposedApi();
    const listener = vi.fn();
    const unsubscribe = api.onThemeChanged(listener);
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();

    handler({}, false);
    expect(listener).toHaveBeenCalledExactlyOnceWith(false);
    unsubscribe();
    handler({}, true);
    expect(listener).toHaveBeenCalledOnce();
  });
});

function exposedApi(): CloudDeploymentAPI {
  const call = electronMocks.exposeInMainWorld.mock.calls[0];
  if (!call) throw new Error("Expected the Cloud Deployment bridge to be installed");
  expect(call[0]).toBe("cloudDeployment");
  return call[1];
}

function eventRegistration(channel: string): unknown[] {
  const call = electronMocks.on.mock.calls.find(([candidate]) => candidate === channel);
  if (!call) throw new Error(`Expected ${channel} to be registered`);
  return call;
}
