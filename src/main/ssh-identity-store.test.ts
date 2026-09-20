// @vitest-environment node

import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalSshIdentityBaseName,
  SshIdentityStore,
  sshIdentityFileName,
} from "./ssh-identity-store.js";

const DEPLOYMENT_ID = "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0001";
const FIRST_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nfirst exact private material\n-----END OPENSSH PRIVATE KEY-----\n";
const SECOND_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nsecond exact private material\n-----END OPENSSH PRIVATE KEY-----\n";
const PPK_KEY = "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: aes256-cbc\nPrivate-Lines: 1\nAAAA\n";

let temporaryDirectory = "";
let identityRoot = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-gui-ssh-identities-"));
  identityRoot = join(temporaryDirectory, "home", ".ssh", "sliver-gui");
});

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("SSH identity filenames", () => {
  it("keeps a safe unique name exact and adds the full deployment UUID only for a collision", () => {
    expect(canonicalSshIdentityBaseName("test1")).toBe("test1");
    expect(sshIdentityFileName("test1", DEPLOYMENT_ID)).toBe("test1");
    expect(sshIdentityFileName("test1", DEPLOYMENT_ID, true))
      .toBe(`test1--${DEPLOYMENT_ID}`);
  });

  it("creates portable ASCII slugs with case-insensitive and NFC-stable collision keys", () => {
    expect(canonicalSshIdentityBaseName("  ../../T\u00e9st Server ")).toBe("test-server");
    expect(canonicalSshIdentityBaseName("T\u00c9ST")).toBe(
      canonicalSshIdentityBaseName("te\u0301st"),
    );
    expect(canonicalSshIdentityBaseName("CON")).toBe("ssh-con");
    expect(canonicalSshIdentityBaseName("con.txt")).toBe("ssh-con.txt");
    expect(canonicalSshIdentityBaseName("LPT1")).toBe("ssh-lpt1");
    expect(canonicalSshIdentityBaseName("\ud83d\udd10")).toBe("ssh-key");
  });
});

describe("SshIdentityStore", () => {
  it("materializes exact stored bytes at the expected private path", async () => {
    const store = new SshIdentityStore(identityRoot);
    const result = await store.materialize({
      managedName: "test1",
      deploymentId: DEPLOYMENT_ID,
      privateKey: FIRST_KEY,
    });

    expect(result).toEqual({
      filePath: join(identityRoot, "test1"),
      commandPath: "~/.ssh/sliver-gui/test1",
    });
    expect(await readFile(result.filePath, "utf8")).toBe(FIRST_KEY);
    if (process.platform !== "win32") {
      expect((await stat(identityRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(result.filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("atomically refreshes the same managed path on repeated copies", async () => {
    const store = new SshIdentityStore(identityRoot);
    const input = { managedName: "test1", deploymentId: DEPLOYMENT_ID, privateKey: FIRST_KEY };
    const first = await store.materialize(input);
    const second = await store.materialize({ ...input, privateKey: SECOND_KEY });

    expect(second).toEqual(first);
    expect(await readFile(second.filePath, "utf8")).toBe(SECOND_KEY);
    expect((await readdir(identityRoot)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects PPK input instead of converting or decrypting it", async () => {
    const store = new SshIdentityStore(identityRoot);
    await expect(store.materialize({
      managedName: "test1",
      deploymentId: DEPLOYMENT_ID,
      privateKey: PPK_KEY,
    })).rejects.toThrow(/PuTTY PPK/u);
    await expect(lstat(identityRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a root occupied by a regular file", async () => {
    await mkdir(join(temporaryDirectory, "home", ".ssh"), { recursive: true });
    await writeFile(identityRoot, "not a directory");
    const store = new SshIdentityStore(identityRoot);
    await expect(store.materialize({
      managedName: "test1",
      deploymentId: DEPLOYMENT_ID,
      privateKey: FIRST_KEY,
    })).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")("rejects a symlink identity root", async () => {
    const target = join(temporaryDirectory, "elsewhere");
    const parent = join(temporaryDirectory, "home", ".ssh");
    await mkdir(target, { recursive: true });
    await mkdir(parent, { recursive: true });
    await symlink(target, identityRoot);
    const store = new SshIdentityStore(identityRoot);
    await expect(store.materialize({
      managedName: "test1",
      deploymentId: DEPLOYMENT_ID,
      privateKey: FIRST_KEY,
    })).rejects.toThrow(/regular directory/u);
    expect(await readdir(target)).toEqual([]);
  });

  it("requires an absolute bounded store root", () => {
    expect(() => new SshIdentityStore("relative/identities")).toThrow(/absolute bounded/u);
  });
});
