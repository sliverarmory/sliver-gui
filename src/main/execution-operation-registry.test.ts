import { describe, expect, it } from "vitest";
import type { BeaconSummary, SessionSummary } from "../shared/target-contracts.js";
import {
  EXECUTION_OPERATION_REGISTRY,
  assertExecutionOperationSupported,
  executionCapabilitiesForTarget,
} from "./execution-operation-registry.js";

const session = (os: string, liveness: "active" | "dead" = "active"): SessionSummary => ({
  mode: "session",
  id: "session-1",
  name: "workstation",
  hostname: "host",
  hostId: "host-1",
  username: "operator",
  os,
  arch: "amd64",
  transport: "mtls",
  remoteAddress: "127.0.0.1:4444",
  activeC2: "mtls://127.0.0.1:4444",
  executable: "implant",
  version: "1",
  locale: "en-US",
  integrity: "High",
  burned: false,
  liveness,
});

const beacon = (os: string): BeaconSummary => ({
  ...session(os),
  mode: "beacon",
  checkinStatus: "on-time",
});

describe("execution operation registry", () => {
  it("is exhaustive and immutable", () => {
    expect(Object.keys(EXECUTION_OPERATION_REGISTRY)).toHaveLength(19);
    expect(Object.isFrozen(EXECUTION_OPERATION_REGISTRY)).toBe(true);
    expect(Object.isFrozen(EXECUTION_OPERATION_REGISTRY["execution.assembly"].artifacts)).toBe(true);
  });

  it("keeps session-only remote composites away from beacons", () => {
    const capabilities = executionCapabilitiesForTarget(beacon("windows"));
    for (const operationId of ["execution.psexec", "execution.ssh", "execution.backdoor", "execution.dll-hijack"] as const) {
      expect(capabilities.find((capability) => capability.operationId === operationId)).toMatchObject({
        available: false,
        reason: { code: "requires-session" },
      });
    }
  });

  it("requires Windows for Windows execution and privilege families", () => {
    const capabilities = executionCapabilitiesForTarget(session("linux"));
    expect(capabilities.find((capability) => capability.operationId === "execution.process")?.available).toBe(true);
    expect(capabilities.find((capability) => capability.operationId === "execution.shellcode")?.available).toBe(true);
    expect(capabilities.find((capability) => capability.operationId === "privilege.make-token")).toMatchObject({
      available: false,
      reason: { code: "requires-windows" },
    });
  });

  it("applies the reviewed beacon command matrix to the six delivered M4 commands", () => {
    const delivered = [
      "execution.children",
      "privilege.get",
      "privilege.run-as",
      "privilege.make-token",
      "privilege.impersonate",
      "privilege.revert",
    ] as const;
    const windowsBeacon = beacon("windows");
    for (const operationId of delivered) {
      expect(assertExecutionOperationSupported(operationId, windowsBeacon).id).toBe(operationId);
      expect(() => assertExecutionOperationSupported(operationId, {
        ...windowsBeacon,
        transport: "namedpipe",
      })).toThrow(/selected transport or runtime/u);
      expect(() => assertExecutionOperationSupported(operationId, {
        ...windowsBeacon,
        arch: "unknown",
      })).toThrow(/architecture/u);
    }
    expect(assertExecutionOperationSupported("execution.children", beacon("linux")).id).toBe("execution.children");
    expect(() => assertExecutionOperationSupported("privilege.get", beacon("linux"))).toThrow(/Windows/u);
  });

  it("fails closed for dead sessions", () => {
    expect(() => assertExecutionOperationSupported("execution.process", session("linux", "dead"))).toThrow(/active session/u);
    expect(executionCapabilitiesForTarget(session("linux", "dead")).every((capability) => !capability.available)).toBe(true);
  });

  it("classifies credential and destructive actions for review", () => {
    expect(EXECUTION_OPERATION_REGISTRY["privilege.run-as"]).toMatchObject({
      risk: "credential-bearing",
      credentialBearing: true,
      confirmationRequired: true,
    });
    expect(EXECUTION_OPERATION_REGISTRY["execution.backdoor"]).toMatchObject({
      risk: "destructive",
      confirmationRequired: true,
    });
    expect(EXECUTION_OPERATION_REGISTRY["privilege.get"]).toMatchObject({
      risk: "read-only",
      confirmationRequired: false,
    });
  });
});
