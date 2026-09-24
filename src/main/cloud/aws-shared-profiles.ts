import { isUtf8 } from "node:buffer";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import { fromIni } from "@aws-sdk/credential-providers";

import { isAwsRegion, isAwsLoginSessionArn } from "../../shared/cloud-deployment-contracts.js";
import { readBoundedRegularFile } from "../secure-file.js";

export const AWS_SHARED_PROFILE_MAX_FILE_BYTES = 1024 * 1024;
export const AWS_SHARED_PROFILE_MAX_COUNT = 512;

const MAX_LINE_BYTES = 16 * 1024;
const MAX_PROFILE_NAME_BYTES = 256;
const MAX_PATH_BYTES = 4_096;
const AWS_CONFIG_PROFILE_HEADER_PATTERN = /^profile\s(?:(['"])([\w@+.%:/-]+)\1|([\w@+.%:/-]+))$/u;

export interface AwsSharedProfilePaths {
  readonly credentialsFilePath: string;
  readonly configFilePath: string;
}

export interface AwsSharedProfileSummary {
  readonly name: string;
  readonly region: string | null;
  readonly authentication?: Pick<AwsSharedProfileAuthentication, "method" | "canConsoleLogin">;
}

export interface AwsSharedProfileAuthentication {
  readonly method: "console-login" | "sso" | "static" | "process" | "role" | "unknown";
  readonly canConsoleLogin: boolean;
  readonly loginSessionArn?: string;
}

export interface AwsSharedProfileCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
  readonly credentialScope?: string;
  readonly accountId?: string;
}

export interface ResolvedAwsSharedProfile {
  readonly profile: AwsSharedProfileSummary;
  readonly credentials: AwsSharedProfileCredentials;
}

export type AwsSharedProfileCredentialProvider = () => Promise<AwsSharedProfileCredentials>;

export interface AwsSharedProfileCredentialResolverInput extends AwsSharedProfilePaths {
  readonly profileName: string;
  readonly region?: string;
}

export interface AwsSharedProfileCredentialIdentity {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
  readonly credentialScope?: string;
  readonly accountId?: string;
}

export type AwsSharedProfileCredentialResolver = (
  input: AwsSharedProfileCredentialResolverInput,
) => Promise<AwsSharedProfileCredentialIdentity>;

export type AwsSharedProfileErrorCode =
  | "invalid-input"
  | "profile-files-unavailable"
  | "profile-not-found"
  | "credential-resolution-failed";

export class AwsSharedProfileError extends Error {
  readonly code: AwsSharedProfileErrorCode;

  constructor(code: AwsSharedProfileErrorCode, message: string) {
    super(message);
    this.name = "AwsSharedProfileError";
    this.code = code;
  }
}

export interface AwsSharedProfileSourceOptions {
  /** Exact paths used for both discovery and SDK resolution. */
  readonly paths?: AwsSharedProfilePaths;
  /** Used only when deriving the standard paths. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Used only when deriving the standard paths. */
  readonly homeDirectory?: string;
  readonly maxFileBytes?: number;
  /** Test seam; production defaults to the official AWS SDK v3 INI provider. */
  readonly credentialResolver?: AwsSharedProfileCredentialResolver;
  readonly now?: () => number;
}

/**
 * Discovers named AWS CLI profiles without returning INI values, and resolves
 * an explicitly selected profile through the official AWS SDK v3 INI provider.
 */
export class AwsSharedProfileSource {
  readonly paths: AwsSharedProfilePaths;

  readonly #maxFileBytes: number;
  readonly #credentialResolver: AwsSharedProfileCredentialResolver;
  readonly #now: () => number;

  constructor(options: AwsSharedProfileSourceOptions = {}) {
    this.paths = Object.freeze(options.paths
      ? validatePaths(options.paths)
      : defaultAwsSharedProfilePaths({
          ...(options.environment !== undefined ? { environment: options.environment } : {}),
          ...(options.homeDirectory !== undefined ? { homeDirectory: options.homeDirectory } : {}),
        }));
    this.#maxFileBytes = validateFileLimit(options.maxFileBytes ?? AWS_SHARED_PROFILE_MAX_FILE_BYTES);
    this.#credentialResolver = options.credentialResolver ?? resolveWithOfficialIniProvider;
    this.#now = options.now ?? Date.now;
  }

  async list(): Promise<readonly AwsSharedProfileSummary[]> {
    const { profiles, authenticationProfiles } = await readProfileMetadata(this.paths, this.#maxFileBytes);
    return Object.freeze([...profiles.entries()]
      .map(([name, { region }]) => {
        const { method, canConsoleLogin } = classifyAuthentication(name, authenticationProfiles);
        return Object.freeze({ name, region, authentication: Object.freeze({ method, canConsoleLogin }) });
      })
      .sort((left, right) => left.name.localeCompare(right.name)));
  }

  /** Classifies configuration without resolving credentials, executing a process, or opening a browser. */
  async authentication(profileName: string): Promise<AwsSharedProfileAuthentication> {
    const selectedName = validateProfileName(profileName);
    const { profiles, authenticationProfiles } = await readProfileMetadata(this.paths, this.#maxFileBytes);
    if (!profiles.has(selectedName)) {
      throw new AwsSharedProfileError("profile-not-found", "The selected AWS profile is unavailable.");
    }
    const authentication = classifyAuthentication(selectedName, authenticationProfiles);
    if (authentication.method === "unknown" && authenticationProfiles.get(selectedName)?.get("login_session") === null) {
      throw new AwsSharedProfileError("profile-files-unavailable", "The selected AWS profile login identity could not be read safely.");
    }
    return authentication;
  }

  /** Only a direct console profile may be renewed with native console sign-in. */
  async loginSessionArn(profileName: string): Promise<string | null> {
    try {
      const authentication = await this.authentication(profileName);
      return authentication.canConsoleLogin ? authentication.loginSessionArn ?? null : null;
    } catch (error) {
      if (error instanceof AwsSharedProfileError && error.code === "profile-not-found") return null;
      throw error;
    }
  }

  async resolve(profileName: string): Promise<ResolvedAwsSharedProfile> {
    const selectedName = validateProfileName(profileName);
    const profile = (await this.list()).find(({ name }) => name === selectedName);
    if (!profile) {
      throw new AwsSharedProfileError("profile-not-found", "The selected AWS profile is unavailable.");
    }

    const provider = this.#credentialProvider(selectedName, profile.region);
    return Object.freeze({ profile, credentials: await provider() });
  }

  /**
   * Returns a refreshable provider for one exact, currently discovered AWS CLI
   * profile. Credential bytes never become renderer-visible or durable GUI
   * state.
   */
  async credentialProvider(
    profileName: string,
    region?: string,
  ): Promise<AwsSharedProfileCredentialProvider> {
    const selectedName = validateProfileName(profileName);
    if (!(await this.list()).some(({ name }) => name === selectedName)) {
      throw new AwsSharedProfileError("profile-not-found", "The selected AWS profile is unavailable.");
    }
    return this.#credentialProvider(selectedName, normalizeClientRegion(region));
  }

  #credentialProvider(
    selectedName: string,
    region: string | null | undefined,
  ): AwsSharedProfileCredentialProvider {
    return async () => {
      let identity: AwsSharedProfileCredentialIdentity;
      try {
        identity = await this.#credentialResolver({
          profileName: selectedName,
          credentialsFilePath: this.paths.credentialsFilePath,
          configFilePath: this.paths.configFilePath,
          ...(region ? { region } : {}),
        });
      } catch {
        throw new AwsSharedProfileError(
          "credential-resolution-failed",
          "Could not resolve the selected AWS profile. Renew it using its configured authentication method and try again.",
        );
      }

      try {
        const credentials = validateResolvedIdentity(identity);
        if (credentials.expiration && credentials.expiration.getTime() <= this.#now()) throw new Error("credentials expired");
        return credentials;
      } catch {
        throw new AwsSharedProfileError(
          "credential-resolution-failed",
          "The selected AWS profile returned invalid credentials.",
        );
      }
    };
  }
}

export interface DefaultAwsSharedProfilePathOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
}

/** Matches the AWS CLI/SDK shared-file environment overrides and defaults. */
export function defaultAwsSharedProfilePaths(
  options: DefaultAwsSharedProfilePathOptions = {},
): AwsSharedProfilePaths {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  if (!isAbsolute(homeDirectory) || Buffer.byteLength(homeDirectory, "utf8") > MAX_PATH_BYTES) {
    throw invalidInput();
  }
  return validatePaths({
    credentialsFilePath: normalizeConfiguredPath(
      environment["AWS_SHARED_CREDENTIALS_FILE"],
      join(homeDirectory, ".aws", "credentials"),
      homeDirectory,
    ),
    configFilePath: normalizeConfiguredPath(
      environment["AWS_CONFIG_FILE"],
      join(homeDirectory, ".aws", "config"),
      homeDirectory,
    ),
  });
}

async function resolveWithOfficialIniProvider(
  input: AwsSharedProfileCredentialResolverInput,
): Promise<AwsSharedProfileCredentialIdentity> {
  const callerRegion = input.region;
  const provider = fromIni({
    profile: input.profileName,
    filepath: input.credentialsFilePath,
    configFilepath: input.configFilePath,
    ignoreCache: true,
  });
  return provider(callerRegion
    ? { callerClientConfig: { region: async () => callerRegion } }
    : undefined);
}

async function readOptionalProfileFile(path: string, label: string, maxBytes: number): Promise<Buffer | undefined> {
  try {
    return (await readBoundedRegularFile(path, { label, maxBytes })).data;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

// Store only presence for secret-bearing settings. Values retained here are
// profile references, credential-source names, and the public login identity.
type AuthenticationProfile = Map<string, true | string | null>;
const AUTHENTICATION_KEYS = new Set([
  "aws_access_key_id", "aws_secret_access_key", "role_arn", "source_profile", "credential_source",
  "web_identity_token_file", "credential_process", "sso_start_url", "sso_account_id", "sso_session",
  "sso_region", "sso_role_name", "login_session",
]);
const AUTHENTICATION_VALUE_KEYS = new Set(["source_profile", "credential_source", "login_session"]);
const SSO_KEYS = ["sso_start_url", "sso_account_id", "sso_session", "sso_region", "sso_role_name"];
const CREDENTIAL_SOURCES = new Set(["Environment", "EcsContainer", "Ec2InstanceMetadata"]);
const UNKNOWN_AUTHENTICATION: AwsSharedProfileAuthentication = Object.freeze({ method: "unknown", canConsoleLogin: false });

async function readProfileMetadata(paths: AwsSharedProfilePaths, maxBytes: number): Promise<{
  profiles: Map<string, { region: string | null }>;
  authenticationProfiles: Map<string, AuthenticationProfile>;
}> {
  let credentialsData: Buffer | undefined;
  let configData: Buffer | undefined;
  try {
    // Settle both reads so every successful buffer can be wiped even when its
    // sibling read fails.
    const [credentialsRead, configRead] = await Promise.allSettled([
      readOptionalProfileFile(paths.credentialsFilePath, "AWS shared credentials file", maxBytes),
      readOptionalProfileFile(paths.configFilePath, "AWS shared config file", maxBytes),
    ]);
    if (credentialsRead.status === "fulfilled") credentialsData = credentialsRead.value;
    if (configRead.status === "fulfilled") configData = configRead.value;
    if (credentialsRead.status === "rejected") throw credentialsRead.reason;
    if (configRead.status === "rejected") throw configRead.reason;
    const profiles = new Map<string, { region: string | null }>();
    const authenticationProfiles = new Map<string, AuthenticationProfile>();
    if (credentialsData) collectCredentialsProfiles(credentialsData, profiles);
    if (configData) collectConfigProfiles(configData, profiles);
    // The SDK merges individual keys, with shared credentials overriding config.
    if (configData) collectAuthenticationProfiles(configData, "config", authenticationProfiles);
    if (credentialsData) collectAuthenticationProfiles(credentialsData, "credentials", authenticationProfiles);
    assertProfileCount(profiles);
    return { profiles, authenticationProfiles };
  } catch {
    throw new AwsSharedProfileError("profile-files-unavailable", "AWS shared profile files could not be read safely.");
  } finally {
    credentialsData?.fill(0);
    configData?.fill(0);
  }
}

function collectAuthenticationProfiles(
  data: Buffer,
  kind: "config" | "credentials",
  profiles: Map<string, AuthenticationProfile>,
): void {
  const fileProfiles = new Map<string, AuthenticationProfile>();
  let currentProfile: string | null = null;
  let inSubsection = false;
  forEachBoundedLine(data, (line) => {
    const [start, end] = iniContentBounds(line);
    if (end - start >= 2 && line[start] === 0x5b && line[end - 1] === 0x5d) {
      const headerBytes = line.subarray(start + 1, end - 1);
      if (!isUtf8(headerBytes)) throw new Error("invalid profile header");
      const header = headerBytes.toString("utf8");
      if (header === "__proto__" || header === "profile __proto__") throw new Error("invalid profile header");
      currentProfile = kind === "config"
        ? profileNameFromConfigHeader(header)
        : authenticationCredentialsProfileName(header);
      inSubsection = false;
      return;
    }
    if (!currentProfile || start === end) return;
    const equals = line.indexOf(0x3d, start);
    if (equals <= start || equals >= end) return;
    const key = line.subarray(start, equals).toString("utf8").trim();
    const [valueStart, valueEnd] = trimAsciiBoundsWithin(line, equals + 1, end);
    if (valueStart === valueEnd) {
      inSubsection = true;
      return;
    }
    if (!isAsciiWhitespace(line[0])) inSubsection = false;
    if (inSubsection || !AUTHENTICATION_KEYS.has(key)) return;
    let profile = fileProfiles.get(currentProfile);
    if (!profile) {
      profile = new Map();
      fileProfiles.set(currentProfile, profile);
      assertProfileCount(fileProfiles);
    }
    if (!AUTHENTICATION_VALUE_KEYS.has(key)) {
      profile.set(key, true);
      return;
    }
    const valueBytes = line.subarray(valueStart, valueEnd);
    if (!isUtf8(valueBytes)) throw new Error("invalid authentication metadata");
    const value = valueBytes.toString("utf8");
    if (key === "login_session") {
      const previous = profile.get(key);
      profile.set(key, isAwsLoginSessionArn(value) && (previous === undefined || previous === value) ? value : null);
    } else {
      profile.set(key, value);
    }
  });
  for (const [name, profile] of fileProfiles) {
    const merged = profiles.get(name) ?? new Map<string, true | string | null>();
    for (const [key, value] of profile) merged.set(key, value);
    profiles.set(name, merged);
    assertProfileCount(profiles);
  }
}

function authenticationCredentialsProfileName(header: string): string | null {
  // The SDK namespaces prefixed sections even in the credentials file. Do not
  // mistake a literal discovery name such as "profile example" for "example".
  const prefixed = /^([\w-]+)\s(?:(['"])([\w@+.%:/-]+)\2|([\w@+.%:/-]+))$/u.exec(header);
  if (prefixed) {
    return ["profile", "sso-session", "services"].includes(prefixed[1] ?? "")
      ? `${prefixed[1]}.${prefixed[3] ?? prefixed[4]}` : null;
  }
  return profileNameFromCredentialsHeader(header);
}

/** Mirrors the SDK INI provider's dispatch order without resolving any secrets. */
function classifyAuthentication(
  name: string,
  profiles: ReadonlyMap<string, AuthenticationProfile>,
  visited: Set<string> = new Set(),
): AwsSharedProfileAuthentication {
  const profile = profiles.get(name);
  if (!profile || visited.size >= AWS_SHARED_PROFILE_MAX_COUNT) return UNKNOWN_AUTHENTICATION;
  const staticKeys = profile.has("aws_access_key_id") && profile.has("aws_secret_access_key");
  // A source profile containing static credentials terminates role resolution,
  // even when it contains its own role settings (including a self-reference).
  if (visited.size > 0 && staticKeys) return Object.freeze({ method: "static", canConsoleLogin: false });
  if (visited.has(name)) return UNKNOWN_AUTHENTICATION;
  const source = profile.get("source_profile");
  const credentialSource = profile.get("credential_source");
  const assumedRole = profile.has("role_arn") && ((typeof source === "string") !== (typeof credentialSource === "string"));
  // The SDK also follows credential_source-only sections reached recursively.
  const recursiveSource = visited.size > 0 && !profile.has("role_arn") && typeof credentialSource === "string";
  if (assumedRole || recursiveSource) {
    visited.add(name);
    const sourceSupported = typeof source === "string"
      ? classifyAuthentication(source, profiles, visited).method !== "unknown"
      : typeof credentialSource === "string" && CREDENTIAL_SOURCES.has(credentialSource);
    visited.delete(name);
    return sourceSupported ? Object.freeze({ method: "role", canConsoleLogin: false }) : UNKNOWN_AUTHENTICATION;
  }
  if (staticKeys) return Object.freeze({ method: "static", canConsoleLogin: false });
  if (profile.has("web_identity_token_file") && profile.has("role_arn")) return Object.freeze({ method: "role", canConsoleLogin: false });
  if (profile.has("credential_process")) return Object.freeze({ method: "process", canConsoleLogin: false });
  if (SSO_KEYS.some((key) => profile.has(key))) return Object.freeze({ method: "sso", canConsoleLogin: false });
  const loginSessionArn = profile.get("login_session");
  if (typeof loginSessionArn === "string") return Object.freeze({ method: "console-login", canConsoleLogin: true, loginSessionArn });
  return UNKNOWN_AUTHENTICATION;
}

function collectCredentialsProfiles(
  data: Buffer,
  profiles: Map<string, { region: string | null }>,
): void {
  forEachBoundedLine(data, (line) => {
    const header = parseIniHeader(line);
    if (!header) return;
    const name = profileNameFromCredentialsHeader(header);
    if (name && !profiles.has(name)) profiles.set(name, { region: null });
    assertProfileCount(profiles);
  });
}

function collectConfigProfiles(
  data: Buffer,
  profiles: Map<string, { region: string | null }>,
): void {
  let currentProfile: string | null = null;
  forEachBoundedLine(data, (line) => {
    const header = parseIniHeader(line);
    if (header) {
      currentProfile = profileNameFromConfigHeader(header);
      if (currentProfile && !profiles.has(currentProfile)) profiles.set(currentProfile, { region: null });
      assertProfileCount(profiles);
      return;
    }
    if (!currentProfile) return;
    const region = parseRegionAssignment(line);
    if (region !== undefined) profiles.set(currentProfile, { region });
  });
}

function forEachBoundedLine(data: Buffer, visitor: (line: Buffer) => void): void {
  let offset = 0;
  while (offset <= data.length) {
    const newline = data.indexOf(0x0a, offset);
    const end = newline === -1 ? data.length : newline;
    let lineEnd = end;
    if (lineEnd > offset && data[lineEnd - 1] === 0x0d) lineEnd -= 1;
    const line = data.subarray(offset, lineEnd);
    if (line.length > MAX_LINE_BYTES) throw new Error("profile line exceeds limit");
    visitor(line);
    if (newline === -1) break;
    offset = newline + 1;
  }
}

function parseIniHeader(line: Buffer): string | null {
  const [start, end] = iniContentBounds(line);
  if (end - start < 3 || line[start] !== 0x5b || line[end - 1] !== 0x5d) return null;
  const contents = line.subarray(start + 1, end - 1);
  if (!isUtf8(contents)) throw new Error("profile header is not UTF-8");
  const header = contents.toString("utf8").trim();
  return header.length > 0 ? header : null;
}

function profileNameFromCredentialsHeader(header: string): string | null {
  try {
    return validateDiscoveredProfileName(header);
  } catch {
    return null;
  }
}

function profileNameFromConfigHeader(header: string): string | null {
  if (header === "default") return "default";
  const match = AWS_CONFIG_PROFILE_HEADER_PATTERN.exec(header);
  if (!match) return null;
  try {
    return validateDiscoveredProfileName(match[2] ?? match[3] ?? "");
  } catch {
    return null;
  }
}

function parseRegionAssignment(line: Buffer): string | null | undefined {
  const [start, end] = iniContentBounds(line);
  if (start === end || line[start] === 0x23 || line[start] === 0x3b) return undefined;
  const equals = line.indexOf(0x3d, start);
  if (equals < start || equals >= end) return undefined;
  const key = line.subarray(start, equals).toString("ascii").trim().toLowerCase();
  if (key !== "region") return undefined;
  const valueBytes = line.subarray(equals + 1, end);
  if (!isUtf8(valueBytes)) throw new Error("profile region is not UTF-8");
  const value = valueBytes.toString("utf8").trim();
  if (value.length === 0) return null;
  return isAwsRegion(value) ? value : null;
}

function trimAsciiBounds(value: Buffer): readonly [number, number] {
  return trimAsciiBoundsWithin(value, 0, value.length);
}

/** Mirrors the SDK's whitespace-delimited `#`/`;` inline comment handling. */
function iniContentBounds(value: Buffer): readonly [number, number] {
  let [start, end] = trimAsciiBounds(value);
  for (let index = start; index < end; index += 1) {
    const byte = value[index];
    if (
      (byte === 0x23 || byte === 0x3b) &&
      (index === start || isAsciiWhitespace(value[index - 1]))
    ) {
      end = index;
      break;
    }
  }
  return trimAsciiBoundsWithin(value, start, end);
}

function trimAsciiBoundsWithin(value: Buffer, initialStart: number, initialEnd: number): readonly [number, number] {
  let start = initialStart;
  let end = initialEnd;
  while (start < end && isAsciiWhitespace(value[start])) start += 1;
  while (end > start && isAsciiWhitespace(value[end - 1])) end -= 1;
  return [start, end];
}

function isAsciiWhitespace(value: number | undefined): boolean {
  return value === 0x20 || (value !== undefined && value >= 0x09 && value <= 0x0d);
}

function validateResolvedIdentity(identity: AwsSharedProfileCredentialIdentity): AwsSharedProfileCredentials {
  const accessKeyId = validateSecret(identity.accessKeyId, 16, 256);
  const secretAccessKey = validateSecret(identity.secretAccessKey, 1, 16_384);
  const sessionToken = identity.sessionToken === undefined
    ? undefined
    : validateSecret(identity.sessionToken, 1, 32_768);
  const expiration = identity.expiration === undefined
    ? undefined
    : validateExpiration(identity.expiration);
  const credentialScope = identity.credentialScope === undefined
    ? undefined
    : validateSecret(identity.credentialScope, 1, 2_048);
  const accountId = identity.accountId === undefined
    ? undefined
    : validateSecret(identity.accountId, 1, 256);
  return Object.freeze({
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    ...(expiration ? { expiration } : {}),
    ...(credentialScope ? { credentialScope } : {}),
    ...(accountId ? { accountId } : {}),
  });
}

function validateSecret(value: unknown, minBytes: number, maxBytes: number): string {
  if (typeof value !== "string") throw new Error("invalid credential");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minBytes || bytes > maxBytes || /\p{Cc}/u.test(value)) throw new Error("invalid credential");
  return value;
}

function validateExpiration(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("invalid credential");
  return new Date(value.getTime());
}

function validateProfileName(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) throw invalidInput();
  try {
    return validateDiscoveredProfileName(value);
  } catch {
    throw invalidInput();
  }
}

function validateDiscoveredProfileName(value: string): string {
  if (
    !isSafePlainText(value, MAX_PROFILE_NAME_BYTES) ||
    value.includes("[") ||
    value.includes("]")
  ) {
    throw new Error("invalid profile name");
  }
  return value;
}

function validatePaths(paths: AwsSharedProfilePaths): AwsSharedProfilePaths {
  return Object.freeze({
    credentialsFilePath: validatePath(paths.credentialsFilePath),
    configFilePath: validatePath(paths.configFilePath),
  });
}

function validatePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    !isSafePlainText(value, MAX_PATH_BYTES)
  ) {
    throw invalidInput();
  }
  return value;
}

function normalizeConfiguredPath(value: string | undefined, fallback: string, homeDirectory: string): string {
  if (!value || value.trim().length === 0) return fallback;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homeDirectory, value.slice(2));
  return isAbsolute(value) ? value : resolvePath(value);
}

function validateFileLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4 * AWS_SHARED_PROFILE_MAX_FILE_BYTES) {
    throw invalidInput();
  }
  return value;
}

function normalizeClientRegion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isAwsRegion(value)) throw invalidInput();
  return value;
}

function isSafePlainText(value: string, maxBytes: number): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= 1 && bytes <= maxBytes && !/\p{C}/u.test(value);
}

function assertProfileCount(profiles: ReadonlyMap<string, unknown>): void {
  if (profiles.size > AWS_SHARED_PROFILE_MAX_COUNT) throw new Error("profile count exceeds limit");
}

function invalidInput(): AwsSharedProfileError {
  return new AwsSharedProfileError("invalid-input", "The AWS shared profile selection is invalid.");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}
