import type { clientpb } from "sliver-script";

import type { InfrastructureServiceSummary } from "../shared/topology-contracts.js";

export const MAX_INFRASTRUCTURE_SERVICES = 500;
const MAX_IDENTITY_LENGTH = 256;
const MAX_DISPLAY_LENGTH = 256;

interface NormalizedInfrastructureServices {
  items: InfrastructureServiceSummary[];
  page: { limit: number; total: number; truncated: boolean };
}

/** Allowlist display metadata from the server's passive registered-builder inventory. */
export function normalizeExternalBuilders(response: clientpb.Builders): NormalizedInfrastructureServices {
  return normalizeServices(response, "Builders", "Name", "External builder");
}

/** Allowlist display metadata from the server's passive connected-station inventory. */
export function normalizeCrackstations(response: clientpb.Crackstations): NormalizedInfrastructureServices {
  return normalizeServices(response, "Crackstations", "HostUUID", "Crackstation");
}

function normalizeServices(
  response: unknown,
  collectionKey: "Builders" | "Crackstations",
  identityKey: "Name" | "HostUUID",
  label: string,
): NormalizedInfrastructureServices {
  if (!isObject(response) || !Array.isArray(response[collectionKey])) {
    throw new Error(`${label} inventory is not a collection`);
  }
  const source = response[collectionKey];
  const items: InfrastructureServiceSummary[] = [];
  const identities = new Set<string>();
  const length = Math.min(source.length, MAX_INFRASTRUCTURE_SERVICES);
  for (let index = 0; index < length; index += 1) {
    const candidate: unknown = source[index];
    if (!isObject(candidate)) throw new Error(`${label} inventory contains an invalid entry`);
    const id = serviceIdentity(candidate[identityKey], identityKey, label);
    if (identities.has(id)) throw new Error(`${label} inventory contains a duplicate identity`);
    identities.add(id);

    const version = collectionKey === "Crackstations" ? displayText(candidate["Version"]) : "";
    items.push({
      id,
      name: displayText(candidate["Name"]) || id,
      os: displayText(candidate["GOOS"]),
      arch: displayText(candidate["GOARCH"]),
      operatorName: displayText(candidate["OperatorName"]),
      ...(version ? { version } : {}),
    });
  }

  items.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return {
    items,
    page: { limit: MAX_INFRASTRUCTURE_SERVICES, total: source.length, truncated: source.length > length },
  };
}

function serviceIdentity(value: unknown, key: "Name" | "HostUUID", label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_IDENTITY_LENGTH
    || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) || (key === "HostUUID" && /\s/u.test(value))) {
    throw new Error(`${label} inventory contains an invalid identity`);
  }
  return value;
}

function displayText(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value.slice(0, MAX_DISPLAY_LENGTH * 4).replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ").replace(/\s+/gu, " ").trim()]
    .slice(0, MAX_DISPLAY_LENGTH).join("");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
