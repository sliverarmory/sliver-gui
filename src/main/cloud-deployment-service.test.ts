// @vitest-environment node

import { createHash, generateKeyPairSync } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ssh2 from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AwsConsoleLoginSession,
  AwsFirewallRule,
  AwsFirewallRuleSpec,
  AwsFirewallSnapshot,
  AzureBrowserLoginSession,
  AzureFirewallRule,
  AzureFirewallRuleSpec,
  AzureFirewallSnapshot,
  AzureCliAccountSummary,
  CreateAwsCloudDeploymentInput,
  CreateAzureCloudDeploymentInput,
  ResolvedAwsCloudCredentialInput,
  ResolvedAzureCloudCredentialInput,
} from "../shared/cloud-deployment-contracts.js";
import type { CloudDeploymentChangeScope } from "../shared/cloud-deployment-ipc.js";
import {
  cloudRequiredPermissions,
  createCloudPermissionEvaluation,
} from "../shared/cloud-provider-permissions.js";
import { CloudCredentialVault, type CloudSafeStorageAdapter } from "./cloud-credential-vault.js";
import { CloudDeploymentStore } from "./cloud-deployment-store.js";
import {
  CloudDeploymentService,
  type CloudAwsProvider,
  type CloudAwsConsoleLogin,
  type CloudAwsProfileSource,
  type CloudAzureAccountSource,
  type CloudAzureBrowserLogin,
  type CloudAzureProvider,
  type CloudPrivateKeyCapabilities,
  type CloudSshTerminalStarter,
  type CloudSliverProvisioner,
} from "./cloud-deployment-service.js";
import type { ConsolePortRuntime } from "./console-port-session.js";
import { SshHostKeyStore } from "./ssh-host-key-store.js";
import { SshTerminalStartError } from "./ssh-terminal-runtime.js";
import type { AwsEc2Credentials, AwsEc2DeploymentResource } from "./cloud/aws-ec2-provider.js";
import type { AzureVmDeploymentResource, AzureVmProviderConnection } from "./cloud/azure-vm-provider.js";
import { generateEd25519SshKeyPair } from "./cloud/ssh-key-generator.js";

const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_DEPLOYMENT_ID = "55555555-5555-4555-8555-555555555555";
const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
const MISSING_CREDENTIAL_ID = "66666666-6666-4666-8666-666666666666";
const DESTROY_TOKEN = "33333333-3333-4333-8333-333333333333";
const FIREWALL_RULE_ID = "sgr-0123456789abcdef0";
const AZURE_SUBSCRIPTION_ID = "77777777-7777-4777-8777-777777777777";
const AZURE_TENANT_ID = "88888888-8888-4888-8888-888888888888";
const AZURE_RESOURCE_GROUP = "sliver-gui-test";
const AZURE_RESOURCE_GROUP_ID =
  `/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/${AZURE_RESOURCE_GROUP}`;
const AZURE_NSG_ID =
  `${AZURE_RESOURCE_GROUP_ID}/providers/Microsoft.Network/networkSecurityGroups/sliver-nsg-${DEPLOYMENT_ID}`;
const AZURE_FIREWALL_RULE_ID = `${AZURE_NSG_ID}/securityRules/operator-api`;
const NOW = new Date("2026-09-06T18:00:00.000Z");

let temporaryDirectory = "";
let rootDirectory = "";
let operatorConfigDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-gui-cloud-service-"));
  rootDirectory = join(temporaryDirectory, ".sliver-client", "gui", "cloud-deployment", "v1");
  operatorConfigDirectory = join(temporaryDirectory, ".sliver-client", "configs");
});

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("CloudDeploymentService", () => {
  it("stages native Azure subscriptions and saves only an owner-bound selected credential", async () => {
    const session = azureAuthSession("initial");
    const login = vi.fn(async () => ({ session, subscriptions: [azureAccount()] }));
    const getToken = vi.fn(async () => ({ session, token: "native-arm-token", expiresOnTimestamp: NOW.getTime() + 3_600_000 }));
    const { service, vault, azureAccounts, cliGetToken, connections } = await azureAuthService({ login, getToken });
    const staged = await service.beginAzureLogin({ tenantId: null, clientId: null }, undefined, 42);
    if (!staged.ok) throw new Error(staged.error);
    expect(JSON.stringify(staged)).not.toMatch(/initial-refresh|cache|home-account/u);
    expect(await vault.list()).toEqual([]);
    await expect(service.createCredential(azureNativeInput(staged.value.token), undefined, 99)).resolves.toMatchObject({ ok: false });
    const created = await service.createCredential(azureNativeInput(staged.value.token), undefined, 42);
    expect(created).toMatchObject({ ok: true, value: { authentication: "login", loginAccountId: session.homeAccountId } });
    await expect(service.createCredential(azureNativeInput(staged.value.token), undefined, 42)).resolves.toMatchObject({ ok: false });
    expect(azureAccounts.list).not.toHaveBeenCalled();
    const key = await vault.withCredential(CREDENTIAL_ID, "azure", (secret) => secret.sshPrivateKey);
    await expect(service.testCredential({ credentialId: CREDENTIAL_ID })).resolves.toMatchObject({ ok: true });
    expect(getToken).toHaveBeenCalledOnce();
    expect(cliGetToken).not.toHaveBeenCalled();
    const connection = connections[0];
    if (!connection) throw new Error("Missing credential connection");
    await expect(connection.credential.getToken("https://graph.microsoft.com/.default")).rejects.toThrow(/Resource Manager/u);
    await expect(connection.credential.getToken("https://management.azure.com/.default", { tenantId: AZURE_SUBSCRIPTION_ID })).rejects.toThrow(/different tenant/u);
    expect(getToken).toHaveBeenCalledOnce();
    await expect(service.loginAzureCredential({ credentialId: CREDENTIAL_ID })).resolves.toEqual(created);
    await expect(vault.withCredential(CREDENTIAL_ID, "azure", (secret) => secret.sshPrivateKey)).resolves.toBe(key);
    expect(login).toHaveBeenLastCalledWith(AZURE_TENANT_ID, session.clientId, expect.any(AbortSignal));
    service.dispose();
  });

  it("requires interactive sign-in for native Azure claims challenges while allowing valid CLI tokens", async () => {
    const session = azureAuthSession("cached");
    const getToken = vi.fn(async () => ({ session, token: "cached-native-token", expiresOnTimestamp: NOW.getTime() + 3_600_000 }));
    const { service, vault, connections, cliGetToken } = await azureAuthService({ login: vi.fn(), getToken });
    const input = azureCredential();
    await vault.create({ ...input, secret: { ...input.secret, authentication: "login", loginSession: session } });
    await expect(service.testCredential({ credentialId: CREDENTIAL_ID })).resolves.toMatchObject({ ok: true });
    const connection = connections[0];
    if (!connection) throw new Error("Missing credential connection");
    getToken.mockClear();
    const scopes = "https://management.azure.com/.default";
    const options = { claims: JSON.stringify({ access_token: { nbf: { essential: true } } }) };
    await expect(connection.credential.getToken(scopes, options)).rejects.toMatchObject({
      code: "login-required", message: "Azure requires interactive authentication. Use Azure Login to sign in again.",
    });
    expect(getToken).not.toHaveBeenCalled();
    await vault.delete(CREDENTIAL_ID);
    await vault.create({ ...input, secret: { ...input.secret, loginSession: session } });
    await expect(connection.credential.getToken(scopes, options)).resolves.toMatchObject({ token: "cli-token" });
    expect(cliGetToken).toHaveBeenCalledWith(scopes, options);
    expect(getToken).not.toHaveBeenCalled();
    service.dispose();
  });

  it("expires Azure login selections, cancels staged capabilities, and verifies subscription membership", async () => {
    let now = NOW.getTime();
    const session = azureAuthSession("staged");
    const { service, vault } = await azureAuthService({ login: async () => ({ session, subscriptions: [azureAccount()] }), getToken: vi.fn() }, { now: () => now });
    const first = await service.beginAzureLogin({ tenantId: null, clientId: null }, undefined, 3);
    if (!first.ok) throw new Error(first.error);
    now += 10 * 60_000;
    await expect(service.createCredential(azureNativeInput(first.value.token), undefined, 3)).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/Sign in again/u) });
    const cancelled = await service.beginAzureLogin({ tenantId: null, clientId: null }, undefined, 3);
    if (!cancelled.ok) throw new Error(cancelled.error);
    service.cancelAzureLogin(3);
    await expect(service.createCredential(azureNativeInput(cancelled.value.token), undefined, 3)).resolves.toMatchObject({ ok: false });
    const invalid = await service.beginAzureLogin({ tenantId: null, clientId: null }, undefined, 3);
    if (!invalid.ok) throw new Error(invalid.error);
    await expect(service.createCredential({ ...azureNativeInput(invalid.value.token), subscriptionId: CREDENTIAL_ID }, undefined, 3)).resolves.toMatchObject({ ok: false });
    await expect(service.createCredential(azureNativeInput(invalid.value.token), undefined, 3)).resolves.toMatchObject({ ok: false });
    expect(await vault.list()).toEqual([]);
    service.dispose();
  });

  it("discards a late Azure browser result after owner cancellation", async () => {
    const pending = authDeferred<{ session: AzureBrowserLoginSession; subscriptions: readonly AzureCliAccountSummary[] }>();
    const login = vi.fn(() => pending.promise);
    const { service, vault } = await azureAuthService({ login, getToken: vi.fn() });
    const beginning = service.beginAzureLogin({ tenantId: null, clientId: null }, undefined, 4);
    await vi.waitFor(() => expect(login).toHaveBeenCalledOnce());
    service.cancelAzureLogin(4);
    pending.resolve({ session: azureAuthSession("late"), subscriptions: [azureAccount()] });
    await expect(beginning).resolves.toMatchObject({ ok: false });
    expect(await vault.list()).toEqual([]);
    service.dispose();
  });

  it("prefers a valid Azure CLI token and persists one native cache rotation when CLI access expires", async () => {
    const original = azureAuthSession("old");
    const rotated = azureAuthSession("rotated");
    const getToken = vi.fn(async () => ({ session: rotated, token: "native-token", expiresOnTimestamp: NOW.getTime() + 3_600_000 }));
    const { service, vault, safeStorage, cliGetToken } = await azureAuthService({ login: vi.fn(), getToken });
    const input = azureCredential();
    await vault.create({ ...input, secret: { ...input.secret, loginSession: original } });
    await expect(service.testCredential({ credentialId: CREDENTIAL_ID })).resolves.toMatchObject({ ok: true });
    expect(cliGetToken).toHaveBeenCalledOnce();
    expect(getToken).not.toHaveBeenCalled();
    cliGetToken.mockResolvedValue({ token: "expired-cli-token", expiresOnTimestamp: NOW.getTime() - 1 });
    const results = await Promise.all([service.testCredential({ credentialId: CREDENTIAL_ID }), service.testCredential({ credentialId: CREDENTIAL_ID })]);
    expect(results.every(({ ok }) => ok)).toBe(true);
    expect(getToken).toHaveBeenCalledOnce();
    const reopened = new CloudCredentialVault(rootDirectory, safeStorage);
    await expect(reopened.withCredential(CREDENTIAL_ID, "azure", (secret) => secret.loginSession?.cache)).resolves.toBe(rotated.cache);
    expect((await reopened.list())[0]).not.toHaveProperty("authentication");
    reopened.dispose();
    service.dispose();
  });

  it("binds Azure CLI reauthentication to tenant and subscription, then pins the browser account", async () => {
    const original = azureAuthSession("original");
    const login = vi.fn(async () => ({ session: original, subscriptions: [azureAccount()] }));
    const { service, vault } = await azureAuthService({ login, getToken: vi.fn() });
    await vault.create(azureCredential());
    await expect(service.loginAzureCredential({ credentialId: CREDENTIAL_ID })).resolves.toMatchObject({ ok: true, value: { loginAccountId: original.homeAccountId } });
    expect((await vault.list())[0]).not.toHaveProperty("authentication");
    login.mockResolvedValueOnce({ session: { ...original, homeAccountId: "different-user" }, subscriptions: [azureAccount()] });
    await expect(service.loginAzureCredential({ credentialId: CREDENTIAL_ID })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/different account/u) });
    login.mockResolvedValueOnce({ session: original, subscriptions: [{ ...azureAccount(), subscriptionId: CREDENTIAL_ID }] });
    await expect(service.loginAzureCredential({ credentialId: CREDENTIAL_ID })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/tenant and subscription/u) });
    await expect(vault.withCredential(CREDENTIAL_ID, "azure", (secret) => secret.loginSession?.homeAccountId)).resolves.toBe(original.homeAccountId);
    service.dispose();
  });

  it("rejects stale Azure refresh writes after reauthentication and does not expose cache tokens", async () => {
    const pending = authDeferred<{ session: AzureBrowserLoginSession; token: string; expiresOnTimestamp: number }>();
    const original = azureAuthSession("old");
    const current = azureAuthSession("current");
    const getToken = vi.fn(() => pending.promise);
    const { service, vault } = await azureAuthService({ login: async () => ({ session: current, subscriptions: [azureAccount()] }), getToken });
    const input = azureCredential();
    await vault.create({ ...input, secret: { ...input.secret, authentication: "login", loginSession: original } });
    const testing = service.testCredential({ credentialId: CREDENTIAL_ID });
    await vi.waitFor(() => expect(getToken).toHaveBeenCalledOnce());
    await expect(service.loginAzureCredential({ credentialId: CREDENTIAL_ID })).resolves.toMatchObject({ ok: true });
    pending.resolve({ session: azureAuthSession("stale"), token: "must-not-expose-token", expiresOnTimestamp: NOW.getTime() + 3_600_000 });
    const result = await testing;
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Azure Login/u) });
    expect(JSON.stringify(result)).not.toMatch(/must-not-expose-token|stale-refresh|current-refresh/u);
    await expect(vault.withCredential(CREDENTIAL_ID, "azure", (secret) => secret.loginSession?.cache)).resolves.toBe(current.cache);
    service.dispose();
  });

  it("does not recreate Azure credentials deleted while reauthentication is pending", async () => {
    const pending = authDeferred<{ session: AzureBrowserLoginSession; subscriptions: readonly AzureCliAccountSummary[] }>();
    const login = vi.fn(() => pending.promise);
    const { service, vault } = await azureAuthService({ login, getToken: vi.fn() });
    await vault.create(azureCredential());
    const signingIn = service.loginAzureCredential({ credentialId: CREDENTIAL_ID });
    await vi.waitFor(() => expect(login).toHaveBeenCalledOnce());
    await service.deleteCredential({ credentialId: CREDENTIAL_ID });
    pending.resolve({ session: azureAuthSession("late"), subscriptions: [azureAccount()] });
    await expect(signingIn).resolves.toMatchObject({ ok: false });
    expect(await vault.list()).toEqual([]);
    service.dispose();
  });

  it("creates native AWS Login without CLI profiles and reauthenticates in place", async () => {
    const originalSession = authSession("original");
    const nextSession = authSession("reauthenticated");
    const login = vi.fn().mockResolvedValueOnce(originalSession).mockResolvedValueOnce(nextSession);
    const { service, vault, store, seen } = await authService({ login, refresh: vi.fn() });
    const created = await service.createCredential(nativeAuthInput());
    expect(created).toMatchObject({ ok: true, value: { id: CREDENTIAL_ID, loginSessionArn: originalSession.loginSessionArn } });
    expect(login).toHaveBeenCalledWith("us-west-2", expect.any(AbortSignal));
    expect(JSON.stringify(await service.getSnapshot())).not.toMatch(/original-secret|original-refresh|BEGIN EC PRIVATE KEY/u);
    const sshKey = await vault.withCredential(CREDENTIAL_ID, "aws", (secret) => secret.sshPrivateKey);
    await expect(service.testCredential({ credentialId: CREDENTIAL_ID })).resolves.toMatchObject({ ok: true });
    expect(seen[0]?.secretAccessKey).toBe(originalSession.secretAccessKey);
    const relogged = await service.loginAwsCredential({ credentialId: CREDENTIAL_ID });
    expect(relogged).toEqual(created);
    await expect(vault.withCredential(CREDENTIAL_ID, "aws", (secret) => ({
      key: secret.sshPrivateKey, refresh: "loginSession" in secret ? secret.loginSession?.refreshToken : undefined,
    }))).resolves.toEqual({ key: sshKey, refresh: nextSession.refreshToken });
    expect(store.getState().deployments).toEqual([]);
    service.dispose();
  });

  it("prefers valid CLI credentials and refreshes one encrypted native fallback for concurrent expired-profile requests", async () => {
    let expired = false;
    const fallback = authSession("old", NOW.getTime() - 1);
    const fresh = authSession("fresh");
    const refresh = vi.fn(async () => fresh);
    const profileSource: CloudAwsProfileSource = {
      list: async () => [{ name: "default", region: "us-west-2" }],
      credentialProvider: async () => async () => ({ accessKeyId: "ASIAEXAMPLE00000001", secretAccessKey: "cli-secret",
        expiration: new Date(expired ? NOW.getTime() - 1 : NOW.getTime() + 10_000) }),
      loginSessionArn: async () => fallback.loginSessionArn,
    };
    const { service, vault, safeStorage, seen } = await authService({ login: vi.fn(), refresh }, profileSource);
    await vault.create({ ...awsCredential(), secret: { profileName: "default", loginSession: fallback,
      sshPrivateKey: awsCredential().secret.sshPrivateKey, sshPassphrase: null } });
    await expect(service.testCredential({ credentialId: CREDENTIAL_ID })).resolves.toMatchObject({ ok: true });
    expect(seen.map(({ secretAccessKey }) => secretAccessKey)).toEqual(["cli-secret"]);
    expect(refresh).not.toHaveBeenCalled();
    expired = true;
    const results = await Promise.all([service.testCredential({ credentialId: CREDENTIAL_ID }), service.testCredential({ credentialId: CREDENTIAL_ID })]);
    expect(results.every(({ ok }) => ok)).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    expect(seen.slice(1).map(({ secretAccessKey }) => secretAccessKey)).toEqual([fresh.secretAccessKey, fresh.secretAccessKey]);
    const reopened = new CloudCredentialVault(rootDirectory, safeStorage);
    await expect(reopened.withCredential(CREDENTIAL_ID, "aws", (secret) => "loginSession" in secret ? secret.loginSession?.refreshToken : null)).resolves.toBe(fresh.refreshToken);
    reopened.dispose();
    service.dispose();
  });

  it("binds profile reauthentication to its configured identity and refuses account changes", async () => {
    const expected = authSession("expected");
    const login = vi.fn(async () => ({ ...expected, loginSessionArn: "arn:aws:iam::999999999999:root" }));
    const { service, vault } = await authService({ login, refresh: vi.fn() }, {
      list: async () => [{ name: "default", region: "us-west-2" }],
      credentialProvider: async () => async () => { throw new Error("expired CLI"); },
      loginSessionArn: async () => expected.loginSessionArn,
    });
    await vault.create({ ...awsCredential(), secret: { profileName: "default", sshPrivateKey: awsCredential().secret.sshPrivateKey, sshPassphrase: null } });
    await expect(service.loginAwsCredential({ credentialId: CREDENTIAL_ID })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/different identity/u) });
    expect((await vault.list())[0]).not.toHaveProperty("loginSessionArn");
    service.dispose();
  });

  it("refuses static-key and unbound-profile reauthentication before opening a browser", async () => {
    const login = vi.fn();
    const { service, vault } = await authService({ login, refresh: vi.fn() });
    await vault.create(awsCredential());
    await expect(service.loginAwsCredential({ credentialId: CREDENTIAL_ID })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/Access-key/u) });
    await vault.delete(CREDENTIAL_ID);
    await vault.create({ ...awsCredential(), secret: { profileName: "default", sshPrivateKey: awsCredential().secret.sshPrivateKey, sshPassphrase: null } });
    await expect(service.loginAwsCredential({ credentialId: CREDENTIAL_ID })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/does not contain/u) });
    expect(login).not.toHaveBeenCalled();
    service.dispose();
  });

  it("does not save a cancelled native login or recreate a credential deleted during reauthentication", async () => {
    const pending = authDeferred<AwsConsoleLoginSession>();
    const login = vi.fn(() => pending.promise);
    const { service, vault } = await authService({ login, refresh: vi.fn() });
    const controller = new AbortController();
    const creating = service.createCredential(nativeAuthInput(), controller.signal);
    controller.abort();
    pending.resolve(authSession("cancelled"));
    await expect(creating).resolves.toMatchObject({ ok: false });
    expect(await vault.list()).toEqual([]);
    await vault.create({ ...awsCredential(), secret: { loginSession: authSession("old"), sshPrivateKey: awsCredential().secret.sshPrivateKey, sshPassphrase: null } });
    const relogin = authDeferred<AwsConsoleLoginSession>();
    login.mockImplementation(() => relogin.promise);
    const signingIn = service.loginAwsCredential({ credentialId: CREDENTIAL_ID });
    await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(2));
    await service.deleteCredential({ credentialId: CREDENTIAL_ID });
    relogin.resolve(authSession("deleted"));
    await expect(signingIn).resolves.toMatchObject({ ok: false });
    expect(await vault.list()).toEqual([]);
    service.dispose();
  });

  it("prevents a stale refresh from overwriting a newer browser login and hides refresh errors", async () => {
    const refreshing = authDeferred<AwsConsoleLoginSession>();
    const latest = authSession("latest");
    const refresh = vi.fn(() => refreshing.promise);
    const { service, vault } = await authService({ login: vi.fn(async () => latest), refresh });
    await vault.create({ ...awsCredential(), secret: { loginSession: authSession("old", NOW.getTime() - 1), sshPrivateKey: awsCredential().secret.sshPrivateKey, sshPassphrase: null } });
    const testing = service.testCredential({ credentialId: CREDENTIAL_ID });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await expect(service.loginAwsCredential({ credentialId: CREDENTIAL_ID })).resolves.toMatchObject({ ok: true });
    refreshing.resolve(authSession("stale"));
    await expect(testing).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/AWS Login/u) });
    await expect(vault.withCredential(CREDENTIAL_ID, "aws", (secret) => "loginSession" in secret ? secret.loginSession?.refreshToken : null)).resolves.toBe(latest.refreshToken);
    service.dispose();
  });

  it.each(["provisioning", "deleting"] as const)(
    "marks an interrupted %s transition failed when a new service session starts",
    async (status) => {
      const { store, safeStorage } = await dependencies();
      const created = await store.create(awsDeployment());
      if (!created.ok) throw new Error(created.error);
      if (status === "deleting") {
        const deleting = await store.update({
          expectedRevision: store.getState().revision,
          deployment: { ...created.value.deployment, status: "deleting", phase: "deleting" },
        });
        if (!deleting.ok) throw new Error(deleting.error);
      }

      const service = await CloudDeploymentService.create({
        rootDirectory,
        operatorConfigDirectory,
        safeStorage,
        store,
        provisioner: fakeProvisioner(),
      });

      expect(store.getState().deployments[0]).toMatchObject({
        status: "failed",
        phase: "failed",
        lastError: expect.stringMatching(new RegExp(`${status === "deleting" ? "termination" : "provisioning"} operation was interrupted`, "u")),
      });
      await expect(service.getSnapshot()).resolves.toMatchObject({
        ok: true,
        value: { provisioningTranscripts: [] },
      });
      expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual(store.getState());
      service.dispose();
    },
  );

  it("returns the detected current egress IPv4 CIDR through the main-owned service", async () => {
    const detector = vi.fn(async () => ({
      address: "203.0.113.42",
      cidr: "203.0.113.42/32",
    }));
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      provisioner: fakeProvisioner(),
      egressIpv4Detector: detector,
    });

    const result = await service.detectCurrentEgressIpv4();

    expect(result).toEqual({
      ok: true,
      value: { address: "203.0.113.42", cidr: "203.0.113.42/32" },
    });
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
    expect(detector).toHaveBeenCalledOnce();
  });

  it("returns bounded transcripts without listing credentials or AWS profiles", async () => {
    const { vault } = await dependencies();
    const listCredentials = vi.spyOn(vault, "list");
    const listProfiles = vi.fn(async () => [{ name: "default", region: "us-west-2" }]);
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      vault,
      provisioner: fakeProvisioner(),
      awsProfileSource: {
        list: listProfiles,
        credentialProvider: vi.fn(async () => async () => ({
          accessKeyId: "not-used",
          secretAccessKey: "not-used",
        })),
      },
    });

    const result = service.getProvisioningTranscripts();

    expect(result).toEqual({ ok: true, value: { provisioningTranscripts: [] } });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.provisioningTranscripts)).toBe(true);
    }
    expect(listCredentials).not.toHaveBeenCalled();
    expect(listProfiles).not.toHaveBeenCalled();
    service.dispose();
  });

  it("performs an AWS one-click deployment, lifecycle/firewall management, and confirmed deletion", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    const provisioner = fakeProvisioner();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner,
      awsProviderFactory: () => provider,
      idFactory: () => DESTROY_TOKEN,
      now: () => NOW.getTime(),
    });
    const awsProgress: Array<{
      phase: string;
      status: string;
      instanceState: string;
      instanceHealth: string;
      systemHealth: string;
    }> = [];
    const changeScopes: CloudDeploymentChangeScope[] = [];
    const changed = vi.fn((scope: CloudDeploymentChangeScope) => {
      changeScopes.push(scope);
      const latest = store.getState().deployments[0];
      if (latest?.provider !== "aws") return;
      awsProgress.push({
        phase: latest.phase,
        status: latest.status,
        instanceState: latest.runtime.instanceState,
        instanceHealth: latest.runtime.instanceHealth,
        systemHealth: latest.runtime.systemHealth,
      });
    });
    service.subscribe(changed);

    const created = await service.createDeployment(awsDeployment());
    if (!created.ok) throw new Error(created.error);

    expect(created).toMatchObject({
      ok: true,
      value: {
        id: DEPLOYMENT_ID,
        status: "running",
        phase: "ready",
        remoteHost: "203.0.113.20",
        operatorConfigFileName: `sliver-gui-cloud-${DEPLOYMENT_ID}.cfg`,
        managedAssets: [
          { resourceType: "ec2-instance", resourceId: "i-0123456789abcdef0", tagged: true },
          { resourceType: "ec2-volume", resourceId: "vol-0123456789abcdef0", tagged: true },
          { resourceType: "ec2-network-interface", resourceId: "eni-0123456789abcdef0", tagged: true },
          { resourceType: "ec2-security-group", resourceId: "sg-0123456789abcdef0", tagged: true },
          { resourceType: "ec2-key-pair", resourceId: "key-0123456789abcdef0", tagged: true },
          { resourceType: "ec2-elastic-ip", resourceId: "eipalloc-0123456789abcdef0", tagged: true },
        ],
      },
    });
    expect(provider.create).toHaveBeenCalledWith(
      expect.objectContaining({
        guid: DEPLOYMENT_ID,
        network: {
          mode: "existing",
          vpcId: "vpc-0123456789abcdef0",
          subnetId: "subnet-a0000000000000000",
        },
        sshPublicKey: expect.stringMatching(/^ssh-rsa /u),
      }),
      expect.any(Function),
    );
    expect(provider.create.mock.calls[0]?.[0]).not.toHaveProperty("keyName");
    expect(created.value.provider).toBe("aws");
    if (created.value.provider !== "aws") throw new Error("Expected an AWS deployment");
    expect(created.value.spec.keyPairName).toBe("managed-by-sliver-gui");
    expect(provisioner.provision).toHaveBeenCalledWith(expect.objectContaining({
      deploymentId: DEPLOYMENT_ID,
      operatorEndpointHost: "203.0.113.20",
      ssh: expect.objectContaining({ host: "203.0.113.20", username: "ubuntu" }),
    }));
    expect(awsProgress).toEqual(expect.arrayContaining([
      {
        phase: "starting-instance",
        status: "provisioning",
        instanceState: "pending",
        instanceHealth: "initializing",
        systemHealth: "initializing",
      },
      {
        phase: "waiting-instance-status",
        status: "provisioning",
        instanceState: "running",
        instanceHealth: "initializing",
        systemHealth: "initializing",
      },
      {
        phase: "waiting-system-status",
        status: "provisioning",
        instanceState: "running",
        instanceHealth: "ok",
        systemHealth: "initializing",
      },
      {
        phase: "finalizing-network",
        status: "provisioning",
        instanceState: "running",
        instanceHealth: "ok",
        systemHealth: "ok",
      },
      {
        phase: "installing-sliver",
        status: "provisioning",
        instanceState: "running",
        instanceHealth: "ok",
        systemHealth: "ok",
      },
    ]));
    expect(changeScopes).toContain("snapshot");
    expect(changeScopes).toContain("transcripts");

    const provisioningSnapshot = await service.getSnapshot();
    expect(provisioningSnapshot).toMatchObject({
      ok: true,
      value: {
        provisioningTranscripts: [{
          deploymentId: DEPLOYMENT_ID,
          status: "complete",
          truncated: false,
        }],
      },
    });
    if (!provisioningSnapshot.ok) throw new Error(provisioningSnapshot.error);
    const transcriptText = provisioningSnapshot.value.provisioningTranscripts[0]?.chunks
      .map(({ bytes }) => Buffer.from(bytes).toString("utf8"))
      .join("");
    expect(transcriptText).toContain("==> Installing the Sliver server");
    expect(transcriptText).toContain("sliver-server active");
    expect(await readFile(join(rootDirectory, "state.json"), "utf8")).not.toContain("sliver-server active");

    const filePath = join(operatorConfigDirectory, `sliver-gui-cloud-${DEPLOYMENT_ID}.cfg`);
    const config = await readFile(filePath);
    expect(createHash("sha256").update(config).digest("hex")).toBe(
      created.ok ? created.value.operatorConfigDigest : undefined,
    );
    if (process.platform !== "win32") expect((await lstat(filePath)).mode & 0o777).toBe(0o600);
    const pinnedHostKeys = JSON.parse(
      await readFile(join(rootDirectory, "ssh-host-keys.json"), "utf8"),
    ) as { readonly fingerprints: Readonly<Record<string, string>> };
    expect(pinnedHostKeys.fingerprints[DEPLOYMENT_ID]).toBe(
      "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    if (process.platform !== "win32") {
      expect((await lstat(join(rootDirectory, "ssh-host-keys.json"))).mode & 0o777).toBe(0o600);
    }
    expect(changed).toHaveBeenCalled();

    const stopped = await service.runLifecycleAction({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
      action: "stop",
    });
    expect(stopped).toMatchObject({ ok: true, value: { status: "stopped", phase: "stopped" } });

    const firewall = await service.updateFirewall({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
      sshCidrs: ["192.0.2.44/32"],
      operatorCidrs: ["198.51.100.44/32"],
    });
    expect(firewall).toMatchObject({
      ok: true,
      value: { spec: { sshCidrs: ["192.0.2.44/32"], operatorCidrs: ["198.51.100.44/32"] } },
    });
    if (!firewall.ok) throw new Error(firewall.error);

    const busyDeployment = await store.update({
      expectedRevision: store.getState().revision,
      deployment: { ...firewall.value, status: "provisioning", phase: "installing-sliver" },
    });
    if (!busyDeployment.ok) throw new Error(busyDeployment.error);
    await expect(service.updateFirewall({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
      sshCidrs: ["192.0.2.45/32"],
      operatorCidrs: ["198.51.100.45/32"],
    })).resolves.toEqual({ ok: false, error: "The deployment is busy" });
    expect(provider.replaceFirewall).toHaveBeenCalledTimes(1);
    const restoredDeployment = await store.update({
      expectedRevision: store.getState().revision,
      deployment: { ...busyDeployment.value.deployment, status: "running", phase: "ready" },
    });
    if (!restoredDeployment.ok) throw new Error(restoredDeployment.error);

    const prepared = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    expect(prepared).toMatchObject({ ok: true, value: { token: DESTROY_TOKEN, deploymentId: DEPLOYMENT_ID } });
    const destroyed = await service.executeDestroyDeployment({ token: DESTROY_TOKEN });
    expect(destroyed).toEqual({ ok: true, value: { v: 1, revision: store.getState().revision, deployments: [] } });
    expect(provider.destroy).toHaveBeenCalledOnce();
    expect(provider.destroy).toHaveBeenCalledWith(expect.objectContaining({
      volumeIds: ["vol-0123456789abcdef0"],
      networkInterfaceIds: ["eni-0123456789abcdef0"],
    }));
    await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.getSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { provisioningTranscripts: [] },
    });
    await expect(service.executeDestroyDeployment({ token: DESTROY_TOKEN })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/invalid or expired/u),
    });
    service.dispose();
  });

  it("lists and mutates AWS firewall rules with revision bumps and fresh snapshots", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
    });
    const deployed = await service.createDeployment(awsDeployment());
    if (!deployed.ok) throw new Error(deployed.error);
    const rule = awsFirewallRuleSpec();

    const revisionBeforeList = store.getState().revision;
    await expect(service.listFirewallRules({ deploymentId: DEPLOYMENT_ID })).resolves.toEqual({
      ok: true,
      value: awsFirewallSnapshot(),
    });
    expect(store.getState().revision).toBe(revisionBeforeList);

    const created = await service.createFirewallRule({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
      rule,
    });
    expect(created).toEqual({ ok: true, value: awsFirewallSnapshot() });
    expect(store.getState().revision).toBe(revisionBeforeList + 1);
    expect(provider.createFirewallRule).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ guid: DEPLOYMENT_ID, securityGroupId: "sg-0123456789abcdef0" }),
      rule,
    );

    const updatedRule = { ...rule, toPort: 8444, description: "Operator API range" };
    const revisionBeforeUpdate = store.getState().revision;
    await expect(service.updateFirewallRule({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: revisionBeforeUpdate,
      ruleId: FIREWALL_RULE_ID,
      rule: updatedRule,
    })).resolves.toEqual({ ok: true, value: awsFirewallSnapshot() });
    expect(store.getState().revision).toBe(revisionBeforeUpdate + 1);
    expect(provider.updateFirewallRule).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ guid: DEPLOYMENT_ID }),
      FIREWALL_RULE_ID,
      updatedRule,
    );

    const revisionBeforeDelete = store.getState().revision;
    await expect(service.deleteFirewallRule({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: revisionBeforeDelete,
      ruleId: FIREWALL_RULE_ID,
    })).resolves.toEqual({ ok: true, value: awsFirewallSnapshot() });
    expect(store.getState().revision).toBe(revisionBeforeDelete + 1);
    expect(provider.deleteFirewallRule).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ guid: DEPLOYMENT_ID }),
      FIREWALL_RULE_ID,
    );
    expect(provider.listFirewallRules).toHaveBeenCalledTimes(7);

    provider.createFirewallRule.mockRejectedValueOnce(
      new Error("AWS rejected secret-cloud-value while creating a rule"),
    );
    const beforeFailure = store.getState();
    await expect(service.createFirewallRule({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: beforeFailure.revision,
      rule,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.not.stringContaining("secret-cloud-value"),
    });
    expect(store.getState()).toBe(beforeFailure);
    expect(store.getState().deployments[0]).toMatchObject({ status: "running", phase: "ready" });

    const createCalls = provider.createFirewallRule.mock.calls.length;
    await expect(service.createFirewallRule({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: beforeFailure.revision - 1,
      rule,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/changed in another window/u),
    });
    expect(provider.createFirewallRule).toHaveBeenCalledTimes(createCalls);

    const busy = await store.update({
      expectedRevision: store.getState().revision,
      deployment: { ...deployed.value, status: "provisioning", phase: "installing-sliver" },
    });
    if (!busy.ok) throw new Error(busy.error);
    await expect(service.listFirewallRules({ deploymentId: DEPLOYMENT_ID }))
      .resolves.toEqual({ ok: false, error: "The deployment is busy" });
    await expect(service.deleteFirewallRule({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
      ruleId: FIREWALL_RULE_ID,
    })).resolves.toEqual({ ok: false, error: "The deployment is busy" });
    expect(provider.deleteFirewallRule).toHaveBeenCalledOnce();
    service.dispose();
  });

  it("returns a synthesized AWS firewall snapshot when the post-mutation refresh fails", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
    });
    const deployed = await service.createDeployment(awsDeployment());
    if (!deployed.ok) throw new Error(deployed.error);
    const newSpec = {
      ...awsFirewallRuleSpec(),
      description: "Additional operator API",
    };
    const newRule = awsFirewallRule(newSpec, "sgr-11111111111111111");
    provider.listFirewallRules
      .mockResolvedValueOnce(awsFirewallSnapshot())
      .mockRejectedValueOnce(new Error("transient post-mutation inventory failure"));
    provider.createFirewallRule.mockResolvedValueOnce(newRule);
    const previousRevision = store.getState().revision;

    await expect(service.createFirewallRule({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: previousRevision,
      rule: newSpec,
    })).resolves.toEqual({
      ok: true,
      value: {
        ...awsFirewallSnapshot(),
        rules: [awsFirewallRule(), newRule],
      },
    });
    expect(store.getState().revision).toBe(previousRevision + 1);
    expect(provider.listFirewallRules).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("does not report a completed AWS mutation as failed when the local revision journal fails", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
    });
    const deployed = await service.createDeployment(awsDeployment());
    if (!deployed.ok) throw new Error(deployed.error);
    provider.listFirewallRules
      .mockResolvedValueOnce(awsFirewallSnapshot())
      .mockRejectedValueOnce(new Error("transient post-mutation inventory failure"));
    vi.spyOn(store, "update").mockRejectedValueOnce(new Error("local journal unavailable"));
    const previousRevision = store.getState().revision;

    await expect(service.deleteFirewallRule({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: previousRevision,
      ruleId: FIREWALL_RULE_ID,
    })).resolves.toEqual({
      ok: true,
      value: { ...awsFirewallSnapshot(), rules: [] },
    });
    expect(provider.deleteFirewallRule).toHaveBeenCalledOnce();
    expect(store.getState().revision).toBe(previousRevision);
    service.dispose();
  });

  it("lists and mutates Azure NSG rules with revision bumps and fresh snapshots", async () => {
    const { store, vault } = await dependencies();
    await vault.create(azureCredential());
    const provider = new FakeAzureProvider();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      azureProviderFactory: () => provider,
    });
    const deployed = await service.createDeployment(azureDeployment());
    if (!deployed.ok) throw new Error(deployed.error);
    const rule = azureFirewallRuleSpec();

    const revisionBeforeList = store.getState().revision;
    await expect(service.listFirewallRules({ deploymentId: DEPLOYMENT_ID })).resolves.toEqual({
      ok: true,
      value: azureFirewallSnapshot(),
    });
    expect(store.getState().revision).toBe(revisionBeforeList);

    await expect(service.createFirewallRule({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
      rule,
    })).resolves.toEqual({ ok: true, value: azureFirewallSnapshot() });
    expect(store.getState().revision).toBe(revisionBeforeList + 1);
    expect(provider.createFirewallRule).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ guid: DEPLOYMENT_ID, networkSecurityGroupId: AZURE_NSG_ID }),
      rule,
    );

    const updatedRule = { ...rule, destinationPortRanges: ["8444", "9443"], description: "Operator API range" };
    const revisionBeforeUpdate = store.getState().revision;
    await expect(service.updateFirewallRule({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: revisionBeforeUpdate,
      ruleId: AZURE_FIREWALL_RULE_ID,
      rule: updatedRule,
    })).resolves.toEqual({ ok: true, value: azureFirewallSnapshot() });
    expect(store.getState().revision).toBe(revisionBeforeUpdate + 1);
    expect(provider.updateFirewallRule).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ guid: DEPLOYMENT_ID }),
      "operator-api",
      updatedRule,
    );

    const revisionBeforeDelete = store.getState().revision;
    await expect(service.deleteFirewallRule({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: revisionBeforeDelete,
      ruleId: AZURE_FIREWALL_RULE_ID,
    })).resolves.toEqual({ ok: true, value: azureFirewallSnapshot() });
    expect(store.getState().revision).toBe(revisionBeforeDelete + 1);
    expect(provider.deleteFirewallRule).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ guid: DEPLOYMENT_ID }),
      "operator-api",
    );
    expect(provider.listFirewallRules).toHaveBeenCalledTimes(7);

    const createCalls = provider.createFirewallRule.mock.calls.length;
    await expect(service.createFirewallRule({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: revisionBeforeDelete,
      rule,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/changed in another window/u),
    });
    expect(provider.createFirewallRule).toHaveBeenCalledTimes(createCalls);
    service.dispose();
  });

  it.each([
    { state: "pending" as const, instanceHealth: "ok" as const, systemHealth: "ok" as const },
    { state: "running" as const, instanceHealth: "initializing" as const, systemHealth: "ok" as const },
    { state: "running" as const, instanceHealth: "ok" as const, systemHealth: "initializing" as const },
  ])("refuses SSH provisioning until every EC2 status check passes (%o)", async (health) => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    provider.create.mockResolvedValueOnce({ ...awsResource(), ...health });
    const provisioner = fakeProvisioner();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner,
      awsProviderFactory: () => provider,
    });

    await expect(service.createDeployment(awsDeployment())).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/status checks did not pass; refusing SSH provisioning/u),
    });
    expect(provisioner.provision).not.toHaveBeenCalled();
    expect(store.getState().deployments[0]).toMatchObject({ status: "failed", phase: "failed" });
    service.dispose();
  });

  it("uses the stable private address in the operator profile when Elastic IP is disabled", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    const { elasticIp: _elasticIp, ...withoutElasticIp } = awsResource();
    provider.create.mockResolvedValueOnce(withoutElasticIp);
    const provisioner = fakeProvisioner();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner,
      awsProviderFactory: () => provider,
    });

    const created = await service.createDeployment(awsDeployment(false));

    expect(created).toMatchObject({ ok: true, value: { status: "running" } });
    expect(provisioner.provision).toHaveBeenCalledWith(expect.objectContaining({
      operatorEndpointHost: "10.0.0.20",
      ssh: expect.objectContaining({ host: "203.0.113.20" }),
    }));
    service.dispose();
  });

  it("creates, journals, and destroys a managed AWS network as GUI-owned infrastructure", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    const managedNetwork = {
      vpcId: "vpc-0123456789abcdef0",
      subnetId: "subnet-0123456789abcdef0",
      internetGatewayId: "igw-0123456789abcdef0",
      routeTableId: "rtb-0123456789abcdef0",
      routeTableAssociationId: "rtbassoc-0123456789abcdef0",
    } as const;
    provider.create.mockImplementationOnce(async (_input, onMutation) => {
      const resource = { ...awsResource(), managedNetwork };
      await onMutation?.({ phase: "key-pair", resources: { keyPair: resource.keyPair } });
      await onMutation?.({ phase: "vpc", resources: { keyPair: resource.keyPair, vpcId: managedNetwork.vpcId } });
      await onMutation?.({
        phase: "internet-gateway",
        resources: {
          keyPair: resource.keyPair,
          vpcId: managedNetwork.vpcId,
          internetGatewayId: managedNetwork.internetGatewayId,
        },
      });
      await onMutation?.({
        phase: "subnet",
        resources: {
          keyPair: resource.keyPair,
          vpcId: managedNetwork.vpcId,
          internetGatewayId: managedNetwork.internetGatewayId,
          subnetId: managedNetwork.subnetId,
        },
      });
      await onMutation?.({
        phase: "route-table",
        resources: { keyPair: resource.keyPair, ...managedNetwork },
      });
      return resource;
    });
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
      idFactory: () => DESTROY_TOKEN,
      now: () => NOW.getTime(),
    });
    const request = awsDeployment();
    const created = await service.createDeployment({
      ...request,
      spec: {
        ...request.spec,
        vpcId: null,
        subnetId: null,
        networkMode: "managed",
        managedVpcCidr: "10.42.0.0/16",
        managedSubnetCidr: "10.42.1.0/24",
      },
    });
    if (!created.ok) throw new Error(created.error);

    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({
      network: {
        mode: "managed",
        vpcCidrBlock: "10.42.0.0/16",
        subnetCidrBlock: "10.42.1.0/24",
      },
    }), expect.any(Function));
    expect(created.value).toMatchObject({
      runtime: managedNetwork,
      managedAssets: expect.arrayContaining([
        expect.objectContaining({ resourceType: "ec2-vpc", resourceId: managedNetwork.vpcId, tagged: true }),
        expect.objectContaining({ resourceType: "ec2-subnet", resourceId: managedNetwork.subnetId, tagged: true }),
        expect.objectContaining({ resourceType: "ec2-internet-gateway", resourceId: managedNetwork.internetGatewayId, tagged: true }),
        expect.objectContaining({ resourceType: "ec2-route-table", resourceId: managedNetwork.routeTableId, tagged: true }),
        expect.objectContaining({
          resourceType: "ec2-route-table-association",
          resourceId: managedNetwork.routeTableAssociationId,
          tagged: false,
        }),
      ]),
    });
    const plan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!plan.ok) throw new Error(plan.error);
    await expect(service.executeDestroyDeployment({ token: plan.value.token })).resolves.toMatchObject({ ok: true });
    expect(provider.destroy).toHaveBeenCalledWith(expect.objectContaining({ managedNetwork }));
    service.dispose();
  });

  it("uses but never tracks or destroys an existing key pair that matches the credential key", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    const existingKeyPair = {
      id: "key-0123456789abcdef0",
      name: "operator-existing",
      managed: false,
    } as const;
    provider.create.mockImplementationOnce(async (_input, onMutation) => {
      const resource = { ...awsResource(), keyPair: existingKeyPair };
      await onMutation?.({
        phase: "security-group",
        resources: { keyPair: existingKeyPair, securityGroupId: resource.securityGroupId },
      });
      await onMutation?.({
        phase: "instance",
        resources: {
          keyPair: existingKeyPair,
          securityGroupId: resource.securityGroupId,
          instanceId: resource.instanceId,
        },
      });
      return resource;
    });
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
      idFactory: () => DESTROY_TOKEN,
      now: () => NOW.getTime(),
    });
    const request = awsDeployment();
    const created = await service.createDeployment({
      ...request,
      spec: {
        ...request.spec,
        vpcId: "vpc-0123456789abcdef0",
        subnetId: "subnet-a0000000000000000",
        sshKeyMode: "existing",
        existingKeyPairName: existingKeyPair.name,
        keyPairName: existingKeyPair.name,
      },
    });
    if (!created.ok) throw new Error(created.error);

    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({
      sshKeyPair: { mode: "existing", name: existingKeyPair.name },
    }), expect.any(Function));
    expect(created.value.managedAssets).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: "ec2-key-pair" }),
    ]));
    const plan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!plan.ok) throw new Error(plan.error);
    await expect(service.executeDestroyDeployment({ token: plan.value.token })).resolves.toMatchObject({ ok: true });
    expect(provider.destroy.mock.calls[0]?.[0]).not.toHaveProperty("keyPair");
    service.dispose();
  });

  it("creates and tests a credential without exposing secrets in the snapshot", async () => {
    const store = await CloudDeploymentStore.load(rootDirectory, { idFactory: () => DEPLOYMENT_ID });
    const safeStorage = new XorSafeStorage();
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    const keys = fakePrivateKeys();
    const provider = new FakeAwsProvider();
    const permissionChecker = fakeAwsPermissionChecker();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: keys,
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
      awsPermissionCheckerFactory: () => permissionChecker,
    });

    const created = await service.createCredential({
      provider: "aws",
      label: "Production AWS",
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: "44444444-4444-4444-8444-444444444444",
      accessKeyId: "AKIAEXAMPLE00000001",
      secretAccessKey: "secret-cloud-value",
      sessionToken: null,
      sshPassphrase: null,
    });
    expect(created).toMatchObject({
      ok: true,
      value: { id: CREDENTIAL_ID, provider: "aws", persistence: "secure" },
    });
    expect(keys.consume).toHaveBeenCalledOnce();
    const tested = await service.testCredential({ credentialId: CREDENTIAL_ID });
    expect(tested).toMatchObject({
      ok: true,
      value: {
        provider: "aws",
        summary: expect.stringMatching(/^AWS us-west-2: [0-9]+\/[0-9]+ required IAM permissions verified/u),
        permissions: { missing: [], unverifiable: ["ec2:CreateTags", "ec2:ModifyVpcAttribute", "ec2:ModifySubnetAttribute"] },
      },
    });
    expect(permissionChecker.check).toHaveBeenCalledOnce();
    const snapshot = await service.getSnapshot();
    expect(snapshot).toMatchObject({ ok: true, value: { secureCredentialStorage: true } });
    expect(JSON.stringify(snapshot)).not.toContain("secret-cloud-value");
    expect(await service.deleteCredential({ credentialId: CREDENTIAL_ID })).toEqual({ ok: true });
    service.dispose();
    expect(keys.dispose).toHaveBeenCalledOnce();
  });

  it("returns renderer-safe AWS deployment options for the selected credential and region", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => new FakeAwsProvider(),
    });

    const discovered = await service.discoverAwsOptions({
      credentialId: CREDENTIAL_ID,
      region: "us-west-2",
    });

    expect(discovered).toMatchObject({
      ok: true,
      value: {
        region: "us-west-2",
        instanceTypes: [{ name: "t3.micro", architecture: "x86_64", memoryMiB: 1024 }],
        images: [{ distribution: "ubuntu", sshUsername: "ubuntu" }],
        vpcs: [{ id: "vpc-0123456789abcdef0", isDefault: true }],
        credentialKey: { fingerprint: expect.stringMatching(/^SHA256:/u) },
      },
    });
    expect(JSON.stringify(discovered)).not.toMatch(/PRIVATE KEY|secret-cloud-value/u);
    service.dispose();
  });

  it("returns renderer-safe Azure accounts and deployment options for the selected CLI subscription", async () => {
    const { store, vault } = await dependencies();
    await vault.create(azureCredential());
    const provider = new FakeAzureProvider();
    const azureProviderFactory = vi.fn(() => provider);
    const accounts = [azureAccount()];
    const azureAccountSource = fakeAzureAccountSource(accounts);
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      azureProviderFactory,
      azureAccountSource,
    });

    await expect(service.discoverAzureAccounts()).resolves.toEqual({ ok: true, value: accounts });
    const discovered = await service.discoverAzureOptions({
      credentialId: CREDENTIAL_ID,
      location: "eastus",
    });

    expect(discovered).toEqual({
      ok: true,
      value: {
        location: "eastus",
        vmSizes: [{ name: "Standard_B2s", vCpuCount: 2, memoryMiB: 4_096 }],
        images: [{
          reference: "Canonical:ubuntu-24_04-lts:server:latest",
          label: "Ubuntu Server 24.04 LTS (x64)",
          architecture: "x64",
          sshUsername: "azureuser",
        }],
        virtualNetworks: [],
        subnets: [],
      },
    });
    expect(azureAccountSource.list).toHaveBeenCalledOnce();
    expect(provider.discover).toHaveBeenCalledOnce();
    expect(azureProviderFactory).toHaveBeenCalledExactlyOnceWith({
      subscriptionId: AZURE_SUBSCRIPTION_ID,
      tenantId: AZURE_TENANT_ID,
      location: "eastus",
      credential: expect.objectContaining({ getToken: expect.any(Function) }),
    });
    expect(JSON.stringify(discovered)).not.toMatch(/PRIVATE KEY|secret-cloud-value/u);
    service.dispose();
  });

  it("tests Azure against its effective RBAC actions without a mutation", async () => {
    const { store, vault } = await dependencies();
    await vault.create(azureCredential());
    const provider = new FakeAzureProvider();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      azureProviderFactory: () => provider,
    });

    const tested = await service.testCredential({ credentialId: CREDENTIAL_ID });

    expect(tested).toMatchObject({
      ok: true,
      value: {
        provider: "azure",
        summary: expect.stringMatching(/^Azure eastus: [0-9]+\/[0-9]+ required RBAC actions verified/u),
        permissions: { missing: [], unverifiable: [] },
      },
    });
    expect(provider.checkPermissions).toHaveBeenCalledOnce();
    expect(provider.create).not.toHaveBeenCalled();
    service.dispose();
  });

  it("generates and securely stores an Ed25519 key when no private key is selected", async () => {
    const store = await CloudDeploymentStore.load(rootDirectory, { idFactory: () => DEPLOYMENT_ID });
    const safeStorage = new XorSafeStorage();
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    const keys = fakePrivateKeys();
    const keyGenerator = vi.fn(generateEd25519SshKeyPair);
    const provider = new FakeAwsProvider();
    const provisioner = fakeProvisioner();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: keys,
      sshKeyGenerator: keyGenerator,
      provisioner,
      awsProviderFactory: () => provider,
    });

    const created = await service.createCredential({
      provider: "aws",
      label: "Generated SSH key",
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: null,
      accessKeyId: "AKIAEXAMPLE00000001",
      secretAccessKey: "secret-cloud-value",
      sessionToken: null,
      sshPassphrase: null,
    });

    expect(created).toMatchObject({ ok: true, value: { id: CREDENTIAL_ID, persistence: "secure" } });
    expect(keyGenerator).toHaveBeenCalledOnce();
    expect(keys.consume).not.toHaveBeenCalled();
    await expect(vault.withCredential(CREDENTIAL_ID, "aws", (secret) => ({
      isGeneratedEd25519: secret.sshPrivateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----"),
      passphrase: secret.sshPassphrase,
    }))).resolves.toEqual({ isGeneratedEd25519: true, passphrase: null });
    expect(JSON.stringify(await service.getSnapshot())).not.toMatch(/OPENSSH PRIVATE KEY|secret-cloud-value/u);

    const deployed = await service.createDeployment(awsDeployment());
    expect(deployed).toMatchObject({ ok: true, value: { status: "running" } });
    expect(provider.create).toHaveBeenCalledWith(
      expect.objectContaining({ sshPublicKey: expect.stringMatching(/^ssh-ed25519 /u) }),
      expect.any(Function),
    );
    expect(provisioner.provision).toHaveBeenCalledWith(expect.objectContaining({
      ssh: expect.objectContaining({
        privateKey: expect.stringMatching(/^-----BEGIN OPENSSH PRIVATE KEY-----/u),
      }),
    }));
    service.dispose();
  });

  it("generates an Ed25519 key for an AWS CLI profile without contacting AWS", async () => {
    const store = await CloudDeploymentStore.load(rootDirectory, { idFactory: () => DEPLOYMENT_ID });
    const safeStorage = new XorSafeStorage();
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    const keys = fakePrivateKeys();
    const keyGenerator = vi.fn(generateEd25519SshKeyPair);
    const profileSource: CloudAwsProfileSource = {
      list: vi.fn(async () => [{ name: "generals-network", region: "us-west-2" }]),
      credentialProvider: vi.fn(async () => async () => ({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "must-not-be-resolved",
      })),
    };
    const awsProviderFactory = vi.fn(() => new FakeAwsProvider());
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: keys,
      sshKeyGenerator: keyGenerator,
      provisioner: fakeProvisioner(),
      awsProfileSource: profileSource,
      awsProviderFactory,
    });

    await expect(service.createCredential({
      provider: "aws",
      label: "Generated profile key",
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: null,
      profileName: "generals-network",
      sshPassphrase: null,
    })).resolves.toMatchObject({ ok: true, value: { profileName: "generals-network" } });

    expect(keyGenerator).toHaveBeenCalledOnce();
    expect(keys.consume).not.toHaveBeenCalled();
    expect(profileSource.credentialProvider).not.toHaveBeenCalled();
    expect(awsProviderFactory).not.toHaveBeenCalled();
    await expect(vault.withCredential(CREDENTIAL_ID, "aws", (secret) => ({
      ...inspectStoredSshKey(secret),
      isExpectedProfile: "profileName" in secret && secret.profileName === "generals-network",
    }))).resolves.toEqual({ algorithm: "ssh-ed25519", isPrivate: true, passphrase: null, isExpectedProfile: true });
    service.dispose();
  });

  it("validates an Azure CLI subscription and generates an Ed25519 key without contacting Azure", async () => {
    const store = await CloudDeploymentStore.load(rootDirectory, { idFactory: () => DEPLOYMENT_ID });
    const safeStorage = new XorSafeStorage();
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    const keys = fakePrivateKeys();
    const keyGenerator = vi.fn(generateEd25519SshKeyPair);
    const azureProviderFactory = vi.fn(() => new FakeAzureProvider());
    const azureAccountSource = fakeAzureAccountSource();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: keys,
      sshKeyGenerator: keyGenerator,
      provisioner: fakeProvisioner(),
      azureProviderFactory,
      azureAccountSource,
    });

    await expect(service.createCredential({
      provider: "azure",
      label: "Generated Azure key",
      defaultLocation: "eastus",
      sshUsername: "azureuser",
      sshPrivateKeyToken: null,
      subscriptionId: AZURE_SUBSCRIPTION_ID,
      tenantId: AZURE_TENANT_ID,
      sshPassphrase: null,
    })).resolves.toMatchObject({ ok: true, value: { provider: "azure" } });

    expect(keyGenerator).toHaveBeenCalledOnce();
    expect(keys.consume).not.toHaveBeenCalled();
    expect(azureAccountSource.list).toHaveBeenCalledOnce();
    expect(azureProviderFactory).not.toHaveBeenCalled();
    await expect(vault.withCredential(CREDENTIAL_ID, "azure", inspectStoredSshKey))
      .resolves.toEqual({ algorithm: "ssh-ed25519", isPrivate: true, passphrase: null });
    service.dispose();
  });

  it.each([
    {
      condition: "the subscription disappeared",
      accounts: [] as readonly AzureCliAccountSummary[],
      error: /subscription is no longer available/u,
    },
    {
      condition: "the tenant changed",
      accounts: [{
        ...azureAccount(),
        tenantId: "99999999-9999-4999-8999-999999999999",
      }],
      error: /subscription is no longer available/u,
    },
    {
      condition: "the subscription belongs to a sovereign cloud",
      accounts: [azureAccount("AzureUSGovernment")],
      error: /Only AzureCloud subscriptions are currently supported/u,
    },
  ])("rejects an Azure CLI credential before consuming its SSH key when $condition", async ({ accounts, error }) => {
    const store = await CloudDeploymentStore.load(rootDirectory, { idFactory: () => DEPLOYMENT_ID });
    const safeStorage = new XorSafeStorage();
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    const keys = fakePrivateKeys();
    const keyGenerator = vi.fn(generateEd25519SshKeyPair);
    const azureProviderFactory = vi.fn(() => new FakeAzureProvider());
    const azureAccountSource = fakeAzureAccountSource(accounts);
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: keys,
      sshKeyGenerator: keyGenerator,
      provisioner: fakeProvisioner(),
      azureProviderFactory,
      azureAccountSource,
    });

    await expect(service.createCredential({
      provider: "azure",
      label: "Rejected Azure key",
      defaultLocation: "eastus",
      sshUsername: "azureuser",
      sshPrivateKeyToken: null,
      subscriptionId: AZURE_SUBSCRIPTION_ID,
      tenantId: AZURE_TENANT_ID,
      sshPassphrase: null,
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(error) });

    expect(azureAccountSource.list).toHaveBeenCalledOnce();
    expect(keyGenerator).not.toHaveBeenCalled();
    expect(keys.consume).not.toHaveBeenCalled();
    expect(azureProviderFactory).not.toHaveBeenCalled();
    await expect(vault.list()).resolves.toEqual([]);
    service.dispose();
  });

  it("stores an AWS CLI profile reference and wires its refreshable provider without creating resources", async () => {
    const store = await CloudDeploymentStore.load(rootDirectory, { idFactory: () => DEPLOYMENT_ID });
    const safeStorage = new XorSafeStorage();
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    const keys = fakePrivateKeys();
    const provider = new FakeAwsProvider();
    const resolvedCredentialProvider = vi.fn(async () => ({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "resolved-only-inside-sdk",
    }));
    const profileSource: CloudAwsProfileSource = {
      list: vi.fn(async () => [{ name: "generals-network", region: "us-west-2" }]),
      credentialProvider: vi.fn(async () => resolvedCredentialProvider),
    };
    const awsProviderFactory = vi.fn(() => provider);
    const awsPermissionCheckerFactory = vi.fn(() => fakeAwsPermissionChecker());
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: keys,
      provisioner: fakeProvisioner(),
      awsProfileSource: profileSource,
      awsProviderFactory,
      awsPermissionCheckerFactory,
    });

    const created = await service.createCredential({
      provider: "aws",
      label: "Existing CLI profile",
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: "44444444-4444-4444-8444-444444444444",
      profileName: "generals-network",
      sshPassphrase: null,
    });
    expect(created).toMatchObject({
      ok: true,
      value: { provider: "aws", profileName: "generals-network", defaultRegion: "us-west-2" },
    });
    expect(keys.consume).toHaveBeenCalledOnce();

    const tested = await service.testCredential({ credentialId: CREDENTIAL_ID });
    expect(tested).toMatchObject({ ok: true, value: { provider: "aws" } });
    expect(profileSource.credentialProvider).toHaveBeenCalledWith("generals-network", "us-west-2");
    expect(awsPermissionCheckerFactory).toHaveBeenCalledWith({
      region: "us-west-2",
      credentials: resolvedCredentialProvider,
    });
    expect(awsProviderFactory).not.toHaveBeenCalled();
    expect(resolvedCredentialProvider).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();

    const snapshot = await service.getSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        awsProfiles: [{ name: "generals-network", region: "us-west-2" }],
        awsProfileDiscoveryError: null,
        credentials: [{ profileName: "generals-network" }],
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("resolved-only-inside-sdk");
    service.dispose();
  });

  it("rejects a disappeared AWS CLI profile before consuming the SSH key capability", async () => {
    const store = await CloudDeploymentStore.load(rootDirectory, { idFactory: () => DEPLOYMENT_ID });
    const safeStorage = new XorSafeStorage();
    const keys = fakePrivateKeys();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      privateKeyCapabilities: keys,
      provisioner: fakeProvisioner(),
      awsProfileSource: {
        list: vi.fn(async () => []),
        credentialProvider: vi.fn(async () => async () => ({
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "not-used",
        })),
      },
    });

    await expect(service.createCredential({
      provider: "aws",
      label: "Missing profile",
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: "44444444-4444-4444-8444-444444444444",
      profileName: "missing",
      sshPassphrase: null,
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/no longer available/u) });
    expect(keys.consume).not.toHaveBeenCalled();
    service.dispose();
  });

  it("destroys provider resources before refusing to remove a changed operator configuration", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
      idFactory: () => DESTROY_TOKEN,
      now: () => NOW.getTime(),
    });
    const created = await service.createDeployment(awsDeployment());
    if (!created.ok) throw new Error(created.error);
    const filePath = join(operatorConfigDirectory, `sliver-gui-cloud-${DEPLOYMENT_ID}.cfg`);
    await writeFile(filePath, "user-modified", { mode: 0o600 });
    const prepared = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!prepared.ok) throw new Error(prepared.error);

    const result = await service.executeDestroyDeployment({ token: prepared.value.token });

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/changed after Cloud Deployment/u) });
    expect(provider.destroy).toHaveBeenCalledOnce();
    expect(await readFile(filePath, "utf8")).toBe("user-modified");
    expect(store.getState().deployments[0]).toMatchObject({ status: "failed", phase: "failed" });
    service.dispose();
  });

  it("retains the operator configuration until provider destruction succeeds", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    provider.destroy.mockRejectedValueOnce(new Error("provider teardown failed"));
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
      idFactory: () => DESTROY_TOKEN,
      now: () => NOW.getTime(),
    });
    const created = await service.createDeployment(awsDeployment());
    if (!created.ok) throw new Error(created.error);
    const filePath = join(operatorConfigDirectory, `sliver-gui-cloud-${DEPLOYMENT_ID}.cfg`);
    const firstPlan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!firstPlan.ok) throw new Error(firstPlan.error);

    await expect(service.executeDestroyDeployment({ token: firstPlan.value.token })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/provider teardown failed/u),
    });
    await expect(lstat(filePath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    expect(store.getState().deployments[0]).toMatchObject({
      operatorConfigFileName: `sliver-gui-cloud-${DEPLOYMENT_ID}.cfg`,
      operatorConfigDigest: created.value.operatorConfigDigest,
      status: "failed",
    });

    const retryPlan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!retryPlan.ok) throw new Error(retryPlan.error);
    await expect(service.executeDestroyDeployment({ token: retryPlan.value.token })).resolves.toMatchObject({
      ok: true,
      value: { deployments: [] },
    });
    expect(provider.destroy).toHaveBeenCalledTimes(2);
    await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    service.dispose();
  });

  it("can delete a failed preflight record that never acquired provider resources", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    provider.preflight = vi.fn(async () => { throw new Error("preflight denied"); });
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
      idFactory: () => DESTROY_TOKEN,
      now: () => NOW.getTime(),
    });

    await expect(service.createDeployment(awsDeployment())).resolves.toMatchObject({ ok: false });
    expect(store.getState().deployments[0]).toMatchObject({
      status: "failed",
      managedAssets: [],
      runtime: { instanceId: null, securityGroupIds: [] },
    });
    const plan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!plan.ok) throw new Error(plan.error);

    await expect(service.executeDestroyDeployment({ token: plan.value.token })).resolves.toMatchObject({
      ok: true,
      value: { deployments: [] },
    });
    expect(provider.destroy).not.toHaveBeenCalled();
    service.dispose();
  });

  it("durably journals and can delete an imported AWS key pair after a later create failure", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    provider.create.mockImplementationOnce(async (_input, onMutation) => {
      await onMutation?.({
        phase: "key-pair",
        resources: {
          keyPair: {
            id: "key-0123456789abcdef0",
            name: `sliver-gui-${DEPLOYMENT_ID}`,
          },
        },
      });
      throw new Error("instance launch interrupted");
    });
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
    });

    await expect(service.createDeployment(awsDeployment())).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/instance launch interrupted/u),
    });
    expect(store.getState().deployments[0]).toMatchObject({
      status: "failed",
      managedAssets: [{
        resourceType: "ec2-key-pair",
        resourceId: "key-0123456789abcdef0",
        displayName: `sliver-gui-${DEPLOYMENT_ID}`,
        tagged: true,
      }],
    });
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual(store.getState());
    const plan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!plan.ok) throw new Error(plan.error);

    await expect(service.executeDestroyDeployment({ token: plan.value.token })).resolves.toMatchObject({
      ok: true,
      value: { deployments: [] },
    });
    expect(provider.destroy).toHaveBeenCalledWith({
      guid: DEPLOYMENT_ID,
      name: "Sliver AWS",
      region: "us-west-2",
      keyPair: {
        id: "key-0123456789abcdef0",
        name: `sliver-gui-${DEPLOYMENT_ID}`,
      },
    });
    service.dispose();
  });

  it("durably journals and can delete a partially created managed AWS network", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    provider.create.mockImplementationOnce(async (_input, onMutation) => {
      await onMutation?.({
        phase: "vpc",
        resources: { vpcId: "vpc-0123456789abcdef0" },
      });
      await onMutation?.({
        phase: "internet-gateway",
        resources: {
          vpcId: "vpc-0123456789abcdef0",
          internetGatewayId: "igw-0123456789abcdef0",
        },
      });
      throw new Error("managed subnet creation interrupted");
    });
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
    });
    const request = awsDeployment();

    await expect(service.createDeployment({
      ...request,
      spec: {
        ...request.spec,
        vpcId: null,
        subnetId: null,
        networkMode: "managed",
        managedVpcCidr: "10.42.0.0/16",
        managedSubnetCidr: "10.42.1.0/24",
      },
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/managed subnet creation interrupted/u),
    });
    expect(store.getState().deployments[0]).toMatchObject({
      status: "failed",
      runtime: {
        vpcId: "vpc-0123456789abcdef0",
        internetGatewayId: "igw-0123456789abcdef0",
      },
      managedAssets: expect.arrayContaining([
        expect.objectContaining({ resourceType: "ec2-vpc", resourceId: "vpc-0123456789abcdef0" }),
        expect.objectContaining({
          resourceType: "ec2-internet-gateway",
          resourceId: "igw-0123456789abcdef0",
        }),
      ]),
    });
    const plan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!plan.ok) throw new Error(plan.error);

    await expect(service.executeDestroyDeployment({ token: plan.value.token })).resolves.toMatchObject({ ok: true });
    expect(provider.destroy).toHaveBeenCalledWith({
      guid: DEPLOYMENT_ID,
      name: "Sliver AWS",
      region: "us-west-2",
      managedNetwork: {
        vpcId: "vpc-0123456789abcdef0",
        internetGatewayId: "igw-0123456789abcdef0",
      },
    });
    service.dispose();
  });

  it("never replaces or removes an existing operator configuration on a name collision", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => new FakeAwsProvider(),
    });
    const filePath = join(operatorConfigDirectory, `sliver-gui-cloud-${DEPLOYMENT_ID}.cfg`);
    await mkdir(operatorConfigDirectory, { recursive: true, mode: 0o700 });
    await writeFile(filePath, "user-owned", { mode: 0o600 });

    const created = await service.createDeployment(awsDeployment());

    expect(created).toMatchObject({ ok: false });
    expect(await readFile(filePath, "utf8")).toBe("user-owned");
    expect(store.getState().deployments[0]).toMatchObject({ status: "failed", phase: "failed" });
    service.dispose();
  });

  it("provisions, operates, and destroys a GUID-tagged Azure VM with baseline firewall policy", async () => {
    const { store, vault } = await dependencies();
    await vault.create(azureCredential());
    const provider = new FakeAzureProvider();
    const provisioner = fakeProvisioner();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner,
      azureProviderFactory: () => provider,
      idFactory: () => DESTROY_TOKEN,
      now: () => NOW.getTime(),
    });

    const result = await service.createDeployment(azureDeployment());
    if (!result.ok) throw new Error(result.error);

    expect(result).toMatchObject({
      ok: true,
      value: {
        provider: "azure",
        status: "running",
        phase: "ready",
        remoteHost: "203.0.113.42",
        runtime: {
          resourceGroupName: AZURE_RESOURCE_GROUP,
          vmId: expect.stringContaining("/virtualMachines/"),
          networkSecurityGroupId: AZURE_NSG_ID,
          instanceState: "running",
        },
      },
    });
    expect(result.value.managedAssets).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: "azure-resource-group", tagged: true }),
      expect.objectContaining({ resourceType: "azure-virtual-network", tagged: true }),
      expect.objectContaining({ resourceType: "azure-subnet", tagged: false }),
      expect.objectContaining({ resourceType: "azure-network-security-group", tagged: true }),
      expect.objectContaining({ resourceType: "azure-public-ip", tagged: true }),
      expect.objectContaining({ resourceType: "azure-network-interface", tagged: true }),
      expect.objectContaining({ resourceType: "azure-os-disk", tagged: true }),
      expect.objectContaining({ resourceType: "azure-virtual-machine", tagged: true }),
    ]));
    expect(provider.create).toHaveBeenCalledWith(
      expect.objectContaining({
        guid: DEPLOYMENT_ID,
        name: "Sliver Azure",
        imageReference: "Canonical:ubuntu-24_04-lts:server:latest",
        vmSize: "Standard_B2s",
        network: {
          mode: "managed",
          virtualNetworkCidr: "10.42.0.0/16",
          subnetCidr: "10.42.1.0/24",
        },
        sshPublicKey: expect.stringMatching(/^ssh-rsa /u),
        firewall: {
          sshPort: 22,
          sshSourceCidrs: ["192.0.2.10/32"],
          operatorPort: 31_337,
          operatorSourceCidrs: ["198.51.100.0/24"],
        },
        allocatePublicIp: true,
      }),
      expect.any(Function),
    );
    expect(provisioner.provision).toHaveBeenCalledWith(expect.objectContaining({
      deploymentId: DEPLOYMENT_ID,
      operatorEndpointHost: "203.0.113.42",
      ssh: expect.objectContaining({ host: "203.0.113.42", username: "azureuser" }),
    }));

    const firewallRevision = store.getState().revision;
    await expect(service.updateFirewall({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: firewallRevision,
      sshCidrs: ["192.0.2.45/32"],
      operatorCidrs: ["198.51.100.45/32"],
    })).resolves.toMatchObject({
      ok: true,
      value: {
        provider: "azure",
        spec: {
          sshCidrs: ["192.0.2.45/32"],
          operatorCidrs: ["198.51.100.45/32"],
        },
      },
    });
    expect(provider.replaceFirewall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ guid: DEPLOYMENT_ID, networkSecurityGroupId: AZURE_NSG_ID }),
      {
        sshPort: 22,
        sshSourceCidrs: ["192.0.2.45/32"],
        operatorPort: 31_337,
        operatorSourceCidrs: ["198.51.100.45/32"],
      },
    );

    await expect(service.runLifecycleAction({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
      action: "stop",
    })).resolves.toMatchObject({ ok: true, value: { status: "stopped", phase: "stopped" } });
    await expect(service.runLifecycleAction({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
      action: "start",
    })).resolves.toMatchObject({ ok: true, value: { status: "running", phase: "ready" } });
    await expect(service.runLifecycleAction({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
      action: "reboot",
    })).resolves.toMatchObject({ ok: true, value: { status: "running", phase: "ready" } });
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(provider.start).toHaveBeenCalledOnce();
    expect(provider.reboot).toHaveBeenCalledOnce();

    const plan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!plan.ok) throw new Error(plan.error);
    await expect(service.executeDestroyDeployment({ token: plan.value.token }))
      .resolves.toMatchObject({ ok: true, value: { deployments: [] } });
    expect(provider.destroy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      guid: DEPLOYMENT_ID,
      subscriptionId: AZURE_SUBSCRIPTION_ID,
      tenantId: AZURE_TENANT_ID,
      networkSecurityGroupId: AZURE_NSG_ID,
    }));
    service.dispose();
  });

  it("refreshes a requested Azure public IP before using it for SSH and the operator endpoint", async () => {
    const { safeStorage, store, vault } = await dependencies();
    await vault.create(azureCredential());
    const provider = new FakeAzureProvider();
    const initial = azureResourceWithoutPublicAddress();
    provider.create.mockResolvedValue(initial);
    provider.refresh.mockResolvedValue(azureResource());
    const provisioner = fakeProvisioner();
    const refreshDelay = vi.fn(async () => undefined);
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner,
      azureProviderFactory: () => provider,
      azurePublicIpRefreshDelay: refreshDelay,
    });

    await expect(service.createDeployment(azureDeployment())).resolves.toMatchObject({
      ok: true,
      value: {
        remoteHost: "203.0.113.42",
        runtime: { publicIpAddress: "203.0.113.42", privateIpAddress: "10.42.1.4" },
      },
    });
    expect(provider.refresh).toHaveBeenCalledExactlyOnceWith(initial);
    expect(refreshDelay).not.toHaveBeenCalled();
    expect(provisioner.provision).toHaveBeenCalledWith(expect.objectContaining({
      operatorEndpointHost: "203.0.113.42",
      ssh: expect.objectContaining({ host: "203.0.113.42" }),
    }));
    service.dispose();
  });

  it("bounds Azure public IP refreshes and refuses to provision through the private fallback", async () => {
    const { safeStorage, store, vault } = await dependencies();
    await vault.create(azureCredential());
    const provider = new FakeAzureProvider();
    const missingPublicAddress = azureResourceWithoutPublicAddress();
    provider.create.mockResolvedValue(missingPublicAddress);
    provider.refresh.mockResolvedValue(missingPublicAddress);
    const provisioner = fakeProvisioner();
    const refreshDelay = vi.fn(async () => undefined);
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner,
      azureProviderFactory: () => provider,
      azurePublicIpRefreshDelay: refreshDelay,
    });

    await expect(service.createDeployment(azureDeployment())).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/after 7 refresh attempts; refusing private-address fallback/u),
    });
    expect(provider.refresh).toHaveBeenCalledTimes(7);
    expect(refreshDelay).toHaveBeenCalledTimes(6);
    expect(refreshDelay).toHaveBeenCalledWith(5_000);
    expect(provisioner.provision).not.toHaveBeenCalled();
    expect(store.getState().deployments[0]).toMatchObject({
      status: "failed",
      phase: "failed",
      remoteHost: null,
    });
    service.dispose();
  });

  it("preserves private-only Azure provisioning without waiting for a public IP", async () => {
    const { safeStorage, store, vault } = await dependencies();
    await vault.create(azureCredential());
    const provider = new FakeAzureProvider();
    provider.create.mockResolvedValue(azurePrivateResource());
    const provisioner = fakeProvisioner();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner,
      azureProviderFactory: () => provider,
    });
    const deployment = azureDeployment();

    await expect(service.createDeployment({
      ...deployment,
      spec: { ...deployment.spec, usePublicIp: false },
    })).resolves.toMatchObject({
      ok: true,
      value: {
        remoteHost: "10.42.1.4",
        runtime: { publicIpAddressId: null, publicIpAddress: null, privateIpAddress: "10.42.1.4" },
      },
    });
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(provisioner.provision).toHaveBeenCalledWith(expect.objectContaining({
      operatorEndpointHost: "10.42.1.4",
      ssh: expect.objectContaining({ host: "10.42.1.4" }),
    }));
    service.dispose();
  });

  it("does not expose a private SSH fallback when a public Azure address disappears on refresh", async () => {
    const { safeStorage, store, vault } = await dependencies();
    await vault.create(azureCredential());
    const provider = new FakeAzureProvider();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      provisioner: fakeProvisioner(),
      azureProviderFactory: () => provider,
    });
    const created = await service.createDeployment(azureDeployment());
    if (!created.ok) throw new Error(created.error);
    provider.reboot.mockResolvedValue(azureResourceWithoutPublicAddress());

    await expect(service.runLifecycleAction({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
      action: "reboot",
    })).resolves.toMatchObject({
      ok: true,
      value: {
        remoteHost: null,
        runtime: { publicIpAddress: null, privateIpAddress: "10.42.1.4" },
      },
    });
    await expect(service.listSshTargets()).resolves.toMatchObject({
      ok: true,
      value: [{
        provider: "azure",
        host: "",
        connectable: false,
        unavailableReason: "This server does not have an SSH address yet",
      }],
    });
    service.dispose();
  });

  it("does not mutate a deployment when an optimistic revision is stale", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => new FakeAwsProvider(),
    });
    await service.createDeployment(awsDeployment());
    const before = store.getState();

    const result = await service.runLifecycleAction({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 0,
      action: "stop",
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/changed in another window/u) });
    expect(store.getState()).toBe(before);
    expect(store.getState().deployments[0]).toMatchObject({ status: "running", phase: "ready" });
    service.dispose();
  });

  it("lists only managed servers backed by matching SSH credentials", async () => {
    const safeStorage = new XorSafeStorage();
    const ids = [DEPLOYMENT_ID, SECOND_DEPLOYMENT_ID];
    const store = await CloudDeploymentStore.load(rootDirectory, {
      idFactory: () => ids.shift() ?? DEPLOYMENT_ID,
      clock: () => NOW,
    });
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    await vault.create(awsCredential());
    await createRunningAwsDeployment(store);
    const unmatched = await store.create({
      ...azureDeployment(),
      expectedRevision: store.getState().revision,
      credentialId: MISSING_CREDENTIAL_ID,
      name: "Missing SSH key",
    });
    if (!unmatched.ok) throw new Error(unmatched.error);
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      provisioner: fakeProvisioner(),
    });

    const result = await service.listSshTargets();

    expect(result).toEqual({
      ok: true,
      value: [{
        deploymentId: DEPLOYMENT_ID,
        name: "Sliver AWS",
        provider: "aws",
        host: "203.0.113.20",
        port: 22,
        username: "ubuntu",
        status: "running",
        connectable: true,
      }],
    });
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
    service.dispose();
  });

  it("requires one-use TOFU approval, pins the fingerprint, and fails closed on a mismatch", async () => {
    const { safeStorage, store, vault } = await dependencies();
    await vault.create(awsCredential());
    await createRunningAwsDeployment(store);
    const approvedFingerprint = `SHA256:${"A".repeat(43)}`;
    const changedFingerprint = `SHA256:${"B".repeat(43)}`;
    const runtime = fakeSshTerminalRuntime();
    const startSshTerminalRuntime = vi.fn<CloudSshTerminalStarter>()
      .mockRejectedValueOnce(new SshTerminalStartError(
        "host-key-approval-required",
        approvedFingerprint,
      ))
      .mockResolvedValueOnce(runtime)
      .mockRejectedValueOnce(new SshTerminalStartError("host-key-mismatch", changedFingerprint));
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      provisioner: fakeProvisioner(),
      startSshTerminalRuntime,
      opaqueIdFactory: () => "r".repeat(43),
      now: () => NOW.getTime(),
    });

    const first = await service.startSshSession(DEPLOYMENT_ID);
    expect(first).toEqual({
      ok: true,
      value: {
        token: "r".repeat(43),
        deploymentId: DEPLOYMENT_ID,
        name: "Sliver AWS",
        host: "203.0.113.20",
        port: 22,
        fingerprint: approvedFingerprint,
        expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000).toISOString(),
      },
    });
    expect(startSshTerminalRuntime.mock.calls[0]?.[0].ssh).toMatchObject({
      host: "203.0.113.20",
      port: 22,
      username: "ubuntu",
      privateKey: expect.stringContaining("PRIVATE KEY"),
    });
    expect(startSshTerminalRuntime.mock.calls[0]?.[0].ssh).not.toHaveProperty("hostKeySha256");
    expect(JSON.stringify(first)).not.toContain("PRIVATE KEY");

    const approved = await service.approveSshHostKey("r".repeat(43));
    expect(approved).toMatchObject({
      ok: true,
      value: {
        target: { deploymentId: DEPLOYMENT_ID, host: "203.0.113.20" },
        runtime,
      },
    });
    expect(startSshTerminalRuntime.mock.calls[1]?.[0].ssh).toMatchObject({
      hostKeySha256: approvedFingerprint,
    });
    const persisted = JSON.parse(
      await readFile(join(rootDirectory, "ssh-host-keys.json"), "utf8"),
    ) as { readonly fingerprints: Readonly<Record<string, string>> };
    expect(persisted.fingerprints).toEqual({ [DEPLOYMENT_ID]: approvedFingerprint });
    await expect(service.approveSshHostKey("r".repeat(43))).resolves.toEqual({
      ok: false,
      error: "The SSH host-key review is invalid or expired",
    });

    const mismatch = await service.startSshSession(DEPLOYMENT_ID);
    expect(mismatch).toEqual({
      ok: false,
      error: "The SSH server host key did not match the trusted fingerprint.",
    });
    expect(JSON.stringify(mismatch)).not.toContain("PRIVATE KEY");
    expect(startSshTerminalRuntime.mock.calls[2]?.[0].ssh).toMatchObject({
      hostKeySha256: approvedFingerprint,
    });
    service.dispose();
  });

  it("uses the Azure deployment SSH identity through one-use TOFU host-key approval", async () => {
    const { safeStorage, store, vault } = await dependencies();
    await vault.create(azureCredential());
    await createRunningAzureDeployment(store);
    const fingerprint = `SHA256:${"Z".repeat(43)}`;
    const runtime = fakeSshTerminalRuntime();
    const startSshTerminalRuntime = vi.fn<CloudSshTerminalStarter>()
      .mockRejectedValueOnce(new SshTerminalStartError(
        "host-key-approval-required",
        fingerprint,
      ))
      .mockResolvedValueOnce(runtime);
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      provisioner: fakeProvisioner(),
      startSshTerminalRuntime,
      opaqueIdFactory: () => "z".repeat(43),
      now: () => NOW.getTime(),
    });

    await expect(service.startSshSession(DEPLOYMENT_ID)).resolves.toEqual({
      ok: true,
      value: {
        token: "z".repeat(43),
        deploymentId: DEPLOYMENT_ID,
        name: "Sliver Azure",
        host: "203.0.113.42",
        port: 22,
        fingerprint,
        expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000).toISOString(),
      },
    });
    expect(startSshTerminalRuntime.mock.calls[0]?.[0].ssh).toMatchObject({
      host: "203.0.113.42",
      port: 22,
      username: "azureuser",
      privateKey: expect.stringContaining("PRIVATE KEY"),
    });
    expect(startSshTerminalRuntime.mock.calls[0]?.[0].ssh).not.toHaveProperty("hostKeySha256");

    await expect(service.approveSshHostKey("z".repeat(43))).resolves.toMatchObject({
      ok: true,
      value: {
        target: {
          deploymentId: DEPLOYMENT_ID,
          provider: "azure",
          name: "Sliver Azure",
          host: "203.0.113.42",
          username: "azureuser",
        },
        runtime,
      },
    });
    expect(startSshTerminalRuntime.mock.calls[1]?.[0].ssh).toMatchObject({
      host: "203.0.113.42",
      username: "azureuser",
      hostKeySha256: fingerprint,
    });
    service.dispose();
  });

  it("keeps a pinned SSH startup valid when an unrelated deployment changes", async () => {
    const safeStorage = new XorSafeStorage();
    const ids = [DEPLOYMENT_ID, SECOND_DEPLOYMENT_ID];
    const store = await CloudDeploymentStore.load(rootDirectory, {
      idFactory: () => ids.shift() ?? DEPLOYMENT_ID,
      clock: () => NOW,
    });
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    await vault.create(awsCredential());
    await createRunningAwsDeployment(store);
    const unrelated = await createUnrelatedAwsDeployment(store);
    const fingerprint = `SHA256:${"D".repeat(43)}`;
    const sshHostKeyStore = await SshHostKeyStore.load(join(rootDirectory, "ssh-host-keys.json"));
    await sshHostKeyStore.remember(DEPLOYMENT_ID, fingerprint);
    const pendingRuntime = deferred<ConsolePortRuntime>();
    const startSshTerminalRuntime = vi.fn<CloudSshTerminalStarter>(() => pendingRuntime.promise);
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      sshHostKeyStore,
      provisioner: fakeProvisioner(),
      startSshTerminalRuntime,
    });

    const starting = service.startSshSession(DEPLOYMENT_ID);
    await vi.waitFor(() => expect(startSshTerminalRuntime).toHaveBeenCalledOnce());
    const changed = await store.update({
      expectedRevision: store.getState().revision,
      deployment: { ...unrelated, name: "Renamed unrelated server" },
    });
    if (!changed.ok) throw new Error(changed.error);
    const runtime = fakeSshTerminalRuntime();
    pendingRuntime.resolve(runtime);

    await expect(starting).resolves.toMatchObject({
      ok: true,
      value: {
        target: { deploymentId: DEPLOYMENT_ID, name: "Sliver AWS" },
        runtime,
      },
    });
    expect(startSshTerminalRuntime).toHaveBeenCalledWith(expect.objectContaining({
      ssh: expect.objectContaining({ hostKeySha256: fingerprint }),
    }));
    service.dispose();
  });

  it("keeps host-key approval valid when an unrelated deployment changes", async () => {
    const safeStorage = new XorSafeStorage();
    const ids = [DEPLOYMENT_ID, SECOND_DEPLOYMENT_ID];
    const store = await CloudDeploymentStore.load(rootDirectory, {
      idFactory: () => ids.shift() ?? DEPLOYMENT_ID,
      clock: () => NOW,
    });
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    await vault.create(awsCredential());
    await createRunningAwsDeployment(store);
    const unrelated = await createUnrelatedAwsDeployment(store);
    const fingerprint = `SHA256:${"E".repeat(43)}`;
    const runtime = fakeSshTerminalRuntime();
    const startSshTerminalRuntime = vi.fn<CloudSshTerminalStarter>()
      .mockRejectedValueOnce(new SshTerminalStartError("host-key-approval-required", fingerprint))
      .mockResolvedValueOnce(runtime);
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      provisioner: fakeProvisioner(),
      startSshTerminalRuntime,
      opaqueIdFactory: () => "u".repeat(43),
      now: () => NOW.getTime(),
    });
    await expect(service.startSshSession(DEPLOYMENT_ID)).resolves.toMatchObject({
      ok: true,
      value: { token: "u".repeat(43), fingerprint },
    });
    const changed = await store.update({
      expectedRevision: store.getState().revision,
      deployment: { ...unrelated, name: "Renamed unrelated server" },
    });
    if (!changed.ok) throw new Error(changed.error);

    await expect(service.approveSshHostKey("u".repeat(43))).resolves.toMatchObject({
      ok: true,
      value: {
        target: { deploymentId: DEPLOYMENT_ID, name: "Sliver AWS" },
        runtime,
      },
    });
    expect(startSshTerminalRuntime).toHaveBeenCalledTimes(2);
    expect(startSshTerminalRuntime.mock.calls[1]?.[0].ssh).toMatchObject({
      hostKeySha256: fingerprint,
    });
    service.dispose();
  });

  it("invalidates a host-key review when managed deployment state changes", async () => {
    const { safeStorage, store, vault } = await dependencies();
    await vault.create(awsCredential());
    await createRunningAwsDeployment(store);
    const startSshTerminalRuntime = vi.fn<CloudSshTerminalStarter>()
      .mockRejectedValueOnce(new SshTerminalStartError(
        "host-key-approval-required",
        `SHA256:${"C".repeat(43)}`,
      ));
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      provisioner: fakeProvisioner(),
      startSshTerminalRuntime,
      opaqueIdFactory: () => "s".repeat(43),
      now: () => NOW.getTime(),
    });
    await expect(service.startSshSession(DEPLOYMENT_ID)).resolves.toMatchObject({
      ok: true,
      value: { token: "s".repeat(43) },
    });
    const current = store.getState().deployments[0];
    if (!current) throw new Error("Expected an SSH deployment fixture");
    const changed = await store.update({
      expectedRevision: store.getState().revision,
      deployment: { ...current, name: "Renamed managed server" },
    });
    if (!changed.ok) throw new Error(changed.error);

    await expect(service.approveSshHostKey("s".repeat(43))).resolves.toEqual({
      ok: false,
      error: "The managed SSH server changed. Review the latest server details and try again.",
    });
    expect(startSshTerminalRuntime).toHaveBeenCalledOnce();
    await expect(lstat(join(rootDirectory, "ssh-host-keys.json"))).rejects.toMatchObject({ code: "ENOENT" });
    service.dispose();
  });

  it("serializes remote transitions globally before rechecking the shared revision", async () => {
    const safeStorage = new XorSafeStorage();
    const ids = [DEPLOYMENT_ID, SECOND_DEPLOYMENT_ID];
    const store = await CloudDeploymentStore.load(rootDirectory, {
      idFactory: () => ids.shift() ?? DEPLOYMENT_ID,
      clock: () => NOW,
    });
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    let releaseFirstStop: (() => void) | undefined;
    const firstStop = new Promise<void>((resolve) => { releaseFirstStop = resolve; });
    provider.stop.mockImplementation(async (resource) => {
      await firstStop;
      return { ...resource, state: "stopped" as const };
    });
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
    });
    await service.createDeployment(awsDeployment());
    await service.createDeployment({
      ...awsDeployment(),
      expectedRevision: store.getState().revision,
      name: "Second Sliver AWS",
    });
    const expectedRevision = store.getState().revision;

    const first = service.runLifecycleAction({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision,
      action: "stop",
    });
    await vi.waitFor(() => expect(provider.stop).toHaveBeenCalledTimes(1));
    const second = service.runLifecycleAction({
      deploymentId: SECOND_DEPLOYMENT_ID,
      expectedRevision,
      action: "stop",
    });
    await Promise.resolve();
    expect(provider.stop).toHaveBeenCalledTimes(1);
    releaseFirstStop?.();

    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/changed in another window/u),
    });
    expect(provider.stop).toHaveBeenCalledTimes(1);
    service.dispose();
  });
});

async function dependencies() {
  const safeStorage = new XorSafeStorage();
  const store = await CloudDeploymentStore.load(rootDirectory, {
    idFactory: () => DEPLOYMENT_ID,
    clock: () => NOW,
  });
  const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
    idFactory: () => CREDENTIAL_ID,
    clock: () => NOW,
  });
  return { safeStorage, store, vault };
}

async function createRunningAwsDeployment(store: CloudDeploymentStore): Promise<void> {
  const created = await store.create({
    ...awsDeployment(),
    expectedRevision: store.getState().revision,
  });
  if (!created.ok || created.value.deployment.provider !== "aws") {
    throw new Error(created.ok ? "Expected an AWS deployment fixture" : created.error);
  }
  const updated = await store.update({
    expectedRevision: store.getState().revision,
    deployment: {
      ...created.value.deployment,
      status: "running",
      phase: "ready",
      remoteHost: "203.0.113.20",
      runtime: {
        ...created.value.deployment.runtime,
        instanceId: "i-0123456789abcdef0",
        instanceState: "running",
        instanceHealth: "ok",
        systemHealth: "ok",
        publicIpAddress: "203.0.113.20",
        privateIpAddress: "10.0.0.20",
      },
    },
  });
  if (!updated.ok) throw new Error(updated.error);
}

async function createRunningAzureDeployment(store: CloudDeploymentStore): Promise<void> {
  const created = await store.create({
    ...azureDeployment(),
    expectedRevision: store.getState().revision,
  });
  if (!created.ok || created.value.deployment.provider !== "azure") {
    throw new Error(created.ok ? "Expected an Azure deployment fixture" : created.error);
  }
  const resource = azureResource();
  const updated = await store.update({
    expectedRevision: store.getState().revision,
    deployment: {
      ...created.value.deployment,
      status: "running",
      phase: "ready",
      remoteHost: "203.0.113.42",
      runtime: {
        resourceGroupName: AZURE_RESOURCE_GROUP,
        vmName: `sliver-vm-${DEPLOYMENT_ID}`,
        vmId: resource.virtualMachineId,
        instanceState: "running",
        provisioningState: "Succeeded",
        networkSecurityGroupId: resource.networkSecurityGroupId,
        networkInterfaceId: resource.networkInterfaceId,
        osDiskId: resource.osDiskId,
        publicIpAddressId: resource.publicIpAddressId ?? null,
        publicIpAddress: "203.0.113.42",
        privateIpAddress: "10.42.1.4",
        vnetId: resource.virtualNetworkId,
        subnetId: resource.subnetId,
      },
    },
  });
  if (!updated.ok) throw new Error(updated.error);
}

async function createUnrelatedAwsDeployment(store: CloudDeploymentStore) {
  const created = await store.create({
    ...awsDeployment(),
    expectedRevision: store.getState().revision,
    name: "Unrelated AWS server",
  });
  if (!created.ok) throw new Error(created.error);
  return created.value.deployment;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeSshTerminalRuntime(): ConsolePortRuntime & { readonly close: ReturnType<typeof vi.fn> } {
  return {
    subscribe: vi.fn(() => () => undefined),
    write: vi.fn(),
    resize: vi.fn(),
    pauseOutput: vi.fn(),
    resumeOutput: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

function awsCredential(): ResolvedAwsCloudCredentialInput {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    provider: "aws",
    label: "AWS",
    defaultRegion: "us-west-2",
    sshUsername: "ubuntu",
    secret: {
      accessKeyId: "AKIAEXAMPLE00000001",
      secretAccessKey: "secret-cloud-value",
      sessionToken: null,
      sshPrivateKey: privateKey,
      sshPassphrase: null,
    },
  };
}

function azureCredential(): ResolvedAzureCloudCredentialInput {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    provider: "azure",
    label: "Azure CLI",
    defaultLocation: "eastus",
    sshUsername: "azureuser",
    secret: {
      subscriptionId: AZURE_SUBSCRIPTION_ID,
      tenantId: AZURE_TENANT_ID,
      sshPrivateKey: privateKey,
      sshPassphrase: null,
    },
  };
}

function awsDeployment(useElasticIp = true): CreateAwsCloudDeploymentInput {
  return {
    provider: "aws",
    expectedRevision: 0,
    credentialId: CREDENTIAL_ID,
    name: "Sliver AWS",
    spec: {
      region: "us-west-2",
      imageId: "ami-0123456789abcdef0",
      instanceType: "t3.small",
      subnetId: "subnet-a0000000000000000",
      vpcId: "vpc-0123456789abcdef0",
      networkMode: "existing",
      managedVpcCidr: null,
      managedSubnetCidr: null,
      sshKeyMode: "managed",
      existingKeyPairName: null,
      sshUsername: "ubuntu",
      keyPairName: "managed-by-sliver-gui",
      operatorName: "operator",
      sshPort: 22,
      multiplayerPort: 31_337,
      volumeSizeGiB: 16,
      useElasticIp,
      sshCidrs: ["192.0.2.10/32"],
      operatorCidrs: ["198.51.100.0/24"],
    },
  };
}

function azureDeployment(): CreateAzureCloudDeploymentInput {
  return {
    provider: "azure",
    expectedRevision: 0,
    credentialId: CREDENTIAL_ID,
    name: "Sliver Azure",
    spec: {
      location: "eastus",
      imageReference: "Canonical:ubuntu-24_04-lts:server:latest",
      vmSize: "Standard_B2s",
      networkMode: "managed",
      vnetId: null,
      subnetId: null,
      managedVnetCidr: "10.42.0.0/16",
      managedSubnetCidr: "10.42.1.0/24",
      sshUsername: "azureuser",
      operatorName: "operator",
      sshPort: 22,
      multiplayerPort: 31_337,
      osDiskSizeGiB: 30,
      usePublicIp: true,
      sshCidrs: ["192.0.2.10/32"],
      operatorCidrs: ["198.51.100.0/24"],
    },
  };
}

function fakePrivateKeys(): CloudPrivateKeyCapabilities {
  return {
    choose: vi.fn(async () => ({ ok: false as const, error: "not used" })),
    consume: vi.fn(() => ({
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate material\n-----END OPENSSH PRIVATE KEY-----",
      publicKey: "ssh-ed25519 AAAA sliver-gui",
    })),
    dispose: vi.fn(),
  };
}

function inspectStoredSshKey(secret: { readonly sshPrivateKey: string; readonly sshPassphrase: string | null }) {
  const parsed = ssh2.utils.parseKey(secret.sshPrivateKey);
  return {
    algorithm: parsed instanceof Error ? null : parsed.type,
    isPrivate: parsed instanceof Error ? false : parsed.isPrivateKey(),
    passphrase: secret.sshPassphrase,
  };
}

function fakeProvisioner(): CloudSliverProvisioner & { provision: ReturnType<typeof vi.fn> } {
  return {
    provision: vi.fn(async (input) => {
      input.onOutput?.({ type: "stage", label: "Installing the Sliver server" });
      input.onOutput?.({ type: "stdout", chunk: new TextEncoder().encode("sliver-server active\n") });
      const operatorConfig = Buffer.from(JSON.stringify({
        operator: input.operatorName ?? `slivergui${input.deploymentId.replaceAll("-", "")}`,
        lhost: input.operatorEndpointHost,
        lport: input.multiplayerPort ?? 31_337,
        ca_certificate: "MANAGED-SLIVER-CA",
        certificate: "CLIENT-CERTIFICATE",
        private_key: "CLIENT-PRIVATE-KEY",
        token: "token",
      }));
      return {
        deploymentId: input.deploymentId,
        hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        architecture: "amd64" as const,
        version: "v1.5.42",
        serverSha256: "a".repeat(64),
        serviceName: `sliver-gui-${input.deploymentId}.service`,
        remoteBinaryPath: `/opt/sliver-gui/${input.deploymentId}/sliver-server`,
        operatorConfig,
        operatorConfigSha256: createHash("sha256").update(operatorConfig).digest("hex"),
      };
    }),
  };
}

class FakeAwsProvider implements CloudAwsProvider {
  readonly create = vi.fn(async (
    _input: Parameters<CloudAwsProvider["create"]>[0],
    onMutation?: Parameters<CloudAwsProvider["create"]>[1],
  ) => {
    const resource = awsResource();
    const elasticIp = resource.elasticIp;
    if (!elasticIp) throw new Error("Expected the AWS fixture to include an Elastic IP");
    await onMutation?.({ phase: "key-pair", resources: { keyPair: resource.keyPair } });
    await onMutation?.({
      phase: "security-group",
      resources: { keyPair: resource.keyPair, securityGroupId: resource.securityGroupId },
    });
    await onMutation?.({
      phase: "instance",
      resources: {
        keyPair: resource.keyPair,
        securityGroupId: resource.securityGroupId,
        instanceId: resource.instanceId,
      },
    });
    await onMutation?.({
      phase: "instance-running",
      resources: {
        keyPair: resource.keyPair,
        securityGroupId: resource.securityGroupId,
        instanceId: resource.instanceId,
      },
    });
    await onMutation?.({
      phase: "instance-status-ok",
      resources: {
        keyPair: resource.keyPair,
        securityGroupId: resource.securityGroupId,
        instanceId: resource.instanceId,
      },
    });
    await onMutation?.({
      phase: "system-status-ok",
      resources: {
        keyPair: resource.keyPair,
        securityGroupId: resource.securityGroupId,
        instanceId: resource.instanceId,
      },
    });
    await onMutation?.({
      phase: "elastic-ip",
      resources: {
        keyPair: resource.keyPair,
        securityGroupId: resource.securityGroupId,
        instanceId: resource.instanceId,
        elasticIpAllocationId: elasticIp.allocationId,
        ...(elasticIp.associationId ? { elasticIpAssociationId: elasticIp.associationId } : {}),
        elasticIpPublicAddress: elasticIp.publicIp,
      },
    });
    return resource;
  });
  readonly start = vi.fn(async (_resource: AwsEc2DeploymentResource) => ({
    ...awsResource(),
    state: "running" as const,
  }));
  readonly stop = vi.fn(async (_resource: AwsEc2DeploymentResource) => ({
    ...awsResource(),
    state: "stopped" as const,
  }));
  readonly reboot = vi.fn(async (_resource: AwsEc2DeploymentResource) => ({
    ...awsResource(),
    state: "running" as const,
  }));
  readonly replaceFirewall = vi.fn(async (_resource: AwsEc2DeploymentResource) => awsResource());
  readonly listFirewallRules = vi.fn(async (_resource: AwsEc2DeploymentResource) => awsFirewallSnapshot());
  readonly createFirewallRule = vi.fn(async (
    _resource: AwsEc2DeploymentResource,
    rule: AwsFirewallRuleSpec,
  ) => awsFirewallRule(rule));
  readonly updateFirewallRule = vi.fn(async (
    _resource: AwsEc2DeploymentResource,
    _ruleId: string,
    rule: AwsFirewallRuleSpec,
  ) => awsFirewallRule(rule));
  readonly deleteFirewallRule = vi.fn(async (
    _resource: AwsEc2DeploymentResource,
    _ruleId: string,
  ) => undefined);
  readonly destroy = vi.fn(async (_resource?: unknown) => undefined);

  async preflight() {
    return { region: "us-west-2", availabilityZones: [{}, {}] };
  }

  async discover() {
    return {
      region: "us-west-2",
      availabilityZones: [{ name: "us-west-2a", state: "available" }],
      instanceTypes: [{
        name: "t3.micro",
        architecture: "x86_64" as const,
        vCpuCount: 2,
        memoryMiB: 1024,
        processor: "Intel or AMD",
        description: "2 vCPU · 1 GiB memory",
      }],
      images: [{
        id: "ami-0123456789abcdef0",
        architecture: "x86_64",
        distribution: "ubuntu" as const,
        version: "24.04 LTS",
        sshUsername: "ubuntu",
      }],
      vpcs: [{ id: "vpc-0123456789abcdef0", isDefault: true }],
      subnets: [
        { id: "subnet-f0000000000000000", vpcId: "vpc-0123456789abcdef0", mapPublicIpOnLaunch: true },
        { id: "subnet-a0000000000000000", vpcId: "vpc-0123456789abcdef0", mapPublicIpOnLaunch: true },
      ],
      keyPairs: [],
    };
  }
}

function awsResource(): AwsEc2DeploymentResource {
  return {
    guid: DEPLOYMENT_ID,
    name: "Sliver AWS",
    region: "us-west-2",
    keyPair: {
      id: "key-0123456789abcdef0",
      name: `sliver-gui-${DEPLOYMENT_ID}`,
    },
    instanceId: "i-0123456789abcdef0",
    securityGroupId: "sg-0123456789abcdef0",
    volumeIds: ["vol-0123456789abcdef0"],
    networkInterfaceIds: ["eni-0123456789abcdef0"],
    state: "running",
    instanceHealth: "ok",
    systemHealth: "ok",
    availabilityZone: "us-west-2a",
    privateIpAddress: "10.0.0.20",
    publicIpAddress: "203.0.113.20",
    elasticIp: {
      allocationId: "eipalloc-0123456789abcdef0",
      associationId: "eipassoc-0123456789abcdef0",
      publicIp: "203.0.113.20",
    },
  };
}

function awsFirewallRule(
  rule: AwsFirewallRuleSpec = awsFirewallRuleSpec(),
  id = FIREWALL_RULE_ID,
): AwsFirewallRule {
  return { id, ...rule, managed: true };
}

function awsFirewallRuleSpec(): AwsFirewallRuleSpec {
  return {
    direction: "ingress",
    protocol: "tcp",
    fromPort: 8443,
    toPort: 8443,
    peerType: "ipv4",
    peer: "203.0.113.0/24",
    description: "Operator API",
  };
}

function awsFirewallSnapshot(): AwsFirewallSnapshot {
  return {
    provider: "aws",
    securityGroupId: "sg-0123456789abcdef0",
    securityGroupName: "sliver-gui-managed",
    vpcId: "vpc-0123456789abcdef0",
    rules: [awsFirewallRule()],
  };
}

function azureResource(
  instanceState: AzureVmDeploymentResource["instanceState"] = "running",
): AzureVmDeploymentResource {
  const virtualNetworkId =
    `${AZURE_RESOURCE_GROUP_ID}/providers/Microsoft.Network/virtualNetworks/sliver-vnet-${DEPLOYMENT_ID}`;
  const subnetId = `${virtualNetworkId}/subnets/sliver-subnet-${DEPLOYMENT_ID}`;
  return {
    subscriptionId: AZURE_SUBSCRIPTION_ID,
    tenantId: AZURE_TENANT_ID,
    location: "eastus",
    guid: DEPLOYMENT_ID,
    name: "Sliver Azure",
    resourceGroupId: AZURE_RESOURCE_GROUP_ID,
    virtualNetworkId,
    subnetId,
    managedNetwork: { virtualNetworkId, subnetId },
    networkSecurityGroupId: AZURE_NSG_ID,
    publicIpAddressId:
      `${AZURE_RESOURCE_GROUP_ID}/providers/Microsoft.Network/publicIPAddresses/sliver-ip-${DEPLOYMENT_ID}`,
    networkInterfaceId:
      `${AZURE_RESOURCE_GROUP_ID}/providers/Microsoft.Network/networkInterfaces/sliver-nic-${DEPLOYMENT_ID}`,
    virtualMachineId:
      `${AZURE_RESOURCE_GROUP_ID}/providers/Microsoft.Compute/virtualMachines/sliver-vm-${DEPLOYMENT_ID}`,
    osDiskId:
      `${AZURE_RESOURCE_GROUP_ID}/providers/Microsoft.Compute/disks/sliver-os-${DEPLOYMENT_ID}`,
    instanceState,
    provisioningState: "Succeeded",
    privateIpAddress: "10.42.1.4",
    publicIpAddress: "203.0.113.42",
  };
}

function azureResourceWithoutPublicAddress(): AzureVmDeploymentResource {
  const { publicIpAddress, ...resource } = azureResource();
  void publicIpAddress;
  return resource;
}

function azurePrivateResource(): AzureVmDeploymentResource {
  const { publicIpAddress, publicIpAddressId, ...resource } = azureResource();
  void publicIpAddress;
  void publicIpAddressId;
  return resource;
}

function azureFirewallRuleSpec(): AzureFirewallRuleSpec {
  return {
    name: "operator-api",
    priority: 1_200,
    direction: "ingress",
    access: "allow",
    protocol: "tcp",
    sourceAddressPrefixes: ["203.0.113.0/24"],
    sourcePortRanges: ["*"],
    destinationAddressPrefixes: ["*"],
    destinationPortRanges: ["8443"],
    description: "Operator API",
  };
}

function azureFirewallRule(
  rule: AzureFirewallRuleSpec = azureFirewallRuleSpec(),
): AzureFirewallRule {
  return {
    id: `${AZURE_NSG_ID}/securityRules/${rule.name}`,
    ...rule,
    managed: true,
    isDefault: false,
    sourceApplicationSecurityGroupIds: [],
    destinationApplicationSecurityGroupIds: [],
    editUnsupportedReason: null,
  };
}

function azureFirewallSnapshot(): AzureFirewallSnapshot {
  return {
    provider: "azure",
    networkSecurityGroupId: AZURE_NSG_ID,
    networkSecurityGroupName: `sliver-nsg-${DEPLOYMENT_ID}`,
    resourceGroupName: AZURE_RESOURCE_GROUP,
    rules: [azureFirewallRule()],
  };
}

class FakeAzureProvider implements CloudAzureProvider {
  readonly create = vi.fn(async (
    _input: Parameters<CloudAzureProvider["create"]>[0],
    onMutation?: Parameters<CloudAzureProvider["create"]>[1],
  ) => {
    const resource = azureResource();
    const base = { resourceGroupId: resource.resourceGroupId };
    const managedNetwork = resource.managedNetwork;
    const publicIpAddressId = resource.publicIpAddressId;
    await onMutation?.({ phase: "resource-group", resources: base });
    await onMutation?.({
      phase: "virtual-network",
      resources: {
        ...base,
        ...(managedNetwork === undefined ? {} : { managedNetwork }),
      },
    });
    await onMutation?.({
      phase: "subnet",
      resources: {
        ...base,
        ...(managedNetwork === undefined ? {} : { managedNetwork }),
      },
    });
    await onMutation?.({
      phase: "network-security-group",
      resources: {
        ...base,
        ...(managedNetwork === undefined ? {} : { managedNetwork }),
        networkSecurityGroupId: resource.networkSecurityGroupId,
      },
    });
    await onMutation?.({
      phase: "firewall",
      resources: {
        ...base,
        ...(managedNetwork === undefined ? {} : { managedNetwork }),
        networkSecurityGroupId: resource.networkSecurityGroupId,
      },
    });
    await onMutation?.({
      phase: "public-ip-address",
      resources: {
        ...base,
        ...(managedNetwork === undefined ? {} : { managedNetwork }),
        networkSecurityGroupId: resource.networkSecurityGroupId,
        ...(publicIpAddressId === undefined ? {} : { publicIpAddressId }),
      },
    });
    await onMutation?.({
      phase: "network-interface",
      resources: {
        ...base,
        ...(managedNetwork === undefined ? {} : { managedNetwork }),
        networkSecurityGroupId: resource.networkSecurityGroupId,
        ...(publicIpAddressId === undefined ? {} : { publicIpAddressId }),
        networkInterfaceId: resource.networkInterfaceId,
      },
    });
    await onMutation?.({
      phase: "virtual-machine",
      resources: {
        ...base,
        ...(managedNetwork === undefined ? {} : { managedNetwork }),
        networkSecurityGroupId: resource.networkSecurityGroupId,
        ...(publicIpAddressId === undefined ? {} : { publicIpAddressId }),
        networkInterfaceId: resource.networkInterfaceId,
        virtualMachineId: resource.virtualMachineId,
      },
    });
    await onMutation?.({
      phase: "os-disk",
      resources: {
        ...base,
        ...(managedNetwork === undefined ? {} : { managedNetwork }),
        networkSecurityGroupId: resource.networkSecurityGroupId,
        ...(publicIpAddressId === undefined ? {} : { publicIpAddressId }),
        networkInterfaceId: resource.networkInterfaceId,
        virtualMachineId: resource.virtualMachineId,
        osDiskId: resource.osDiskId,
      },
    });
    return resource;
  });
  readonly refresh = vi.fn(async () => azureResource());
  readonly start = vi.fn(async () => azureResource("running"));
  readonly stop = vi.fn(async () => azureResource("deallocated"));
  readonly reboot = vi.fn(async () => azureResource("running"));
  readonly replaceFirewall = vi.fn(async () => azureResource());
  readonly listFirewallRules = vi.fn(async () => azureFirewallSnapshot());
  readonly createFirewallRule = vi.fn(async (
    _resource: AzureVmDeploymentResource,
    rule: AzureFirewallRuleSpec,
  ) => azureFirewallRule(rule));
  readonly updateFirewallRule = vi.fn(async (
    _resource: AzureVmDeploymentResource,
    _ruleId: string,
    rule: AzureFirewallRuleSpec,
  ) => azureFirewallRule(rule));
  readonly deleteFirewallRule = vi.fn(async () => undefined);
  readonly destroy = vi.fn(async () => undefined);

  readonly checkPermissions = vi.fn(async () => {
    const statuses = new Map(
      cloudRequiredPermissions("azure").map(({ id }) => [id, "verified" as const]),
    );
    return createCloudPermissionEvaluation("azure", statuses);
  });

  readonly discover = vi.fn(async () => ({
    subscriptionId: AZURE_SUBSCRIPTION_ID,
    tenantId: AZURE_TENANT_ID,
    location: "eastus",
    vmSizes: [{
      name: "Standard_B2s",
      architecture: "x64" as const,
      vCpuCount: 2,
      memoryMiB: 4_096,
      maxDataDiskCount: 4,
      osDiskSizeMiB: 1_048_576,
      premiumIo: true,
    }],
    virtualNetworks: [],
    subnets: [],
    images: [{
      id: "Canonical:ubuntu-24_04-lts:server:latest",
      label: "Ubuntu Server 24.04 LTS (x64)",
      architecture: "x64" as const,
      publisher: "Canonical",
      offer: "ubuntu-24_04-lts",
      sku: "server",
      version: "latest" as const,
      sshUsername: "azureuser" as const,
    }],
  }));
}

function fakeAwsPermissionChecker() {
  const statuses = new Map<string, "verified" | "missing" | "unverifiable">(
    cloudRequiredPermissions("aws").map(({ id }) => [id, "verified"]),
  );
  statuses.set("ec2:ModifyVpcAttribute", "unverifiable");
  statuses.set("ec2:ModifySubnetAttribute", "unverifiable");
  statuses.set("ec2:CreateTags", "unverifiable");
  return {
    check: vi.fn(async () => createCloudPermissionEvaluation("aws", statuses)),
  };
}

function azureAccount(cloudName = "AzureCloud"): AzureCliAccountSummary {
  return {
    subscriptionId: AZURE_SUBSCRIPTION_ID,
    name: "Test Subscription",
    tenantId: AZURE_TENANT_ID,
    homeTenantId: AZURE_TENANT_ID,
    isDefault: true,
    cloudName,
  };
}

function fakeAzureAccountSource(
  accounts: readonly AzureCliAccountSummary[] = [azureAccount()],
): CloudAzureAccountSource {
  return {
    list: vi.fn(async () => accounts),
  };
}

class XorSafeStorage implements CloudSafeStorageAdapter {
  isEncryptionAvailable(): boolean {
    return true;
  }

  getSelectedStorageBackend(): string {
    return "keychain";
  }

  encryptString(plainText: string): Buffer {
    return xor(Buffer.from(plainText, "utf8"));
  }

  decryptString(encrypted: Buffer): string {
    return xor(Buffer.from(encrypted)).toString("utf8");
  }
}

function xor(input: Buffer): Buffer {
  const output = Buffer.alloc(input.length);
  for (let index = 0; index < input.length; index += 1) output[index] = input[index]! ^ 0xa5;
  return output;
}

function nativeAuthInput() {
  return { provider: "aws" as const, authentication: "login" as const, label: "Browser login", defaultRegion: "us-west-2",
    sshUsername: "ubuntu", sshPrivateKeyToken: null, sshPassphrase: null };
}

function authSession(name: string, expires = NOW.getTime() + 900_000): AwsConsoleLoginSession {
  return { loginSessionArn: "arn:aws:iam::123456789012:root", region: "us-west-2", accessKeyId: "ASIAEXAMPLE00000001",
    secretAccessKey: `${name}-secret`, sessionToken: `${name}-session`, refreshToken: `${name}-refresh`,
    privateKey: "-----BEGIN EC PRIVATE KEY-----\nproof-key\n-----END EC PRIVATE KEY-----", expiresAt: new Date(expires).toISOString() };
}

async function authService(awsConsoleLogin: CloudAwsConsoleLogin, awsProfileSource: CloudAwsProfileSource = {
  list: async () => [], credentialProvider: async () => { throw new Error("CLI unavailable"); },
}) {
  const deps = await dependencies();
  const seen: AwsEc2Credentials[] = [];
  const service = await CloudDeploymentService.create({ ...deps, rootDirectory, operatorConfigDirectory,
    awsConsoleLogin, awsProfileSource, now: () => NOW.getTime(),
    awsPermissionCheckerFactory: (connection) => ({ check: async () => {
      seen.push(typeof connection.credentials === "function" ? await connection.credentials() : connection.credentials);
      return fakeAwsPermissionChecker().check();
    } }),
  });
  return { ...deps, service, seen };
}

function authDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function azureAuthSession(name: string): AzureBrowserLoginSession {
  return { clientId: "04b07795-8ddb-461a-bbee-02f9e1bf7b46", tenantId: AZURE_TENANT_ID,
    homeAccountId: "home-account", localAccountId: "local-account", username: "operator@example.com",
    cache: JSON.stringify({ RefreshToken: { account: { secret: `${name}-refresh` } } }) };
}

function azureNativeInput(loginToken: string) {
  return { provider: "azure" as const, authentication: "login" as const, loginToken, label: "Azure Login", defaultLocation: "eastus",
    subscriptionId: AZURE_SUBSCRIPTION_ID, tenantId: AZURE_TENANT_ID, sshUsername: "azureuser", sshPrivateKeyToken: null, sshPassphrase: null };
}

async function azureAuthService(azureBrowserLogin: CloudAzureBrowserLogin, options: { now?: () => number } = {}) {
  const deps = await dependencies();
  const cliGetToken = vi.fn(async () => ({ token: "cli-token", expiresOnTimestamp: NOW.getTime() + 3_600_000 }));
  const connections: AzureVmProviderConnection[] = [];
  const azureAccounts = fakeAzureAccountSource();
  const service = await CloudDeploymentService.create({ ...deps, rootDirectory, operatorConfigDirectory,
    azureBrowserLogin, azureAccountSource: azureAccounts, now: options.now ?? (() => NOW.getTime()),
    azureCliCredentialFactory: () => ({ getToken: cliGetToken }),
    azureProviderFactory: (connection) => {
      connections.push(connection);
      const provider = new FakeAzureProvider();
      provider.checkPermissions.mockImplementation(async () => {
        await connection.credential.getToken("https://management.azure.com/.default");
        return createCloudPermissionEvaluation("azure", new Map(cloudRequiredPermissions("azure").map(({ id }) => [id, "verified" as const])));
      });
      return provider;
    },
  });
  return { ...deps, service, azureAccounts, cliGetToken, connections };
}
