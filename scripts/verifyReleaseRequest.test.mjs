import assert from "node:assert/strict";
import test from "node:test";

import { verifyReleaseRequest } from "./verifyReleaseRequest.mjs";

const SHA = "a".repeat(40);
const TAG_SHA = "b".repeat(40);
const OTHER_SHA = "c".repeat(40);

function request(overrides = {}, mutate = () => undefined) {
  const responses = [
    { ref: "refs/tags/v0.0.1", object: { type: "tag", sha: TAG_SHA } },
    { sha: TAG_SHA, tag: "v0.0.1", object: { type: "commit", sha: SHA }, verification: { verified: true, reason: "valid" } },
    { ref: "refs/heads/main", object: { type: "commit", sha: SHA } },
  ];
  mutate(responses);
  const calls = [];
  return {
    calls,
    options: {
      releaseTag: "v0.0.1",
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      sha: SHA,
      repository: "example/desktop",
      token: "read-token",
      fetchImplementation: async (url, options) => {
        calls.push({ url, options });
        const body = responses.shift();
        assert.ok(body, "Unexpected GitHub request");
        return { ok: true, json: async () => body };
      },
      ...overrides,
    },
  };
}

test("verifies a signed annotated stable tag at the exact dispatched main commit", async () => {
  const { options, calls } = request();
  assert.deepEqual(await verifyReleaseRequest(options), { releaseTag: "v0.0.1", commit: SHA, tagObject: TAG_SHA });
  assert.deepEqual(calls.map(({ url }) => url), [
    "https://api.github.com/repos/example/desktop/git/ref/tags/v0.0.1",
    `https://api.github.com/repos/example/desktop/git/tags/${TAG_SHA}`,
    "https://api.github.com/repos/example/desktop/git/ref/heads/main",
  ]);
  assert.ok(calls.every(({ options: init }) => init.redirect === "error" && init.signal instanceof AbortSignal));
});

test("ordinary CI requests do not read release metadata", async () => {
  const { options, calls } = request({ releaseTag: "", eventName: "pull_request", ref: "refs/pull/1/merge" });
  assert.equal(await verifyReleaseRequest(options), undefined);
  assert.equal(calls.length, 0);
});

for (const overrides of [
  { eventName: "push" },
  { ref: "refs/tags/v0.0.1" },
  { ref: "refs/heads/feature" },
  { releaseTag: "v0.0.1-beta.1" },
  { releaseTag: "v01.0.1" },
  { releaseTag: "v0.0.1\nrelease_tag=other" },
  { releaseTag: "$(unsafe)" },
  { sha: "main" },
  { repository: "example/desktop/../other" },
]) {
  test(`rejects malformed or unauthorized release context ${JSON.stringify(overrides)}`, async () => {
    const { options, calls } = request(overrides);
    await assert.rejects(verifyReleaseRequest(options));
    assert.equal(calls.length, 0);
  });
}

for (const [description, mutate] of [
  ["lightweight tag", (responses) => { responses[0].object.type = "commit"; }],
  ["unverified signature", (responses) => { responses[1].verification.verified = false; }],
  ["invalid signature reason", (responses) => { responses[1].verification.reason = "invalid"; }],
  ["nested tag", (responses) => { responses[1].object.type = "tag"; }],
  ["different tag name", (responses) => { responses[1].tag = "v0.0.2"; }],
  ["mismatched tag object", (responses) => { responses[1].sha = OTHER_SHA; }],
  ["tag targets another commit", (responses) => { responses[1].object.sha = OTHER_SHA; }],
  ["main advanced after dispatch", (responses) => { responses[2].object.sha = OTHER_SHA; }],
]) {
  test(`rejects ${description}`, async () => {
    const { options } = request({}, mutate);
    await assert.rejects(verifyReleaseRequest(options));
  });
}

test("GitHub metadata errors fail verification", async () => {
  const { options } = request({ fetchImplementation: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(verifyReleaseRequest(options), /HTTP 403/u);
});
