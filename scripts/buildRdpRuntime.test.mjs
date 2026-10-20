import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  buildRdpRuntime, cargoLicenseInventory, RDP_PACKAGED_RECORD, rdpBuildEnvironment, rdpSourceInputs, rdpTargetForHost, selectedCargoPackages, sha256, verifyIronRdpPatchInventory, verifyIronRdpCheckout,
} from "./buildRdpRuntime.mjs";
import { fixtureManifest, rdpFixture } from "./rdpTestFixtures.mjs";

test("RDP builds the complete GUI target matrix and rejects unsupported architectures", () => {
  assert.equal(rdpTargetForHost("darwin", "arm64"), "darwin-universal");
  assert.equal(rdpTargetForHost("darwin", "x64"), "darwin-universal");
  assert.equal(rdpTargetForHost("darwin", "arm64", true), "darwin-arm64");
  assert.equal(rdpTargetForHost("win32", "x64"), "windows-x64");
  assert.equal(rdpTargetForHost("linux", "x64"), "linux-x64");
  for (const [platform, architecture] of [["linux", "arm64"], ["win32", "arm64"], ["freebsd", "x64"]]) {
    assert.throws(() => rdpTargetForHost(platform, architecture), /does not support/u);
  }
});

test("build environment excludes credentials and ambient Rust flags and pins static Windows CRT", () => {
  const env = rdpBuildEnvironment({ PATH: "/bin", HOME: "/home/test", "ProgramFiles(x86)": "C:\\Program Files (x86)", AWS_SECRET_ACCESS_KEY: "secret", RUSTFLAGS: "bad", CARGO_ENCODED_RUSTFLAGS: "bad", RUSTUP_TOOLCHAIN: "nightly" }, fixtureManifest, "x86_64-pc-windows-msvc", "/source", "identity");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.RUSTFLAGS, undefined);
  assert.equal(env.RUSTUP_TOOLCHAIN, "1.94.1");
  assert.equal(env.CARGO_ENCODED_RUSTFLAGS, "--remap-path-prefix=/source=sliver-gui\x1f-Ctarget-feature=+crt-static");
  assert.equal(env.SLIVER_RDP_BUILD_ID, "identity");
  assert.equal(env["ProgramFiles(x86)"], "C:\\Program Files (x86)", "MSVC discovery must retain its standard installation directory");
});

test("Cargo inventory excludes dev-only nodes and rejects a mixed IronRDP revision", async (context) => {
  const fixture = await rdpFixture(context);
  assert.deepEqual(selectedCargoPackages(fixture.metadata, fixtureManifest).map(({ name }) => name), ["ironrdp-client", "sliver-rdp"]);
  fixture.metadata.packages[1].source = "registry+https://github.com/rust-lang/crates.io-index";
  assert.throws(() => selectedCargoPackages(fixture.metadata, fixtureManifest), /Unpinned IronRDP/u);
});

test("source identity covers source and lockfile while ignoring generated outputs", async (context) => {
  const { root } = await rdpFixture(context);
  const first = await rdpSourceInputs(root);
  await mkdir(join(root, "native/rdp/bin"));
  await writeFile(join(root, "native/rdp/bin/sliver-rdp"), "generated");
  await writeFile(join(root, RDP_PACKAGED_RECORD), "generated archive trust anchor");
  assert.deepEqual(await rdpSourceInputs(root), first);
  await writeFile(join(root, "native/rdp/Cargo.lock"), "changed dependency graph");
  assert.notDeepEqual(await rdpSourceInputs(root), first);
});

test("IronRDP feature and fork patch inventories must match the reviewed pin", async (context) => {
  const fixture = await rdpFixture(context);
  const selected = selectedCargoPackages(fixture.metadata, fixtureManifest);
  await verifyIronRdpPatchInventory(selected, fixtureManifest);
  fixture.metadata.resolve.nodes[1].features.push("clipboard");
  assert.throws(() => selectedCargoPackages(fixture.metadata, fixtureManifest), /features do not match/u);
  await writeFile(join(fixture.root, "dependency/SLIVER_GUI_EMBEDDING.md"), "unexpected patches");
  await assert.rejects(verifyIronRdpPatchInventory(selected, fixtureManifest), /pinned digest/u);
});

test("omitted workspace license text can only come from the same repository and license", async (context) => {
  const fixture = await rdpFixture(context);
  await mkdir(join(fixture.root, "subcrate"));
  const owner = { ...fixture.metadata.packages[1], repository: "https://github.com/example/workspace.git", selectedFeatures: [] };
  const sibling = { ...owner, name: "workspace-subcrate", source: "registry+crates.io", repository: "https://github.com/example/workspace/",
    manifest_path: join(fixture.root, "subcrate/Cargo.toml"), license: "MIT/Apache-2.0" };
  assert.match(await cargoLicenseInventory([owner, sibling], fixture.root), /Shared upstream license text from ironrdp-client@0.1.0/u);
  await assert.rejects(cargoLicenseInventory([owner, { ...sibling, repository: "https://github.com/unrelated/repo" }], fixture.root), /no packaged license/u);
  await assert.rejects(cargoLicenseInventory([owner, { ...sibling, license: "BSD-3-Clause" }], fixture.root), /no packaged license/u);
});

test("Cargo's fork checkout must have the exact tree and no changes besides its completion marker", async () => {
  const run = (tree, status) => async (_command, args) => ({ stdout: args.includes("rev-parse") ? `${fixtureManifest.source.commit}\n${tree}\n` : status });
  await verifyIronRdpCheckout("/cargo/checkout", fixtureManifest, run(fixtureManifest.source.tree, "?? .cargo-ok\n"));
  await assert.rejects(verifyIronRdpCheckout("/cargo/checkout", fixtureManifest, run("c".repeat(40), "")), /pinned commit\/tree/u);
  await assert.rejects(verifyIronRdpCheckout("/cargo/checkout", fixtureManifest, run(fixtureManifest.source.tree, " M crates/ironrdp-client/src/lib.rs\n")), /modified/u);
  await assert.rejects(verifyIronRdpCheckout("/cargo/checkout", fixtureManifest, run(fixtureManifest.source.tree, "?? .cargo-ok\n?? unreviewed.rs\n")), /modified/u);
});

test("universal build records both slices, locked graph, notices and an atomic success marker", async (context) => {
  const fixture = await rdpFixture(context);
  const { record, executablePath } = await buildRdpRuntime({ projectDirectory: fixture.root, platform: "darwin", architecture: "arm64", run: fixture.run, environment: {} });
  assert.deepEqual(record.build.slices.map(({ target }) => target), ["x86_64-apple-darwin", "aarch64-apple-darwin"]);
  assert.equal(record.artifact.sha256, sha256(await readFile(executablePath)));
  assert.equal(record.protocolVersion, 1);
  assert.ok(fixture.calls.filter(({ args }) => args[0] === "build").every(({ args }) => args.includes("--locked")));
  const inventory = await readFile(join(fixture.root, "native/rdp/bin/THIRD_PARTY_LICENSES.txt"), "utf8");
  assert.match(inventory, /MIT dependency notice/u);
  assert.match(inventory, /GPL source license/u);
  assert.match(inventory, /Cargo inventory entries: 2/u);
  assert.doesNotMatch(inventory, /test-only/u);
  assert.deepEqual(await readFile(join(fixture.root, RDP_PACKAGED_RECORD)),
    await readFile(join(fixture.root, "native/rdp/bin/provenance.json")));
  fixture.metadata.packages[1].source = "git+https://example.com/unreviewed#abc";
  await assert.rejects(buildRdpRuntime({ projectDirectory: fixture.root, platform: "darwin", architecture: "arm64", run: fixture.run, environment: {} }), /Unpinned IronRDP/u);
  await assert.rejects(readFile(join(fixture.root, "native/rdp/bin/provenance.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(fixture.root, RDP_PACKAGED_RECORD)), { code: "ENOENT" });
});
