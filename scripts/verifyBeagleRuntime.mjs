import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { windowsPowerShellEnvironment } from "../src/shared/windows-powershell-environment.ts";
import { runRdpCommand } from "./buildRdpRuntime.mjs";
import { rdpBinaryArchitectures } from "./verifyRdpRuntime.mjs";
import { readUpdateSigningAssets, releaseSigningProfile, verifyPinnedMacosSignatures, verifyPinnedWindowsSignatures } from "./releaseSigning.mjs";
import { verifyWindowsSigningChanges } from "./verifyWindowsSigningChanges.mjs";
import { ROOT_DIRECTORY, BEAGLE_SOURCE_MANIFEST, BEAGLE_PACKAGED_RECORD, BEAGLE_OUTPUT_DIRECTORY,
  BEAGLE_TARGETS, beagleExecutableName, beagleTargetForHost, beagleSourceInputs, sha256, validateBeagleSourceManifest } from "./buildBeagleRuntime.mjs";

export function assertBeagleArchitecture(bytes, target) {
  // A PE header identifies the CPU/format; GNU versus MSVC is release provenance.
  const actual = rdpBinaryArchitectures(bytes).map((value) => value.replace("windows-msvc", "windows-gnu")).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...BEAGLE_TARGETS[target]].sort())) throw new Error("Beagle executable architectures do not match the package target");
}

export function validateBeagleBuildRecord(record, manifest, sourceBytes, inputs, target) {
  if (record.schemaVersion !== 1 || record.protocolVersion !== manifest.protocolVersion || record.version !== manifest.version ||
      record.sourceManifestSha256 !== sha256(sourceBytes) || JSON.stringify(record.source) !== JSON.stringify(manifest.source) ||
      JSON.stringify(record.inputs) !== JSON.stringify(inputs) || record.buildIdentity !== sha256(JSON.stringify({ manifest, inputs })) ||
      JSON.stringify(record.toolchain) !== JSON.stringify(manifest.toolchain) || record.build?.target !== target ||
      record.artifact?.fileName !== beagleExecutableName(target) || !/^[a-f0-9]{64}$/u.test(record.artifact?.sha256 ?? "") ||
      !Number.isSafeInteger(record.artifact?.size) || record.artifact.size <= 0 ||
      JSON.stringify(record.build?.slices?.map(({ target: slice }) => slice)) !== JSON.stringify(BEAGLE_TARGETS[target])) {
    throw new Error("Beagle build provenance does not match the pinned release or package target; rebuild the helper");
  }
  for (const slice of record.build.slices) {
    const asset = manifest.release.assets.find(({ target: triple }) => triple === slice.target);
    if (slice.sha256 !== asset.binarySha256 || !Number.isSafeInteger(slice.size) || slice.size <= 0) throw new Error("Invalid Beagle slice provenance");
  }
  const seen = new Set();
  if (!Array.isArray(record.supportFiles) || record.supportFiles.length === 0) throw new Error("Missing Beagle license inventory");
  for (const entry of record.supportFiles) {
    if (typeof entry.path !== "string" || entry.path.includes("\\") ||
        entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
        (!entry.path.startsWith("licenses/") && !["LICENSE", "THIRD_PARTY_LICENSES.txt"].includes(entry.path)) ||
        seen.has(entry.path) || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "") || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
      throw new Error("Invalid Beagle license inventory entry");
    }
    seen.add(entry.path);
  }
  for (const required of ["LICENSE", "THIRD_PARTY_LICENSES.txt", ...record.build.slices.flatMap(({ target: triple }) =>
    ["LICENSE", "THIRD_PARTY_NOTICES.md", "BUILD-PROVENANCE.json"].map((name) => `licenses/${triple}/${name}`))]) {
    if (!seen.has(required)) throw new Error(`Missing Beagle release license/provenance: ${required}`);
  }
}

export async function verifyBeagleBuildInfo(executablePath, record, { run = runRdpCommand, architecture = process.arch } = {}) {
  const info = JSON.parse((await run(executablePath, ["--build-info"], { signal: AbortSignal.timeout(30_000) })).stdout);
  const target = record.build.target === "darwin-universal"
    ? architecture === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin" : record.build.slices[0].target;
  if (info.name !== "beagle" || info.protocol !== record.protocolVersion || info.version !== record.version ||
      info.beagleRevision !== record.source.commit || info.target !== target) throw new Error("Beagle executable build identity does not match its pinned release");
}

export async function verifyPreparedBeagleRuntime({ projectDirectory = ROOT_DIRECTORY, platform = process.platform,
  architecture = process.arch, hostOnly = false, run = runRdpCommand } = {}) {
  const sourceBytes = await readFile(join(projectDirectory, BEAGLE_SOURCE_MANIFEST));
  const manifest = validateBeagleSourceManifest(JSON.parse(sourceBytes));
  const directory = join(projectDirectory, BEAGLE_OUTPUT_DIRECTORY);
  const recordBytes = await readFile(join(directory, "provenance.json"));
  if (!recordBytes.equals(await readFile(join(projectDirectory, BEAGLE_PACKAGED_RECORD)))) throw new Error("Beagle ASAR trust anchor differs from the prepared runtime provenance");
  const record = JSON.parse(recordBytes);
  validateBeagleBuildRecord(record, manifest, sourceBytes, await beagleSourceInputs(projectDirectory), beagleTargetForHost(platform, architecture, hostOnly));
  const executablePath = join(directory, record.artifact.fileName);
  const [executable, metadata, copiedSource] = await Promise.all([readFile(executablePath), stat(executablePath), readFile(join(directory, "source-provenance.json"))]);
  if (!metadata.isFile() || executable.length !== record.artifact.size || sha256(executable) !== record.artifact.sha256 || !copiedSource.equals(sourceBytes)) {
    throw new Error("Prepared Beagle executable/provenance failed integrity verification");
  }
  assertBeagleArchitecture(executable, record.build.target);
  if (process.platform !== "win32" && !(metadata.mode & 0o111)) throw new Error("Beagle helper is not executable");
  const supportFiles = new Map();
  for (const entry of record.supportFiles) {
    const bytes = await readFile(join(directory, entry.path));
    if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.size) throw new Error(`Prepared Beagle license/provenance changed: ${entry.path}`);
    supportFiles.set(entry.path, bytes);
  }
  const inventory = supportFiles.get("THIRD_PARTY_LICENSES.txt");
  const license = supportFiles.get("LICENSE");
  if (sha256(inventory) !== record.licenseInventorySha256 || sha256(license) !== record.projectLicenseSha256) throw new Error("Beagle license inventory digest mismatch");
  await verifyBeagleBuildInfo(executablePath, record, { run, architecture });
  return { sourceBytes, recordBytes, record, executable, supportFiles, inventory, license };
}

export function verifyBeagleArchiveRecord(archivePath, entries, expectedRecordBytes, extractFile) {
  const entry = entries.find(({ normalizedPath }) => normalizedPath === BEAGLE_PACKAGED_RECORD);
  if (!entry || !extractFile(archivePath, entry.lookupPath, false).equals(expectedRecordBytes)) throw new Error("ASAR Beagle build provenance does not match the prepared helper");
}

export async function verifyPackagedBeagleRuntime({ projectDirectory = ROOT_DIRECTORY, resourcesDirectory,
  platform = process.platform, architecture = process.arch, stage = "packaged", environment = process.env,
  run = runRdpCommand, evidence } = {}) {
  evidence ??= await verifyPreparedBeagleRuntime({ projectDirectory, platform, architecture, run });
  const directory = join(resourcesDirectory, "beagle");
  for (const [name, expected] of [["source-provenance.json", evidence.sourceBytes], ["provenance.json", evidence.recordBytes], ...evidence.supportFiles]) {
    if (!(await readFile(join(directory, name))).equals(expected)) throw new Error(`Packaged Beagle ${name} changed`);
  }
  const executablePath = join(directory, evidence.record.artifact.fileName);
  const executable = await readFile(executablePath);
  assertBeagleArchitecture(executable, evidence.record.build.target);
  if (process.platform !== "win32" && !((await stat(executablePath)).mode & 0o111)) throw new Error("Packaged Beagle helper is not executable");
  const unchanged = executable.equals(evidence.executable);
  const required = platform !== "linux" && stage === "packaged" && (["true", "1"].includes(environment.SLIVER_GUI_REQUIRE_SIGNED_CHILD) || releaseSigningProfile(environment) === "self-signed");
  if (!unchanged) {
    if (platform === "linux" || (platform === "darwin" && stage === "before-sign")) throw new Error("Packaged Beagle helper changed before signing");
    if (platform === "win32") verifyWindowsSigningChanges(evidence.executable, executable);
  }
  if (!unchanged || required) await verifyBeagleSignature({ projectDirectory, resourcesDirectory, executablePath, platform, stage, environment, run, required });
  await verifyBeagleBuildInfo(executablePath, evidence.record, { run, architecture });
}

async function verifyBeagleSignature({ projectDirectory, resourcesDirectory, executablePath, platform, stage, environment, run, required }) {
  const profile = releaseSigningProfile(environment);
  if (platform === "win32") {
    const appPath = stage === "before-sign" ? executablePath : join(dirname(resourcesDirectory), "Sliver GUI.exe");
    if (profile === "self-signed") {
      const { manifest } = await readUpdateSigningAssets(projectDirectory);
      return verifyPinnedWindowsSignatures({ appPath, executablePath, expectedSha256: manifest.windows.sha256,
        expectedPublisher: manifest.windows.subject, environment, run });
    }
    const expected = environment.WIN_CSC_PUBLISHER_NAME?.trim();
    if (required && !expected) throw new Error("Signed Beagle helper verification requires WIN_CSC_PUBLISHER_NAME");
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
      "$ErrorActionPreference = 'Stop'", "$paths = @($env:SLIVER_GUI_BEAGLE_HELPER, $env:SLIVER_GUI_BEAGLE_APPLICATION)",
      "foreach ($path in $paths) {", "  $signature = Get-AuthenticodeSignature -LiteralPath $path",
      "  if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'Invalid Beagle Authenticode signature' }",
      "  [Console]::Out.WriteLine($signature.SignerCertificate.Subject)", "}",
    ].join("\n")], { env: { ...windowsPowerShellEnvironment(environment), SLIVER_GUI_BEAGLE_HELPER: executablePath, SLIVER_GUI_BEAGLE_APPLICATION: appPath } });
    const publishers = stdout.trim().split(/\r?\n/u);
    if (publishers.length !== 2 || publishers[0] !== publishers[1] || (expected && publishers[0] !== expected)) throw new Error("Beagle Authenticode publisher mismatch");
    return;
  }
  if (platform === "darwin") {
    const appPath = resolve(resourcesDirectory, "../..");
    if (profile === "self-signed") {
      const { manifest } = await readUpdateSigningAssets(projectDirectory);
      return verifyPinnedMacosSignatures({ appPath, expectedSha256: manifest.macos.sha256, run });
    }
    await run("/usr/bin/codesign", ["--verify", "--all-architectures", "--strict", executablePath]);
    const expected = environment.APPLE_TEAM_ID?.trim();
    if (required && !expected) throw new Error("Signed Beagle helper verification requires APPLE_TEAM_ID");
    const parent = await run("/usr/bin/codesign", ["--display", "--verbose=4", appPath]);
    const parentTeam = `${parent.stdout}\n${parent.stderr}`.match(/^TeamIdentifier=(.+)$/mu)?.[1];
    for (const architecture of ["x86_64", "arm64"]) {
      const details = await run("/usr/bin/codesign", ["--display", "--architecture", architecture, "--verbose=4", executablePath]);
      const team = `${details.stdout}\n${details.stderr}`.match(/^TeamIdentifier=(.+)$/mu)?.[1];
      if (!team || team === "not set" || team !== parentTeam || (expected && team !== expected)) throw new Error("Beagle nested Mach-O signer mismatch");
    }
    return;
  }
  throw new Error("Beagle helper changed on an unsigned platform");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--resources");
  if (index !== -1) {
    if (!process.argv[index + 1]) throw new Error("--resources requires an application resources directory");
    await verifyPackagedBeagleRuntime({ resourcesDirectory: resolve(process.argv[index + 1]) });
  } else await verifyPreparedBeagleRuntime({ hostOnly: process.argv.includes("--host") });
  console.log("Verified Beagle release provenance, architecture, build identity and licenses");
}
