// @vitest-environment node
import { clientpb, sliverpb } from "sliver-script";
import { expect, it, vi } from "vitest";
import type { TargetSummary } from "../shared/target-contracts.js";
import { discoverAdTargetDomain } from "./ad-target-domain.js";
const target = { mode: "beacon", id: "beacon-1", os: "windows", checkinStatus: "on-time" } as TargetSummary;
function fixture(name = "USERDNSDOMAIN") {
  const response = sliverpb.EnvInfo.create({ Variables: [{ Key: "USERDNSDOMAIN", Value: "EXAMPLE.LOCAL" }] });
  const task = clientpb.BeaconTask.create({ State: "completed", Request: Buffer.from(sliverpb.Envelope.encode(sliverpb.Envelope.create({ Type: 66,
    Data: Buffer.from(sliverpb.EnvReq.encode(sliverpb.EnvReq.create({ Name: name })).finish()) })).finish()), Response: Buffer.from(sliverpb.EnvInfo.encode(response).finish()) });
  const client = { getEnvSession: vi.fn(async () => response), getEnvBeacon: vi.fn(async () => sliverpb.EnvInfo.create({
    Response: { Async: true, BeaconID: target.id, TaskID: "task-1" } })),
    fetchBeaconTaskContent: vi.fn(async () => task), cancelBeaconTask: vi.fn(async () => clientpb.BeaconTask.create()) };
  return { client, task };
}
it("resolves the exact correlated beacon domain response and scrubs its buffers", async () => {
  const { client, task } = fixture();
  expect(await discoverAdTargetDomain(client, target, vi.fn())).toEqual({ domain: "example.local" });
  expect(client.fetchBeaconTaskContent).toHaveBeenCalledWith("beacon-1", "task-1", "EnvReq", 10);
  expect(task.Request.every((byte) => byte === 0)).toBe(true);
  expect(task.Response.every((byte) => byte === 0)).toBe(true);
});
it("does not trust an unrelated environment request, and cancels its bounded hint task", async () => {
  const { client } = fixture("SECRET");
  expect(await discoverAdTargetDomain(client, target, vi.fn())).toEqual({});
  expect(client.cancelBeaconTask).toHaveBeenCalledWith("task-1");
});
it("preserves target authorization and does not queue stale beacon hints", async () => {
  const { client } = fixture();
  expect(await discoverAdTargetDomain(client, { ...target, checkinStatus: "overdue" } as TargetSummary, vi.fn())).toEqual({});
  expect(client.getEnvBeacon).not.toHaveBeenCalled();
  await expect(discoverAdTargetDomain(client, target, () => { throw new Error("changed target"); })).rejects.toThrow("changed target");
});
