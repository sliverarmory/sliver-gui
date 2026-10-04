import { constants as fsConstants, realpathSync, statSync } from "node:fs";
import { dirname, posix, win32 } from "node:path";

import { execFile, resolveExecutable } from "@azure/core-process";
import { AzureCliCredential } from "@azure/identity";

import type { AzureCliAccountSummary } from "../../shared/cloud-deployment-contracts.js";

export const AZURE_CLI_ACCOUNT_MAX_OUTPUT_BYTES = 512 * 1024;
export const AZURE_CLI_ACCOUNT_MAX_COUNT = 512;
export const AZURE_CLI_ACCOUNT_DISCOVERY_TIMEOUT_MS = 15_000;
export const AZURE_CLI_CREDENTIAL_PROCESS_TIMEOUT_MS = 30_000;

const AZURE_CLI_CREDENTIAL_PROCESS_TIMEOUT_MAX_MS = 2 * 60_000;
const AZURE_CLI_ACCOUNT_NAME_MAX_BYTES = 512;
const AZURE_CLI_CLOUD_NAME_MAX_BYTES = 128;
const AZURE_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const AZURE_CLI_ACCOUNT_QUERY = "[?state=='Enabled'].{subscriptionId:id,name:name,tenantId:tenantId,homeTenantId:homeTenantId,isDefault:isDefault,cloudName:cloudName}";

export const AZURE_CLI_ACCOUNT_LIST_ARGS = Object.freeze([
  "account",
  "list",
  "--all",
  "--query",
  AZURE_CLI_ACCOUNT_QUERY,
  "--output",
  "json",
  "--only-show-errors",
] as const);

export type AzureCliAccountErrorCode =
  | "cli-unavailable"
  | "discovery-failed"
  | "invalid-response";

export class AzureCliAccountError extends Error {
  readonly code: AzureCliAccountErrorCode;

  constructor(code: AzureCliAccountErrorCode, message: string) {
    super(message);
    this.name = "AzureCliAccountError";
    this.code = code;
  }
}

export interface AzureCliCommandRequest {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export type AzureCliCommandRunner = (request: AzureCliCommandRequest) => Promise<string>;

export interface AzureCliExecutableResolverInput {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly platform: NodeJS.Platform;
}

export type AzureCliExecutableResolver = (
  input: AzureCliExecutableResolverInput,
) => string | Promise<string>;

export interface AzureCliAccountSourceOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly runner?: AzureCliCommandRunner;
  readonly executableResolver?: AzureCliExecutableResolver;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/**
 * Discovers non-secret Azure subscription summaries through one fixed Azure CLI
 * query. The CLI is always launched as an executable with a fixed argument
 * vector; no renderer value reaches a command name, argument, or shell.
 */
export class AzureCliAccountSource {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #runner: AzureCliCommandRunner;
  readonly #executableResolver: AzureCliExecutableResolver;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: AzureCliAccountSourceOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#platform = options.platform ?? process.platform;
    this.#runner = options.runner ?? runAzureCliCommand;
    this.#executableResolver = options.executableResolver ?? findAzureCliExecutable;
    this.#timeoutMs = boundedInteger(
      options.timeoutMs ?? AZURE_CLI_ACCOUNT_DISCOVERY_TIMEOUT_MS,
      1_000,
      60_000,
      "Azure CLI discovery timeout",
    );
    this.#maxOutputBytes = boundedInteger(
      options.maxOutputBytes ?? AZURE_CLI_ACCOUNT_MAX_OUTPUT_BYTES,
      1_024,
      4 * 1024 * 1024,
      "Azure CLI output limit",
    );
  }

  async list(): Promise<readonly AzureCliAccountSummary[]> {
    const environment = azureCliChildEnvironment(this.#environment, this.#platform);
    let executablePath: string;
    try {
      executablePath = await this.#executableResolver({ environment, platform: this.#platform });
      assertTrustedAzureCliPath(executablePath, environment, this.#platform);
    } catch (error) {
      if (error instanceof AzureCliAccountError) throw error;
      throw new AzureCliAccountError(
        "cli-unavailable",
        "Azure CLI could not be found in a trusted installation location.",
      );
    }

    // AzureCliCredential resolves the bare `az` command later. Prepending only
    // the already verified executable directory makes Homebrew installations
    // available to Finder-launched Electron processes without importing an
    // arbitrary login-shell PATH.
    if (this.#environment === process.env) {
      prependAzureCliDirectoryToPath(this.#environment, executablePath, this.#platform);
    }
    const commandEnvironment = azureCliChildEnvironment(this.#environment, this.#platform);

    let output: string;
    try {
      output = await this.#runner(Object.freeze({
        executablePath,
        args: AZURE_CLI_ACCOUNT_LIST_ARGS,
        environment: commandEnvironment,
        cwd: azureCliSafeWorkingDirectory(commandEnvironment, this.#platform),
        timeoutMs: this.#timeoutMs,
        maxOutputBytes: this.#maxOutputBytes,
      }));
    } catch {
      throw new AzureCliAccountError(
        "discovery-failed",
        "Azure CLI accounts could not be discovered. Run az login and try again.",
      );
    }

    try {
      return parseAzureCliAccounts(output, this.#maxOutputBytes);
    } catch {
      throw new AzureCliAccountError(
        "invalid-response",
        "Azure CLI returned an invalid account list.",
      );
    }
  }
}

/** Returns a credential pinned to one exact tenant and subscription. */
export function createAzureCliCredential(
  account: Pick<AzureCliAccountSummary, "subscriptionId" | "tenantId">,
  processTimeoutInMs = AZURE_CLI_CREDENTIAL_PROCESS_TIMEOUT_MS,
): AzureCliCredential {
  const subscriptionId = azureGuid(account.subscriptionId, "Azure subscription ID");
  const tenantId = azureGuid(account.tenantId, "Azure tenant ID");
  const timeout = boundedInteger(
    processTimeoutInMs,
    1_000,
    AZURE_CLI_CREDENTIAL_PROCESS_TIMEOUT_MAX_MS,
    "Azure CLI credential timeout",
  );
  return new AzureCliCredential({
    tenantId,
    subscription: subscriptionId,
    processTimeoutInMs: timeout,
  });
}

export function parseAzureCliAccounts(
  output: string,
  maxOutputBytes = AZURE_CLI_ACCOUNT_MAX_OUTPUT_BYTES,
): readonly AzureCliAccountSummary[] {
  const outputLimit = boundedInteger(
    maxOutputBytes,
    1,
    4 * 1024 * 1024,
    "Azure CLI output limit",
  );
  if (
    typeof output !== "string" ||
    Buffer.byteLength(output, "utf8") > outputLimit ||
    output.trim().length === 0
  ) throw new TypeError("Invalid Azure CLI account list");

  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new TypeError("Invalid Azure CLI account list");
  }
  if (!Array.isArray(value) || value.length > AZURE_CLI_ACCOUNT_MAX_COUNT) {
    throw new TypeError("Invalid Azure CLI account list");
  }

  const subscriptionIds = new Set<string>();
  let defaultCount = 0;
  const accounts = value.map((entry) => {
    if (!hasExactKeys(entry, [
      "subscriptionId",
      "name",
      "tenantId",
      "homeTenantId",
      "isDefault",
      "cloudName",
    ])) throw new TypeError("Invalid Azure CLI account list");

    const subscriptionId = azureGuid(entry["subscriptionId"], "Azure subscription ID");
    if (subscriptionIds.has(subscriptionId)) throw new TypeError("Invalid Azure CLI account list");
    subscriptionIds.add(subscriptionId);
    if (typeof entry["isDefault"] !== "boolean") throw new TypeError("Invalid Azure CLI account list");
    if (entry["isDefault"] && ++defaultCount > 1) throw new TypeError("Invalid Azure CLI account list");

    return Object.freeze({
      subscriptionId,
      name: boundedPlainText(entry["name"], AZURE_CLI_ACCOUNT_NAME_MAX_BYTES),
      tenantId: azureGuid(entry["tenantId"], "Azure tenant ID"),
      homeTenantId: entry["homeTenantId"] === null
        ? null
        : azureGuid(entry["homeTenantId"], "Azure home tenant ID"),
      isDefault: entry["isDefault"],
      cloudName: boundedPlainText(entry["cloudName"], AZURE_CLI_CLOUD_NAME_MAX_BYTES),
    } satisfies AzureCliAccountSummary);
  });

  accounts.sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    const byName = compareText(left.name, right.name);
    return byName === 0 ? compareText(left.subscriptionId, right.subscriptionId) : byName;
  });
  return Object.freeze(accounts);
}

/**
 * Resolves Azure CLI only from fixed platform installation directories. PATH is
 * consulted solely to prioritize those same trusted directories.
 */
export function findAzureCliExecutable(
  input: AzureCliExecutableResolverInput,
): string {
  const candidates = azureCliExecutableCandidates(input.environment, input.platform);
  const trustedRoots = azureCliTrustedRoots(input.environment, input.platform);
  for (const candidate of candidates) {
    const resolved = resolveExecutable(candidate, {
      cwd: azureCliSafeWorkingDirectory(input.environment, input.platform),
      env: { ...input.environment },
      allowWindowsBatchFiles: true,
    });
    if (!resolved) continue;
    try {
      const canonical = realpathSync.native(resolved);
      if (!statSync(canonical).isFile()) continue;
      if (!isPathWithinTrustedRoots(canonical, trustedRoots, input.platform)) continue;
      if (input.platform !== "win32" && (statSync(canonical).mode & fsConstants.S_IXUSR) === 0) continue;
      return resolved;
    } catch {
      continue;
    }
  }
  throw new AzureCliAccountError(
    "cli-unavailable",
    "Azure CLI could not be found in a trusted installation location.",
  );
}

export function azureCliExecutableCandidates(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): readonly string[] {
  const path = platform === "win32" ? win32 : posix;
  const directories = azureCliTrustedDirectories(environment, platform);
  const trustedKeys = new Set(directories.map((directory) => pathKey(directory, platform)));
  const prioritized = azureCliPathEntries(environment, platform)
    .filter((directory) => trustedKeys.has(pathKey(directory, platform)));
  const orderedDirectories = uniquePaths([...prioritized, ...directories], platform);
  const names = platform === "win32" ? ["az.exe", "az.cmd"] : ["az"];
  return Object.freeze(orderedDirectories.flatMap((directory) => (
    names.map((name) => path.join(directory, name))
  )));
}

export function azureCliChildEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): Readonly<NodeJS.ProcessEnv> {
  const snapshot: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== "string") continue;
    const key = platform === "win32" ? name.toLowerCase() : name;
    if (seen.has(key)) continue;
    seen.add(key);
    snapshot[name] = value;
  }

  const pathName = environmentKey(snapshot, "PATH", platform) ?? "PATH";
  snapshot[pathName] = azureCliTrustedDirectories(environment, platform).join(
    platform === "win32" ? win32.delimiter : posix.delimiter,
  );
  setEnvironmentValue(snapshot, "AZURE_CORE_COLLECT_TELEMETRY", "no", platform);
  setEnvironmentValue(snapshot, "AZURE_CORE_ONLY_SHOW_ERRORS", "true", platform);
  setEnvironmentValue(snapshot, "NO_COLOR", "1", platform);
  return Object.freeze(snapshot);
}

export function prependAzureCliDirectoryToPath(
  environment: NodeJS.ProcessEnv,
  executablePath: string,
  platform: NodeJS.Platform,
): void {
  const path = platform === "win32" ? win32 : posix;
  if (!path.isAbsolute(executablePath) || executablePath.includes("\0") || /[\r\n]/u.test(executablePath)) {
    throw new TypeError("Invalid Azure CLI executable path");
  }
  const executableDirectory = dirnameForPlatform(executablePath, platform);
  const trustedDirectories = azureCliTrustedDirectories(environment, platform);
  if (!trustedDirectories.some((directory) => pathKey(directory, platform) === pathKey(executableDirectory, platform))) {
    throw new TypeError("Untrusted Azure CLI executable path");
  }

  const pathName = environmentKey(environment, "PATH", platform) ?? "PATH";
  const entries = azureCliPathEntries(environment, platform);
  environment[pathName] = uniquePaths([executableDirectory, ...entries], platform).join(path.delimiter);
}

async function runAzureCliCommand(request: AzureCliCommandRequest): Promise<string> {
  const result = await execFile(request.executablePath, request.args, {
    cwd: request.cwd,
    env: { ...request.environment },
    allowWindowsBatchFiles: true,
    encoding: "utf8",
    timeout: request.timeoutMs,
    maxBuffer: request.maxOutputBytes,
    windowsHide: true,
  });
  return result.stdout;
}

function azureCliTrustedDirectories(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): readonly string[] {
  if (platform === "win32") {
    const roots = [
      environmentValue(environment, "ProgramFiles", platform),
      environmentValue(environment, "ProgramFiles(x86)", platform),
    ].filter((value): value is string => isWindowsAbsolute(value));
    const localAppData = environmentValue(environment, "LOCALAPPDATA", platform);
    const systemRoot = environmentValue(environment, "SystemRoot", platform);
    return uniquePaths([
      ...roots.map((root) => win32.join(root, "Microsoft SDKs", "Azure", "CLI2", "wbin")),
      ...(isWindowsAbsolute(localAppData)
        ? [win32.join(localAppData, "Programs", "Azure CLI", "wbin")]
        : []),
      ...(isWindowsAbsolute(systemRoot) ? [win32.join(systemRoot, "System32")] : []),
    ], platform);
  }
  if (platform === "darwin") {
    return Object.freeze(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
  }
  return Object.freeze(["/usr/local/bin", "/usr/bin", "/bin", "/opt/az/bin", "/snap/bin"]);
}

function azureCliTrustedRoots(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): readonly string[] {
  if (platform === "win32") {
    return [
      environmentValue(environment, "ProgramFiles", platform),
      environmentValue(environment, "ProgramFiles(x86)", platform),
      environmentValue(environment, "LOCALAPPDATA", platform),
      environmentValue(environment, "SystemRoot", platform),
    ].filter((value): value is string => isWindowsAbsolute(value));
  }
  return platform === "darwin"
    ? Object.freeze(["/opt/homebrew", "/usr/local", "/usr"])
    : Object.freeze(["/usr/local", "/usr", "/opt/az", "/snap"]);
}

function azureCliPathEntries(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): readonly string[] {
  const path = platform === "win32" ? win32 : posix;
  const value = environmentValue(environment, "PATH", platform) ?? "";
  return uniquePaths(value.split(path.delimiter).flatMap((entry) => {
    const candidate = platform === "win32" ? unquoteWindowsPath(entry.trim()) : entry;
    return candidate && path.isAbsolute(candidate) ? [path.resolve(candidate)] : [];
  }), platform);
}

function azureCliSafeWorkingDirectory(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string {
  if (platform !== "win32") return "/bin";
  const systemRoot = environmentValue(environment, "SystemRoot", platform);
  return isWindowsAbsolute(systemRoot) ? systemRoot : "C:\\Windows";
}

function assertTrustedAzureCliPath(
  executablePath: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): void {
  const candidates = new Set(azureCliExecutableCandidates(environment, platform).map((candidate) => (
    pathKey(candidate, platform)
  )));
  if (!candidates.has(pathKey(executablePath, platform))) {
    throw new AzureCliAccountError(
      "cli-unavailable",
      "Azure CLI could not be found in a trusted installation location.",
    );
  }
}

function isPathWithinTrustedRoots(
  pathValue: string,
  roots: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  const path = platform === "win32" ? win32 : posix;
  return roots.some((root) => {
    const relative = path.relative(root, pathValue);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  });
}

function dirnameForPlatform(pathValue: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? win32.dirname(pathValue) : dirname(pathValue);
}

function uniquePaths(values: readonly string[], platform: NodeJS.Platform): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const key = pathKey(value, platform);
    if (!unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()];
}

function pathKey(value: string, platform: NodeJS.Platform): string {
  const path = platform === "win32" ? win32 : posix;
  const normalized = path.normalize(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function unquoteWindowsPath(value: string): string {
  return value.startsWith("\"") && value.endsWith("\"") ? value.slice(1, -1) : value;
}

function isWindowsAbsolute(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z]:[\\/]/u.test(value);
}

function environmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  const key = environmentKey(environment, name, platform);
  return key === undefined ? undefined : environment[key];
}

function environmentKey(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return Object.hasOwn(environment, name) ? name : undefined;
  const normalizedName = name.toLowerCase();
  return Object.keys(environment).find((key) => key.toLowerCase() === normalizedName);
}

function setEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  environment[environmentKey(environment, name, platform) ?? name] = value;
}

function azureGuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !AZURE_GUID_PATTERN.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value.toLowerCase();
}

function boundedPlainText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /\p{C}/u.test(value)
  ) throw new TypeError("Invalid Azure CLI account text");
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
