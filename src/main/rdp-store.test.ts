// @vitest-environment node
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RdpSaveProfileInput } from "../shared/rdp-contracts.js";
import type { CloudSafeStorageAdapter } from "./cloud-credential-vault.js";
import { RdpStore, rdpEndpoint } from "./rdp-store.js";
import * as secureFile from "./secure-file.js";
import { RDP_PREVIEW_FIXTURE } from "../tests/rdp-preview-fixture.js";

const PASSWORD = "test-only RDP password 7h83\"\\";
const options: RdpSaveProfileInput = { host: "rdp.example.test", port: 3389, username: "alice", domain: "LAB",
  width: 1920, height: 1080, clipboard: false, label: "Test desktop", scaleMode: "fit" };
let directory = "";
let path = "";
const stores: RdpStore[] = [];

function storage(available = true, backend = "gnome_libsecret"): CloudSafeStorageAdapter {
  // Deliberately reversible test cipher; production is exercised through the safeStorage boundary.
  const xor = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => byte ^ 0xa5));
  return { isEncryptionAvailable: vi.fn(() => available), getSelectedStorageBackend: vi.fn(() => backend),
    encryptString: vi.fn((plain: string) => xor(Buffer.from(plain))), decryptString: vi.fn((encrypted: Buffer) => xor(encrypted).toString("utf8")) };
}
function store(adapter = storage(), platform: NodeJS.Platform = "linux"): RdpStore {
  const instance = new RdpStore(path, adapter, platform);
  stores.push(instance);
  return instance;
}

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "sliver-rdp-store-")); path = join(directory, "rdp.json"); });
afterEach(async () => { for (const instance of stores.splice(0)) instance.dispose(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

describe("RdpStore credentials", () => {
  it.each(["session", "secure"] as const)("scopes %s Windows credentials and previews to the full manual proxy identity", async (persistence) => {
    const instance = store();
    const manual = { ...options, networking: { kind: "socks5-manual" as const, host: "proxy.test", port: 1080, username: "proxy-user" } };
    const profile = await instance.saveProfile({ ...manual, proxyPassword: "never-store-proxy-secret" } as typeof manual);
    await instance.saveCredential(profile.id, manual, PASSWORD, persistence);
    await instance.savePreview(profile.id, manual, RDP_PREVIEW_FIXTURE);
    await instance.savePin(manual, "c".repeat(64));
    for (const changed of [options, { ...manual, networking: { ...manual.networking, host: "other.test" } },
      { ...manual, networking: { ...manual.networking, port: 1081 } }, { ...manual, networking: { ...manual.networking, username: "other-user" } }]) {
      expect(instance.credential(profile.id, changed)).toBeUndefined();
      expect(instance.pin(changed)).toBeUndefined();
      expect(rdpEndpoint(changed)).not.toBe(rdpEndpoint(manual));
    }
    const reopened = store(); await reopened.load();
    expect(reopened.pin(manual)).toBe("c".repeat(64));
    expect(reopened.profile(profile.id)?.networking).toEqual(manual.networking);
    expect(await readFile(path, "utf8")).not.toContain("never-store-proxy-secret");
    const changed = await instance.saveProfile({ ...manual, id: profile.id, networking: { ...manual.networking, username: "other-user" } });
    expect(changed.hasCredential).toBe(false); expect(changed.preview).toBeUndefined();
  });
  it("reloads bounded manual route pins with long endpoint and quoted username identities", async () => {
    const instance = store();
    const manual = { ...options, host: "a".repeat(253), networking: { kind: "socks5-manual" as const, host: "b".repeat(253), port: 1080, username: '"'.repeat(255) } };
    await instance.savePin(manual, "d".repeat(64));
    const reopened = store(); await reopened.load();
    expect(reopened.pin(manual)).toBe("d".repeat(64));
  });
  it.each(["session", "secure"] as const)("scopes %s credentials, previews, and certificate pins to the proxy route", async (persistence) => {
    const instance = store(), profile = await instance.saveProfile(options);
    const proxy = { ...options, networking: { kind: "socks5" as const, proxyId: "socks5-11111111-1111-4111-8111-111111111111" } };
    const other = { ...proxy, networking: { kind: "socks5" as const, proxyId: "socks5-22222222-2222-4222-8222-222222222222" } };
    await instance.saveCredential(profile.id, options, PASSWORD, persistence);
    await instance.savePreview(profile.id, options, RDP_PREVIEW_FIXTURE);
    await instance.savePin(options, "a".repeat(64));
    expect(instance.pin(proxy)).toBeUndefined();
    expect(instance.credential(profile.id, proxy)).toBeUndefined();
    const saved = await instance.saveProfile({ ...proxy, id: profile.id });
    expect(saved.hasCredential).toBe(false); expect(saved.preview).toBeUndefined();
    await instance.saveCredential(profile.id, proxy, PASSWORD, persistence);
    await instance.savePin(proxy, "b".repeat(64));
    expect(instance.credential(profile.id, other)).toBeUndefined();
    expect(instance.pin(other)).toBeUndefined();
    const reopened = store(); await reopened.load();
    expect(reopened.pin(options)).toBe("a".repeat(64));
    expect(reopened.pin(proxy)).toBe("b".repeat(64));
    expect(reopened.profile(profile.id)?.networking).toEqual(proxy.networking);
  });

  it.each(["session", "secure"] as const)("clears %s credentials and previews when switching to remote-screen sign-in", async (persistence) => {
    const instance = store(), profile = await instance.saveProfile(options);
    await instance.saveCredential(profile.id, options, PASSWORD, persistence);
    await instance.savePreview(profile.id, options, RDP_PREVIEW_FIXTURE);
    const remote = { ...options, id: profile.id, signInMode: "remote-screen" as const, username: "", domain: "" };
    const saved = await instance.saveProfile(remote);
    expect(saved).toMatchObject({ signInMode: "remote-screen", username: "", domain: "", hasCredential: false, credentialPersistence: "none" });
    expect(saved.preview).toBeUndefined();
    expect(instance.credential(profile.id, options)).toBeUndefined();
    expect(instance.credential(profile.id, remote)).toBeUndefined();
    await expect(instance.saveCredential(profile.id, remote, PASSWORD, "secure")).rejects.toThrow();
    await expect(instance.saveCredential(profile.id, options, PASSWORD, "secure")).rejects.toThrow();
    const reopened = store(); await reopened.load();
    expect(reopened.profile(profile.id)).toMatchObject({ signInMode: "remote-screen", hasCredential: false });
    expect((await reopened.saveProfile({ ...options, id: profile.id })).signInMode).toBeUndefined();
  });

  it("loads legacy NLA profiles and encrypted credentials without a mode migration", async () => {
    const adapter = storage(), instance = store(adapter);
    const profile = await instance.saveProfile(options);
    await instance.saveCredential(profile.id, options, PASSWORD, "secure");
    expect(await readFile(path, "utf8")).not.toContain("signInMode");
    const reopened = store(adapter); await reopened.load();
    expect(reopened.credential(profile.id, { ...options, signInMode: "nla" })).toBe(PASSWORD);
  });

  it.each(["session", "secure"] as const)("preserves %s credentials when profile edits or deletion cannot be persisted", async (persistence) => {
    const instance = store(), profile = await instance.saveProfile(options);
    await instance.saveCredential(profile.id, options, PASSWORD, persistence);
    const persisted = await readFile(path, "utf8");
    const write = vi.spyOn(secureFile, "writePrivateFileAtomic");
    write.mockRejectedValueOnce(new Error("disk failure"));
    await expect(instance.saveProfile({ ...options, id: profile.id, host: "replacement.example.test" })).rejects.toThrow("disk failure");
    expect(instance.profile(profile.id)).toMatchObject({ host: options.host, hasCredential: true, credentialPersistence: persistence });
    expect(instance.credential(profile.id, options)).toBe(PASSWORD);
    write.mockRejectedValueOnce(new Error("disk failure"));
    await expect(instance.deleteProfile(profile.id)).rejects.toThrow("disk failure");
    expect(instance.profile(profile.id)).toBeDefined();
    expect(instance.credential(profile.id, options)).toBe(PASSWORD);
    expect(await readFile(path, "utf8")).toBe(persisted);
    await instance.deleteProfile(profile.id);
    expect(instance.profile(profile.id)).toBeUndefined();
    expect(instance.credential(profile.id, options)).toBeUndefined();
  });

  it.each(["none", "session", "secure"] as const)("does not replace a secure credential with %s persistence when the write fails", async (persistence) => {
    const instance = store(), profile = await instance.saveProfile(options);
    await instance.saveCredential(profile.id, options, PASSWORD, "secure");
    const persisted = await readFile(path, "utf8");
    vi.spyOn(secureFile, "writePrivateFileAtomic").mockRejectedValueOnce(new Error("disk failure"));
    await expect(instance.saveCredential(profile.id, options, "replacement password", persistence)).rejects.toThrow("disk failure");
    expect(instance.credential(profile.id, options)).toBe(PASSWORD);
    expect(instance.profile(profile.id)?.credentialPersistence).toBe("secure");
    expect(await readFile(path, "utf8")).toBe(persisted);
    const reopened = store(); await reopened.load(); expect(reopened.credential(profile.id, options)).toBe(PASSWORD);
  });

  it("preserves a session credential when encryption fails before a secure replacement is written", async () => {
    const adapter = storage(), instance = store(adapter), profile = await instance.saveProfile(options);
    await instance.saveCredential(profile.id, options, PASSWORD, "session");
    vi.mocked(adapter.encryptString).mockImplementationOnce(() => { throw new Error("Keychain locked"); });
    await expect(instance.saveCredential(profile.id, options, "replacement password", "secure")).rejects.toThrow("Keychain locked");
    expect(instance.credential(profile.id, options)).toBe(PASSWORD);
    expect(instance.profile(profile.id)?.credentialPersistence).toBe("session");
  });

  it("keeps metadata and credentials unchanged during a pending deletion and serializes later edits after failure", async () => {
    const instance = store(), profile = await instance.saveProfile(options);
    await instance.saveCredential(profile.id, options, PASSWORD, "session");
    let failWrite: ((error: Error) => void) | undefined;
    vi.spyOn(secureFile, "writePrivateFileAtomic").mockImplementationOnce(() => new Promise((_resolve, reject) => { failWrite = reject; }));
    const deleting = instance.deleteProfile(profile.id);
    const rejected = expect(deleting).rejects.toThrow("disk failure");
    await vi.waitFor(() => expect(failWrite).toBeDefined());
    const editing = instance.saveProfile({ ...options, id: profile.id, label: "After failed delete" });
    const changing = instance.saveCredential(profile.id, options, "new session password", "session");
    expect(instance.profile(profile.id)?.label).toBe(options.label);
    expect(instance.credential(profile.id, options)).toBe(PASSWORD);
    failWrite?.(new Error("disk failure"));
    await rejected; await Promise.all([editing, changing]);
    expect(instance.profile(profile.id)?.label).toBe("After failed delete");
    expect(instance.credential(profile.id, options)).toBe("new session password");
    const reopened = store(); await reopened.load();
    expect(reopened.profile(profile.id)?.label).toBe("After failed delete");
    expect(reopened.credential(profile.id, options)).toBeUndefined();
  });

  it("does not restore session secrets when a pending write finishes after disposal", async () => {
    const instance = store(), profile = await instance.saveProfile(options), realWrite = secureFile.writePrivateFileAtomic;
    let finishWrite: (() => void) | undefined;
    vi.spyOn(secureFile, "writePrivateFileAtomic").mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { finishWrite = resolve; });
      await realWrite(...args);
    });
    const saving = instance.saveCredential(profile.id, options, PASSWORD, "session");
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    instance.dispose(); finishWrite?.(); await saving;
    expect(instance.credential(profile.id, options)).toBeUndefined();
    await expect(instance.saveCredential(profile.id, options, PASSWORD, "session")).rejects.toThrow("shutting down");
  });

  it.each(["basic_text", "unknown"])("refuses Linux %s secure persistence and still supports session memory", async (backend) => {
    const adapter = storage(true, backend), instance = store(adapter);
    const profile = await instance.saveProfile(options);
    expect(instance.securePersistenceAvailable()).toBe(false);
    await expect(instance.saveCredential(profile.id, options, PASSWORD, "secure")).rejects.toThrow(/secure storage/u);
    expect(adapter.encryptString).not.toHaveBeenCalled();
    await instance.saveCredential(profile.id, options, PASSWORD, "session");
    expect(instance.credential(profile.id, options)).toBe(PASSWORD);
    expect(await readFile(path, "utf8")).not.toContain(PASSWORD);
    const reopened = store(adapter);
    await reopened.load();
    expect(reopened.credential(profile.id, options)).toBeUndefined();
    expect(reopened.profile(profile.id)).toMatchObject({ hasCredential: false, credentialPersistence: "none" });
    instance.dispose();
    expect(instance.credential(profile.id, options)).toBeUndefined();
  });

  it("refuses unavailable/throwing secure storage without writing plaintext or invoking encryption", async () => {
    const adapter = storage(false), instance = store(adapter, "darwin");
    const profile = await instance.saveProfile(options);
    await expect(instance.saveCredential(profile.id, options, PASSWORD, "secure")).rejects.toThrow();
    vi.mocked(adapter.isEncryptionAvailable).mockImplementation(() => { throw new Error("Keychain locked"); });
    expect(instance.securePersistenceAvailable()).toBe(false);
    expect(adapter.encryptString).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).not.toContain(PASSWORD);
  });

  it("persists only encrypted envelopes and returns metadata without plaintext or ciphertext", async () => {
    const adapter = storage(), instance = store(adapter);
    const profile = await instance.saveProfile(options);
    await instance.saveCredential(profile.id, options, PASSWORD, "secure");
    const saved = await readFile(path, "utf8");
    expect(saved).not.toContain(PASSWORD);
    expect(saved).not.toContain(JSON.stringify(PASSWORD));
    expect(JSON.parse(saved).profiles[0].encryptedCredential).toEqual(expect.any(String));
    expect(instance.profile(profile.id)).toMatchObject({ hasCredential: true, credentialPersistence: "secure" });
    expect(JSON.stringify(instance.profiles())).not.toContain("encryptedCredential");
    expect(JSON.stringify(instance.profiles())).not.toContain(PASSWORD);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const reopened = store(adapter);
    await reopened.load();
    expect(reopened.credential(profile.id, options)).toBe(PASSWORD);
    vi.mocked(adapter.isEncryptionAvailable).mockReturnValue(false);
    expect(() => reopened.credential(profile.id, options)).toThrow(/unavailable/u);
  });

  it.each(["session", "secure"] as const)("binds %s credentials to endpoint, port, username and domain", async (persistence) => {
    const instance = store();
    const profile = await instance.saveProfile(options);
    await instance.saveCredential(profile.id, options, PASSWORD, persistence);
    for (const changed of [{ host: "other.example.test" }, { port: 3390 }, { username: "bob" }, { domain: "OTHER" }]) {
      expect(instance.credential(profile.id, { ...options, ...changed })).toBeUndefined();
    }
    expect(instance.credential("different-profile-id", options)).toBeUndefined();
    expect(instance.credential(profile.id, { ...options, host: options.host.toUpperCase() })).toBe(PASSWORD);
  });

  it.each(["session", "secure"] as const)("preserves %s credential on cosmetic edits and invalidates identity edits/deletion", async (persistence) => {
    const instance = store();
    const profile = await instance.saveProfile(options);
    await instance.saveCredential(profile.id, options, PASSWORD, persistence);
    await instance.saveProfile({ ...options, id: profile.id, label: "Renamed", width: 1280, clipboard: true });
    expect(instance.credential(profile.id, options)).toBe(PASSWORD);
    await instance.saveProfile({ ...options, id: profile.id, host: "replacement.example.test" });
    expect(instance.credential(profile.id, options)).toBeUndefined();
    expect(instance.profile(profile.id)?.hasCredential).toBe(false);
    await instance.saveCredential(profile.id, { ...options, host: "replacement.example.test" }, PASSWORD, persistence);
    await instance.deleteProfile(profile.id);
    expect(instance.credential(profile.id, options)).toBeUndefined();
    expect(instance.profiles()).toEqual([]);
    expect(await readFile(path, "utf8")).not.toContain("encryptedCredential");
    await expect(instance.saveProfile({ ...options, id: profile.id })).rejects.toThrow(/no longer exists/u);
  });

  it("forgetting remembered credentials removes both secure and session material", async () => {
    const instance = store();
    const profile = await instance.saveProfile(options);
    await instance.saveCredential(profile.id, options, PASSWORD, "secure");
    await instance.saveCredential(profile.id, options, PASSWORD, "none");
    expect(instance.credential(profile.id, options)).toBeUndefined();
    expect(instance.profile(profile.id)?.credentialPersistence).toBe("none");
    expect(await readFile(path, "utf8")).not.toContain("encryptedCredential");
  });
});

describe("RdpStore persistence and trust", () => {
  it("does not publish profile creation before its durable write succeeds", async () => {
    const instance = store();
    vi.spyOn(secureFile, "writePrivateFileAtomic").mockRejectedValueOnce(new Error("disk failure"));
    await expect(instance.saveProfile(options)).rejects.toThrow("disk failure");
    expect(instance.profiles()).toEqual([]);
    await instance.saveProfile(options);
    expect(instance.profiles()).toHaveLength(1);
    const reopened = store(); await reopened.load(); expect(reopened.profiles()).toHaveLength(1);
  });

  it("does not trust pending or failed certificate pins and preserves previously approved pins", async () => {
    const instance = store();
    const approved = "ab".repeat(32), replacement = "cd".repeat(32);
    await instance.savePin(options, approved);
    let failWrite: ((error: Error) => void) | undefined;
    const write = vi.spyOn(secureFile, "writePrivateFileAtomic").mockImplementationOnce(() => new Promise((_resolve, reject) => { failWrite = reject; }));
    const pending = instance.savePin(options, replacement);
    const rejected = expect(pending).rejects.toThrow("disk failure");
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(instance.pin(options)).toBe(approved);
    failWrite?.(new Error("disk failure"));
    await rejected;
    expect(instance.pin(options)).toBe(approved);
    const reopened = store(); await reopened.load(); expect(reopened.pin(options)).toBe(approved);
    write.mockRejectedValueOnce(new Error("disk failure"));
    const other = { ...options, host: "another.example.test" };
    await expect(instance.savePin(other, replacement)).rejects.toThrow("disk failure");
    expect(instance.pin(other)).toBeUndefined();
    await instance.savePin(options, replacement);
    expect(instance.pin(options)).toBe(replacement);
  });

  it("preserves an approved pin when a profile save was queued during its persistence", async () => {
    const instance = store(), fingerprint = "ef".repeat(32);
    const realWrite = secureFile.writePrivateFileAtomic;
    let finishWrite: (() => void) | undefined;
    vi.spyOn(secureFile, "writePrivateFileAtomic").mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { finishWrite = resolve; });
      await realWrite(...args);
    });
    const pinning = instance.savePin(options, fingerprint);
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    expect(instance.pin(options)).toBeUndefined();
    const saving = instance.saveProfile(options);
    finishWrite?.();
    await Promise.all([pinning, saving]);
    const reopened = store(); await reopened.load();
    expect(reopened.pin(options)).toBe(fingerprint);
    expect(reopened.profiles()).toHaveLength(1);
  });

  it("starts clean without a file, persists endpoint-scoped pins and rejects invalid fingerprints", async () => {
    const instance = store();
    await instance.load();
    expect(instance.profiles()).toEqual([]);
    const fingerprint = "ab".repeat(32);
    await instance.savePin(options, fingerprint);
    expect(instance.pin({ ...options, port: 3390 })).toBeUndefined();
    expect(instance.pin({ ...options, host: "other.example.test" })).toBeUndefined();
    const reopened = store();
    await reopened.load();
    expect(reopened.pin(options)).toBe(fingerprint);
    await expect(instance.savePin(options, "not a digest")).rejects.toThrow(/fingerprint/u);
  });

  it("rejects corrupt and non-private persisted state", async () => {
    await writeFile(path, "{truncated", { mode: 0o600 });
    await expect(store().load()).rejects.toThrow();
    await writeFile(path, JSON.stringify({ version: 2, profiles: [], pins: [] }));
    await expect(store().load()).rejects.toThrow(/Invalid RDP/u);
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await expect(store().load()).rejects.toThrow(/loaded safely/u);
    }
  });

  it("does not publish a partially parsed profile list when later persisted state is invalid", async () => {
    const instance = store();
    const profile = { ...options, id: "known-profile" };
    await writeFile(path, JSON.stringify({ version: 1, profiles: [profile, profile], pins: [] }), { mode: 0o600 });
    await expect(instance.load()).rejects.toThrow(/Duplicate/u);
    expect(instance.profiles()).toEqual([]);
    expect(instance.pin(options)).toBeUndefined();
  });
});

describe("RdpStore frame previews", () => {
  it("persists private bounded sidecars independently from credentials and reloads them", async () => {
    const instance = store(), profile = await instance.saveProfile(options);
    await instance.saveCredential(profile.id, options, PASSWORD, "secure");
    await instance.savePreview(profile.id, options, RDP_PREVIEW_FIXTURE);
    const files = await readdir(directory), previewPath = join(directory, files.find((file) => file.includes(".preview-"))!);
    expect(await readFile(path, "utf8")).not.toContain("data:image");
    expect(await readFile(previewPath, "utf8")).not.toContain("encryptedCredential");
    expect(await readFile(previewPath, "utf8")).not.toContain(PASSWORD);
    if (process.platform !== "win32") expect((await stat(previewPath)).mode & 0o777).toBe(0o600);
    const reopened = store(); await reopened.load();
    expect(reopened.profile(profile.id)?.preview).toEqual(RDP_PREVIEW_FIXTURE);
    expect(reopened.credential(profile.id, options)).toBe(PASSWORD);
  });

  it.each([{ host: "other.example.test" }, { port: 3390 }, { username: "bob" }, { domain: "OTHER" }])("removes previews when connection identity changes (%j)", async (change) => {
    const instance = store(), profile = await instance.saveProfile(options);
    await instance.savePreview(profile.id, options, RDP_PREVIEW_FIXTURE);
    await instance.saveProfile({ ...options, id: profile.id, label: "Renamed", width: 1280 });
    expect(instance.profile(profile.id)?.preview).toEqual(RDP_PREVIEW_FIXTURE);
    await instance.saveProfile({ ...options, ...change, id: profile.id });
    expect(instance.profile(profile.id)?.preview).toBeUndefined();
    expect(await readdir(directory)).toEqual(["rdp.json"]);
    await expect(instance.savePreview(profile.id, options, RDP_PREVIEW_FIXTURE)).rejects.toThrow("changed");
    const reopened = store(); await reopened.load();
    expect(reopened.profile(profile.id)?.preview).toBeUndefined();
  });

  it("deletes saved frames with their profile and rejects late saves", async () => {
    const instance = store(), profile = await instance.saveProfile(options);
    await instance.savePreview(profile.id, options, RDP_PREVIEW_FIXTURE);
    await instance.deleteProfile(profile.id);
    expect(await readdir(directory)).toEqual(["rdp.json"]);
    await expect(instance.savePreview(profile.id, options, RDP_PREVIEW_FIXTURE)).rejects.toThrow("changed");
  });

  it("keeps the previous preview after write failure or a stale attempt detected before commit", async () => {
    const instance = store(), profile = await instance.saveProfile(options);
    await instance.savePreview(profile.id, options, RDP_PREVIEW_FIXTURE);
    const replacement = { ...RDP_PREVIEW_FIXTURE, capturedAt: "2026-10-20T12:00:00.000Z" };
    vi.spyOn(secureFile, "writePrivateFileAtomic").mockRejectedValueOnce(new Error("disk failure"));
    await expect(instance.savePreview(profile.id, options, replacement)).rejects.toThrow("disk failure");
    const current = vi.fn().mockImplementationOnce(() => undefined).mockImplementation(() => { throw new Error("stale attempt"); });
    await expect(instance.savePreview(profile.id, options, replacement, current)).rejects.toThrow("stale attempt");
    expect(instance.profile(profile.id)?.preview).toEqual(RDP_PREVIEW_FIXTURE);
    const reopened = store(); await reopened.load();
    expect(reopened.profile(profile.id)?.preview).toEqual(RDP_PREVIEW_FIXTURE);
  });

  it("keeps saved connections unchanged when preview cleanup fails", async () => {
    const instance = store(), profile = await instance.saveProfile(options);
    await instance.savePreview(profile.id, options, RDP_PREVIEW_FIXTURE);
    const previewPath = join(directory, (await readdir(directory)).find((file) => file.includes(".preview-"))!);
    await rm(previewPath); await mkdir(previewPath);
    await expect(instance.deleteProfile(profile.id)).rejects.toThrow("preview could not be removed");
    await expect(instance.saveProfile({ ...options, id: profile.id, host: "other.test" })).rejects.toThrow("preview could not be removed");
    expect(instance.profile(profile.id)?.host).toBe(options.host);
    expect(instance.profile(profile.id)?.preview).toEqual(RDP_PREVIEW_FIXTURE);
    const reopened = store(); await reopened.load();
    expect(reopened.profile(profile.id)?.host).toBe(options.host);
  });

  it("loads legacy profiles and ignores corrupt, unsafe, or identity-mismatched preview caches", async () => {
    const instance = store(), profile = await instance.saveProfile(options);
    const legacy = store(); await legacy.load();
    expect(legacy.profile(profile.id)?.preview).toBeUndefined();
    await instance.savePreview(profile.id, options, RDP_PREVIEW_FIXTURE);
    const previewPath = join(directory, (await readdir(directory)).find((file) => file.includes(".preview-"))!);
    const original = await readFile(previewPath, "utf8");
    for (const data of ["{broken", JSON.stringify({ ...JSON.parse(original), identity: "another account" })]) {
      await writeFile(previewPath, data);
      const reopened = store(); await reopened.load();
      expect(reopened.profile(profile.id)?.label).toBe(options.label);
      expect(reopened.profile(profile.id)?.preview).toBeUndefined();
    }
    await rm(previewPath);
    await symlink(path, previewPath);
    const linked = store(); await linked.load();
    expect(linked.profile(profile.id)?.preview).toBeUndefined();
    await rm(previewPath);
    await writeFile(previewPath, original, { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(previewPath, 0o644);
      const unsafe = store(); await unsafe.load();
      expect(unsafe.profile(profile.id)?.preview).toBeUndefined();
    }
  });
});
