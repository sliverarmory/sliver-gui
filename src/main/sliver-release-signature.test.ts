// @vitest-environment node

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SLIVER_RELEASE_MINISIGN_PUBLIC_KEY,
  verifySliverReleaseMinisign,
} from "./sliver-release-signature.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Sliver release Minisign verification", () => {
  it("verifies a streamed Minisign signature and its signed asset filename", async () => {
    const directory = await testDirectory();
    const fileName = "sliver-server_linux-amd64";
    const artifactPath = join(directory, fileName);
    const artifact = Buffer.from("official test release bytes", "utf8");
    const fixture = signedFixture(artifact, fileName);
    await writeFile(artifactPath, artifact);

    await expect(verifySliverReleaseMinisign(
      artifactPath,
      fixture.signature,
      fileName,
      fixture.publicKey,
    )).resolves.toBeUndefined();
  });

  it("rejects altered artifact bytes and an invalid signature", async () => {
    const directory = await testDirectory();
    const fileName = "sliver-server_linux-arm64";
    const artifactPath = join(directory, fileName);
    const artifact = Buffer.from("signed release bytes", "utf8");
    const fixture = signedFixture(artifact, fileName);
    await writeFile(artifactPath, Buffer.from("altered release byte", "utf8"));

    await expect(verifySliverReleaseMinisign(
      artifactPath,
      fixture.signature,
      fileName,
      fixture.publicKey,
    )).rejects.toThrow(/signature is invalid/u);
  });

  it("rejects a valid signature whose trusted comment names another asset", async () => {
    const directory = await testDirectory();
    const fileName = "sliver-server_linux-amd64";
    const artifactPath = join(directory, fileName);
    const artifact = Buffer.from("signed release bytes", "utf8");
    const fixture = signedFixture(artifact, "sliver-client_linux-amd64");
    await writeFile(artifactPath, artifact);

    await expect(verifySliverReleaseMinisign(
      artifactPath,
      fixture.signature,
      fileName,
      fixture.publicKey,
    )).rejects.toThrow(/does not match the selected asset/u);
  });

  it("uses the same pinned Sliver trust root as the bundled console", () => {
    expect(SLIVER_RELEASE_MINISIGN_PUBLIC_KEY).toBe(
      "RWTZPg959v3b7tLG7VzKHRB1/QT+d3c71Uzetfa44qAoX5rH7mGoQTTR",
    );
  });
});

interface SignedFixture {
  readonly publicKey: string;
  readonly signature: Buffer;
}

function signedFixture(artifact: Uint8Array, fileName: string): SignedFixture {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.from("0102030405060708", "hex");
  const exported = publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = Buffer.from(exported).subarray(-32);
  const minisignPublicKey = Buffer.concat([
    Buffer.from("Ed", "ascii"),
    keyId,
    rawPublicKey,
  ]).toString("base64");

  const digest = createHash("blake2b512").update(artifact).digest();
  const messageSignature = sign(null, digest, privateKey);
  const trustedComment = `timestamp:1788721200\tfile:${fileName}`;
  const commentSignature = sign(
    null,
    Buffer.concat([messageSignature, Buffer.from(trustedComment, "utf8")]),
    privateKey,
  );
  const rawSignature = Buffer.concat([
    Buffer.from("ED", "ascii"),
    keyId,
    messageSignature,
  ]);
  const signature = Buffer.from([
    "untrusted comment: signature from test minisign key",
    rawSignature.toString("base64"),
    `trusted comment: ${trustedComment}`,
    commentSignature.toString("base64"),
    "",
  ].join("\n"), "utf8");
  return { publicKey: minisignPublicKey, signature };
}

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sliver-gui-minisign-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
