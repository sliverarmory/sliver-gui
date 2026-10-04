import { Buffer } from "node:buffer";
import { join } from "node:path";

import { windowsPowerShellEnvironment } from "../shared/windows-powershell-environment.js";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

const FORBIDDEN_UPDATE_CONFIG_KEY_PATTERN =
  /^(?:access[-_]?token|api[-_]?key|auth(?:orization)?|credentials?|password|request-?headers?|secret|token)$/iu;

export interface PackagedUpdateVersions {
  readonly from: string;
  readonly to: string;
}

export type PackagedUpdateFeed = "private" | "public";

export function parsePackagedUpdateFeed(value: string | undefined): PackagedUpdateFeed {
  if (value === undefined || value === "" || value === "private") return "private";
  if (value === "public") return "public";
  throw new Error("SLIVER_GUI_UPDATE_E2E_FEED must be private or public");
}

export function packagedUpdateGithubToken(
  feed: PackagedUpdateFeed,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (feed === "public") return undefined;
  const token = environment["GH_TOKEN"];
  if (!token || token.length < 20 || /[\s\0]/u.test(token)) {
    throw new Error("GH_TOKEN must be a non-empty runtime credential without whitespace or NUL bytes");
  }
  return token;
}

export interface PackagedUpdateLaunchProfile {
  readonly arguments: string[];
  readonly userDataDirectory: string;
}

export type ObservedPromiseSettlement<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly reason: unknown; readonly status: "rejected" };

export function observePromiseSettlement<T>(promise: Promise<T>): Promise<ObservedPromiseSettlement<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ reason, status: "rejected" }),
  );
}

export function attachCleanupFailure(primaryError: unknown, cleanupError: unknown): void {
  if (
    (typeof primaryError !== "object" || primaryError === null) &&
    typeof primaryError !== "function"
  ) return;
  try {
    Object.defineProperty(primaryError, "cleanupError", {
      configurable: true,
      enumerable: false,
      value: cleanupError,
    });
  } catch {
    // The original failure may be frozen or expose a non-configurable field.
    // Cleanup callers still log the secondary failure before rethrowing it.
  }
}

interface OwnedProcessStream {
  destroy(): unknown;
}

interface OwnedApplicationProcess {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stdio: readonly (OwnedProcessStream | null | undefined)[];
  kill(signal: NodeJS.Signals): boolean;
}

export interface OwnedApplicationForCleanup {
  close(): Promise<void>;
  process(): OwnedApplicationProcess;
}

export async function cleanupOwnedApplication(
  application: OwnedApplicationForCleanup,
  label: string,
  settleTimeoutMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(settleTimeoutMs) || settleTimeoutMs <= 0) {
    throw new Error("Application cleanup timeout must be a positive integer");
  }
  let ownedProcess: OwnedApplicationProcess | undefined;
  const fallbackFailures: string[] = [];
  try {
    ownedProcess = application.process();
  } catch (error) {
    fallbackFailures.push(`could not inspect the owned process: ${cleanupErrorMessage(error)}`);
  }
  const close = observePromiseSettlement(Promise.resolve().then(() => application.close()));
  const initial = await settlementWithin(close, settleTimeoutMs);
  if (initial?.status === "fulfilled") return;

  if (ownedProcess) {
    if (ownedProcess.exitCode === null && ownedProcess.signalCode === null) {
      try {
        if (!ownedProcess.kill("SIGKILL")) fallbackFailures.push("owned process kill returned false");
      } catch (error) {
        fallbackFailures.push(`could not kill the owned process: ${cleanupErrorMessage(error)}`);
      }
    }
    const destroyedStreams = new Set<OwnedProcessStream>();
    for (const [index, stream] of ownedProcess.stdio.entries()) {
      if (!stream || destroyedStreams.has(stream)) continue;
      destroyedStreams.add(stream);
      try {
        stream.destroy();
      } catch (error) {
        fallbackFailures.push(`could not destroy owned stdio[${index}]: ${cleanupErrorMessage(error)}`);
      }
    }
  }

  const final = await settlementWithin(close, settleTimeoutMs);
  if (final?.status === "fulfilled") return;
  const closeFailure = final?.status === "rejected"
    ? cleanupErrorMessage(final.reason)
    : initial?.status === "rejected"
      ? cleanupErrorMessage(initial.reason)
      : "timed out after the transport fallback";
  const fallback = fallbackFailures.length > 0 ? `; ${fallbackFailures.join("; ")}` : "";
  throw new Error(`${label} application cleanup failed: ${closeFailure}${fallback}`);
}

async function settlementWithin<T>(
  observation: Promise<ObservedPromiseSettlement<T>>,
  timeoutMs: number,
): Promise<ObservedPromiseSettlement<T> | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolveDeadline) => {
    timeout = setTimeout(() => resolveDeadline(undefined), timeoutMs);
  });
  try {
    return await Promise.race([observation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function cleanupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function packagedUpdateLaunchProfile(
  profileRoot: string,
  platform: NodeJS.Platform,
): PackagedUpdateLaunchProfile {
  const userDataDirectory = join(profileRoot, "user-data");
  return {
    arguments: [
      "--enable-sandbox",
      // This disposable profile has no login keychain. Match the packaged
      // smoke harness so Chromium cannot block on profile-encryption prompts.
      // These flags do not change native code-signature or certificate trust.
      ...(platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
      `--user-data-dir=${userDataDirectory}`,
    ],
    userDataDirectory,
  };
}

export async function boundedUpdateDiagnostic<T>(
  label: string,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T | { readonly error: string }> {
  const outcome = await settlementWithin(observePromiseSettlement(Promise.resolve().then(operation)), timeoutMs);
  if (!outcome) return { error: `${label} timed out after ${timeoutMs}ms` };
  if (outcome.status === "rejected") return { error: `${label}: ${cleanupErrorMessage(outcome.reason)}` };
  return outcome.value;
}

export function packagedUpdateProfileEnvironment(
  profileRoot: string,
  platform: NodeJS.Platform,
): Readonly<Record<string, string>> {
  return {
    APPDATA: join(profileRoot, "AppData", "Roaming"),
    HOME: profileRoot,
    LOCALAPPDATA: join(profileRoot, "AppData", "Local"),
    USERPROFILE: profileRoot,
    XDG_CACHE_HOME: join(profileRoot, ".cache"),
    XDG_CONFIG_HOME: join(profileRoot, ".config"),
    XDG_DATA_HOME: join(profileRoot, ".local", "share"),
    // Electron resolves macOS home directories through Core Foundation, which
    // intentionally ignores HOME. Keep those application paths aligned with
    // the explicit user-data directory used by controlled Playwright launches.
    ...(platform === "darwin" ? { CFFIXED_USER_HOME: profileRoot } : {}),
  };
}

export function packagedUpdateApplicationEnvironment(
  profileRoot: string,
  platform: NodeJS.Platform,
  githubToken: string | undefined,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(inherited).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" &&
      !/(?:^|_)(?:ACCESS_KEY|API_KEY|AUTH|CREDENTIALS?|PASS(?:WORD)?|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/iu.test(entry[0]) &&
      !/^(?:APPLE_ID|CSC_LINK|MAC_CSC_LINK|WIN_CSC_LINK|NODE_OPTIONS)$/iu.test(entry[0])),
  );
  return {
    ...(platform === "win32" ? windowsPowerShellEnvironment(environment) : environment),
    ...packagedUpdateProfileEnvironment(profileRoot, platform),
    ...(githubToken ? { GH_TOKEN: githubToken } : {}),
    ...(platform === "linux" ? { APPIMAGE_EXTRACT_AND_RUN: "1" } : {}),
  };
}

export interface WindowsAuthenticodeInspection {
  readonly status: string;
  readonly statusMessage: string;
  readonly subject: string;
  readonly thumbprint: string;
}

export interface WindowsAuthenticodeInspectionCommand {
  readonly arguments: readonly string[];
  readonly executable: "powershell.exe";
}

export function windowsAuthenticodeInspectionCommand(
  executablePath: string,
): WindowsAuthenticodeInspectionCommand {
  const encodedPath = Buffer.from(executablePath, "utf16le").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$path = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Authenticode target is missing' }",
    "$signature = Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop",
    "if ($null -eq $signature) { throw 'Get-AuthenticodeSignature returned no result' }",
    "if ($null -eq $signature.SignerCertificate) { throw 'Authenticode signer certificate is missing' }",
    "[PSCustomObject]@{ Status = $signature.Status.ToString(); " +
      "StatusMessage = $signature.StatusMessage.ToString(); " +
      "Subject = $signature.SignerCertificate.Subject.ToString(); " +
      "Thumbprint = $signature.SignerCertificate.Thumbprint.ToString() } | ConvertTo-Json -Compress",
  ].join("; ");
  return {
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    executable: "powershell.exe",
  };
}

export function parseWindowsAuthenticodeInspection(content: string): WindowsAuthenticodeInspection {
  const value = JSON.parse(content) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Authenticode inspection must return one JSON object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["Status", "StatusMessage", "Subject", "Thumbprint"];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    expectedKeys.some((key) => typeof record[key] !== "string")
  ) {
    throw new Error("Authenticode inspection returned an unexpected JSON shape");
  }
  const thumbprint = record["Thumbprint"] as string;
  if (!/^[A-F0-9]{40}$/iu.test(thumbprint)) {
    throw new Error("Authenticode inspection returned an invalid certificate thumbprint");
  }
  return {
    status: record["Status"] as string,
    statusMessage: record["StatusMessage"] as string,
    subject: record["Subject"] as string,
    thumbprint: thumbprint.toUpperCase(),
  };
}

interface ParsedPrereleaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

export function parsePackagedUpdateVersions(
  fromValue: string,
  toValue: string,
  feed: PackagedUpdateFeed = "private",
): PackagedUpdateVersions {
  const from = parseVersion(fromValue, "SLIVER_GUI_UPDATE_E2E_FROM_VERSION", feed);
  const to = parseVersion(toValue, "SLIVER_GUI_UPDATE_E2E_TO_VERSION", feed);
  if (compareVersions(from, to) >= 0) {
    throw new Error("SLIVER_GUI_UPDATE_E2E_TO_VERSION must have higher SemVer precedence than the from version");
  }
  return { from: fromValue, to: toValue };
}

export function assertPrivatePackagedUpdateConfiguration(content: string, token: string): void {
  if (content.includes(token)) throw new Error("Packaged app-update.yml contains the runtime GitHub token");
  assertPackagedUpdateConfiguration(content, "private");
}

export function assertPublicPackagedUpdateConfiguration(content: string): void {
  assertPackagedUpdateConfiguration(content, "public");
}

function assertPackagedUpdateConfiguration(content: string, feed: PackagedUpdateFeed): void {
  assertSimpleUpdateConfigurationSyntax(content);

  const keyEntries = [...content.matchAll(/^([ \t]*)([A-Za-z][A-Za-z0-9_-]*):/gmu)]
    .map((match) => ({ indentation: match[1] ?? "", key: match[2] ?? "" }));
  const forbidden = keyEntries
    .map(({ key }) => key)
    .filter((key) => FORBIDDEN_UPDATE_CONFIG_KEY_PATTERN.test(key));
  if (forbidden.length > 0) {
    throw new Error(`Packaged app-update.yml contains credential field(s): ${forbidden.join(", ")}`);
  }

  const rootEntries = keyEntries.filter(({ indentation }) => indentation === "");
  const allowedRootKeys = new Set([
    "provider",
    "owner",
    "repo",
    ...(feed === "private" ? ["private"] : []),
    "channel",
    "updaterCacheDirName",
    "publisherName",
  ]);
  const unexpected = rootEntries
    .map(({ key }) => key)
    .filter((key) => !allowedRootKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Packaged app-update.yml contains unexpected root field(s): ${unexpected.join(", ")}`);
  }

  const expectedScalars = new Map([
    ["provider", "github"],
    ["owner", "sliverarmory"],
    ["repo", "sliver-gui"],
    ["updaterCacheDirName", "sliver-gui-updater"],
  ]);
  if (feed === "private") expectedScalars.set("private", "true");
  if (feed === "private" || rootEntries.some(({ key }) => key === "channel")) {
    expectedScalars.set("channel", "latest");
  }
  for (const [key, expected] of expectedScalars) {
    const count = rootEntries.filter((entry) => entry.key === key).length;
    if (count !== 1) {
      throw new Error(`Packaged app-update.yml must contain exactly one root ${key} field`);
    }
    const actual = rootScalar(content, key);
    if (actual !== expected) {
      throw new Error(`Packaged app-update.yml ${key} ${actual ?? "<missing>"} does not match ${expected}`);
    }
  }
  for (const key of ["publisherName"]) {
    if (rootEntries.filter((entry) => entry.key === key).length > 1) {
      throw new Error(`Packaged app-update.yml must contain at most one root ${key} field`);
    }
  }
}

function assertSimpleUpdateConfigurationSyntax(content: string): void {
  let parentKey: string | undefined;
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (line.trim() === "") continue;
    if (/^[ \t]/u.test(line)) {
      if (parentKey !== "publisherName" || !/^[ \t]+-[ \t]+\S/u.test(line)) {
        throw new Error(`Packaged app-update.yml uses unsupported nested YAML at line ${index + 1}`);
      }
      continue;
    }
    const root = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/u.exec(line);
    if (!root?.[1]) {
      throw new Error(`Packaged app-update.yml uses unsupported root YAML at line ${index + 1}`);
    }
    parentKey = root[1];
    if (parentKey === "publisherName" && (root[2] ?? "") !== "") {
      throw new Error("Packaged app-update.yml publisherName must be a block sequence");
    }
  }
}

function parseVersion(value: string, variableName: string, feed: PackagedUpdateFeed): ParsedPrereleaseVersion {
  const match = SEMVER_PATTERN.exec(value);
  const kind = feed === "private" ? "prerelease" : "stable";
  if (!match) throw new Error(`${variableName} must be an exact ${kind} SemVer without build metadata`);
  const prereleaseText = match[4];
  if (feed === "private" && prereleaseText === undefined) throw new Error(`${variableName} is missing prerelease identifiers`);
  if (feed === "public" && prereleaseText !== undefined) throw new Error(`${variableName} must be stable for the public feed`);
  const prerelease = prereleaseText?.split(".") ?? [];
  for (const identifier of prerelease) {
    if (/^\d+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
      throw new Error(`${variableName} contains a numeric prerelease identifier with a leading zero`);
    }
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareVersions(left: ParsedPrereleaseVersion, right: ParsedPrereleaseVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return Number(leftIdentifier) < Number(rightIdentifier) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function rootScalar(content: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "mu").exec(content);
  if (!match?.[1]) return undefined;
  const value = match[1];
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) return value.slice(1, -1);
  return value;
}
