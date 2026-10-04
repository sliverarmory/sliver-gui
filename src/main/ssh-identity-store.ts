import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  CLOUD_SSH_PRIVATE_KEY_MAX_LENGTH,
  isUuidV4,
} from "../shared/cloud-deployment-contracts.js";
import { writePrivateFileAtomic } from "./secure-file.js";

export const DEFAULT_SSH_IDENTITY_COMMAND_DIRECTORY = "~/.ssh/sliver-gui";

const MAX_MANAGED_NAME_LENGTH = 1_024;
const MAX_IDENTITY_BASE_NAME_LENGTH = 64;
const MAX_DIRECTORY_LENGTH = 4_096;
const DEFAULT_IDENTITY_BASE_NAME = "ssh-key";
const WINDOWS_RESERVED_BASE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin|conout)(?:\.|$)/u;
const OPENSSH_PRIVATE_KEY_HEADER = /^-----BEGIN (?:(?:OPENSSH|RSA|EC|DSA) PRIVATE KEY|PRIVATE KEY)-----/u;
const PUTTY_PRIVATE_KEY_HEADER = /^PuTTY-User-Key-File-\d+:/u;

export interface MaterializeSshIdentityInput {
  readonly managedName: string;
  readonly deploymentId: string;
  readonly privateKey: string;
  readonly collision?: boolean;
}

export interface MaterializedSshIdentity {
  readonly filePath: string;
  readonly commandPath: string;
}

export interface SshIdentityMaterializer {
  materialize(input: MaterializeSshIdentityInput): Promise<MaterializedSshIdentity>;
}

export interface SshIdentityStoreOptions {
  readonly commandDirectory?: string;
}

/**
 * Converts an operator-visible managed name into a portable, case-insensitive
 * collision key that is also safe to use as a single path component.
 */
export function canonicalSshIdentityBaseName(managedName: string): string {
  if (typeof managedName !== "string" || managedName.length > MAX_MANAGED_NAME_LENGTH) {
    throw new TypeError("Invalid managed SSH identity name");
  }

  // NFC first makes canonically equivalent operator names collide. NFKD then
  // lets common accented Latin names retain a useful ASCII representation.
  const ascii = managedName
    .normalize("NFC")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  let baseName = ascii
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .slice(0, MAX_IDENTITY_BASE_NAME_LENGTH)
    .replace(/[._-]+$/gu, "");

  if (baseName === "" || baseName === "." || baseName === "..") {
    baseName = DEFAULT_IDENTITY_BASE_NAME;
  }
  if (WINDOWS_RESERVED_BASE_NAME.test(baseName)) {
    baseName = `ssh-${baseName}`
      .slice(0, MAX_IDENTITY_BASE_NAME_LENGTH)
      .replace(/[._-]+$/gu, "");
  }
  return baseName;
}

/** Returns the stable managed filename selected by the caller's collision set. */
export function sshIdentityFileName(
  managedName: string,
  deploymentId: string,
  collision = false,
): string {
  if (typeof collision !== "boolean") throw new TypeError("Invalid SSH identity collision state");
  const baseName = canonicalSshIdentityBaseName(managedName);
  if (!collision) return baseName;
  if (!isUuidV4(deploymentId)) throw new TypeError("Invalid SSH deployment identity");
  return `${baseName}--${deploymentId.toLowerCase()}`;
}

/**
 * Persists explicitly requested OpenSSH identity bytes in a main-owned store.
 * Writes are serialized so repeated copies refresh one deterministic path.
 */
export class SshIdentityStore implements SshIdentityMaterializer {
  readonly rootDirectory: string;
  readonly commandDirectory: string;
  #mutationChain: Promise<void> = Promise.resolve();

  constructor(rootDirectory: string, options: SshIdentityStoreOptions = {}) {
    assertRootDirectory(rootDirectory);
    this.rootDirectory = rootDirectory;
    this.commandDirectory = normalizeCommandDirectory(
      options.commandDirectory ?? DEFAULT_SSH_IDENTITY_COMMAND_DIRECTORY,
    );
  }

  materialize(input: MaterializeSshIdentityInput): Promise<MaterializedSshIdentity> {
    return this.#serializeMutation(async () => {
      assertMaterializeInput(input);
      const fileName = sshIdentityFileName(
        input.managedName,
        input.deploymentId,
        input.collision ?? false,
      );
      const filePath = join(this.rootDirectory, fileName);
      const data = Buffer.from(input.privateKey, "utf8");
      try {
        if (data.byteLength < 32 || data.byteLength > CLOUD_SSH_PRIVATE_KEY_MAX_LENGTH) {
          throw new TypeError("Invalid SSH private key");
        }
        await writePrivateFileAtomic(filePath, data);
      } finally {
        data.fill(0);
      }

      return Object.freeze({
        filePath,
        commandPath: `${this.commandDirectory}/${fileName}`,
      });
    });
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

function assertMaterializeInput(input: MaterializeSshIdentityInput): void {
  if (!input || typeof input !== "object") throw new TypeError("Invalid SSH identity request");
  if (!isUuidV4(input.deploymentId)) throw new TypeError("Invalid SSH deployment identity");
  if (typeof input.privateKey !== "string") throw new TypeError("Invalid SSH private key");
  if (PUTTY_PRIVATE_KEY_HEADER.test(input.privateKey)) {
    throw new TypeError("PuTTY PPK private keys cannot be exported for OpenSSH");
  }
  if (!OPENSSH_PRIVATE_KEY_HEADER.test(input.privateKey)) throw new TypeError("Invalid SSH private key");
  if (input.collision !== undefined && typeof input.collision !== "boolean") {
    throw new TypeError("Invalid SSH identity collision state");
  }
}

function assertRootDirectory(rootDirectory: string): void {
  if (
    typeof rootDirectory !== "string" ||
    rootDirectory.length < 1 ||
    rootDirectory.length > MAX_DIRECTORY_LENGTH ||
    rootDirectory.trim() !== rootDirectory ||
    rootDirectory.includes("\0") ||
    /[\r\n]/u.test(rootDirectory) ||
    !isAbsolute(rootDirectory) ||
    resolve(rootDirectory) !== rootDirectory ||
    dirname(rootDirectory) === rootDirectory
  ) {
    throw new TypeError("An absolute bounded SSH identity directory is required");
  }
}

function normalizeCommandDirectory(commandDirectory: string): string {
  if (
    typeof commandDirectory !== "string" ||
    commandDirectory.length < 1 ||
    commandDirectory.length > MAX_DIRECTORY_LENGTH ||
    commandDirectory.trim() !== commandDirectory ||
    commandDirectory.includes("\0") ||
    /[\r\n]/u.test(commandDirectory)
  ) {
    throw new TypeError("A bounded SSH identity command directory is required");
  }
  const normalized = commandDirectory.replace(/\/+$/u, "");
  if (normalized === "") throw new TypeError("A bounded SSH identity command directory is required");
  return normalized;
}
