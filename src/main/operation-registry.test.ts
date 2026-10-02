// @vitest-environment node

import { describe, expect, it } from "vitest";

import { TARGET_OPERATION_IDS } from "../shared/operation-contracts.js";
import {
  OPERATION_REGISTRY,
  findOperationDescriptor,
  getOperationDescriptor,
} from "./operation-registry.js";

describe("compiled operation registry", () => {
  it("is an exact allowlist with one internally consistent binding per declared mode", () => {
    expect(Object.keys(OPERATION_REGISTRY)).toEqual([...TARGET_OPERATION_IDS]);

    for (const operationId of TARGET_OPERATION_IDS) {
      const descriptor = OPERATION_REGISTRY[operationId];
      expect(descriptor.id).toBe(operationId);
      expect(Object.keys(descriptor.bindings).sort()).toEqual([...descriptor.modes].sort());
      for (const mode of descriptor.modes) {
        const binding = descriptor.bindings[mode];
        expect(binding).toBeDefined();
        expect(binding?.timeout.timeoutSeconds).toBeGreaterThan(0);
        expect(binding?.timeout.afterSubmission).toBe("outcome-unknown");
        expect(binding?.adapterMethod).toMatch(/^(ping|rename|setEnv|unsetEnv|reconfigure|openSession|pwd|ls|ps|ifconfig|env|whoami|netstat|mount|memfiles|cat|head|tail|grep)/u);
      }
    }
  });

  it("allows one automatic retry only for the idempotent ping read", () => {
    expect(getOperationDescriptor("target.ping").idempotency).toEqual({
      class: "idempotent-read",
      maxAutomaticRetries: 1,
    });

    const beaconReadIds = [
      "beacon.filesystem.pwd",
      "beacon.filesystem.ls",
      "beacon.process.list",
      "beacon.network.interfaces",
      "beacon.environment.list",
      "beacon.identity.whoami",
      "beacon.network.netstat",
      "beacon.filesystem.mount",
      "beacon.filesystem.memfiles",
      "beacon.filesystem.cat",
      "beacon.filesystem.head",
      "beacon.filesystem.tail",
      "beacon.filesystem.grep",
    ] as const;
    for (const operationId of beaconReadIds) {
      expect(getOperationDescriptor(operationId).idempotency).toEqual({
        class: "idempotent-read",
        maxAutomaticRetries: 0,
      });
    }

    for (const operationId of TARGET_OPERATION_IDS.filter((id) =>
      id !== "target.ping" && !(beaconReadIds as readonly string[]).includes(id)
    )) {
      expect(getOperationDescriptor(operationId).idempotency).toEqual({
        class: "unconfirmed-mutation",
        maxAutomaticRetries: 0,
      });
    }
  });

  it("compiles session calls and server-side rename synchronously, and implant beacon calls as tasks", () => {
    for (const descriptor of Object.values(OPERATION_REGISTRY)) {
      if (descriptor.bindings.session !== undefined) {
        expect(descriptor.bindings.session.execution).toBe("synchronous-response");
        expect(descriptor.bindings.session.cancellation).toBe("not-supported");
      }
      if (
        descriptor.bindings.beacon !== undefined &&
        descriptor.id !== "target.rename" &&
        descriptor.id !== "beacon.reconfigure"
      ) {
        expect(descriptor.bindings.beacon.execution).toBe("asynchronous-beacon-task");
        expect(descriptor.bindings.beacon.cancellation).toBe("best-effort-beacon-task");
      }
    }
    expect(OPERATION_REGISTRY["target.rename"].bindings.beacon).toMatchObject({
      execution: "synchronous-response",
      cancellation: "not-supported",
      reconciliation: "target-refresh",
    });
    expect(OPERATION_REGISTRY["beacon.reconfigure"].modes).toEqual(["beacon"]);
    expect(OPERATION_REGISTRY["beacon.reconfigure"].bindings.beacon?.cancellation).toBe("not-supported");
    expect(OPERATION_REGISTRY["beacon.open-session"].modes).toEqual(["beacon"]);
  });

  it("keeps request encoding, decoding, timeout, capability, and disposition policy compiled and bounded", () => {
    for (const descriptor of Object.values(OPERATION_REGISTRY)) {
      expect(descriptor.confirmation).toBe("none");
      expect(descriptor.capabilityId).toMatch(/^(target|beacon)\./u);
      expect(descriptor.resultBounds.maximumDecodedBytes).toBeLessThanOrEqual(128 * 1_024);
      if (descriptor.resultBounds.maximumDecodedBytes > 64 * 1_024) {
        expect(["beacon.filesystem.cat", "beacon.filesystem.head", "beacon.filesystem.tail"])
          .toContain(descriptor.id);
      }
      expect(descriptor.resultBounds.maximumTextCharacters).toBeLessThanOrEqual(16_384);
      expect(descriptor.resultBounds.maximumTableRows).toBeLessThanOrEqual(256);
      expect(descriptor.resultBounds.maximumStructuredFields).toBeLessThanOrEqual(64);
      for (const binding of Object.values(descriptor.bindings)) {
        expect(binding?.requestEncoder).toBeTruthy();
        expect(binding?.responseDecoder).toBeTruthy();
      }
    }
  });

  it("does not expose arbitrary RPC or excluded administrative entries", () => {
    for (const excluded of ["server.clean", "server.remove-operator", "rpc.invoke", "target.kill", "session.close"]) {
      expect(findOperationDescriptor(excluded)).toBeUndefined();
    }
    expect(findOperationDescriptor("target.ping")).toBe(OPERATION_REGISTRY["target.ping"]);

    const serialized = JSON.stringify(OPERATION_REGISTRY);
    expect(serialized).not.toContain("server.clean");
    expect(serialized).not.toContain("RemoveOperator");
    expect(serialized).not.toContain("rpc.invoke");
  });

  it("deep-freezes the registry and every compiled policy object", () => {
    const visit = (value: unknown): void => {
      if (typeof value !== "object" || value === null) {
        return;
      }
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) {
        visit(child);
      }
    };
    visit(OPERATION_REGISTRY);

    expect(() => {
      (OPERATION_REGISTRY["target.ping"].modes as string[]).push("admin");
    }).toThrow(TypeError);
    expect(() => {
      (OPERATION_REGISTRY["target.ping"].bindings.session?.timeout as { timeoutSeconds: number }).timeoutSeconds = 1;
    }).toThrow(TypeError);
  });
});
