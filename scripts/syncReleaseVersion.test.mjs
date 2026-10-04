import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { syncReleaseVersion } from "./syncReleaseVersion.mjs";

const repository = "https://github.com/sliverarmory/sliver-gui";

async function fixture(t, version, sourceRepository = repository) {
  const directory = await mkdtemp(join(tmpdir(), "release-version-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "protocol"));
  const provenance = {
    source: { commit: "pinned-upstream-commit" },
    build: { overlay: {
      files: [{ sourcePath: "unchanged.go", sha256: "pinned-source-digest" }],
      correspondingSource: {
        repository: sourceRepository,
        packageVersion: "0.1.0",
        tag: "v0.1.0",
        archive: `${sourceRepository}/archive/refs/tags/v0.1.0.tar.gz`,
      },
    } },
  };
  await writeFile(join(directory, "package.json"), JSON.stringify({ version }));
  const path = join(directory, "protocol/sliver-console-provenance.json");
  await writeFile(path, JSON.stringify(provenance));
  return { directory, path, provenance };
}

test("synchronizes release source version without altering source pins", async (t) => {
  const { directory, path, provenance } = await fixture(t, "0.0.1");
  assert.equal(await syncReleaseVersion(directory), "0.0.1");
  const expected = structuredClone(provenance);
  expected.build.overlay.correspondingSource = {
    repository,
    packageVersion: "0.0.1",
    tag: "v0.0.1",
    archive: `${repository}/archive/refs/tags/v0.0.1.tar.gz`,
  };
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), expected);
  const first = await readFile(path, "utf8");
  await syncReleaseVersion(directory);
  assert.equal(await readFile(path, "utf8"), first);
});

for (const version of ["0.0.1-beta.1", "01.0.1", "../main", undefined]) {
  test(`rejects non-stable version ${String(version)} before writing`, async (t) => {
    const { directory, path } = await fixture(t, version);
    const original = await readFile(path, "utf8");
    await assert.rejects(syncReleaseVersion(directory), /exact stable package version/u);
    assert.equal(await readFile(path, "utf8"), original);
  });
}

test("rejects an unexpected source repository before writing", async (t) => {
  const { directory, path } = await fixture(t, "0.0.1", "https://example.test/other");
  const original = await readFile(path, "utf8");
  await assert.rejects(syncReleaseVersion(directory), /Unexpected corresponding-source repository/u);
  assert.equal(await readFile(path, "utf8"), original);
});
