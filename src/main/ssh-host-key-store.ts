import { dirname } from "node:path";

import { isUuidV4 } from "../shared/cloud-deployment-contracts.js";
import { readBoundedRegularFile, writePrivateFileAtomic } from "./secure-file.js";

export const SSH_HOST_KEY_STORE_VERSION = 1 as const;
export const SSH_HOST_KEY_STORE_MAX_BYTES = 256 * 1024;
export const SSH_HOST_KEY_STORE_MAX_ENTRIES = 4_096;

const HOST_KEY_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/u;

interface PersistedSshHostKeyStore {
  readonly v: typeof SSH_HOST_KEY_STORE_VERSION;
  readonly fingerprints: Readonly<Record<string, string>>;
}

/**
 * Pins the SSH host key to the app-issued deployment identity. New managed
 * deployments use trust-on-first-use, then every later session must match the
 * private, atomic pin before authentication is allowed to complete.
 */
export class SshHostKeyStore {
  readonly filePath: string;
  readonly #fingerprints = new Map<string, string>();
  #mutationChain: Promise<void> = Promise.resolve();

  private constructor(filePath: string, entries: Readonly<Record<string, string>>) {
    assertFilePath(filePath);
    this.filePath = filePath;
    for (const [deploymentId, fingerprint] of Object.entries(entries)) {
      this.#fingerprints.set(deploymentId, fingerprint);
    }
  }

  static async load(filePath: string): Promise<SshHostKeyStore> {
    assertFilePath(filePath);
    try {
      const loaded = await readBoundedRegularFile(filePath, {
        label: "SSH host-key store",
        maxBytes: SSH_HOST_KEY_STORE_MAX_BYTES,
        requirePrivateMode: true,
      });
      try {
        const parsed = parsePersistedStore(JSON.parse(loaded.data.toString("utf8")) as unknown);
        return new SshHostKeyStore(filePath, parsed.fingerprints);
      } finally {
        loaded.data.fill(0);
      }
    } catch (error) {
      // Only an absent store enables first use. Corrupt, replaced, or
      // permission-weakened pin state must fail closed instead of silently
      // converting a previously trusted deployment back into TOFU.
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return new SshHostKeyStore(filePath, {});
      }
      throw new Error("The SSH host-key store is corrupt or unavailable", { cause: error });
    }
  }

  get(deploymentId: string): string | undefined {
    assertDeploymentId(deploymentId);
    return this.#fingerprints.get(deploymentId);
  }

  remember(deploymentId: string, fingerprint: string): Promise<void> {
    assertDeploymentId(deploymentId);
    assertFingerprint(fingerprint);
    return this.#serializeMutation(async () => {
      const current = this.#fingerprints.get(deploymentId);
      if (current !== undefined && current !== fingerprint) {
        throw new Error("The SSH host key did not match the pinned deployment fingerprint");
      }
      if (current === fingerprint) return;
      if (this.#fingerprints.size >= SSH_HOST_KEY_STORE_MAX_ENTRIES) {
        throw new Error("The SSH host-key store is full");
      }
      const next = Object.fromEntries([...this.#fingerprints, [deploymentId, fingerprint] as const]
        .sort((left, right) => left[0].localeCompare(right[0])));
      const data = Buffer.from(JSON.stringify({ v: SSH_HOST_KEY_STORE_VERSION, fingerprints: next }), "utf8");
      try {
        if (data.byteLength > SSH_HOST_KEY_STORE_MAX_BYTES) {
          throw new Error("The SSH host-key store is too large");
        }
        await writePrivateFileAtomic(this.filePath, data);
        this.#fingerprints.set(deploymentId, fingerprint);
      } finally {
        data.fill(0);
      }
    });
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationChain.then(operation);
    this.#mutationChain = result.then(() => undefined, () => undefined);
    return result;
  }
}

function parsePersistedStore(value: unknown): PersistedSshHostKeyStore {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value["v"] !== SSH_HOST_KEY_STORE_VERSION) {
    throw new TypeError("Invalid SSH host-key store");
  }
  const fingerprints = value["fingerprints"];
  if (!isRecord(fingerprints) || Object.keys(fingerprints).length > SSH_HOST_KEY_STORE_MAX_ENTRIES) {
    throw new TypeError("Invalid SSH host-key store");
  }
  for (const [deploymentId, fingerprint] of Object.entries(fingerprints)) {
    assertDeploymentId(deploymentId);
    assertFingerprint(fingerprint);
  }
  return Object.freeze({
    v: SSH_HOST_KEY_STORE_VERSION,
    fingerprints: Object.freeze({ ...fingerprints }) as Readonly<Record<string, string>>,
  });
}

function assertFilePath(filePath: string): void {
  if (typeof filePath !== "string" || filePath.trim() === "" || dirname(filePath) === filePath) {
    throw new TypeError("An explicit SSH host-key store path is required");
  }
}

function assertDeploymentId(value: string): void {
  if (!isUuidV4(value)) throw new TypeError("Invalid SSH deployment identity");
}

function assertFingerprint(value: unknown): asserts value is string {
  if (typeof value !== "string" || !HOST_KEY_FINGERPRINT_PATTERN.test(value)) {
    throw new TypeError("Invalid SSH host-key fingerprint");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
