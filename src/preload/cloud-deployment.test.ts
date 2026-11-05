// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  CLOUD_DEPLOYMENT_IPC_EVENTS,
  CLOUD_DEPLOYMENT_IPC_INVOKE,
  type CloudDeploymentAPI,
  type CloudDeploymentInvokeMethod,
} from "../shared/cloud-deployment-ipc.js";

type InvokeArgumentCases = {
  [Method in CloudDeploymentInvokeMethod]: readonly Parameters<CloudDeploymentAPI[Method]>[];
};

const credentialId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const installationId = "33333333-3333-4333-8333-333333333333";
const rule = {
  direction: "ingress" as const, protocol: "tcp", fromPort: 443, toPort: 443,
  peerType: "ipv4" as const, peer: "203.0.113.0/24", description: "HTTPS",
};
const dnsIdentity = { credentialId, zoneId: "ZEXAMPLE" };
const dnsExisting = { ...dnsIdentity, recordId: "www.example.test.|A", expectedVersion: "a".repeat(64) };
const dnsRecord = { name: "www", type: "A" as const, ttl: 300, values: ["203.0.113.10"] };
// Exhaustiveness and argument shapes are checked independently against the shared API.
const invokeArguments = {
  getSnapshot: [[]],
  refreshDeployments: [[]],
  copyInstanceId: [[{ deploymentId }]],
  copyIpAddress: [[{ deploymentId, kind: "public" }], [{ deploymentId, kind: "private" }]],
  getProvisioningTranscripts: [[]],
  getTerminalRuntime: [[]],
  detectCurrentEgressIpv4: [[]],
  chooseSshPrivateKey: [[]],
  createCredential: [[{
    provider: "aws", label: "Fixture profile", defaultRegion: "us-west-2", profileName: "fixture",
    sshUsername: "ubuntu", sshPrivateKeyToken: null, sshPassphrase: null,
  }]],
  openAwsConsole: [[{ region: "us-west-2" }]],
  loginAwsCredential: [[{ credentialId }]],
  copyAwsLoginLink: [[]],
  cancelAwsLogin: [[]],
  beginAzureLogin: [[{ tenantId: null, clientId: null }]],
  loginAzureCredential: [[{ credentialId }]],
  cancelAzureLogin: [[]],
  deleteCredential: [[{ credentialId }]],
  testCredential: [[{ credentialId }]],
  copyAwsPermissionsTerraform: [[]],
  discoverAwsOptions: [[{ credentialId, region: "us-west-2" }]],
  discoverAzureAccounts: [[]],
  discoverAzureOptions: [[{ credentialId, location: "westus2" }]],
  listDnsZones: [[{ credentialId }]],
  listDnsRecords: [[{ credentialId, zoneId: null }]],
  createDnsRecord: [[{ ...dnsIdentity, record: dnsRecord }]],
  updateDnsRecord: [[{ ...dnsExisting, record: dnsRecord }]],
  deleteDnsRecord: [[dnsExisting]],
  createDeployment: [[{
    provider: "aws", expectedRevision: 3, credentialId, name: "Fixture deployment",
    spec: {
      region: "us-west-2", imageId: "ami-0123456789abcdef0", instanceType: "t3.small",
      networkMode: "managed", subnetId: null, vpcId: null, managedVpcCidr: "10.0.0.0/16",
      managedSubnetCidr: "10.0.1.0/24", sshKeyMode: "managed", existingKeyPairName: null,
      sshUsername: "ubuntu", keyPairName: "fixture-key", operatorName: "operator",
      sshPort: 22, multiplayerPort: 31337, volumeSizeGiB: 20, useElasticIp: false,
      sshCidrs: ["203.0.113.10/32"], operatorCidrs: ["203.0.113.10/32"],
    },
  }]],
  getSoftwareState: [[]],
  getSoftwareInstallProgress: [[{ deploymentId }]],
  listSoftwareListeners: [[{ deploymentId }]],
  installLocalRedirector: [[{
    deploymentId, expectedRevision: 0, recipeId: "caddy", publicIp: "203.0.113.10",
    domains: [], listener: { mode: "create", port: 8000 },
  }]],
  removeLocalRedirector: [[{ deploymentId, installationId, expectedRevision: 1 }]],
  renameDeployment: [[{ deploymentId, expectedRevision: 4, name: "Production Control" }]],
  createOperatorConfig: [[{
    deploymentId, expectedRevision: 7, operatorName: "red-team-2", publicIp: "203.0.113.80",
    port: 44331, permissions: "crackstation",
  }]],
  runLifecycleAction: [[{ deploymentId, expectedRevision: 4, action: "stop" }]],
  updateFirewall: [[{ deploymentId, expectedRevision: 4, sshCidrs: ["203.0.113.10/32"], operatorCidrs: ["203.0.113.10/32"] }]],
  listFirewallRules: [[{ deploymentId }]],
  createFirewallRule: [[{ deploymentId, expectedRevision: 4, rule }]],
  updateFirewallRule: [[{ deploymentId, expectedRevision: 5, ruleId: "sgr-0123456789abcdef0", rule }]],
  deleteFirewallRule: [[{ deploymentId, expectedRevision: 6, ruleId: "sgr-0123456789abcdef0" }]],
  prepareDestroyDeployment: [[{ deploymentId, expectedRevision: 4 }]],
  executeDestroyDeployment: [[{ token: "a".repeat(43) }]],
  openSshWindow: [[{ deploymentId }]],
  approveSshHostKey: [[{ token: "a".repeat(43) }]],
} satisfies InvokeArgumentCases;
const invokeCases = (Object.keys(CLOUD_DEPLOYMENT_IPC_INVOKE) as CloudDeploymentInvokeMethod[])
  .flatMap((method) => invokeArguments[method].map((args, variant) => ({ method, args, variant })));

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: CloudDeploymentAPI) => void>(),
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    send: electronMocks.send,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

await import("./cloud-deployment.js");

describe("Cloud Deployment preload bridge", () => {
  it.each(invokeCases)("preserves $method arguments, replies, and rejections (case $variant)", async ({ method, args }) => {
    const api = exposedApi();
    const channel = CLOUD_DEPLOYMENT_IPC_INVOKE[method];
    const reply = { ok: true, value: { method } };
    electronMocks.invoke.mockClear();
    electronMocks.invoke.mockResolvedValueOnce(reply);
    await expect(Reflect.apply(api[method], api, args)).resolves.toBe(reply);
    expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(channel, ...args);

    const failure = new Error(`Main rejected ${method}`);
    electronMocks.invoke.mockClear();
    electronMocks.invoke.mockRejectedValueOnce(failure);
    await expect(Reflect.apply(api[method], api, args)).rejects.toBe(failure);
    expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(channel, ...args);
  });

  it("accepts only credential-free login progress and removes its listener", () => {
    const api = exposedApi();
    const listener = vi.fn();
    const unsubscribe = api.onAwsLoginProgress!(listener);
    const registration = eventRegistration(CLOUD_DEPLOYMENT_IPC_EVENTS.awsLoginProgress);
    const handler = registration[1] as (_event: unknown, ...payload: unknown[]) => void;
    handler({}, { phase: "waiting-for-authorization" });
    handler({}, null);
    for (const payload of [
      [], [undefined], [{ phase: "unknown" }], [{ phase: "opening-browser", url: "https://example.test/?code=secret" }],
      [{ phase: "opening-browser", token: "secret" }], [{ phase: "exchanging-authorization" }, "extra"], [["opening-browser"]],
    ]) handler({}, ...payload);
    expect(listener.mock.calls).toEqual([[{ phase: "waiting-for-authorization" }], [null]]);
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(CLOUD_DEPLOYMENT_IPC_EVENTS.awsLoginProgress, handler);
  });

  it("passes through only bounded typed software install progress from main", () => {
    const api = exposedApi();
    const listener = vi.fn();
    const unsubscribe = api.onSoftwareInstallProgress(listener);
    const handler = eventRegistration(CLOUD_DEPLOYMENT_IPC_EVENTS.softwareInstallProgress)[1] as
      (_event: unknown, ...payload: unknown[]) => void;
    const deploymentId = "22222222-2222-4222-8222-222222222222";
    const chunk = new Uint8Array([65, 66]);
    handler({}, { deploymentId, step: "ssh", status: "running", output: { stream: "stdout", chunk } });
    chunk[0] = 90;
    handler({}, { deploymentId, step: "dns", status: "complete", message: "A record ready" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0]?.[0]).toEqual({
      deploymentId, step: "ssh", status: "running", output: { stream: "stdout", chunk: new Uint8Array([65, 66]) },
    });
    expect(listener.mock.calls[1]?.[0]).toEqual({ deploymentId, step: "dns", status: "complete", message: "A record ready" });
    for (const payload of [
      [], [null], [{ deploymentId, step: "unknown", status: "running" }],
      [{ deploymentId, step: "dns", status: "done" }],
      [{ deploymentId, step: "dns", status: "running", token: "secret" }],
      [{ deploymentId: "bad", step: "dns", status: "running" }],
      [{ deploymentId, step: "dns", status: "running", message: "x".repeat(1025) }],
      [{ deploymentId, step: "ssh", status: "running", output: { stream: "combined", chunk: new Uint8Array([65]) } }],
      [{ deploymentId, step: "ssh", status: "running", output: { stream: "stdout", chunk: new Uint8Array(64 * 1024 + 1) } }],
      [{ deploymentId, step: "dns", status: "running" }, "extra"],
    ]) handler({}, ...payload);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(CLOUD_DEPLOYMENT_IPC_EVENTS.softwareInstallProgress, handler);
  });

  it("exposes only the narrow frozen cloud API", () => {
    const api = exposedApi();
    expect(Object.keys(api)).toEqual([
      "getSnapshot",
      "refreshDeployments",
      "copyInstanceId",
      "copyIpAddress",
      "getProvisioningTranscripts",
      "getTerminalRuntime",
      "detectCurrentEgressIpv4",
      "chooseSshPrivateKey",
      "createCredential",
      "openAwsConsole",
      "loginAwsCredential",
      "copyAwsLoginLink",
      "cancelAwsLogin",
      "beginAzureLogin",
      "loginAzureCredential",
      "cancelAzureLogin",
      "deleteCredential",
      "testCredential",
      "copyAwsPermissionsTerraform",
      "discoverAwsOptions",
      "discoverAzureAccounts",
      "discoverAzureOptions",
      "listDnsZones",
      "listDnsRecords",
      "createDnsRecord",
      "updateDnsRecord",
      "deleteDnsRecord",
      "createDeployment",
      "getSoftwareState",
      "getSoftwareInstallProgress",
      "listSoftwareListeners",
      "installLocalRedirector",
      "removeLocalRedirector",
      "renameDeployment",
      "createOperatorConfig",
      "runLifecycleAction",
      "updateFirewall",
      "listFirewallRules",
      "createFirewallRule",
      "updateFirewallRule",
      "deleteFirewallRule",
      "prepareDestroyDeployment",
      "executeDestroyDeployment",
      "openSshWindow",
      "approveSshHostKey",
      "onChanged",
      "onAwsLoginProgress",
      "onSoftwareInstallProgress",
      "onNavigationRequested",
      "onThemeChanged",
    ]);
    expect(Object.isFrozen(api)).toBe(true);

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

  it("validates and replays a navigation request that arrives before subscription", async () => {
    const handler = eventRegistration(CLOUD_DEPLOYMENT_IPC_EVENTS.navigationRequested)[1] as (
      event: unknown,
      ...payload: unknown[]
    ) => void;
    const deploymentId = "22222222-2222-4222-8222-222222222222";
    handler({}, { view: "deployments", deploymentId: "not-a-deployment", action: "stop" });
    handler({}, { view: "deployments", deploymentId, action: "delete" });
    handler({}, { view: "firewall", deploymentId, action: "stop" });
    handler({}, { view: "software", deploymentId, action: "stop" });

    const api = exposedApi();
    const listener = vi.fn();
    handler({}, { view: "deployments", deploymentId, action: "ssh" });
    const unsubscribe = api.onNavigationRequested(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      view: "deployments",
      deploymentId,
      action: "ssh",
    });
    expect(Object.isFrozen(listener.mock.calls[0]?.[0])).toBe(true);

    handler({}, { view: "deployments", deploymentId, action: "stop" });
    expect(listener).toHaveBeenLastCalledWith({ view: "deployments", deploymentId, action: "stop" });

    handler({}, { view: "firewall", deploymentId });
    expect(listener).toHaveBeenLastCalledWith({ view: "firewall", deploymentId });
    handler({}, { view: "software", deploymentId });
    expect(listener).toHaveBeenLastCalledWith({ view: "software", deploymentId });
    expect(Object.isFrozen(listener.mock.calls.at(-1)?.[0])).toBe(true);
    unsubscribe();
  });

  it("replays exact operator navigation requests and rejects extra fields or payloads", async () => {
    const handler = eventRegistration(CLOUD_DEPLOYMENT_IPC_EVENTS.navigationRequested)[1] as (
      event: unknown,
      ...payload: unknown[]
    ) => void;
    const deploymentId = "22222222-2222-4222-8222-222222222222";
    const request = { view: "deployments", deploymentId, action: "operator" };
    const listener = vi.fn();

    handler({}, request);
    handler({}, { ...request, operatorName: "unexpected" });
    const unsubscribe = exposedApi().onNavigationRequested(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith(request);
    expect(Object.isFrozen(listener.mock.calls[0]?.[0])).toBe(true);

    handler({}, { ...request, operatorName: "unexpected" });
    handler({}, { ...request, view: "firewall" });
    handler({}, { ...request, deploymentId: "not-a-deployment" });
    handler({}, request, "extra");
    expect(listener).toHaveBeenCalledOnce();

    const nextRequest = { ...request, deploymentId: "33333333-3333-4333-8333-333333333333" };
    handler({}, nextRequest);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(nextRequest);
    unsubscribe();
  });

  it.each(["reboot", "rename"])("validates and replays a bounded %s navigation request", async (action) => {
    const handler = eventRegistration(CLOUD_DEPLOYMENT_IPC_EVENTS.navigationRequested)[1] as (
      event: unknown,
      ...payload: unknown[]
    ) => void;
    const request = {
      view: "deployments",
      deploymentId: "22222222-2222-4222-8222-222222222222",
      action,
    };
    handler({}, request);
    const listener = vi.fn();
    const unsubscribe = exposedApi().onNavigationRequested(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith(request);
    expect(Object.isFrozen(listener.mock.calls[0]?.[0])).toBe(true);

    handler({}, { ...request, command: "unexpected" });
    handler({}, { ...request, view: "firewall" });
    handler({}, request, "extra");
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("retains an early navigation request across a subscribe-cleanup-resubscribe cycle", async () => {
    const handler = eventRegistration(CLOUD_DEPLOYMENT_IPC_EVENTS.navigationRequested)[1] as (
      event: unknown,
      ...payload: unknown[]
    ) => void;
    const deploymentId = "33333333-3333-4333-8333-333333333333";
    const api = exposedApi();
    const firstListener = vi.fn();
    const secondListener = vi.fn();

    handler({}, { view: "firewall", deploymentId });
    const unsubscribeFirst = api.onNavigationRequested(firstListener);
    unsubscribeFirst();
    api.onNavigationRequested(secondListener);
    await Promise.resolve();

    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalledExactlyOnceWith({ view: "firewall", deploymentId });
  });

  it("does not replay an older buffered request after a newer live request", async () => {
    const handler = eventRegistration(CLOUD_DEPLOYMENT_IPC_EVENTS.navigationRequested)[1] as (
      event: unknown,
      ...payload: unknown[]
    ) => void;
    const firstDeploymentId = "44444444-4444-4444-8444-444444444444";
    const secondDeploymentId = "55555555-5555-4555-8555-555555555555";
    const listener = vi.fn();

    handler({}, { view: "firewall", deploymentId: firstDeploymentId });
    exposedApi().onNavigationRequested(listener);
    handler({}, { view: "deployments", deploymentId: secondDeploymentId, action: "start" });
    await Promise.resolve();

    expect(listener).toHaveBeenCalledExactlyOnceWith({
      view: "deployments",
      deploymentId: secondDeploymentId,
      action: "start",
    });
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
