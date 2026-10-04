import { createHash } from "node:crypto";

import type { CloudDeploymentController } from "../main/cloud-deployment-ipc.js";
import type { CloudDnsRecord, CloudDnsZone } from "../shared/cloud-dns-contracts.js";
import { E2E_AWS_CREDENTIAL_ID, E2E_AZURE_CREDENTIAL_ID, E2E_AZURE_SUBSCRIPTION_ID } from "./cloud-deployment-fixture.js";

type DnsController = Pick<CloudDeploymentController,
  "listDnsZones" | "listDnsRecords" | "createDnsRecord" | "updateDnsRecord" | "deleteDnsRecord">;

/** In-memory DNS only: this fixture never constructs a provider or loads credentials. */
export function createCloudDnsFixture(allowMutations: boolean): DnsController {
  const zones: readonly CloudDnsZone[] = [
    { id: "ZEXAMPLE", name: "example.test", provider: "aws", private: false, recordCount: 2, resourceGroupName: null },
    { id: "ZSECOND", name: "second.test", provider: "aws", private: true, recordCount: 1, resourceGroupName: null },
    { id: `/subscriptions/${E2E_AZURE_SUBSCRIPTION_ID}/resourceGroups/dns-test/providers/Microsoft.Network/dnsZones/azure.test`, name: "azure.test", provider: "azure", private: false, recordCount: 1, resourceGroupName: "dns-test" },
  ];
  const records = new Map<string, CloudDnsRecord>();
  const version = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const provider = (credentialId: string): string | undefined => credentialId === E2E_AWS_CREDENTIAL_ID ? "aws"
    : credentialId === E2E_AZURE_CREDENTIAL_ID ? "azure" : undefined;
  const findZone = (credentialId: string, zoneId: string): CloudDnsZone | undefined =>
    zones.find((zone) => zone.id === zoneId && zone.provider === provider(credentialId));
  for (const [index, zone] of zones.entries()) {
    const record: CloudDnsRecord = {
      id: `www.${zone.name}|A`, zoneId: zone.id, zoneName: zone.name,
      name: `www.${zone.name}`, type: "A", ttl: 300, values: [`192.0.2.${index + 1}`],
      editable: true, readOnlyReason: null, version: version(zone),
    };
    records.set(record.id, record);
  }
  records.set("example.test|NS", {
    id: "example.test|NS", zoneId: "ZEXAMPLE", zoneName: "example.test", name: "example.test",
    type: "NS", ttl: 172800, values: ["ns1.example.test."], editable: false,
    readOnlyReason: "The zone's authoritative name servers are managed by the provider.", version: version("NS"),
  });
  return {
    listDnsZones: ({ credentialId }) => provider(credentialId)
      ? { ok: true, value: zones.filter((zone) => zone.provider === provider(credentialId)).map((zone) => ({
        ...zone, recordCount: [...records.values()].filter((record) => record.zoneId === zone.id).length,
      })) }
      : { ok: false, error: "Unknown DNS fixture account" },
    listDnsRecords: ({ credentialId, zoneId }) => {
      if (!provider(credentialId) || (zoneId !== null && !findZone(credentialId, zoneId))) {
        return { ok: false, error: "Unknown DNS fixture zone" };
      }
      return { ok: true, value: [...records.values()].filter((record) =>
        findZone(credentialId, record.zoneId) && (zoneId === null || record.zoneId === zoneId)) };
    },
    createDnsRecord: ({ credentialId, zoneId, record }) => {
      const zone = findZone(credentialId, zoneId);
      if (!allowMutations || !zone) return { ok: false, error: "DNS fixture mutations are disabled or the zone is unknown" };
      const inputName = record.name.replace(/\.$/u, "");
      const name = inputName === "@" ? zone.name : inputName === zone.name || inputName.endsWith(`.${zone.name}`)
        ? inputName : `${inputName}.${zone.name}`;
      const id = `${name}|${record.type}`;
      if (records.has(id)) return { ok: false, error: "This record already exists" };
      records.set(id, { ...record, name, id, zoneId, zoneName: zone.name, editable: true,
        readOnlyReason: null, version: version(record) });
      return { ok: true };
    },
    updateDnsRecord: ({ credentialId, zoneId, recordId, expectedVersion, record }) => {
      const before = records.get(recordId);
      if (!allowMutations || !findZone(credentialId, zoneId) || !before?.editable ||
          before.zoneId !== zoneId || before.version !== expectedVersion) {
        return { ok: false, error: "The DNS record changed; refresh before retrying" };
      }
      records.set(recordId, { ...before, ttl: record.ttl, values: record.values, version: version(record) });
      return { ok: true };
    },
    deleteDnsRecord: ({ credentialId, zoneId, recordId, expectedVersion }) => {
      const before = records.get(recordId);
      if (!allowMutations || !findZone(credentialId, zoneId) || !before?.editable ||
          before.zoneId !== zoneId || before.version !== expectedVersion) {
        return { ok: false, error: "The DNS record changed; refresh before retrying" };
      }
      records.delete(recordId);
      return { ok: true };
    },
  };
}
