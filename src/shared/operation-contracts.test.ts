// @vitest-environment node

import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  BeaconTaskDetail,
  OperationRecordId,
  OperationOwnership,
  SafeArtifactHandle,
  TargetOperationId,
  TargetOperationInput,
  TargetOperationRecord,
} from "./operation-contracts.js";
import type { SessionWorkbenchOperationId } from "./session-contracts.js";

import {
  BEACON_TASK_STATES,
  BEACON_MUTATION_OPERATION_IDS,
  OPERATION_DISPOSITION_KINDS,
  OPERATION_INPUT_LIMITS,
  TARGET_OPERATION_IDS,
  TARGET_OPERATION_STATES,
  isTargetOperationId,
  parseCancelBeaconTaskInput,
  parseCancelTargetOperationInput,
  parseBeaconMutationInput,
  parseBeaconMutationTokenInput,
  parseGetBeaconTaskInput,
  parseGetBeaconTaskResponseInput,
  parseOperationPageRequest,
  parseTargetOperationInput,
} from "./operation-contracts.js";

describe("operation contracts", () => {
  it("publishes the complete closed target operation, state, task, and disposition unions", () => {
    expect(TARGET_OPERATION_IDS).toEqual([
      "target.ping",
      "target.rename",
      "target.env-set",
      "target.env-unset",
      "beacon.reconfigure",
      "beacon.open-session",
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
      "beacon.registry.write",
      "beacon.registry.create",
      "beacon.registry.delete",
      "beacon.service.list",
      "beacon.service.info",
      "beacon.service.start",
      "beacon.service.stop",
    ]);
    expect(BEACON_MUTATION_OPERATION_IDS).toEqual([
      "beacon.registry.write", "beacon.registry.create", "beacon.registry.delete",
      "beacon.service.start", "beacon.service.stop",
    ]);
    expect(TARGET_OPERATION_STATES).toEqual([
      "queued",
      "submitting",
      "submitted",
      "running",
      "cancel-requested",
      "completed",
      "failed",
      "canceled",
      "partial",
      "outcome-unknown",
      "target-disappeared",
    ]);
    expect(BEACON_TASK_STATES).toEqual(["pending", "sent", "completed", "canceled", "failed", "unknown"]);
    expect(OPERATION_DISPOSITION_KINDS).toEqual([
      "inline-text",
      "table",
      "structured-detail",
      "native-save",
      "loot-save",
      "binary-preview",
      "stream-attachment",
    ]);
  });

  it("keeps main-owned identity, external ownership, and artifact/task payloads safe by type", () => {
    expectTypeOf<Extract<keyof BeaconTaskDetail, "request" | "response" | "rawRequest" | "rawResponse">>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof SafeArtifactHandle, "path" | "bytes" | "data">>().toEqualTypeOf<never>();
    expectTypeOf<Extract<OperationOwnership, { origin: "external" }>>().not.toHaveProperty("ownerWindowId");
    expectTypeOf<Extract<OperationOwnership, { origin: "unknown" }>["actor"]>().toEqualTypeOf<{
      attribution: "unknown";
    }>();
    expectTypeOf<TargetOperationRecord["requestId"]>().toEqualTypeOf<string>();
    expectTypeOf<TargetOperationRecord["operationId"]>().toEqualTypeOf<OperationRecordId>();
    expectTypeOf<TargetOperationInput["operationId"]>().toEqualTypeOf<TargetOperationId>();
    expectTypeOf<SessionWorkbenchOperationId>().toMatchTypeOf<OperationRecordId>();
    expectTypeOf<Extract<TargetOperationInput["operationId"], `session.${string}`>>()
      .toEqualTypeOf<never>();
    expectTypeOf<BeaconTaskDetail["errorKind"]>().toEqualTypeOf<
      "target-reported" | "decode-uncertain" | undefined
    >();
  });

  it("accepts the original ten typed operation input shapes", () => {
    expect(parseTargetOperationInput({ operationId: "target.ping" })).toEqual({ operationId: "target.ping" });
    expect(parseTargetOperationInput({ operationId: "target.rename", name: "target-01.example" })).toEqual({
      operationId: "target.rename",
      name: "target-01.example",
    });
    expect(parseTargetOperationInput({ operationId: "target.env-set", name: "M1_PROBE", value: "ready" })).toEqual({
      operationId: "target.env-set",
      name: "M1_PROBE",
      value: "ready",
    });
    expect(parseTargetOperationInput({ operationId: "target.env-unset", name: "M1_PROBE" })).toEqual({
      operationId: "target.env-unset",
      name: "M1_PROBE",
    });
    expect(
      parseTargetOperationInput({
        operationId: "beacon.reconfigure",
        reconnectIntervalSeconds: 60,
        intervalSeconds: 30,
        jitterSeconds: 5,
      }),
    ).toEqual({
      operationId: "beacon.reconfigure",
      reconnectIntervalSeconds: 60,
      intervalSeconds: 30,
      jitterSeconds: 5,
    });
    expect(
      parseTargetOperationInput({
        operationId: "beacon.open-session",
        delaySeconds: 0,
      }),
    ).toEqual({
      operationId: "beacon.open-session",
      delaySeconds: 0,
    });
    expect(parseTargetOperationInput({ operationId: "beacon.filesystem.pwd" })).toEqual({
      operationId: "beacon.filesystem.pwd",
    });
    expect(parseTargetOperationInput({ operationId: "beacon.filesystem.ls", path: "/tmp" })).toEqual({
      operationId: "beacon.filesystem.ls",
      path: "/tmp",
    });
    expect(parseTargetOperationInput({ operationId: "beacon.process.list", fullInfo: true })).toEqual({
      operationId: "beacon.process.list",
      fullInfo: true,
    });
    expect(parseTargetOperationInput({ operationId: "beacon.network.interfaces" })).toEqual({
      operationId: "beacon.network.interfaces",
    });
  });

  it("accepts bounded BC-05 reads and rejects unsafe counts or extra fields", () => {
    expect(parseTargetOperationInput({ operationId: "beacon.environment.list", name: "PATH" }))
      .toEqual({ operationId: "beacon.environment.list", name: "PATH" });
    expect(parseTargetOperationInput({ operationId: "beacon.filesystem.head", path: "/tmp/a", lines: 10 }))
      .toEqual({ operationId: "beacon.filesystem.head", path: "/tmp/a", lines: 10 });
    expect(parseTargetOperationInput({ operationId: "beacon.filesystem.tail", path: "/tmp/a", bytes: 128 }))
      .toEqual({ operationId: "beacon.filesystem.tail", path: "/tmp/a", bytes: 128 });
    expect(parseTargetOperationInput({ operationId: "beacon.filesystem.grep", path: ".", pattern: "needle",
      recursive: false, before: 0, after: 2 })).toMatchObject({ pattern: "needle", after: 2 });
    expect(() => parseTargetOperationInput({ operationId: "beacon.filesystem.head", path: "/tmp/a",
      bytes: 2, lines: 1 })).toThrow(/either bytes or lines/u);
    expect(() => parseTargetOperationInput({ operationId: "beacon.filesystem.tail", path: "/tmp/a",
      lines: 10 })).toThrow(/unavailable/u);
    expect(() => parseTargetOperationInput({ operationId: "beacon.filesystem.cat", path: "/tmp/a", rpc: "download" }))
      .toThrow(/exactly/u);
  });

  it("parses all ten BC-08 commands while bounding locations and typed Registry values", () => {
    const location = { hive: "HKCU", path: "Software\\Acme", hostname: "host01" };
    const valid = [
      { operationId: "beacon.registry.read", ...location, key: "Name" },
      { operationId: "beacon.registry.list-subkeys", ...location },
      { operationId: "beacon.registry.list-values", ...location },
      { operationId: "beacon.registry.write", ...location, key: "Name", value: { type: "string", value: "Alice" } },
      { operationId: "beacon.registry.create", ...location, key: "Child" },
      { operationId: "beacon.registry.delete", ...location, key: "Child" },
      { operationId: "beacon.service.list", hostname: "host01" },
      { operationId: "beacon.service.info", name: "Spooler", hostname: "host01" },
      { operationId: "beacon.service.start", name: "Spooler", hostname: "host01" },
      { operationId: "beacon.service.stop", name: "Spooler", hostname: "host01" },
    ] as const;
    for (const input of valid) expect(parseTargetOperationInput(input)).toEqual(input);
    for (const input of valid.slice(3, 6).concat(valid.slice(8))) {
      expect(parseBeaconMutationInput(input)).toEqual(input);
    }
    expect(() => parseBeaconMutationInput(valid[0])).toThrow(/does not require/u);
    expect(parseBeaconMutationTokenInput({ token: "review_1" })).toEqual({ token: "review_1" });
    expect(() => parseBeaconMutationTokenInput({ token: "review_1", targetId: "beacon_2" }))
      .toThrow(/exactly/u);

    const base = { operationId: "beacon.registry.write", hive: "HKCU", path: "Software\\Acme", key: "Name" };
    for (const value of [
      { type: "string", value: "hello" }, { type: "binary", hex: "00ff" },
      { type: "dword", value: 0xffff_ffff }, { type: "qword", value: "18446744073709551615" },
    ]) expect(parseTargetOperationInput({ ...base, value })).toMatchObject({ value });
    expect(parseTargetOperationInput({ ...base, value: { type: "qword", value: "0001" } }))
      .toMatchObject({ value: { type: "qword", value: "1" } });
    expect(parseBeaconMutationInput({ ...base, value: { type: "qword", value: "0000" } }))
      .toMatchObject({ value: { type: "qword", value: "0" } });
    for (const value of [
      { type: "binary", hex: "abc" }, { type: "dword", value: -1 },
      { type: "qword", value: "18446744073709551616" }, { type: "string", value: "x".repeat(16_385) },
    ]) expect(() => parseTargetOperationInput({ ...base, value })).toThrow();
    expect(() => parseTargetOperationInput({ ...base, value: { type: "binary", hex: "aa".repeat(16_385) } }))
      .toThrow(/write limit/u);
  });

  it("rejects BC-08 unknown fields, unsupported hives, NUL, and oversized names", () => {
    const registry = { operationId: "beacon.registry.read", hive: "HKCU", path: "Software", key: "Name" };
    expect(() => parseTargetOperationInput({ ...registry, rpc: "RegistryRead" })).toThrow(/unexpected/u);
    expect(() => parseTargetOperationInput({ ...registry, hive: "HKZZ" })).toThrow(/not supported/u);
    expect(() => parseTargetOperationInput({ ...registry, path: "x".repeat(4_097) })).toThrow();
    expect(() => parseTargetOperationInput({ ...registry, key: "bad\0key" })).toThrow(/NUL/u);
    expect(() => parseTargetOperationInput({ ...registry, hostname: "bad\0host" })).toThrow(/NUL/u);
    expect(() => parseTargetOperationInput({ ...registry, hostname: "x".repeat(256) })).toThrow();
    expect(() => parseTargetOperationInput({ operationId: "beacon.registry.list-subkeys", hive: "HKCU",
      path: "Software", key: "unreviewed" })).toThrow(/unexpected/u);
    expect(() => parseTargetOperationInput({ operationId: "beacon.service.list", name: "Spooler" })).toThrow(/unexpected/u);
    expect(() => parseTargetOperationInput({ operationId: "beacon.service.start", name: "x".repeat(257) })).toThrow();
    expect(() => parseTargetOperationInput({ operationId: "beacon.service.stop", name: "bad\0name" })).toThrow(/NUL/u);
    expect(() => parseTargetOperationInput({ operationId: "beacon.service.info", name: "Spooler", targetId: "other" }))
      .toThrow(/unexpected/u);
  });

  it("rejects ill-formed UTF-16 in BC-08 fields before protobuf encoding", () => {
    const loneSurrogate = "\ud800";
    const registry = { operationId: "beacon.registry.read", hive: "HKCU", path: "Software", key: "Name" };
    expect(() => parseTargetOperationInput({ ...registry, path: loneSurrogate })).toThrow();
    expect(() => parseTargetOperationInput({ ...registry, key: loneSurrogate })).toThrow();
    expect(() => parseTargetOperationInput({ ...registry, hostname: loneSurrogate })).toThrow();
    expect(() => parseTargetOperationInput({ operationId: "beacon.registry.write", hive: "HKCU",
      path: "Software", key: "Name", value: { type: "string", value: loneSurrogate } })).toThrow();
    expect(() => parseTargetOperationInput({ operationId: "beacon.service.info", name: loneSurrogate })).toThrow();
    expect(() => parseTargetOperationInput({ operationId: "beacon.service.list", hostname: loneSurrogate })).toThrow();
    expect(parseTargetOperationInput({ operationId: "beacon.service.info", name: "Svc\ud83d\ude00" }))
      .toMatchObject({ name: "Svc\ud83d\ude00" });
  });

  it("rejects an arbitrary method selector and every renderer-supplied policy field", () => {
    const forbiddenFields = [
      "rpc",
      "rpcMethod",
      "adapterMethod",
      "timeoutSeconds",
      "retry",
      "decoder",
      "disposition",
      "capabilityId",
      "requestId",
      "target",
    ];
    for (const field of forbiddenFields) {
      expect(() => parseTargetOperationInput({ operationId: "target.ping", [field]: "server.clean" })).toThrow(
        /exactly these fields/u,
      );
    }
    expect(() => parseTargetOperationInput({ operationId: "server.clean" })).toThrow(/not an allowed/u);
    expect(isTargetOperationId("server.clean")).toBe(false);
    expect(isTargetOperationId("target.ping")).toBe(true);
  });

  it("enforces target, environment, and interval bounds without accepting renderer C2 endpoints", () => {
    for (const name of ["", ".", "..", "..hidden", "invalid name", "a".repeat(33)]) {
      expect(() => parseTargetOperationInput({ operationId: "target.rename", name })).toThrow();
    }
    expect(() =>
      parseTargetOperationInput({ operationId: "target.env-set", name: "BAD=NAME", value: "value" }),
    ).toThrow(/must not contain/u);
    expect(() =>
      parseTargetOperationInput({
        operationId: "target.env-set",
        name: "NAME",
        value: "x".repeat(OPERATION_INPUT_LIMITS.environmentValueLength + 1),
      }),
    ).toThrow(/0-16384/u);
    expect(() => parseTargetOperationInput({ operationId: "beacon.reconfigure" })).toThrow(/at least one/u);
    expect(() =>
      parseTargetOperationInput({ operationId: "beacon.reconfigure", intervalSeconds: 0 }),
    ).toThrow(/between 1/u);
    expect(() =>
      parseTargetOperationInput({ operationId: "beacon.reconfigure", jitterSeconds: 0 }),
    ).toThrow(/between 1/u);
    expect(() =>
      parseTargetOperationInput({
        operationId: "beacon.reconfigure",
        intervalSeconds: 5,
        c2Uri: "https://attacker.invalid",
      }),
    ).toThrow(/unexpected field/u);
    expect(() =>
      parseTargetOperationInput({
        operationId: "beacon.open-session",
        c2Urls: ["https://attacker.invalid"],
        delaySeconds: 0,
      }),
    ).toThrow(/exactly these fields/u);
    expect(() => parseTargetOperationInput({ operationId: "beacon.filesystem.ls", path: "" })).toThrow(/1-4096/u);
    expect(() =>
      parseTargetOperationInput({ operationId: "beacon.filesystem.ls", path: "x".repeat(4_097) }),
    ).toThrow(/1-4096/u);
    expect(() => parseTargetOperationInput({ operationId: "beacon.filesystem.ls", path: "bad\0path" }))
      .toThrow(/NUL/u);
    expect(() => parseTargetOperationInput({ operationId: "beacon.process.list", fullInfo: 1 }))
      .toThrow(/boolean/u);
    expect(() => parseTargetOperationInput({ operationId: "beacon.filesystem.pwd", target: "beacon_1" }))
      .toThrow(/exactly/u);
  });

  it("strictly parses bounded pagination and task/request identifiers", () => {
    expect(parseOperationPageRequest(undefined)).toEqual({});
    expect(parseOperationPageRequest({ cursor: "next_1", limit: 50 })).toEqual({ cursor: "next_1", limit: 50 });
    expect(() => parseOperationPageRequest({ limit: OPERATION_INPUT_LIMITS.pageLimit + 1 })).toThrow(/between/u);
    expect(() => parseOperationPageRequest({ limit: 25, rpc: "GetBeaconTasks" })).toThrow(/unexpected field/u);

    expect(parseCancelTargetOperationInput({ requestId: "request_01-test" })).toEqual({
      requestId: "request_01-test",
    });
    expect(parseGetBeaconTaskInput({ taskId: "task_01-test" })).toEqual({ taskId: "task_01-test" });
    expect(parseCancelBeaconTaskInput({ taskId: "task_01-test" })).toEqual({ taskId: "task_01-test" });
    expect(() => parseGetBeaconTaskInput({ taskId: "../task" })).toThrow(/unsupported/u);
    expect(() => parseCancelBeaconTaskInput({ taskId: "task", force: true })).toThrow(/exactly/u);
  });

  it("accepts only task identity and a nonnegative integer response offset", () => {
    expect(parseGetBeaconTaskResponseInput({ taskId: "task_1" })).toEqual({ taskId: "task_1" });
    expect(parseGetBeaconTaskResponseInput({ taskId: "task_1", offset: 65_536 })).toEqual({ taskId: "task_1", offset: 65_536 });
    for (const input of [
      { taskId: "task_1", offset: -1 },
      { taskId: "task_1", offset: 0.5 },
      { taskId: "task_1", offset: Number.POSITIVE_INFINITY },
      { taskId: "task_1", offset: Number.MAX_SAFE_INTEGER + 1 },
      { taskId: "task_1", offset: "0" },
      { taskId: "task_1", beaconId: "another_beacon" },
      { taskId: "../task" },
      {},
    ]) expect(() => parseGetBeaconTaskResponseInput(input)).toThrow();
  });
});
