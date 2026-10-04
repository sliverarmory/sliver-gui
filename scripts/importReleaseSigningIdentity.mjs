import { execFile } from "node:child_process";
import { X509Certificate, randomBytes } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { windowsPowerShellEnvironment } from "../src/shared/windows-powershell-environment.ts";

import { readUpdateSigningAssets } from "./releaseSigning.mjs";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = process.env;
const cleanup = process.argv.includes("--cleanup");

// Trust is modified only inside disposable hosted release runners, never developer machines.
if (environment.RUNNER_ENVIRONMENT !== "github-hosted" || environment.GITHUB_REF !== "refs/heads/main" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" || environment.SLIVER_GUI_SIGNING_PROFILE !== "self-signed") {
  throw new Error("Signing identity import requires a main-branch self-signed release on a GitHub-hosted runner");
}
if (!environment.RUNNER_TEMP || !environment.GITHUB_ENV) throw new Error("Missing GitHub runner paths");
const platform = process.platform;
if (platform !== "darwin" && platform !== "win32") throw new Error("Signing identity import supports macOS and Windows");

async function run(file, args, env = environment) {
  try {
    return await execute(file, args, { env, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true });
  } catch {
    // Child process errors may include private-key passwords in their command line.
    throw new Error(`Release signing ${basename(file)} operation failed`);
  }
}

async function exportEnvironment(name, value) {
  if (/[\r\n\0]/u.test(value)) throw new Error("Invalid signing environment value");
  await appendFile(environment.GITHUB_ENV, `${name}=${value}\n`);
}

if (cleanup) {
  const directory = environment.SLIVER_GUI_RELEASE_SIGNING_DIRECTORY;
  if (directory) {
    const absolute = resolve(directory);
    if (dirname(absolute) !== resolve(environment.RUNNER_TEMP) || !basename(absolute).startsWith("sliver-gui-release-signing-")) {
      throw new Error("Refusing to clean signing material outside the release runner directory");
    }
    const state = JSON.parse(await readFile(join(absolute, "state.json"), "utf8"));
    const failures = [];
    if (platform === "darwin") {
      // Admin trust removal can block waiting for UI on hosted macOS runners.
      // The disposable VM owns that public trust record; remove all private
      // signing material and restore the original keychain search list here.
      for (const operation of [
        () => run("/usr/bin/security", ["list-keychains", "-d", "user", "-s", ...state.originalKeychains]),
        () => run("/usr/bin/security", ["delete-keychain", join(absolute, "signing.keychain-db")]),
      ]) {
        try { await operation(); } catch (error) { failures.push(error.message); }
      }
    } else {
      for (const store of ["Root", "TrustedPublisher"]) {
        try { await run("certutil.exe", ["-delstore", store, state.thumbprint]); }
        catch (error) { failures.push(error.message); }
      }
    }
    await rm(absolute, { recursive: true, force: true });
    if (failures.length) throw new Error(`Signing cleanup failed: ${failures.join("; ")}`);
  }
} else {
  const { files, manifest } = await readUpdateSigningAssets(root);
  const directory = await mkdtemp(join(environment.RUNNER_TEMP, "sliver-gui-release-signing-"));
  await exportEnvironment("SLIVER_GUI_RELEASE_SIGNING_DIRECTORY", directory);
  if (platform === "darwin") {
    const encoded = environment.MAC_CSC_LINK;
    const password = environment.MAC_CSC_KEY_PASSWORD;
    if (!encoded || !password) throw new Error("Missing macOS release signing secrets");
    const original = await run("/usr/bin/security", ["list-keychains", "-d", "user"]);
    const originalKeychains = original.stdout.split("\n").map((line) => line.trim().replace(/^"|"$/gu, "")).filter(Boolean);
    await writeFile(join(directory, "state.json"), JSON.stringify({ originalKeychains }), { mode: 0o600 });
    const p12 = join(directory, "identity.p12");
    await writeFile(p12, Buffer.from(encoded, "base64"), { mode: 0o600 });
    const extracted = await run("/usr/bin/openssl", ["pkcs12", "-in", p12, "-clcerts", "-nokeys", "-passin", "env:MAC_CSC_KEY_PASSWORD"]);
    const certificate = new X509Certificate(extracted.stdout);
    if (!certificate.raw.equals(files.get("macos.cer"))) throw new Error("macOS signing secret does not match the pinned public certificate");
    const commonName = certificate.subject.split("\n").find((line) => line.startsWith("CN="))?.slice(3);
    if (!commonName?.startsWith("Developer ID Application: ")) throw new Error("macOS signing certificate has an invalid identity name");
    const keychain = join(directory, "signing.keychain-db");
    const keychainPassword = randomBytes(32).toString("hex");
    await run("/usr/bin/security", ["create-keychain", "-p", keychainPassword, keychain]);
    await run("/usr/bin/security", ["set-keychain-settings", "-lut", "21600", keychain]);
    await run("/usr/bin/security", ["unlock-keychain", "-p", keychainPassword, keychain]);
    await run("/usr/bin/security", ["import", p12, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign", "-T", "/usr/bin/productbuild"]);
    await run("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychain]);
    await run("/usr/bin/sudo", ["-n", "/usr/bin/security", "add-trusted-cert", "-d", "-r", "trustRoot", "-p", "codeSign", "-k", keychain, join(root, "build/update-signing/macos.cer")]);
    await run("/usr/bin/security", ["list-keychains", "-d", "user", "-s", keychain, ...originalKeychains]);
    await exportEnvironment("CSC_KEYCHAIN", keychain);
    await exportEnvironment("CSC_NAME", commonName.slice("Developer ID Application: ".length));
    await rm(p12);
  } else {
    const certificate = new X509Certificate(files.get("windows.cer"));
    const thumbprint = certificate.fingerprint.replaceAll(":", "");
    await writeFile(join(directory, "state.json"), JSON.stringify({ thumbprint }), { mode: 0o600 });
    const certificatePath = join(root, "build/update-signing/windows.cer");
    const script = "$ErrorActionPreference = 'Stop'; $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($env:SLIVER_GUI_SIGNING_CERTIFICATE); if ($certificate.Subject -cne $env:WIN_CSC_PUBLISHER_NAME) { throw 'Pinned certificate publisher mismatch' }";
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      ...windowsPowerShellEnvironment(environment), SLIVER_GUI_SIGNING_CERTIFICATE: certificatePath, WIN_CSC_PUBLISHER_NAME: manifest.windows.subject,
    });
    for (const store of ["Root", "TrustedPublisher"]) await run("certutil.exe", ["-addstore", "-f", store, certificatePath]);
  }
  console.log("Imported the pinned release signing identity into the disposable runner");
}
