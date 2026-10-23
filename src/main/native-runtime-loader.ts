import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { windowsPowerShellEnvironment } from "../shared/windows-powershell-environment.js";
import { readBoundedRegularFile } from "./secure-file.js";

const FAILURE = "The bundled runtime could not be verified.";
export interface NativeVerificationCommandOptions { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }
export type NativeVerificationCommand = (file: string, args: readonly string[], options: NativeVerificationCommandOptions) => Promise<string>;
export const executeNativeVerification: NativeVerificationCommand = (file, args, options) => new Promise((accept, reject) => {
  execFile(file, [...args], { ...options, encoding: "utf8", windowsHide: true, shell: false }, (error, stdout) => {
    if (error) reject(new Error(FAILURE));
    else accept(stdout);
  });
});

export async function readBundledNativeFile(root: string, path: string, limit: number, archiveMember = false): Promise<Buffer> {
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
  return (await readBoundedRegularFile(path, { label: "Bundled runtime", maxBytes: limit })).data;
}

export async function verifySameApplicationSigner(platform: NodeJS.Platform, resourcesPath: string, helperPath: string,
  run: NativeVerificationCommand, options: NativeVerificationCommandOptions): Promise<void> {
  if (platform === "win32") {
    const appPath = resolve(resourcesPath, "..", "Sliver GUI.exe");
    const script = [
      "$ErrorActionPreference = 'Stop'", "$hash = [Security.Cryptography.SHA256]::Create()", "try {",
      "  $fingerprints = @()", "  foreach ($path in @($env:SLIVER_GUI_VERIFY_HELPER, $env:SLIVER_GUI_VERIFY_APP)) {",
      "    $signature = Get-AuthenticodeSignature -LiteralPath $path",
      "    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'Invalid code signature' }",
      "    $fingerprints += [Convert]::ToBase64String($hash.ComputeHash($signature.SignerCertificate.RawData))", "  }",
      "  if ($fingerprints[0] -cne $fingerprints[1]) { throw 'Runtime signer mismatch' }", "  [Console]::Out.Write('verified')",
      "} finally { $hash.Dispose() }",
    ].join("\n");
    const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      ...options, env: { ...windowsPowerShellEnvironment(options.env), SLIVER_GUI_VERIFY_HELPER: helperPath, SLIVER_GUI_VERIFY_APP: appPath },
    });
    if (output !== "verified") throw new Error(FAILURE);
    return;
  }
  if (platform !== "darwin") throw new Error(FAILURE);
  const appPath = resolve(resourcesPath, "../..");
  await run("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", helperPath], options);
  await run("/usr/bin/codesign", ["--verify", "--strict", appPath], options);
  const directory = await mkdtemp(join(tmpdir(), "sliver-runtime-signature-"));
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
