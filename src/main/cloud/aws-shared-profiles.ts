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
    let credentialsData: Buffer | undefined;
    let configData: Buffer | undefined;
    try {
      [credentialsData, configData] = await Promise.all([
        readOptionalProfileFile(this.paths.credentialsFilePath, "AWS shared credentials file", this.#maxFileBytes),
        readOptionalProfileFile(this.paths.configFilePath, "AWS shared config file", this.#maxFileBytes),
      ]);
      const profiles = new Map<string, { region: string | null }>();
      if (credentialsData) collectCredentialsProfiles(credentialsData, profiles);
      if (configData) collectConfigProfiles(configData, profiles);
      if (profiles.size > AWS_SHARED_PROFILE_MAX_COUNT) {
        throw new Error("profile count exceeds limit");
      }
      return Object.freeze([...profiles.entries()]
        .map(([name, { region }]) => Object.freeze({ name, region }))
        .sort((left, right) => left.name.localeCompare(right.name)));
    } catch (error) {
      if (error instanceof AwsSharedProfileError) throw error;
      throw new AwsSharedProfileError(
        "profile-files-unavailable",
        "AWS shared profile files could not be read safely.",
      );
    } finally {
      credentialsData?.fill(0);
      configData?.fill(0);
    }
  }

  /** Reads only the console-login identity needed to bind native reauthentication. */
  async loginSessionArn(profileName: string): Promise<string | null> {
    const selectedName = validateProfileName(profileName);
    let data: Buffer | undefined;
    try {
      data = await readOptionalProfileFile(this.paths.configFilePath, "AWS shared config file", this.#maxFileBytes);
      if (!data) return null;
      let currentProfile: string | null = null;
      let loginSessionArn: string | null = null;
      forEachBoundedLine(data, (line) => {
        const header = parseIniHeader(line);
        if (header) {
          currentProfile = profileNameFromConfigHeader(header);
          return;
        }
        if (currentProfile !== selectedName) return;
        const [start, end] = iniContentBounds(line);
        const equals = line.indexOf(0x3d, start);
        if (equals < start || equals >= end) return;
        if (line.subarray(start, equals).toString("ascii").trim().toLowerCase() !== "login_session") return;
        const valueBytes = line.subarray(equals + 1, end);
        if (!isUtf8(valueBytes)) throw new Error("invalid login identity");
        const value = valueBytes.toString("utf8").trim();
        if (!isAwsLoginSessionArn(value)) throw new Error("invalid login identity");
        if (loginSessionArn !== null && loginSessionArn !== value) throw new Error("ambiguous login identity");
        loginSessionArn = value;
      });
      return loginSessionArn;
    } catch {
      throw new AwsSharedProfileError("profile-files-unavailable", "The selected AWS profile login identity could not be read safely.");
    } finally {
      data?.fill(0);
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
          "Could not resolve the selected AWS profile. Use AWS Login or refresh its AWS CLI sign-in and try again.",
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
