import { useCallback, useEffect, useRef, useState } from "react";

import type { CloudDeploymentAPI } from "../../../shared/cloud-deployment-ipc";
import type { CloudDnsZone } from "../../../shared/cloud-dns-contracts";

type ZoneInventory = Readonly<Record<string, readonly CloudDnsZone[] | null>>;

export function useCloudDnsZoneCount(
  api: Pick<CloudDeploymentAPI, "listDnsZones"> | undefined,
  credentials: readonly { readonly id: string }[],
) {
  const credentialKey = JSON.stringify([...new Set(credentials.map(({ id }) => id))].sort());
  const [inventory, setInventory] = useState<ZoneInventory>({});
  const [revision, setRevision] = useState(0);
  const versions = useRef(new Map<string, number>());
  const updateZones = useCallback((credentialId: string, zones: readonly CloudDnsZone[] | null): void => {
    versions.current.set(credentialId, (versions.current.get(credentialId) ?? 0) + 1);
    setInventory((current) => ({ ...current, [credentialId]: zones }));
  }, []);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    const ids = JSON.parse(credentialKey) as string[];
    setInventory({});
    if (!api) return;
    let cursor = 0;
    // Discovery stays bounded even when several cloud accounts are saved.
    const workers = Array.from({ length: Math.min(3, ids.length) }, async () => {
      while (active && cursor < ids.length) {
        const credentialId = ids[cursor++]!;
        const version = versions.current.get(credentialId) ?? 0;
        let zones: readonly CloudDnsZone[] | null = null;
        try {
          const result = await api.listDnsZones({ credentialId });
          if (result.ok) zones = result.value;
        } catch {
          // Unknown inventories must not appear as a successful zero-zone count.
        }
        if (active && version === (versions.current.get(credentialId) ?? 0)) {
          setInventory((current) => ({ ...current, [credentialId]: zones }));
        }
      }
    });
    void Promise.all(workers);
    return () => { active = false; };
  }, [api, credentialKey, revision]);

  const ids = JSON.parse(credentialKey) as string[];
  const loading = ids.some((id) => inventory[id] === undefined);
  const unavailable = ids.some((id) => inventory[id] === null);
  // Multiple saved credentials can expose the same zone. Azure resource IDs
  // are case-insensitive; equal domain names alone do not identify equal zones.
  const zones = new Set(ids.flatMap((id) => (inventory[id] ?? []).map((zone) => `${zone.provider}:${zone.id.toLowerCase()}`)));
  return { count: loading || unavailable ? null : zones.size, loading, updateZones, refresh };
}
