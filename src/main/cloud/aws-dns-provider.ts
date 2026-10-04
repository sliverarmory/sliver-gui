import { createHash } from "node:crypto";
import {
  ChangeResourceRecordSetsCommand, GetHostedZoneCommand, ListHostedZonesCommand,
  ListResourceRecordSetsCommand, Route53Client,
  type GetHostedZoneCommandOutput, type ListHostedZonesCommandOutput,
  type ListResourceRecordSetsCommandInput, type ListResourceRecordSetsCommandOutput,
  type ResourceRecordSet,
} from "@aws-sdk/client-route-53";
import {
  cloudDnsRecordName, parseCloudDnsRecordSpec,
  type CloudDnsProvider, type CloudDnsRecord, type CloudDnsRecordSpec, type CloudDnsZone,
} from "../../shared/cloud-dns-contracts.js";
import type { AwsEc2ProviderConnection } from "./aws-ec2-provider.js";

const MAX_PAGES = 100;
const MAX_RECORDS = 20_000;
const DEADLINE_MS = 60_000;

export interface AwsDnsClientLike {
  send(command: unknown, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown>;
  destroy?(): void;
}
export interface AwsDnsProviderDependencies { readonly clientFactory?: (connection: AwsEc2ProviderConnection) => AwsDnsClientLike }

export class AwsDnsProvider implements CloudDnsProvider {
  private readonly client: AwsDnsClientLike;
  constructor(connection: AwsEc2ProviderConnection, dependencies: AwsDnsProviderDependencies = {}) {
    this.client = (dependencies.clientFactory ?? ((configuration) => new Route53Client({ ...configuration, maxAttempts: 1 })))(connection);
  }

  dispose(): void { this.client.destroy?.(); }

  async listZones(): Promise<readonly CloudDnsZone[]> {
    const abortSignal = AbortSignal.timeout(DEADLINE_MS);
    const zones: CloudDnsZone[] = [];
    const seen = new Set<string>();
    let marker: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.client.send(new ListHostedZonesCommand({ MaxItems: 100, ...(marker ? { Marker: marker } : {}) }), { abortSignal }) as ListHostedZonesCommandOutput;
      for (const zone of result.HostedZones ?? []) {
        if (!zone.Id || !zone.Name) throw new Error("AWS returned an incomplete DNS zone.");
        if (zones.length >= 1_000) throw new Error("AWS DNS zone listing exceeds the 1000-zone limit.");
        zones.push({ id: zoneId(zone.Id), name: zone.Name.replace(/\.$/u, ""), provider: "aws", private: zone.Config?.PrivateZone ?? false, recordCount: zone.ResourceRecordSetCount ?? null, resourceGroupName: null });
      }
      if (!result.IsTruncated) return zones;
      marker = result.NextMarker;
      if (!marker || marker.length > 4_096 || seen.has(marker)) throw new Error("AWS DNS zone pagination did not advance.");
      seen.add(marker);
    }
    throw new Error("AWS DNS zone listing exceeded its page limit.");
  }

  async listRecords(id: string): Promise<readonly CloudDnsRecord[]> {
    const abortSignal = AbortSignal.timeout(DEADLINE_MS);
    const zone = await this.getZone(id, abortSignal);
    return (await this.rawRecords(zone.id, abortSignal)).map((record) => toRecord(zone, record));
  }

  async createRecord(id: string, input: CloudDnsRecordSpec): Promise<void> {
    const spec = parseCloudDnsRecordSpec(input);
    const abortSignal = AbortSignal.timeout(DEADLINE_MS);
    const zone = await this.getZone(id, abortSignal);
    const record = toAwsRecord(zone, spec);
    await this.change(zone.id, [{ Action: "CREATE", ResourceRecordSet: record }], abortSignal);
  }

  async updateRecord(id: string, recordId: string, expectedVersion: string, input: CloudDnsRecordSpec): Promise<void> {
    const spec = parseCloudDnsRecordSpec(input);
    const abortSignal = AbortSignal.timeout(DEADLINE_MS);
    const zone = await this.getZone(id, abortSignal);
    const existing = await this.mutableRecord(zone, recordId, expectedVersion, abortSignal);
    const replacement = toAwsRecord(zone, spec);
    if (replacement.Name !== existing.Name?.toLowerCase() || replacement.Type !== existing.Type) throw new Error("DNS record name and type cannot be changed when editing.");
    // DELETE checks the exact previous values. Route 53 validates the entire batch
    // before applying either change, preventing an intervening edit from being lost.
    await this.change(zone.id, [
      { Action: "DELETE", ResourceRecordSet: existing },
      { Action: "CREATE", ResourceRecordSet: { ...existing, ...replacement } },
    ], abortSignal);
  }

  async deleteRecord(id: string, recordId: string, expectedVersion: string): Promise<void> {
    const abortSignal = AbortSignal.timeout(DEADLINE_MS);
    const zone = await this.getZone(id, abortSignal);
    const existing = await this.mutableRecord(zone, recordId, expectedVersion, abortSignal);
    await this.change(zone.id, [{ Action: "DELETE", ResourceRecordSet: existing }], abortSignal);
  }

  private async getZone(id: string, abortSignal: AbortSignal): Promise<CloudDnsZone> {
    const normalizedId = zoneId(id);
    const result = await this.client.send(new GetHostedZoneCommand({ Id: normalizedId }), { abortSignal }) as GetHostedZoneCommandOutput;
    const zone = result.HostedZone;
    if (!zone?.Id || zoneId(zone.Id) !== normalizedId || !zone.Name) throw new Error("AWS returned a different or incomplete DNS zone.");
    return { id: normalizedId, name: zone.Name.replace(/\.$/u, ""), provider: "aws", private: zone.Config?.PrivateZone ?? false, recordCount: zone.ResourceRecordSetCount ?? null, resourceGroupName: null };
  }

  private async rawRecords(id: string, abortSignal: AbortSignal): Promise<ResourceRecordSet[]> {
    const records: ResourceRecordSet[] = [];
    const seen = new Set<string>();
    let cursor: Partial<ListResourceRecordSetsCommandInput> = {};
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.client.send(new ListResourceRecordSetsCommand({ HostedZoneId: id, MaxItems: 300, ...cursor }), { abortSignal }) as ListResourceRecordSetsCommandOutput;
      records.push(...(result.ResourceRecordSets ?? []));
      if (records.length > MAX_RECORDS) throw new Error("AWS DNS zone exceeds the 20000-record listing limit.");
      if (!result.IsTruncated) return records;
      if (!result.NextRecordName || !result.NextRecordType) throw new Error("AWS DNS record pagination is incomplete.");
      cursor = { StartRecordName: result.NextRecordName, StartRecordType: result.NextRecordType, ...(result.NextRecordIdentifier ? { StartRecordIdentifier: result.NextRecordIdentifier } : {}) };
      const key = JSON.stringify(cursor);
      if (key.length > 4_096 || seen.has(key)) throw new Error("AWS DNS record pagination did not advance.");
      seen.add(key);
    }
    throw new Error("AWS DNS record listing exceeded its page limit.");
  }

  private async mutableRecord(zone: CloudDnsZone, recordId: string, expectedVersion: string, abortSignal: AbortSignal): Promise<ResourceRecordSet> {
    const existing = (await this.rawRecords(zone.id, abortSignal)).find((record) => identity(record) === recordId);
    if (!existing) throw new Error("DNS record no longer exists. Refresh the records before retrying.");
    const record = toRecord(zone, existing);
    if (!record.editable) throw new Error(record.readOnlyReason ?? "This DNS record is read-only.");
    if (record.version !== expectedVersion) throw new Error("DNS record changed since it was loaded. Refresh the records before retrying.");
    return existing;
  }

  private async change(id: string, changes: { Action: "CREATE" | "DELETE"; ResourceRecordSet: ResourceRecordSet }[], abortSignal: AbortSignal): Promise<void> {
    try {
      const result = await this.client.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: id, ChangeBatch: { Changes: changes } }), { abortSignal }) as { ChangeInfo?: { Id?: string } };
      if (!result.ChangeInfo?.Id) throw new Error("AWS DNS change outcome is unknown. Refresh and verify the record before retrying.");
    } catch (error) {
      const status = typeof error === "object" && error !== null && "$metadata" in error ? Number((error.$metadata as { httpStatusCode?: number } | undefined)?.httpStatusCode) : 0;
      if (abortSignal.aborted || status >= 500 || (error instanceof Error && /timeout|abort|network|socket|ECONN/iu.test(`${error.name} ${error.message}`))) throw new Error("AWS DNS change outcome is unknown. Refresh and verify the record before retrying.");
      throw error;
    }
  }
}

function zoneId(value: string): string {
  const id = value.replace(/^\/hostedzone\//u, "");
  if (!/^Z[A-Z0-9]{1,63}$/u.test(id)) throw new Error("Invalid AWS hosted zone ID.");
  return id;
}

function identity(record: ResourceRecordSet): string { return `${record.Type}:${encodeURIComponent(record.Name ?? "")}:${encodeURIComponent(record.SetIdentifier ?? "")}`; }

function toAwsRecord(zone: CloudDnsZone, spec: CloudDnsRecordSpec): ResourceRecordSet {
  const name = cloudDnsRecordName(spec.name, zone.name);
  if (name === `${zone.name.toLowerCase()}.` && (spec.type === "NS" || spec.type === "CNAME")) throw new Error("Zone-apex NS and CNAME records cannot be managed here.");
  return { Name: name, Type: spec.type, TTL: spec.ttl, ResourceRecords: spec.values.map((Value) => ({ Value })) };
}

function toRecord(zone: CloudDnsZone, raw: ResourceRecordSet): CloudDnsRecord {
  const name = raw.Name ?? "";
  const type = raw.Type ?? "Unknown";
  const values = raw.ResourceRecords?.map(({ Value }) => Value ?? "") ?? (raw.AliasTarget ? [raw.AliasTarget.DNSName ?? "Alias"] : []);
  let reason: string | null = null;
  if (type === "SOA" || (type === "NS" && name.toLowerCase().replace(/\.$/u, "") === zone.name.toLowerCase())) reason = "Provider-managed zone-apex NS and SOA records are read-only.";
  else if (raw.AliasTarget) reason = "Alias records are read-only. Manage this record in AWS.";
  else if (raw.MultiValueAnswer || Object.entries(raw).some(([key, value]) => value !== undefined && !["Name", "Type", "TTL", "ResourceRecords", "MultiValueAnswer"].includes(key))) reason = "Records with routing policies or provider-specific settings are read-only.";
  else {
    try { parseCloudDnsRecordSpec({ name, type, ttl: raw.TTL, values }); } catch { reason = "This record's type or values cannot be safely edited here. Manage it in AWS."; }
  }
  return { id: identity(raw), zoneId: zone.id, zoneName: zone.name, name, type, ttl: raw.TTL ?? null, values, editable: reason === null, readOnlyReason: reason, version: createHash("sha256").update(JSON.stringify(canonical(raw))).digest("hex") };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
