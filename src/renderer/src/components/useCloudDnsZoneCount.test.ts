import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudDeploymentAPI } from "../../../shared/cloud-deployment-ipc";
import type { CloudDnsZone } from "../../../shared/cloud-dns-contracts";
import { useCloudDnsZoneCount } from "./useCloudDnsZoneCount";

const zone: CloudDnsZone = { id: "ZPUBLIC", name: "example.test", provider: "aws", private: false, recordCount: 2, resourceGroupName: null };
const privateZone = { ...zone, id: "ZPRIVATE", private: true };
const azureZone = { ...zone, id: "/subscriptions/test/dnsZones/example.test", provider: "azure" as const };
const credentials = [{ id: "aws" }, { id: "aws-duplicate" }, { id: "azure" }];
type ZoneResult = Awaited<ReturnType<CloudDeploymentAPI["listDnsZones"]>>;

afterEach(cleanup);

describe("DNS tab zone count", () => {
  it("counts distinct zones across accounts while keeping same-name public/private zones distinct", async () => {
    const api = { listDnsZones: vi.fn<CloudDeploymentAPI["listDnsZones"]>().mockImplementation(async ({ credentialId }) => ({
      ok: true, value: credentialId === "azure" ? [azureZone] : [zone, privateZone],
    })) };
    const { result, rerender } = renderHook(({ accounts }) => useCloudDnsZoneCount(api, accounts), { initialProps: { accounts: credentials } });
    expect(result.current.count).toBeNull();
    await waitFor(() => expect(result.current.count).toBe(3));
    rerender({ accounts: credentials.map((account) => ({ ...account })) });
    expect(api.listDnsZones).toHaveBeenCalledTimes(3);
    act(() => result.current.updateZones("azure", [azureZone, { ...azureZone, id: azureZone.id.toUpperCase() }]));
    expect(result.current.count).toBe(3);
  });

  it("shows unavailable counts after a failed account read and recovers on refresh", async () => {
    const api = { listDnsZones: vi.fn<CloudDeploymentAPI["listDnsZones"]>()
      .mockResolvedValueOnce({ ok: false, error: "Access denied" })
      .mockResolvedValue({ ok: true, value: [zone] }) };
    const { result } = renderHook(() => useCloudDnsZoneCount(api, [{ id: "aws" }]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.count).toBeNull();
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.count).toBe(1));
    act(() => result.current.updateZones("aws", null));
    expect(result.current.count).toBeNull();
  });

  it("keeps a newer DNS panel refresh when an older background discovery finishes", async () => {
    let resolve: (value: ZoneResult) => void = () => undefined;
    const api = { listDnsZones: vi.fn<CloudDeploymentAPI["listDnsZones"]>().mockReturnValue(new Promise((done) => { resolve = done; })) };
    const { result } = renderHook(() => useCloudDnsZoneCount(api, [{ id: "aws" }]));
    act(() => result.current.updateZones("aws", [zone, privateZone]));
    expect(result.current.count).toBe(2);
    await act(async () => resolve({ ok: true, value: [zone] }));
    expect(result.current.count).toBe(2);
  });

  it("removes deleted accounts and ignores their late results", async () => {
    let resolve: (value: ZoneResult) => void = () => undefined;
    const api = { listDnsZones: vi.fn<CloudDeploymentAPI["listDnsZones"]>().mockReturnValue(new Promise((done) => { resolve = done; })) };
    const { result, rerender } = renderHook(({ accounts }) => useCloudDnsZoneCount(api, accounts), { initialProps: { accounts: [{ id: "aws" }] } });
    rerender({ accounts: [] });
    expect(result.current.count).toBe(0);
    await act(async () => resolve({ ok: true, value: [zone] }));
    expect(result.current.count).toBe(0);
  });
});
