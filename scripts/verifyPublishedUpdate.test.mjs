import assert from "node:assert/strict";
import test from "node:test";
import { verifyPublishedUpdate } from "./verifyPublishedUpdate.mjs";

const commit = "a".repeat(40);
const tagObject = "b".repeat(40);
const environment = {
  GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "owner/repo",
  RELEASE_TAG: "v0.0.1", BASELINE_RUN_ID: "123", GH_TOKEN: "test-only-token",
};
function fixture(overrides = {}) {
  const objects = {
    "": { full_name: "owner/repo", private: false },
    "releases/tags/v0.0.1": { id: 456, tag_name: "v0.0.1", draft: false, prerelease: false, immutable: true },
    "releases/latest": { id: 456, tag_name: "v0.0.1" },
    "git/ref/tags/v0.0.1": { ref: "refs/tags/v0.0.1", object: { type: "tag", sha: tagObject } },
    [`git/tags/${tagObject}`]: { sha: tagObject, tag: "v0.0.1", object: { type: "commit", sha: commit }, verification: { verified: true, reason: "valid" } },
    "actions/runs/123": { id: 123, repository: { full_name: "owner/repo" }, path: ".github/workflows/build-and-release.yml", event: "workflow_dispatch", head_branch: "main", head_sha: commit, conclusion: "failure" },
    ...overrides,
  };
  return async (url, options) => {
    assert.equal(options.redirect, "error");
    const key = url.replace("https://api.github.com/repos/owner/repo", "").replace(/^\//u, "");
    return { ok: Object.hasOwn(objects, key), json: async () => objects[key] };
  };
}

test("verifies an immutable signed release even when its post-publication test failed", async () => {
  assert.deepEqual(await verifyPublishedUpdate({ environment, fetchImplementation: fixture() }), {
    releaseTag: "v0.0.1", baselineRunId: "123", commit,
  });
});
for (const change of [{ GITHUB_REF: "refs/heads/feature" }, { GITHUB_EVENT_NAME: "pull_request" }, { BASELINE_RUN_ID: "../123" }, { RELEASE_TAG: "v0.0.1-beta.1" }]) {
  test(`rejects invalid invocation ${JSON.stringify(change)}`, async () => {
    await assert.rejects(verifyPublishedUpdate({ environment: { ...environment, ...change }, fetchImplementation: async () => { assert.fail("must validate before network access"); } }));
  });
}
for (const overrides of [
  { "": { full_name: "owner/repo", private: true } },
  { "releases/tags/v0.0.1": { tag_name: "v0.0.1", draft: false, prerelease: false, immutable: false } },
  { "releases/latest": { id: 789, tag_name: "v0.0.2" } },
  { "git/ref/tags/v0.0.1": { ref: "refs/tags/v0.0.1", object: { type: "commit", sha: commit } } },
  { [`git/tags/${tagObject}`]: { sha: tagObject, tag: "v0.0.1", object: { type: "commit", sha: commit }, verification: { verified: false, reason: "unsigned" } } },
  { "actions/runs/123": { id: 123, repository: { full_name: "owner/repo" }, path: ".github/workflows/build-and-release.yml", event: "workflow_dispatch", head_branch: "main", head_sha: "c".repeat(40) } },
  { "actions/runs/123": { id: 123, repository: { full_name: "owner/repo" }, path: ".github/workflows/unrelated.yml", event: "workflow_dispatch", head_branch: "main", head_sha: commit } },
  { "actions/runs/123": { id: 123, repository: { full_name: "owner/repo" }, path: ".github/workflows/build-and-release.yml", event: "pull_request", head_branch: "feature", head_sha: commit } },
]) {
  test(`rejects inconsistent publication metadata ${Object.keys(overrides)[0]} ${JSON.stringify(overrides)}`, async () => {
    await assert.rejects(verifyPublishedUpdate({ environment, fetchImplementation: fixture(overrides) }));
  });
}
