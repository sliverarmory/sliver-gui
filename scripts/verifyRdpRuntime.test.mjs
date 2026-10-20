import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildRdpRuntime, RDP_PACKAGED_RECORD } from "./buildRdpRuntime.mjs";
import { nativeBinary, universalBinary, rdpFixture } from "./rdpTestFixtures.mjs";
import { rdpBinaryArchitectures, verifyPreparedRdpRuntime, verifyPackagedRdpRuntime } from "./verifyRdpRuntime.mjs";

test("native parser identifies all supported architectures and rejects malformed or repeated slices", () => {
  for (const target of ["x86_64-apple-darwin", "aarch64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]) {
    assert.deepEqual(rdpBinaryArchitectures(nativeBinary(target)), [target]);
  }
  assert.deepEqual(rdpBinaryArchitectures(universalBinary()), ["aarch64-apple-darwin", "x86_64-apple-darwin"]);
  assert.throws(() => rdpBinaryArchitectures(Buffer.from("oops")), /Unrecognized/u);
  assert.throws(() => rdpBinaryArchitectures(universalBinary().subarray(0, 40)), /Truncated/u);
  const repeated = universalBinary();
  repeated.writeUInt32BE(0x01000007, 28);
  repeated.writeUInt32LE(0x01000007, 1028);
  assert.throws(() => rdpBinaryArchitectures(repeated), /repeats/u);
  const pe = nativeBinary("x86_64-pc-windows-msvc");
  pe.writeUInt32LE(0xfffffff0, 60);
  assert.throws(() => rdpBinaryArchitectures(pe), /Truncated/u);
});

async function builtFixture(context) {
  const fixture = await rdpFixture(context);
  const built = await buildRdpRuntime({ projectDirectory: fixture.root, platform: "linux", architecture: "x64", run: fixture.run, environment: {} });
  const info = { name: "sliver-rdp", protocol: 1, ironrdpRevision: built.record.source.commit,
    target: "x86_64-unknown-linux-gnu", buildIdentity: built.record.buildIdentity };
  const run = async (_command, args) => ({ stdout: JSON.stringify(args[0] === "--build-info" ? info : { ok: true }), stderr: "" });
  const options = { projectDirectory: fixture.root, platform: "linux", architecture: "x64", run };
  return { ...fixture, ...built, info, options };
}

test("prepared verification binds native ABI to source, lockfile, binary and license bytes", async (context) => {
  const fixture = await builtFixture(context);
  await verifyPreparedRdpRuntime(fixture.options);
  fixture.info.protocol = 2;
  await assert.rejects(verifyPreparedRdpRuntime(fixture.options), /identity\/ABI/u);
  fixture.info.protocol = 1;
  await writeFile(join(fixture.root, "native/rdp/src/main.rs"), "changed source");
  await assert.rejects(verifyPreparedRdpRuntime(fixture.options), /provenance/u);
});

test("prepared verification rejects a stale ASAR trust anchor before executing the helper", async (context) => {
  const fixture = await builtFixture(context);
  await writeFile(join(fixture.root, RDP_PACKAGED_RECORD), "stale archive anchor");
  await assert.rejects(verifyPreparedRdpRuntime({ ...fixture.options,
    run: async () => { throw new Error("Unexpected helper execution"); },
  }), /ASAR trust anchor/u);
});

test("packaging rejects changed native bytes and altered notices without running a changed binary", async (context) => {
  const fixture = await builtFixture(context);
  const evidence = await verifyPreparedRdpRuntime(fixture.options);
  const resourcesDirectory = join(fixture.root, "packaged/resources");
  await mkdir(join(resourcesDirectory, "rdp"), { recursive: true });
  for (const name of ["sliver-rdp", "provenance.json", "source-provenance.json", "LICENSE", "THIRD_PARTY_LICENSES.txt"]) {
    await copyFile(join(fixture.root, "native/rdp/bin", name), join(resourcesDirectory, "rdp", name));
  }
  await chmod(join(resourcesDirectory, "rdp/sliver-rdp"), 0o755);
  const options = { ...fixture.options, resourcesDirectory, evidence, environment: { CSC_IDENTITY_AUTO_DISCOVERY: "false" } };
  await verifyPackagedRdpRuntime(options);
  const executable = await readFile(join(resourcesDirectory, "rdp/sliver-rdp"));
  executable[100] ^= 1;
  await writeFile(join(resourcesDirectory, "rdp/sliver-rdp"), executable);
  await assert.rejects(verifyPackagedRdpRuntime(options), /changed before signing/u);
  await writeFile(join(resourcesDirectory, "rdp/sliver-rdp"), evidence.executable);
  await writeFile(join(resourcesDirectory, "rdp/THIRD_PARTY_LICENSES.txt"), "incomplete inventory");
  await assert.rejects(verifyPackagedRdpRuntime(options), /THIRD_PARTY_LICENSES.txt changed/u);
});
