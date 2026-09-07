// @vitest-environment node

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SshHostKeyStore } from "./ssh-host-key-store.js";

const deploymentId = "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0001";
const fingerprint = `SHA256:${"A".repeat(43)}`;

let directory = "";
let filePath = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sliver-gui-ssh-host-keys-"));
  filePath = join(directory, "ssh-host-keys.json");
});

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("SshHostKeyStore", () => {
  it("starts empty only when the file is absent and persists a private deterministic pin", async () => {
    const store = await SshHostKeyStore.load(filePath);
    expect(store.get(deploymentId)).toBeUndefined();

    await store.remember(deploymentId, fingerprint);

    expect(store.get(deploymentId)).toBe(fingerprint);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      v: 1,
      fingerprints: { [deploymentId]: fingerprint },
    });
    const loaded = await SshHostKeyStore.load(filePath);
    expect(loaded.get(deploymentId)).toBe(fingerprint);
  });

  it("never silently replaces a deployment pin", async () => {
    const store = await SshHostKeyStore.load(filePath);
    await store.remember(deploymentId, fingerprint);
    await expect(store.remember(deploymentId, `SHA256:${"B".repeat(43)}`))
      .rejects.toThrow("did not match");
    expect(store.get(deploymentId)).toBe(fingerprint);
  });

  it("fails closed for corrupt or permission-weakened existing state", async () => {
    await writeFile(filePath, "not-json", { mode: 0o600 });
    await expect(SshHostKeyStore.load(filePath)).rejects.toThrow("corrupt or unavailable");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o644);
      await expect(SshHostKeyStore.load(filePath)).rejects.toThrow("corrupt or unavailable");
    }
  });
});
