import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rdpSourceInputs, runRdpCommand, selectedCargoPackages, sha256 } from "./buildRdpRuntime.mjs";
import { prepareRdpSource, RDP_SOURCE_PATCH, RDP_STAGED_SOURCE, verifyRdpOverlayPatch, verifyStagedRdpSource } from "./rdpSourceOverlay.mjs";
import { fixtureManifest, rdpFixture } from "./rdpTestFixtures.mjs";

async function sourceFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "rdp-overlay-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "original");
  await mkdir(source);
  const git = async (...args) => (await runRdpCommand("git", ["-C", source, ...args])).stdout.trim();
  await git("init");
  await writeFile(join(source, "LICENSE"), "MIT\n");
  await writeFile(join(source, "SLIVER_GUI_EMBEDDING.md"), "Original reviewed inventory\n");
  await writeFile(join(source, "client.rs"), "original\n");
  await git("add", ".");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Pinned fixture");
  const [commit, tree] = (await git("rev-parse", "HEAD", "HEAD^{tree}")).split("\n");
  await writeFile(join(source, "client.rs"), "reviewed change\n");
  const patch = (await runRdpCommand("git", ["-C", source, "diff", "--binary"])).stdout;
  await git("add", ".");
  const patchedTree = await git("write-tree");
  await git("reset", "--hard", "HEAD");
  await mkdir(join(root, "native/rdp/patches"), { recursive: true });
  await writeFile(join(root, RDP_SOURCE_PATCH), patch);
  const manifest = { ...fixtureManifest, source: { ...fixtureManifest.source, commit, tree,
    patchInventorySha256: sha256(await readFile(join(source, "SLIVER_GUI_EMBEDDING.md"))),
    localOverlay: { patch: RDP_SOURCE_PATCH, sha256: sha256(patch), tree: patchedTree } } };
  const options = { projectDirectory: root, sourceDirectory: source, manifest, run: runRdpCommand };
  return { root, source, manifest, options, git };
}

test("staging applies the reviewed patch without changing its source checkout and is reusable", async (context) => {
  const fixture = await sourceFixture(context);
  const destination = await prepareRdpSource(fixture.options);
  assert.equal(destination, join(fixture.root, RDP_STAGED_SOURCE));
  assert.equal(await readFile(join(destination, "client.rs"), "utf8"), "reviewed change\n");
  assert.equal(await readFile(join(fixture.source, "client.rs"), "utf8"), "original\n");
  assert.equal(await fixture.git("status", "--porcelain"), "");
  assert.equal((await runRdpCommand("git", ["-C", destination, "config", "core.autocrlf"])).stdout.trim(), "false");
  assert.equal(await prepareRdpSource(fixture.options), destination);
  await writeFile(join(destination, "client.rs"), "unreviewed\n");
  await assert.rejects(prepareRdpSource(fixture.options), /git failed/u);
});

test("staging fails closed for patch digest, base revision, index tree and untracked drift", async (context) => {
  const fixture = await sourceFixture(context);
  const destination = await prepareRdpSource(fixture.options);
  const altered = (source) => ({ ...fixture.manifest, source: { ...fixture.manifest.source, ...source } });
  await assert.rejects(verifyStagedRdpSource(destination, altered({ commit: "c".repeat(40) }), runRdpCommand), /pinned base/u);
  await assert.rejects(verifyStagedRdpSource(destination, altered({ localOverlay: { ...fixture.manifest.source.localOverlay, tree: "d".repeat(40) } }), runRdpCommand), /overlay tree/u);
  await writeFile(join(destination, "unreviewed.rs"), "unexpected source");
  await assert.rejects(verifyStagedRdpSource(destination, fixture.manifest, runRdpCommand), /untracked/u);
  await writeFile(join(fixture.root, RDP_SOURCE_PATCH), "different patch");
  await assert.rejects(verifyRdpOverlayPatch(fixture.root, fixture.manifest), /digest mismatch/u);
});

test("staging detects changed bytes even when Git marks them assume-unchanged", async (context) => {
  const fixture = await sourceFixture(context);
  const destination = await prepareRdpSource(fixture.options);
  await runRdpCommand("git", ["-C", destination, "update-index", "--assume-unchanged", "client.rs"]);
  await writeFile(join(destination, "client.rs"), "hidden mutation\n");
  await assert.rejects(verifyStagedRdpSource(destination, fixture.manifest, runRdpCommand), /content changed/u);
});

test("Cargo graph only accepts overlaid IronRDP dependencies from the verified staging path", async (context) => {
  const fixture = await rdpFixture(context);
  const manifest = { ...fixtureManifest, source: { ...fixtureManifest.source, localOverlay: { patch: RDP_SOURCE_PATCH, sha256: "a".repeat(64), tree: "b".repeat(40) } } };
  const client = fixture.metadata.packages[1];
  client.source = null;
  client.manifest_path = join(fixture.root, RDP_STAGED_SOURCE, "crates/ironrdp-client/Cargo.toml");
  assert.equal(selectedCargoPackages(fixture.metadata, manifest, fixture.root).length, 2);
  client.manifest_path = join(fixture.root, "unreviewed/ironrdp-client/Cargo.toml");
  assert.throws(() => selectedCargoPackages(fixture.metadata, manifest, fixture.root), /Unpinned/u);
  client.manifest_path = join(fixture.root, RDP_STAGED_SOURCE, "crates/ironrdp-client/Cargo.toml");
  client.source = `git+${fixtureManifest.source.repository}?rev=${fixtureManifest.source.commit}#${fixtureManifest.source.commit}`;
  assert.throws(() => selectedCargoPackages(fixture.metadata, manifest, fixture.root), /Unpinned/u);
});

test("build identity includes the tracked overlay but excludes generated staging", async (context) => {
  const fixture = await rdpFixture(context);
  await mkdir(join(fixture.root, "native/rdp/patches"));
  await writeFile(join(fixture.root, RDP_SOURCE_PATCH), "reviewed patch");
  const first = await rdpSourceInputs(fixture.root);
  await mkdir(join(fixture.root, RDP_STAGED_SOURCE), { recursive: true });
  await writeFile(join(fixture.root, RDP_STAGED_SOURCE, "generated"), "checkout");
  assert.deepEqual(await rdpSourceInputs(fixture.root), first);
  await writeFile(join(fixture.root, RDP_SOURCE_PATCH), "new patch");
  assert.notDeepEqual(await rdpSourceInputs(fixture.root), first);
});
