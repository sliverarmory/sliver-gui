// @vitest-environment node

import ssh2 from "ssh2";
import { describe, expect, it } from "vitest";

import { generateEd25519SshKeyPair } from "./ssh-key-generator.js";

const { parseKey } = ssh2.utils;

describe("Ed25519 SSH key generation", () => {
  it("generates a unique OpenSSH key pair that the provisioning SSH stack can use", async () => {
    const [first, second] = await Promise.all([
      generateEd25519SshKeyPair(),
      generateEd25519SshKeyPair(),
    ]);

    expect(first.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/u);
    expect(first.privateKey).not.toBe(second.privateKey);
    expect(first.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* sliver-gui$/u);
    expect(Object.isFrozen(first)).toBe(true);

    const privateKey = parseKey(first.privateKey);
    const publicKey = parseKey(first.publicKey);
    if (privateKey instanceof Error || publicKey instanceof Error) {
      throw new Error("Generated key material was not parseable");
    }

    expect(privateKey.type).toBe("ssh-ed25519");
    expect(privateKey.isPrivateKey()).toBe(true);
    expect(privateKey.getPublicSSH().equals(publicKey.getPublicSSH())).toBe(true);
    const message = Buffer.from("sliver-gui generated SSH key test", "utf8");
    expect(publicKey.verify(message, privateKey.sign(message))).toBe(true);
  });
});
