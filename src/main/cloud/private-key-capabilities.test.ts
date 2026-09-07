// @vitest-environment node

import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it } from "vitest";

import { PrivateKeyCapabilities } from "./private-key-capabilities.js";

const token = "8e577480-5dc2-4dde-aa58-23c8f1770627";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SSH private-key capabilities", () => {
  it("returns only an opaque one-shot token and derives the public key in main", async () => {
    const path = await privateKeyFile();
    const capabilities = new PrivateKeyCapabilities({
      idFactory: () => token,
      selectFile: async () => path,
    });

    await expect(capabilities.choose({} as BrowserWindow)).resolves.toEqual({
      ok: true,
      value: { token, fileName: "id_ed25519" },
    });
    const resolved = capabilities.consume(token, null);
    expect(resolved.privateKey).toContain("PRIVATE KEY-----");
    expect(resolved.publicKey).toMatch(/^ssh-rsa [A-Za-z0-9+/]+=* sliver-gui$/u);
    expect(() => capabilities.consume(token, null)).toThrow(/invalid or expired/);
  });

  it("refuses non-key material without issuing a capability", async () => {
    const root = await testDirectory();
    const path = join(root, "notes.txt");
    await writeFile(path, "not a key", { mode: 0o600 });
    const capabilities = new PrivateKeyCapabilities({
      idFactory: () => token,
      selectFile: async () => path,
    });

    await expect(capabilities.choose({} as BrowserWindow)).resolves.toEqual({
      ok: false,
      error: "The selected file is not a supported SSH private key",
    });
    expect(() => capabilities.consume(token, null)).toThrow(/invalid or expired/);
  });

  it("expires capabilities before secret resolution", async () => {
    const path = await privateKeyFile();
    let now = 0;
    const capabilities = new PrivateKeyCapabilities({
      idFactory: () => token,
      now: () => now,
      selectFile: async () => path,
    });
    await capabilities.choose({} as BrowserWindow);
    now = 11 * 60 * 1000;
    expect(() => capabilities.consume(token, null)).toThrow(/invalid or expired/);
  });
});

async function privateKeyFile(): Promise<string> {
  const root = await testDirectory();
  const path = join(root, "id_ed25519");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(path, privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
  return path;
}

async function testDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sliver-cloud-key-test-"));
  roots.push(root);
  return root;
}
