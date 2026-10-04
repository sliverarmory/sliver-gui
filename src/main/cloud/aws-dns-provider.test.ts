import {
  ChangeResourceRecordSetsCommand, GetHostedZoneCommand, ListHostedZonesCommand,
  ListResourceRecordSetsCommand, type ResourceRecordSet,
} from "@aws-sdk/client-route-53";
import { describe, expect, it, vi } from "vitest";
import { AwsDnsProvider } from "./aws-dns-provider.js";

const spec = { name: "www", type: "A" as const, ttl: 300, values: ["192.0.2.10"] };
const record: ResourceRecordSet = { Name: "www.example.test.", Type: "A", TTL: 300, ResourceRecords: [{ Value: "192.0.2.10" }] };

function fixture(records: ResourceRecordSet[] = [record]) {
  const state = { records };
  const send = vi.fn(async (command: unknown, _options?: { abortSignal?: AbortSignal }): Promise<unknown> => {
    if (command instanceof GetHostedZoneCommand) return { HostedZone: { Id: "/hostedzone/Z123", Name: "example.test.", Config: { PrivateZone: false } } };
    if (command instanceof ListHostedZonesCommand) return { HostedZones: [{ Id: "/hostedzone/Z123", Name: "example.test.", ResourceRecordSetCount: 5 }], IsTruncated: false };
    if (command instanceof ListResourceRecordSetsCommand) return { ResourceRecordSets: state.records, IsTruncated: false };
    if (command instanceof ChangeResourceRecordSetsCommand) return { ChangeInfo: { Id: "/change/C123", Status: "PENDING" } };
    throw new Error("Unexpected AWS command.");
  });
  const destroy = vi.fn();
  const provider = new AwsDnsProvider({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } }, { clientFactory: () => ({ send, destroy }) });
  return { provider, send, state, destroy };
}

describe("AwsDnsProvider", () => {
  it("lists zones over all pages and includes private-zone metadata", async () => {
    const { provider, send } = fixture();
    send.mockResolvedValueOnce({ HostedZones: [{ Id: "/hostedzone/Z1", Name: "one.test.", Config: { PrivateZone: true } }], IsTruncated: true, NextMarker: "page2" });
    send.mockResolvedValueOnce({ HostedZones: [{ Id: "/hostedzone/Z2", Name: "two.test.", ResourceRecordSetCount: 8 }], IsTruncated: false });
    expect(await provider.listZones()).toEqual([
      { id: "Z1", name: "one.test", provider: "aws", private: true, recordCount: null, resourceGroupName: null },
      { id: "Z2", name: "two.test", provider: "aws", private: false, recordCount: 8, resourceGroupName: null },
    ]);
    expect((send.mock.calls[1]![0] as ListHostedZonesCommand).input.Marker).toBe("page2");
    expect(send.mock.calls.every(([, options]) => options?.abortSignal instanceof AbortSignal)).toBe(true);
  });

  it("rejects repeated zone pagination tokens and an oversized inventory", async () => {
    const repeated = fixture();
    repeated.send.mockResolvedValue({ HostedZones: [], IsTruncated: true, NextMarker: "same" });
    await expect(repeated.provider.listZones()).rejects.toThrow(/pagination/iu);
    const large = fixture();
    large.send.mockResolvedValue({ HostedZones: Array.from({ length: 1_001 }, () => ({ Id: "Z123", Name: "example.test." })), IsTruncated: false });
    await expect(large.provider.listZones()).rejects.toThrow(/1000/iu);
  });

  it("carries all three record pagination fields including routing identifiers", async () => {
    const { provider, send } = fixture();
    send.mockResolvedValueOnce({ HostedZone: { Id: "Z123", Name: "example.test." } });
    send.mockResolvedValueOnce({ ResourceRecordSets: [record], IsTruncated: true, NextRecordName: "x.example.test.", NextRecordType: "A", NextRecordIdentifier: "west" });
    send.mockResolvedValueOnce({ ResourceRecordSets: [{ ...record, Name: "x.example.test.", SetIdentifier: "west", Weight: 2 }], IsTruncated: false });
    const result = await provider.listRecords("Z123");
    expect(result).toHaveLength(2);
    expect((send.mock.calls[2]![0] as ListResourceRecordSetsCommand).input).toMatchObject({ StartRecordName: "x.example.test.", StartRecordType: "A", StartRecordIdentifier: "west" });
    expect(result[1]?.editable).toBe(false);
  });

  it("rejects record cursor loops", async () => {
    const { provider, send } = fixture();
    send.mockResolvedValueOnce({ HostedZone: { Id: "Z123", Name: "example.test." } });
    send.mockResolvedValue({ ResourceRecordSets: [], IsTruncated: true, NextRecordName: "a.example.test.", NextRecordType: "A" });
    await expect(provider.listRecords("Z123")).rejects.toThrow(/pagination/iu);
  });

  it("rejects malformed and mismatched zone IDs before record access", async () => {
    const { provider, send } = fixture();
    await expect(provider.listRecords("https://other.example/Z123")).rejects.toThrow(/zone ID/iu);
    expect(send).not.toHaveBeenCalled();
    send.mockResolvedValueOnce({ HostedZone: { Id: "Z999", Name: "example.test." } });
    await expect(provider.listRecords("Z123")).rejects.toThrow(/different/iu);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("creates with CREATE rather than overwriting an existing record", async () => {
    const { provider, send } = fixture();
    await provider.createRecord("Z123", spec);
    const command = send.mock.calls.at(-1)![0] as ChangeResourceRecordSetsCommand;
    expect(command.input.ChangeBatch?.Changes).toEqual([{ Action: "CREATE", ResourceRecordSet: record }]);
  });

  it("edits through one atomic exact-delete/create transaction and retains optional fields", async () => {
    const existing = { ...record, MultiValueAnswer: false };
    const { provider, send } = fixture([existing]);
    const loaded = (await provider.listRecords("Z123"))[0]!;
    await provider.updateRecord("Z123", loaded.id, loaded.version, { ...spec, ttl: 600, values: ["192.0.2.20"] });
    const command = send.mock.calls.at(-1)![0] as ChangeResourceRecordSetsCommand;
    expect(command.input.ChangeBatch?.Changes).toEqual([
      { Action: "DELETE", ResourceRecordSet: existing },
      { Action: "CREATE", ResourceRecordSet: { ...existing, TTL: 600, ResourceRecords: [{ Value: "192.0.2.20" }] } },
    ]);
  });

  it("blocks stale edits and deletes without submitting a mutation", async () => {
    const { provider, send, state } = fixture();
    const loaded = (await provider.listRecords("Z123"))[0]!;
    state.records = [{ ...record, TTL: 900 }];
    await expect(provider.updateRecord("Z123", loaded.id, loaded.version, spec)).rejects.toThrow(/changed since/iu);
    await expect(provider.deleteRecord("Z123", loaded.id, loaded.version)).rejects.toThrow(/changed since/iu);
    expect(send.mock.calls.some(([command]) => command instanceof ChangeResourceRecordSetsCommand)).toBe(false);
  });

  it("keeps record name and type immutable", async () => {
    const { provider } = fixture();
    const loaded = (await provider.listRecords("Z123"))[0]!;
    await expect(provider.updateRecord("Z123", loaded.id, loaded.version, { ...spec, name: "changed" })).rejects.toThrow(/cannot be changed/iu);
  });

  it("deletes exactly the versioned provider representation", async () => {
    const { provider, send } = fixture();
    const loaded = (await provider.listRecords("Z123"))[0]!;
    await provider.deleteRecord("Z123", loaded.id, loaded.version);
    expect((send.mock.calls.at(-1)![0] as ChangeResourceRecordSetsCommand).input.ChangeBatch?.Changes).toEqual([{ Action: "DELETE", ResourceRecordSet: record }]);
  });

  it("marks provider-owned, aliases, policies, unsupported types, and uneditable values read-only", async () => {
    const protectedRecords: ResourceRecordSet[] = [
      { Name: "example.test.", Type: "NS", TTL: 300, ResourceRecords: [{ Value: "ns1.example.test." }] },
      { Name: "example.test.", Type: "SOA", TTL: 300, ResourceRecords: [{ Value: "ns1.example.test. admin.example.test. 1 2 3 4 5" }] },
      { Name: "alias.example.test.", Type: "A", AliasTarget: { DNSName: "target.test.", HostedZoneId: "Z999", EvaluateTargetHealth: false } },
      { ...record, Name: "weighted.example.test.", SetIdentifier: "east", Weight: 0 },
      { ...record, Name: "health.example.test.", HealthCheckId: "health-id" },
      { ...record, Name: "multi.example.test.", MultiValueAnswer: true },
      { Name: "txt.example.test.", Type: "TXT", TTL: 300, ResourceRecords: [{ Value: '"a\\123"' }] },
      { Name: "unsupported.example.test.", Type: "NAPTR", TTL: 300, ResourceRecords: [{ Value: '10 10 "" "" "" .' }] },
    ];
    const { provider, send } = fixture(protectedRecords);
    const loaded = await provider.listRecords("Z123");
    expect(loaded.every((entry) => !entry.editable && entry.readOnlyReason)).toBe(true);
    for (const entry of loaded) await expect(provider.deleteRecord("Z123", entry.id, entry.version)).rejects.toThrow();
    expect(send.mock.calls.some(([command]) => command instanceof ChangeResourceRecordSetsCommand)).toBe(false);
  });

  it("protects apex NS creation and rejects absolute names outside the selected zone", async () => {
    const { provider } = fixture();
    await expect(provider.createRecord("Z123", { name: "@", type: "NS", ttl: 300, values: ["ns1.example.test."] })).rejects.toThrow(/apex/iu);
    await expect(provider.createRecord("Z123", { ...spec, name: "other.test." })).rejects.toThrow(/belong/iu);
  });

  it.each([new Error("socket closed"), Object.assign(new Error("Service unavailable"), { $metadata: { httpStatusCode: 503 } })])("requires reconciliation after uncertain mutation failures", async (error) => {
    const { provider, send } = fixture();
    send.mockResolvedValueOnce({ HostedZone: { Id: "Z123", Name: "example.test." } });
    send.mockRejectedValueOnce(error);
    await expect(provider.createRecord("Z123", spec)).rejects.toThrow(/outcome is unknown.*Refresh/iu);
  });

  it("does not claim success without provider change confirmation", async () => {
    const { provider, send } = fixture();
    send.mockResolvedValueOnce({ HostedZone: { Id: "Z123", Name: "example.test." } });
    send.mockResolvedValueOnce({});
    await expect(provider.createRecord("Z123", spec)).rejects.toThrow(/outcome is unknown/iu);
  });

  it("releases the SDK client", () => {
    const { provider, destroy } = fixture();
    provider.dispose();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
