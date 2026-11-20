import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { BEAGLE_OUTPUT_DIRECTORY, BEAGLE_PACKAGED_RECORD, BEAGLE_SOURCE_MANIFEST, beagleArchiveMembers,
  beagleExecutableName, beagleSourceInputs, beagleTargetForHost, buildBeagleRuntime, sha256, validateBeagleSourceManifest } from "./buildBeagleRuntime.mjs";
import { beagleFixture } from "./beagleTestFixtures.mjs";
import { rdpBinaryArchitectures } from "./verifyRdpRuntime.mjs";

test("Beagle selects universal macOS, host development slices and supported desktop targets", () => {
  assert.equal(beagleTargetForHost("darwin", "arm64"), "darwin-universal");
  assert.equal(beagleTargetForHost("darwin", "x64"), "darwin-universal");
  assert.equal(beagleTargetForHost("darwin", "arm64", true), "darwin-arm64");
  assert.equal(beagleTargetForHost("darwin", "x64", true), "darwin-x64");
  assert.equal(beagleTargetForHost("win32", "x64"), "windows-x64");
  assert.equal(beagleTargetForHost("linux", "x64"), "linux-x64");
  assert.equal(beagleExecutableName("windows-x64"), "beagle.exe");
  assert.equal(beagleExecutableName("darwin-universal"), "beagle");
  for (const [platform, architecture] of [["win32", "arm64"], ["linux", "arm64"], ["freebsd", "x64"]]) {
    assert.throws(() => beagleTargetForHost(platform, architecture), /does not support/u);
  }
  assert.throws(() => beagleExecutableName("unsupported"), /Unsupported Beagle target/u);
});

test("source manifest requires fixed repository, exact tag, complete unique targets and SHA-256 pins", async (context) => {
  const { manifest } = await beagleFixture(context);
  assert.equal(validateBeagleSourceManifest(manifest), manifest);
  for (const mutate of [
    (pin) => { pin.source.repository = "https://example.com/Beagle"; },
    (pin) => { pin.source.commit = "main"; }, (pin) => { pin.source.tree = "HEAD"; },
    (pin) => { pin.release.tag = "latest"; }, (pin) => { pin.toolchain.rust = "stable"; },
    (pin) => { pin.protocolVersion = 2; }, (pin) => { pin.release.assets.pop(); },
    (pin) => { pin.release.assets[1] = pin.release.assets[0]; },
    (pin) => { pin.release.assets[0].url = "https://example.com/replacement.tar.gz"; },
    (pin) => { pin.release.assets[0].fileName = "../beagle.tar.gz"; },
    (pin) => { pin.release.assets[0].sha256 = "a".repeat(63); },
    (pin) => { pin.release.assets[0].binarySha256 = "g".repeat(64); },
  ]) {
    const changed = structuredClone(manifest); mutate(changed);
    assert.throws(() => validateBeagleSourceManifest(changed), /Invalid pinned Beagle/u);
  }
});

test("archive inventory rejects alternate roots, traversal, duplicates and unsupported members", () => {
  const root = "beagle-0.1.0-x86_64-unknown-linux-gnu";
  assert.deepEqual(beagleArchiveMembers(`${root}/\n${root}/beagle\n${root}/licenses/engine/LICENSE\n`, root), ["beagle", "licenses/engine/LICENSE"]);
  for (const listing of ["other/beagle", `${root}/../beagle`, `${root}/./beagle`, `${root}//beagle`,
    `${root}/licenses\\outside`, `${root}/beagle\n${root}/beagle`, `${root}/unexpected.so`, `${root}/licenses/invalid\u0000name`]) {
    assert.throws(() => beagleArchiveMembers(listing, root), /archive (root|member)/u);
  }
  assert.throws(() => beagleArchiveMembers(Array.from({ length: 513 }, (_, index) => `${root}/licenses/${index}`).join("\n"), root), /Too many/u);
});

test("archive provenance binds the release to pinned source, toolchain, protocol and executable bytes", async (context) => {
  const fixture = await beagleFixture(context);
  const asset = fixture.manifest.release.assets.at(-1);
  const files = fixture.releaseFiles.get(asset.target);
  const original = files.get("BUILD-PROVENANCE.json");
  await fixture.readArchive("archive.tar.gz", asset, fixture.manifest);
  for (const [key, value] of [["commit", "c".repeat(40)], ["tree", "c".repeat(40)], ["tag", "latest"], ["target", "aarch64-apple-darwin"],
    ["rust_toolchain", "nightly"], ["helper_protocol", 2], ["version", "0.1.1"], ["project", "other"]]) {
    files.set("BUILD-PROVENANCE.json", Buffer.from(JSON.stringify({ ...JSON.parse(original), [key]: value })));
    await assert.rejects(fixture.readArchive("archive.tar.gz", asset, fixture.manifest), /pinned source, toolchain or binary digest/u);
  }
  files.set("BUILD-PROVENANCE.json", original);
  files.set("beagle", Buffer.from("replacement executable"));
  await assert.rejects(fixture.readArchive("archive.tar.gz", asset, fixture.manifest), /binary digest/u);
  files.delete("LICENSE");
  await assert.rejects(fixture.readArchive("archive.tar.gz", asset, fixture.manifest), /Missing Beagle release member: LICENSE/u);
});

test("source inputs include preparation scripts and exclude generated helper and trust anchor", async (context) => {
  const fixture = await beagleFixture(context);
  const inputs = await beagleSourceInputs(fixture.root);
  await buildBeagleRuntime(fixture.options);
  assert.deepEqual(await beagleSourceInputs(fixture.root), inputs);
  await writeFile(join(fixture.root, "scripts/verifyBeagleRuntime.mjs"), "changed verification policy");
  assert.notDeepEqual(await beagleSourceInputs(fixture.root), inputs);
});

test("universal assembly records both release slices, complete license inventory and matching ASAR anchor", async (context) => {
  const fixture = await beagleFixture(context);
  const { record, executablePath } = await buildBeagleRuntime({ ...fixture.options, platform: "darwin", architecture: "arm64" });
  assert.equal(record.build.target, "darwin-universal");
  assert.deepEqual(record.build.slices.map(({ target }) => target), ["x86_64-apple-darwin", "aarch64-apple-darwin"]);
  const executable = await readFile(executablePath);
  assert.deepEqual(rdpBinaryArchitectures(executable).sort(), ["aarch64-apple-darwin", "x86_64-apple-darwin"]);
  assert.equal(record.artifact.sha256, sha256(executable));
  assert.equal(record.buildIdentity, sha256(JSON.stringify({ manifest: fixture.manifest, inputs: record.inputs })));
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].command, "/usr/bin/lipo");
  assert.equal(fixture.calls[0].args[0], "-create");
  assert.equal(fixture.downloads.length, 2);
  for (const entry of record.supportFiles) {
    const bytes = await readFile(join(fixture.root, BEAGLE_OUTPUT_DIRECTORY, entry.path));
    assert.equal(sha256(bytes), entry.sha256); assert.equal(bytes.length, entry.size);
  }
  const inventory = await readFile(join(fixture.root, BEAGLE_OUTPUT_DIRECTORY, "THIRD_PARTY_LICENSES.txt"));
  assert.match(inventory.toString(), /Beagle GPL license/u);
  assert.match(inventory.toString(), /Graph engine MIT license/u);
  assert.equal(record.licenseInventorySha256, sha256(inventory));
  assert.deepEqual(await readFile(join(fixture.root, BEAGLE_PACKAGED_RECORD)), await readFile(join(fixture.root, BEAGLE_OUTPUT_DIRECTORY, "provenance.json")));
  assert.ok((await readdir(join(fixture.root, BEAGLE_OUTPUT_DIRECTORY))).every((name) => !name.startsWith("x86_64-") && !name.startsWith("aarch64-")));
});

test("verified release archives are reused, and a corrupted cache is fetched and checked again", async (context) => {
  const fixture = await beagleFixture(context);
  await buildBeagleRuntime(fixture.options);
  await buildBeagleRuntime({ ...fixture.options, fetchBytes: async () => { throw new Error("unexpected download"); } });
  const asset = fixture.manifest.release.assets.at(-1);
  await writeFile(join(fixture.root, "native/beagle/cache", `${asset.sha256}-${asset.fileName}`), "corrupt cache");
  await buildBeagleRuntime(fixture.options);
  assert.equal(fixture.downloads.length, 2);
});

async function assertInvalidated(root) {
  for (const path of [BEAGLE_PACKAGED_RECORD, `${BEAGLE_OUTPUT_DIRECTORY}/provenance.json`]) await assert.rejects(readFile(join(root, path)), { code: "ENOENT" });
  assert.ok((await readdir(join(root, "native/beagle/cache"))).every((name) => !name.startsWith("stage-")));
}

test("failed download or archive digest invalidates stale build success and ASAR anchors", async (context) => {
  const fixture = await beagleFixture(context);
  await buildBeagleRuntime(fixture.options);
  const asset = fixture.manifest.release.assets.at(-1);
  const cached = join(fixture.root, "native/beagle/cache", `${asset.sha256}-${asset.fileName}`);
  await writeFile(cached, "corrupt cache");
  await assert.rejects(buildBeagleRuntime({ ...fixture.options, fetchBytes: async () => Buffer.from("untrusted download") }), /archive checksum mismatch/u);
  await assertInvalidated(fixture.root);
  await buildBeagleRuntime(fixture.options);
  await writeFile(cached, "corrupt cache");
  await assert.rejects(buildBeagleRuntime({ ...fixture.options, fetchBytes: async () => { throw new Error("network unavailable"); } }), /network unavailable/u);
  await assertInvalidated(fixture.root);
});

test("changed invalid release pin and universal assembly failure cannot leave a stale success anchor", async (context) => {
  const fixture = await beagleFixture(context);
  await buildBeagleRuntime(fixture.options);
  await writeFile(join(fixture.root, BEAGLE_SOURCE_MANIFEST), JSON.stringify({ ...fixture.manifest, protocolVersion: 2 }));
  await assert.rejects(buildBeagleRuntime(fixture.options), /Invalid pinned/u);
  await assertInvalidated(fixture.root);
  await writeFile(join(fixture.root, BEAGLE_SOURCE_MANIFEST), JSON.stringify(fixture.manifest));
  await buildBeagleRuntime(fixture.options);
  await assert.rejects(buildBeagleRuntime({ ...fixture.options, platform: "darwin", architecture: "arm64", run: async () => { throw new Error("lipo failed"); } }), /lipo failed/u);
  await assertInvalidated(fixture.root);
});

test("the builder rechecks executable digest even when an injected archive reader returns altered bytes", async (context) => {
  const fixture = await beagleFixture(context);
  await assert.rejects(buildBeagleRuntime({ ...fixture.options, readArchive: async () => ({ binaryName: "beagle", files: new Map([["beagle", Buffer.from("replacement")]]) }) }), /executable checksum mismatch/u);
  await assertInvalidated(fixture.root);
});
