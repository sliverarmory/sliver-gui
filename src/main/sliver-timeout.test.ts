// @vitest-environment node

import {
  clientpb,
  SliverClient,
  timeoutSecondsToNanoseconds,
  withTimeoutSignal,
  type SliverClientConfig,
} from "sliver-script";
import { describe, expect, it, vi } from "vitest";

const MAX_TIMEOUT_SECONDS = 2_147_483;
const invalidTimeouts = [
  -1,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  MAX_TIMEOUT_SECONDS + 1,
  Number.MAX_SAFE_INTEGER,
] as const;

describe("Sliver operation timeout encoding", () => {
  it("matches the pinned Go client's nanoseconds-minus-one wire values", () => {
    expect(timeoutSecondsToNanoseconds(0)).toBe("0");
    expect(timeoutSecondsToNanoseconds(1)).toBe("999999999");
    expect(timeoutSecondsToNanoseconds(60)).toBe("59999999999");
    expect(timeoutSecondsToNanoseconds(MAX_TIMEOUT_SECONDS)).toBe("2147482999999999");
  });

  it.each(invalidTimeouts)(
    "rejects invalid timeout %s before an RPC can be dispatched",
    (timeout) => {
      expect(() => timeoutSecondsToNanoseconds(timeout)).toThrow(RangeError);
    },
  );

  it.each(invalidTimeouts)("rejects invalid timeout %s before invoking a timeout callback", async (timeout) => {
    const callback = vi.fn(async (_signal: AbortSignal) => "called");

    await expect(withTimeoutSignal(timeout, callback)).rejects.toBeInstanceOf(RangeError);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(invalidTimeouts)("rejects invalid timeout %s before crossing the RPC seam", async (timeout) => {
    const getVersion = vi.fn(async () => clientpb.Version.create());
    const client = sliverClientWithControlRpc({ getVersion });

    await expect(client.getVersion(timeout)).rejects.toBeInstanceOf(RangeError);
    expect(getVersion).not.toHaveBeenCalled();
  });

  it("accepts zero and the supported timer ceiling", async () => {
    const callback = vi.fn(async (signal: AbortSignal) => signal.aborted);

    await expect(withTimeoutSignal(0, callback)).resolves.toBe(false);
    await expect(withTimeoutSignal(MAX_TIMEOUT_SECONDS, callback)).resolves.toBe(false);
    expect(callback).toHaveBeenCalledTimes(2);
  });
});

function sliverClientWithControlRpc(controlRpc: object): SliverClient {
  const config: SliverClientConfig = {
    operator: "timeout-test",
    lhost: "127.0.0.1",
    lport: 31_337,
    ca_certificate: "fixture-ca",
    certificate: "fixture-cert",
    private_key: "fixture-key",
    token: "fixture-token",
  };
  const client = new SliverClient(config);
  const internals = client as unknown as { rpcClients: Record<string, object> };
  internals.rpcClients["control"] = controlRpc;
  return client;
}
