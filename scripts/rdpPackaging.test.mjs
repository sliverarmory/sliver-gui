import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

import { ROOT_DIRECTORY, RDP_PACKAGED_RECORD } from "./buildRdpRuntime.mjs";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const { getFileMatchers } = require("app-builder-lib/out/fileMatcher.js");

test("electron-builder retains the immutable RDP archive anchor outside extraResources exclusions", async () => {
  const config = load(await readFile(join(ROOT_DIRECTORY, "electron-builder.yml"), "utf8"));
  const destination = join(ROOT_DIRECTORY, "release/test-resources");
  const options = { defaultSrc: ROOT_DIRECTORY, macroExpander: (value) => value, customBuildOptions: {}, globalOutDir: join(ROOT_DIRECTORY, "release") };
  const resources = getFileMatchers(config, "extraResources", destination, options);
  const archives = getFileMatchers(config, "files", join(destination, "app"), options);
  const exclusions = [];
  for (const matcher of resources) matcher.computeParsedPatterns(exclusions, ROOT_DIRECTORY);
  for (const matcher of archives) matcher.excludePatterns = exclusions;
  const regularFile = await stat(join(ROOT_DIRECTORY, "package.json"));
  const includedInArchive = (path) => archives.some((matcher) => matcher.createFilter()(join(ROOT_DIRECTORY, path), regularFile));
  assert.equal(includedInArchive(RDP_PACKAGED_RECORD), true, "the internal trust anchor must survive the real builder exclusions");
  assert.equal(includedInArchive("native/rdp/bin/provenance.json"), false, "the external copy is excluded from ASAR by extraResources");
  assert.equal(includedInArchive("native/rdp/bin/sliver-rdp"), false, "the native executable stays outside ASAR");
  assert.equal(includedInArchive("native/rdp/vendor/ironrdp/crates/ironrdp-client/src/rdp.rs"), false, "generated source staging must not enter the application archive");
  assert.ok(resources.some((matcher) => matcher.createFilter()(join(ROOT_DIRECTORY, "native/rdp/bin/provenance.json"), regularFile)));
});
