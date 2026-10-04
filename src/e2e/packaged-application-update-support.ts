import { Buffer } from "node:buffer";
import { join } from "node:path";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/u;

const FORBIDDEN_UPDATE_CONFIG_KEY_PATTERN =
  /^(?:access[-_]?token|api[-_]?key|auth(?:orization)?|credentials?|password|request-?headers?|secret|token)$/iu;

export interface PackagedUpdateVersions {
  readonly from: string;
  readonly to: string;
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

export function packagedUpdateLaunchProfile(profileRoot: string): PackagedUpdateLaunchProfile {
  const userDataDirectory = join(profileRoot, "user-data");
  return {
    arguments: ["--enable-sandbox", `--user-data-dir=${userDataDirectory}`],
    userDataDirectory,
  };
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

export interface WindowsAuthenticodeInspection {
  readonly status: string;
  readonly statusMessage: string;
  readonly subject: string;
  readonly thumbprint: string;
}

export interface WindowsAuthenticodeInspectionCommand {
  readonly arguments: readonly string[];
  readonly executable: "pwsh.exe";
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
    executable: "pwsh.exe",
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

export function parsePackagedUpdateVersions(fromValue: string, toValue: string): PackagedUpdateVersions {
  const from = parsePrereleaseVersion(fromValue, "SLIVER_GUI_UPDATE_E2E_FROM_VERSION");
  const to = parsePrereleaseVersion(toValue, "SLIVER_GUI_UPDATE_E2E_TO_VERSION");
  if (compareVersions(from, to) >= 0) {
    throw new Error("SLIVER_GUI_UPDATE_E2E_TO_VERSION must have higher SemVer precedence than the from version");
  }
  return { from: fromValue, to: toValue };
}

export function assertPrivatePackagedUpdateConfiguration(content: string, token: string): void {
  if (content.includes(token)) throw new Error("Packaged app-update.yml contains the runtime GitHub token");
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
    "private",
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
    ["private", "true"],
    ["channel", "latest"],
    ["updaterCacheDirName", "sliver-gui-updater"],
  ]);
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

function parsePrereleaseVersion(value: string, variableName: string): ParsedPrereleaseVersion {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) throw new Error(`${variableName} must be an exact prerelease SemVer without build metadata`);
  const prereleaseText = match[4];
  if (prereleaseText === undefined) throw new Error(`${variableName} is missing prerelease identifiers`);
  const prerelease = prereleaseText.split(".");
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
