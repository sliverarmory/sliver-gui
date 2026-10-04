import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { prepareUpdaterTrustBeforeSigning } from "./afterPack.mjs";
import { windowsPowerShellEnvironment } from "../src/shared/windows-powershell-environment.ts";
import { extractMacosSigningCertificate, readUpdateSigningAssets, releaseSigningProfile, verifyPinnedMacosSignatures, verifyPinnedWindowsSignatures } from "./releaseSigning.mjs";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "release-signing-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "build"));
  await cp(join(rootDirectory, "build/update-signing"), join(directory, "build/update-signing"), { recursive: true });
  return directory;
}

test("release signing profiles are explicit and reject unknown values", () => {
  assert.equal(releaseSigningProfile({}), "developer-id");
  assert.equal(releaseSigningProfile({ SLIVER_GUI_SIGNING_PROFILE: "self-signed" }), "self-signed");
  assert.throws(() => releaseSigningProfile({ SLIVER_GUI_SIGNING_PROFILE: "unsigned" }), /Unsupported/u);
});

test("public update certificates are pinned DER code-signing identities", async (context) => {
  const directory = await fixture(context);
  const evidence = await readUpdateSigningAssets(directory);
  assert.equal(evidence.files.size, 3);
  const certificatePath = join(directory, "build/update-signing/macos.cer");
  await writeFile(certificatePath, evidence.files.get("windows.cer"));
  await assert.rejects(readUpdateSigningAssets(directory), /pinned DER fingerprint/u);
  const certificate = new X509Certificate(evidence.files.get("macos.cer"));
  await writeFile(certificatePath, certificate.toString());
  await assert.rejects(readUpdateSigningAssets(directory), /pinned DER fingerprint/u);
});

test("a manifest cannot substitute a TLS certificate for a code-signing identity", async (context) => {
  const directory = await fixture(context);
  const manifestPath = join(directory, "build/update-signing/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const tls = new X509Certificate(await readFile(join(rootDirectory, "src/e2e/fixtures/server.crt.fixture")));
  await writeFile(join(directory, "build/update-signing/macos.cer"), tls.raw);
  manifest.macos.sha256 = sha256(tls.raw);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(readUpdateSigningAssets(directory), /must (?:be self-signed|permit code signing)/u);
});

test("macOS verification checks outer bundle and every physical Mach-O against the exact pin", async (context) => {
  const directory = await fixture(context);
  const appPath = join(directory, "Application.app");
  const contents = join(appPath, "Contents");
  await mkdir(join(contents, "Resources/updater-trust"), { recursive: true });
  await mkdir(join(contents, "Frameworks"));
  await writeFile(join(contents, "Frameworks/addon.node"), Buffer.from("cffaedfe", "hex"));
  await writeFile(join(contents, "Resources/updater-trust/updater-trust"), Buffer.from("cafebabe", "hex"));
  await writeFile(join(contents, "Resources/app.asar"), "not executable");
  if (process.platform !== "win32") {
    await symlink(join(contents, "Frameworks/addon.node"), join(contents, "linked-addon"));
  }
  const leaf = await readFile(join(directory, "build/update-signing/macos.cer"));
  const verified = [];
  const extractedArchitectures = [];
  const run = async (command, args) => {
    if (command === "/usr/bin/lipo") return { stdout: "x86_64 arm64" };
    assert.equal(command, "/usr/bin/codesign");
    if (args.includes("--verbose=4")) return { stdout: "", stderr: "CodeDirectory v=20500 size=400 flags=0x10000(runtime) hashes=10\n" };
    if (args[0] === "--verify") {
      assert.ok(args.includes("--all-architectures"));
      verified.push(args.at(-1));
    } else {
      extractedArchitectures.push(args[2]);
      assert.match(args[3], /^--extract-certificates=.+/u);
      assert.equal(args.length, 5);
      await writeFile(`${args[3].slice("--extract-certificates=".length)}0`, leaf);
    }
  };
  await verifyPinnedMacosSignatures({ appPath, expectedSha256: sha256(leaf), run });
  assert.deepEqual(verified.sort(), [appPath, join(contents, "Frameworks/addon.node"), join(contents, "Resources/updater-trust/updater-trust")].sort());
  assert.deepEqual(extractedArchitectures, ["x86_64", "arm64", "x86_64", "arm64", "x86_64", "arm64"]);
  await assert.rejects(
    verifyPinnedMacosSignatures({ appPath, expectedSha256: "0".repeat(64), run }),
    /does not match the pinned signing certificate/u,
  );
  await assert.rejects(
    verifyPinnedMacosSignatures({ appPath, expectedSha256: sha256(leaf), run: async () => { throw new Error("invalid code signature"); } }),
    /invalid code signature/u,
  );
  await assert.rejects(
    verifyPinnedMacosSignatures({ appPath, expectedSha256: sha256(leaf), run: async (command, args) => args.includes("--verbose=4") ? { stdout: "", stderr: "CodeDirectory v=20500 size=400 flags=0x0(none)" } : run(command, args) }),
    /must enable hardened runtime/u,
  );
});

test("macOS certificate extraction uses codesign's real optional-prefix syntax without changing trust", { skip: process.platform !== "darwin" }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "macOS certificate extraction "));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const run = (command, args) => promisify(execFile)(command, args, { timeout: 15_000, maxBuffer: 1024 * 1024 });
  const codePath = "/usr/bin/security";
  const architectures = (await run("/usr/bin/lipo", ["-archs", codePath])).stdout.trim().split(/\s+/u);
  assert.ok(architectures.length > 0);
  const architecture = architectures[0];
  const expectedPrefix = join(directory, "expected certificate ");
  await run("/usr/bin/codesign", ["--display", `--extract-certificates=${expectedPrefix}`, "--architecture", architecture, codePath]);
  const expected = new X509Certificate(await readFile(`${expectedPrefix}0`));
  const actual = await extractMacosSigningCertificate({
    codePath, architecture, prefix: join(directory, "actual certificate "), run,
  });
  assert.equal(sha256(actual), sha256(expected.raw));
});

test("Windows verification requires Authenticode validity, full Subject, and SHA-256 of raw certificate", async () => {
  let invocation;
  await verifyPinnedWindowsSignatures({
    appPath: "application.exe",
    executablePath: "child.exe",
    expectedSha256: "1".repeat(64),
    expectedPublisher: "CN=Publisher",
    environment: { PSModulePath: "incompatible modules", Path: "preserved" },
    run: async (...args) => { invocation = args; },
  });
  const [command, args, options] = invocation;
  assert.equal(command, "powershell.exe");
  assert.match(args.at(-1), /\$signature.Status -ne 'Valid'/u);
  assert.match(args.at(-1), /ComputeHash\(\$signature.SignerCertificate.RawData\)/u);
  assert.match(args.at(-1), /\$fingerprint -cne \$env:SLIVER_GUI_EXPECTED_CERTIFICATE_SHA256/u);
  assert.match(args.at(-1), /Subject -cne \$env:SLIVER_GUI_EXPECTED_PUBLISHER/u);
  assert.equal(options.env.SLIVER_GUI_EXPECTED_CERTIFICATE_SHA256, "1".repeat(64));
  assert.equal(options.env.SLIVER_GUI_EXPECTED_PUBLISHER, "CN=Publisher");
  assert.equal(options.env.Path, "preserved");
  assert.equal(options.env.PSModulePath, undefined);
});

test("Windows PowerShell child environments omit every casing of PSModulePath without mutating the parent", () => {
  const original = Object.freeze({ PSModulePath: "one", PSMODULEPATH: "two", psmodulepath: "three", Path: "preserved", TEMP: "temporary" });
  assert.deepEqual(windowsPowerShellEnvironment(original), { Path: "preserved", TEMP: "temporary" });
  assert.equal(original.PSModulePath, "one");
});

test("Windows Authenticode verifier works through Node launched from PowerShell 7 and rejects a wrong certificate pin", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const run = (command, args, options = {}) => promisify(execFile)(command, args, {
    ...options, timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  const powerShell7Home = (await run("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "$PSHOME"])).stdout.trim();
  const environment = { ...process.env, PSModulePath: join(powerShell7Home, "Modules") };
  const executablePath = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const inspection = [
    "$ErrorActionPreference = 'Stop'",
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:TEST_SIGNED_EXECUTABLE",
    "if ($signature.Status -ne 'Valid') { throw 'System PowerShell signature must be valid' }",
    "$sha256 = [System.Security.Cryptography.SHA256]::Create()",
    "try { @{ Subject = $signature.SignerCertificate.Subject; Fingerprint = ([BitConverter]::ToString($sha256.ComputeHash($signature.SignerCertificate.RawData))).Replace('-', '').ToLowerInvariant() } | ConvertTo-Json -Compress } finally { $sha256.Dispose() }",
  ].join("\n");
  const baseline = JSON.parse((await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", inspection], {
    env: { ...windowsPowerShellEnvironment(environment), TEST_SIGNED_EXECUTABLE: executablePath },
  })).stdout);
  const options = {
    appPath: executablePath, executablePath, expectedSha256: baseline.Fingerprint,
    expectedPublisher: baseline.Subject, run, environment,
  };
  await verifyPinnedWindowsSignatures(options);
  await assert.rejects(verifyPinnedWindowsSignatures({ ...options, expectedSha256: "0".repeat(64) }), /Unexpected Authenticode signing certificate/u);
});

test("afterPack verifies public certs and installs the executable before app signing", async (context) => {
  const directory = await fixture(context);
  const resourcesDirectory = join(directory, "resources");
  await cp(join(directory, "build/update-signing"), join(resourcesDirectory, "update-signing"), { recursive: true });
  const helper = join(directory, "built-helper");
  await writeFile(helper, "compiled helper");
  let builds = 0;
  const build = async ({ projectDirectory }) => {
    assert.equal(projectDirectory, directory);
    builds++;
    return helper;
  };
  await prepareUpdaterTrustBeforeSigning({ platform: "darwin", projectDirectory: directory, resourcesDirectory, build });
  assert.equal(await readFile(join(resourcesDirectory, "updater-trust/updater-trust"), "utf8"), "compiled helper");
  if (process.platform !== "win32") assert.equal((await stat(join(resourcesDirectory, "updater-trust/updater-trust"))).mode & 0o777, 0o755);
  await prepareUpdaterTrustBeforeSigning({ platform: "linux", projectDirectory: directory, resourcesDirectory, build });
  assert.equal(builds, 1);
  await writeFile(join(resourcesDirectory, "update-signing/manifest.json"), "{}");
  await assert.rejects(prepareUpdaterTrustBeforeSigning({ platform: "darwin", projectDirectory: directory, resourcesDirectory, build }), /changed before signing/u);
  assert.equal(builds, 1);
});

test("self-signed environment needs persistent signing credentials but no Apple notarization account", async () => {
  const manifest = JSON.parse(await readFile(join(rootDirectory, "build/update-signing/manifest.json"), "utf8"));
  const run = (platform, environment) => spawnSync(process.execPath, [join(rootDirectory, "scripts/verifyReleaseSigningEnvironment.mjs"), "--platform", platform], {
    encoding: "utf8",
    env: {
      ...process.env,
      SLIVER_GUI_SIGNING_PROFILE: "self-signed",
      APPLE_ID: "",
      APPLE_TEAM_ID: "",
      APPLE_APP_SPECIFIC_PASSWORD: "",
      MAC_CSC_LINK: "fixture-key",
      MAC_CSC_KEY_PASSWORD: "fixture-password",
      WIN_CSC_LINK: "fixture-key",
      WIN_CSC_KEY_PASSWORD: "fixture-password",
      WIN_CSC_PUBLISHER_NAME: manifest.windows.subject,
      ...environment,
    },
  });
  for (const platform of ["macos", "windows"]) {
    const accepted = run(platform);
    assert.equal(accepted.status, 0, accepted.stderr);
  }
  assert.match(run("macos", { MAC_CSC_LINK: "" }).stderr, /missing required.*MAC_CSC_LINK/u);
  assert.match(run("windows", { WIN_CSC_PUBLISHER_NAME: "CN=Wrong" }).stderr, /does not match the pinned/u);
  assert.match(run("macos", { SLIVER_GUI_SIGNING_PROFILE: "developer-id" }).stderr, /missing required.*APPLE_ID/u);
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
