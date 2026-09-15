// @vitest-environment node

import { EventEmitter } from "node:events";

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
  writeText: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  clipboard: { writeText: electronMocks.writeText },
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
const AWS_AUTHORIZATION_URL = "https://us-west-2.signin.aws.amazon.com/v1/authorize?state=test-state&code_challenge=test-challenge";

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
  electronMocks.writeText.mockReset();
});

afterEach(() => unregisterCloudDeploymentIpcHandlers());

describe("Cloud Deployment IPC boundary", () => {
  it("binds Azure subscription selection to its window until saved or discarded", async () => {
    const selection = { token: PRIVATE_KEY_TOKEN, expiresAt: "2026-09-09T00:00:00.000Z", subscriptions: [] };
    const beginAzureLogin = vi.fn<CloudDeploymentController["beginAzureLogin"]>(async () => ({ ok: true, value: selection }));
    const cancelAzureLogin = vi.fn();
    registerCloudDeploymentIpcHandlers(controllerMock({ beginAzureLogin, cancelAzureLogin }), CLOUD_RENDERER_URL, () => true);
    const owner = invokeEvent(CLOUD_RENDERER_URL, 77);
    const other = invokeEvent(CLOUD_RENDERER_URL, 78);
    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.beginAzureLogin, owner.event, { tenantId: null, clientId: null }))
      .resolves.toEqual({ ok: true, value: selection });
    expect(beginAzureLogin).toHaveBeenCalledWith({ tenantId: null, clientId: null }, expect.any(AbortSignal), 77);
    expect(owner.sender.listenerCount("destroyed")).toBe(1);
    await invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.cancelAzureLogin, other.event);
    expect(cancelAzureLogin).not.toHaveBeenCalledWith(77);
    owner.sender.emit("did-start-navigation", { isMainFrame: false });
    expect(cancelAzureLogin).not.toHaveBeenCalledWith(77);
    owner.sender.emit("did-start-navigation", { isMainFrame: true });
    expect(cancelAzureLogin).toHaveBeenCalledWith(77);
    expect(owner.sender.listenerCount("destroyed")).toBe(0);
  });

  it("passes only the trusted owner ID when saving an Azure login selection", async () => {
    const beginAzureLogin = vi.fn<CloudDeploymentController["beginAzureLogin"]>(async () => ({
      ok: true, value: { token: PRIVATE_KEY_TOKEN, expiresAt: "2026-09-09T00:00:00.000Z", subscriptions: [] },
    }));
    const createCredential = vi.fn<CloudDeploymentController["createCredential"]>(async () => ({ ok: false, error: "selection probe" }));
    const cancelAzureLogin = vi.fn();
    registerCloudDeploymentIpcHandlers(controllerMock({ beginAzureLogin, createCredential, cancelAzureLogin }), CLOUD_RENDERER_URL, authorizeCurrentWindow);
    const owner = invokeEvent(CLOUD_RENDERER_URL, 77);
    await invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.beginAzureLogin, owner.event, { tenantId: null, clientId: null });
    const input = { provider: "azure", authentication: "login", label: "Browser Azure", defaultLocation: "eastus",
      sshUsername: "azureuser", sshPrivateKeyToken: null, sshPassphrase: null, loginToken: PRIVATE_KEY_TOKEN,
      subscriptionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", tenantId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" };
    const expected = { ...input };
    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.createCredential, owner.event, input))
      .resolves.toEqual({ ok: false, error: "selection probe" });
    expect(createCredential).toHaveBeenCalledWith(expected, expect.any(AbortSignal), 77);
    expect(cancelAzureLogin).toHaveBeenCalledWith(77);
    expect(owner.sender.listenerCount("destroyed")).toBe(0);
  });

  it("keeps Azure and AWS cancellation separate while rejecting overlapping logins", async () => {
    let signal: AbortSignal | undefined;
    const loginAzureCredential = vi.fn<CloudDeploymentController["loginAzureCredential"]>(async (_input, pendingSignal) => {
      signal = pendingSignal;
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { ok: false, error: "cancelled" };
    });
    const loginAwsCredential = vi.fn<CloudDeploymentController["loginAwsCredential"]>(async () => ({ ok: false, error: "unused" }));
    registerCloudDeploymentIpcHandlers(controllerMock({ loginAzureCredential, loginAwsCredential }), CLOUD_RENDERER_URL, authorizeCurrentWindow);
    const owner = invokeEvent(CLOUD_RENDERER_URL, 77);
    const login = invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.loginAzureCredential, owner.event, { credentialId: CREDENTIAL_ID });
    await invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.cancelAwsLogin, owner.event);
    expect(signal?.aborted).toBe(false);
    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.loginAwsCredential, owner.event, { credentialId: CREDENTIAL_ID }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining("already in progress") });
    expect(loginAwsCredential).not.toHaveBeenCalled();
    await invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.cancelAzureLogin, owner.event);
    await expect(login).resolves.toEqual({ ok: false, error: "cancelled" });
  });

  it("starts native credential creation with only a validated request and revocable signal", async () => {
    const input = {
      provider: "aws" as const, authentication: "login" as const, label: "Browser account",
      defaultRegion: "us-east-1", sshUsername: "ubuntu", sshPrivateKeyToken: null, sshPassphrase: null,
    };
    let loginSignal: AbortSignal | undefined;
    const createCredential = vi.fn<CloudDeploymentController["createCredential"]>(async (parsed, signal, ownerId, onPendingAuthorization) => {
      expect(parsed).toEqual(input);
      expect(ownerId).toBeUndefined();
      onPendingAuthorization?.(AWS_AUTHORIZATION_URL);
      loginSignal = signal;
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { ok: false, error: "cancelled" };
    });
    registerCloudDeploymentIpcHandlers(controllerMock({ createCredential }), CLOUD_RENDERER_URL, authorizeCurrentWindow);
    const owner = invokeEvent(CLOUD_RENDERER_URL, 77);
    const request = invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.createCredential, owner.event, input);
    expect(loginSignal?.aborted).toBe(false);
    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink, owner.event)).resolves.toEqual({ ok: true });
    expect(electronMocks.writeText).toHaveBeenCalledExactlyOnceWith(AWS_AUTHORIZATION_URL);
    owner.sender.emit("did-start-navigation", { isMainFrame: false });
    expect(loginSignal?.aborted).toBe(false);
    owner.sender.emit("did-start-navigation", { isMainFrame: true });
    await expect(request).resolves.toEqual({ ok: false, error: "cancelled" });
    expect(loginSignal?.aborted).toBe(true);
  });

  it("copies only the initiating window's pending AWS link without returning it to the renderer", async () => {
    let releaseLogin!: () => void;
    const gate = new Promise<void>((resolve) => { releaseLogin = resolve; });
    const loginAwsCredential = vi.fn<CloudDeploymentController["loginAwsCredential"]>(async (_input, _signal, publish) => {
      publish?.(AWS_AUTHORIZATION_URL);
      await gate;
      return { ok: false, error: "test completed" };
    });
    const authorize = vi.fn(() => true);
    registerCloudDeploymentIpcHandlers(controllerMock({ loginAwsCredential }), CLOUD_RENDERER_URL, authorize);
    const owner = invokeEvent(CLOUD_RENDERER_URL, 77);
    const other = invokeEvent(CLOUD_RENDERER_URL, 78);
    const login = invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.loginAwsCredential, owner.event, { credentialId: CREDENTIAL_ID });
    try {
      await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink, other.event)).resolves.toMatchObject({ ok: false });
      await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink, owner.event, AWS_AUTHORIZATION_URL)).resolves.toEqual(REJECTED);
      await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink,
        invokeEvent("sliver://app/index.html", 77).event)).resolves.toEqual(REJECTED);
      authorize.mockReturnValue(false);
      await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink, owner.event)).resolves.toEqual(REJECTED);
      expect(electronMocks.writeText).not.toHaveBeenCalled();
      authorize.mockReturnValue(true);
      await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink, owner.event)).resolves.toEqual({ ok: true });
      expect(electronMocks.writeText).toHaveBeenCalledExactlyOnceWith(AWS_AUTHORIZATION_URL);
      electronMocks.writeText.mockImplementationOnce(() => { throw new Error(`PRIVATE_CLIPBOARD_ERROR ${AWS_AUTHORIZATION_URL}`); });
      await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink, owner.event)).resolves.toEqual(REJECTED);
    } finally {
      releaseLogin();
      await login;
    }
    electronMocks.writeText.mockClear();
    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink, owner.event)).resolves.toMatchObject({ ok: false });
    expect(electronMocks.writeText).not.toHaveBeenCalled();
  });

  it("expires the link at authorization and ignores late publications from completed attempts", async () => {
    const publishers: Array<(url: string | null) => void> = [];
    const releases: Array<() => void> = [];
    const loginAwsCredential = vi.fn<CloudDeploymentController["loginAwsCredential"]>(async (_input, _signal, publish) => {
      publishers.push(publish!);
      publish?.(`${AWS_AUTHORIZATION_URL}&attempt=${publishers.length}`);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      return { ok: false, error: "test completed" };
    });
    registerCloudDeploymentIpcHandlers(controllerMock({ loginAwsCredential }), CLOUD_RENDERER_URL, authorizeCurrentWindow);
    const owner = invokeEvent(CLOUD_RENDERER_URL, 77);
    const first = invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.loginAwsCredential, owner.event, { credentialId: CREDENTIAL_ID });
    publishers[0]!(null);
    publishers[0]!(AWS_AUTHORIZATION_URL);
    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink, owner.event)).resolves.toMatchObject({ ok: false });
    expect(electronMocks.writeText).not.toHaveBeenCalled();
    releases[0]!();
    await first;
    const second = invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.loginAwsCredential, owner.event, { credentialId: CREDENTIAL_ID });
    try {
      publishers[0]!(AWS_AUTHORIZATION_URL);
      publishers[0]!(null);
      await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink, owner.event)).resolves.toEqual({ ok: true });
      expect(electronMocks.writeText).toHaveBeenCalledExactlyOnceWith(`${AWS_AUTHORIZATION_URL}&attempt=2`);
    } finally {
      releases[1]!();
      await second;
    }
  });

  it.each(["cancel", "destroyed", "render-process-gone", "did-start-navigation", "unregister"])(
    "immediately revokes copied-link access on %s even if the operation has not settled", async (eventName) => {
      let publish!: (url: string | null) => void;
      let signal!: AbortSignal;
      let releaseLogin!: () => void;
      const gate = new Promise<void>((resolve) => { releaseLogin = resolve; });
      const loginAwsCredential = vi.fn<CloudDeploymentController["loginAwsCredential"]>(async (_input, authSignal, onPendingAuthorization) => {
        publish = onPendingAuthorization!;
        signal = authSignal!;
        publish(AWS_AUTHORIZATION_URL);
        await gate;
        return { ok: false, error: "cancelled" };
      });
      registerCloudDeploymentIpcHandlers(controllerMock({ loginAwsCredential }), CLOUD_RENDERER_URL, authorizeCurrentWindow);
      const owner = invokeEvent(CLOUD_RENDERER_URL, 77);
      const login = invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.loginAwsCredential, owner.event, { credentialId: CREDENTIAL_ID });
      const copyHandler = electronMocks.handlers.get(CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink)!;
      try {
        if (eventName === "cancel") await invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.cancelAwsLogin, owner.event);
        else if (eventName === "unregister") unregisterCloudDeploymentIpcHandlers();
        else owner.sender.emit(eventName, { isMainFrame: true });
        expect(signal.aborted).toBe(true);
        publish(AWS_AUTHORIZATION_URL);
        await expect(copyHandler(owner.event)).resolves.toMatchObject({ ok: false });
        expect(electronMocks.writeText).not.toHaveBeenCalled();
      } finally {
        releaseLogin();
        await login;
      }
    },
  );

  it("does not copy an AWS link during an Azure login", async () => {
    const loginAzureCredential = vi.fn<CloudDeploymentController["loginAzureCredential"]>(async (_input, signal) => {
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { ok: false, error: "cancelled" };
    });
    registerCloudDeploymentIpcHandlers(controllerMock({ loginAzureCredential }), CLOUD_RENDERER_URL, authorizeCurrentWindow);
    const owner = invokeEvent(CLOUD_RENDERER_URL, 77);
    const login = invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.loginAzureCredential, owner.event, { credentialId: CREDENTIAL_ID });
    try {
      await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink, owner.event)).resolves.toMatchObject({ ok: false });
      expect(electronMocks.writeText).not.toHaveBeenCalled();
    } finally {
      await invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.cancelAzureLogin, owner.event);
      await login;
    }
  });

  it("scopes login cancellation to the initiating window and rejects a concurrent flow", async () => {
    let loginSignal: AbortSignal | undefined;
    const loginAwsCredential = vi.fn<CloudDeploymentController["loginAwsCredential"]>(async (_input, signal) => {
      loginSignal = signal;
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { ok: false, error: "AWS login was cancelled." };
    });
    registerCloudDeploymentIpcHandlers(controllerMock({ loginAwsCredential }), CLOUD_RENDERER_URL, () => true);
    const owner = invokeEvent(CLOUD_RENDERER_URL, 77);
    const other = invokeEvent(CLOUD_RENDERER_URL, 78);
    const login = invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.loginAwsCredential, owner.event, { credentialId: CREDENTIAL_ID });
    expect(loginSignal?.aborted).toBe(false);
    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.loginAwsCredential, owner.event, { credentialId: CREDENTIAL_ID }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining("already in progress") });
    await invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.cancelAwsLogin, other.event);
    expect(loginSignal?.aborted).toBe(false);
    await invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.cancelAwsLogin, owner.event);
    await expect(login).resolves.toEqual({ ok: false, error: "AWS login was cancelled." });
    expect(loginSignal?.aborted).toBe(true);
    expect(owner.sender.listenerCount("destroyed")).toBe(0);
    expect(owner.sender.listenerCount("did-start-navigation")).toBe(0);
  });

  it.each(["destroyed", "render-process-gone", "did-start-navigation", "unregister"])(
    "revokes pending login on %s", async (eventName) => {
      const loginAwsCredential = vi.fn<CloudDeploymentController["loginAwsCredential"]>(async (_input, signal) => {
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
        return { ok: false, error: "cancelled" };
      });
      registerCloudDeploymentIpcHandlers(controllerMock({ loginAwsCredential }), CLOUD_RENDERER_URL, authorizeCurrentWindow);
      const owner = invokeEvent(CLOUD_RENDERER_URL, 77);
      const login = invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.loginAwsCredential, owner.event, { credentialId: CREDENTIAL_ID });
      if (eventName === "unregister") unregisterCloudDeploymentIpcHandlers();
      else owner.sender.emit(eventName, { isMainFrame: true });
      await expect(login).resolves.toEqual({ ok: false, error: "cancelled" });
      expect(owner.sender.listenerCount("destroyed")).toBe(0);
    },
  );

  it("does not launch login for an untrusted document", async () => {
    const controller = controllerMock();
    registerCloudDeploymentIpcHandlers(controller, CLOUD_RENDERER_URL, authorizeCurrentWindow);
    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.loginAwsCredential,
      invokeEvent("sliver://app/index.html", 77).event, { credentialId: CREDENTIAL_ID }))
      .resolves.toEqual(REJECTED);
    expect(controller.loginAwsCredential).not.toHaveBeenCalled();
  });

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

  it("refreshes cloud status only from the authorized window without renderer arguments", async () => {
    const response = { ok: true as const, value: { state: { v: 1 as const, revision: 0, deployments: [] }, refreshErrors: [] } };
    const refreshDeployments = vi.fn(async () => response);
    registerCloudDeploymentIpcHandlers(controllerMock({ refreshDeployments }), CLOUD_RENDERER_URL, authorizeCurrentWindow);

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.refreshDeployments,
      invokeEvent("sliver://app/index.html", 77).event)).resolves.toEqual(REJECTED);
    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.refreshDeployments,
      invokeEvent(CLOUD_RENDERER_URL, 77).event, { credentialId: CREDENTIAL_ID })).resolves.toEqual(REJECTED);
    expect(refreshDeployments).not.toHaveBeenCalled();

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.refreshDeployments,
      invokeEvent(CLOUD_RENDERER_URL, 77).event)).resolves.toBe(response);
    expect(refreshDeployments).toHaveBeenCalledExactlyOnceWith();
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
      [CLOUD_DEPLOYMENT_IPC_INVOKE.refreshDeployments, [null]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.getProvisioningTranscripts, [null]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.getTerminalRuntime, ["ghostty-vt.wasm"]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.detectCurrentEgressIpv4, [null]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.chooseSshPrivateKey, [null]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.createCredential, [null]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.loginAwsCredential, [{ credentialId: CREDENTIAL_ID, url: "https://example.test" }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink, [null]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.cancelAwsLogin, [CREDENTIAL_ID]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.beginAzureLogin, [{ tenantId: "https://example.test", clientId: null }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.loginAzureCredential, [{ credentialId: CREDENTIAL_ID, url: "https://example.test" }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.cancelAzureLogin, [CREDENTIAL_ID]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.deleteCredential, [{ credentialId: "not-a-uuid" }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.testCredential, [{ credentialId: CREDENTIAL_ID }, "extra"]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.discoverAwsOptions, [{ credentialId: CREDENTIAL_ID, region: "invalid" }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.discoverAzureAccounts, [null]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.discoverAzureOptions, [{ credentialId: CREDENTIAL_ID, location: "West US 2" }]],
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
        ruleId: "not-a-rule-id-",
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
      expect(await invoke(channel, event, ...args), channel).toEqual(REJECTED);
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

  it("forwards Azure account discovery and validated Azure option discovery", async () => {
    const response = { ok: false as const, error: "Azure inventory probe" };
    const discoverAzureAccounts = vi.fn<CloudDeploymentController["discoverAzureAccounts"]>(
      async () => response,
    );
    const discoverAzureOptions = vi.fn<CloudDeploymentController["discoverAzureOptions"]>(
      async () => response,
    );
    registerCloudDeploymentIpcHandlers(
      controllerMock({ discoverAzureAccounts, discoverAzureOptions }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.discoverAzureAccounts, event))
      .resolves.toBe(response);
    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.discoverAzureOptions, event, {
      credentialId: CREDENTIAL_ID,
      location: "westus2",
    })).resolves.toBe(response);
    expect(discoverAzureAccounts).toHaveBeenCalledExactlyOnceWith();
    expect(discoverAzureOptions).toHaveBeenCalledExactlyOnceWith({
      credentialId: CREDENTIAL_ID,
      location: "westus2",
    });
    expect(Object.isFrozen(discoverAzureOptions.mock.calls[0]?.[0])).toBe(true);
  });

  it("validates and forwards cloud firewall rule operations", async () => {
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
    refreshDeployments: vi.fn(unavailable),
    getProvisioningTranscripts: vi.fn(unavailable),
    getTerminalRuntime: vi.fn(unavailable),
    detectCurrentEgressIpv4: vi.fn(unavailable),
    chooseSshPrivateKey: vi.fn(unavailable),
    createCredential: vi.fn(unavailable),
    loginAwsCredential: vi.fn(unavailable),
    beginAzureLogin: vi.fn(unavailable),
    loginAzureCredential: vi.fn(unavailable),
    cancelAzureLogin: vi.fn(),
    deleteCredential: vi.fn(unavailable),
    testCredential: vi.fn(unavailable),
    discoverAwsOptions: vi.fn(unavailable),
    discoverAzureAccounts: vi.fn(unavailable),
    discoverAzureOptions: vi.fn(unavailable),
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
  const sender = Object.assign(new EventEmitter(), {
    id: contentsId,
    mainFrame,
    getURL: () => url,
    isDestroyed: () => false,
  }) as unknown as WebContents;
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
