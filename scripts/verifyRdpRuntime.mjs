import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { windowsPowerShellEnvironment } from "../src/shared/windows-powershell-environment.ts";
import {
  ROOT_DIRECTORY, RDP_OUTPUT_DIRECTORY, RDP_SOURCE_MANIFEST, RDP_TARGETS,
  rdpExecutableName, rdpSourceInputs, rdpTargetForHost, runRdpCommand, sha256, validateRdpSourceManifest,
} from "./buildRdpRuntime.mjs";
import { readUpdateSigningAssets, releaseSigningProfile, verifyPinnedMacosSignatures, verifyPinnedWindowsSignatures } from "./releaseSigning.mjs";
import { verifyWindowsSigningChanges } from "./verifyWindowsSigningChanges.mjs";

/** Read native headers without trusting the provenance's architecture claims. */
export function rdpBinaryArchitectures(bytes) {
  const range = (offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.length) throw new Error("Truncated RDP executable header");
  };
  range(0, 4);
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    range(0, 20);
    if (bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) throw new Error("RDP ELF must be 64-bit x86_64");
    return ["x86_64-unknown-linux-gnu"];
  }
  if (bytes.readUInt16LE(0) === 0x5a4d) {
    range(0, 64);
    const offset = bytes.readUInt32LE(60);
    range(offset, 26);
    if (bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664 || bytes.readUInt16LE(offset + 24) !== 0x20b) {
      throw new Error("RDP PE must be 64-bit x86_64");
    }
    return ["x86_64-pc-windows-msvc"];
  }
  const cpuTarget = (cpu) => {
    if (cpu === 0x01000007) return "x86_64-apple-darwin";
    if (cpu === 0x0100000c) return "aarch64-apple-darwin";
    throw new Error("Unsupported RDP Mach-O architecture");
  };
  if (bytes.readUInt32LE(0) === 0xfeedfacf) {
    range(0, 32);
    return [cpuTarget(bytes.readUInt32LE(4))];
  }
  const magic = bytes.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    range(0, 8);
    const count = bytes.readUInt32BE(4);
    if (count !== 2) throw new Error("Universal RDP helper must contain exactly two slices");
    const stride = magic === 0xcafebabe ? 20 : 32;
    range(8, count * stride);
    const targets = [];
    for (let index = 0; index < count; index += 1) {
      const cursor = 8 + index * stride;
      const offset = stride === 20 ? bytes.readUInt32BE(cursor + 8) : Number(bytes.readBigUInt64BE(cursor + 8));
      const length = stride === 20 ? bytes.readUInt32BE(cursor + 12) : Number(bytes.readBigUInt64BE(cursor + 16));
      range(offset, length);
      if (length < 32) throw new Error("Empty RDP Mach-O slice");
      const target = cpuTarget(bytes.readUInt32BE(cursor));
      if (rdpBinaryArchitectures(bytes.subarray(offset, offset + length))[0] !== target) throw new Error("RDP Mach-O slice architecture mismatch");
      targets.push(target);
    }
    if (new Set(targets).size !== 2) throw new Error("Universal RDP helper repeats an architecture");
    return targets.sort();
  }
  throw new Error("Unrecognized RDP executable format");
}

export function validateRdpBuildRecord(record, manifest, sourceBytes, inputs, target) {
  if (record.schemaVersion !== 1 || record.protocolVersion !== manifest.protocolVersion ||
      record.sourceManifestSha256 !== sha256(sourceBytes) ||
      JSON.stringify(record.source) !== JSON.stringify(manifest.source) ||
      JSON.stringify(record.inputs) !== JSON.stringify(inputs) ||
      record.buildIdentity !== sha256(JSON.stringify({ manifest, inputs })) ||
      !record.toolchain?.rust?.startsWith(`rustc ${manifest.toolchain.rust} `) ||
      record.build?.target !== target || record.build?.macosDeploymentTarget !== manifest.build.macosDeploymentTarget ||
      record.build?.windowsCrt !== manifest.build.windowsCrt ||
      record.artifact?.fileName !== rdpExecutableName(target) ||
      !/^[a-f0-9]{64}$/u.test(record.artifact?.sha256 ?? "") ||
      !Number.isSafeInteger(record.artifact?.size) || record.artifact.size <= 0 ||
      JSON.stringify(record.build?.slices?.map(({ target: slice }) => slice)) !== JSON.stringify(RDP_TARGETS[target])) {
    throw new Error("RDP build provenance does not match the pinned source, toolchain, ABI or package target; rebuild the helper");
  }
  for (const slice of record.build.slices) {
    if (!/^[a-f0-9]{64}$/u.test(slice.sha256 ?? "") || !Number.isSafeInteger(slice.size) || slice.size <= 0) throw new Error("Invalid RDP slice provenance");
  }
}

export async function verifyRdpBuildInfo(executablePath, record, { run = runRdpCommand, architecture = process.arch } = {}) {
  const options = { signal: AbortSignal.timeout(30_000) };
  const info = JSON.parse((await run(executablePath, ["--build-info"], options)).stdout);
  const target = record.build.target === "darwin-universal"
    ? architecture === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
    : record.build.slices[0].target;
  if (info.name !== "sliver-rdp" || info.protocol !== record.protocolVersion || info.ironrdpRevision !== record.source.commit ||
      info.target !== target || info.buildIdentity !== record.buildIdentity) {
    throw new Error("RDP executable build identity/ABI does not match its provenance");
  }
  const selfTest = JSON.parse((await run(executablePath, ["--self-test"], { signal: AbortSignal.timeout(30_000) })).stdout);
  if (selfTest.ok !== true) throw new Error("RDP helper self-test failed");
}

export async function verifyPreparedRdpRuntime({ projectDirectory = ROOT_DIRECTORY, platform = process.platform,
  architecture = process.arch, hostOnly = false, run = runRdpCommand } = {}) {
  const sourceBytes = await readFile(join(projectDirectory, RDP_SOURCE_MANIFEST));
  const manifest = validateRdpSourceManifest(JSON.parse(sourceBytes));
  const directory = join(projectDirectory, RDP_OUTPUT_DIRECTORY);
  const recordBytes = await readFile(join(directory, "provenance.json"));
  const record = JSON.parse(recordBytes);
  const inputs = await rdpSourceInputs(projectDirectory);
  const target = rdpTargetForHost(platform, architecture, hostOnly);
  validateRdpBuildRecord(record, manifest, sourceBytes, inputs, target);
  const executablePath = join(directory, record.artifact.fileName);
  const [executable, metadata, inventory, license, copiedManifest] = await Promise.all([
    readFile(executablePath), stat(executablePath), readFile(join(directory, "THIRD_PARTY_LICENSES.txt")),
    readFile(join(directory, "LICENSE")), readFile(join(directory, "source-provenance.json")),
  ]);
  if (!metadata.isFile() || executable.length !== record.artifact.size || sha256(executable) !== record.artifact.sha256 ||
      !copiedManifest.equals(sourceBytes) || sha256(inventory) !== record.licenseInventorySha256 ||
      sha256(license) !== record.projectLicenseSha256 || !(await readFile(join(projectDirectory, "LICENSE"))).equals(license)) {
    throw new Error("Prepared RDP executable/provenance/licenses failed integrity verification");
  }
  assertArchitecture(executable, target);
  if (platform !== "win32" && !(metadata.mode & 0o111)) throw new Error("RDP helper is not executable");
  await verifyRdpBuildInfo(executablePath, record, { run, architecture });
  return { sourceBytes, recordBytes, record, executable, inventory, license };
}

function assertArchitecture(bytes, target) {
  if (JSON.stringify(rdpBinaryArchitectures(bytes).sort()) !== JSON.stringify([...RDP_TARGETS[target]].sort())) {
    throw new Error("RDP executable architectures do not match the package target");
  }
}

export async function verifyPackagedRdpRuntime({ projectDirectory = ROOT_DIRECTORY, resourcesDirectory,
  platform = process.platform, architecture = process.arch, stage = "packaged", environment = process.env,
  run = runRdpCommand, evidence } = {}) {
  evidence ??= await verifyPreparedRdpRuntime({ projectDirectory, platform, architecture, run });
  const directory = join(resourcesDirectory, "rdp");
  for (const [name, expected] of [["source-provenance.json", evidence.sourceBytes], ["provenance.json", evidence.recordBytes],
    ["THIRD_PARTY_LICENSES.txt", evidence.inventory], ["LICENSE", evidence.license]]) {
    if (!(await readFile(join(directory, name))).equals(expected)) throw new Error(`Packaged RDP ${name} changed`);
  }
  const executablePath = join(directory, evidence.record.artifact.fileName);
  const executable = await readFile(executablePath);
  assertArchitecture(executable, evidence.record.build.target);
  if (platform !== "win32" && !((await stat(executablePath)).mode & 0o111)) throw new Error("Packaged RDP helper is not executable");
  const unchanged = executable.equals(evidence.executable);
  const required = platform !== "linux" && stage === "packaged" && (["true", "1"].includes(environment.SLIVER_GUI_REQUIRE_SIGNED_CHILD) ||
    releaseSigningProfile(environment) === "self-signed");
  if (!unchanged) {
    if (platform === "linux" || (platform === "darwin" && stage === "before-sign")) throw new Error("Packaged RDP helper changed before signing");
    if (platform === "win32") verifyWindowsSigningChanges(evidence.executable, executable);
  }
  if (!unchanged || required) {
    await verifyRdpSignature({ projectDirectory, resourcesDirectory, executablePath, platform, stage, environment, run, required });
  }
  await verifyRdpBuildInfo(executablePath, evidence.record, { run, architecture });
}

async function verifyRdpSignature({ projectDirectory, resourcesDirectory, executablePath, platform, stage, environment, run, required }) {
  const profile = releaseSigningProfile(environment);
  if (platform === "win32") {
    const appPath = stage === "before-sign" ? executablePath : join(dirname(resourcesDirectory), "Sliver GUI.exe");
    if (profile === "self-signed") {
      const { manifest } = await readUpdateSigningAssets(projectDirectory);
      return verifyPinnedWindowsSignatures({ appPath, executablePath, expectedSha256: manifest.windows.sha256,
        expectedPublisher: manifest.windows.subject, environment, run });
    }
    const expected = environment.WIN_CSC_PUBLISHER_NAME?.trim();
    if (required && !expected) throw new Error("Signed RDP helper verification requires WIN_CSC_PUBLISHER_NAME");
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
      "$ErrorActionPreference = 'Stop'", "$paths = @($env:SLIVER_GUI_RDP_HELPER, $env:SLIVER_GUI_RDP_APPLICATION)",
      "foreach ($path in $paths) {", "  $signature = Get-AuthenticodeSignature -LiteralPath $path",
      "  if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'Invalid RDP Authenticode signature' }",
      "  [Console]::Out.WriteLine($signature.SignerCertificate.Subject)", "}",
    ].join("\n")], { env: { ...windowsPowerShellEnvironment(environment), SLIVER_GUI_RDP_HELPER: executablePath, SLIVER_GUI_RDP_APPLICATION: appPath } });
    const publishers = stdout.trim().split(/\r?\n/u);
    if (publishers.length !== 2 || publishers[0] !== publishers[1] || (expected && publishers[0] !== expected)) throw new Error("RDP Authenticode publisher mismatch");
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
    if (required && !expected) throw new Error("Signed RDP helper verification requires APPLE_TEAM_ID");
    const parent = await run("/usr/bin/codesign", ["--display", "--verbose=4", appPath]);
    const parentTeam = `${parent.stdout}\n${parent.stderr}`.match(/^TeamIdentifier=(.+)$/mu)?.[1];
    for (const architecture of ["x86_64", "arm64"]) {
      const details = await run("/usr/bin/codesign", ["--display", "--architecture", architecture, "--verbose=4", executablePath]);
      const team = `${details.stdout}\n${details.stderr}`.match(/^TeamIdentifier=(.+)$/mu)?.[1];
      if (!team || team === "not set" || team !== parentTeam || (expected && team !== expected)) throw new Error("RDP nested Mach-O signer mismatch");
    }
    return;
  }
  throw new Error("RDP helper changed on an unsigned platform");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--resources");
  if (index !== -1) {
    if (!process.argv[index + 1]) throw new Error("--resources requires an application resources directory");
    await verifyPackagedRdpRuntime({ resourcesDirectory: resolve(process.argv[index + 1]) });
  } else await verifyPreparedRdpRuntime({ hostOnly: process.argv.includes("--host") });
  console.log("Verified RDP runtime provenance, architecture, ABI, licenses and self-test");
}
