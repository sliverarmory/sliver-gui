// @vitest-environment node

import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ResolvedAwsCloudCredentialInput,
  AwsConsoleLoginSession,
  AzureBrowserLoginSession,
  ResolvedAzureCloudCredentialInput,
} from "../shared/cloud-deployment-contracts.js";
import * as secureFiles from "./secure-file.js";
import {
  CLOUD_CREDENTIAL_DIRECTORY,
  CloudCredentialVault,
  type CloudSafeStorageAdapter,
} from "./cloud-credential-vault.js";

const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = new Date("2026-09-06T18:00:00.000Z");
const ACCESS_KEY_ID = "AKIAEXAMPLE00000001";
const SECRET_ACCESS_KEY = "correct horse battery staple";
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate material\n-----END OPENSSH PRIVATE KEY-----";
const SUBSCRIPTION_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_ID = "11111111-1111-1111-1111-111111111111";

let temporaryDirectory = "";
let vaultRoot = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-gui-cloud-vault-"));
  vaultRoot = join(temporaryDirectory, "gui", "cloud-deployment", "v1");
});

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("CloudCredentialVault", () => {
  it.each([true, false])("updates Azure session caches without changing CLI origin or credential metadata (secure=%s)", async (secure) => {
    const storage = new XorSafeStorage(secure);
    const vault = createVault(storage);
    const originalInput = azureCredential();
    const original = await vault.create(originalInput);
    const session = azureLoginSessionFixture("first-refresh");
    const updated = await vault.updateAzureLoginSession(CREDENTIAL_ID, originalInput.secret, session);
    expect(updated).toEqual({ ...original, loginAccountId: session.homeAccountId });
    expect(updated).not.toHaveProperty("authentication");
    expect(JSON.stringify(await vault.list())).not.toContain("first-refresh");
    await expect(vault.updateAzureLoginSession(CREDENTIAL_ID, originalInput.secret, azureLoginSessionFixture("stale"))).rejects.toThrow(/changed/u);
    if (secure) {
      const reopened = new CloudCredentialVault(vaultRoot, storage);
      await expect(reopened.withCredential(CREDENTIAL_ID, "azure", (secret) => secret.loginSession?.cache)).resolves.toBe(session.cache);
      reopened.dispose();
    }
    await vault.delete(CREDENTIAL_ID);
    await expect(vault.updateAzureLoginSession(CREDENTIAL_ID, { ...originalInput.secret, loginSession: session }, azureLoginSessionFixture("deleted"))).rejects.toThrow();
    expect(await vault.list()).toEqual([]);
  });

  it("checks cancellation at the atomic credential create commit after filesystem preparation", async () => {
    const storage = new XorSafeStorage();
    const vault = createVault(storage);
    const controller = new AbortController();
    const write = secureFiles.writePrivateFileExclusiveAtomic;
    const spy = vi.spyOn(secureFiles, "writePrivateFileExclusiveAtomic").mockImplementation((path, data, beforeCommit) =>
      write(path, data, () => { controller.abort(); beforeCommit?.(); }));
    try {
      await expect(vault.create(azureCredential(), controller.signal)).rejects.toThrow();
      expect(await vault.list()).toEqual([]);
      expect(await readdir(join(vaultRoot, CLOUD_CREDENTIAL_DIRECTORY))).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it.each(["aws", "azure"] as const)("checks cancellation before atomically replacing %s login credentials", async (provider) => {
    const storage = new XorSafeStorage();
    const vault = createVault(storage);
    const input = provider === "aws" ? awsProfileCredential() : azureCredential();
    const original = await vault.create(input);
    const controller = new AbortController();
    storage.encryptString.mockImplementationOnce((plaintext) => {
      queueMicrotask(() => controller.abort());
      return xor(Buffer.from(plaintext, "utf8"));
    });
    const updating = input.provider === "aws"
      ? vault.updateAwsLoginSession(CREDENTIAL_ID, input.secret, loginSessionFixture("cancelled"), controller.signal)
      : vault.updateAzureLoginSession(CREDENTIAL_ID, input.secret, azureLoginSessionFixture("cancelled"), controller.signal);
    await expect(updating).rejects.toThrow();
    expect(await vault.list()).toEqual([original]);
    expect(await readdir(join(vaultRoot, CLOUD_CREDENTIAL_DIRECTORY))).toEqual([CREDENTIAL_ID]);
  });

  it.each([true, false])("updates native login sessions in place and rejects stale or deleted snapshots (secure=%s)", async (secure) => {
    const storage = new XorSafeStorage(secure);
    const vault = createVault(storage);
    const profile = awsProfileCredential();
    const original = await vault.create(profile);
    const first = loginSessionFixture("first-refresh-token");
    const updated = await vault.updateAwsLoginSession(CREDENTIAL_ID, profile.secret, first);
    expect(updated).toEqual({ ...original, loginSessionArn: first.loginSessionArn });
    expect(JSON.stringify(await vault.list())).not.toContain(first.refreshToken);
    await expect(vault.updateAwsLoginSession(CREDENTIAL_ID, profile.secret, loginSessionFixture("stale"))).rejects.toThrow(/changed/u);
    if (secure) {
      const ciphertext = await readFile(join(vaultRoot, CLOUD_CREDENTIAL_DIRECTORY, CREDENTIAL_ID));
      expect(ciphertext.toString()).not.toContain(first.refreshToken);
      const reopened = new CloudCredentialVault(vaultRoot, storage);
      await expect(reopened.withCredential(CREDENTIAL_ID, "aws", (secret) => "loginSession" in secret ? secret.loginSession?.refreshToken : null)).resolves.toBe(first.refreshToken);
      reopened.dispose();
    }
    await vault.delete(CREDENTIAL_ID);
    await expect(vault.updateAwsLoginSession(CREDENTIAL_ID, { ...profile.secret, loginSession: first }, loginSessionFixture("resurrect"))).rejects.toThrow();
    expect(await vault.list()).toEqual([]);
  });

  it("rejects cancelled session updates before modifying the encrypted credential", async () => {
    const vault = createVault(new XorSafeStorage());
    const profile = awsProfileCredential();
    const original = await vault.create(profile);
    const controller = new AbortController();
    controller.abort();
    await expect(vault.updateAwsLoginSession(CREDENTIAL_ID, profile.secret, loginSessionFixture("cancelled"), controller.signal)).rejects.toThrow();
    expect(await vault.list()).toEqual([original]);
  });

  it("persists only safeStorage ciphertext in a private UUID-named file", async () => {
    const safeStorage = new XorSafeStorage();
    const vault = createVault(safeStorage, "linux");

    expect(vault.supportsSecurePersistence()).toBe(true);

    const summary = await vault.create(awsCredential());

    expect(summary).toEqual({
      id: CREDENTIAL_ID,
      provider: "aws",
      label: "Production AWS",
      persistence: "secure",
      createdAt: CREATED_AT.toISOString(),
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
    });
    expect(JSON.stringify(summary)).not.toContain(SECRET_ACCESS_KEY);
    const directory = join(vaultRoot, CLOUD_CREDENTIAL_DIRECTORY);
    expect(await readdir(directory)).toEqual([CREDENTIAL_ID]);
    const ciphertext = await readFile(join(directory, CREDENTIAL_ID));
    expect(ciphertext.toString("utf8")).not.toContain(SECRET_ACCESS_KEY);
    expect(ciphertext.toString("utf8")).not.toContain(PRIVATE_KEY);
    if (process.platform !== "win32") {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(directory, CREDENTIAL_ID))).mode & 0o777).toBe(0o600);
    }
  });

  it("lists only redacted metadata and scopes decryption to a callback", async () => {
    const vault = createVault(new XorSafeStorage());
    await vault.create(awsCredential());

    const listed = await vault.list();
    const observed = await vault.withCredential(CREDENTIAL_ID, "aws", async (secret, summary) => ({
      identity: "accessKeyId" in secret ? secret.accessKeyId : "wrong-provider",
      label: summary.label,
    }));

    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(SECRET_ACCESS_KEY);
    expect(JSON.stringify(listed)).not.toContain(PRIVATE_KEY);
    expect(observed).toEqual({ identity: ACCESS_KEY_ID, label: "Production AWS" });
    await expect(vault.withCredential(CREDENTIAL_ID, "azure", () => undefined)).rejects.toThrow(/provider mismatch/u);
  });

  it("reopens the pre-profile AWS access-key envelope shape", async () => {
    const safeStorage = new XorSafeStorage();
    const original = createVault(safeStorage);
    await original.create(awsCredential());
    original.dispose();

    const reopened = new CloudCredentialVault(vaultRoot, safeStorage);
    await expect(reopened.list()).resolves.toEqual([{
      id: CREDENTIAL_ID,
      provider: "aws",
      label: "Production AWS",
      persistence: "secure",
      createdAt: CREATED_AT.toISOString(),
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
    }]);
    await expect(reopened.withCredential(CREDENTIAL_ID, "aws", (secret) =>
      "accessKeyId" in secret ? secret.accessKeyId : null))
      .resolves.toBe(ACCESS_KEY_ID);
    reopened.dispose();
  });

  it("persists only an AWS profile reference with SSH material and rejects source mismatches", async () => {
    const safeStorage = new XorSafeStorage();
    const vault = createVault(safeStorage);

    const summary = await vault.create(awsProfileCredential());
    expect(summary).toEqual({
      id: CREDENTIAL_ID,
      provider: "aws",
      label: "Local AWS profile",
      persistence: "secure",
      createdAt: CREATED_AT.toISOString(),
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
      profileName: "generals-network",
    });
    await expect(vault.withCredential(CREDENTIAL_ID, "aws", (secret) =>
      "profileName" in secret ? secret.profileName : null))
      .resolves.toBe("generals-network");
    expect(JSON.stringify(await vault.list())).not.toContain("aws_access_key_id");

    const credentialPath = join(vaultRoot, CLOUD_CREDENTIAL_DIRECTORY, CREDENTIAL_ID);
    const ciphertext = await readFile(credentialPath);
    const envelope = JSON.parse(safeStorage.decryptString(ciphertext)) as {
      summary: { profileName: string };
    };
    envelope.summary.profileName = "different-profile";
    await writeFile(credentialPath, safeStorage.encryptString(JSON.stringify(envelope)), { mode: 0o600 });
    await expect(vault.list()).rejects.toThrow(/corrupt or unavailable/u);
  });

  it("encrypts Azure subscription-bound SSH material while listing only non-secret metadata", async () => {
    const vault = createVault(new XorSafeStorage());

    const summary = await vault.create(azureCredential());
    const usable = await vault.withCredential(CREDENTIAL_ID, "azure", (secret) =>
      secret.subscriptionId === SUBSCRIPTION_ID && secret.tenantId === TENANT_ID);

    expect(summary).toMatchObject({
      provider: "azure",
      subscriptionId: SUBSCRIPTION_ID,
      tenantId: TENANT_ID,
      defaultLocation: "westus2",
      sshUsername: "azureuser",
      persistence: "secure",
    });
    expect(JSON.stringify(await vault.list())).not.toContain(PRIVATE_KEY);
    expect(usable).toBe(true);
  });

  it.each([
    ["subscriptionId", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"],
    ["tenantId", "33333333-3333-3333-3333-333333333333"],
  ] as const)("rejects an Azure envelope whose summary %s does not match its secret", async (field, value) => {
    const safeStorage = new XorSafeStorage();
    const vault = createVault(safeStorage);
    await vault.create(azureCredential());

    const credentialPath = join(vaultRoot, CLOUD_CREDENTIAL_DIRECTORY, CREDENTIAL_ID);
    const ciphertext = await readFile(credentialPath);
    const envelope = JSON.parse(safeStorage.decryptString(ciphertext)) as {
      summary: { subscriptionId: string; tenantId: string };
    };
    envelope.summary[field] = value;
    await writeFile(credentialPath, safeStorage.encryptString(JSON.stringify(envelope)), { mode: 0o600 });

    await expect(vault.list()).rejects.toThrow(/corrupt or unavailable/u);
  });

  it("deletes an exact verified persistent credential without accepting path input", async () => {
    const vault = createVault(new XorSafeStorage());
    await vault.create(awsCredential());

    await expect(vault.delete("../state.json")).rejects.toThrow(/identity/u);
    await expect(vault.delete(CREDENTIAL_ID)).resolves.toBe(true);
    await expect(vault.delete(CREDENTIAL_ID)).resolves.toBe(false);
    await expect(vault.list()).resolves.toEqual([]);
  });

  it("never overwrites an existing ciphertext file on an identity collision", async () => {
    const vault = createVault(new XorSafeStorage());
    await vault.create(awsCredential());
    const credentialPath = join(vaultRoot, CLOUD_CREDENTIAL_DIRECTORY, CREDENTIAL_ID);
    const original = await readFile(credentialPath);

    await expect(vault.create({ ...awsCredential(), label: "Collision" })).rejects.toThrow(/already exists/u);
    expect(await readFile(credentialPath)).toEqual(original);
    expect((await vault.list())[0]?.label).toBe("Production AWS");
  });

  it.each([
    { available: false, backend: "unknown" },
    { available: true, backend: "basic_text" },
  ])("uses session-only memory when native secure storage is unavailable: %o", async ({ available, backend }) => {
    const safeStorage = new XorSafeStorage(available, backend);
    const vault = createVault(safeStorage, "linux");

    expect(vault.supportsSecurePersistence()).toBe(false);

    const summary = await vault.create(awsCredential());

    expect(summary.persistence).toBe("session");
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
    await expect(lstat(join(vaultRoot, CLOUD_CREDENTIAL_DIRECTORY))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(vault.list()).resolves.toEqual([summary]);
    await expect(vault.withCredential(CREDENTIAL_ID, "aws", (secret) =>
      "accessKeyId" in secret && secret.secretAccessKey === SECRET_ACCESS_KEY))
      .resolves.toBe(true);

    vault.dispose();
    await expect(vault.list()).rejects.toThrow(/disposed/u);
    const restarted = createVault(safeStorage);
    await expect(restarted.list()).resolves.toEqual([]);
  });

  it("uses native encryption on macOS and Windows without calling the Linux password-store API", () => {
    const safeStorage = new XorSafeStorage();
    const linuxBackend = vi.spyOn(safeStorage, "getSelectedStorageBackend")
      .mockImplementation(() => { throw new Error("Linux-only API"); });

    expect(createVault(safeStorage, "darwin").supportsSecurePersistence()).toBe(true);
    expect(createVault(safeStorage, "win32").supportsSecurePersistence()).toBe(true);
    expect(linuxBackend).not.toHaveBeenCalled();
  });

  it("fails closed when persisted ciphertext is corrupt or its directory has unknown entries", async () => {
    const vault = createVault(new XorSafeStorage());
    await vault.create(awsCredential());
    const credentialPath = join(vaultRoot, CLOUD_CREDENTIAL_DIRECTORY, CREDENTIAL_ID);
    await writeFile(credentialPath, Buffer.from("corrupt"), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(credentialPath, 0o600);

    await expect(vault.list()).rejects.toThrow(/corrupt or unavailable/u);

    await writeFile(join(vaultRoot, CLOUD_CREDENTIAL_DIRECTORY, "notes.txt"), "not a credential", { mode: 0o600 });
    await expect(vault.list()).rejects.toThrow(/invalid entry/u);
  });

  it("refuses to decrypt existing credentials while secure storage is unavailable", async () => {
    const secure = createVault(new XorSafeStorage());
    await secure.create(awsCredential());
    const unavailable = createVault(new XorSafeStorage(false, "unknown"));

    await expect(unavailable.list()).rejects.toThrow(/storage is unavailable/u);
    await expect(unavailable.withCredential(CREDENTIAL_ID, "aws", () => undefined)).rejects.toThrow(/storage is unavailable/u);
  });

  it("rejects invalid generated identities and malformed resolved secrets before writing", async () => {
    const vault = new CloudCredentialVault(vaultRoot, new XorSafeStorage(), {
      idFactory: () => "not-a-uuid",
      clock: () => CREATED_AT,
    });

    await expect(vault.create(awsCredential())).rejects.toThrow(/identity generation/u);
    await expect(vault.create({
      ...awsCredential(),
      secret: { ...awsCredential().secret, sshPrivateKey: "/tmp/id_ed25519" },
    })).rejects.toThrow(/Invalid/u);
    await expect(lstat(join(vaultRoot, CLOUD_CREDENTIAL_DIRECTORY))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires an explicit absolute root", () => {
    expect(() => new CloudCredentialVault("relative/v1", new XorSafeStorage())).toThrow(/absolute bounded/u);
    expect(() => new CloudCredentialVault("/", new XorSafeStorage())).toThrow(/absolute bounded/u);
  });
});

function createVault(
  safeStorage: CloudSafeStorageAdapter,
  platform?: NodeJS.Platform,
): CloudCredentialVault {
  return new CloudCredentialVault(vaultRoot, safeStorage, {
    idFactory: () => CREDENTIAL_ID,
    clock: () => CREATED_AT,
    ...(platform ? { platform } : {}),
  });
}

function awsCredential(): ResolvedAwsCloudCredentialInput {
  return {
    provider: "aws",
    label: "Production AWS",
    defaultRegion: "us-west-2",
    sshUsername: "ubuntu",
    secret: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      sessionToken: null,
      sshPrivateKey: PRIVATE_KEY,
      sshPassphrase: null,
    },
  };
}

function awsProfileCredential(): ResolvedAwsCloudCredentialInput {
  return {
    provider: "aws",
    label: "Local AWS profile",
    defaultRegion: "us-west-2",
    sshUsername: "ubuntu",
    secret: {
      profileName: "generals-network",
      sshPrivateKey: PRIVATE_KEY,
      sshPassphrase: null,
    },
  };
}

function azureCredential(): ResolvedAzureCloudCredentialInput {
  return {
    provider: "azure",
    label: "Azure CLI",
    defaultLocation: "westus2",
    sshUsername: "azureuser",
    secret: {
      subscriptionId: SUBSCRIPTION_ID,
      tenantId: TENANT_ID,
      sshPrivateKey: PRIVATE_KEY,
      sshPassphrase: null,
    },
  };
}

class XorSafeStorage implements CloudSafeStorageAdapter {
  readonly encryptString = vi.fn((plainText: string): Buffer => xor(Buffer.from(plainText, "utf8")));
  readonly decryptString = vi.fn((encrypted: Buffer): string => xor(encrypted).toString("utf8"));

  constructor(
    private readonly available = true,
    private readonly backend = "gnome_libsecret",
  ) {}

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  getSelectedStorageBackend(): string {
    return this.backend;
  }
}

function xor(input: Buffer): Buffer {
  return Buffer.from(input.map((byte) => byte ^ 0xa5));
}

function loginSessionFixture(refreshToken: string): AwsConsoleLoginSession {
  return { loginSessionArn: "arn:aws:iam::123456789012:root", region: "us-west-2",
    accessKeyId: "ASIAEXAMPLE00000001", secretAccessKey: "native-secret", sessionToken: "native-session", refreshToken,
    privateKey: "-----BEGIN EC PRIVATE KEY-----\nproof-key\n-----END EC PRIVATE KEY-----", expiresAt: "2026-09-08T20:00:00.000Z" };
}

function azureLoginSessionFixture(token: string): AzureBrowserLoginSession {
  return { clientId: SUBSCRIPTION_ID, tenantId: TENANT_ID, homeAccountId: "home-account", localAccountId: "local-account",
    username: "operator@example.com", cache: JSON.stringify({ RefreshToken: { value: { secret: token } } }) };
}
