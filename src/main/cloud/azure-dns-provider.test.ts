// @vitest-environment node

import type { RecordSet, Zone } from "@azure/arm-dns";
import { describe, expect, it, vi } from "vitest";

import type { CloudDnsRecordSpec } from "../../shared/cloud-dns-contracts.js";
import { AzureDnsProvider, type AzureDnsClientLike } from "./azure-dns-provider.js";

const subscriptionId = "11111111-1111-4111-8111-111111111111";
const tenantId = "22222222-2222-4222-8222-222222222222";
const resourceGroupName = "dns-resources";
const zoneName = "example.test";
const zoneId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Network/dnsZones/${zoneName}`;
const zone: Zone = { id: zoneId, name: zoneName, type: "Microsoft.Network/dnsZones", location: "global", zoneType: "Public", numberOfRecordSets: 2 };
const aRecord: RecordSet = {
  id: `${zoneId}/A/www`, name: "www", type: "Microsoft.Network/dnsZones/A",
  fqdn: "www.example.test.", ttl: 300, etag: '"version-1"',
  aRecords: [{ ipv4Address: "203.0.113.10" }], metadata: { purpose: "website" },
};
const spec: CloudDnsRecordSpec = { name: "www", type: "A", ttl: 600, values: ["203.0.113.20"] };

async function* pages<T>(values: readonly T[]): AsyncIterable<T> {
  for (const value of values) yield value;
}

function fixture() {
  const client = {
    zones: {
      list: vi.fn<AzureDnsClientLike["zones"]["list"]>(() => pages([zone])),
      get: vi.fn<AzureDnsClientLike["zones"]["get"]>(async () => zone),
    },
    recordSets: {
      listAllByDnsZone: vi.fn<AzureDnsClientLike["recordSets"]["listAllByDnsZone"]>(() => pages([aRecord])),
      get: vi.fn<AzureDnsClientLike["recordSets"]["get"]>(async () => aRecord),
      createOrUpdate: vi.fn<AzureDnsClientLike["recordSets"]["createOrUpdate"]>(async () => aRecord),
      delete: vi.fn<AzureDnsClientLike["recordSets"]["delete"]>(async () => undefined),
    },
  } satisfies AzureDnsClientLike;
  const connection = { subscriptionId, tenantId, location: "eastus", credential: { getToken: vi.fn(async () => ({ token: "test-token", expiresOnTimestamp: Date.now() + 60_000 })) } };
  const clientFactory = vi.fn(() => client);
  const provider = new AzureDnsProvider(connection, { clientFactory });
  return { client, connection, clientFactory, provider };
}

async function listed(f: ReturnType<typeof fixture>) {
  const records = await f.provider.listRecords(zoneId);
  const record = records[0];
  if (!record) throw new Error("Missing listed test record");
  return record;
}

describe("Azure DNS provider", () => {
  it("binds its client to the selected subscription and consumes paginated zones across resource groups", async () => {
    const f = fixture();
    const second = { ...zone, id: zoneId.replace("dns-resources", "other-resources") };
    f.client.zones.list.mockImplementation(() => pages([zone, second]));
    expect(f.clientFactory).toHaveBeenCalledExactlyOnceWith(f.connection);
    await expect(f.provider.listZones()).resolves.toEqual([
      { id: zoneId, name: zoneName, provider: "azure", private: false, recordCount: 2, resourceGroupName },
      { id: second.id, name: zoneName, provider: "azure", private: false, recordCount: 2, resourceGroupName: "other-resources" },
    ]);
    expect(f.client.zones.list).toHaveBeenCalledWith(expect.objectContaining({ abortSignal: expect.any(Object) }));
  });

  it("lists every record with its containing zone and preserves provider metadata when editing", async () => {
    const f = fixture();
    const record = await listed(f);
    expect(record).toMatchObject({ zoneId, zoneName, type: "A", ttl: 300, values: ["203.0.113.10"], editable: true, readOnlyReason: null });
    await f.provider.updateRecord(zoneId, record.id, record.version, spec);
    expect(f.client.recordSets.createOrUpdate).toHaveBeenCalledExactlyOnceWith(
      resourceGroupName, zoneName, "www", "A",
      expect.objectContaining({ ttl: 600, aRecords: [{ ipv4Address: "203.0.113.20" }], metadata: { purpose: "website" } }),
      expect.objectContaining({ ifMatch: aRecord.etag, abortSignal: expect.any(Object) }),
    );
  });

  it("uses create-if-absent and the original etag for deletions", async () => {
    const f = fixture();
    await f.provider.createRecord(zoneId, spec);
    expect(f.client.recordSets.createOrUpdate).toHaveBeenCalledExactlyOnceWith(
      resourceGroupName, zoneName, "www", "A",
      expect.objectContaining({ ttl: 600, aRecords: [{ ipv4Address: "203.0.113.20" }] }),
      expect.objectContaining({ ifNoneMatch: "*", abortSignal: expect.any(Object) }),
    );
    const record = await listed(f);
    await f.provider.deleteRecord(zoneId, record.id, record.version);
    expect(f.client.recordSets.delete).toHaveBeenCalledExactlyOnceWith(
      resourceGroupName, zoneName, "www", "A", expect.objectContaining({ ifMatch: aRecord.etag, abortSignal: expect.any(Object) }),
    );
  });

  it("rejects stale updates and deletions without sending a mutation", async () => {
    const f = fixture();
    const record = await listed(f);
    f.client.recordSets.listAllByDnsZone.mockImplementation(() => pages([{ ...aRecord, etag: '"version-2"' }]));
    await expect(f.provider.updateRecord(zoneId, record.id, record.version, spec)).rejects.toThrow(/changed|refresh|stale/iu);
    await expect(f.provider.deleteRecord(zoneId, record.id, record.version)).rejects.toThrow(/changed|refresh|stale/iu);
    expect(f.client.recordSets.createOrUpdate).not.toHaveBeenCalled();
    expect(f.client.recordSets.delete).not.toHaveBeenCalled();
  });

  it("rejects zone requests outside the selected subscription before contacting Azure", async () => {
    const f = fixture();
    const outside = zoneId.replace(subscriptionId, tenantId);
    await expect(f.provider.listRecords(outside)).rejects.toThrow(/subscription|zone|identity/iu);
    await expect(f.provider.createRecord(outside, spec)).rejects.toThrow(/subscription|zone|identity/iu);
    expect(f.client.zones.get).not.toHaveBeenCalled();
    expect(f.client.recordSets.createOrUpdate).not.toHaveBeenCalled();
  });

  it("rejects a returned zone or record belonging to a different resource", async () => {
    const f = fixture();
    f.client.zones.get.mockResolvedValueOnce({ ...zone, id: zoneId.replace(zoneName, "other.test"), name: "other.test" });
    await expect(f.provider.listRecords(zoneId)).rejects.toThrow(/zone|identity|different/iu);
    const record = await listed(f);
    f.client.recordSets.listAllByDnsZone.mockImplementationOnce(() => pages([{ ...aRecord, id: aRecord.id!.replace(zoneName, "other.test") }]));
    await expect(f.provider.updateRecord(zoneId, record.id, record.version, spec)).rejects.toThrow(/record|zone|identity|different/iu);
    expect(f.client.recordSets.createOrUpdate).not.toHaveBeenCalled();
  });

  it("refuses record name and type changes when editing", async () => {
    const f = fixture();
    const record = await listed(f);
    await expect(f.provider.updateRecord(zoneId, record.id, record.version, { ...spec, name: "other" })).rejects.toThrow(/name.*type|changed/iu);
    await expect(f.provider.updateRecord(zoneId, record.id, record.version, { name: "www", type: "TXT", ttl: 300, values: ['"test"'] })).rejects.toThrow(/name.*type|changed/iu);
    expect(f.client.recordSets.createOrUpdate).not.toHaveBeenCalled();
  });

  it.each([
    { type: "NS", name: "@", nsRecords: [{ nsdname: "ns1.example.test." }] },
    { type: "SOA", name: "@", soaRecord: { host: "ns1.example.test." } },
    { type: "A", name: "alias", aRecords: [{ ipv4Address: "203.0.113.10" }], targetResource: { id: "/subscriptions/example/resource" } },
  ])("keeps provider-managed $type records and aliases visible but read-only", async (entry) => {
    const f = fixture();
    const raw: RecordSet = { ...entry, type: `Microsoft.Network/dnsZones/${entry.type}`, id: `${zoneId}/${entry.type}/${entry.name}`, ttl: 300, etag: '"provider-version"' };
    f.client.recordSets.listAllByDnsZone.mockImplementation(() => pages([raw]));
    f.client.recordSets.get.mockResolvedValue(raw);
    const record = await listed(f);
    expect(record.editable).toBe(false);
    expect(record.readOnlyReason).toBeTruthy();
    await expect(f.provider.deleteRecord(zoneId, record.id, record.version)).rejects.toThrow(/read.only|managed|alias/iu);
    expect(f.client.recordSets.delete).not.toHaveBeenCalled();
  });

  it("preserves TXT chunk boundaries, empty chunks, and metadata on a round trip", async () => {
    const f = fixture();
    const raw: RecordSet = {
      id: `${zoneId}/TXT/notes`, name: "notes", type: "Microsoft.Network/dnsZones/TXT", ttl: 300, etag: '"txt-version"',
      txtRecords: [{ value: ["first", "second"] }, { value: [""] }], metadata: { owner: "dns-team" },
    };
    f.client.recordSets.listAllByDnsZone.mockImplementation(() => pages([raw]));
    f.client.recordSets.get.mockResolvedValue(raw);
    const record = await listed(f);
    expect(record).toMatchObject({ editable: true, values: ['"first" "second"', '""'] });
    await f.provider.updateRecord(zoneId, record.id, record.version, { name: "notes", type: "TXT", ttl: 600, values: record.values });
    expect(f.client.recordSets.createOrUpdate).toHaveBeenCalledWith(
      resourceGroupName, zoneName, "notes", "TXT",
      expect.objectContaining({ ttl: 600, txtRecords: raw.txtRecords, metadata: raw.metadata }),
      expect.objectContaining({ ifMatch: raw.etag }),
    );
  });

  it("recognizes equivalent record fields regardless of object property insertion order", async () => {
    const f = fixture();
    const raw: RecordSet = {
      id: `${zoneId}/MX/@`, name: "@", type: "Microsoft.Network/dnsZones/MX", ttl: 300, etag: '"mx-version"',
      mxRecords: [{ exchange: "mail.example.test.", preference: 10 }],
    };
    f.client.recordSets.listAllByDnsZone.mockImplementation(() => pages([raw]));
    const record = await listed(f);
    expect(record).toMatchObject({ editable: true, values: ["10 mail.example.test."] });
  });

  it("bounds zone and record enumeration without returning truncated results", async () => {
    const f = fixture();
    f.client.zones.list.mockImplementation(() => pages(Array.from({ length: 1_001 }, () => zone)));
    await expect(f.provider.listZones()).rejects.toThrow(/limit|many|exceed/iu);
    f.client.recordSets.listAllByDnsZone.mockImplementation(() => pages(Array.from({ length: 20_001 }, () => aRecord)));
    await expect(f.provider.listRecords(zoneId)).rejects.toThrow(/limit|many|exceed/iu);
  });

  it("reports an ambiguous mutation transport failure with reconciliation guidance", async () => {
    const f = fixture();
    const error = new Error("socket closed");
    error.name = "AbortError";
    f.client.recordSets.createOrUpdate.mockRejectedValueOnce(error);
    await expect(f.provider.createRecord(zoneId, spec)).rejects.toThrow(/outcome.*unknown.*refresh|refresh.*verify/iu);
    expect(f.client.recordSets.createOrUpdate).toHaveBeenCalledOnce();
  });
});
