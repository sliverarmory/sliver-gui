// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  CLOUD_DEPLOYMENT_IPC_EVENTS,
  CLOUD_DEPLOYMENT_IPC_INVOKE,
  type CloudDeploymentAPI,
} from "../shared/cloud-deployment-ipc.js";
import {
  APPLICATION_CONTEXT_MENU_IPC,
  type ApplicationContextMenuAPI,
} from "../shared/application-context-menu-contracts.js";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: CloudDeploymentAPI) => void>(),
  invoke: vi.fn(async () => ({ ok: true })),
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

const documentAddEventListener = vi.fn();
const documentQuerySelectorAll = vi.fn(() => []);
const mutationObserverCallbacks: Array<(records: readonly Record<string, unknown>[]) => void> = [];
const mutationObserverObserve = vi.fn();
class TestMutationObserver {
  public constructor(callback: (records: readonly Record<string, unknown>[]) => void) {
    mutationObserverCallbacks.push(callback);
  }

  public observe(target: unknown, options: unknown): void {
    mutationObserverObserve(target, options);
  }
}
vi.stubGlobal("MutationObserver", TestMutationObserver);
vi.stubGlobal("document", {
  addEventListener: documentAddEventListener,
  querySelectorAll: documentQuerySelectorAll,
});

await import("./cloud-deployment.js");

describe("Cloud Deployment preload bridge", () => {
  it("exposes only the narrow frozen cloud API and maps every invoke to its fixed channel", async () => {
    const api = exposedApi();
    expect(Object.keys(api)).toEqual([
      "getSnapshot",
      "refreshDeployments",
      "getProvisioningTranscripts",
      "getTerminalRuntime",
      "detectCurrentEgressIpv4",
      "chooseSshPrivateKey",
      "createCredential",
      "loginAwsCredential",
      "cancelAwsLogin",
      "beginAzureLogin",
      "loginAzureCredential",
      "cancelAzureLogin",
      "deleteCredential",
      "testCredential",
      "discoverAwsOptions",
      "discoverAzureAccounts",
      "discoverAzureOptions",
      "createDeployment",
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
      "onNavigationRequested",
      "onThemeChanged",
    ]);
    expect(Object.isFrozen(api)).toBe(true);

    await api.getSnapshot();
    await api.refreshDeployments();
    await api.getProvisioningTranscripts();
    await api.getTerminalRuntime();
    await api.detectCurrentEgressIpv4();
    await api.chooseSshPrivateKey();
    await api.discoverAwsOptions({
      credentialId: "11111111-1111-4111-8111-111111111111",
      region: "us-west-2",
    });
    await api.discoverAzureAccounts();
    await api.discoverAzureOptions({
      credentialId: "11111111-1111-4111-8111-111111111111",
      location: "westus2",
    });
    const deploymentId = "22222222-2222-4222-8222-222222222222";
    const rule = {
      direction: "ingress" as const,
      protocol: "tcp",
      fromPort: 443,
      toPort: 443,
      peerType: "ipv4" as const,
      peer: "203.0.113.0/24",
      description: "HTTPS",
    };
    await api.listFirewallRules({ deploymentId });
    await api.createFirewallRule({ deploymentId, expectedRevision: 4, rule });
    await api.updateFirewallRule({
      deploymentId,
      expectedRevision: 5,
      ruleId: "sgr-0123456789abcdef0",
      rule,
    });
    await api.deleteFirewallRule({
      deploymentId,
      expectedRevision: 6,
      ruleId: "sgr-0123456789abcdef0",
    });
    await api.openSshWindow({ deploymentId });
    await api.approveSshHostKey({ token: "a".repeat(43) });
    expect(electronMocks.invoke.mock.calls.slice(0, 15)).toEqual([
      [CLOUD_DEPLOYMENT_IPC_INVOKE.getSnapshot],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.refreshDeployments],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.getProvisioningTranscripts],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.getTerminalRuntime],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.detectCurrentEgressIpv4],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.chooseSshPrivateKey],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.discoverAwsOptions, {
        credentialId: "11111111-1111-4111-8111-111111111111",
        region: "us-west-2",
      }],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.discoverAzureAccounts],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.discoverAzureOptions, {
        credentialId: "11111111-1111-4111-8111-111111111111",
        location: "westus2",
      }],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.listFirewallRules, { deploymentId }],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.createFirewallRule, {
        deploymentId,
        expectedRevision: 4,
        rule,
      }],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.updateFirewallRule, {
        deploymentId,
        expectedRevision: 5,
        ruleId: "sgr-0123456789abcdef0",
        rule,
      }],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.deleteFirewallRule, {
        deploymentId,
        expectedRevision: 6,
        ruleId: "sgr-0123456789abcdef0",
      }],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.openSshWindow, { deploymentId }],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.approveSshHostKey, { token: "a".repeat(43) }],
    ]);
  });

  it("keeps AWS sign-in and cancellation on fixed credential-scoped channels", async () => {
    const api = exposedApi();
    const input = { credentialId: "11111111-1111-4111-8111-111111111111" };
    await api.loginAwsCredential(input);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(CLOUD_DEPLOYMENT_IPC_INVOKE.loginAwsCredential, input);
    await api.cancelAwsLogin();
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(CLOUD_DEPLOYMENT_IPC_INVOKE.cancelAwsLogin);
  });

  it("exposes only fixed Azure login and subscription-selection channels", async () => {
    const api = exposedApi();
    const input = { tenantId: null, clientId: null };
    await api.beginAzureLogin(input);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(CLOUD_DEPLOYMENT_IPC_INVOKE.beginAzureLogin, input);
    const credential = { credentialId: "11111111-1111-4111-8111-111111111111" };
    await api.loginAzureCredential(credential);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(CLOUD_DEPLOYMENT_IPC_INVOKE.loginAzureCredential, credential);
    await api.cancelAzureLogin();
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(CLOUD_DEPLOYMENT_IPC_INVOKE.cancelAzureLogin);
  });

  it("also exposes the frozen validated application context-menu bridge", async () => {
    const contextMenu = exposedContextMenuApi();
    expect(Object.keys(contextMenu)).toEqual(["onMenuRequested", "executeAction", "setOpen"]);
    expect(Object.isFrozen(contextMenu)).toBe(true);
    const requestId = "00000000-0000-4000-8000-000000000001";
    const actionId = "00000000-0000-4000-8000-000000000002";
    const listener = vi.fn();
    const unsubscribe = contextMenu.onMenuRequested(listener);
    const handler = eventRegistration(APPLICATION_CONTEXT_MENU_IPC.menuRequested)[1] as (
      event: unknown,
      ...payload: unknown[]
    ) => void;
    handler({}, { v: 1, requestId, x: 7, y: 9, items: [{
      type: "action",
      actionId,
      kind: "inspect",
      label: "Inspect Element",
      enabled: true,
    }] });
    handler({}, { v: 1, requestId, x: 7, y: 9, items: [{ type: "separator" }] });
    expect(listener).toHaveBeenCalledOnce();

    electronMocks.invoke.mockClear();
    await contextMenu.executeAction({ requestId, actionId });
    expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(
      APPLICATION_CONTEXT_MENU_IPC.executeAction,
      { requestId, actionId },
    );
    expect(() => contextMenu.executeAction({ requestId, actionId: "inspect" })).toThrow(
      /Invalid application context menu action request/u,
    );

    electronMocks.invoke.mockClear();
    await contextMenu.setOpen({ requestId, open: false });
    expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(
      APPLICATION_CONTEXT_MENU_IPC.setOpen,
      { requestId, open: false },
    );
    expect(() => contextMenu.setOpen({ requestId: "menu", open: true })).toThrow(
      /Invalid application context menu visibility request/u,
    );
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      APPLICATION_CONTEXT_MENU_IPC.menuRequested,
      handler,
    );
  });

  it("sticks restricted classification across attribute removal and descendant moves", () => {
    const registration = documentAddEventListener.mock.calls.find(([type]) => type === "contextmenu");
    if (!registration) throw new Error("Expected the restricted-target capture listener");
    expect(registration[2]).toBe(true);
    expect(mutationObserverObserve).toHaveBeenCalledWith(
      (globalThis as { document?: unknown }).document,
      expect.objectContaining({ attributes: true, childList: true, subtree: true }),
    );
    const handler = registration[1] as (event: { isTrusted: boolean; target: unknown }) => void;
    const observe = mutationObserverCallbacks[0];
    if (!observe) throw new Error("Expected the restricted-target mutation observer");
    let rootPolicy: string | null = "inspect-only";
    const root = {
      childNodes: [] as unknown[],
      getAttribute: () => rootPolicy,
      parentNode: null,
    };
    const textarea = { childNodes: [], parentNode: root as object | null };

    observe([{
      addedNodes: [],
      attributeName: "data-application-context-menu-policy",
      oldValue: null,
      target: root,
      type: "attributes",
    }]);
    root.childNodes.push(textarea);
    observe([{ addedNodes: [textarea], target: root, type: "childList" }]);
    rootPolicy = null;
    textarea.parentNode = {};

    electronMocks.send.mockClear();
    handler({ isTrusted: true, target: root });
    handler({ isTrusted: true, target: textarea });
    handler({ isTrusted: false, target: textarea });
    handler({ isTrusted: true, target: {} });

    expect(electronMocks.send).toHaveBeenCalledTimes(2);
    expect(electronMocks.send).toHaveBeenNthCalledWith(
      1,
      APPLICATION_CONTEXT_MENU_IPC.restrictedTarget,
    );
    expect(electronMocks.send).toHaveBeenNthCalledWith(
      2,
      APPLICATION_CONTEXT_MENU_IPC.restrictedTarget,
    );
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
    handler({}, { view: "deployments", deploymentId, action: "reboot" });
    handler({}, { view: "firewall", deploymentId, action: "stop" });

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

function exposedContextMenuApi(): ApplicationContextMenuAPI {
  const call = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => (
    name === "applicationContextMenu"
  ));
  if (!call) throw new Error("Expected the application context-menu bridge to be installed");
  return call[1] as unknown as ApplicationContextMenuAPI;
}

function eventRegistration(channel: string): unknown[] {
  const call = electronMocks.on.mock.calls.find(([candidate]) => candidate === channel);
  if (!call) throw new Error(`Expected ${channel} to be registered`);
  return call;
}
