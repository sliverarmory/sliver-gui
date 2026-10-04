import type { CloudProvider } from "./cloud-deployment-contracts.js";

export const CLOUD_DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "PTR", "SRV", "CAA"] as const;
export type CloudDnsRecordType = (typeof CLOUD_DNS_RECORD_TYPES)[number];

export interface CloudDnsZone {
  readonly id: string;
  readonly name: string;
  readonly provider: CloudProvider;
  readonly private: boolean;
  readonly recordCount: number | null;
  readonly resourceGroupName: string | null;
}

export interface CloudDnsRecord {
  readonly id: string;
  readonly zoneId: string;
  readonly zoneName: string;
  readonly name: string;
  readonly type: string;
  readonly ttl: number | null;
  readonly values: readonly string[];
  readonly editable: boolean;
  readonly readOnlyReason: string | null;
  readonly version: string;
}

export interface CloudDnsRecordSpec {
  readonly name: string;
  readonly type: CloudDnsRecordType;
  readonly ttl: number;
  readonly values: readonly string[];
}

export interface ListCloudDnsZonesInput { readonly credentialId: string }
export interface ListCloudDnsRecordsInput extends ListCloudDnsZonesInput { readonly zoneId: string | null }
export interface CreateCloudDnsRecordInput extends ListCloudDnsZonesInput {
  readonly zoneId: string;
  readonly record: CloudDnsRecordSpec;
}
export interface DeleteCloudDnsRecordInput extends ListCloudDnsZonesInput {
  readonly zoneId: string;
  readonly recordId: string;
  readonly expectedVersion: string;
}
export interface UpdateCloudDnsRecordInput extends DeleteCloudDnsRecordInput { readonly record: CloudDnsRecordSpec }

/** Main-process adapters use resolved credentials; renderer requests only contain credential IDs. */
export interface CloudDnsProvider {
  listZones(): Promise<readonly CloudDnsZone[]>;
  listRecords(zoneId: string): Promise<readonly CloudDnsRecord[]>;
  createRecord(zoneId: string, record: CloudDnsRecordSpec): Promise<void>;
  updateRecord(zoneId: string, recordId: string, expectedVersion: string, record: CloudDnsRecordSpec): Promise<void>;
  deleteRecord(zoneId: string, recordId: string, expectedVersion: string): Promise<void>;
  dispose(): void;
}

export function parseListCloudDnsZonesInput(value: unknown): ListCloudDnsZonesInput {
  const input = object(value, ["credentialId"]);
  return Object.freeze({ credentialId: credentialId(input["credentialId"]) });
}

export function parseListCloudDnsRecordsInput(value: unknown): ListCloudDnsRecordsInput {
  const input = object(value, ["credentialId", "zoneId"]);
  return Object.freeze({ credentialId: credentialId(input["credentialId"]), zoneId: input["zoneId"] === null ? null : identifier(input["zoneId"], "zone ID") });
}

export function parseCreateCloudDnsRecordInput(value: unknown): CreateCloudDnsRecordInput {
  const input = object(value, ["credentialId", "zoneId", "record"]);
  return Object.freeze({ credentialId: credentialId(input["credentialId"]), zoneId: identifier(input["zoneId"], "zone ID"), record: parseCloudDnsRecordSpec(input["record"]) });
}

export function parseUpdateCloudDnsRecordInput(value: unknown): UpdateCloudDnsRecordInput {
  const input = object(value, ["credentialId", "zoneId", "recordId", "expectedVersion", "record"]);
  return Object.freeze({ ...mutationIdentity(input), record: parseCloudDnsRecordSpec(input["record"]) });
}

export function parseDeleteCloudDnsRecordInput(value: unknown): DeleteCloudDnsRecordInput {
  return mutationIdentity(object(value, ["credentialId", "zoneId", "recordId", "expectedVersion"]));
}

export function parseCloudDnsRecordSpec(value: unknown): CloudDnsRecordSpec {
  const input = object(value, ["name", "type", "ttl", "values"]);
  if (typeof input["name"] !== "string" || (input["name"] !== "@" && !isDnsName(input["name"], true))) throw new Error("Enter a valid DNS record name, a relative name, or @ for the zone apex.");
  if (!CLOUD_DNS_RECORD_TYPES.includes(input["type"] as CloudDnsRecordType)) throw new Error("Unsupported DNS record type.");
  const type = input["type"] as CloudDnsRecordType;
  if (!Number.isInteger(input["ttl"]) || (input["ttl"] as number) < 0 || (input["ttl"] as number) > 2_147_483_647) throw new Error("DNS TTL must be a whole number from 0 to 2147483647.");
  if (!Array.isArray(input["values"]) || input["values"].length < 1 || input["values"].length > 100) throw new Error("Provide between 1 and 100 DNS record values.");
  const values = input["values"].map((value: unknown) => {
    if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value) || value.trim() !== value) throw new Error("DNS values must be nonempty single lines of at most 4096 characters.");
    validateDnsValue(type, value);
    return value;
  });
  if (new Set(values).size !== values.length) throw new Error("DNS record values must be unique.");
  if (type === "CNAME" && values.length !== 1) throw new Error("A CNAME record must have exactly one target.");
  return Object.freeze({ name: input["name"].toLowerCase(), type, ttl: input["ttl"] as number, values: Object.freeze(values) });
}

/** Resolve names without allowing an absolute name to escape its selected zone. */
export function cloudDnsRecordName(name: string, zoneName: string): string {
  const zone = zoneName.toLowerCase().replace(/\.$/u, "");
  const candidate = name.toLowerCase();
  const plain = candidate.replace(/\.$/u, "");
  const resolved = candidate === "@" ? zone : plain === zone || plain.endsWith(`.${zone}`) ? plain : candidate.endsWith(".") ? "" : `${plain}.${zone}`;
  if (!resolved || !isDnsName(resolved, true)) throw new Error("DNS record name must belong to the selected zone and fit within DNS name limits.");
  return `${resolved}.`;
}

/** TXT presentation format keeps each quoted chunk, including an empty chunk, intact. */
export function parseDnsTextChunks(value: string): string[] {
  const chunks: string[] = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] !== '"') throw new Error('TXT values must contain quoted strings, for example "hello".');
    index += 1;
    let chunk = "";
    let closed = false;
    while (index < value.length) {
      const character = value[index++];
      if (character === '"') { closed = true; break; }
      if (character === "\\") {
        const escaped = value[index++];
        if (escaped !== "\\" && escaped !== '"') throw new Error("TXT escapes must be an escaped quote or backslash.");
        chunk += escaped;
      } else chunk += character;
    }
    if (!closed || new TextEncoder().encode(chunk).length > 255) throw new Error("Each TXT quoted string must be closed and at most 255 bytes.");
    chunks.push(chunk);
    if (index < value.length && value[index] !== " ") throw new Error("Separate TXT quoted strings with spaces.");
    while (value[index] === " ") index += 1;
  }
  if (!chunks.length) throw new Error("Provide at least one quoted TXT string.");
  return chunks;
}

function validateDnsValue(type: CloudDnsRecordType, value: string): void {
  let valid = true;
  if (type === "A") valid = value.split(".").length === 4 && value.split(".").every((part) => /^(0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255);
  else if (type === "AAAA") {
    try { valid = /^[0-9a-f:.]+$/iu.test(value) && value.includes(":") && new URL(`http://[${value}]/`).hostname.startsWith("["); } catch { valid = false; }
  } else if (["CNAME", "NS", "PTR"].includes(type)) valid = isDnsName(value, false);
  else if (type === "TXT") parseDnsTextChunks(value);
  else if (type === "MX") {
    const parts = value.split(/ +/u);
    valid = parts.length === 2 && unsigned(parts[0], 65_535) && (parts[1] === "." || isDnsName(parts[1]!, false));
  } else if (type === "SRV") {
    const parts = value.split(/ +/u);
    valid = parts.length === 4 && parts.slice(0, 3).every((part) => unsigned(part, 65_535)) && (parts[3] === "." || isDnsName(parts[3]!, false));
  } else if (type === "CAA") {
    const match = /^(\d+) ([a-zA-Z0-9]+) ("(?:[^"\\]|\\["\\])*")$/u.exec(value);
    valid = !!match && unsigned(match[1], 255) && match[2]!.length <= 15;
  }
  if (!valid) throw new Error(`Enter a valid ${type} record value.`);
}

function isDnsName(value: string, wildcard: boolean): boolean {
  const name = value.replace(/\.$/u, "");
  return name.length > 0 && name.length <= 253 && name.split(".").every((part, index) =>
    (wildcard && index === 0 && part === "*") || (part.length <= 63 && /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/iu.test(part)));
}

function unsigned(value: string | undefined, max: number): boolean { return value !== undefined && /^(0|[1-9]\d*)$/u.test(value) && Number(value) <= max; }

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) throw new Error("Invalid DNS request fields.");
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Invalid DNS ${label}.`);
  return value;
}

function credentialId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) throw new Error("Invalid cloud credential ID.");
  return value;
}

function mutationIdentity(input: Record<string, unknown>): DeleteCloudDnsRecordInput {
  return Object.freeze({ credentialId: credentialId(input["credentialId"]), zoneId: identifier(input["zoneId"], "zone ID"), recordId: identifier(input["recordId"], "record ID"), expectedVersion: identifier(input["expectedVersion"], "record version") });
}
