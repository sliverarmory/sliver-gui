import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function releaseSigningProfile(environment = process.env) {
  const profile = environment.SLIVER_GUI_SIGNING_PROFILE || "developer-id";
  if (profile !== "developer-id" && profile !== "self-signed") {
    throw new Error(`Unsupported SLIVER_GUI_SIGNING_PROFILE: ${profile}`);
  }
  return profile;
}

export async function readUpdateSigningAssets(projectDirectory) {
  const directory = join(projectDirectory, "build", "update-signing");
  const manifestBytes = await readFile(join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported update signing manifest version");
  const files = new Map([["manifest.json", manifestBytes]]);
  for (const platform of ["macos", "windows"]) {
    const expected = manifest[platform]?.sha256;
    if (typeof expected !== "string" || !/^[0-9a-f]{64}$/u.test(expected)) {
      throw new Error(`Update signing manifest has no valid ${platform} SHA-256 fingerprint`);
    }
    const bytes = await readFile(join(directory, `${platform}.cer`));
    const certificate = new X509Certificate(bytes);
    if (!bytes.equals(certificate.raw) || sha256(bytes) !== expected) {
      throw new Error(`Update signing ${platform} certificate does not match its pinned DER fingerprint`);
    }
    if (certificate.issuer !== certificate.subject || !certificate.verify(certificate.publicKey)) {
      throw new Error(`Update signing ${platform} certificate must be self-signed`);
    }
    if (!certificate.keyUsage?.includes("1.3.6.1.5.5.7.3.3")) {
      throw new Error(`Update signing ${platform} certificate must permit code signing`);
    }
    if (Date.now() < Date.parse(certificate.validFrom) || Date.now() > Date.parse(certificate.validTo)) {
      throw new Error(`Update signing ${platform} certificate is outside its validity interval`);
    }
    files.set(`${platform}.cer`, bytes);
  }
  if (typeof manifest.windows.subject !== "string" || !manifest.windows.subject.includes("=") || /[\r\n\0]/u.test(manifest.windows.subject)) {
    throw new Error("Update signing manifest requires the full Windows certificate Subject");
  }
  return { manifest, files };
}

export async function verifyPinnedMacosSignatures({ appPath, expectedSha256, run }) {
  const codePaths = [appPath, ...await machOFiles(join(appPath, "Contents"))];
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-gui-signatures-"));
  try {
    for (const [index, path] of codePaths.entries()) {
      await run("/usr/bin/codesign", ["--verify", "--all-architectures", "--strict", "--verbose=2", path]);
      const architectures = path === appPath
        ? ["x86_64", "arm64"]
        : (await run("/usr/bin/lipo", ["-archs", path])).stdout.trim().split(/\s+/u);
      if (architectures.length === 0 || architectures.some((architecture) => !["x86_64", "arm64"].includes(architecture))) {
        throw new Error(`Packaged macOS code has unsupported architectures: ${path}`);
      }
      for (const architecture of architectures) {
        if (path === appPath) {
          const details = await run("/usr/bin/codesign", ["--display", "--architecture", architecture, "--verbose=4", path]);
          if (!/^CodeDirectory .*flags=\S*\([^)]*\bruntime\b[^)]*\)/mu.test(`${details.stdout}\n${details.stderr}`)) {
            throw new Error(`Packaged macOS app must enable hardened runtime (${architecture})`);
          }
        }
        const prefix = join(temporaryDirectory, `certificate-${index}-${architecture}-`);
        await run("/usr/bin/codesign", ["--display", "--architecture", architecture, "--extract-certificates", prefix, path]);
        const leaf = await readFile(`${prefix}0`);
        if (sha256(leaf) !== expectedSha256) {
          throw new Error(`Packaged macOS code does not match the pinned signing certificate (${architecture}): ${path}`);
        }
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function machOFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await machOFiles(path));
    else if (entry.isFile()) {
      // Follow the bundle's physical file tree only, avoiding framework symlink duplicates.
      const file = await open(path, "r");
      try {
        const bytes = Buffer.alloc(4);
        const { bytesRead } = await file.read(bytes, 0, 4, 0);
        if (bytesRead === 4 && ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(bytes.toString("hex"))) {
          files.push(path);
        }
      } finally {
        await file.close();
      }
    }
  }
  return files;
}

export async function verifyPinnedWindowsSignatures({ appPath, executablePath, expectedSha256, expectedPublisher, run, environment = process.env }) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$sha256 = [System.Security.Cryptography.SHA256]::Create()",
    "try {",
    "  foreach ($path in @($env:SLIVER_GUI_CHILD_EXECUTABLE, $env:SLIVER_GUI_APPLICATION_EXECUTABLE)) {",
    "    $signature = Get-AuthenticodeSignature -LiteralPath $path",
    "    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw \"Invalid Authenticode signature: $path ($($signature.Status))\" }",
    "    $fingerprint = ([BitConverter]::ToString($sha256.ComputeHash($signature.SignerCertificate.RawData))).Replace('-', '').ToLowerInvariant()",
    "    if ($fingerprint -cne $env:SLIVER_GUI_EXPECTED_CERTIFICATE_SHA256) { throw \"Unexpected Authenticode signing certificate: $path\" }",
    "    if ($signature.SignerCertificate.Subject -cne $env:SLIVER_GUI_EXPECTED_PUBLISHER) { throw \"Unexpected Authenticode publisher: $path\" }",
    "  }",
    "} finally { $sha256.Dispose() }",
  ].join("\n");
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: {
      ...environment,
      SLIVER_GUI_APPLICATION_EXECUTABLE: appPath,
      SLIVER_GUI_CHILD_EXECUTABLE: executablePath,
      SLIVER_GUI_EXPECTED_CERTIFICATE_SHA256: expectedSha256,
      SLIVER_GUI_EXPECTED_PUBLISHER: expectedPublisher,
    },
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
