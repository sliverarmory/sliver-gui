const REQUIRED_CONFIGURATION = new Map([
  ["provider", "github"],
  ["owner", "sliverarmory"],
  ["repo", "sliver-gui"],
  ["updaterCacheDirName", "sliver-gui-updater"],
]);

const OPTIONAL_ROOT_KEYS = new Set(["publisherName"]);
const FORBIDDEN_CREDENTIAL_KEY =
  /^(?:access[-_]?token|api[-_]?key|auth(?:orization)?|credentials?|password|request-?headers?|secret|token)$/iu;

export function assertPackagedGitHubUpdateConfiguration(content, { privateE2E = false } = {}) {
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("Packaged app-update.yml must be non-empty text");
  }

  assertSimpleUpdateConfigurationSyntax(content);

  const keyEntries = [...content.matchAll(/^([ \t]*)([A-Za-z][A-Za-z0-9_-]*):/gmu)]
    .map((match) => ({ indentation: match[1], key: match[2] }));
  const forbiddenKeys = keyEntries
    .filter(({ key }) => FORBIDDEN_CREDENTIAL_KEY.test(key))
    .map(({ key }) => key);
  if (forbiddenKeys.length > 0) {
    throw new Error(`Packaged app-update.yml contains private credential field(s): ${forbiddenKeys.join(", ")}`);
  }

  const rootEntries = keyEntries.filter(({ indentation }) => indentation === "");
  const allowedRootKeys = new Set([
    ...REQUIRED_CONFIGURATION.keys(),
    ...OPTIONAL_ROOT_KEYS,
    ...(privateE2E ? ["private", "channel"] : []),
  ]);
  const privateEntries = rootEntries.filter(({ key }) => key === "private");
  if (!privateE2E && privateEntries.length > 0) {
    throw new Error("Packaged app-update.yml contains private credential field(s): private");
  }
  const unexpected = rootEntries
    .map(({ key }) => key)
    .filter((key) => !allowedRootKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Packaged app-update.yml contains unexpected root field(s): ${unexpected.join(", ")}`);
  }

  for (const [key, expected] of REQUIRED_CONFIGURATION) {
    requireExactRootScalar(content, rootEntries, key, expected);
  }
  for (const key of OPTIONAL_ROOT_KEYS) {
    const count = rootEntries.filter((entry) => entry.key === key).length;
    if (count > 1) throw new Error(`Packaged app-update.yml must contain at most one root ${key} field`);
  }

  if (privateE2E) {
    requireExactRootScalar(content, rootEntries, "private", "true");
    requireExactRootScalar(content, rootEntries, "channel", "latest");
  }
}

function assertSimpleUpdateConfigurationSyntax(content) {
  let parentKey;
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

function requireExactRootScalar(content, rootEntries, key, expected) {
  const count = rootEntries.filter((entry) => entry.key === key).length;
  const actual = rootScalar(content, key);
  if (count !== 1) {
    throw new Error(`Packaged app-update.yml must contain exactly one root ${key} field`);
  }
  if (actual !== expected) {
    if (key === "private") {
      throw new Error("Private E2E app-update.yml must contain exactly private: true at the root");
    }
    if (key === "channel") {
      throw new Error(`Private E2E app-update.yml channel ${actual ?? "<missing>"} does not match latest`);
    }
    throw new Error(`Packaged app-update.yml ${key} ${actual ?? "<missing>"} does not match ${expected}`);
  }
}

function rootScalar(content, key) {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "mu").exec(content);
  if (!match?.[1]) return undefined;
  const value = match[1];
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) return value.slice(1, -1);
  return value;
}
