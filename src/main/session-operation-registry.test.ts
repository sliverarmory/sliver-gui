// @vitest-environment node

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  SESSION_DESTRUCTIVE_ACTION_IDS,
  SESSION_WORKBENCH_ARTIFACT_IDS,
  SESSION_WORKBENCH_MUTATION_IDS,
  SESSION_WORKBENCH_QUERY_IDS,
  type SessionWorkbenchOperationId,
} from "../shared/session-contracts.js";
import {
  getSessionOperationDescriptor,
  SESSION_OPERATION_CATEGORIES,
  SESSION_OPERATION_DESCRIPTORS,
  type SessionOperationDescriptor,
} from "./session-operation-registry.js";

describe("session operation registry", () => {
  const everyOperationId = [
    ...SESSION_WORKBENCH_QUERY_IDS,
    ...SESSION_WORKBENCH_MUTATION_IDS,
    ...SESSION_WORKBENCH_ARTIFACT_IDS,
    ...SESSION_DESTRUCTIVE_ACTION_IDS,
  ];

  it("exhaustively describes the closed session operation union", () => {
    expect(SESSION_OPERATION_CATEGORIES).toEqual([
      "read",
      "direct-mutation",
      "artifact",
      "reviewed-mutation",
    ]);
    expect(Object.keys(SESSION_OPERATION_DESCRIPTORS).sort()).toEqual([...everyOperationId].sort());
    expect(new Set(everyOperationId).size).toBe(everyOperationId.length);
    expectTypeOf<keyof typeof SESSION_OPERATION_DESCRIPTORS>().toEqualTypeOf<SessionWorkbenchOperationId>();
    expectTypeOf<(typeof SESSION_OPERATION_DESCRIPTORS)[SessionWorkbenchOperationId]>()
      .toMatchTypeOf<Readonly<SessionOperationDescriptor>>();
  });

  it.each([
    [SESSION_WORKBENCH_QUERY_IDS, "read"],
    [SESSION_WORKBENCH_MUTATION_IDS, "direct-mutation"],
    [SESSION_WORKBENCH_ARTIFACT_IDS, "artifact"],
    [SESSION_DESTRUCTIVE_ACTION_IDS, "reviewed-mutation"],
  ] as const)("classifies every %s operation", (ids, category) => {
    for (const id of ids) {
      expect(getSessionOperationDescriptor(id)).toMatchObject({ id, category, cancellation: "not-supported" });
    }
  });

  it("marks only remote-state mutations as outcome-unknown after response loss", () => {
    for (const id of SESSION_WORKBENCH_QUERY_IDS) {
      expect(getSessionOperationDescriptor(id).outcomeUnknownAfterSubmission, id).toBe(false);
    }
    for (const id of SESSION_WORKBENCH_MUTATION_IDS) {
      expect(getSessionOperationDescriptor(id).outcomeUnknownAfterSubmission, id).toBe(true);
    }
    for (const id of SESSION_DESTRUCTIVE_ACTION_IDS) {
      expect(getSessionOperationDescriptor(id).outcomeUnknownAfterSubmission, id).toBe(true);
    }
    for (const id of SESSION_WORKBENCH_ARTIFACT_IDS) {
      expect(getSessionOperationDescriptor(id).outcomeUnknownAfterSubmission, id)
        .toBe(id === "session.filesystem.upload-open");
    }
  });

  it("publishes bounded generic messages without runtime input or result fields", () => {
    for (const id of everyOperationId) {
      const descriptor = getSessionOperationDescriptor(id);
      expect(descriptor.startMessage.length).toBeGreaterThan(0);
      expect(descriptor.completionMessage.length).toBeGreaterThan(0);
      expect(descriptor.startMessage.length).toBeLessThanOrEqual(80);
      expect(descriptor.completionMessage.length).toBeLessThanOrEqual(80);
      expect(Object.keys(descriptor).sort()).toEqual([
        "cancellation",
        "category",
        "completionMessage",
        "id",
        "outcomeUnknownAfterSubmission",
        "startMessage",
      ]);
      expect(Object.isFrozen(descriptor)).toBe(true);
    }
    expect(Object.isFrozen(SESSION_OPERATION_DESCRIPTORS)).toBe(true);
    expect(() => getSessionOperationDescriptor("session.not-real" as SessionWorkbenchOperationId))
      .toThrow(/Unknown session operation descriptor/u);
  });
});
