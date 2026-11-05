// @vitest-environment node

import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { readWorkflow, repositoryRoot, workflowScript } from "../tests/workflow-fixtures.js";

const execute = promisify(execFile);
const workflow = readWorkflow("private-updater-e2e.yml");
const roots: string[] = [];
const cleanupRelease = "Delete test evidence when GitHub permits it";
const macSigning = "Remove ephemeral private signing material";
const macTrust = "Remove ephemeral macOS trust";
interface Call { command: string; args: string[]; environment: string }
interface Scenario {
  release?: number[];
  tag?: number[];
  fail?: string;
  publishedState?: string;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Execute the workflow's actual run blocks. PATH contains only fake privileged /
// network commands and the ordinary file/text utilities the scripts need.
async function bashFixture(scenario: Scenario = {}) {
  const root = await mkdtemp(join(tmpdir(), "updater-workflow-"));
  roots.push(root);
  const runnerTemp = join(root, "runner");
  const bin = join(root, "bin");
  await Promise.all([mkdir(runnerTemp), mkdir(bin), mkdir(join(root, "release-assets"))]);
  await writeFile(join(root, "release-assets", "fixture.zip"), "fixture");
  await writeFile(join(root, "scenario.json"), JSON.stringify(scenario));
  await writeFile(join(root, "environment"), "");
  const fake = join(bin, "fake.cjs");
  await writeFile(fake, `#!${process.execPath}\n` + FAKE_COMMAND);
  await chmod(fake, 0o755);
  for (const name of ["gh", "security", "sudo", "openssl", "sleep", "rm", "node"]) await symlink(fake, join(bin, name));
  for (const name of ["cat", "head", "grep", "sed", "find", "sort", "diff", "basename", "mkdir"]) {
    await symlink(`${process.platform === "darwin" && ["cat", "mkdir"].includes(name) ? "/bin" : "/usr/bin"}/${name}`, join(bin, name));
  }
  const env = {
    PATH: bin,
    FIXTURE_ROOT: root,
    RUNNER_TEMP: runnerTemp,
    GITHUB_ENV: join(root, "environment"),
    GITHUB_STEP_SUMMARY: join(root, "summary"),
    GITHUB_OUTPUT: join(root, "output"),
    GITHUB_REPOSITORY: "fixture/repository",
    GITHUB_SHA: "fixture-sha",
    TEST_TAG: "fixture-tag",
    UPDATE_VERSION: "0.0.2-test.1",
    BUILD_RESULT: "success",
    PUBLISH_RESULT: "success",
    NATIVE_RESULT: "success",
    RUNNER_ENVIRONMENT: "github-hosted",
    MAC_SIGNING_AUTHORITY: "Fixture signing identity",
  };
  return {
    root, runnerTemp,
    async run(name: string, overrides: Record<string, string> = {}) {
      const script = join(root, "step.sh");
      await writeFile(script, workflowScript(workflow, name).replaceAll("${{ runner.temp }}", runnerTemp));
      const result = await execute("/bin/bash", [script], { cwd: root, env: { ...env, ...overrides }, timeout: 10_000 })
        .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
          (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
      const calls = await readFile(join(root, "calls.jsonl"), "utf8").catch(() => "");
      return { ...result, calls: calls.trim() ? calls.trim().split("\n").map((line) => JSON.parse(line) as Call) : [],
        summary: await readFile(join(root, "summary"), "utf8").catch(() => "") };
    },
  };
}

const FAKE_COMMAND = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.FIXTURE_ROOT;
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(path.join(root, "scenario.json"), "utf8"));
fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify({ command, args,
  environment: fs.readFileSync(process.env.GITHUB_ENV, "utf8") }) + "\n");
const fail = (key) => { if (scenario.fail === key) { process.stderr.write("fixture failure: " + key); process.exit(1); } };
if (command === "gh") {
  if (args[0] === "api" && args[1] === "--include") {
    const resource = args[2].includes("/releases/") ? "release" : "tag";
    const statePath = path.join(root, resource + "-requests");
    const index = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, "utf8")) : 0;
    fs.writeFileSync(statePath, String(index + 1));
    const values = scenario[resource] ?? [200, 404];
    const status = values[Math.min(index, values.length - 1)];
    process.stdout.write("HTTP/2.0 " + status + " Fixture\n");
    process.exit(status === 200 ? 0 : 1);
  }
  if (args[0] === "release" && args[1] === "delete") fail("delete-release");
  else if (args.includes("DELETE")) fail("delete-tag");
  else if (args[0] === "release" && args[1] === "view") {
    const fields = args[args.indexOf("--json") + 1];
    if (fields === "assets") console.log("fixture.zip");
    else if (fields === "url") console.log("https://example.test/release");
    else console.log(scenario.publishedState ?? "false\ttrue\ttrue\tfixture-tag\tfixture-sha");
  } else if (args[0] === "release" && args[1] === "download") {
    fs.mkdirSync("remote-assets"); fs.writeFileSync("remote-assets/fixture.zip", "fixture");
  } else if (args[0] === "api" && args[1].endsWith("/latest")) console.log("stable-release");
  else if (args[0] === "api" && args[1].includes("?per_page=")) console.log("fixture-tag");
} else if (command === "security") {
  if (args[0] === "list-keychains" && !args.includes("-s")) console.log('    "/fixture/login.keychain-db"');
  else if (args[0] === "list-keychains") fail("restore-keychains");
  else if (args[0] === "delete-keychain") fail("delete-keychain");
  else if (args[0] === "create-keychain") fs.writeFileSync(args.at(-1), "fixture");
  else if (args[0] === "find-identity") console.log(process.env.MAC_SIGNING_AUTHORITY);
} else if (command === "sudo") {
  if (args[0] !== "-n" || args[1] !== "security" || args[2] !== "add-trusted-cert") process.exit(97);
  fail("trust");
} else if (command === "openssl") {
  if (args[0] === "rand") console.log("fixture-password");
  for (const flag of ["-out", "-keyout"]) if (args.includes(flag)) fs.writeFileSync(args[args.indexOf(flag) + 1], "fixture");
} else if (command === "node" && process.env.FIXTURE_REAL_NODE === "1") {
  const result = require("node:child_process").spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  process.exit(result.status ?? 1);
} else if (command === "rm") {
  fail("remove-files");
  const target = args.at(-1);
  if (!target.startsWith(root + path.sep)) process.exit(98);
  fs.rmSync(target, { force: true, recursive: args.some((arg) => arg.includes("r")) });
}
`;

describe.skipIf(process.platform === "win32")("private updater Bash workflow behavior", () => {
  it("waits for release absence before deleting the tag, then proves both absent", async () => {
    const f = await bashFixture({ release: [200, 200, 404], tag: [200, 200, 404] });
    const result = await f.run(cleanupRelease);
    expect(result.code).toBe(0);
    expect(result.summary).toContain("Deleted test release and tag");
    expect(result.calls.map(({ command, args }) => [command, ...args])).toEqual([
      ["gh", "api", "--include", "repos/fixture/repository/releases/tags/fixture-tag"],
      ["gh", "release", "delete", "fixture-tag", "--yes"],
      ["gh", "api", "--include", "repos/fixture/repository/releases/tags/fixture-tag"],
      ["sleep", "5"],
      ["gh", "api", "--include", "repos/fixture/repository/releases/tags/fixture-tag"],
      ["gh", "api", "--include", "repos/fixture/repository/git/ref/tags/fixture-tag"],
      ["gh", "api", "--method", "DELETE", "repos/fixture/repository/git/refs/tags/fixture-tag"],
      ["gh", "api", "--include", "repos/fixture/repository/git/ref/tags/fixture-tag"],
      ["sleep", "5"],
      ["gh", "api", "--include", "repos/fixture/repository/git/ref/tags/fixture-tag"],
    ]);
  });

  it("succeeds without deletion when both resources are already absent", async () => {
    const result = await (await bashFixture({ release: [404], tag: [404] })).run(cleanupRelease);
    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.summary).toContain("No test release or tag existed");
  });

  it.each(["release", "tag"] as const)("fails closed when %s remains present through the polling deadline", async (resource) => {
    const result = await (await bashFixture({ [resource]: [200] })).run(cleanupRelease);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Timed out waiting for explicit 404 absence");
    expect(result.calls.filter(({ command }) => command === "sleep")).toHaveLength(12);
    expect(result.summary).not.toContain("Deleted test release and tag");
    if (resource === "release") expect(result.calls.some(({ args }) => args.includes("DELETE"))).toBe(false);
  });

  it.each([
    { release: [403] }, { release: [200, 500] }, { tag: [403] }, { tag: [200, 500] },
    { fail: "delete-release" }, { fail: "delete-tag" },
  ])("does not report cleanup success after API/deletion failure: %j", async (scenario) => {
    const result = await (await bashFixture(scenario)).run(cleanupRelease);
    expect(result.code).toBe(1);
    expect(result.summary).not.toContain("Deleted test release and tag");
    expect(result.calls.some(({ command }) => command === "sleep")).toBe(false);
    if (scenario.release) expect(result.calls.some(({ args }) => args.includes("DELETE"))).toBe(false);
  });

  it.each(["BUILD_RESULT", "PUBLISH_RESULT", "NATIVE_RESULT"])("retains a failing %s even after successful cleanup", async (key) => {
    const result = await (await bashFixture({ release: [404], tag: [404] })).run(cleanupRelease, { [key]: "failure" });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Updater E2E failed");
  });

  it.each([macSigning, macTrust].flatMap((name) => [
    { name, fail: undefined }, { name, fail: "restore-keychains" }, { name, fail: "delete-keychain" },
  ]))("attempts every teardown action: $name, failure $fail", async ({ name, fail }) => {
    const f = await bashFixture(fail ? { fail } : {});
    const signingDir = join(f.runnerTemp, "sliver-gui-updater-signing");
    await mkdir(signingDir);
    const list = name === macSigning ? join(signingDir, "original-keychains.txt") : join(f.runnerTemp, "sliver-gui-updater-original-keychains.txt");
    await writeFile(list, "/fixture/login.keychain-db\n/fixture/second.keychain-db\n");
    const keychain = join(f.runnerTemp, name === macSigning ? "sliver-gui-updater-signing.keychain-db" : "sliver-gui-updater-trust.keychain-db");
    await writeFile(keychain, "fixture");
    const result = await f.run(name);
    expect(result.code).toBe(fail ? 1 : 0);
    expect(result.calls.find(({ args }) => args[0] === "list-keychains")?.args).toEqual([
      "list-keychains", "-d", "user", "-s", "/fixture/login.keychain-db", "/fixture/second.keychain-db",
    ]);
    expect(result.calls.some(({ args }) => args[0] === "delete-keychain" && args[1] === keychain)).toBe(true);
    expect(result.calls.some(({ command }) => command === "rm")).toBe(true);
    expect(result.calls.some(({ command }) => command === "sudo")).toBe(false);
  });

  it.each([macSigning, macTrust])("reports teardown deletion failures: %s", async (name) => {
    const f = await bashFixture({ fail: "remove-files" });
    const keychain = join(f.runnerTemp, name === macSigning ? "sliver-gui-updater-signing.keychain-db" : "sliver-gui-updater-trust.keychain-db");
    await writeFile(keychain, "fixture");
    const result = await f.run(name);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Failed to remove");
    expect(result.calls.some(({ args }) => args[0] === "delete-keychain" && args[1] === keychain)).toBe(true);
  });

  it.each([macSigning, macTrust])("refuses file deletion outside runner temp: %s", async (name) => {
    const f = await bashFixture();
    const outside = join(f.root, "outside");
    await writeFile(outside, "keep");
    const variable = name === macSigning ? "UPDATER_E2E_SIGNING_DIR" : "UPDATER_E2E_TRUST_ORIGINAL_KEYCHAINS";
    const result = await f.run(name, { [variable]: outside });
    expect(result.code).toBe(1);
    expect(await readFile(outside, "utf8")).toBe("keep");
    expect(result.calls.some(({ command }) => command === "rm")).toBe(false);
  });

  it.each([
    "Generate one ephemeral self-signed macOS identity", "Trust the ephemeral macOS public certificate",
  ])("records recoverable state before noninteractive trust and rejects unowned hosts: %s", async (name) => {
    for (const hosted of [true, false]) {
      const f = await bashFixture();
      await mkdir(join(f.runnerTemp, "sliver-gui-updater-e2e/base"), { recursive: true });
      await writeFile(join(f.runnerTemp, "sliver-gui-updater-e2e/base/signing-certificate.pem"), "public fixture");
      const result = await f.run(name, { RUNNER_ENVIRONMENT: hosted ? "github-hosted" : "self-hosted" });
      expect(result.code, result.stderr).toBe(hosted ? 0 : 1);
      const privileged = result.calls.filter(({ command }) => command === "sudo");
      expect(privileged).toHaveLength(hosted ? 1 : 0);
      if (hosted) {
        const signing = name.startsWith("Generate");
        const directory = join(f.runnerTemp, "sliver-gui-updater-signing");
        const keychain = join(f.runnerTemp, signing ? "sliver-gui-updater-signing.keychain-db" : "sliver-gui-updater-trust.keychain-db");
        const certificate = signing ? join(directory, "signing.pem") : join(f.runnerTemp, "sliver-gui-updater-e2e/base/signing-certificate.pem");
        expect(privileged[0]!.args).toEqual(["-n", "security", "add-trusted-cert", "-d", "-r", "trustRoot", "-p", "codeSign", "-k", keychain, certificate]);
        const recovery = signing ? {
          CSC_KEYCHAIN: keychain,
          UPDATER_E2E_PUBLIC_CERT: certificate,
          UPDATER_E2E_SIGNING_DIR: directory,
          UPDATER_E2E_ORIGINAL_KEYCHAINS: join(directory, "original-keychains.txt"),
        } : {
          UPDATER_E2E_TRUST_KEYCHAIN: keychain,
          UPDATER_E2E_TRUST_ORIGINAL_KEYCHAINS: join(f.runnerTemp, "sliver-gui-updater-original-keychains.txt"),
        };
        for (const [key, value] of Object.entries(recovery)) expect(privileged[0]!.environment).toContain(`${key}=${value}\n`);
      }
    }
  });

  it.each(["false\ttrue\tfalse\tfixture-tag\tfixture-sha", "true\ttrue\ttrue\tfixture-tag\tfixture-sha", "false\ttrue\ttrue\twrong-tag\tfixture-sha", "false\ttrue\ttrue\tfixture-tag\twrong-sha"])(
    "rejects a published state that is not the expected immutable release", async (publishedState) => {
      const result = await (await bashFixture({ publishedState })).run("Verify published state and exact remote inventory");
      expect(result.code).toBe(1);
      expect(result.calls).toHaveLength(1);
    },
  );

  it("verifies downloaded artifacts after accepting the immutable release and exact asset inventory", async () => {
    const result = await (await bashFixture()).run("Verify published state and exact remote inventory");
    expect(result.code).toBe(0);
    expect(result.calls[0]?.args).toEqual([
      "release", "view", "fixture-tag", "--json", "isDraft,isImmutable,isPrerelease,tagName,targetCommitish",
      "--jq", "[.isDraft, .isPrerelease, .isImmutable, .tagName, .targetCommitish] | @tsv",
    ]);
    expect(result.calls.find(({ command }) => command === "node")?.args).toEqual([
      "./scripts/verifyUpdateArtifacts.mjs", "--directory", "remote-assets", "--platform", "all", "--version", "0.0.2-test.1",
      "--checksums", "SHA256SUMS", "--app-update", "verification-context/app-update.yml", "--private-e2e",
    ]);
  });

  it.each([
    {}, { isImmutable: false }, { isDraft: true }, { isPrerelease: false },
    { tagName: "wrong" }, { commit: "wrong" }, { baseVersion: "wrong" }, { updateVersion: "wrong" },
  ])("validates credential-free release context using the actual inline verifier: %j", async (overrides) => {
    const f = await bashFixture();
    const directory = join(f.runnerTemp, "sliver-gui-updater-e2e/release");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "release.json"), JSON.stringify({
      tagName: "fixture-tag", commit: "fixture-sha", baseVersion: "0.0.1-test.1", updateVersion: "0.0.2-test.1",
      isDraft: false, isPrerelease: true, isImmutable: true, ...overrides,
    }));
    const result = await f.run("Verify credential-free release context", {
      FIXTURE_REAL_NODE: "1", EXPECTED_TAG: "fixture-tag", EXPECTED_BASE_VERSION: "0.0.1-test.1", EXPECTED_UPDATE_VERSION: "0.0.2-test.1",
    });
    expect(result.code, result.stderr).toBe(Object.keys(overrides).length === 0 ? 0 : 1);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]!.command).toBe("node");
  });

});

describe.skipIf(process.platform !== "win32")("private updater PowerShell trust behavior", () => {
  const trustStores = ["Root", "TrustedPublisher"] as const;
  const outcomes = ["success", ...trustStores] as const;
  const powershellMocks = String.raw`
function Record-Call($Name, $Arguments) {
  $saved = [IO.File]::ReadAllText($env:GITHUB_ENV)
  Add-Content -LiteralPath $env:FIXTURE_LOG -Value (@{ command=$Name; args=@($Arguments); environment=$saved } | ConvertTo-Json -Compress)
}
function certutil.exe {
  Record-Call "certutil" $args
  $store = if ($args[0] -eq "-addstore") { $args[2] } else { $args[1] }
  $global:LASTEXITCODE = if ($store -eq $env:FAIL_STORE) { 1 } else { 0 }
}
function Import-Certificate { throw "Unexpected certificate import" }
function New-SelfSignedCertificate {
  param($Type, $Subject, $FriendlyName, $CertStoreLocation, $KeyAlgorithm, $KeyLength, $HashAlgorithm, $KeyExportPolicy, $NotAfter)
  Record-Call "generate" @($CertStoreLocation)
  return [PSCustomObject]@{ Thumbprint="FIXTURE"; Subject=$Subject }
}
function Export-PfxCertificate {
  param($Cert, $FilePath, $Password)
  Record-Call "export-pfx" @($FilePath)
}
function Export-Certificate {
  param($Cert, $FilePath, $Type)
  Record-Call "export-public" @($FilePath)
}
function Test-Path {
  param($LiteralPath)
  Record-Call "test-path" @($LiteralPath)
  return $true
}
function Remove-Item {
  param($LiteralPath, [switch]$Force, [switch]$Recurse)
  Record-Call "remove" @($LiteralPath)
}
`;

  async function powershellFixture() {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "updater-pwsh-"));
    roots.push(temporaryRoot);
    // PowerShell expands Windows short-path aliases when resolving fixture files.
    const root = await realpath(temporaryRoot);
    const log = join(root, "calls.jsonl");
    const environment = join(root, "environment");
    await writeFile(environment, "");
    return {
      root,
      async run(name: string, failStore: string) {
        const script = join(root, "step.ps1");
        // These functions shadow every certificate-generation, store, and deletion
        // command used by the workflow. Real file operations remain in this fixture.
        await writeFile(script, powershellMocks + workflowScript(workflow, name));
        const result = await execute("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script], {
          env: {
            ...process.env, FIXTURE_LOG: log, GITHUB_ENV: environment, RUNNER_TEMP: root,
            FAIL_STORE: failStore, WINDOWS_CERT_THUMBPRINT: "FIXTURE", UPDATER_E2E_TRUST_THUMBPRINT: "FIXTURE",
            UPDATER_E2E_SIGNING_DIR: join(root, "sliver-gui-updater-signing"),
          },
          timeout: 10_000,
        }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
          (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
        const text = await readFile(log, "utf8").catch(() => "");
        return {
          ...result,
          calls: text.trim() ? text.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Call) : [],
          environment: await readFile(environment, "utf8"),
        };
      },
    };
  }

  it.each([
    { name: "Remove ephemeral Windows private signing material", signing: true },
    { name: "Remove ephemeral Windows trust", signing: false },
  ].flatMap((entry) => outcomes.map((failStore) => ({ ...entry, failStore }))))(
    "$name completes every teardown action with $failStore outcome", async ({ name, signing, failStore }) => {
      const fixture = await powershellFixture();
      const result = await fixture.run(name, failStore);
      expect(result.code, result.stderr).toBe(failStore === "success" ? 0 : 1);
      expect(result.calls.filter(({ command }) => command === "certutil").map(({ args }) => args)).toEqual([
        ["-delstore", "Root", "FIXTURE"], ["-delstore", "TrustedPublisher", "FIXTURE"],
      ]);
      const privatePath = "Cert:\\CurrentUser\\My\\FIXTURE";
      const signingDirectory = join(fixture.root, "sliver-gui-updater-signing");
      expect(result.calls.filter(({ command }) => command === "test-path").map(({ args }) => args)).toEqual([
        ["Cert:\\LocalMachine\\Root\\FIXTURE"], ["Cert:\\LocalMachine\\TrustedPublisher\\FIXTURE"],
        ...(signing ? [[privatePath], [signingDirectory]] : []),
      ]);
      expect(result.calls.filter(({ command }) => command === "remove").map(({ args }) => args)).toEqual(
        signing ? [[privatePath], [signingDirectory]] : [],
      );
      if (failStore !== "success") expect(result.stdout).toContain(`failed to remove the ephemeral certificate from LocalMachine ${failStore}`);
    },
  );

  it.each([
    { name: "Generate one ephemeral self-signed Windows identity", signing: true },
    { name: "Trust the ephemeral Windows public certificate", signing: false },
  ].flatMap((entry) => outcomes.map((failStore) => ({ ...entry, failStore }))))(
    "$name persists recovery state and handles $failStore outcome", async ({ name, signing, failStore }) => {
      const fixture = await powershellFixture();
      const signingDirectory = join(fixture.root, "sliver-gui-updater-signing");
      let thumbprint = "FIXTURE";
      let certificatePath = join(signingDirectory, "signing.cer");
      if (!signing) {
        const directory = join(fixture.root, "sliver-gui-updater-e2e", "base");
        await mkdir(directory, { recursive: true });
        const certificate = new X509Certificate(await readFile(join(repositoryRoot, "src/e2e/fixtures/server.crt.fixture")));
        certificatePath = join(directory, "signing-certificate.cer");
        await writeFile(certificatePath, certificate.raw);
        thumbprint = certificate.fingerprint.replaceAll(":", "");
      }
      const result = await fixture.run(name, failStore);
      expect(result.code, result.stderr).toBe(failStore === "success" ? 0 : 1);
      if (failStore !== "success") {
        expect(result.stderr).toContain("certutil failed to add");
        expect(result.stderr).toContain(failStore);
      }
      const expectedStores = failStore === "Root" ? ["Root"] : trustStores;
      const mutations = result.calls.filter(({ command }) => command === "certutil");
      expect(mutations.map(({ args }) => args)).toEqual(
        expectedStores.map((store) => ["-addstore", "-f", store, certificatePath]),
      );
      for (const mutation of mutations) {
        expect(mutation.environment).toContain(`${signing ? "WINDOWS_CERT_THUMBPRINT" : "UPDATER_E2E_TRUST_THUMBPRINT"}=${thumbprint}`);
        if (signing) expect(mutation.environment).toContain(`UPDATER_E2E_SIGNING_DIR=${signingDirectory}`);
      }
      const generated = result.calls.filter(({ command }) => command === "generate");
      expect(generated.map(({ args }) => args)).toEqual(signing ? [["Cert:\\CurrentUser\\My"]] : []);
      if (signing) {
        expect(generated[0]!.environment).toContain(`UPDATER_E2E_SIGNING_DIR=${signingDirectory}`);
        expect(result.calls.filter(({ command }) => command.startsWith("export-")).map(({ command, args }) => [command, ...args])).toEqual([
          ["export-pfx", join(signingDirectory, "signing.pfx")], ["export-public", certificatePath],
        ]);
      }
    },
  );
});
