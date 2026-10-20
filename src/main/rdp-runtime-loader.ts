import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

import { RDP_PROTOCOL_VERSION } from "../shared/rdp-contracts.js";
import { rdpRecord } from "../shared/rdp-validation.js";
import { windowsPowerShellEnvironment } from "../shared/windows-powershell-environment.js";
import { rdpRuntimeEnvironment } from "./rdp-runtime.js";
import { readBoundedRegularFile } from "./secure-file.js";

const FAILURE = "The bundled RDP runtime could not be verified. Rebuild or reinstall Sliver GUI.";
const SHA256 = /^[a-f0-9]{64}$/u;
interface CommandOptions { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }
export type RdpVerificationCommand = (file: string, args: readonly string[], options: CommandOptions) => Promise<string>;
export interface ResolveVerifiedRdpRuntimeOptions {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly developmentRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  /** Test seam; production always executes fixed helper and OS verifier paths. */
  readonly execute?: RdpVerificationCommand;
}

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
const execute: RdpVerificationCommand = (file, args, options) => new Promise((accept, reject) => {
  execFile(file, [...args], { ...options, encoding: "utf8", windowsHide: true, shell: false }, (error, stdout) => {
    if (error) reject(new Error(FAILURE));
    else accept(stdout);
  });
});

async function bundledFile(root: string, path: string, limit: number, archiveMember = false): Promise<Buffer> {
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(path)]);
  if (!canonicalFile.startsWith(`${canonicalRoot}${sep}`)) throw new Error(FAILURE);
  if (archiveMember) {
    // ASAR lstat inodes are synthetic; an opened member has a real descriptor.
    // Check its size/type, cap the read, and compare that descriptor to itself.
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > limit) throw new Error(FAILURE);
    const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== before.size || opened.size > limit) throw new Error(FAILURE);
      const bytes = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      if (length > limit || length !== opened.size || opened.dev !== after.dev || opened.ino !== after.ino ||
          opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw new Error(FAILURE);
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }
  return (await readBoundedRegularFile(path, { label: "RDP runtime", maxBytes: limit })).data;
}

/** Reject missing, replaced and incompatible helpers before a connection sees credentials. */
export async function resolveVerifiedRdpRuntime(options: ResolveVerifiedRdpRuntimeOptions): Promise<string> {
  try {
    const platform = options.platform ?? process.platform;
    const architecture = options.architecture ?? process.arch;
    const triple = platform === "darwin" && architecture === "arm64" ? "aarch64-apple-darwin"
      : platform === "darwin" && architecture === "x64" ? "x86_64-apple-darwin"
        : platform === "win32" && architecture === "x64" ? "x86_64-pc-windows-msvc"
          : platform === "linux" && architecture === "x64" ? "x86_64-unknown-linux-gnu" : undefined;
    if (!triple || !isAbsolute(options.resourcesPath) || !isAbsolute(options.developmentRoot)) throw new Error(FAILURE);
    const root = options.isPackaged ? options.resourcesPath : options.developmentRoot;
    const directory = options.isPackaged ? join(root, "rdp") : join(root, "native/rdp/bin");
    const sourcePath = options.isPackaged ? join(root, "app.asar/protocol/ironrdp-provenance.json") : join(root, "protocol/ironrdp-provenance.json");
    const [sourceBytes, copiedSource, recordBytes] = await Promise.all([
      bundledFile(root, sourcePath, 64 * 1024, options.isPackaged),
      bundledFile(root, join(directory, "source-provenance.json"), 64 * 1024),
      bundledFile(root, join(directory, "provenance.json"), 2 * 1024 * 1024),
    ]);
    if (!sourceBytes.equals(copiedSource)) throw new Error(FAILURE);
    if (options.isPackaged && !recordBytes.equals(await bundledFile(root,
      join(root, "app.asar/native/rdp/bin/provenance.json"), 2 * 1024 * 1024, true))) throw new Error(FAILURE);
    const manifest = rdpRecord(JSON.parse(sourceBytes.toString("utf8")));
    const source = rdpRecord(manifest["source"]);
    const record = rdpRecord(JSON.parse(recordBytes.toString("utf8")));
    const artifact = rdpRecord(record["artifact"]);
    const build = rdpRecord(record["build"]);
    const slices = build["slices"];
    const inputs = record["inputs"];
    const buildIdentity = record["buildIdentity"];
    const filename = platform === "win32" ? "sliver-rdp.exe" : "sliver-rdp";
    const expectedTarget = platform === "darwin" ? "darwin-universal" : platform === "win32" ? "windows-x64" : "linux-x64";
    if (manifest["schemaVersion"] !== 1 || manifest["protocolVersion"] !== RDP_PROTOCOL_VERSION ||
        source["repository"] !== "https://github.com/sliverarmory/IronRDP" || typeof source["commit"] !== "string" || !/^[a-f0-9]{40}$/u.test(source["commit"]) ||
        record["schemaVersion"] !== 1 || record["protocolVersion"] !== RDP_PROTOCOL_VERSION ||
        JSON.stringify(record["source"]) !== JSON.stringify(source) || record["sourceManifestSha256"] !== digest(sourceBytes) ||
        typeof buildIdentity !== "string" || !SHA256.test(buildIdentity) || artifact["fileName"] !== filename ||
        !Array.isArray(inputs) || inputs.length === 0 || buildIdentity !== digest(Buffer.from(JSON.stringify({ manifest, inputs }))) ||
        typeof artifact["sha256"] !== "string" || !SHA256.test(artifact["sha256"]) ||
        !Number.isSafeInteger(artifact["size"]) || (artifact["size"] as number) <= 0 ||
        !Array.isArray(slices) || !slices.some((slice: unknown) => rdpRecord(slice)["target"] === triple) ||
        (options.isPackaged && (build["target"] !== expectedTarget || slices.length !== (platform === "darwin" ? 2 : 1)))) throw new Error(FAILURE);
    const executablePath = join(directory, filename);
    const bytes = await bundledFile(root, executablePath, 256 * 1024 * 1024);
    const metadata = await lstat(executablePath);
    if (platform !== "win32" && !(metadata.mode & 0o111)) throw new Error(FAILURE);
    const run = options.execute ?? execute;
    const commandOptions: CommandOptions = { timeout: 15_000, maxBuffer: 16 * 1024, env: rdpRuntimeEnvironment() };
    if (digest(bytes) !== artifact["sha256"] || bytes.length !== artifact["size"]) {
      if (!options.isPackaged || platform === "linux") throw new Error(FAILURE);
      await verifySameApplicationSigner(platform, options.resourcesPath, executablePath, run, commandOptions);
    }
    const info = rdpRecord(JSON.parse(await run(executablePath, ["--build-info"], commandOptions)));
    if (info["name"] !== "sliver-rdp" || info["protocol"] !== RDP_PROTOCOL_VERSION ||
        info["ironrdpRevision"] !== source["commit"] || info["buildIdentity"] !== buildIdentity || info["target"] !== triple) throw new Error(FAILURE);
    // Catch replacements during verification; all credential use occurs after this returns.
    const after = await lstat(executablePath);
    if (after.isSymbolicLink() || after.dev !== metadata.dev || after.ino !== metadata.ino || after.size !== metadata.size ||
        after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs) throw new Error(FAILURE);
    return executablePath;
  } catch { throw new Error(FAILURE); }
}

async function verifySameApplicationSigner(platform: NodeJS.Platform, resourcesPath: string, helperPath: string,
  run: RdpVerificationCommand, options: CommandOptions): Promise<void> {
  if (platform === "win32") {
    const appPath = resolve(resourcesPath, "..", "Sliver GUI.exe");
    const script = [
      "$ErrorActionPreference = 'Stop'", "$hash = [Security.Cryptography.SHA256]::Create()", "try {",
      "  $fingerprints = @()", "  foreach ($path in @($env:SLIVER_GUI_VERIFY_RDP, $env:SLIVER_GUI_VERIFY_APP)) {",
      "    $signature = Get-AuthenticodeSignature -LiteralPath $path",
      "    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'Invalid code signature' }",
      "    $fingerprints += [Convert]::ToBase64String($hash.ComputeHash($signature.SignerCertificate.RawData))", "  }",
      "  if ($fingerprints[0] -cne $fingerprints[1]) { throw 'RDP signer mismatch' }", "  [Console]::Out.Write('verified')",
      "} finally { $hash.Dispose() }",
    ].join("\n");
    const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      ...options, env: { ...windowsPowerShellEnvironment(options.env), SLIVER_GUI_VERIFY_RDP: helperPath, SLIVER_GUI_VERIFY_APP: appPath },
    });
    if (output !== "verified") throw new Error(FAILURE);
    return;
  }
  if (platform !== "darwin") throw new Error(FAILURE);
  const appPath = resolve(resourcesPath, "../..");
  await run("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", helperPath], options);
  await run("/usr/bin/codesign", ["--verify", "--strict", appPath], options);
  const directory = await mkdtemp(join(tmpdir(), "sliver-rdp-signature-"));
  try {
    const appPrefix = join(directory, "app-");
    await run("/usr/bin/codesign", ["--display", `--extract-certificates=${appPrefix}`, appPath], options);
    const appCertificate = await readFile(`${appPrefix}0`);
    if (!appCertificate.length || appCertificate.length > 64 * 1024) throw new Error(FAILURE);
    for (const architecture of ["x86_64", "arm64"]) {
      const prefix = join(directory, `helper-${architecture}-`);
      await run("/usr/bin/codesign", ["--display", "--architecture", architecture, `--extract-certificates=${prefix}`, helperPath], options);
      if (!(await readFile(`${prefix}0`)).equals(appCertificate)) throw new Error(FAILURE);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
