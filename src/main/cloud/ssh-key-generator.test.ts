// @vitest-environment node

import ssh2 from "ssh2";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ssh2", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof ssh2 }>();
  return {
    ...actual,
    default: {
      ...actual.default,
      utils: {
        ...actual.default.utils,
        generateKeyPairSync: vi.fn(actual.default.utils.generateKeyPairSync),
      },
    },
  };
});

import { generateEd25519SshKeyPair } from "./ssh-key-generator.js";

const { parseKey } = ssh2.utils;
const generateKeyPair = vi.mocked(ssh2.utils.generateKeyPairSync);
const GENERATION_ERROR = "Unable to generate a compatible Ed25519 SSH key";

beforeEach(() => {
  generateKeyPair.mockReset();
});

async function usablePair(): Promise<{ private: string; public: string }> {
  const generated = await generateEd25519SshKeyPair();
  generateKeyPair.mockClear();
  return { private: generated.privateKey, public: generated.publicKey };
}

describe("Ed25519 SSH key generation", () => {
  it("generates a unique OpenSSH key pair that the provisioning SSH stack can use", async () => {
    const [first, second] = await Promise.all([
      generateEd25519SshKeyPair(),
      generateEd25519SshKeyPair(),
    ]);

    expect(first.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(first.privateKey !== second.privateKey).toBe(true);
    expect(/^ssh-ed25519 [A-Za-z0-9+/]+=* sliver-gui$/u.test(first.publicKey)).toBe(true);
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

  it.each(["short private key", "unparseable private key", "unparseable public key"])(
    "generates a fresh pair after an unusable result: %s",
    async (failure) => {
      const valid = await usablePair();
      const unusable = { ...valid };
      if (failure === "short private key") unusable.private = "invalid";
      if (failure === "unparseable private key") unusable.private = "invalid private key".padEnd(64, "!");
      if (failure === "unparseable public key") unusable.public = "invalid public key";
      generateKeyPair.mockReturnValueOnce(unusable).mockReturnValueOnce(valid);

      const result = await generateEd25519SshKeyPair();

      expect(result.privateKey === valid.private).toBe(true);
      expect(result.publicKey === valid.public).toBe(true);
      expect(generateKeyPair).toHaveBeenCalledTimes(2);
      expect(generateKeyPair).toHaveBeenNthCalledWith(1, "ed25519", { comment: "sliver-gui" });
      expect(generateKeyPair).toHaveBeenNthCalledWith(2, "ed25519", { comment: "sliver-gui" });
    },
  );

  it("rejects a mismatched pair and returns the next validated pair", async () => {
    const first = await usablePair();
    const second = await usablePair();
    generateKeyPair
      .mockReturnValueOnce({ private: first.private, public: second.public })
      .mockReturnValueOnce(second);

    const result = await generateEd25519SshKeyPair();

    expect(result.privateKey === second.private).toBe(true);
    expect(result.publicKey === second.public).toBe(true);
    expect(generateKeyPair).toHaveBeenCalledTimes(2);
  });

  it("stops after five unusable results without exposing rejected key material", async () => {
    generateKeyPair.mockReturnValue({
      private: "rejected-private-material".padEnd(64, "!"),
      public: "rejected-public-material",
    });

    const error: unknown = await generateEd25519SshKeyPair().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(GENERATION_ERROR);
    expect(error).not.toHaveProperty("cause");
    expect(generateKeyPair).toHaveBeenCalledTimes(5);
  });

  it("keeps an underlying generation exception generic without retrying", async () => {
    generateKeyPair.mockImplementationOnce(() => {
      throw new Error("backend failure with rejected-private-material");
    });

    const error: unknown = await generateEd25519SshKeyPair().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(GENERATION_ERROR);
    expect(error).not.toHaveProperty("cause");
    expect(generateKeyPair).toHaveBeenCalledOnce();
  });
});
