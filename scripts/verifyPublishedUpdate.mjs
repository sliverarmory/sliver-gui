import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Bind a verification-only run to an immutable release and its original baseline build. */
export async function verifyPublishedUpdate({ environment = process.env, fetchImplementation = fetch } = {}) {
  const { RELEASE_TAG: tag, BASELINE_RUN_ID: runId, GITHUB_REPOSITORY: repository, GH_TOKEN: token } = environment;
  if (environment.GITHUB_REF !== "refs/heads/main" || environment.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw new Error("Public update verification must run from main.");
  }
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag ?? "") ||
      !/^[1-9]\d{0,19}$/u.test(runId ?? "") || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") || !token) {
    throw new Error("Invalid public update verification context.");
  }
  async function read(path) {
    const response = await fetchImplementation(`https://api.github.com/repos/${repository}${path ? `/${path}` : ""}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2026-03-10" },
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Unable to read public update verification metadata.");
    return response.json();
  }
  const [repo, release, latest, ref, run] = await Promise.all([
    read(""), read(`releases/tags/${tag}`), read("releases/latest"), read(`git/ref/tags/${tag}`), read(`actions/runs/${runId}`),
  ]);
  if (repo.full_name !== repository || repo.private !== false || release.tag_name !== tag ||
      release.draft !== false || release.prerelease !== false || release.immutable !== true ||
      !Number.isSafeInteger(release.id) || release.id <= 0 || latest.id !== release.id || latest.tag_name !== tag) {
    throw new Error("Verification requires an immutable public stable release.");
  }
  if (ref.ref !== `refs/tags/${tag}` || ref.object?.type !== "tag" || !/^[0-9a-f]{40}$/u.test(ref.object.sha ?? "")) {
    throw new Error("Release tag must be annotated and signed.");
  }
  const signedTag = await read(`git/tags/${ref.object.sha}`);
  if (signedTag.sha !== ref.object.sha || signedTag.tag !== tag || signedTag.object?.type !== "commit" ||
      !/^[0-9a-f]{40}$/u.test(signedTag.object.sha ?? "") || signedTag.verification?.verified !== true || signedTag.verification.reason !== "valid") {
    throw new Error("Release tag must have a valid verified signature and commit.");
  }
  if (String(run.id) !== runId || run.repository?.full_name !== repository ||
      run.path !== ".github/workflows/build-and-release.yml" || run.event !== "workflow_dispatch" ||
      run.head_branch !== "main" || run.head_sha !== signedTag.object.sha) {
    throw new Error("Baseline run must be the main-branch release build at the signed tag commit.");
  }
  // The original release run can still be running, or have failed solely in
  // post-publication verification. The baseline installer is checked again by
  // the installed-update test for exact version and pinned code-signing identity.
  return { releaseTag: tag, baselineRunId: runId, commit: signedTag.object.sha };
}

async function main() {
  const result = await verifyPublishedUpdate();
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `release_tag=${result.releaseTag}\nbaseline_run_id=${result.baselineRunId}\n`);
  }
  console.log(`Verified immutable ${result.releaseTag} and original baseline build ${result.baselineRunId} at ${result.commit}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("::error::Published update verification requires main, an immutable public signed release, and its original main-branch baseline build.");
    process.exitCode = 1;
  });
}
