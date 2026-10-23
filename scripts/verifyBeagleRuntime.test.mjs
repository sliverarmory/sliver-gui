import assert from "node:assert/strict";
import { chmod, cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { asarEntryPaths } from "./asarEntryPaths.mjs";
import { BEAGLE_OUTPUT_DIRECTORY, BEAGLE_PACKAGED_RECORD, BEAGLE_SOURCE_MANIFEST } from "./buildBeagleRuntime.mjs";
import { builtBeagleFixture } from "./beagleTestFixtures.mjs";
import { nativeBinary, universalBinary } from "./rdpTestFixtures.mjs";
import { assertBeagleArchitecture, validateBeagleBuildRecord, verifyBeagleArchiveRecord,
  verifyBeagleBuildInfo, verifyPackagedBeagleRuntime, verifyPreparedBeagleRuntime } from "./verifyBeagleRuntime.mjs";

test("Beagle architecture verification accepts GNU Windows and requires exact native or universal slices", () => {
  for (const [triple, target] of [["x86_64-apple-darwin", "darwin-x64"], ["aarch64-apple-darwin", "darwin-arm64"],
    ["x86_64-pc-windows-gnu", "windows-x64"], ["x86_64-unknown-linux-gnu", "linux-x64"]]) {
    assertBeagleArchitecture(nativeBinary(triple), target);
  }
  assertBeagleArchitecture(universalBinary(), "darwin-universal");
  assert.throws(() => assertBeagleArchitecture(nativeBinary("aarch64-apple-darwin"), "darwin-universal"), /architectures/u);
  assert.throws(() => assertBeagleArchitecture(nativeBinary("x86_64-unknown-linux-gnu"), "windows-x64"), /architectures/u);
  assert.throws(() => assertBeagleArchitecture(Buffer.from("not an executable"), "linux-x64"), /Unrecognized/u);
  const repeated = universalBinary();
  repeated.writeUInt32BE(0x01000007, 28); repeated.writeUInt32LE(0x01000007, 1028);
  assert.throws(() => assertBeagleArchitecture(repeated, "darwin-universal"), /repeats/u);
});

test("prepared verification accepts every supported packaging target and macOS host slices", async (context) => {
  for (const [platform, architecture, hostOnly] of [["linux", "x64", false], ["win32", "x64", false],
    ["darwin", "arm64", false], ["darwin", "x64", false], ["darwin", "arm64", true], ["darwin", "x64", true]]) {
    const fixture = await builtBeagleFixture(context, platform, architecture, hostOnly);
    const evidence = await verifyPreparedBeagleRuntime(fixture.options);
    assert.deepEqual(evidence.record, fixture.record);
    assert.equal(fixture.commands.length, 1);
    assert.deepEqual(fixture.commands[0].args, ["--build-info"]);
    assert.ok(evidence.supportFiles.has(`licenses/${fixture.record.build.slices[0].target}/licenses/graph/LICENSE`));
  }
});

test("build-info verification rejects mismatched helper name, protocol, version, revision and native target", async (context) => {
  const fixture = await builtBeagleFixture(context);
  for (const field of ["name", "protocol", "version", "beagleRevision", "target"]) {
    const previous = fixture.info[field]; fixture.info[field] = "wrong";
    await assert.rejects(verifyBeagleBuildInfo(fixture.executablePath, fixture.record, fixture.options), /build identity/u);
    fixture.info[field] = previous;
  }
  await verifyBeagleBuildInfo(fixture.executablePath, fixture.record, fixture.options);
});

test("stale ASAR trust anchor, source bytes and build script changes fail before helper execution", async (context) => {
  for (const [path, message] of [[BEAGLE_PACKAGED_RECORD, /ASAR trust anchor/u],
    [`${BEAGLE_OUTPUT_DIRECTORY}/source-provenance.json`, /integrity verification/u],
    ["scripts/buildBeagleRuntime.mjs", /build provenance/u], ["scripts/verifyBeagleRuntime.mjs", /build provenance/u]]) {
    const fixture = await builtBeagleFixture(context);
    await writeFile(join(fixture.root, path), "changed input");
    await assert.rejects(verifyPreparedBeagleRuntime(fixture.options), message);
    assert.equal(fixture.commands.length, 0);
  }
});

test("prepared executable mutation and execute permission loss fail before running the helper", async (context) => {
  const fixture = await builtBeagleFixture(context);
  const original = await readFile(fixture.executablePath);
  const changed = Buffer.from(original); changed[100] ^= 1;
  await writeFile(fixture.executablePath, changed);
  await assert.rejects(verifyPreparedBeagleRuntime(fixture.options), /integrity verification/u);
  await writeFile(fixture.executablePath, original);
  if (process.platform !== "win32") {
    await chmod(fixture.executablePath, 0o644);
    await assert.rejects(verifyPreparedBeagleRuntime(fixture.options), /not executable/u);
  }
  assert.equal(fixture.commands.length, 0);
});

test("prepared verification checks every support file including nested dependency licenses and release provenance", async (context) => {
  const fixture = await builtBeagleFixture(context);
  for (const entry of fixture.record.supportFiles) {
    const path = join(fixture.root, BEAGLE_OUTPUT_DIRECTORY, entry.path);
    const previous = await readFile(path);
    await writeFile(path, "changed support bytes");
    await assert.rejects(verifyPreparedBeagleRuntime(fixture.options), /license\/provenance changed/u);
    assert.equal(fixture.commands.length, 0);
    await writeFile(path, previous);
  }
});

test("build record rejects slice/source drift, unsafe or missing license inventory and altered artifact selection", async (context) => {
  const fixture = await builtBeagleFixture(context);
  const sourceBytes = await readFile(join(fixture.root, BEAGLE_SOURCE_MANIFEST));
  const validate = (record) => validateBeagleBuildRecord(record, fixture.manifest, sourceBytes, fixture.record.inputs, "linux-x64");
  validate(fixture.record);
  for (const mutate of [
    (record) => { record.source.commit = "c".repeat(40); },
    (record) => { record.buildIdentity = "0".repeat(64); },
    (record) => { record.build.slices[0].sha256 = "0".repeat(64); },
    (record) => { record.build.slices[0].target = "aarch64-apple-darwin"; },
    (record) => { record.artifact.fileName = "../beagle"; },
    (record) => { record.supportFiles[0].path = "licenses/../../outside"; },
    (record) => { record.supportFiles[0].path = "licenses\\outside"; },
    (record) => { record.supportFiles.push(record.supportFiles[0]); },
    (record) => { record.supportFiles = record.supportFiles.filter(({ path }) => path !== "LICENSE"); },
    (record) => { record.supportFiles = record.supportFiles.filter(({ path }) => !path.endsWith("BUILD-PROVENANCE.json")); },
  ]) {
    const record = structuredClone(fixture.record); mutate(record);
    assert.throws(() => validate(record), /Beagle (build provenance|slice provenance|license inventory|release license\/provenance)/u);
  }
});

test("top-level license inventory digests cannot disagree with verified support bytes", async (context) => {
  const fixture = await builtBeagleFixture(context);
  for (const field of ["licenseInventorySha256", "projectLicenseSha256"]) {
    const changed = { ...fixture.record, [field]: "0".repeat(64) };
    for (const path of [BEAGLE_PACKAGED_RECORD, `${BEAGLE_OUTPUT_DIRECTORY}/provenance.json`]) await writeFile(join(fixture.root, path), JSON.stringify(changed));
    await assert.rejects(verifyPreparedBeagleRuntime(fixture.options), /license inventory digest mismatch/u);
    assert.equal(fixture.commands.length, 0);
  }
});

test("ASAR provenance lookup supports native separators without following links and requires identical bytes", () => {
  const expected = Buffer.from('{"schemaVersion":1}\n');
  for (const listed of ["/native/beagle/packaged-provenance.json", "\\native\\beagle\\packaged-provenance.json"]) {
    const entries = [asarEntryPaths(listed)];
    let calls = 0;
    verifyBeagleArchiveRecord("app.asar", entries, expected, (archive, lookup, followLinks) => {
      assert.equal(archive, "app.asar"); assert.equal(lookup, listed.slice(1)); assert.equal(followLinks, false);
      calls++; return expected;
    });
    assert.equal(calls, 1);
    assert.throws(() => verifyBeagleArchiveRecord("app.asar", entries, expected, () => Buffer.from('{ "schemaVersion": 1 }\n')), /does not match/u);
  }
  assert.throws(() => verifyBeagleArchiveRecord("app.asar", [], expected, () => { throw new Error("unexpected extraction"); }), /does not match/u);
});

async function packagedFixture(context, platform = "linux") {
  const fixture = await builtBeagleFixture(context, platform);
  const evidence = await verifyPreparedBeagleRuntime(fixture.options);
  const resourcesDirectory = join(fixture.root, "Sliver GUI.app/Contents/Resources");
  await cp(join(fixture.root, BEAGLE_OUTPUT_DIRECTORY), join(resourcesDirectory, "beagle"), { recursive: true });
  const executablePath = join(resourcesDirectory, "beagle", evidence.record.artifact.fileName);
  const options = { ...fixture.options, resourcesDirectory, evidence, environment: {} };
  fixture.commands.length = 0;
  return { ...fixture, executablePath, resourcesDirectory, evidence, options };
}

test("packaging verifies copied provenance and all notices before executing the helper", async (context) => {
  const fixture = await packagedFixture(context);
  await verifyPackagedBeagleRuntime(fixture.options);
  for (const name of ["source-provenance.json", "provenance.json", ...fixture.evidence.supportFiles.keys()]) {
    fixture.commands.length = 0;
    const path = join(fixture.resourcesDirectory, "beagle", name);
    const previous = await readFile(path);
    await writeFile(path, "changed package support file");
    await assert.rejects(verifyPackagedBeagleRuntime(fixture.options), /Packaged Beagle .* changed/u);
    assert.equal(fixture.commands.length, 0);
    await writeFile(path, previous);
  }
});

test("Linux helper replacement and macOS changes before signing are rejected before execution", async (context) => {
  for (const platform of ["linux", "darwin"]) {
    const fixture = await packagedFixture(context, platform);
    const changed = Buffer.from(fixture.evidence.executable); changed[100] ^= 1;
    await writeFile(fixture.executablePath, changed);
    await assert.rejects(verifyPackagedBeagleRuntime({ ...fixture.options, stage: "before-sign" }), /changed before signing/u);
    assert.equal(fixture.commands.length, 0);
  }
});

test("packaging rejects an incompatible binary architecture before invoking signing or helper commands", async (context) => {
  const fixture = await packagedFixture(context);
  await writeFile(fixture.executablePath, nativeBinary("x86_64-pc-windows-gnu"));
  await assert.rejects(verifyPackagedBeagleRuntime(fixture.options), /architectures/u);
  assert.equal(fixture.commands.length, 0);
});

test("macOS signing changes require valid signatures from the application team on both architectures", async (context) => {
  const fixture = await packagedFixture(context, "darwin");
  const changed = Buffer.from(fixture.evidence.executable); changed[100] ^= 1;
  await writeFile(fixture.executablePath, changed);
  const commands = [];
  let mismatched = false;
  const run = async (command, args) => {
    commands.push({ command, args });
    if (args[0] === "--build-info") return { stdout: JSON.stringify(fixture.info), stderr: "" };
    assert.equal(command, "/usr/bin/codesign");
    return { stdout: "", stderr: `TeamIdentifier=${mismatched && args.includes("arm64") ? "OTHER" : "TEAM123"}\n` };
  };
  const options = { ...fixture.options, run, environment: { SLIVER_GUI_REQUIRE_SIGNED_CHILD: "true", APPLE_TEAM_ID: "TEAM123" } };
  await verifyPackagedBeagleRuntime(options);
  assert.deepEqual(commands.filter(({ args }) => args.includes("--architecture")).map(({ args }) => args[args.indexOf("--architecture") + 1]), ["x86_64", "arm64"]);
  assert.deepEqual(commands.at(-1).args, ["--build-info"]);
  commands.length = 0; mismatched = true;
  await assert.rejects(verifyPackagedBeagleRuntime(options), /nested Mach-O signer mismatch/u);
  assert.ok(commands.every(({ args }) => args[0] !== "--build-info"));
});

test("required signatures cannot be skipped for unchanged Windows binaries or unspecified publishers", async (context) => {
  const fixture = await packagedFixture(context, "win32");
  const environment = { SLIVER_GUI_REQUIRE_SIGNED_CHILD: "true", WIN_CSC_PUBLISHER_NAME: "CN=Sliver" };
  const commands = [];
  let publisher = "CN=Sliver";
  const run = async (command, args, options) => {
    commands.push({ command, args, options });
    return { stdout: command === "powershell.exe" ? `CN=Sliver\n${publisher}\n` : JSON.stringify(fixture.info), stderr: "" };
  };
  await verifyPackagedBeagleRuntime({ ...fixture.options, environment, run });
  assert.equal(commands[0].command, "powershell.exe");
  assert.equal(commands[0].options.env.SLIVER_GUI_BEAGLE_HELPER, fixture.executablePath);
  commands.length = 0; publisher = "CN=Other";
  await assert.rejects(verifyPackagedBeagleRuntime({ ...fixture.options, environment, run }), /publisher mismatch/u);
  assert.equal(commands.length, 1);
  await assert.rejects(verifyPackagedBeagleRuntime({ ...fixture.options, environment: { SLIVER_GUI_REQUIRE_SIGNED_CHILD: "true" }, run }), /requires WIN_CSC_PUBLISHER_NAME/u);
});

test("Windows permits only Authenticode fields and its appended certificate before checking the signer", async (context) => {
  const fixture = await packagedFixture(context, "win32");
  const unsigned = fixture.evidence.executable;
  const signed = Buffer.concat([unsigned, Buffer.alloc(16)]);
  signed.writeUInt32LE(123, 152 + 64);
  signed.writeUInt32LE(unsigned.length, 152 + 112 + 4 * 8);
  signed.writeUInt32LE(16, 152 + 112 + 4 * 8 + 4);
  signed.writeUInt32LE(16, unsigned.length);
  signed.writeUInt16LE(0x0200, unsigned.length + 4);
  signed.writeUInt16LE(0x0002, unsigned.length + 6);
  await writeFile(fixture.executablePath, signed);
  const commands = [];
  const run = async (command, args) => {
    commands.push({ command, args });
    return { stdout: command === "powershell.exe" ? "CN=Sliver\nCN=Sliver\n" : JSON.stringify(fixture.info), stderr: "" };
  };
  await verifyPackagedBeagleRuntime({ ...fixture.options, run });
  assert.equal(commands[0].command, "powershell.exe");
  assert.deepEqual(commands[1].args, ["--build-info"]);
  commands.length = 0; signed[100] ^= 1;
  await writeFile(fixture.executablePath, signed);
  await assert.rejects(verifyPackagedBeagleRuntime({ ...fixture.options, run }), /outside Authenticode fields/u);
  assert.equal(commands.length, 0);
});
