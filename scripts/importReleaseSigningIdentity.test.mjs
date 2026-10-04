import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = new URL("./importReleaseSigningIdentity.mjs", import.meta.url);
const allowedContext = {
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  SLIVER_GUI_SIGNING_PROFILE: "self-signed",
};

for (const override of [
  { RUNNER_ENVIRONMENT: "self-hosted" },
  { GITHUB_REF: "refs/heads/feature" },
  { GITHUB_REF: "refs/tags/v0.0.1" },
  { GITHUB_EVENT_NAME: "pull_request" },
  { SLIVER_GUI_SIGNING_PROFILE: "developer-id" },
]) {
  test(`refuses trust changes outside approved release context ${JSON.stringify(override)}`, () => {
    const secret = "must-not-appear-in-output";
    const result = spawnSync(process.execPath, [fileURLToPath(script)], {
      encoding: "utf8",
      env: { ...process.env, ...allowedContext, ...override, MAC_CSC_KEY_PASSWORD: secret },
      timeout: 5_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires a main-branch self-signed release on a GitHub-hosted runner/u);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes(secret), false);
  });
}
