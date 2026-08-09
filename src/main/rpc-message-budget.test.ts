import {
  RPC_MESSAGE_BUDGETS,
  RPC_MESSAGE_DOMAINS,
  rpcMessageChannelOptions,
  rpcTlsAuthorityOverride,
} from "sliver-script";
import { describe, expect, it } from "vitest";

const MiB = 1024 * 1024;

describe("Sliver RPC message budgets", () => {
  it("keeps control, inventory, and artifact allocations isolated and bounded", () => {
    expect(RPC_MESSAGE_DOMAINS).toEqual(["control", "inventory", "artifact"]);
    expect(RPC_MESSAGE_BUDGETS).toEqual({
      control: { maxSendBytes: 8 * MiB, maxReceiveBytes: 16 * MiB },
      inventory: { maxSendBytes: 4 * MiB, maxReceiveBytes: 32 * MiB },
      artifact: { maxSendBytes: 256 * MiB, maxReceiveBytes: 256 * MiB },
    });
    expect(RPC_MESSAGE_BUDGETS.control.maxReceiveBytes).toBeLessThan(
      RPC_MESSAGE_BUDGETS.inventory.maxReceiveBytes,
    );
    expect(RPC_MESSAGE_BUDGETS.inventory.maxReceiveBytes).toBeLessThan(
      RPC_MESSAGE_BUDGETS.artifact.maxReceiveBytes,
    );
  });

  it("maps each domain to grpc-js pre-decode send and receive limits", () => {
    for (const domain of RPC_MESSAGE_DOMAINS) {
      expect(rpcMessageChannelOptions(domain)).toEqual({
        "grpc.max_send_message_length": RPC_MESSAGE_BUDGETS[domain].maxSendBytes,
        "grpc.max_receive_message_length": RPC_MESSAGE_BUDGETS[domain].maxReceiveBytes,
      });
    }
  });

  it("adds only the narrow authority overrides needed by a local transport proxy", () => {
    expect(rpcMessageChannelOptions("control", "operator.internal")).toEqual({
      "grpc.max_send_message_length": 8 * MiB,
      "grpc.max_receive_message_length": 16 * MiB,
      "grpc.ssl_target_name_override": "operator.internal",
      "grpc.default_authority": "operator.internal",
    });
  });

  it("uses a DNS-form TLS authority for IP literals without overriding direct DNS targets", () => {
    expect(rpcTlsAuthorityOverride("127.0.0.1", false)).toBe("sliver");
    expect(rpcTlsAuthorityOverride("[::1]", false)).toBe("sliver");
    expect(rpcTlsAuthorityOverride("operator.internal", false)).toBeUndefined();
    expect(rpcTlsAuthorityOverride("operator.internal", true)).toBe("operator.internal");
  });
});
