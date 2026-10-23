import type { TargetRef } from "./target-contracts.js";
import { BEAGLE_PROJECT_ID } from "./beagle-contracts.js";

/** Main-window catalog metadata, without database paths or graph contents. */
export interface AdCollectionSummary { id: string; name: string; createdAt: string }
export interface AdExplorerOpenInput { projectId: string }

export function parseAdExplorerOpenInput(value: unknown): AdExplorerOpenInput {
  const input = record(value, "AD Explorer collection", ["projectId"]);
  if (typeof input["projectId"] !== "string" || !BEAGLE_PROJECT_ID.test(input["projectId"])) {
    throw new TypeError("Choose a valid AD Explorer collection");
  }
  return { projectId: input["projectId"] };
}

/** SharpHound collection methods supported by the integrated workflow. */
export const AD_COLLECTION_METHODS = ["Default", "DCOnly", "ComputerOnly", "Session"] as const;
export const RUSTHOUND_COLLECTION_METHODS = ["LdapOnly", "DCOnly", "All"] as const;
export type AdCollectionMethod = (typeof AD_COLLECTION_METHODS)[number] | (typeof RUSTHOUND_COLLECTION_METHODS)[number];

export interface AdCollectorSummary {
  id: string;
  name: string;
  description: string;
  source: "native-file" | "armory";
  /** Verified entries are eligible for the default picker. Operator-supplied
   * files are an explicit advanced choice; only their output can be checked. */
  compatibility: "verified" | "operator-supplied";
  collectionMethods: readonly AdCollectionMethod[];
  available: boolean;
  reason?: string;
}

export interface AdCollectorCatalog {
  target: TargetRef;
  collectors: AdCollectorSummary[];
}

export interface AdCollectorRunInput {
  target: TargetRef;
  collectorId: string;
  /** Explicit operator-supplied AD DNS domain; target inventory has no AD domain. */
  domain: string;
  collectionMethod: AdCollectionMethod;
  /** Optional LDAP/DC host FQDN when target DNS cannot resolve the domain. */
  ldapFqdn?: string;
  /** Request LDAPS. The current fork does not verify the DC certificate. */
  ldaps?: boolean;
  /** Transient credentials for the RustHound extension. Never persist or echo. */
  credentials?: { username: string; password: string };
}

export interface AdCollectorRunResult {
  state: "imported" | "saved" | "submitted" | "cancelled";
  collectorId: string;
  targetId: string;
  domain: string;
  message: string;
  projectId?: string;
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ARMORY_COLLECTOR_PREFIX = "sharphound:armory:aliases/";
export const RUSTHOUND_ARMORY_COLLECTOR_ID = "rusthound:armory:extensions/rusthound-ce";

function isCollectorId(value: unknown): value is string {
  if (value === RUSTHOUND_ARMORY_COLLECTOR_ID) return true;
  if (value === "sharphound:verified:file" || value === "sharphound:verified:script" || value === "sharphound:custom:file" ||
      value === "sharphound:custom:script") return true;
  if (typeof value !== "string" || !value.startsWith(ARMORY_COLLECTOR_PREFIX)) return false;
  const name = value.slice(ARMORY_COLLECTOR_PREFIX.length);
  // Match the single-segment Armory package-name rules. The registry still
  // resolves this ID against its current, main-owned installed catalog.
  return name.length > 0 && name.length <= 180 && !name.startsWith(".") &&
    !/[. ]$/u.test(name) && !/[\x00-\x1f\x7f\\/:<>"|?*]/u.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name);
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

export function parseAdTargetRef(value: unknown): TargetRef {
  const input = record(value, "AD Explorer target reference", ["mode", "id", "backendEpoch", "domainRevision", "fingerprint"]);
  if ((input["mode"] !== "session" && input["mode"] !== "beacon") ||
      typeof input["id"] !== "string" || !input["id"] || input["id"].length > 128 ||
      typeof input["backendEpoch"] !== "number" || !Number.isSafeInteger(input["backendEpoch"]) || input["backendEpoch"] < 1 ||
      typeof input["domainRevision"] !== "number" || !Number.isSafeInteger(input["domainRevision"]) || input["domainRevision"] < 0 ||
      typeof input["fingerprint"] !== "string" || !/^[a-f0-9]{64}$/u.test(input["fingerprint"])) {
    throw new TypeError("Invalid AD Explorer target reference");
  }
  return input as unknown as TargetRef;
}

export function parseAdDomain(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Enter an AD DNS domain");
  const domain = value.trim().toLowerCase();
  if (domain.length < 3 || domain.length > 77 || !domain.includes(".") ||
      domain.split(".").some((label) => !DNS_LABEL.test(label))) {
    throw new TypeError("Enter a valid AD DNS domain such as example.local");
  }
  return domain;
}

export function parseAdCollectorRunInput(value: unknown): AdCollectorRunInput {
  const input = record(value, "AD collector request", ["target", "collectorId", "domain", "collectionMethod", "ldapFqdn", "ldaps", "credentials"]);
  const target = parseAdTargetRef(input["target"]);
  if (!isCollectorId(input["collectorId"])) {
    throw new TypeError("Choose an available AD collector");
  }
  const rustHound = input["collectorId"] === RUSTHOUND_ARMORY_COLLECTOR_ID;
  if (rustHound
    ? !RUSTHOUND_COLLECTION_METHODS.includes(input["collectionMethod"] as (typeof RUSTHOUND_COLLECTION_METHODS)[number])
    : !AD_COLLECTION_METHODS.includes(input["collectionMethod"] as (typeof AD_COLLECTION_METHODS)[number])) {
    throw new TypeError("Choose a supported AD collection method");
  }
  let ldapFqdn: string | undefined;
  if (input["ldapFqdn"] !== undefined) {
    if (!rustHound) throw new TypeError("This collector does not accept an LDAP host");
    ldapFqdn = parseAdDomain(input["ldapFqdn"]);
  }
  if (input["ldaps"] !== undefined && (!rustHound || typeof input["ldaps"] !== "boolean")) {
    throw new TypeError("This collector does not accept this LDAP transport setting");
  }
  let credentials: AdCollectorRunInput["credentials"];
  if (rustHound) {
    const raw = record(input["credentials"], "RustHound credentials", ["username", "password"]);
    if (typeof raw["username"] !== "string" || raw["username"].length < 1 ||
        new TextEncoder().encode(raw["username"]).length > 256 ||
        /[\\\x00-\x1f\x7f]/u.test(raw["username"]) ||
        typeof raw["password"] !== "string" || !raw["password"] ||
        new TextEncoder().encode(raw["password"]).length > 1024 || raw["password"].includes("\0")) {
      throw new TypeError("Enter a user name and password for RustHound");
    }
    credentials = { username: raw["username"], password: raw["password"] };
  } else if (input["credentials"] !== undefined) {
    throw new TypeError("This collector does not accept credentials");
  }
  return {
    target,
    collectorId: input["collectorId"],
    domain: parseAdDomain(input["domain"]),
    collectionMethod: input["collectionMethod"] as AdCollectionMethod,
    ...(ldapFqdn ? { ldapFqdn } : {}),
    ...(input["ldaps"] === true ? { ldaps: true } : {}),
    ...(credentials ? { credentials } : {}),
  };
}
