// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  TARGET_OPERATION_IDS,
  type TargetMode,
  type TargetOperationId,
} from "../shared/operation-contracts.js";
import {
  OPERATION_REGISTRY,
  findOperationDescriptor,
  getOperationDescriptor,
  type OperationAdapterMethodId,
} from "./operation-registry.js";

// This reviewed dispatch map is independent of the compiled registry: an added
// operation or a changed client method must receive an explicit test review.
const REVIEWED_ADAPTER_METHODS = {
  "target.ping": { session: "pingSession", beacon: "pingBeacon" },
  "target.rename": { session: "renameSession", beacon: "renameBeacon" },
  "target.env-set": { session: "setEnvSession", beacon: "setEnvBeacon" },
  "target.env-unset": { session: "unsetEnvSession", beacon: "unsetEnvBeacon" },
  "beacon.reconfigure": { beacon: "reconfigureBeacon" },
  "beacon.open-session": { beacon: "openSessionFromBeacon" },
  "beacon.filesystem.pwd": { beacon: "pwdBeacon" },
  "beacon.filesystem.ls": { beacon: "lsBeacon" },
  "beacon.process.list": { beacon: "psBeacon" },
  "beacon.network.interfaces": { beacon: "ifconfigBeacon" },
  "beacon.environment.list": { beacon: "envBeacon" },
  "beacon.identity.whoami": { beacon: "whoamiBeacon" },
  "beacon.network.netstat": { beacon: "netstatBeacon" },
  "beacon.filesystem.mount": { beacon: "mountBeacon" },
  "beacon.filesystem.memfiles": { beacon: "memfilesBeacon" },
  "beacon.filesystem.cat": { beacon: "catBeacon" },
  "beacon.filesystem.head": { beacon: "headBeacon" },
  "beacon.filesystem.tail": { beacon: "tailBeacon" },
  "beacon.filesystem.grep": { beacon: "grepBeacon" },
  "beacon.registry.read": { beacon: "registryReadBeacon" },
  "beacon.registry.list-subkeys": { beacon: "registryListSubkeysBeacon" },
  "beacon.registry.list-values": { beacon: "registryListValuesBeacon" },
  "beacon.registry.write": { beacon: "registryWriteBeacon" },
  "beacon.registry.create": { beacon: "registryCreateBeacon" },
  "beacon.registry.delete": { beacon: "registryDeleteBeacon" },
  "beacon.service.list": { beacon: "servicesBeacon" },
  "beacon.service.info": { beacon: "serviceDetailBeacon" },
  "beacon.service.start": { beacon: "serviceStartBeacon" },
  "beacon.service.stop": { beacon: "serviceStopBeacon" },
} as const satisfies Record<TargetOperationId, Partial<Record<TargetMode, OperationAdapterMethodId>>>;

describe("compiled operation registry", () => {
  it("is an exact allowlist with one internally consistent binding per declared mode", () => {
    expect(Object.keys(OPERATION_REGISTRY)).toEqual([...TARGET_OPERATION_IDS]);
    expect(Object.keys(REVIEWED_ADAPTER_METHODS)).toEqual([...TARGET_OPERATION_IDS]);

    for (const operationId of TARGET_OPERATION_IDS) {
      const descriptor = OPERATION_REGISTRY[operationId];
      expect(descriptor.id).toBe(operationId);
      expect(Object.keys(descriptor.bindings).sort()).toEqual([...descriptor.modes].sort());
      expect(Object.fromEntries(Object.entries(descriptor.bindings).map(([mode, binding]) => [
        mode,
        binding?.adapterMethod,
      ])), operationId).toEqual(REVIEWED_ADAPTER_METHODS[operationId]);
      for (const mode of descriptor.modes) {
        const binding = descriptor.bindings[mode];
        expect(binding).toBeDefined();
        expect(binding?.timeout.timeoutSeconds).toBeGreaterThan(0);
        expect(binding?.timeout.afterSubmission).toBe("outcome-unknown");
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
      "beacon.registry.read",
      "beacon.registry.list-subkeys",
      "beacon.registry.list-values",
      "beacon.service.list",
      "beacon.service.info",
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
        expect(descriptor.bindings.beacon.cancellation).toBe(
          descriptor.confirmation === "beacon-mutation-plan" ? "not-supported" : "best-effort-beacon-task",
        );
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
      expect(descriptor.confirmation).toBe(
        ["beacon.registry.write", "beacon.registry.create", "beacon.registry.delete",
          "beacon.service.start", "beacon.service.stop"].includes(descriptor.id)
          ? "beacon-mutation-plan" : "none",
      );
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

  it("keeps BC-08 mutations reviewed, single dispatch, and readback limited", () => {
    for (const id of ["beacon.registry.write", "beacon.registry.create", "beacon.registry.delete",
      "beacon.service.start", "beacon.service.stop"] as const) {
      const descriptor = getOperationDescriptor(id);
      expect(descriptor.modes).toEqual(["beacon"]);
      expect(descriptor.idempotency).toEqual({ class: "unconfirmed-mutation", maxAutomaticRetries: 0 });
      expect(descriptor.confirmation).toBe("beacon-mutation-plan");
      expect(descriptor.bindings.beacon).toMatchObject({
        execution: "asynchronous-beacon-task", cancellation: "not-supported", reconciliation: "beacon-task-state",
      });
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
