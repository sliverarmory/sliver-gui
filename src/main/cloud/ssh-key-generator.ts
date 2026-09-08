import ssh2 from "ssh2";

import { CLOUD_SSH_PRIVATE_KEY_MAX_LENGTH } from "../../shared/cloud-deployment-contracts.js";
import type { ResolvedPrivateKey } from "./private-key-capabilities.js";

const { generateKeyPairSync, parseKey } = ssh2.utils;
const GENERATED_KEY_COMMENT = "sliver-gui";
const MAX_GENERATION_ATTEMPTS = 5;

/**
 * Generates a main-process-only Ed25519 key using ssh2's Node crypto wrapper.
 * The synchronous Ed25519 primitive avoids depending on the shared libuv
 * worker pool, which can be saturated by unrelated application work. ssh2
 * emits the OpenSSH private-key form its own client can consume, without
 * shelling out to ssh-keygen or writing plaintext to disk.
 */
export async function generateEd25519SshKeyPair(): Promise<ResolvedPrivateKey> {
  try {
    // ssh2 can discard a legitimate leading zero byte while serializing an
    // Ed25519 public key. Generate a fresh pair when validation catches an
    // unusable result, but keep persistent failures bounded.
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const generated = generateKeyPairSync("ed25519", { comment: GENERATED_KEY_COMMENT });
      if (
        typeof generated.private !== "string" ||
        generated.private.length < 32 ||
        generated.private.length > CLOUD_SSH_PRIVATE_KEY_MAX_LENGTH
      ) continue;

      const privateKey = parseKey(generated.private);
      const publicKey = parseKey(generated.public);
      if (
        privateKey instanceof Error ||
        publicKey instanceof Error ||
        privateKey.type !== "ssh-ed25519" ||
        publicKey.type !== "ssh-ed25519" ||
        !privateKey.isPrivateKey() ||
        publicKey.isPrivateKey() ||
        !privateKey.getPublicSSH().equals(publicKey.getPublicSSH())
      ) continue;

      return Object.freeze({
        privateKey: generated.private,
        publicKey: `${privateKey.type} ${privateKey.getPublicSSH().toString("base64")} ${GENERATED_KEY_COMMENT}`,
      });
    }
  } catch {
    throw generationError();
  }
  throw generationError();
}

function generationError(): Error {
  return new Error("Unable to generate a compatible Ed25519 SSH key");
}
