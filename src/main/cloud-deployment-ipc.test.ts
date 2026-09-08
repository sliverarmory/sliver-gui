// @vitest-environment node

import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain,
} from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLOUD_DEPLOYMENT_IPC_INVOKE } from "../shared/cloud-deployment-ipc.js";
import {
  registerCloudDeploymentIpcHandlers,
  unregisterCloudDeploymentIpcHandlers,
  type CloudDeploymentController,
} from "./cloud-deployment-ipc.js";

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  fromWebContents: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler,
  },
}));

const CLOUD_RENDERER_URL = "sliver://app/index.html?surface=cloud-deployment";
const CREDENTIAL_ID = "80ae1382-e6e2-44d6-a663-537cafb60e74";
const FIREWALL_RULE_ID = "sgr-0123456789abcdef0";
const PRIVATE_KEY_TOKEN = "939914c7-7b6d-4f35-bcd6-461d7ff3cf81";
const CURRENT_WINDOW = { marker: "current-cloud-window" } as unknown as BrowserWindow;
const OTHER_WINDOW = { marker: "stale-cloud-window" } as unknown as BrowserWindow;
const REJECTED = { ok: false, error: "The Cloud Deployment request was rejected" };

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.handle.mockReset();
  electronMocks.handle.mockImplementation(
    (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    },
  );
  electronMocks.removeHandler.mockReset();
  electronMocks.removeHandler.mockImplementation((channel: string) => {
    electronMocks.handlers.delete(channel);
  });
  electronMocks.fromWebContents.mockReset();
  electronMocks.fromWebContents.mockReturnValue(CURRENT_WINDOW);
});

afterEach(() => unregisterCloudDeploymentIpcHandlers());

describe("Cloud Deployment IPC boundary", () => {
  it("registers and unregisters exactly the isolated Cloud Deployment channels", () => {
    registerCloudDeploymentIpcHandlers(controllerMock(), CLOUD_RENDERER_URL, authorizeCurrentWindow);

    expect([...electronMocks.handlers.keys()].sort()).toEqual(
      Object.values(CLOUD_DEPLOYMENT_IPC_INVOKE).sort(),
    );
    expect(electronMocks.handle).toHaveBeenCalledTimes(
      Object.keys(CLOUD_DEPLOYMENT_IPC_INVOKE).length,
    );

    unregisterCloudDeploymentIpcHandlers();

    expect(electronMocks.handlers.size).toBe(0);
    expect(electronMocks.removeHandler.mock.calls.map(([channel]) => channel).sort()).toEqual(
      Object.values(CLOUD_DEPLOYMENT_IPC_INVOKE).sort(),
    );
  });

  it("accepts only the exact authorized Cloud Deployment main-frame document", async () => {
    const response = { ok: false as const, error: "snapshot probe" };
    const getSnapshot = vi.fn(async () => response);
    const authorizeWindow = vi.fn(authorizeCurrentWindow);
    registerCloudDeploymentIpcHandlers(
      controllerMock({ getSnapshot }),
      CLOUD_RENDERER_URL,
      authorizeWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.getSnapshot, event)).resolves.toBe(response);
    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(authorizeWindow).toHaveBeenCalledExactlyOnceWith(
      {
        contentsId: 77,
        rendererProcessId: 100,
        rendererFrameToken: "main-frame",
      },
      CURRENT_WINDOW,
    );
  });

  it("forwards a no-argument verified terminal runtime request", async () => {
    const response = {
      ok: true as const,
      value: {
        version: "0.4.0" as const,
        sha256: "d6f0326f1874ad2ce9f289e3a4a0c5f3507d4cb38d8747e4b287def470a0c60a",
        bytes: Uint8Array.from([0x00, 0x61, 0x73, 0x6d]),
      },
    };
    const getTerminalRuntime = vi.fn(async () => response);
    registerCloudDeploymentIpcHandlers(
      controllerMock({ getTerminalRuntime }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.getTerminalRuntime, event))
      .resolves.toBe(response);
    expect(getTerminalRuntime).toHaveBeenCalledExactlyOnceWith();
  });

  it("forwards a no-argument provisioning transcript snapshot request", async () => {
    const response = {
      ok: true as const,
      value: { provisioningTranscripts: [] },
    };
    const getProvisioningTranscripts = vi.fn(async () => response);
    registerCloudDeploymentIpcHandlers(
      controllerMock({ getProvisioningTranscripts }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.getProvisioningTranscripts, event))
      .resolves.toBe(response);
    expect(getProvisioningTranscripts).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    ["workspace document", "sliver://app/index.html"],
    ["origin prefix impostor", "sliver://app.evil.test/index.html?surface=cloud-deployment"],
    ["surface query impostor", "sliver://app/index.html?surface=cloud-deployment-extra"],
    ["extra query state", "sliver://app/index.html?surface=cloud-deployment&admin=true"],
  ])("rejects the %s", async (_label, url) => {
    const getSnapshot = vi.fn(async () => ({ ok: false as const, error: "should not run" }));
    registerCloudDeploymentIpcHandlers(
      controllerMock({ getSnapshot }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.getSnapshot, invokeEvent(url, 77).event))
      .resolves.toEqual(REJECTED);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a child frame even when it reports the exact cloud document", async () => {
    const getSnapshot = vi.fn(async () => ({ ok: false as const, error: "should not run" }));
    registerCloudDeploymentIpcHandlers(
      controllerMock({ getSnapshot }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const { event, mainFrame } = invokeEvent(CLOUD_RENDERER_URL, 77);
    Object.defineProperty(event, "senderFrame", {
      value: {
        ...mainFrame,
        frameToken: "child-frame",
      } as WebFrameMain,
    });

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.getSnapshot, event)).resolves.toEqual(REJECTED);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a stale or different BrowserWindow even for the exact document", async () => {
    const getSnapshot = vi.fn(async () => ({ ok: false as const, error: "should not run" }));
    const authorizeWindow = vi.fn(authorizeCurrentWindow);
    registerCloudDeploymentIpcHandlers(
      controllerMock({ getSnapshot }),
      CLOUD_RENDERER_URL,
      authorizeWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);
    electronMocks.fromWebContents.mockReturnValue(OTHER_WINDOW);

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.getSnapshot, event)).resolves.toEqual(REJECTED);
    expect(authorizeWindow).toHaveBeenCalledWith(expect.any(Object), OTHER_WINDOW);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("passes the fixed current BrowserWindow to the native SSH key chooser", async () => {
    const response = {
      ok: true as const,
      value: { token: PRIVATE_KEY_TOKEN, fileName: "id_ed25519" },
    };
    const chooseSshPrivateKey = vi.fn(async (_owner: BrowserWindow) => response);
    registerCloudDeploymentIpcHandlers(
      controllerMock({ chooseSshPrivateKey }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.chooseSshPrivateKey, event))
      .resolves.toBe(response);
    expect(chooseSshPrivateKey).toHaveBeenCalledExactlyOnceWith(CURRENT_WINDOW);
  });

  it("forwards a no-argument current egress IPv4 detection request", async () => {
    const response = {
      ok: true as const,
      value: { address: "203.0.113.42", cidr: "203.0.113.42/32" },
    };
    const detectCurrentEgressIpv4 = vi.fn(async () => response);
    registerCloudDeploymentIpcHandlers(
      controllerMock({ detectCurrentEgressIpv4 }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.detectCurrentEgressIpv4, event))
      .resolves.toBe(response);
    expect(detectCurrentEgressIpv4).toHaveBeenCalledExactlyOnceWith();
  });

  it("rejects unexpected argument counts and malformed inputs before controller dispatch", async () => {
    const controller = controllerMock();
    registerCloudDeploymentIpcHandlers(controller, CLOUD_RENDERER_URL, authorizeCurrentWindow);
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);
    const malformedRequests: ReadonlyArray<readonly [string, readonly unknown[]]> = [
      [CLOUD_DEPLOYMENT_IPC_INVOKE.getSnapshot, [{ unexpected: true }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.getProvisioningTranscripts, [null]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.getTerminalRuntime, ["ghostty-vt.wasm"]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.detectCurrentEgressIpv4, [null]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.chooseSshPrivateKey, [null]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.createCredential, [null]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.deleteCredential, [{ credentialId: "not-a-uuid" }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.testCredential, [{ credentialId: CREDENTIAL_ID }, "extra"]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.discoverAwsOptions, [{ credentialId: CREDENTIAL_ID, region: "invalid" }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.createDeployment, [{}]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.runLifecycleAction, [{
        deploymentId: CREDENTIAL_ID,
        expectedRevision: 0,
        action: "terminate",
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.updateFirewall, [{
        deploymentId: CREDENTIAL_ID,
        expectedRevision: 0,
        sshCidrs: [],
        operatorCidrs: [],
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.listFirewallRules, [{
        deploymentId: CREDENTIAL_ID,
        expectedRevision: 0,
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.createFirewallRule, [{
        deploymentId: CREDENTIAL_ID,
        expectedRevision: 0,
        rule: { ...validFirewallRule(), toPort: 70_000 },
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.updateFirewallRule, [{
        deploymentId: CREDENTIAL_ID,
        expectedRevision: 0,
        ruleId: "not-a-rule-id",
        rule: validFirewallRule(),
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.deleteFirewallRule, [{
        deploymentId: CREDENTIAL_ID,
        expectedRevision: 0,
        ruleId: FIREWALL_RULE_ID,
        unexpected: true,
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.prepareDestroyDeployment, [{
        deploymentId: CREDENTIAL_ID,
        expectedRevision: -1,
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.executeDestroyDeployment, [{ token: "not-a-uuid" }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.openSshWindow, [{ deploymentId: "not-a-uuid" }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.approveSshHostKey, [{ token: "short" }]],
    ];

    for (const [channel, args] of malformedRequests) {
      await expect(invoke(channel, event, ...args)).resolves.toEqual(REJECTED);
    }

    for (const method of Object.values(controller)) expect(method).not.toHaveBeenCalled();
  });

  it("forwards only validated opaque SSH window capabilities", async () => {
    const response = {
      ok: true as const,
      value: { status: "opened" as const, tabId: "t".repeat(43), created: true },
    };
    const open = vi.fn(async () => response);
    const approveHostKey = vi.fn(async () => response);
    registerCloudDeploymentIpcHandlers(
      controllerMock(),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
      { open, approveHostKey },
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.openSshWindow, event, {
      deploymentId: CREDENTIAL_ID,
    })).resolves.toBe(response);
    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.approveSshHostKey, event, {
      token: "r".repeat(43),
    })).resolves.toBe(response);
    expect(open).toHaveBeenCalledExactlyOnceWith(CREDENTIAL_ID);
    expect(approveHostKey).toHaveBeenCalledExactlyOnceWith("r".repeat(43));
  });

  it("validates and forwards AWS option discovery", async () => {
    const response = { ok: false as const, error: "inventory probe" };
    const discoverAwsOptions = vi.fn(async () => response);
    registerCloudDeploymentIpcHandlers(
      controllerMock({ discoverAwsOptions }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.discoverAwsOptions, event, {
      credentialId: CREDENTIAL_ID,
      region: "us-west-2",
    })).resolves.toBe(response);
    expect(discoverAwsOptions).toHaveBeenCalledExactlyOnceWith({
      credentialId: CREDENTIAL_ID,
      region: "us-west-2",
    });
  });

  it("validates and forwards AWS firewall rule operations", async () => {
    const response = { ok: false as const, error: "firewall probe" };
    const listFirewallRules = vi.fn<CloudDeploymentController["listFirewallRules"]>(async () => response);
    const createFirewallRule = vi.fn<CloudDeploymentController["createFirewallRule"]>(async () => response);
    const updateFirewallRule = vi.fn<CloudDeploymentController["updateFirewallRule"]>(async () => response);
    const deleteFirewallRule = vi.fn<CloudDeploymentController["deleteFirewallRule"]>(async () => response);
    registerCloudDeploymentIpcHandlers(
      controllerMock({
        listFirewallRules,
        createFirewallRule,
        updateFirewallRule,
        deleteFirewallRule,
      }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);
    const rule = validFirewallRule();

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.listFirewallRules, event, {
      deploymentId: CREDENTIAL_ID,
    })).resolves.toBe(response);
    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.createFirewallRule, event, {
      deploymentId: CREDENTIAL_ID,
      expectedRevision: 4,
      rule,
    })).resolves.toBe(response);
    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.updateFirewallRule, event, {
      deploymentId: CREDENTIAL_ID,
      expectedRevision: 5,
      ruleId: FIREWALL_RULE_ID,
      rule,
    })).resolves.toBe(response);
    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.deleteFirewallRule, event, {
      deploymentId: CREDENTIAL_ID,
      expectedRevision: 6,
      ruleId: FIREWALL_RULE_ID,
    })).resolves.toBe(response);

    expect(listFirewallRules).toHaveBeenCalledExactlyOnceWith({ deploymentId: CREDENTIAL_ID });
    expect(createFirewallRule).toHaveBeenCalledExactlyOnceWith({
      deploymentId: CREDENTIAL_ID,
      expectedRevision: 4,
      rule,
    });
    expect(updateFirewallRule).toHaveBeenCalledExactlyOnceWith({
      deploymentId: CREDENTIAL_ID,
      expectedRevision: 5,
      ruleId: FIREWALL_RULE_ID,
      rule,
    });
    expect(deleteFirewallRule).toHaveBeenCalledExactlyOnceWith({
      deploymentId: CREDENTIAL_ID,
      expectedRevision: 6,
      ruleId: FIREWALL_RULE_ID,
    });
    for (const call of [
      listFirewallRules.mock.calls[0]?.[0],
      createFirewallRule.mock.calls[0]?.[0],
      updateFirewallRule.mock.calls[0]?.[0],
      deleteFirewallRule.mock.calls[0]?.[0],
    ]) expect(Object.isFrozen(call)).toBe(true);
  });

  it("scrubs mutable credential arguments only after the controller finishes", async () => {
    let releaseController!: () => void;
    const controllerGate = new Promise<void>((resolve) => { releaseController = resolve; });
    let parsedInput: unknown;
    const createCredential = vi.fn(async (input) => {
      parsedInput = input;
      await controllerGate;
      return { ok: false as const, error: "credential probe" };
    });
    registerCloudDeploymentIpcHandlers(
      controllerMock({ createCredential }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const rawCredential = validAwsCredential();
    const pending = invoke(
      CLOUD_DEPLOYMENT_IPC_INVOKE.createCredential,
      invokeEvent(CLOUD_RENDERER_URL, 77).event,
      rawCredential,
    );

    expect(createCredential).toHaveBeenCalledOnce();
    expect(rawCredential.accessKeyId).toBe("AKIA123456789012");
    expect(rawCredential.secretAccessKey).toBe("aws-secret-value");
    expect(Object.isFrozen(parsedInput)).toBe(true);
    expect(parsedInput).not.toBe(rawCredential);

    releaseController();
    await expect(pending).resolves.toEqual({ ok: false, error: "credential probe" });
    expect(rawCredential.accessKeyId).toBe("");
    expect(rawCredential.secretAccessKey).toBe("");
    expect(rawCredential.sessionToken).toBe("");
    expect(rawCredential.sshPassphrase).toBe("");
  });

  it("scrubs every credential-shaped secret even when trust or parsing fails", async () => {
    const createCredential = vi.fn(async () => ({
      ok: true as const,
      value: {
        id: CREDENTIAL_ID,
        provider: "aws" as const,
        label: "Primary AWS",
        persistence: "secure" as const,
        createdAt: "2026-09-06T12:00:00.000Z",
        defaultRegion: "us-east-1",
        sshUsername: "ubuntu",
      },
    }));
    registerCloudDeploymentIpcHandlers(
      controllerMock({ createCredential }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const rawCredential = {
      ...validAwsCredential(),
      tokenId: "root@pam!gui",
      tokenSecret: "proxmox-token-secret",
      tlsCaCertificate: "-----BEGIN CERTIFICATE-----fake-----END CERTIFICATE-----",
      unexpected: true,
    };

    await expect(invoke(
      CLOUD_DEPLOYMENT_IPC_INVOKE.createCredential,
      invokeEvent("sliver://app/index.html", 77).event,
      rawCredential,
    )).resolves.toEqual(REJECTED);

    for (const key of [
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "tokenId",
      "tokenSecret",
      "tlsCaCertificate",
      "sshPassphrase",
    ] as const) expect(rawCredential[key]).toBe("");
    expect(createCredential).not.toHaveBeenCalled();

    const immutableCredential = Object.freeze({
      provider: "aws",
      accessKeyId: "immutable-access-key",
      secretAccessKey: "immutable-secret-key",
    });
    await expect(invoke(
      CLOUD_DEPLOYMENT_IPC_INVOKE.createCredential,
      invokeEvent(CLOUD_RENDERER_URL, 77).event,
      immutableCredential,
    )).resolves.toEqual(REJECTED);
    expect(immutableCredential.accessKeyId).toBe("immutable-access-key");
  });
});

function controllerMock(
  overrides: Partial<CloudDeploymentController> = {},
): CloudDeploymentController {
  const unavailable = vi.fn(async () => ({ ok: false as const, error: "not implemented" }));
  return {
    getSnapshot: vi.fn(unavailable),
    getProvisioningTranscripts: vi.fn(unavailable),
    getTerminalRuntime: vi.fn(unavailable),
    detectCurrentEgressIpv4: vi.fn(unavailable),
    chooseSshPrivateKey: vi.fn(unavailable),
    createCredential: vi.fn(unavailable),
    deleteCredential: vi.fn(unavailable),
    testCredential: vi.fn(unavailable),
    discoverAwsOptions: vi.fn(unavailable),
    createDeployment: vi.fn(unavailable),
    runLifecycleAction: vi.fn(unavailable),
    updateFirewall: vi.fn(unavailable),
    listFirewallRules: vi.fn(unavailable),
    createFirewallRule: vi.fn(unavailable),
    updateFirewallRule: vi.fn(unavailable),
    deleteFirewallRule: vi.fn(unavailable),
    prepareDestroyDeployment: vi.fn(unavailable),
    executeDestroyDeployment: vi.fn(unavailable),
    ...overrides,
  };
}

function authorizeCurrentWindow(
  identity: { contentsId: number; rendererProcessId: number; rendererFrameToken: string },
  window: BrowserWindow,
): boolean {
  return window === CURRENT_WINDOW &&
    identity.contentsId === 77 &&
    identity.rendererProcessId === 100 &&
    identity.rendererFrameToken === "main-frame";
}

function invoke(
  channel: string,
  event: IpcMainInvokeEvent,
  ...args: unknown[]
): Promise<unknown> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`Expected ${channel} to be registered`);
  return Promise.resolve(handler(event, ...args));
}

function invokeEvent(url: string, contentsId: number): {
  event: IpcMainInvokeEvent;
  mainFrame: WebFrameMain;
  sender: WebContents;
} {
  const mainFrame = {
    frameToken: "main-frame",
    processId: 100,
    url,
    isDestroyed: () => false,
  } as WebFrameMain;
  const sender = {
    id: contentsId,
    mainFrame,
    getURL: () => url,
    isDestroyed: () => false,
  } as unknown as WebContents;
  return {
    event: { sender, senderFrame: mainFrame } as IpcMainInvokeEvent,
    mainFrame,
    sender,
  };
}

function validAwsCredential() {
  return {
    provider: "aws" as const,
    label: "Primary AWS",
    defaultRegion: "us-east-1",
    sshUsername: "ubuntu",
    sshPrivateKeyToken: PRIVATE_KEY_TOKEN,
    accessKeyId: "AKIA123456789012",
    secretAccessKey: "aws-secret-value",
    sessionToken: "aws-session-token",
    sshPassphrase: "ssh-passphrase",
  };
}

function validFirewallRule() {
  return {
    direction: "ingress" as const,
    protocol: "tcp",
    fromPort: 8443,
    toPort: 8443,
    peerType: "ipv4" as const,
    peer: "203.0.113.0/24",
    description: "Operator API",
  };
}
