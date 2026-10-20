import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { RDP_PREVIEW_MAX_DATA_URL_LENGTH, type RdpConnectionOptions, type RdpCredentialPersistence, type RdpPreview, type RdpProfile, type RdpSaveProfileInput } from "../shared/rdp-contracts.js";
import { parseRdpPreview, parseRdpProfile, rdpPassword, rdpRecord, rdpString } from "../shared/rdp-validation.js";
import type { CloudSafeStorageAdapter } from "./cloud-credential-vault.js";
import { readBoundedRegularFile, writePrivateFileAtomic } from "./secure-file.js";

interface SavedProfile extends RdpSaveProfileInput { id: string; encryptedCredential?: string }
interface SessionSecret { identity: string; bytes: Buffer }
const MAX_PROFILES = 100;
export function rdpEndpoint(options: Pick<RdpConnectionOptions, "host" | "port">): string { return `${options.host.toLowerCase()}:${options.port}`; }
function credentialIdentity(options: RdpConnectionOptions): string { return JSON.stringify([rdpEndpoint(options), options.username, options.domain]); }

/** Independent from operator configs, with secret material confined to main. */
export class RdpStore {
  readonly #profiles = new Map<string, SavedProfile>();
  readonly #pins = new Map<string, string>();
  readonly #secrets = new Map<string, SessionSecret>();
  readonly #previews = new Map<string, RdpPreview>();
  #writeChain: Promise<unknown> = Promise.resolve();
  #disposed = false;
  constructor(readonly path: string, readonly storage: CloudSafeStorageAdapter, readonly platform: NodeJS.Platform = process.platform) {}

  async load(): Promise<void> {
    let data: Buffer;
    try { data = (await readBoundedRegularFile(this.path, { label: "RDP settings", maxBytes: 1024 * 1024, requirePrivateMode: true })).data; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("RDP settings could not be loaded safely"); }
    try {
      const profiles = new Map<string, SavedProfile>();
      const pins = new Map<string, string>();
      const saved = rdpRecord(JSON.parse(data.toString("utf8")));
      if (saved["version"] !== 1 || !Array.isArray(saved["profiles"]) || saved["profiles"].length > MAX_PROFILES || !Array.isArray(saved["pins"]) || saved["pins"].length > MAX_PROFILES) throw new Error("Invalid RDP settings");
      for (const raw of saved["profiles"]) {
        const record = rdpRecord(raw), profile = parseRdpProfile(raw), id = rdpString(profile.id, 80);
        if (profiles.has(id)) throw new Error("Duplicate RDP profile");
        profiles.set(id, { ...profile, id, ...(record["encryptedCredential"] === undefined ? {} : { encryptedCredential: rdpString(record["encryptedCredential"], 32768) }) });
      }
      for (const raw of saved["pins"]) {
        const record = rdpRecord(raw), endpoint = rdpString(record["endpoint"], 512), fingerprint = rdpString(record["fingerprint"], 64);
        if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error("Invalid RDP certificate pin");
        if (pins.has(endpoint)) throw new Error("Duplicate RDP certificate pin");
        pins.set(endpoint, fingerprint);
      }
      this.#profiles.clear(); this.#pins.clear();
      for (const [key, value] of profiles) this.#profiles.set(key, value);
      for (const [key, value] of pins) this.#pins.set(key, value);
      this.#previews.clear();
      for (const [id, profile] of profiles) {
        let previewData: Buffer | undefined;
        try {
          previewData = (await readBoundedRegularFile(this.#previewPath(id), { label: "RDP preview", maxBytes: RDP_PREVIEW_MAX_DATA_URL_LENGTH + 4096, requirePrivateMode: true })).data;
          const savedPreview = rdpRecord(JSON.parse(previewData.toString("utf8")));
          if (savedPreview["version"] === 1 && savedPreview["identity"] === credentialIdentity(profile)) this.#previews.set(id, parseRdpPreview(savedPreview["preview"]));
        } catch { /* Previews are a cache; missing or invalid files must not hide saved connections. */ }
        finally { previewData?.fill(0); }
      }
    } finally { data.fill(0); }
  }

  securePersistenceAvailable(): boolean {
    try {
      if (!this.storage.isEncryptionAvailable()) return false;
      if (this.platform !== "linux") return true;
      const backend = this.storage.getSelectedStorageBackend();
      return backend !== "basic_text" && backend !== "unknown";
    } catch { return false; }
  }
  profiles(): RdpProfile[] {
    return [...this.#profiles.values()].map(({ encryptedCredential, ...profile }) => ({ ...profile,
      ...(this.#previews.has(profile.id) ? { preview: this.#previews.get(profile.id)! } : {}),
      hasCredential: this.#secrets.has(profile.id) || Boolean(encryptedCredential),
      credentialPersistence: encryptedCredential ? "secure" : this.#secrets.has(profile.id) ? "session" : "none" }));
  }
  profile(id: string): RdpProfile | undefined { return this.profiles().find((profile) => profile.id === id); }
  async saveProfile(input: RdpSaveProfileInput): Promise<RdpProfile> {
    const parsed = parseRdpProfile(input), id = parsed.id ?? randomUUID();
    return this.#enqueue(async () => {
      const previous = this.#profiles.get(id);
      if (parsed.id && !previous) throw new Error("RDP profile no longer exists");
      if (!previous && this.#profiles.size >= MAX_PROFILES) throw new Error("RDP profile limit reached");
      const sameIdentity = previous && credentialIdentity(previous) === credentialIdentity(parsed);
      const profile = { ...parsed, id, ...(sameIdentity && previous.encryptedCredential ? { encryptedCredential: previous.encryptedCredential } : {}) };
      const profiles = new Map(this.#profiles); profiles.set(id, profile);
      // Cache removal precedes the metadata commit so cleanup failure cannot
      // report an unsuccessful edit after the saved connection has changed.
      if (previous && !sameIdentity) await this.#deletePreviewFile(id);
      await this.#write(profiles, this.#pins);
      this.#profiles.set(id, profile);
      if (!sameIdentity) {
        this.forgetSessionCredential(id);
        this.#previews.delete(id);
      }
      return this.profile(id)!;
    });
  }
  async deleteProfile(id: string): Promise<void> {
    await this.#enqueue(async () => {
      const profiles = new Map(this.#profiles);
      if (!profiles.delete(id)) throw new Error("RDP profile no longer exists");
      await this.#deletePreviewFile(id);
      await this.#write(profiles, this.#pins);
      this.#profiles.delete(id);
      this.forgetSessionCredential(id);
      this.#previews.delete(id);
    });
  }
  async savePreview(id: string, options: RdpConnectionOptions, input: RdpPreview, beforeCommit: () => void = () => undefined): Promise<void> {
    const preview = parseRdpPreview(input), identity = credentialIdentity(options);
    await this.#enqueue(async () => {
      const profile = this.#profiles.get(id);
      if (!profile || credentialIdentity(profile) !== identity) throw new Error("RDP saved connection changed");
      beforeCommit();
      const data = Buffer.from(JSON.stringify({ version: 1, identity, preview }), "utf8");
      try { await writePrivateFileAtomic(this.#previewPath(id), data, beforeCommit); }
      finally { data.fill(0); }
      if (!this.#disposed) this.#previews.set(id, preview);
    });
  }
  async saveCredential(key: string, options: RdpConnectionOptions, password: string, persistence: RdpCredentialPersistence): Promise<void> {
    const secret = rdpPassword(password), identity = credentialIdentity(options);
    await this.#enqueue(async () => {
      const current = this.#profiles.get(key);
      if (persistence === "secure" && (!current || !this.securePersistenceAvailable())) throw new Error("Save a profile and enable system secure storage before remembering this password");
      const profile = current ? { ...current } : undefined;
      if (profile) delete profile.encryptedCredential;
      if (persistence === "secure" && profile) {
        const encrypted = this.storage.encryptString(JSON.stringify({ identity, password: secret }));
        try { profile.encryptedCredential = encrypted.toString("base64"); } finally { encrypted.fill(0); }
      }
      if (profile) {
        const profiles = new Map(this.#profiles); profiles.set(key, profile);
        await this.#write(profiles, this.#pins);
        this.#profiles.set(key, profile);
      }
      this.forgetSessionCredential(key);
      if (persistence === "session" && !this.#disposed) this.#secrets.set(key, { identity, bytes: Buffer.from(secret, "utf8") });
    });
  }
  credential(key: string, options: RdpConnectionOptions): string | undefined {
    const identity = credentialIdentity(options), memory = this.#secrets.get(key);
    if (memory) return memory.identity === identity ? memory.bytes.toString("utf8") : undefined;
    const encrypted = this.#profiles.get(key)?.encryptedCredential;
    if (!encrypted) return undefined;
    if (!this.securePersistenceAvailable()) throw new Error("System secure storage is unavailable; enter the password again");
    const bytes = Buffer.from(encrypted, "base64");
    try {
      const envelope = rdpRecord(JSON.parse(this.storage.decryptString(bytes)));
      return envelope["identity"] === identity ? rdpPassword(envelope["password"]) : undefined;
    } catch { throw new Error("Saved RDP password could not be unlocked; enter it again"); }
    finally { bytes.fill(0); }
  }
  pin(options: RdpConnectionOptions): string | undefined { return this.#pins.get(rdpEndpoint(options)); }
  async savePin(options: RdpConnectionOptions, fingerprint: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error("Invalid certificate fingerprint");
    const endpoint = rdpEndpoint(options);
    await this.#enqueue(async () => {
      if (!this.#pins.has(endpoint) && this.#pins.size >= MAX_PROFILES) throw new Error("RDP certificate pin limit reached");
      const pins = new Map(this.#pins);
      pins.set(endpoint, fingerprint);
      await this.#write(this.#profiles, pins);
      // A pending or failed approval must never become trusted in memory.
      this.#pins.set(endpoint, fingerprint);
    });
  }
  forgetSessionCredential(key: string): void { this.#secrets.get(key)?.bytes.fill(0); this.#secrets.delete(key); }
  flush(): Promise<void> {
    return this.#enqueue(() => this.#write(this.#profiles, this.#pins));
  }
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#writeChain.catch(() => undefined).then(() => {
      if (this.#disposed) throw new Error("RDP settings are shutting down");
      return operation();
    });
    this.#writeChain = queued;
    return queued;
  }
  async #write(profiles: ReadonlyMap<string, SavedProfile>, pins: ReadonlyMap<string, string>): Promise<void> {
    const data = Buffer.from(JSON.stringify({ version: 1, profiles: [...profiles.values()], pins: [...pins].map(([endpoint, fingerprint]) => ({ endpoint, fingerprint })) }), "utf8");
    try { await writePrivateFileAtomic(this.path, data); }
    finally { data.fill(0); }
  }
  #previewPath(id: string): string { return `${this.path}.preview-${createHash("sha256").update(id).digest("hex")}.json`; }
  async #deletePreviewFile(id: string): Promise<void> {
    try { await unlink(this.#previewPath(id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The saved RDP preview could not be removed"); }
  }
  dispose(): void { this.#disposed = true; this.#previews.clear(); for (const key of this.#secrets.keys()) this.forgetSessionCredential(key); }
}
