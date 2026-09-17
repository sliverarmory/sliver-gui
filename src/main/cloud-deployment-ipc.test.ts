// @vitest-environment node

import { EventEmitter } from "node:events";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain,
} from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  E2E_AWS_DEPLOYMENT,
  E2E_AZURE_DEPLOYMENT,
} from "../e2e/cloud-deployment-fixture.js";
import {
  CLOUD_DEPLOYMENT_IPC_INVOKE,
  type CloudDeploymentSnapshot,
  type CreateCloudOperatorConfigInput,
} from "../shared/cloud-deployment-ipc.js";
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
  showSaveDialog: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  clipboard: { writeText: electronMocks.writeText },
  dialog: { showSaveDialog: electronMocks.showSaveDialog },
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

function operatorInput(
  operatorName: string,
  overrides: Partial<CreateCloudOperatorConfigInput> = {},
): CreateCloudOperatorConfigInput {
  return {
    deploymentId: CREDENTIAL_ID,
    expectedRevision: 2,
    operatorName,
    publicIp: "203.0.113.80",
    port: 44_331,
    permissions: "all",
    ...overrides,
  };
}

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
  electronMocks.showSaveDialog.mockReset();
  electronMocks.showSaveDialog.mockResolvedValue({ canceled: true });
  electronMocks.writeText.mockReset();
});

afterEach(() => unregisterCloudDeploymentIpcHandlers());

describe("Cloud Deployment IPC boundary", () => {
  it("copies the requested managed AWS instance ID from the current snapshot", async () => {
    const deployment = {
      ...E2E_AWS_DEPLOYMENT,
      id: CREDENTIAL_ID,
      runtime: { ...E2E_AWS_DEPLOYMENT.runtime, instanceId: "i-currentmanagedinstance" },
    };
    const getSnapshot = vi.fn<CloudDeploymentController["getSnapshot"]>(async () => ({
      ok: true,
      value: snapshotWithDeployments([E2E_AWS_DEPLOYMENT, deployment]),
    }));
    registerCloudDeploymentIpcHandlers(controllerMock({ getSnapshot }), CLOUD_RENDERER_URL, authorizeCurrentWindow);

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyInstanceId, invokeEvent(CLOUD_RENDERER_URL, 77).event, {
      deploymentId: CREDENTIAL_ID,
    })).resolves.toEqual({ ok: true });
    expect(getSnapshot).toHaveBeenCalledExactlyOnceWith();
    expect(electronMocks.writeText).toHaveBeenCalledExactlyOnceWith("i-currentmanagedinstance");
  });

  it.each([
    ["missing deployment", []],
    ["pending instance", [{ ...E2E_AWS_DEPLOYMENT, runtime: { ...E2E_AWS_DEPLOYMENT.runtime, instanceId: null } }]],
    ["Azure deployment", [{ ...E2E_AZURE_DEPLOYMENT, id: E2E_AWS_DEPLOYMENT.id }]],
  ] as const)("does not copy an unavailable ID for a %s", async (_label, deployments) => {
    const getSnapshot = vi.fn<CloudDeploymentController["getSnapshot"]>(async () => ({
      ok: true,
      value: snapshotWithDeployments(deployments),
    }));
    registerCloudDeploymentIpcHandlers(controllerMock({ getSnapshot }), CLOUD_RENDERER_URL, authorizeCurrentWindow);

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyInstanceId, invokeEvent(CLOUD_RENDERER_URL, 77).event, {
      deploymentId: E2E_AWS_DEPLOYMENT.id,
    })).resolves.toEqual({ ok: false, error: "No instance ID is available for this deployment." });
    expect(electronMocks.writeText).not.toHaveBeenCalled();
  });

  it.each([
    ["AWS public", E2E_AWS_DEPLOYMENT, "public"],
    ["AWS private", E2E_AWS_DEPLOYMENT, "private"],
    ["Azure public", E2E_AZURE_DEPLOYMENT, "public"],
    ["Azure private", E2E_AZURE_DEPLOYMENT, "private"],
  ] as const)("copies the requested %s IP from the managed snapshot", async (_label, deployment, kind) => {
    const getSnapshot = vi.fn<CloudDeploymentController["getSnapshot"]>(async () => ({
      ok: true,
      value: snapshotWithDeployments([E2E_AWS_DEPLOYMENT, E2E_AZURE_DEPLOYMENT]),
    }));
    registerCloudDeploymentIpcHandlers(controllerMock({ getSnapshot }), CLOUD_RENDERER_URL, authorizeCurrentWindow);

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyIpAddress, invokeEvent(CLOUD_RENDERER_URL, 77).event, {
      deploymentId: deployment.id, kind,
    })).resolves.toEqual({ ok: true });
    const expected = kind === "public" ? deployment.runtime.publicIpAddress : deployment.runtime.privateIpAddress;
    expect(electronMocks.writeText).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each(["public", "private"] as const)("does not copy a missing %s IP or an unknown deployment", async (kind) => {
    const getSnapshot = vi.fn<CloudDeploymentController["getSnapshot"]>(async () => ({
      ok: true,
      value: snapshotWithDeployments([{
        ...E2E_AWS_DEPLOYMENT,
        runtime: { ...E2E_AWS_DEPLOYMENT.runtime, publicIpAddress: null, privateIpAddress: null },
      }]),
    }));
    registerCloudDeploymentIpcHandlers(controllerMock({ getSnapshot }), CLOUD_RENDERER_URL, authorizeCurrentWindow);
    for (const deploymentId of [E2E_AWS_DEPLOYMENT.id, CREDENTIAL_ID]) {
      await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.copyIpAddress, invokeEvent(CLOUD_RENDERER_URL, 77).event, {
        deploymentId, kind,
      })).resolves.toEqual({ ok: false, error: `No ${kind} IP address is available for this deployment.` });
    }
    expect(electronMocks.writeText).not.toHaveBeenCalled();
  });

  it.each([
    [CLOUD_DEPLOYMENT_IPC_INVOKE.copyInstanceId, { deploymentId: E2E_AWS_DEPLOYMENT.id }],
    [CLOUD_DEPLOYMENT_IPC_INVOKE.copyIpAddress, { deploymentId: E2E_AWS_DEPLOYMENT.id, kind: "public" }],
  ])("rejects %s from another surface or revoked window before reading state", async (channel, input) => {
    const getSnapshot = vi.fn<CloudDeploymentController["getSnapshot"]>();
    registerCloudDeploymentIpcHandlers(controllerMock({ getSnapshot }), CLOUD_RENDERER_URL, authorizeCurrentWindow);
    for (const event of [invokeEvent("sliver://app/index.html", 77).event, invokeEvent(CLOUD_RENDERER_URL, 78).event]) {
      await expect(invoke(channel, event, input)).resolves.toEqual(REJECTED);
    }
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(electronMocks.writeText).not.toHaveBeenCalled();
  });

  it.each([
    [CLOUD_DEPLOYMENT_IPC_INVOKE.copyInstanceId, { deploymentId: E2E_AWS_DEPLOYMENT.id }],
    [CLOUD_DEPLOYMENT_IPC_INVOKE.copyIpAddress, { deploymentId: E2E_AWS_DEPLOYMENT.id, kind: "private" }],
  ])("does not dispatch %s when the requesting window is revoked while reading state", async (channel, input) => {
    let resolveSnapshot!: (snapshot: Awaited<ReturnType<CloudDeploymentController["getSnapshot"]>>) => void;
    const getSnapshot = vi.fn<CloudDeploymentController["getSnapshot"]>(() => new Promise((resolve) => {
      resolveSnapshot = resolve;
    }));
    const authorize = vi.fn(authorizeCurrentWindow);
    registerCloudDeploymentIpcHandlers(controllerMock({ getSnapshot }), CLOUD_RENDERER_URL, authorize);
    const pending = invoke(channel, invokeEvent(CLOUD_RENDERER_URL, 77).event, input);
    authorize.mockReturnValue(false);
    resolveSnapshot({ ok: true, value: snapshotWithDeployments([E2E_AWS_DEPLOYMENT]) });

    await expect(pending).resolves.toEqual(REJECTED);
    expect(electronMocks.writeText).not.toHaveBeenCalled();
  });

  it.each([
    [CLOUD_DEPLOYMENT_IPC_INVOKE.copyInstanceId, { deploymentId: E2E_AWS_DEPLOYMENT.id }, "The instance ID could not be loaded."],
    [CLOUD_DEPLOYMENT_IPC_INVOKE.copyIpAddress, { deploymentId: E2E_AWS_DEPLOYMENT.id, kind: "public" }, "The IP address could not be loaded."],
  ])("reports %s failures without returning clipboard contents", async (channel, input, message) => {
    const getSnapshot = vi.fn<CloudDeploymentController["getSnapshot"]>()
      .mockResolvedValueOnce({ ok: false, error: "snapshot unavailable" })
      .mockResolvedValueOnce({ ok: true, value: snapshotWithDeployments([E2E_AWS_DEPLOYMENT]) });
    registerCloudDeploymentIpcHandlers(controllerMock({ getSnapshot }), CLOUD_RENDERER_URL, authorizeCurrentWindow);
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);
    await expect(invoke(channel, event, input))
      .resolves.toEqual({ ok: false, error: message });
    expect(electronMocks.writeText).not.toHaveBeenCalled();
    electronMocks.writeText.mockImplementationOnce(() => { throw new Error("private clipboard failure"); });
    await expect(invoke(channel, event, input)).resolves.toEqual(REJECTED);
  });

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

  it("does not create an operator when the native save dialog is canceled", async () => {
    const generateOperatorConfig = vi.fn<CloudDeploymentController["generateOperatorConfig"]>();
    registerCloudDeploymentIpcHandlers(
      controllerMock({ generateOperatorConfig }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    await expect(invoke(
      CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig,
      event,
      operatorInput("red-team-2"),
    )).resolves.toEqual({
      ok: true,
      value: { saved: false, fileName: "red-team-2.cfg", mutationState: "not-started" },
    });
    expect(electronMocks.showSaveDialog).toHaveBeenCalledExactlyOnceWith(CURRENT_WINDOW, {
      title: "Save red-team-2 operator config",
      defaultPath: "red-team-2.cfg",
      filters: [{ name: "Sliver operator config", extensions: ["cfg"] }],
    });
    expect(generateOperatorConfig).not.toHaveBeenCalled();
  });

  it("keeps save-dialog and controller preflight failures explicitly retryable", async () => {
    const destination = join(tmpdir(), "red-team-preflight.cfg");
    const generateOperatorConfig = vi.fn<CloudDeploymentController["generateOperatorConfig"]>(async () => ({
      ok: false,
      error: "That operator already exists on this managed server",
      mutationState: "not-started",
    }));
    electronMocks.showSaveDialog
      .mockRejectedValueOnce(new Error("dialog unavailable"))
      .mockResolvedValueOnce({ canceled: false, filePath: destination });
    registerCloudDeploymentIpcHandlers(
      controllerMock({ generateOperatorConfig }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);
    const input = operatorInput("red-team-preflight");

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig, event, input)).resolves.toEqual({
      ok: true,
      value: {
        saved: false,
        fileName: "red-team-preflight.cfg",
        mutationState: "not-started",
        error: "The operator configuration save dialog could not be opened",
      },
    });
    expect(generateOperatorConfig).not.toHaveBeenCalled();

    await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig, event, input)).resolves.toEqual({
      ok: true,
      value: {
        saved: false,
        fileName: "red-team-preflight.cfg",
        mutationState: "not-started",
        error: "That operator already exists on this managed server",
      },
    });
    expect(generateOperatorConfig).toHaveBeenCalledExactlyOnceWith(input);
  });

  it("treats an unexpected controller exception as an unknown non-retryable outcome", async () => {
    const destination = join(tmpdir(), "red-team-interrupted.cfg");
    const generateOperatorConfig = vi.fn<CloudDeploymentController["generateOperatorConfig"]>(async () => {
      throw new Error("unexpected controller failure");
    });
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
    registerCloudDeploymentIpcHandlers(
      controllerMock({ generateOperatorConfig }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    await expect(invoke(
      CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig,
      event,
      operatorInput("red-team-interrupted"),
    )).resolves.toEqual({
      ok: true,
      value: {
        saved: false,
        fileName: "red-team-interrupted.cfg",
        mutationState: "unknown",
        error: "The operator request ended without a confirmed server outcome. Do not retry until you reconcile the operator list on the managed server.",
      },
    });
  });

  it("does not disclose a post-mutation recovery result to a revoked renderer", async () => {
    const destination = join(tmpdir(), "red-team-revoked-failure.cfg");
    const authorize = vi.fn(authorizeCurrentWindow);
    const recoveryPath = `/var/lib/sliver-gui/${CREDENTIAL_ID}/operator-export/operator-aaaaaaaaaaaaaaaa.cfg`;
    const generateOperatorConfig = vi.fn<CloudDeploymentController["generateOperatorConfig"]>(async () => {
      authorize.mockReturnValue(false);
      return {
        ok: false,
        error: "The remote handoff failed",
        mutationState: "created",
        remoteRecoveryPath: recoveryPath,
      };
    });
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
    registerCloudDeploymentIpcHandlers(
      controllerMock({ generateOperatorConfig }),
      CLOUD_RENDERER_URL,
      authorize,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    await expect(invoke(
      CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig,
      event,
      operatorInput("red-team-revoked-failure"),
    )).resolves.toEqual(REJECTED);
  });

  it("creates an operator only after file selection and saves a private config without exposing bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sliver-gui-operator-save-"));
    const destination = join(directory, "red-team.cfg");
    const generatedBytes = Buffer.from("operator-config-secret", "utf8");
    const generateOperatorConfig = vi.fn<CloudDeploymentController["generateOperatorConfig"]>(async () => ({
      ok: true,
      value: {
        operatorName: "red-team",
        publicIp: "203.0.113.80",
        port: 44_331,
        permissions: "builder",
        data: generatedBytes,
        remoteRecoveryPath: `/var/lib/sliver-gui/${CREDENTIAL_ID}/operator-export/operator-aaaaaaaaaaaaaaaa.cfg`,
      },
    }));
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
    registerCloudDeploymentIpcHandlers(
      controllerMock({ generateOperatorConfig }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    try {
      const input = operatorInput("red-team", { permissions: "builder" });
      await expect(invoke(CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig, event, input)).resolves.toEqual({
        ok: true,
        value: { saved: true, fileName: "red-team.cfg", mutationState: "created" },
      });
      expect(generateOperatorConfig).toHaveBeenCalledExactlyOnceWith(input);
      expect(await readFile(destination, "utf8")).toBe("operator-config-secret");
      if (process.platform !== "win32") expect((await lstat(destination)).mode & 0o777).toBe(0o600);
      expect(generatedBytes.every((byte) => byte === 0)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves an unknown server mutation outcome and refuses an automatic retry", async () => {
    const destination = join(tmpdir(), "red-team-unknown.cfg");
    const remoteRecoveryCandidatePath =
      `/var/lib/sliver-gui/${CREDENTIAL_ID}/operator-export/operator-bbbbbbbbbbbbbbbb.cfg`;
    const remoteHandoffCandidatePath =
      `/tmp/.sliver-gui-${CREDENTIAL_ID}-cccccccccccccccc.operator.cfg`;
    const generateOperatorConfig = vi.fn<CloudDeploymentController["generateOperatorConfig"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: "The operator command outcome is unknown.",
        mutationState: "unknown",
        remoteRecoveryCandidatePath,
        remoteHandoffCandidatePath,
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "A previous operator attempt must be reconciled.",
        mutationState: "unknown",
      });
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
    registerCloudDeploymentIpcHandlers(
      controllerMock({ generateOperatorConfig }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    await expect(invoke(
      CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig,
      event,
      operatorInput("red-team-unknown"),
    )).resolves.toEqual({
      ok: true,
      value: {
        saved: false,
        fileName: "red-team-unknown.cfg",
        mutationState: "unknown",
        error: `The operator command outcome is unknown. Do not retry until you reconcile the operator list on the managed server. Inspect ${remoteRecoveryCandidatePath} over SSH; it is only a candidate path and the file may not exist. A private temporary handoff may remain at ${remoteHandoffCandidatePath}; remove it over SSH if it still exists.`,
        remoteRecoveryCandidatePath,
        remoteHandoffCandidatePath,
      },
    });

    await expect(invoke(
      CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig,
      event,
      operatorInput("red-team-marker-only"),
    )).resolves.toEqual({
      ok: true,
      value: {
        saved: false,
        fileName: "red-team-marker-only.cfg",
        mutationState: "unknown",
        error: "A previous operator attempt must be reconciled. Do not retry until you reconcile the operator list on the managed server.",
      },
    });
  });

  it("reports a created operator and its recovery path when the local save fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sliver-gui-operator-failed-save-"));
    const destination = join(directory, "missing-parent", "red-team.cfg");
    const generatedBytes = Buffer.from("operator-config-secret", "utf8");
    const remoteRecoveryPath = `/var/lib/sliver-gui/${CREDENTIAL_ID}/operator-export/operator-aaaaaaaaaaaaaaaa.cfg`;
    const generateOperatorConfig = vi.fn<CloudDeploymentController["generateOperatorConfig"]>(async () => ({
      ok: true,
      value: {
        operatorName: "red-team",
        publicIp: "203.0.113.80",
        port: 44_331,
        permissions: "all",
        data: generatedBytes,
        remoteRecoveryPath,
      },
    }));
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
    registerCloudDeploymentIpcHandlers(
      controllerMock({ generateOperatorConfig }),
      CLOUD_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    try {
      await expect(invoke(
        CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig,
        event,
        operatorInput("red-team"),
      )).resolves.toEqual({
        ok: true,
        value: {
          saved: false,
          fileName: "red-team.cfg",
          mutationState: "created",
          error: `The operator was created, but its configuration could not be saved at the selected location. Do not retry creation. Recover the root-only configuration over SSH from ${remoteRecoveryPath}.`,
          remoteRecoveryPath,
        },
      });
      expect(generatedBytes.every((byte) => byte === 0)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("zeroes generated operator bytes when the requesting window is revoked before saving", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sliver-gui-operator-revoked-save-"));
    const destination = join(directory, "red-team.cfg");
    const generatedBytes = Buffer.from("operator-config-secret", "utf8");
    const authorize = vi.fn(authorizeCurrentWindow);
    const generateOperatorConfig = vi.fn<CloudDeploymentController["generateOperatorConfig"]>(async () => {
      authorize.mockReturnValue(false);
      return {
        ok: true,
        value: {
          operatorName: "red-team",
          publicIp: "203.0.113.80",
          port: 44_331,
          permissions: "all",
          data: generatedBytes,
          remoteRecoveryPath: `/var/lib/sliver-gui/${CREDENTIAL_ID}/operator-export/operator-aaaaaaaaaaaaaaaa.cfg`,
        },
      };
    });
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
    registerCloudDeploymentIpcHandlers(
      controllerMock({ generateOperatorConfig }),
      CLOUD_RENDERER_URL,
      authorize,
    );
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);

    try {
      await expect(invoke(
        CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig,
        event,
        operatorInput("red-team"),
      )).resolves.toEqual(REJECTED);
      expect(generatedBytes.every((byte) => byte === 0)).toBe(true);
      await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unexpected argument counts and malformed inputs before controller dispatch", async () => {
    const controller = controllerMock();
    registerCloudDeploymentIpcHandlers(controller, CLOUD_RENDERER_URL, authorizeCurrentWindow);
    const { event } = invokeEvent(CLOUD_RENDERER_URL, 77);
    const malformedRequests: ReadonlyArray<readonly [string, readonly unknown[]]> = [
      [CLOUD_DEPLOYMENT_IPC_INVOKE.getSnapshot, [{ unexpected: true }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.refreshDeployments, [null]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.copyInstanceId, []],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.copyInstanceId, [{ deploymentId: "not-a-uuid" }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.copyInstanceId, [{ deploymentId: CREDENTIAL_ID, instanceId: "arbitrary clipboard content" }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.copyInstanceId, [{ deploymentId: CREDENTIAL_ID }, "extra"]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.copyIpAddress, []],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.copyIpAddress, [{ deploymentId: "invalid", kind: "public" }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.copyIpAddress, [{ deploymentId: CREDENTIAL_ID }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.copyIpAddress, [{ deploymentId: CREDENTIAL_ID, kind: "arbitrary" }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.copyIpAddress, [{ deploymentId: CREDENTIAL_ID, kind: "private", address: "arbitrary clipboard content" }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.copyIpAddress, [{ deploymentId: CREDENTIAL_ID, kind: "public" }, "extra"]],
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
      [CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig, [{
        ...operatorInput("valid-name"),
        operatorName: "not an operator name",
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig, [{
        deploymentId: CREDENTIAL_ID,
        expectedRevision: 1,
        operatorName: "missing-endpoint",
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig, [{
        ...operatorInput("extra-field"),
        unexpected: true,
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig, [{
        ...operatorInput("bad-ip"),
        publicIp: "999.0.0.1",
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig, [{
        ...operatorInput("zero-port"),
        port: 0,
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig, [{
        ...operatorInput("large-port"),
        port: 65_536,
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig, [{
        ...operatorInput("fractional-port"),
        port: 31_337.5,
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig, [{
        ...operatorInput("string-port"),
        port: "31337",
      }]],
      [CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig, [{
        ...operatorInput("bad-permission"),
        permissions: "administrator",
      }]],
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

function snapshotWithDeployments(deployments: CloudDeploymentSnapshot["state"]["deployments"]): CloudDeploymentSnapshot {
  return {
    state: { v: 1, revision: 0, deployments },
    refreshErrors: [],
    credentials: [],
    secureCredentialStorage: true,
    awsProfiles: [],
    awsProfileDiscoveryError: null,
    azureAccounts: [],
    azureAccountDiscoveryError: null,
    provisioningTranscripts: [],
  };
}

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
    generateOperatorConfig: vi.fn(async () => ({
      ok: false as const,
      error: "not implemented",
      mutationState: "not-started" as const,
    })),
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
