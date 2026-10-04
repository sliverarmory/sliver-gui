import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { dialog, type BrowserWindow } from "electron";
import ssh2 from "ssh2";

const { utils: sshUtils } = ssh2;

import type { OperationResult } from "../../shared/contracts.js";
import { isUuidV4 } from "../../shared/cloud-deployment-contracts.js";
import { readBoundedRegularFile } from "../secure-file.js";

const MAX_PRIVATE_KEY_BYTES = 1024 * 1024;
const CAPABILITY_TTL_MS = 10 * 60 * 1000;

export interface PrivateKeySelection {
  readonly token: string;
  readonly fileName: string;
}

export interface ResolvedPrivateKey {
  readonly privateKey: string;
  readonly publicKey: string;
}

interface PrivateKeyCapabilityOptions {
  readonly idFactory?: () => string;
  readonly now?: () => number;
  readonly selectFile?: (owner: BrowserWindow) => Promise<string | undefined>;
}

interface PrivateKeyCapability {
  readonly data: Buffer;
  readonly fileName: string;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
}

/** Main-only, one-shot capabilities prevent the cloud renderer from naming arbitrary files. */
export class PrivateKeyCapabilities {
  readonly #entries = new Map<string, PrivateKeyCapability>();
  readonly #idFactory: () => string;
  readonly #now: () => number;
  readonly #selectFile: (owner: BrowserWindow) => Promise<string | undefined>;

  constructor(options: PrivateKeyCapabilityOptions = {}) {
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#now = options.now ?? Date.now;
    this.#selectFile = options.selectFile ?? selectPrivateKeyFile;
  }

  async choose(owner: BrowserWindow): Promise<OperationResult<PrivateKeySelection>> {
    try {
      const path = await this.#selectFile(owner);
      if (!path) return { ok: false, error: "SSH private key selection canceled" };
      const loaded = await readBoundedRegularFile(path, {
        label: "SSH private key",
        maxBytes: MAX_PRIVATE_KEY_BYTES,
        requirePrivateMode: true,
      });
      if (loaded.data.includes(0) || !looksLikePrivateKey(loaded.data)) {
        loaded.data.fill(0);
        return { ok: false, error: "The selected file is not a supported SSH private key" };
      }
      const token = this.#idFactory();
      if (!isUuidV4(token) || this.#entries.has(token)) {
        loaded.data.fill(0);
        return { ok: false, error: "Unable to create a private-key selection" };
      }
      const expiresAt = this.#now() + CAPABILITY_TTL_MS;
      const timer = setTimeout(() => this.#discard(token), CAPABILITY_TTL_MS);
      timer.unref?.();
      this.#entries.set(token, { data: loaded.data, fileName: basename(path), expiresAt, timer });
      return { ok: true, value: Object.freeze({ token, fileName: basename(path) }) };
    } catch {
      return { ok: false, error: "Unable to read the selected SSH private key" };
    }
  }

  consume(token: string, passphrase: string | null): ResolvedPrivateKey {
    if (!isUuidV4(token)) throw new Error("The SSH private-key selection is invalid or expired");
    const entry = this.#entries.get(token);
    if (!entry) throw new Error("The SSH private-key selection is invalid or expired");
    this.#entries.delete(token);
    clearTimeout(entry.timer);
    try {
      if (entry.expiresAt <= this.#now()) throw new Error("The SSH private-key selection is invalid or expired");
      const parsed = sshUtils.parseKey(entry.data, passphrase ?? undefined);
      if (parsed instanceof Error || !parsed.isPrivateKey()) {
        throw new Error("The SSH private key or passphrase is invalid");
      }
      const privateKey = entry.data.toString("utf8");
      const publicKey = `${parsed.type} ${parsed.getPublicSSH().toString("base64")} sliver-gui`;
      return Object.freeze({ privateKey, publicKey });
    } finally {
      entry.data.fill(0);
    }
  }

  dispose(): void {
    for (const token of [...this.#entries.keys()]) this.#discard(token);
  }

  #discard(token: string): void {
    const entry = this.#entries.get(token);
    if (!entry) return;
    this.#entries.delete(token);
    clearTimeout(entry.timer);
    entry.data.fill(0);
  }
}

async function selectPrivateKeyFile(owner: BrowserWindow): Promise<string | undefined> {
  const result = await dialog.showOpenDialog(owner, {
    title: "Choose SSH Private Key",
    properties: ["openFile"],
    filters: [
      { name: "SSH private keys", extensions: ["pem", "key", "ppk"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return result.canceled ? undefined : result.filePaths[0];
}

function looksLikePrivateKey(data: Buffer): boolean {
  const prefix = data.subarray(0, Math.min(data.length, 512)).toString("utf8");
  return /-----BEGIN (?:(?:OPENSSH|RSA|EC|DSA) PRIVATE KEY|PRIVATE KEY)-----/u.test(prefix) ||
    prefix.includes("PuTTY-User-Key-File-");
}
