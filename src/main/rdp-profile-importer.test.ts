// @vitest-environment node
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importRdpProfiles, rdpImportPaths } from "./rdp-profile-importer.js";
import { rdpFilesFromArguments } from "./rdp-open-files.js";
import { RdpStore } from "./rdp-store.js";

let directory: string, store: RdpStore;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "rdp-import-"));
  store = new RdpStore(join(directory, "profiles.json"), { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => "basic_text", encryptString: () => { throw new Error("Unavailable"); }, decryptString: () => { throw new Error("Unavailable"); } }, "linux");
});
afterEach(async () => { store.dispose(); await rm(directory, { recursive: true, force: true }); });

describe("RDP file opening", () => {
  it("extracts bounded file arguments without interpreting URLs or flags", () => {
    expect(rdpFilesFromArguments(["electron", "--other.rdp", "https://host/file.rdp", "desktop.rdp", "desktop.rdp", "x.txt"], directory)).toEqual([join(directory, "desktop.rdp")]);
    expect(rdpFilesFromArguments(Array.from({ length: 40 }, (_, i) => `${i}.rdp`), directory)).toHaveLength(32);
  });
  it("rejects malformed or unbounded path batches", () => {
    for (const paths of [[], ["relative.rdp"], [join(directory, "file.txt")], Array(33).fill(join(directory, "a.rdp")), [1]]) expect(() => rdpImportPaths(paths)).toThrow();
  });
  it("imports valid profiles once per path and reports failures per file", async () => {
    const good = join(directory, "Lab desktop.rdp"), bad = join(directory, "broken.rdp");
    await writeFile(good, "full address:s:lab.test:3390\r\nredirectclipboard:i:1\r\npassword 51:b:NEVER_IMPORT_THIS\r\n");
    await writeFile(bad, "username:s:alice");
    const result = await importRdpProfiles([good, bad, good], store, () => undefined);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.profile).toMatchObject({ label: "Lab desktop", host: "lab.test", port: 3390, username: "", clipboard: true, hasCredential: false });
    expect(result.items[0]?.warnings.length).toBeGreaterThan(0);
    expect(result.items[1]?.error).toMatch(/full address/);
    expect(store.profiles()).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("NEVER_IMPORT_THIS");
    expect(JSON.stringify(result)).not.toContain(directory);
  });
  it("rejects symlinks and oversized files without following or persisting them", async () => {
    const file = join(directory, "large.rdp"), link = join(directory, "linked.rdp"), valid = join(directory, "valid.rdp");
    await writeFile(valid, "full address:s:lab.test");
    await writeFile(file, Buffer.alloc(256 * 1024 + 1)); await symlink(valid, link);
    const result = await importRdpProfiles([link, file], store, () => undefined);
    expect(result.items.every((item) => Boolean(item.error))).toBe(true);
    expect(store.profiles()).toHaveLength(0);
  });
  it("keeps storage paths out of per-file save errors", async () => {
    const file = join(directory, "desktop.rdp"); await writeFile(file, "full address:s:lab.test");
    vi.spyOn(store, "saveProfile").mockRejectedValueOnce(new Error(`EACCES: ${directory}/private-settings.json`));
    const result = await importRdpProfiles([file], store, () => undefined);
    expect(result.items[0]?.error).toMatch(/Could not save/);
    expect(JSON.stringify(result)).not.toContain(directory);
  });
  it("rechecks the caller after reading before saving", async () => {
    const file = join(directory, "desktop.rdp"); await writeFile(file, "full address:s:lab.test");
    const current = vi.fn().mockImplementationOnce(() => undefined).mockImplementation(() => { throw new Error("Window closed"); });
    await expect(importRdpProfiles([file], store, current)).rejects.toThrow("Window closed");
    expect(store.profiles()).toHaveLength(0);
  });
});
