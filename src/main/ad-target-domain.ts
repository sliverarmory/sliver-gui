import { sliverpb } from "sliver-script";
import { parseAdDomain } from "../shared/ad-explorer-contracts.js";
import type { TargetSummary } from "../shared/target-contracts.js";
import type { SliverClientAdapter } from "./sliver-client-adapter.js";

type Client = Pick<SliverClientAdapter, "getEnvSession" | "getEnvBeacon" | "fetchBeaconTaskContent" | "cancelBeaconTask">;
/** Optional bounded hint; RustHound can discover the domain itself if unavailable. */
export async function discoverAdTargetDomain(client: Client, target: TargetSummary, assertCurrent: () => void,
  options: { now?: () => number; delay?: (ms: number) => Promise<void> } = {}): Promise<{ domain?: string }> {
  if (target.os.toLowerCase() !== "windows" || target.mode === "session" && target.liveness !== "active") return {};
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let response: sliverpb.EnvInfo | undefined;
  let pending: string | undefined;
  try {
    assertCurrent();
    if (target.mode === "session") response = await client.getEnvSession(target.id, "USERDNSDOMAIN", 15);
    else {
      if (target.checkinStatus === "overdue") return {};
      response = await client.getEnvBeacon(target.id, "USERDNSDOMAIN", 15);
      if (!response.Response?.Async || response.Response.BeaconID !== target.id || !/^[A-Za-z0-9_-]{1,128}$/u.test(response.Response.TaskID)) return {};
      pending = response.Response.TaskID;
      const deadline = now() + 30_000;
      response = undefined;
      while (now() < deadline) {
        assertCurrent();
        const task = await client.fetchBeaconTaskContent(target.id, pending, "EnvReq", 10);
        try {
          const envelope = sliverpb.Envelope.decode(task.Request);
          try {
            if (envelope.Type !== 66 || envelope.UnknownMessageType || !envelope.Data.length ||
                sliverpb.EnvReq.decode(envelope.Data).Name !== "USERDNSDOMAIN") throw new Error("Unexpected domain hint task request");
          } finally { envelope.Data.fill(0); }
          const state = task.State.toLowerCase();
          if (state === "completed") {
            response = sliverpb.EnvInfo.decode(task.Response);
            pending = undefined;
            break;
          }
          if (state !== "pending" && state !== "sent") break;
        } finally { task.Request.fill(0); task.Response.fill(0); }
        await delay(Math.min(1000, Math.max(0, deadline - now())));
      }
    }
    assertCurrent();
    if (response?.Response?.Err) return {};
    const matches = response?.Variables?.filter((v) => v.Key === "USERDNSDOMAIN") ?? [];
    if (matches.length === 1) return { domain: parseAdDomain(matches[0]!.Value) };
  } catch { /* Hints are optional; native current-user discovery remains available. */ }
  finally { if (pending) await client.cancelBeaconTask(pending).catch(() => undefined); }
  assertCurrent();
  return {};
}
