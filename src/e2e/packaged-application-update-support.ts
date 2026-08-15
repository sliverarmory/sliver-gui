const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/u;

const FORBIDDEN_UPDATE_CONFIG_KEY_PATTERN =
  /^(?:access[-_]?token|api[-_]?key|auth(?:orization)?|credentials?|password|request-?headers?|secret|token)$/iu;

export interface PackagedUpdateVersions {
  readonly from: string;
  readonly to: string;
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
