import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const { getFileMatchers } = require("app-builder-lib/out/fileMatcher.js");

test("electron-builder retains the Beagle trust anchor and native license inventory", async () => {
  const config = load(await readFile(join(root, "electron-builder.yml"), "utf8"));
  const destination = join(root, "release/test-resources");
  const options = { defaultSrc: root, macroExpander: (value) => value, customBuildOptions: {}, globalOutDir: join(root, "release") };
  const resources = getFileMatchers(config, "extraResources", destination, options);
  const archives = getFileMatchers(config, "files", join(destination, "app"), options);
  const exclusions = [];
  for (const matcher of resources) matcher.computeParsedPatterns(exclusions, root);
  for (const matcher of archives) matcher.excludePatterns = exclusions;
  const regularFile = await stat(join(root, "package.json"));
  const includedInArchive = (path) => archives.some((matcher) => matcher.createFilter()(join(root, path), regularFile));
  assert.equal(includedInArchive("protocol/beagle-provenance.json"), true);
  assert.equal(includedInArchive("native/beagle/packaged-provenance.json"), true, "the trust anchor must survive extraResources exclusions");
  for (const name of ["beagle", "beagle.exe", "provenance.json", "source-provenance.json", "LICENSE", "THIRD_PARTY_LICENSES.txt",
    "licenses/aarch64-apple-darwin/BUILD-PROVENANCE.json", "licenses/aarch64-apple-darwin/THIRD_PARTY_NOTICES.md",
    "licenses/aarch64-apple-darwin/licenses/GraphQLite-MIT.txt", "licenses/x86_64-pc-windows-gnu/licenses/windows-posix/libiconv/COPYING.LIB"]) {
    const path = `native/beagle/bin/${name}`;
    assert.equal(includedInArchive(path), false, `${name} must remain outside ASAR`);
    assert.ok(resources.some((matcher) => matcher.createFilter()(join(root, path), regularFile)), `${name} must be copied into resources`);
  }
  assert.equal(includedInArchive("native/beagle/cache/release.tar.gz"), false);
  assert.equal(includedInArchive("native/beagle/source/src/main.rs"), false);
});
