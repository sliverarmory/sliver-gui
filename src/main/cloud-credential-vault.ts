import { randomUUID } from "node:crypto";
import { lstat, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  isUuidV4,
  parseAwsCredentialSecret,
  parseAzureCliCredentialSecret,
  parseCloudCredentialSummary,
  parseResolvedCloudCredentialInput,
  type AwsCloudCredentialSummary,
  type AwsCredentialSecret,
  type AwsConsoleLoginSession,
  type AzureCliCredentialSecret,
  type AzureBrowserLoginSession,
  type AzureCloudCredentialSummary,
  type CloudCredentialSummary,
  type CloudProvider,
  type ResolvedCloudCredentialInput,
} from "../shared/cloud-deployment-contracts.js";
import { readBoundedRegularFile, writePrivateFileAtomic, writePrivateFileExclusiveAtomic } from "./secure-file.js";

export const CLOUD_CREDENTIAL_DIRECTORY = "credentials";
export const CLOUD_CREDENTIAL_CIPHERTEXT_MAX_BYTES = 2 * 1024 * 1024;

const CLOUD_CREDENTIAL_ENVELOPE_VERSION = 1 as const;
const ENVELOPE_KEYS = ["v", "summary", "secret"] as const;

export interface CloudSafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface CloudCredentialVaultOptions {
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  readonly platform?: NodeJS.Platform;
}

interface AwsCredentialEnvelope {
  readonly v: typeof CLOUD_CREDENTIAL_ENVELOPE_VERSION;
  readonly summary: AwsCloudCredentialSummary;
  readonly secret: AwsCredentialSecret;
}

interface AzureCredentialEnvelope {
  readonly v: typeof CLOUD_CREDENTIAL_ENVELOPE_VERSION;
  readonly summary: AzureCloudCredentialSummary;
  readonly secret: AzureCliCredentialSecret;
}

type CloudCredentialEnvelope = AwsCredentialEnvelope | AzureCredentialEnvelope;
type CredentialSecretByProvider = {
  readonly aws: AwsCredentialSecret;
  readonly azure: AzureCliCredentialSecret;
};
type CredentialSummaryByProvider = {
  readonly aws: AwsCloudCredentialSummary;
  readonly azure: AzureCloudCredentialSummary;
};

interface SessionCredential {
  readonly summary: CloudCredentialSummary;
  readonly plaintext: Buffer;
}

/**
 * Stores provider and SSH secrets only as safeStorage ciphertext. When native
 * encryption is unavailable (or Electron selected basic_text), credentials
 * remain in process memory for this application session and are wiped on
 * deletion/disposal where Buffer semantics permit it.
 */
export class CloudCredentialVault {
  readonly rootDirectory: string;
  readonly credentialDirectory: string;

  readonly #safeStorage: CloudSafeStorageAdapter;
  readonly #idFactory: () => string;
  readonly #clock: () => Date;
  readonly #platform: NodeJS.Platform;
  readonly #sessionCredentials = new Map<string, SessionCredential>();
  #mutationChain: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(
    rootDirectory: string,
    safeStorage: CloudSafeStorageAdapter,
    options: CloudCredentialVaultOptions = {},
  ) {
    assertRootDirectory(rootDirectory);
    this.rootDirectory = rootDirectory;
    this.credentialDirectory = join(rootDirectory, CLOUD_CREDENTIAL_DIRECTORY);
    this.#safeStorage = safeStorage;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#clock = options.clock ?? (() => new Date());
    this.#platform = options.platform ?? process.platform;
  }

  supportsSecurePersistence(): boolean {
    this.#assertActive();
    return this.#canPersistSecurely();
  }

  create(input: ResolvedCloudCredentialInput, signal?: AbortSignal): Promise<CloudCredentialSummary> {
    return this.#serializeMutation(async () => {
      this.#assertActive();
      signal?.throwIfAborted();
      const parsed = parseResolvedCloudCredentialInput(input);
      const id = this.#idFactory();
      if (!isUuidV4(id) || this.#sessionCredentials.has(id)) {
        throw new Error("Cloud credential identity generation failed");
      }
      const createdAt = this.#clock().toISOString();
      const persistence = this.#canPersistSecurely() ? "secure" : "session";
      const envelope = createEnvelope(id, createdAt, persistence, parsed);
      const serialized = Buffer.from(JSON.stringify(envelope), "utf8");
      try {
        if (serialized.length > CLOUD_CREDENTIAL_CIPHERTEXT_MAX_BYTES) {
          throw new Error("Cloud credential is too large");
        }
        this.#assertActive();
        signal?.throwIfAborted();
        if (persistence === "session") {
          this.#sessionCredentials.set(id, {
            summary: envelope.summary,
            plaintext: Buffer.from(serialized),
          });
          return envelope.summary;
        }

        let ciphertext: Buffer | undefined;
        try {
          ciphertext = this.#safeStorage.encryptString(serialized.toString("utf8"));
          if (ciphertext.length < 1 || ciphertext.length > CLOUD_CREDENTIAL_CIPHERTEXT_MAX_BYTES) {
            throw new Error("Encrypted cloud credential is invalid");
          }
          await assertCredentialFileMissing(join(this.credentialDirectory, id));
          this.#assertActive();
          signal?.throwIfAborted();
          await writePrivateFileExclusiveAtomic(join(this.credentialDirectory, id), ciphertext, () => {
            this.#assertActive();
            signal?.throwIfAborted();
          });
        } finally {
          ciphertext?.fill(0);
        }
        return envelope.summary;
      } finally {
        serialized.fill(0);
      }
    });
  }

  /**
   * Replaces session material only if the credential still matches the captured
   * snapshot. Explicit login may tolerate background token rotation while the
   * caller separately excludes overlapping explicit logins.
   */
  updateAwsLoginSession(
    id: string,
    expected: AwsCredentialSecret,
    loginSession: AwsConsoleLoginSession,
    signal?: AbortSignal,
    options: { readonly allowSessionRotation?: boolean } = {},
  ): Promise<AwsCloudCredentialSummary> {
    const allowSessionRotation = options.allowSessionRotation === true;
    return this.#serializeMutation(async () => {
      this.#assertActive();
      assertCredentialId(id);
      signal?.throwIfAborted();
      const session = this.#sessionCredentials.get(id);
      const current = session
        ? parseCredentialEnvelopeFromBuffer(Buffer.from(session.plaintext), id, "session")
        : await this.#readPersistentEnvelope(id);
      if (current.summary.provider !== "aws") throw new Error("The cloud credential changed during AWS login. Try again.");
      const currentSecret = parseAwsCredentialSecret(current.secret);
      const checkedExpected = parseAwsCredentialSecret(expected);
      if (JSON.stringify(currentSecret) !== JSON.stringify(checkedExpected) &&
        !(allowSessionRotation && sameAwsLoginSource(currentSecret, checkedExpected))) {
        throw new Error("The cloud credential changed during AWS login. Try again.");
      }
      if ("accessKeyId" in currentSecret) throw new Error("AWS login is unavailable for an access-key credential");
      if (allowSessionRotation && currentSecret.loginSession && (
        currentSecret.loginSession.loginSessionArn !== loginSession.loginSessionArn ||
        currentSecret.loginSession.region !== loginSession.region
      )) throw new Error("The cloud credential changed during AWS login. Try again.");
      const secret = parseAwsCredentialSecret({ ...currentSecret, loginSession });
      const envelope = createEnvelope(id, current.summary.createdAt, current.summary.persistence, {
        provider: "aws", label: current.summary.label, defaultRegion: current.summary.defaultRegion,
        sshUsername: current.summary.sshUsername, secret,
      });
      if (envelope.summary.provider !== "aws") throw new Error("Cloud credential provider mismatch");
      const serialized = Buffer.from(JSON.stringify(envelope), "utf8");
      let ciphertext: Buffer | undefined;
      try {
        if (serialized.length > CLOUD_CREDENTIAL_CIPHERTEXT_MAX_BYTES) throw new Error("Cloud credential is too large");
        this.#assertActive();
        signal?.throwIfAborted();
        if (session) {
          session.plaintext.fill(0);
          this.#sessionCredentials.set(id, { summary: envelope.summary, plaintext: Buffer.from(serialized) });
        } else {
          ciphertext = this.#safeStorage.encryptString(serialized.toString("utf8"));
          if (ciphertext.length < 1 || ciphertext.length > CLOUD_CREDENTIAL_CIPHERTEXT_MAX_BYTES) throw new Error("Encrypted cloud credential is invalid");
          await writePrivateFileAtomic(join(this.credentialDirectory, id), ciphertext, () => {
            this.#assertActive();
            signal?.throwIfAborted();
          });
        }
        return envelope.summary;
      } finally {
        serialized.fill(0);
        ciphertext?.fill(0);
      }
    });
  }

  /** Updates an encrypted MSAL cache only while its credential snapshot remains current. */
  updateAzureLoginSession(
    id: string,
    expected: AzureCliCredentialSecret,
    loginSession: AzureBrowserLoginSession,
    signal?: AbortSignal,
  ): Promise<AzureCloudCredentialSummary> {
    return this.#serializeMutation(async () => {
      this.#assertActive();
      assertCredentialId(id);
      signal?.throwIfAborted();
      const session = this.#sessionCredentials.get(id);
      const current = session
        ? parseCredentialEnvelopeFromBuffer(Buffer.from(session.plaintext), id, "session")
        : await this.#readPersistentEnvelope(id);
      if (current.summary.provider !== "azure" || JSON.stringify(current.secret) !== JSON.stringify(parseAzureCliCredentialSecret(expected))) {
        throw new Error("The cloud credential changed during Azure login. Try again.");
      }
      const secret = parseAzureCliCredentialSecret({ ...current.secret, loginSession });
      const envelope = createEnvelope(id, current.summary.createdAt, current.summary.persistence, {
        provider: "azure", label: current.summary.label, defaultLocation: current.summary.defaultLocation,
        sshUsername: current.summary.sshUsername, secret,
      });
      if (envelope.summary.provider !== "azure") throw new Error("Cloud credential provider mismatch");
      const serialized = Buffer.from(JSON.stringify(envelope), "utf8");
      let ciphertext: Buffer | undefined;
      try {
        if (serialized.length > CLOUD_CREDENTIAL_CIPHERTEXT_MAX_BYTES) throw new Error("Cloud credential is too large");
        this.#assertActive();
        signal?.throwIfAborted();
        if (session) {
          session.plaintext.fill(0);
          this.#sessionCredentials.set(id, { summary: envelope.summary, plaintext: Buffer.from(serialized) });
        } else {
          ciphertext = this.#safeStorage.encryptString(serialized.toString("utf8"));
          if (ciphertext.length < 1 || ciphertext.length > CLOUD_CREDENTIAL_CIPHERTEXT_MAX_BYTES) throw new Error("Encrypted cloud credential is invalid");
          await writePrivateFileAtomic(join(this.credentialDirectory, id), ciphertext, () => {
            this.#assertActive();
            signal?.throwIfAborted();
          });
        }
        return envelope.summary;
      } finally {
        serialized.fill(0);
        ciphertext?.fill(0);
      }
    });
  }

  async list(): Promise<readonly CloudCredentialSummary[]> {
    this.#assertActive();
    await this.#mutationChain;
    this.#assertActive();
    const summaries: CloudCredentialSummary[] = [];
    const fileNames = await listCredentialFileNames(this.credentialDirectory);
    if (fileNames.length > 0 && !this.#canPersistSecurely()) {
      throw new Error("Secure cloud credential storage is unavailable");
    }
    for (const fileName of fileNames) {
      try {
        const envelope = await this.#readPersistentEnvelope(fileName);
        summaries.push(envelope.summary);
      } catch (error) {
        // Proxmox support was retired without deleting encrypted user data.
        // Legacy envelopes remain on disk but are deliberately unavailable.
        if (!(error instanceof RetiredProxmoxCredentialError)) throw error;
      }
    }
    summaries.push(...[...this.#sessionCredentials.values()].map(({ summary }) => summary));
    if (new Set(summaries.map(({ id }) => id)).size !== summaries.length) {
      throw new Error("Duplicate cloud credential identity");
    }
    return Object.freeze(summaries.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || left.label.localeCompare(right.label)));
  }

  delete(id: string): Promise<boolean> {
    return this.#serializeMutation(async () => {
      this.#assertActive();
      assertCredentialId(id);
      const session = this.#sessionCredentials.get(id);
      if (session) {
        session.plaintext.fill(0);
        this.#sessionCredentials.delete(id);
        return true;
      }

      const path = join(this.credentialDirectory, id);
      try {
        const envelope = await this.#readPersistentEnvelope(id);
        if (envelope.summary.id !== id) throw new Error("Cloud credential identity mismatch");
        await unlink(path);
        return true;
      } catch (error) {
        if (isMissingFile(error)) return false;
        throw error;
      }
    });
  }

  /**
   * Makes decrypted material available only for the duration of the callback.
   * Callers must return non-secret operation results and must not retain the
   * supplied object after the callback settles.
   */
  async withCredential<Provider extends CloudProvider, T>(
    id: string,
    provider: Provider,
    operation: (
      secret: CredentialSecretByProvider[Provider],
      summary: CredentialSummaryByProvider[Provider],
    ) => T | Promise<T>,
  ): Promise<T> {
    this.#assertActive();
    assertCredentialId(id);
    if (provider !== "aws" && provider !== "azure") throw new TypeError("Invalid cloud provider");
    await this.#mutationChain;
    this.#assertActive();

    const session = this.#sessionCredentials.get(id);
    const envelope = session
      ? parseCredentialEnvelopeFromBuffer(Buffer.from(session.plaintext), id, "session")
      : await this.#readPersistentEnvelope(id);
    if (envelope.summary.provider !== provider) throw new Error("Cloud credential provider mismatch");
    return operation(
      envelope.secret as CredentialSecretByProvider[Provider],
      envelope.summary as CredentialSummaryByProvider[Provider],
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const credential of this.#sessionCredentials.values()) credential.plaintext.fill(0);
    this.#sessionCredentials.clear();
  }

  async #readPersistentEnvelope(id: string): Promise<CloudCredentialEnvelope> {
    assertCredentialId(id);
    if (!this.#canPersistSecurely()) throw new Error("Secure cloud credential storage is unavailable");
    await verifyCredentialDirectory(this.credentialDirectory);
    const loaded = await readBoundedRegularFile(join(this.credentialDirectory, id), {
      label: "Encrypted cloud credential",
      maxBytes: CLOUD_CREDENTIAL_CIPHERTEXT_MAX_BYTES,
      requirePrivateMode: true,
    });
    let plaintext: string | undefined;
    try {
      plaintext = this.#safeStorage.decryptString(loaded.data);
      const parsed = JSON.parse(plaintext) as unknown;
      if (isRetiredProxmoxEnvelope(parsed, id, "secure")) {
        throw new RetiredProxmoxCredentialError();
      }
      return parseCredentialEnvelope(parsed, id, "secure");
    } catch (error) {
      if (error instanceof RetiredProxmoxCredentialError) throw error;
      throw new Error("Encrypted cloud credential is corrupt or unavailable", { cause: error });
    } finally {
      plaintext = undefined;
      loaded.data.fill(0);
    }
  }

  #canPersistSecurely(): boolean {
    try {
      if (!this.#safeStorage.isEncryptionAvailable()) return false;
      if (this.#platform !== "linux") return true;
      const backend = this.#safeStorage.getSelectedStorageBackend();
      return backend !== "basic_text" && backend !== "unknown";
    } catch {
      return false;
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Cloud credential vault is disposed");
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationChain.then(operation);
    this.#mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function sameAwsLoginSource(current: AwsCredentialSecret, expected: AwsCredentialSecret): boolean {
  if ("accessKeyId" in current || "accessKeyId" in expected || !current.loginSession || !expected.loginSession) return false;
  if (("profileName" in current) !== ("profileName" in expected)) return false;
  if ("profileName" in current && "profileName" in expected && current.profileName !== expected.profileName) return false;
  return current.sshPrivateKey === expected.sshPrivateKey && current.sshPassphrase === expected.sshPassphrase &&
    current.loginSession.loginSessionArn === expected.loginSession.loginSessionArn &&
    current.loginSession.region === expected.loginSession.region;
}

function createEnvelope(
  id: string,
  createdAt: string,
  persistence: "secure" | "session",
  input: ResolvedCloudCredentialInput,
): CloudCredentialEnvelope {
  if (input.provider === "aws") {
    const profileSummary = "profileName" in input.secret
      ? { profileName: input.secret.profileName }
      : {};
    return Object.freeze({
      v: CLOUD_CREDENTIAL_ENVELOPE_VERSION,
      summary: parseCloudCredentialSummary({
        id,
        provider: "aws",
        label: input.label,
        persistence,
        createdAt,
        defaultRegion: input.defaultRegion,
        sshUsername: input.sshUsername,
        ...profileSummary,
        ...("loginSession" in input.secret && input.secret.loginSession ? { loginSessionArn: input.secret.loginSession.loginSessionArn } : {}),
      }) as AwsCloudCredentialSummary,
      secret: input.secret,
    });
  }
  return Object.freeze({
    v: CLOUD_CREDENTIAL_ENVELOPE_VERSION,
    summary: parseCloudCredentialSummary({
      id,
      provider: "azure",
      label: input.label,
      persistence,
      createdAt,
      defaultLocation: input.defaultLocation,
      subscriptionId: input.secret.subscriptionId,
      tenantId: input.secret.tenantId,
      ...(input.secret.authentication ? { authentication: input.secret.authentication } : {}),
      ...(input.secret.loginSession ? { loginAccountId: input.secret.loginSession.homeAccountId } : {}),
      sshUsername: input.sshUsername,
    }) as AzureCloudCredentialSummary,
    secret: input.secret,
  });
}

function parseCredentialEnvelopeFromBuffer(
  data: Buffer,
  expectedId: string,
  expectedPersistence: "secure" | "session",
): CloudCredentialEnvelope {
  try {
    return parseCredentialEnvelope(JSON.parse(data.toString("utf8")) as unknown, expectedId, expectedPersistence);
  } catch (error) {
    throw new Error("Cloud credential is corrupt or unavailable", { cause: error });
  } finally {
    data.fill(0);
  }
}

function parseCredentialEnvelope(
  value: unknown,
  expectedId: string,
  expectedPersistence: "secure" | "session",
): CloudCredentialEnvelope {
  if (!hasExactKeys(value, ENVELOPE_KEYS) || value["v"] !== CLOUD_CREDENTIAL_ENVELOPE_VERSION) {
    throw new TypeError("Invalid cloud credential envelope");
  }
  const summary = parseCloudCredentialSummary(value["summary"]);
  if (summary.id !== expectedId || summary.persistence !== expectedPersistence) {
    throw new TypeError("Invalid cloud credential envelope identity");
  }
  if (summary.provider === "aws") {
    const secret = parseAwsCredentialSecret(value["secret"]);
    const summaryUsesProfile = "profileName" in summary;
    const secretUsesProfile = "profileName" in secret;
    if (
      summaryUsesProfile !== secretUsesProfile ||
      (summaryUsesProfile && secretUsesProfile && summary.profileName !== secret.profileName) ||
      (("loginSessionArn" in summary ? summary.loginSessionArn : undefined) !== ("loginSession" in secret ? secret.loginSession?.loginSessionArn : undefined))
    ) {
      throw new TypeError("Invalid AWS cloud credential source");
    }
    return Object.freeze({
      v: CLOUD_CREDENTIAL_ENVELOPE_VERSION,
      summary,
      secret,
    });
  }
  const secret = parseAzureCliCredentialSecret(value["secret"]);
  if (
    summary.subscriptionId !== secret.subscriptionId ||
    summary.tenantId !== secret.tenantId ||
    summary.authentication !== secret.authentication ||
    summary.loginAccountId !== secret.loginSession?.homeAccountId
  ) {
    throw new TypeError("Invalid Azure CLI cloud credential source");
  }
  return Object.freeze({
    v: CLOUD_CREDENTIAL_ENVELOPE_VERSION,
    summary,
    secret,
  });
}

class RetiredProxmoxCredentialError extends Error {
  constructor() {
    super("This credential belongs to the retired Proxmox provider");
    this.name = "RetiredProxmoxCredentialError";
  }
}

function isRetiredProxmoxEnvelope(
  value: unknown,
  expectedId: string,
  expectedPersistence: "secure" | "session",
): boolean {
  if (!hasExactKeys(value, ENVELOPE_KEYS) || value["v"] !== CLOUD_CREDENTIAL_ENVELOPE_VERSION) return false;
  const summary = value["summary"];
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  const record = summary as Record<string, unknown>;
  return record["provider"] === "proxmox" && record["id"] === expectedId && record["persistence"] === expectedPersistence;
}

async function listCredentialFileNames(directory: string): Promise<readonly string[]> {
  try {
    await verifyCredentialDirectory(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const fileNames: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !isUuidV4(entry.name)) {
        throw new Error("Cloud credential directory contains an invalid entry");
      }
      fileNames.push(entry.name);
    }
    return fileNames.sort();
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

async function verifyCredentialDirectory(directory: string): Promise<void> {
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Cloud credential directory must be a private regular directory");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("Cloud credential directory permissions must be private (0700 or stricter)");
  }
}

async function assertCredentialFileMissing(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error("Cloud credential identity already exists");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
}

function assertCredentialId(id: string): void {
  if (!isUuidV4(id)) throw new TypeError("Invalid cloud credential identity");
}

function assertRootDirectory(rootDirectory: string): void {
  if (
    typeof rootDirectory !== "string" ||
    rootDirectory.trim() === "" ||
    !isAbsolute(rootDirectory) ||
    resolve(rootDirectory) !== rootDirectory ||
    dirname(rootDirectory) === rootDirectory
  ) {
    throw new TypeError("An absolute bounded cloud credential root is required");
  }
}

function hasExactKeys<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
): value is Record<Key, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
