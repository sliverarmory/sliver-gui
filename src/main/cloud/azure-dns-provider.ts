import { DnsManagementClient, type RecordSet, type RecordSets, type RecordType, type Zone, type Zones } from "@azure/arm-dns";
import {
  cloudDnsRecordName, parseCloudDnsRecordSpec, parseDnsTextChunks,
  type CloudDnsProvider, type CloudDnsRecord, type CloudDnsRecordSpec, type CloudDnsZone,
} from "../../shared/cloud-dns-contracts.js";
import type { AzureVmProviderConnection } from "./azure-vm-provider.js";

const DEADLINE_MS = 60_000;
const RECORD_FIELDS = ["aRecords", "aaaaRecords", "cnameRecord", "mxRecords", "nsRecords", "ptrRecords", "srvRecords", "txtRecords", "caaRecords"] as const;

export interface AzureDnsClientLike {
  readonly zones: {
    list(options?: Parameters<Zones["list"]>[0]): AsyncIterable<Zone>;
    get: Zones["get"];
  };
  readonly recordSets: {
    listAllByDnsZone(resourceGroupName: string, zoneName: string, options?: Parameters<RecordSets["listAllByDnsZone"]>[2]): AsyncIterable<RecordSet>;
    createOrUpdate: RecordSets["createOrUpdate"];
    get: RecordSets["get"];
    delete: RecordSets["delete"];
  };
}
export interface AzureDnsProviderDependencies { readonly clientFactory?: (connection: AzureVmProviderConnection) => AzureDnsClientLike }

export class AzureDnsProvider implements CloudDnsProvider {
  private readonly client: AzureDnsClientLike;
  private readonly subscriptionId: string;
  constructor(connection: AzureVmProviderConnection, dependencies: AzureDnsProviderDependencies = {}) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(connection.subscriptionId)) throw new Error("Invalid Azure subscription ID.");
    this.subscriptionId = connection.subscriptionId;
    this.client = (dependencies.clientFactory ?? ((configuration) => new DnsManagementClient(configuration.credential, configuration.subscriptionId, { retryOptions: { maxRetries: 0 } })))(connection);
  }

  dispose(): void { /* The Azure HTTP client owns no persistent application resources. */ }

  async listZones(): Promise<readonly CloudDnsZone[]> {
    const abortSignal = AbortSignal.timeout(DEADLINE_MS);
    const zones: CloudDnsZone[] = [];
    let count = 0;
    for await (const zone of this.client.zones.list({ abortSignal })) {
      abortSignal.throwIfAborted();
      if (++count > 1_000) throw new Error("Azure DNS zone listing exceeds the 1000-zone limit.");
      if (zone.zoneType && zone.zoneType !== "Public") continue;
      zones.push(this.toZone(zone));
    }
    return zones;
  }

  async listRecords(id: string): Promise<readonly CloudDnsRecord[]> {
    const abortSignal = AbortSignal.timeout(DEADLINE_MS);
    const zone = await this.getZone(id, abortSignal);
    return (await this.rawRecords(zone, abortSignal)).map((raw) => toRecord(zone, raw));
  }

  async createRecord(id: string, input: CloudDnsRecordSpec): Promise<void> {
    const spec = parseCloudDnsRecordSpec(input);
    const abortSignal = AbortSignal.timeout(DEADLINE_MS);
    const zone = await this.getZone(id, abortSignal);
    const name = relativeName(zone, spec);
    await this.mutate(async () => {
      const result = await this.client.recordSets.createOrUpdate(zone.resourceGroupName!, zone.name, name, spec.type, toAzureRecord(spec), { ifNoneMatch: "*", abortSignal });
      if (!result.etag) throw new Error("Azure DNS change outcome is unknown. Refresh and verify the record before retrying.");
    }, abortSignal);
  }

  async updateRecord(id: string, recordId: string, expectedVersion: string, input: CloudDnsRecordSpec): Promise<void> {
    const spec = parseCloudDnsRecordSpec(input);
    const abortSignal = AbortSignal.timeout(DEADLINE_MS);
    const zone = await this.getZone(id, abortSignal);
    const current = await this.mutableRecord(zone, recordId, expectedVersion, abortSignal);
    const name = relativeName(zone, spec);
    if (name.toLowerCase() !== current.name?.toLowerCase() || spec.type !== recordType(current)) throw new Error("DNS record name and type cannot be changed when editing.");
    await this.mutate(async () => {
      const result = await this.client.recordSets.createOrUpdate(zone.resourceGroupName!, zone.name, current.name!, spec.type, { ...current, ...toAzureRecord(spec) }, { ifMatch: expectedVersion, abortSignal });
      if (!result.etag) throw new Error("Azure DNS change outcome is unknown. Refresh and verify the record before retrying.");
    }, abortSignal);
  }

  async deleteRecord(id: string, recordId: string, expectedVersion: string): Promise<void> {
    const abortSignal = AbortSignal.timeout(DEADLINE_MS);
    const zone = await this.getZone(id, abortSignal);
    const current = await this.mutableRecord(zone, recordId, expectedVersion, abortSignal);
    await this.mutate(() => this.client.recordSets.delete(zone.resourceGroupName!, zone.name, current.name!, recordType(current) as RecordType, { ifMatch: expectedVersion, abortSignal }), abortSignal);
  }

  private toZone(raw: Zone): CloudDnsZone {
    if (!raw.id || !raw.name) throw new Error("Azure returned an incomplete DNS zone.");
    const parsed = this.parseZoneId(raw.id);
    if (parsed.name.toLowerCase() !== raw.name.toLowerCase()) throw new Error("Azure returned an inconsistent DNS zone name.");
    return { id: raw.id, name: raw.name, provider: "azure", private: false, recordCount: raw.numberOfRecordSets ?? null, resourceGroupName: parsed.resourceGroupName };
  }

  private parseZoneId(id: string): { resourceGroupName: string; name: string } {
    const match = /^\/subscriptions\/([0-9a-f-]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft.Network\/dnsZones\/([^/]+)$/iu.exec(id);
    if (!match || match[1]!.toLowerCase() !== this.subscriptionId.toLowerCase() || !/^(?!.*\.$)[\p{L}\p{N}_.()\-]{1,90}$/u.test(match[2]!) || !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/iu.test(match[3]!) || match[3]!.length > 253) throw new Error("DNS zone must belong to the selected Azure subscription.");
    return { resourceGroupName: match[2]!, name: match[3]! };
  }

  private async getZone(id: string, abortSignal: AbortSignal): Promise<CloudDnsZone> {
    const parsed = this.parseZoneId(id);
    const raw = await this.client.zones.get(parsed.resourceGroupName, parsed.name, { abortSignal });
    const zone = this.toZone(raw);
    if (zone.id.toLowerCase() !== id.toLowerCase() || (raw.zoneType && raw.zoneType !== "Public")) throw new Error("Azure returned a different zone. Only public Azure DNS zones are supported.");
    return zone;
  }

  private async rawRecords(zone: CloudDnsZone, abortSignal: AbortSignal): Promise<RecordSet[]> {
    const records: RecordSet[] = [];
    for await (const record of this.client.recordSets.listAllByDnsZone(zone.resourceGroupName!, zone.name, { abortSignal })) {
      abortSignal.throwIfAborted();
      if (records.length >= 20_000) throw new Error("Azure DNS zone exceeds the 20000-record listing limit.");
      if (!record.name || !record.type || (record.id && !record.id.toLowerCase().startsWith(`${zone.id.toLowerCase()}/`))) throw new Error("Azure returned a record outside the selected zone.");
      records.push(record);
    }
    return records;
  }

  private async mutableRecord(zone: CloudDnsZone, id: string, expectedVersion: string, abortSignal: AbortSignal): Promise<RecordSet> {
    const raw = (await this.rawRecords(zone, abortSignal)).find((record) => identity(record) === id);
    if (!raw) throw new Error("DNS record no longer exists. Refresh the records before retrying.");
    const record = toRecord(zone, raw);
    if (!record.editable) throw new Error(record.readOnlyReason ?? "This DNS record is read-only.");
    if (record.version !== expectedVersion) throw new Error("DNS record changed since it was loaded. Refresh the records before retrying.");
    return raw;
  }

  private async mutate(action: () => Promise<void>, abortSignal: AbortSignal): Promise<void> {
    try { await action(); } catch (error) {
      const status = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 0;
      if (abortSignal.aborted || status >= 500 || (error instanceof Error && /timeout|abort|network|socket|ECONN/iu.test(`${error.name} ${error.message}`))) throw new Error("Azure DNS change outcome is unknown. Refresh and verify the record before retrying.");
      if (status === 412) throw new Error("DNS record changed since it was loaded. Refresh the records before retrying.");
      throw error;
    }
  }
}

function recordType(raw: RecordSet): string { return raw.type?.split("/").at(-1)?.toUpperCase() ?? "Unknown"; }
function identity(raw: RecordSet): string { return `${recordType(raw)}:${encodeURIComponent(raw.name ?? "")}`; }

function relativeName(zone: CloudDnsZone, spec: CloudDnsRecordSpec): string {
  const name = cloudDnsRecordName(spec.name, zone.name);
  const suffix = `${zone.name.toLowerCase()}.`;
  const relative = name === suffix ? "@" : name.slice(0, -suffix.length - 1);
  if (relative === "@" && (spec.type === "NS" || spec.type === "CNAME")) throw new Error("Zone-apex NS and CNAME records cannot be managed here.");
  return relative;
}

function toAzureRecord(spec: CloudDnsRecordSpec): RecordSet {
  const result: RecordSet = { ttl: spec.ttl };
  switch (spec.type) {
    case "A": result.aRecords = spec.values.map((ipv4Address) => ({ ipv4Address })); break;
    case "AAAA": result.aaaaRecords = spec.values.map((ipv6Address) => ({ ipv6Address })); break;
    case "CNAME": result.cnameRecord = { cname: spec.values[0]! }; break;
    case "NS": result.nsRecords = spec.values.map((nsdname) => ({ nsdname })); break;
    case "PTR": result.ptrRecords = spec.values.map((ptrdname) => ({ ptrdname })); break;
    case "TXT": result.txtRecords = spec.values.map((value) => ({ value: parseDnsTextChunks(value) })); break;
    case "MX": result.mxRecords = spec.values.map((value) => { const [preference, exchange] = value.split(/ +/u); return { preference: Number(preference), exchange: exchange! }; }); break;
    case "SRV": result.srvRecords = spec.values.map((value) => { const [priority, weight, port, target] = value.split(/ +/u); return { priority: Number(priority), weight: Number(weight), port: Number(port), target: target! }; }); break;
    case "CAA": result.caaRecords = spec.values.map((value) => { const match = /^(\d+) ([a-zA-Z0-9]+) (.+)$/u.exec(value)!; return { flags: Number(match[1]), tag: match[2]!, value: JSON.parse(match[3]!) as string }; }); break;
  }
  return result;
}

function recordValues(raw: RecordSet): string[] {
  switch (recordType(raw)) {
    case "A": return raw.aRecords?.map((r) => r.ipv4Address ?? "") ?? [];
    case "AAAA": return raw.aaaaRecords?.map((r) => r.ipv6Address ?? "") ?? [];
    case "CNAME": return raw.cnameRecord?.cname ? [raw.cnameRecord.cname] : [];
    case "NS": return raw.nsRecords?.map((r) => r.nsdname ?? "") ?? [];
    case "PTR": return raw.ptrRecords?.map((r) => r.ptrdname ?? "") ?? [];
    case "MX": return raw.mxRecords?.map((r) => `${r.preference} ${r.exchange}`) ?? [];
    case "SRV": return raw.srvRecords?.map((r) => `${r.priority} ${r.weight} ${r.port} ${r.target}`) ?? [];
    case "TXT": return raw.txtRecords?.map((r) => r.value?.map((chunk) => JSON.stringify(chunk)).join(" ") ?? "") ?? [];
    case "CAA": return raw.caaRecords?.map((r) => `${r.flags} ${r.tag} ${JSON.stringify(r.value)}`) ?? [];
    case "SOA": return raw.soaRecord ? [JSON.stringify(raw.soaRecord)] : [];
    default: return [];
  }
}

function toRecord(zone: CloudDnsZone, raw: RecordSet): CloudDnsRecord {
  const type = recordType(raw);
  const name = raw.name === "@" ? `${zone.name}.` : `${raw.name}.${zone.name}.`;
  const values = raw.targetResource ? [`Alias: ${raw.targetResource.id ?? "Azure resource"}`] : recordValues(raw);
  let reason: string | null = null;
  if (type === "SOA" || (type === "NS" && raw.name === "@")) reason = "Provider-managed zone-apex NS and SOA records are read-only.";
  else if (raw.targetResource) reason = "Alias records are read-only. Manage this record in Azure.";
  else if (!raw.etag) reason = "This record has no concurrency version and cannot be safely edited.";
  else if (Object.entries(raw).some(([key, value]) => value !== undefined && !["id", "name", "type", "etag", "metadata", "ttl", "fqdn", "provisioningState", ...RECORD_FIELDS].includes(key))) reason = "Records with provider-specific settings are read-only.";
  else {
    try {
      const spec = parseCloudDnsRecordSpec({ name, type, ttl: raw.ttl, values });
      const recreated = toAzureRecord(spec);
      for (const field of RECORD_FIELDS) {
        if (JSON.stringify(canonical(raw[field])) !== JSON.stringify(canonical(recreated[field]))) throw new Error("Record values cannot round-trip.");
      }
    } catch { reason = "This record's type or values cannot be safely edited here. Manage it in Azure."; }
  }
  return { id: identity(raw), zoneId: zone.id, zoneName: zone.name, name, type, ttl: raw.ttl ?? null, values, editable: reason === null, readOnlyReason: reason, version: raw.etag ?? "unversioned" };
}

function canonical(value: unknown): unknown {
  // Object insertion order carries no DNS semantics; TXT chunk order does.
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
