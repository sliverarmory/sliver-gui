// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  DESTRUCTIVE_TARGET_ACTION_IDS,
  MAX_TARGET_DOMAIN_ITEMS,
  TARGET_CAPABILITY_IDS,
  type PrepareTargetActionInput,
  type TargetActionExecutionResult,
} from "./target-contracts.js";

describe("target contracts", () => {
  it("keeps target domains and capability IDs closed and bounded", () => {
    expect(MAX_TARGET_DOMAIN_ITEMS).toBe(500);
    expect(TARGET_CAPABILITY_IDS).toEqual([
      "target.ping",
      "target.rename",
      "target.terminate",
      "target.task.execute",
      "target.environment.write",
      "session.close",
      "beacon.remove",
      "beacon.reconfigure",
      "beacon.open-session",
      "beacon.tasks.read",
      "beacon.tasks.cancel",
    ]);
    expect(new Set(TARGET_CAPABILITY_IDS).size).toBe(TARGET_CAPABILITY_IDS.length);
  });

  it("allows only the reviewed destructive action IDs", () => {
    expect(DESTRUCTIVE_TARGET_ACTION_IDS).toEqual([
      "target.kill",
      "session.close",
      "beacon.remove",
      "sessions.prune-dead",
      "beacons.prune-overdue",
    ]);
    expect(DESTRUCTIVE_TARGET_ACTION_IDS).not.toContain("clean");
    expect(DESTRUCTIVE_TARGET_ACTION_IDS).not.toContain("operator.delete");
  });

  it("keeps prepare requests target-free and execution outcomes per target", () => {
    const prepare: PrepareTargetActionInput = { actionId: "target.kill" };
    expect(Object.keys(prepare)).toEqual(["actionId"]);
    expect(prepare).not.toHaveProperty("targetId");

    const execution: TargetActionExecutionResult = {
      actionId: "beacons.prune-overdue",
      outcomes: [],
      partial: true,
    };
    expect(execution).toEqual({ actionId: "beacons.prune-overdue", outcomes: [], partial: true });
  });
});
