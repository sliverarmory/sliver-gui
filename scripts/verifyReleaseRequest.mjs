import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/** Authorize a release before any job enters the signing environment. */
export async function verifyReleaseRequest({
  releaseTag,
  eventName,
  ref,
  sha,
  repository,
  token,
  fetchImplementation = fetch,
}) {
  if (releaseTag === "" || releaseTag === undefined) return undefined;
  if (eventName !== "workflow_dispatch" || ref !== "refs/heads/main") {
    throw new Error("Release builds must be dispatched on the main branch.");
  }
  if (typeof releaseTag !== "string" || releaseTag.length > 64 || !STABLE_TAG.test(releaseTag)) {
    throw new Error("Release tag must be an exact stable SemVer tag such as v0.0.1.");
  }
  if (!COMMIT_SHA.test(sha ?? "") || !REPOSITORY.test(repository ?? "")) {
    throw new Error("Release request has invalid repository or commit context.");
  }
  if (typeof token !== "string" || token.length === 0) throw new Error("A GitHub read token is required.");

  async function readGitHub(path) {
    const response = await fetchImplementation(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub release verification failed (HTTP ${response.status}).`);
    return response.json();
  }

  const tagRef = await readGitHub(`git/ref/tags/${releaseTag}`);
  if (tagRef.ref !== `refs/tags/${releaseTag}` || tagRef.object?.type !== "tag" || !COMMIT_SHA.test(tagRef.object.sha ?? "")) {
    throw new Error("Release tag must be an annotated signed tag.");
  }
  const tag = await readGitHub(`git/tags/${tagRef.object.sha}`);
  if (tag.sha !== tagRef.object.sha || tag.tag !== releaseTag || tag.object?.type !== "commit" || !COMMIT_SHA.test(tag.object.sha ?? "")) {
    throw new Error("Release tag must directly identify the requested commit.");
  }
  if (tag.verification?.verified !== true || tag.verification.reason !== "valid") {
    throw new Error("Release tag signature must be verified by GitHub.");
  }
  const main = await readGitHub("git/ref/heads/main");
  if (main.ref !== "refs/heads/main" || main.object?.type !== "commit" ||
      main.object.sha !== sha || tag.object.sha !== sha) {
    throw new Error("Release tag, workflow commit, and current remote main must match exactly.");
  }
  return Object.freeze({ releaseTag, commit: sha, tagObject: tag.sha });
}

async function main() {
  const result = await verifyReleaseRequest({
    releaseTag: process.env.RELEASE_TAG,
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
  });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `release_tag=${result?.releaseTag ?? ""}\n`);
  }
  console.log(result ? `Verified signed release ${result.releaseTag} at main commit ${result.commit}.` : "Unsigned CI build; no release requested.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Keep tokens, URLs, and remote error payloads out of Actions logs.
    console.error("::error::Release request verification failed. Require a GitHub-verified annotated stable tag at the exact current main commit, dispatched on main.");
    process.exitCode = 1;
  });
}
