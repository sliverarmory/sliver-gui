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
  OPERATION_DISPOSITION_KINDS,
  OPERATION_INPUT_LIMITS,
  TARGET_OPERATION_IDS,
  TARGET_OPERATION_STATES,
  isTargetOperationId,
  parseCancelBeaconTaskInput,
  parseCancelTargetOperationInput,
  parseGetBeaconTaskInput,
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
});
