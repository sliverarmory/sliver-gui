// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type {
  OperationDisposition,
  TargetOperationInput,
  TargetOperationRecord,
} from "../shared/operation-contracts.js";
import type {
  BeaconSummary,
  SessionSummary,
  TargetCapabilityId,
  TargetMode,
  TargetRef,
  TargetSummary,
} from "../shared/target-contracts.js";
import {
  isAuthoritativeActiveC2Usable,
  OperationEngine,
  TaskCancellationDispatchError,
  type ExternalOperationDescriptor,
  type OperationEngineHost,
  type ResolvedOperationTarget,
} from "./operation-engine.js";

describe("OperationEngine", () => {
  it("journals main-owned session workbench activity without retaining result contents", () => {
    const changes: TargetOperationRecord[] = [];
    const harness = createHarness("session", { onChanged: (record) => changes.push(structuredClone(record)) });

    const started = harness.engine.beginExternal("session.filesystem.ls", harness.active);
    expect(started).toMatchObject({
      operationId: "session.filesystem.ls",
      mode: "session",
      target: { fingerprint: "session:fingerprint" },
      state: "submitting",
      attempts: 0,
      cancellation: "not-supported",
      message: "List directory in progress",
    });
    expect(Object.isFrozen(started)).toBe(true);

    harness.engine.markExternalSubmitted(started.requestId);
    const finished = harness.engine.finishExternal(started.requestId, "completed");
    expect(finished).toMatchObject({
      state: "completed",
      attempts: 1,
      finishedAt: expect.any(String),
      message: "List directory completed",
    });
    expect(finished.disposition).toBeUndefined();
    expect(harness.engine.list().items.map((record) => record.requestId)).toContain(started.requestId);
    expect(changes.map((record) => record.state)).toEqual(["submitting", "running", "completed"]);
    expect(JSON.stringify(harness.engine.list())).not.toContain("remote-file-contents");
  });

  it("uses descriptor-owned uncertainty for close and target loss", () => {
    const harness = createHarness("session", { terminalRecordLimit: 4 });
    const disappeared = harness.engine.beginExternal("session.filesystem.mkdir", harness.active);
    expect(harness.engine.markTargetUnavailable(harness.active.ref, "secret-path-or-result-content")).toBe(1);
    expect(harness.engine.get(disappeared.requestId)).toMatchObject({
      state: "target-disappeared",
      finishedAt: expect.any(String),
    });
    expect(JSON.stringify(harness.engine.get(disappeared.requestId))).not.toContain("secret-path-or-result-content");

    const disappearedAfterSubmission = harness.engine.beginExternal(
      "session.filesystem.mkdir",
      harness.active,
    );
    harness.engine.markExternalSubmitted(disappearedAfterSubmission.requestId);
    expect(harness.engine.markTargetUnavailable(harness.active.ref, "gone after dispatch")).toBe(1);
    expect(harness.engine.get(disappearedAfterSubmission.requestId)).toMatchObject({
      state: "outcome-unknown",
      attempts: 1,
      finishedAt: expect.any(String),
    });

    const reviewedMutationAfterSubmission = harness.engine.beginExternal(
      "session.process.terminate",
      harness.active,
    );
    harness.engine.markExternalSubmitted(reviewedMutationAfterSubmission.requestId);
    expect(harness.engine.markTargetUnavailable(harness.active.ref, "gone during reviewed action")).toBe(1);
    expect(harness.engine.get(reviewedMutationAfterSubmission.requestId)).toMatchObject({
      state: "outcome-unknown",
      attempts: 1,
      finishedAt: expect.any(String),
    });

    const submittedMutation = harness.engine.beginExternal("session.filesystem.mkdir", harness.active);
    harness.engine.markExternalSubmitted(submittedMutation.requestId);
    const submittedRead = harness.engine.beginExternal("session.filesystem.ls", harness.active);
    harness.engine.markExternalSubmitted(submittedRead.requestId);
    const localOnly = harness.engine.beginExternal("session.filesystem.stage-text", harness.active);
    harness.engine.close();

    expect(harness.engine.get(submittedMutation.requestId)).toMatchObject({ state: "outcome-unknown" });
    expect(harness.engine.get(submittedRead.requestId)).toMatchObject({ state: "canceled" });
    expect(harness.engine.get(localOnly.requestId)).toMatchObject({ state: "canceled" });
    expect(() => harness.engine.beginExternal("session.filesystem.ls", harness.active)).toThrow(/closed/u);
    expect(harness.engine.markExternalSubmitted(localOnly.requestId)).toMatchObject({ state: "canceled" });
    expect(harness.engine.finishExternal(submittedMutation.requestId, "completed"))
      .toMatchObject({ state: "outcome-unknown" });
  });

  it("enforces outcome-unknown only for submitted state-changing operations", () => {
    const harness = createHarness("session");
    const read = harness.engine.beginExternal("session.filesystem.ls", harness.active);
    harness.engine.markExternalSubmitted(read.requestId);
    expect(() => harness.engine.finishExternal(read.requestId, "outcome-unknown"))
      .toThrow(/cannot have an unknown remote-state outcome/u);
    expect(harness.engine.get(read.requestId)).toMatchObject({ state: "running" });
    harness.engine.finishExternal(read.requestId, "failed");

    const mutation = harness.engine.beginExternal("session.filesystem.mkdir", harness.active);
    expect(() => harness.engine.finishExternal(mutation.requestId, "outcome-unknown"))
      .toThrow(/before submission/u);
    harness.engine.markExternalSubmitted(mutation.requestId);
    expect(harness.engine.finishExternal(mutation.requestId, "outcome-unknown"))
      .toMatchObject({ state: "outcome-unknown", attempts: 1 });
  });

  it("recovers only submitted external mutation uncertainty after an exact success", () => {
    const changes: TargetOperationRecord[] = [];
    const harness = createHarness("session", { onChanged: (record) => changes.push(structuredClone(record)) });
    const mutation = harness.engine.beginExternal("session.filesystem.mkdir", harness.active);
    harness.engine.markExternalSubmitted(mutation.requestId);
    harness.engine.markTargetUnavailable(harness.active.ref, "gone while the exact response was pending");

    expect(harness.engine.resolveExternalOutcome(mutation.requestId, "completed")).toMatchObject({
      state: "completed",
      attempts: 1,
      finishedAt: expect.any(String),
      message: "Create directory completed",
    });
    expect(changes.map(({ state }) => state)).toEqual([
      "submitting",
      "running",
      "outcome-unknown",
      "completed",
    ]);

    const unsubmitted = harness.engine.beginExternal("session.filesystem.mkdir", harness.active);
    expect(() => harness.engine.resolveExternalOutcome(unsubmitted.requestId, "completed"))
      .toThrow(/submitted external operation/u);
    const read = harness.engine.beginExternal("session.filesystem.ls", harness.active);
    harness.engine.markExternalSubmitted(read.requestId);
    harness.engine.markTargetUnavailable(harness.active.ref);
    expect(() => harness.engine.resolveExternalOutcome(read.requestId, "completed"))
      .toThrow(/submitted external operation/u);
    const failed = harness.engine.beginExternal("session.filesystem.mkdir", harness.active);
    harness.engine.markExternalSubmitted(failed.requestId);
    harness.engine.finishExternal(failed.requestId, "failed");
    expect(() => harness.engine.resolveExternalOutcome(failed.requestId, "completed"))
      .toThrow(/submitted external operation/u);

    const rejected = harness.engine.beginExternal("session.filesystem.mkdir", harness.active);
    harness.engine.markExternalSubmitted(rejected.requestId);
    harness.engine.markTargetUnavailable(harness.active.ref);
    expect(harness.engine.resolveExternalOutcome(rejected.requestId, "failed")).toMatchObject({
      state: "failed",
      attempts: 1,
      message: "The session operation failed",
    });
  });

  it("does not recover external mutation uncertainty after the engine closes", () => {
    const harness = createHarness("session");
    const mutation = harness.engine.beginExternal("session.filesystem.mkdir", harness.active);
    harness.engine.markExternalSubmitted(mutation.requestId);
    harness.engine.close();

    expect(harness.engine.resolveExternalOutcome(mutation.requestId, "completed")).toMatchObject({
      state: "outcome-unknown",
    });
  });

  it("indexes and reconciles an exact external beacon task without decoding M1 results", async () => {
    const harness = createHarness("beacon", { ids: ["external_beacon_request"] });
    const descriptor = externalBeaconDescriptor({ taskTimeoutSeconds: 45 });
    const started = harness.engine.beginExternal("execution.process", harness.active, descriptor);

    expect(harness.reserveTaskClaim).toHaveBeenCalledWith(started.requestId);
    const submitted = harness.engine.markExternalSubmitted(started.requestId, "external_beacon_task");
    expect(submitted).toMatchObject({
      operationId: "execution.process",
      state: "running",
      taskId: "external_beacon_task",
      deadlineAt: expect.any(String),
      attempts: 1,
    });
    expect(harness.claimExternalTask).toHaveBeenCalledWith(
      "external_beacon_task",
      started.requestId,
      "execution.process",
      harness.active.ref.id,
    );
    expect(harness.engine.findByTask("external_beacon_task", harness.active.ref.id)?.requestId)
      .toBe(started.requestId);
    expect(harness.engine.requiresTaskResultVerification("external_beacon_task", harness.active.ref.id))
      .toBe(false);

    await expect(harness.engine.reconcileTask({
      taskId: "external_beacon_task",
      beaconId: harness.active.ref.id,
      state: "pending",
      error: "REMOTE_SECRET_PENDING",
      disposition: {
        kind: "inline-text",
        text: "REMOTE_SECRET_DISPOSITION",
        truncated: false,
      },
    })).resolves.toMatchObject({
      state: "running",
      message: "The beacon task is awaiting completion",
    });

    expect(harness.engine.markTaskOutcomeUnknown(
      "external_beacon_task",
      harness.active.ref.id,
      "LOCAL_SECRET_TRANSPORT_ERROR",
    )).toMatchObject({
      state: "outcome-unknown",
      message: "The reviewed task outcome could not be confirmed.",
    });
    const recovered = await harness.engine.reconcileTask({
      taskId: "external_beacon_task",
      beaconId: harness.active.ref.id,
      state: "completed",
      error: "REMOTE_SECRET_COMPLETION_ERROR",
      disposition: {
        kind: "inline-text",
        text: "REMOTE_SECRET_COMPLETION_BODY",
        truncated: false,
      },
    });
    expect(recovered).toMatchObject({
      state: "completed",
      message: "Reviewed execution completed.",
      finishedAt: expect.any(String),
    });
    expect(recovered?.disposition).toBeUndefined();
    expect(JSON.stringify(recovered)).not.toMatch(/REMOTE_SECRET|LOCAL_SECRET/u);
    expect(harness.settleTaskClaim).toHaveBeenCalledWith("external_beacon_task", started.requestId);

    await expect(harness.engine.reconcileTask({
      taskId: "external_beacon_task",
      beaconId: harness.active.ref.id,
      state: "failed",
      error: "late remote failure",
    })).resolves.toMatchObject({ state: "completed", message: "Reviewed execution completed." });
  });

  it("rejects duplicate external task IDs, cross-window claims, and cross-beacon reconciliation", async () => {
    const harness = createHarness("beacon", { ids: ["external_first", "external_second"] });
    const first = harness.engine.beginExternal("execution.process", harness.active, externalBeaconDescriptor());
    const second = harness.engine.beginExternal("execution.shellcode", harness.active, externalBeaconDescriptor());
    harness.engine.markExternalSubmitted(first.requestId, "duplicate_external_task");

    expect(() => harness.engine.markExternalSubmitted(second.requestId, "duplicate_external_task"))
      .toThrow(/duplicate task ID/u);
    expect(() => harness.engine.markExternalSubmitted(first.requestId, "different_external_task"))
      .toThrow(/already bound/u);
    expect(harness.engine.findByTask("duplicate_external_task", "different_beacon")).toBeUndefined();
    await expect(harness.engine.reconcileTask({
      taskId: "duplicate_external_task",
      beaconId: "different_beacon",
      state: "completed",
    })).resolves.toBeUndefined();
    expect(harness.engine.get(first.requestId)).toMatchObject({ state: "running" });

    const globalClaims = new Map<string, string>();
    const claimExternalTask: OperationEngineHost["claimExternalTask"] = (taskId, requestId) => {
      const existing = globalClaims.get(taskId);
      if (existing && existing !== requestId) return false;
      globalClaims.set(taskId, requestId);
      return true;
    };
    const windowOne = createHarness("beacon", {
      ids: ["window_one_external"],
      ownerWindowId: 11,
      claimExternalTask,
    });
    const windowTwo = createHarness("beacon", {
      ids: ["window_two_external"],
      ownerWindowId: 22,
      claimExternalTask,
    });
    const windowOneRecord = windowOne.engine.beginExternal(
      "execution.process",
      windowOne.active,
      externalBeaconDescriptor(),
    );
    const windowTwoRecord = windowTwo.engine.beginExternal(
      "execution.process",
      windowTwo.active,
      externalBeaconDescriptor(),
    );
    windowOne.engine.markExternalSubmitted(windowOneRecord.requestId, "global_external_task");
    expect(() => windowTwo.engine.markExternalSubmitted(windowTwoRecord.requestId, "global_external_task"))
      .toThrow(/already claimed/u);
    expect(windowOne.engine.findByTask("global_external_task", windowOne.active.ref.id)?.requestId)
      .toBe(windowOneRecord.requestId);
    expect(windowTwo.engine.findByTask("global_external_task", windowTwo.active.ref.id)).toBeUndefined();
  });

  it("cancels a pending external beacon task once without replaying the reviewed operation", async () => {
    const harness = createHarness("beacon", { ids: ["external_cancel_request"] });
    const record = harness.engine.beginExternal(
      "execution.process",
      harness.active,
      externalBeaconDescriptor(),
    );
    harness.engine.markExternalSubmitted(record.requestId);
    const cancellation = harness.engine.cancel(record.requestId);
    await expect(cancellation).resolves.toMatchObject({
      state: "cancel-requested",
    });
    harness.engine.markExternalSubmitted(record.requestId, "external_cancel_task");
    await vi.waitFor(() => expect(harness.cancelTask).toHaveBeenCalledOnce());
    expect(harness.cancelTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: harness.active.ref.id, mode: "beacon" }),
      "external_cancel_task",
    );
    await expect(harness.engine.reconcileTask({
      taskId: "external_cancel_task",
      beaconId: harness.active.ref.id,
      state: "canceled",
    })).resolves.toMatchObject({
      state: "canceled",
      message: "Reviewed execution canceled.",
    });
    await harness.engine.cancel(record.requestId);
    expect(harness.cancelTask).toHaveBeenCalledOnce();
  });

  it.each([
    ["failed" as const, "Reviewed execution failed."],
    ["canceled" as const, "Reviewed execution canceled."],
  ])("uses fixed external journal text for a %s beacon task", async (state, expectedMessage) => {
    const harness = createHarness("beacon", { ids: [`external_${state}_request`] });
    const record = harness.engine.beginExternal(
      "execution.shellcode",
      harness.active,
      externalBeaconDescriptor(),
    );
    harness.engine.markExternalSubmitted(record.requestId, `external_${state}_task`);
    await expect(harness.engine.reconcileTask({
      taskId: `external_${state}_task`,
      beaconId: harness.active.ref.id,
      state: "sent",
      error: "REMOTE_SENT_SECRET",
    })).resolves.toMatchObject({ state: "running", message: "The beacon task is awaiting completion" });
    const terminal = await harness.engine.reconcileTask({
      taskId: `external_${state}_task`,
      beaconId: harness.active.ref.id,
      state,
      error: "REMOTE_TERMINAL_SECRET",
    });
    expect(terminal).toMatchObject({ state, message: expectedMessage });
    expect(JSON.stringify(terminal)).not.toContain("REMOTE_");
  });

  it("expires, prunes, and closes external task indexes conservatively", () => {
    const expiring = createHarness("beacon", {
      ids: ["expiring_external"],
      recoverableTaskTtlMilliseconds: 1_000,
    });
    const record = expiring.engine.beginExternal(
      "execution.children",
      expiring.active,
      externalBeaconDescriptor({ outcomeUnknownAfterSubmission: false, taskTimeoutSeconds: 2 }),
    );
    expiring.engine.markExternalSubmitted(record.requestId, "expiring_external_task");
    expiring.advance(2_001);
    expect(expiring.engine.expireOverdueTasks()).toBe(1);
    expect(expiring.engine.findByTask("expiring_external_task", expiring.active.ref.id)).toMatchObject({
      state: "outcome-unknown",
    });
    expiring.advance(1_001);
    expect(expiring.engine.list().items).toHaveLength(0);
    expect(expiring.engine.findByTask("expiring_external_task", expiring.active.ref.id)).toBeUndefined();
    expect(expiring.settleTaskClaim).toHaveBeenCalledWith("expiring_external_task", record.requestId);

    const closing = createHarness("beacon", { ids: ["closing_external"] });
    const closingRecord = closing.engine.beginExternal(
      "execution.process",
      closing.active,
      externalBeaconDescriptor(),
    );
    closing.engine.markExternalSubmitted(closingRecord.requestId, "closing_external_task");
    closing.engine.close();
    expect(closing.engine.get(closingRecord.requestId)).toMatchObject({ state: "outcome-unknown" });
    expect(closing.engine.findByTask("closing_external_task", closing.active.ref.id)).toBeUndefined();
    expect(closing.settleTaskClaim).toHaveBeenCalledWith("closing_external_task", closingRecord.requestId);
  });

  it("orders mixed activity deterministically and keeps cursor pages stable across insertion", async () => {
    const harness = createHarness("session", {
      freezeClock: true,
      ids: ["external_old", "managed_middle", "external_new", "inserted_later"],
    });
    const oldest = harness.engine.beginExternal("session.filesystem.ls", harness.active);
    harness.engine.finishExternal(oldest.requestId, "completed");
    const managed = await harness.engine.submit({ operationId: "target.ping" });
    const newest = harness.engine.beginExternal("session.process.list", harness.active);
    harness.engine.finishExternal(newest.requestId, "completed");

    const firstPage = harness.engine.list({ limit: 2 });
    expect(firstPage.items.map(({ requestId }) => requestId)).toEqual([newest.requestId, managed.requestId]);
    expect(firstPage.page).toMatchObject({ total: 3, truncated: true, nextCursor: expect.any(String) });
    const cursor = firstPage.page.nextCursor;
    if (!cursor) throw new Error("Expected a cursor for the truncated first page");

    const inserted = harness.engine.beginExternal("session.service.list", harness.active);
    harness.engine.finishExternal(inserted.requestId, "completed");
    const secondPage = harness.engine.list({ limit: 2, cursor });
    expect(secondPage.items.map(({ requestId }) => requestId)).toEqual([oldest.requestId]);
    expect(secondPage.page).toMatchObject({ total: 4, truncated: false });
  });

  it("applies one terminal cap across managed and external records", async () => {
    const harness = createHarness("session", {
      freezeClock: true,
      terminalRecordLimit: 2,
      ids: ["external_1", "managed_1", "external_2", "managed_2"],
    });
    const externalOne = harness.engine.beginExternal("session.filesystem.ls", harness.active);
    harness.engine.finishExternal(externalOne.requestId, "completed");
    const managedOne = await harness.engine.submit({ operationId: "target.ping" });
    const externalTwo = harness.engine.beginExternal("session.process.list", harness.active);
    harness.engine.finishExternal(externalTwo.requestId, "completed");
    const managedTwo = await harness.engine.submit({ operationId: "target.ping" });

    expect(harness.engine.list().items.map(({ requestId }) => requestId))
      .toEqual([managedTwo.requestId, externalTwo.requestId]);
    expect(harness.engine.list().page.total).toBe(2);
    expect(harness.engine.get(externalOne.requestId)).toBeUndefined();
    expect(harness.engine.get(managedOne.requestId)).toBeUndefined();
  });

  it("shares duplicate-ID and active-operation guards across managed and external records", async () => {
    const duplicate = createHarness("session", { ids: ["same_request", "same_request"] });
    duplicate.engine.beginExternal("session.filesystem.ls", duplicate.active);
    await expect(duplicate.engine.submit({ operationId: "target.ping" })).rejects.toThrow(
      /Duplicate operation request ID/u,
    );
    expect(duplicate.client.pingSession).not.toHaveBeenCalled();

    const reverse = createHarness("session", { ids: ["same_reverse", "same_reverse"] });
    await reverse.engine.submit({ operationId: "target.ping" });
    expect(() => reverse.engine.beginExternal("session.filesystem.ls", reverse.active))
      .toThrow(/Duplicate operation request ID/u);

    const bounded = createHarness("session", { activeOperationLimit: 2 });
    bounded.engine.beginExternal("session.filesystem.ls", bounded.active);
    bounded.engine.beginExternal("session.process.list", bounded.active);
    await expect(bounded.engine.submit({ operationId: "target.ping" })).rejects.toThrow(
      /already has 2 active operations/u,
    );
  });

  it("denies cancellation without mutating or re-emitting active external records", async () => {
    const changes: TargetOperationRecord[] = [];
    const harness = createHarness("session", { onChanged: (record) => changes.push(structuredClone(record)) });
    const external = harness.engine.beginExternal("session.filesystem.mkdir", harness.active);

    await expect(harness.engine.cancel(external.requestId)).rejects.toThrow(/cannot be canceled/u);
    expect(harness.engine.get(external.requestId)).toMatchObject({ state: "submitting", attempts: 0 });
    expect(changes).toHaveLength(1);

    harness.engine.finishExternal(external.requestId, "canceled");
    await expect(harness.engine.cancel(external.requestId)).resolves.toMatchObject({ state: "canceled" });
    expect(changes.map(({ state }) => state)).toEqual(["submitting", "canceled"]);
  });

  it("runs bounded synchronous session reads and mutations without retaining inputs", async () => {
    const harness = createHarness("session");

    const ping = await harness.engine.submit({ operationId: "target.ping" });
    expect(ping).toMatchObject({
      operationId: "target.ping",
      mode: "session",
      state: "completed",
      attempts: 1,
      progress: { completedUnits: 3, totalUnits: 3, message: "Operation completed" },
      disposition: {
        kind: "structured-detail",
        fields: [{ label: "Nonce", value: expect.any(Number) }],
      },
    });
    expect(harness.client.pingSession).toHaveBeenCalledWith(
      harness.active.ref.id,
      expect.any(Number),
      30,
    );

    const secret = "do-not-retain-this-value";
    const mutation = await harness.engine.submit({
      operationId: "target.env-set",
      name: "M1_ENGINE_TEST",
      value: secret,
    });
    expect(mutation).toMatchObject({ state: "completed", attempts: 1 });
    expect(harness.client.setEnvSession).toHaveBeenCalledWith(
      harness.active.ref.id,
      "M1_ENGINE_TEST",
      secret,
      30,
    );
    expect(JSON.stringify(harness.engine.list())).not.toContain(secret);
    expect(harness.refreshTargets).not.toHaveBeenCalled();
    expect(harness.client.getEnvSession).toHaveBeenCalledWith(harness.active.ref.id, "", 30);
  });

  it("reconciles empty environment values and unsets against the full session environment", async () => {
    const harness = createHarness("session");
    await expect(harness.engine.submit({
      operationId: "target.env-set",
      name: "EMPTY_VALUE",
      value: "",
    })).resolves.toMatchObject({ state: "completed" });
    await expect(harness.engine.submit({
      operationId: "target.env-unset",
      name: "EMPTY_VALUE",
    })).resolves.toMatchObject({ state: "completed" });
    expect(harness.client.getEnvSession).toHaveBeenNthCalledWith(1, harness.active.ref.id, "", 30);
    expect(harness.client.getEnvSession).toHaveBeenNthCalledWith(2, harness.active.ref.id, "", 30);
  });

  it("checks implant response errors and does not expose mutation error contents", async () => {
    const harness = createHarness("session");
    harness.client.setEnvSession.mockResolvedValueOnce({
      Response: { Err: "failure mentioning do-not-show", Async: false, BeaconID: "", TaskID: "" },
    });

    const record = await harness.engine.submit({
      operationId: "target.env-set",
      name: "KEY",
      value: "do-not-show",
    });

    expect(record).toMatchObject({ state: "failed", message: "The target rejected the operation" });
    expect(JSON.stringify(record)).not.toContain("do-not-show");
  });

  it.each(["session", "beacon"] as const)("renames a %s synchronously and refreshes targets", async (mode) => {
    const harness = createHarness(mode);

    const record = await harness.engine.submit({ operationId: "target.rename", name: "renamed-target" });

    expect(record).toMatchObject({ state: "completed", mode, attempts: 1 });
    expect(record.taskId).toBeUndefined();
    const method = mode === "session" ? harness.client.renameSession : harness.client.renameBeacon;
    expect(method).toHaveBeenCalledWith(harness.active.ref.id, "renamed-target", 30);
    expect(harness.refreshTargets).toHaveBeenCalledOnce();
  });

  const asyncCases: Array<[TargetOperationInput, OperationClientMethod, number]> = [
    [{ operationId: "target.ping" }, "pingBeacon", 30],
    [{ operationId: "target.env-set", name: "KEY", value: "VALUE" }, "setEnvBeacon", 30],
    [{ operationId: "target.env-unset", name: "KEY" }, "unsetEnvBeacon", 30],
    [{ operationId: "beacon.reconfigure", intervalSeconds: 5, jitterSeconds: 1 }, "reconfigureBeacon", 60],
    [{ operationId: "beacon.open-session", delaySeconds: 2 }, "openSessionFromBeacon", 60],
    [{ operationId: "beacon.filesystem.pwd" }, "pwdBeacon", 30],
    [{ operationId: "beacon.filesystem.ls", path: "/tmp" }, "lsBeacon", 60],
    [{ operationId: "beacon.process.list", fullInfo: true }, "psBeacon", 60],
    [{ operationId: "beacon.network.interfaces" }, "ifconfigBeacon", 30],
    [{ operationId: "beacon.environment.list" }, "envBeacon", 30],
    [{ operationId: "beacon.network.netstat", tcp: true, udp: false, ip4: true, ip6: false, listen: true }, "netstatBeacon", 60],
    [{ operationId: "beacon.filesystem.mount" }, "mountBeacon", 30],
    [{ operationId: "beacon.filesystem.cat", path: "/tmp/readme.txt" }, "catBeacon", 60],
    [{ operationId: "beacon.filesystem.head", path: "/tmp/readme.txt", lines: 8 }, "headBeacon", 60],
    [{ operationId: "beacon.filesystem.tail", path: "/tmp/readme.txt", bytes: 512 }, "tailBeacon", 60],
    [{ operationId: "beacon.filesystem.grep", path: "/tmp", pattern: "needle", recursive: true, before: 2, after: 3 }, "grepBeacon", 60],
  ];

  it.each(asyncCases)("correlates an exact async task ID for %s", async (input, method, timeout) => {
    const harness = createHarness("beacon");
    const taskId = `task_${method}`;
    harness.client[method].mockResolvedValueOnce(asyncResponse(taskId));

    const record = await harness.engine.submit(input);

    expect(record).toMatchObject({ state: "submitted", taskId, attempts: 1 });
    expect(harness.engine.findByTask(taskId, harness.active.ref.id)?.requestId).toBe(record.requestId);
    expect(harness.engine.requiresTaskResultVerification(taskId, harness.active.ref.id)).toBe(true);
    expect(harness.client[method].mock.calls[0]?.at(-1)).toBe(timeout);
    expect(harness.refreshTargets).toHaveBeenCalled();
  });

  it("dispatches only the compiled beacon read arguments", async () => {
    const harness = createHarness("beacon");

    await harness.engine.submit({ operationId: "beacon.filesystem.pwd" });
    await harness.engine.submit({ operationId: "beacon.filesystem.ls", path: "/var/tmp" });
    await harness.engine.submit({ operationId: "beacon.process.list", fullInfo: true });
    await harness.engine.submit({ operationId: "beacon.network.interfaces" });

    expect(harness.client.pwdBeacon).toHaveBeenCalledWith(harness.active.ref.id, 30);
    expect(harness.client.lsBeacon).toHaveBeenCalledWith(harness.active.ref.id, "/var/tmp", 60);
    expect(harness.client.psBeacon).toHaveBeenCalledWith(harness.active.ref.id, true, 60);
    expect(harness.client.ifconfigBeacon).toHaveBeenCalledWith(harness.active.ref.id, 30);
  });

  it("dispatches BC-05 read options only through named client methods", async () => {
    const harness = createHarness("beacon");
    const targetId = harness.active.ref.id;

    await harness.engine.submit({ operationId: "beacon.environment.list", name: "HOME" });
    await harness.engine.submit({ operationId: "beacon.network.netstat", tcp: true, udp: false, ip4: true, ip6: false, listen: true });
    await harness.engine.submit({ operationId: "beacon.filesystem.mount" });
    await harness.engine.submit({ operationId: "beacon.filesystem.cat", path: "/tmp/readme.txt" });
    await harness.engine.submit({ operationId: "beacon.filesystem.head", path: "/tmp/readme.txt", lines: 8 });
    await harness.engine.submit({ operationId: "beacon.filesystem.tail", path: "/tmp/readme.txt", bytes: 512 });
    await harness.engine.submit({
      operationId: "beacon.filesystem.grep", path: "/tmp", pattern: "needle", recursive: true, before: 2, after: 3,
    });

    expect(harness.client.envBeacon).toHaveBeenCalledWith(targetId, "HOME", 30);
    expect(harness.client.netstatBeacon).toHaveBeenCalledWith(targetId, {
      tcp: true, udp: false, ip4: true, ip6: false, listen: true,
    }, 60);
    expect(harness.client.mountBeacon).toHaveBeenCalledWith(targetId, 30);
    expect(harness.client.catBeacon).toHaveBeenCalledWith(targetId, "/tmp/readme.txt", 60);
    expect(harness.client.headBeacon).toHaveBeenCalledWith(targetId, "/tmp/readme.txt", { lines: 8 }, 60);
    expect(harness.client.tailBeacon).toHaveBeenCalledWith(targetId, "/tmp/readme.txt", { bytes: 512 }, 60);
    expect(harness.client.grepBeacon).toHaveBeenCalledWith(targetId, {
      path: "/tmp", pattern: "needle", recursive: true, before: 2, after: 3,
    }, 60);
  });

  it("gates BC-05 platform reads before client dispatch", async () => {
    const harness = createHarness("beacon");
    await harness.engine.submit({ operationId: "beacon.filesystem.memfiles" });
    await harness.engine.submit({ operationId: "beacon.identity.whoami" });
    expect(harness.client.memfilesBeacon).not.toHaveBeenCalled();
    expect(harness.client.whoamiBeacon).not.toHaveBeenCalled();

    harness.active.summary.os = "linux";
    await expect(harness.engine.submit({ operationId: "beacon.filesystem.memfiles" }))
      .resolves.toMatchObject({ state: "submitted" });
    expect(harness.client.memfilesBeacon).toHaveBeenCalledWith(harness.active.ref.id, 30);

    harness.active.summary.os = "windows";
    harness.client.whoamiBeacon.mockResolvedValueOnce(asyncResponse("windows_whoami_task"));
    await expect(harness.engine.submit({ operationId: "beacon.identity.whoami" }))
      .resolves.toMatchObject({ state: "submitted" });
    expect(harness.client.whoamiBeacon).toHaveBeenCalledWith(harness.active.ref.id, 30);
  });

  it("rejects a directory-list acknowledgement for a different beacon", async () => {
    const harness = createHarness("beacon");
    harness.client.lsBeacon.mockResolvedValueOnce({
      Response: { Err: "", Async: true, BeaconID: "another_beacon", TaskID: "cross_routed_ls" },
    });

    const record = await harness.engine.submit({ operationId: "beacon.filesystem.ls", path: "/tmp" });

    expect(record).toMatchObject({ state: "outcome-unknown" });
    expect(record.taskId).toBeUndefined();
    expect(harness.engine.findByTask("cross_routed_ls", harness.active.ref.id)).toBeUndefined();
    expect(harness.client.lsBeacon).toHaveBeenCalledOnce();
  });

  it("converts seconds to nanoseconds for compiled beacon operations", async () => {
    const harness = createHarness("beacon");

    await harness.engine.submit({
      operationId: "beacon.reconfigure",
      reconnectIntervalSeconds: 7,
      intervalSeconds: 5,
      jitterSeconds: 1,
    });
    expect(harness.client.reconfigureBeacon).toHaveBeenCalledWith(
      harness.active.ref.id,
      {
        reconnectIntervalNanoseconds: "7000000000",
        intervalNanoseconds: "5000000000",
        jitterNanoseconds: "1000000000",
      },
      60,
    );

    await harness.engine.submit({
      operationId: "beacon.open-session",
      delaySeconds: 2,
    });
    expect(harness.client.openSessionFromBeacon).toHaveBeenCalledWith(
      harness.active.ref.id,
      [harness.active.authoritativeActiveC2],
      "2000000000",
      60,
    );
    expect(JSON.stringify(harness.engine.list())).not.toContain("main-only");
  });

  it("derives open-session C2 only from the main-owned target and rejects a missing endpoint", async () => {
    const harness = createHarness("beacon");
    await harness.engine.submit({ operationId: "beacon.open-session", delaySeconds: 0 });
    expect(harness.client.openSessionFromBeacon).toHaveBeenCalledWith(
      harness.active.ref.id,
      [harness.active.authoritativeActiveC2],
      "0",
      60,
    );

    const missing = createHarness("beacon");
    delete missing.active.authoritativeActiveC2;
    const result = await missing.engine.submit({ operationId: "beacon.open-session", delaySeconds: 0 });
    expect(result).toMatchObject({ state: "failed" });
    expect(missing.client.openSessionFromBeacon).not.toHaveBeenCalled();
  });

  it("uses a main-owned implant WireGuard endpoint for open-session", async () => {
    const harness = createHarness("beacon");
    harness.active.summary.transport = "wg";
    harness.active.authoritativeActiveC2 = "wg://127.0.0.1:51820/private?token=main-only";

    const record = await harness.engine.submit({ operationId: "beacon.open-session", delaySeconds: 1 });

    expect(record).toMatchObject({ state: "submitted" });
    expect(harness.client.openSessionFromBeacon).toHaveBeenCalledWith(
      harness.active.ref.id,
      [harness.active.authoritativeActiveC2],
      "1000000000",
      60,
    );
    expect(JSON.stringify(record)).not.toContain("main-only");
  });

  it("validates authoritative session-conversion endpoints without exposing them", () => {
    const target = resolvedTarget("beacon");
    expect(isAuthoritativeActiveC2Usable({ summary: target.summary })).toBe(false);
    expect(isAuthoritativeActiveC2Usable({
      summary: target.summary,
      authoritativeActiveC2: "ftp://c2.example.test/file",
    })).toBe(false);
    expect(isAuthoritativeActiveC2Usable({
      summary: target.summary,
      authoritativeActiveC2: "mtls://c2.example.test:8888/private?main-only=true",
    })).toBe(true);
  });

  it("requires the exact ping nonce for synchronous and correlated beacon results", async () => {
    const session = createHarness("session");
    session.client.pingSession.mockResolvedValue(syncPing(-1));
    const mismatched = await session.engine.submit({ operationId: "target.ping" });
    expect(mismatched).toMatchObject({ state: "failed", attempts: 2 });

    const beacon = createHarness("beacon");
    const queued = await beacon.engine.submit({ operationId: "target.ping" });
    const dispatchedNonce = beacon.client.pingBeacon.mock.calls[0]?.[1];
    expect(dispatchedNonce).toEqual(expect.any(Number));
    expect(beacon.engine.expectedPingNonceForTask(queued.taskId!, beacon.active.ref.id)).toBe(dispatchedNonce);
  });

  it("never infers a task ID and rejects duplicate server task correlation", async () => {
    const harness = createHarness("beacon");
    harness.client.pingBeacon.mockResolvedValueOnce({
      Nonce: 1,
      Response: { Err: "", Async: true, BeaconID: harness.active.ref.id, TaskID: "" },
    });
    const missing = await harness.engine.submit({ operationId: "target.ping" });
    expect(missing).toMatchObject({ state: "outcome-unknown" });
    expect(missing.taskId).toBeUndefined();
    expect(harness.engine.findByTask("", harness.active.ref.id)).toBeUndefined();

    harness.client.pingBeacon.mockResolvedValue(asyncResponse("same_task"));
    const first = await harness.engine.submit({ operationId: "target.ping" });
    const duplicate = await harness.engine.submit({ operationId: "target.ping" });
    expect(first).toMatchObject({ state: "submitted", taskId: "same_task" });
    expect(duplicate).toMatchObject({ state: "outcome-unknown", message: expect.stringMatching(/duplicate/u) });
    expect(harness.engine.findByTask("same_task", harness.active.ref.id)?.requestId).toBe(first.requestId);
  });

  it.each([
    [false, "beacon_1"],
    [true, ""],
    [true, "another_beacon"],
  ] as const)(
    "rejects incomplete async task correlation (async=%s, beacon=%s)",
    async (async, beaconId) => {
      const harness = createHarness("beacon");
      harness.client.pingBeacon.mockResolvedValueOnce({
        Nonce: 1,
        Response: { Err: "", Async: async, BeaconID: beaconId, TaskID: "plausible_task" },
      });

      const record = await harness.engine.submit({ operationId: "target.ping" });

      expect(record).toMatchObject({ state: "outcome-unknown" });
      expect(record.taskId).toBeUndefined();
      expect(harness.engine.findByTask("plausible_task", harness.active.ref.id)).toBeUndefined();
      expect(harness.client.pingBeacon).toHaveBeenCalledOnce();
    },
  );

  it("rejects a repeated main-owned request ID before a second dispatch", async () => {
    const harness = createHarness("session", { ids: ["fixed_id", "fixed_id"] });
    await harness.engine.submit({ operationId: "target.ping" });

    await expect(harness.engine.submit({ operationId: "target.ping" })).rejects.toThrow(
      /Duplicate operation request ID/u,
    );
    expect(harness.client.pingSession).toHaveBeenCalledOnce();
  });

  it.each(["session", "beacon"] as const)(
    "rejects a repeated main-owned request ID before a second %s mutation dispatch",
    async (mode) => {
      const harness = createHarness(mode, { ids: ["fixed_mutation", "fixed_mutation"] });
      const input = { operationId: "target.env-set", name: "M1_DUPLICATE", value: "one" } as const;
      await harness.engine.submit(input);

      await expect(harness.engine.submit({ ...input, value: "two" })).rejects.toThrow(
        /Duplicate operation request ID/u,
      );
      const mutation = mode === "session" ? harness.client.setEnvSession : harness.client.setEnvBeacon;
      expect(mutation).toHaveBeenCalledOnce();
    },
  );

  it("retries only ping once after transport failure", async () => {
    const pingHarness = createHarness("session");
    pingHarness.client.pingSession
      .mockRejectedValueOnce(new Error("temporary transport error"))
      .mockImplementationOnce(async (_targetId: string, nonce: number) => syncPing(nonce));
    const ping = await pingHarness.engine.submit({ operationId: "target.ping" });
    expect(ping).toMatchObject({ state: "completed", attempts: 2 });
    expect(pingHarness.client.pingSession).toHaveBeenCalledTimes(2);
    expect(pingHarness.assertTarget).toHaveBeenCalledTimes(2);

    const mutationHarness = createHarness("session");
    mutationHarness.client.setEnvSession.mockRejectedValue(new Error("deadline exceeded: SECRET"));
    const mutation = await mutationHarness.engine.submit({
      operationId: "target.env-set",
      name: "KEY",
      value: "SECRET",
    });
    expect(mutation).toMatchObject({
      state: "outcome-unknown",
      attempts: 1,
      message: "The request was dispatched, but its outcome is unknown",
    });
    expect(mutationHarness.client.setEnvSession).toHaveBeenCalledOnce();
    expect(JSON.stringify(mutation)).not.toContain("SECRET");

    const beaconHarness = createHarness("beacon");
    beaconHarness.client.pingBeacon.mockRejectedValue(new Error("response lost after possible enqueue"));
    const beaconRead = await beaconHarness.engine.submit({ operationId: "target.ping" });
    expect(beaconRead).toMatchObject({ state: "outcome-unknown", attempts: 1 });
    expect(beaconHarness.client.pingBeacon).toHaveBeenCalledOnce();
  });

  it("reconciles committed session mutations after a lost response without replaying them", async () => {
    const setHarness = createHarness("session");
    const setImplementation = setHarness.client.setEnvSession.getMockImplementation() as (
      targetId: string,
      name: string,
      value: string,
      timeout: number,
    ) => Promise<unknown>;
    setHarness.client.setEnvSession.mockImplementationOnce(async (...args: [string, string, string, number]) => {
      await setImplementation(...args);
      throw new Error("response lost after commit");
    });
    await expect(setHarness.engine.submit({
      operationId: "target.env-set",
      name: "RECONCILED",
      value: "present",
    })).resolves.toMatchObject({ state: "completed", attempts: 1 });
    expect(setHarness.client.setEnvSession).toHaveBeenCalledOnce();

    const unsetImplementation = setHarness.client.unsetEnvSession.getMockImplementation() as (
      targetId: string,
      name: string,
      timeout: number,
    ) => Promise<unknown>;
    setHarness.client.unsetEnvSession.mockImplementationOnce(async (...args: [string, string, number]) => {
      await unsetImplementation(...args);
      throw new Error("response lost after unset");
    });
    await expect(setHarness.engine.submit({
      operationId: "target.env-unset",
      name: "RECONCILED",
    })).resolves.toMatchObject({ state: "completed", attempts: 1 });
    expect(setHarness.client.unsetEnvSession).toHaveBeenCalledOnce();

    const renameHarness = createHarness("session");
    renameHarness.client.renameSession.mockImplementationOnce(async () => {
      renameHarness.active.summary.name = "reconciled-name";
      throw new Error("response lost after rename");
    });
    await expect(renameHarness.engine.submit({
      operationId: "target.rename",
      name: "reconciled-name",
    })).resolves.toMatchObject({ state: "completed", attempts: 1 });
    expect(renameHarness.client.renameSession).toHaveBeenCalledOnce();
    expect(renameHarness.refreshTargets).toHaveBeenCalledOnce();
  });

  it("reconciles Windows environment names case-insensitively and fails closed on ambiguity", async () => {
    const setHarness = createHarness("session");
    setHarness.active.summary.os = "windows";
    setHarness.client.getEnvSession.mockResolvedValue({
      Variables: [{ Key: "Path", Value: "expected" }],
      Response: emptyResponse(),
    });
    await expect(setHarness.engine.submit({
      operationId: "target.env-set",
      name: "PATH",
      value: "expected",
    })).resolves.toMatchObject({ state: "completed" });

    const unsetHarness = createHarness("session");
    unsetHarness.active.summary.os = "windows";
    unsetHarness.client.getEnvSession.mockResolvedValue({
      Variables: [{ Key: "Path", Value: "still-present" }],
      Response: emptyResponse(),
    });
    await expect(unsetHarness.engine.submit({
      operationId: "target.env-unset",
      name: "PATH",
    })).resolves.toMatchObject({ state: "partial" });

    const ambiguousHarness = createHarness("session");
    ambiguousHarness.active.summary.os = "windows";
    ambiguousHarness.client.getEnvSession.mockResolvedValue({
      Variables: [
        { Key: "Path", Value: "expected" },
        { Key: "PATH", Value: "expected" },
      ],
      Response: emptyResponse(),
    });
    await expect(ambiguousHarness.engine.submit({
      operationId: "target.env-set",
      name: "PATH",
      value: "expected",
    })).resolves.toMatchObject({ state: "partial" });
  });

  it("never proves an environment mutation against a reused target ID", async () => {
    const harness = createHarness("session");
    const replacement = resolvedTarget("session");
    replacement.ref = { ...replacement.ref, fingerprint: "replacement-fingerprint" };
    harness.assertTarget
      .mockResolvedValueOnce(harness.active)
      .mockResolvedValueOnce(replacement);
    harness.client.getEnvSession.mockResolvedValue({
      Variables: [{ Key: "BOUND_KEY", Value: "expected" }],
      Response: emptyResponse(),
    });

    await expect(harness.engine.submit({
      operationId: "target.env-set",
      name: "BOUND_KEY",
      value: "expected",
    })).resolves.toMatchObject({ state: "partial" });
    expect(harness.client.getEnvSession).not.toHaveBeenCalled();
  });

  it("marks a target disappearance before dispatch and rechecks capability", async () => {
    const missingHarness = createHarness("session");
    missingHarness.assertTarget.mockRejectedValueOnce(new Error("target vanished"));
    const missing = await missingHarness.engine.submit({ operationId: "target.ping" });
    expect(missing).toMatchObject({ state: "target-disappeared", attempts: 0 });
    expect(missingHarness.client.pingSession).not.toHaveBeenCalled();

    const capabilityHarness = createHarness("session");
    capabilityHarness.capability
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const gated = await capabilityHarness.engine.submit({ operationId: "target.ping" });
    expect(gated).toMatchObject({ state: "failed", attempts: 0 });
    expect(capabilityHarness.capability).toHaveBeenCalledTimes(2);
    expect(capabilityHarness.client.pingSession).not.toHaveBeenCalled();
  });

  it("cancels locally before submission without issuing an adapter request", async () => {
    const capabilityGate = deferred<boolean>();
    const harness = createHarness("session", { ids: ["queued_request"] });
    harness.capability.mockImplementationOnce(async () => capabilityGate.promise);

    const submission = harness.engine.submit({ operationId: "target.ping" });
    await waitForRecord(harness.engine, "queued_request");
    const canceled = await harness.engine.cancel("queued_request");
    expect(canceled).toMatchObject({ state: "canceled", attempts: 0 });

    capabilityGate.resolve(true);
    await expect(submission).resolves.toMatchObject({ state: "canceled" });
    expect(harness.client.pingSession).not.toHaveBeenCalled();
  });

  it("requests best-effort beacon cancellation and lets authoritative task state win races", async () => {
    const harness = createHarness("beacon");
    const submitted = await harness.engine.submit({ operationId: "target.ping" });

    const requested = await harness.engine.cancel(submitted.requestId);
    expect(requested).toMatchObject({ state: "cancel-requested" });
    expect(harness.cancelTask).toHaveBeenCalledWith(submitted.target, submitted.taskId);

    await expect(harness.engine.reconcileTask({ taskId: submitted.taskId!, beaconId: harness.active.ref.id, state: "sent" }))
      .resolves.toMatchObject({ state: "running" });
    await expect(harness.engine.reconcileTask({ taskId: submitted.taskId!, beaconId: harness.active.ref.id, state: "canceled" }))
      .resolves.toMatchObject({ state: "canceled" });
  });

  it("single-flights concurrent cancellation requests for one correlated operation", async () => {
    const gate = deferred<undefined>();
    const harness = createHarness("beacon");
    harness.cancelTask.mockImplementationOnce(async () => gate.promise);
    const submitted = await harness.engine.submit({
      operationId: "target.env-set",
      name: "M1_CANCEL_ONCE",
      value: "value",
    });

    const first = harness.engine.cancel(submitted.requestId);
    const second = harness.engine.cancel(submitted.requestId);
    await vi.waitFor(() => expect(harness.cancelTask).toHaveBeenCalledOnce());
    gate.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { state: "cancel-requested", taskId: submitted.taskId },
      { state: "cancel-requested", taskId: submitted.taskId },
    ]);
    expect(harness.cancelTask).toHaveBeenCalledOnce();
  });

  it("allows an explicit cancellation retry only after a proven pre-dispatch failure", async () => {
    const harness = createHarness("beacon");
    harness.cancelTask
      .mockRejectedValueOnce(new TaskCancellationDispatchError("preflight failed", false))
      .mockResolvedValueOnce(undefined);
    const submitted = await harness.engine.submit({ operationId: "target.ping" });

    await expect(harness.engine.cancel(submitted.requestId)).rejects.toThrow(/preflight failed/u);
    await expect(harness.engine.cancel(submitted.requestId)).resolves.toMatchObject({
      state: "cancel-requested",
      taskId: submitted.taskId,
    });
    expect(harness.cancelTask).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite an authoritative sent race with cancel-requested", async () => {
    const harness = createHarness("beacon");
    const submitted = await harness.engine.submit({ operationId: "target.ping" });
    harness.cancelTask.mockImplementationOnce(async () => {
      await harness.engine.reconcileTask({
        taskId: submitted.taskId!,
        beaconId: submitted.target.id,
        state: "sent",
      });
    });

    await expect(harness.engine.cancel(submitted.requestId)).resolves.toMatchObject({ state: "running" });
    expect(harness.cancelTask).toHaveBeenCalledOnce();
  });

  it("queues cancellation requested while the beacon submission is in flight", async () => {
    const responseGate = deferred<ReturnType<typeof asyncResponse>>();
    const harness = createHarness("beacon", { ids: ["inflight_request"] });
    harness.client.pingBeacon.mockImplementationOnce(async () => responseGate.promise);

    const submission = harness.engine.submit({ operationId: "target.ping" });
    await waitForState(harness.engine, "inflight_request", "submitting");
    const cancelPromise = harness.engine.cancel("inflight_request");
    responseGate.resolve(asyncResponse("inflight_task"));

    await expect(cancelPromise).resolves.toMatchObject({ state: "cancel-requested" });
    await expect(submission).resolves.toMatchObject({
      state: "cancel-requested",
      taskId: "inflight_task",
    });
    expect(harness.cancelTask).toHaveBeenCalledWith(expect.any(Object), "inflight_task");
  });

  it("does not retry the original beacon read when a queued cancellation fails", async () => {
    const responseGate = deferred<ReturnType<typeof asyncResponse>>();
    const harness = createHarness("beacon", { ids: ["cancel_failure"] });
    harness.client.pingBeacon.mockImplementationOnce(async () => responseGate.promise);
    harness.cancelTask.mockRejectedValueOnce(new Error("task already dispatched"));

    const submission = harness.engine.submit({ operationId: "target.ping" });
    await waitForState(harness.engine, "cancel_failure", "submitting");
    await harness.engine.cancel("cancel_failure");
    responseGate.resolve(asyncResponse("cancel_failure_task"));

    await expect(submission).resolves.toMatchObject({
      state: "cancel-requested",
      attempts: 1,
      taskId: "cancel_failure_task",
    });
    expect(harness.client.pingBeacon).toHaveBeenCalledOnce();
  });

  it("does not let late task results overwrite a terminal state", async () => {
    const harness = createHarness("beacon");
    const submitted = await harness.engine.submit({ operationId: "target.ping" });
    expect(harness.engine.markTargetUnavailable(submitted.target, "gone")).toBe(1);

    const late = await harness.engine.reconcileTask({
      taskId: submitted.taskId!,
      beaconId: harness.active.ref.id,
      state: "completed",
      disposition: pingDisposition(99),
    });
    expect(late).toMatchObject({ state: "target-disappeared" });
    expect(late?.disposition).toBeUndefined();
  });

  it("does not retry or attach a late response after target disappearance", async () => {
    const responseGate = deferred<ReturnType<typeof syncPing>>();
    const harness = createHarness("session", { ids: ["vanishing_request"] });
    harness.client.pingSession.mockImplementationOnce(async () => responseGate.promise);

    const submission = harness.engine.submit({ operationId: "target.ping" });
    await waitForState(harness.engine, "vanishing_request", "submitting");
    expect(harness.engine.markTargetUnavailable(harness.active.ref, "gone")).toBe(1);
    responseGate.resolve(syncPing(77));

    await expect(submission).resolves.toMatchObject({
      state: "target-disappeared",
      attempts: 1,
    });
    expect(harness.client.pingSession).toHaveBeenCalledOnce();
  });

  it("lets authoritative completion win a cancellation callback race", async () => {
    const cancellationGate = deferred<undefined>();
    const harness = createHarness("beacon");
    harness.cancelTask.mockImplementationOnce(async () => cancellationGate.promise);
    const submitted = await harness.engine.submit({ operationId: "target.ping" });

    const cancellation = harness.engine.cancel(submitted.requestId);
    await Promise.resolve();
    await harness.engine.reconcileTask({
      taskId: submitted.taskId!,
      beaconId: harness.active.ref.id,
      state: "completed",
      disposition: pingDisposition(55),
    });
    cancellationGate.resolve(undefined);

    await expect(cancellation).resolves.toMatchObject({ state: "completed" });
    expect(harness.engine.get(submitted.requestId)).toMatchObject({ state: "completed" });
  });

  it("resolves beacon mutation cancellation and completion callback races without replay", async () => {
    const completionFirst = createHarness("beacon");
    const completionGate = deferred<undefined>();
    completionFirst.cancelTask.mockImplementationOnce(async () => completionGate.promise);
    const completionSubmitted = await completionFirst.engine.submit({
      operationId: "target.env-set",
      name: "M1_RACE",
      value: "completed",
    });
    const cancellation = completionFirst.engine.cancel(completionSubmitted.requestId);
    await Promise.resolve();
    await completionFirst.engine.reconcileTask({
      taskId: completionSubmitted.taskId!,
      beaconId: completionFirst.active.ref.id,
      state: "completed",
      disposition: {
        kind: "structured-detail",
        title: "Environment update",
        fields: [{ label: "Status", value: "Applied" }],
        truncated: false,
      },
    });
    completionGate.resolve(undefined);
    await expect(cancellation).resolves.toMatchObject({ state: "completed" });
    expect(completionFirst.client.setEnvBeacon).toHaveBeenCalledOnce();

    const cancellationFirst = createHarness("beacon");
    const cancellationGate = deferred<undefined>();
    cancellationFirst.cancelTask.mockImplementationOnce(async () => cancellationGate.promise);
    const canceledSubmitted = await cancellationFirst.engine.submit({
      operationId: "target.env-set",
      name: "M1_RACE",
      value: "canceled",
    });
    const canceled = cancellationFirst.engine.cancel(canceledSubmitted.requestId);
    await Promise.resolve();
    await cancellationFirst.engine.reconcileTask({
      taskId: canceledSubmitted.taskId!,
      beaconId: cancellationFirst.active.ref.id,
      state: "canceled",
    });
    cancellationGate.resolve(undefined);
    await expect(canceled).resolves.toMatchObject({ state: "canceled" });
    await expect(cancellationFirst.engine.reconcileTask({
      taskId: canceledSubmitted.taskId!,
      beaconId: cancellationFirst.active.ref.id,
      state: "completed",
    })).resolves.toMatchObject({ state: "canceled" });
    expect(cancellationFirst.client.setEnvBeacon).toHaveBeenCalledOnce();
  });

  it("reconciles pending, completion, failure, and bounded decoded dispositions", async () => {
    const completedHarness = createHarness("beacon");
    const submitted = await completedHarness.engine.submit({ operationId: "beacon.reconfigure", intervalSeconds: 5 });
    await expect(completedHarness.engine.reconcileTask({ taskId: submitted.taskId!, beaconId: completedHarness.active.ref.id, state: "pending" }))
      .resolves.toMatchObject({ state: "running" });

    const oversizedDisposition: OperationDisposition = {
      kind: "structured-detail",
      title: "Result",
      fields: Array.from({ length: 80 }, (_, index) => ({ label: `Field ${index}`, value: "x" })),
      truncated: false,
    };
    const completed = await completedHarness.engine.reconcileTask({
      taskId: submitted.taskId!,
      beaconId: completedHarness.active.ref.id,
      state: "completed",
      disposition: oversizedDisposition,
    });
    expect(completed).toMatchObject({ state: "completed", disposition: { truncated: true } });
    expect(completed?.disposition?.kind === "structured-detail" && completed.disposition.fields).toHaveLength(64);
    expect(completedHarness.refreshTargets).toHaveBeenCalledTimes(2);

    const failedHarness = createHarness("beacon");
    const failedSubmission = await failedHarness.engine.submit({ operationId: "target.env-unset", name: "KEY" });
    await expect(failedHarness.engine.reconcileTask({
      taskId: failedSubmission.taskId!,
      beaconId: failedHarness.active.ref.id,
      state: "failed",
      error: "implant failed",
    })).resolves.toMatchObject({ state: "failed", message: "The beacon task failed" });
  });

  it("keeps history across navigation-like reads and bounds only terminal records", async () => {
    const harness = createHarness("beacon", {
      terminalRecordLimit: 2,
      ids: ["pending", "done_1", "done_2", "done_3"],
    });
    const pending = await harness.engine.submit({ operationId: "target.ping" });

    for (const requestId of ["done_1", "done_2", "done_3"]) {
      harness.client.renameBeacon.mockResolvedValueOnce({});
      const completed = await harness.engine.submit({ operationId: "target.rename", name: requestId });
      expect(completed.state).toBe("completed");
    }

    const firstNavigation = harness.engine.list({ limit: 2 });
    expect(firstNavigation.page.nextCursor).toBeDefined();
    const secondNavigation = harness.engine.list({ cursor: firstNavigation.page.nextCursor!, limit: 2 });
    expect([...firstNavigation.items, ...secondNavigation.items].map((item) => item.requestId).sort())
      .toEqual([pending.requestId, "done_2", "done_3"].sort());
    expect(harness.engine.get("done_1")).toBeUndefined();
    expect(harness.engine.get(pending.requestId)).toMatchObject({ state: "submitted" });
  });

  it("anchors operation cursors so a new record cannot shift or duplicate later pages", async () => {
    const harness = createHarness("session", {
      terminalRecordLimit: 10,
      ids: ["history_1", "history_2", "history_3", "new_history"],
    });
    for (const name of ["one", "two", "three"]) {
      await harness.engine.submit({ operationId: "target.rename", name });
    }
    const first = harness.engine.list({ limit: 2 });
    expect(first.items.map(({ requestId }) => requestId)).toEqual(["history_3", "history_2"]);

    await harness.engine.submit({ operationId: "target.rename", name: "new" });
    const second = harness.engine.list({ cursor: first.page.nextCursor!, limit: 2 });

    expect(second.items.map(({ requestId }) => requestId)).toEqual(["history_1"]);
    expect(new Set([...first.items, ...second.items].map(({ requestId }) => requestId)).size).toBe(3);
    expect(harness.engine.list({ limit: 2 }).items[0]?.requestId).toBe("new_history");
  });

  it("isolates ownership and task correlation between two window engines", async () => {
    const first = createHarness("beacon", { ownerWindowId: 11, ids: ["window_11"] });
    const second = createHarness("beacon", { ownerWindowId: 22, ids: ["window_22"] });
    first.client.pingBeacon.mockResolvedValueOnce(asyncResponse("task_window_11"));
    second.client.pingBeacon.mockResolvedValueOnce(asyncResponse("task_window_22"));

    const [firstRecord, secondRecord] = await Promise.all([
      first.engine.submit({ operationId: "target.ping" }),
      second.engine.submit({ operationId: "target.ping" }),
    ]);

    expect(firstRecord.ownership).toMatchObject({ origin: "local", ownerWindowId: 11 });
    expect(secondRecord.ownership).toMatchObject({ origin: "local", ownerWindowId: 22 });
    expect(first.engine.get(secondRecord.requestId)).toBeUndefined();
    expect(second.engine.findByTask(firstRecord.taskId!, second.active.ref.id)).toBeUndefined();
  });

  it("emits immutable clones and closes unresolved work conservatively", async () => {
    const events: Readonly<TargetOperationRecord>[] = [];
    const harness = createHarness("beacon", { onChanged: (record) => events.push(record) });
    const record = await harness.engine.submit({ operationId: "target.ping" });

    expect(Object.isFrozen(events.at(-1))).toBe(true);
    expect(Object.isFrozen(events.at(-1)?.target)).toBe(true);
    expect(() => {
      (events.at(-1) as TargetOperationRecord).state = "failed";
    }).toThrow(TypeError);
    expect(harness.engine.get(record.requestId)?.state).toBe("submitted");

    harness.engine.close();
    expect(harness.engine.get(record.requestId)).toMatchObject({ state: "outcome-unknown" });
    await expect(harness.engine.submit({ operationId: "target.ping" })).rejects.toThrow(/closed/u);
  });

  it("keeps a correlated task reconcilable after connection uncertainty", async () => {
    const harness = createHarness("beacon", { ids: ["recoverable_request"] });
    harness.client.pingBeacon.mockResolvedValueOnce(asyncResponse("recoverable_task"));
    const submitted = await harness.engine.submit({ operationId: "target.ping" });

    expect(harness.engine.markTaskOutcomeUnknown("recoverable_task", harness.active.ref.id)).toMatchObject({
      requestId: submitted.requestId,
      state: "outcome-unknown",
    });
    await expect(harness.engine.reconcileTask({
      taskId: "recoverable_task",
      beaconId: harness.active.ref.id,
      state: "pending",
    })).resolves.toMatchObject({ state: "outcome-unknown" });
    await expect(harness.engine.reconcileTask({
      taskId: "recoverable_task",
      beaconId: harness.active.ref.id,
      state: "completed",
      disposition: {
        kind: "structured-detail",
        title: "Recovered ping",
        fields: [{ label: "Nonce", value: 42 }],
        truncated: false,
      },
    })).resolves.toMatchObject({
      state: "completed",
      disposition: { kind: "structured-detail", title: "Recovered ping" },
    });
    expect(harness.client.pingBeacon).toHaveBeenCalledOnce();
  });

  it("moves recovered task completion to partial when its postcondition refresh fails", async () => {
    const harness = createHarness("beacon", { ids: ["recoverable_reconfigure"] });
    harness.client.reconfigureBeacon.mockResolvedValueOnce(asyncResponse("recoverable_reconfigure_task"));
    harness.refreshTargets.mockRejectedValue(new Error("refresh unavailable"));
    const submitted = await harness.engine.submit({
      operationId: "beacon.reconfigure",
      intervalSeconds: 5,
    });
    harness.engine.markTaskOutcomeUnknown(submitted.taskId!, harness.active.ref.id);

    const recovered = await harness.engine.reconcileTask({
      taskId: submitted.taskId!,
      beaconId: harness.active.ref.id,
      state: "completed",
      disposition: {
        kind: "structured-detail",
        title: "Reconfigure response",
        fields: [{ label: "Status", value: "Delivered" }],
        truncated: false,
      },
    });

    expect(recovered).toMatchObject({
      state: "partial",
      disposition: { kind: "structured-detail", title: "Reconfigure response" },
    });
    expect(harness.client.reconfigureBeacon).toHaveBeenCalledOnce();
  });

  it("moves an overdue correlated task to recoverable outcome unknown without replay", async () => {
    const harness = createHarness("beacon", { ids: ["deadline_request"] });
    harness.client.pingBeacon.mockResolvedValueOnce(asyncResponse("deadline_task"));
    const submitted = await harness.engine.submit({ operationId: "target.ping" });
    expect(submitted).toMatchObject({ state: "submitted", deadlineAt: expect.any(String) });

    harness.advance(31_000);
    expect(harness.engine.expireOverdueTasks()).toBe(1);
    expect(harness.engine.get(submitted.requestId)).toMatchObject({
      state: "outcome-unknown",
      message: expect.stringMatching(/reconciliation deadline/),
    });
    expect(harness.engine.expireOverdueTasks()).toBe(0);
    expect(harness.client.pingBeacon).toHaveBeenCalledOnce();
  });

  it("bounds recoverable task history by count and age while dropping task correlations", async () => {
    const harness = createHarness("beacon", {
      ids: ["recoverable_1", "recoverable_2", "recoverable_3"],
      recoverableTaskRecordLimit: 2,
      recoverableTaskTtlMilliseconds: 1_000,
    });
    const records: TargetOperationRecord[] = [];
    for (const index of [1, 2, 3]) {
      harness.client.pingBeacon.mockResolvedValueOnce(asyncResponse(`recoverable_task_${index}`));
      const record = await harness.engine.submit({ operationId: "target.ping" });
      harness.engine.markTaskOutcomeUnknown(record.taskId!, harness.active.ref.id);
      records.push(record);
    }

    expect(harness.engine.get(records[0]!.requestId)).toBeUndefined();
    await expect(harness.engine.reconcileTask({
      taskId: records[0]!.taskId!,
      beaconId: harness.active.ref.id,
      state: "completed",
      disposition: pingDisposition(1),
    })).resolves.toBeUndefined();
    expect(harness.engine.list().page.total).toBe(2);

    harness.advance(1_100);
    expect(harness.engine.list().page.total).toBe(0);
    for (const record of records.slice(1)) {
      expect(harness.engine.findByTask(record.taskId!, harness.active.ref.id)).toBeUndefined();
    }
    expect(harness.client.pingBeacon).toHaveBeenCalledTimes(3);
  });

  it("bounds active per-window operations below the task catalog capacity", async () => {
    const harness = createHarness("beacon", {
      activeOperationLimit: 2,
      ids: ["active_1", "active_2", "rejected_3"],
    });
    harness.client.pingBeacon
      .mockResolvedValueOnce(asyncResponse("active_task_1"))
      .mockResolvedValueOnce(asyncResponse("active_task_2"));

    await expect(harness.engine.submit({ operationId: "target.ping" }))
      .resolves.toMatchObject({ state: "submitted" });
    await expect(harness.engine.submit({ operationId: "target.ping" }))
      .resolves.toMatchObject({ state: "submitted" });
    await expect(harness.engine.submit({ operationId: "target.ping" }))
      .rejects.toThrow(/already has 2 active operations/u);
    expect(harness.client.pingBeacon).toHaveBeenCalledTimes(2);
    expect(harness.engine.get("rejected_3")).toBeUndefined();
  });

  it("reserves active admission before awaiting target resolution", async () => {
    const targetGate = deferred<void>();
    const harness = createHarness("beacon", {
      activeOperationLimit: 2,
      ids: ["concurrent_1", "concurrent_2", "concurrent_rejected"],
    });
    harness.resolveActiveTarget.mockImplementation(async () => {
      await targetGate.promise;
      return harness.active;
    });
    harness.client.pingBeacon
      .mockResolvedValueOnce(asyncResponse("concurrent_task_1"))
      .mockResolvedValueOnce(asyncResponse("concurrent_task_2"));

    const first = harness.engine.submit({ operationId: "target.ping" });
    const second = harness.engine.submit({ operationId: "target.ping" });
    await expect(harness.engine.submit({ operationId: "target.ping" }))
      .rejects.toThrow(/already has 2 active operations/u);
    expect(harness.resolveActiveTarget).toHaveBeenCalledTimes(2);

    targetGate.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { state: "submitted" },
      { state: "submitted" },
    ]);
    expect(harness.client.pingBeacon).toHaveBeenCalledTimes(2);
  });

  it("emits bounded progress for queued, submitting, waiting, and terminal stages", async () => {
    const changes: Readonly<TargetOperationRecord>[] = [];
    const harness = createHarness("beacon", { onChanged: (record) => changes.push(record) });
    const submitted = await harness.engine.submit({ operationId: "target.ping" });
    await harness.engine.reconcileTask({ taskId: submitted.taskId!, beaconId: harness.active.ref.id, state: "sent" });
    await harness.engine.reconcileTask({
      taskId: submitted.taskId!,
      beaconId: harness.active.ref.id,
      state: "completed",
      disposition: pingDisposition(harness.engine.expectedPingNonceForTask(submitted.taskId!, harness.active.ref.id)!),
    });

    expect(changes.map((record) => record.progress?.completedUnits)).toEqual(expect.arrayContaining([0, 1, 2, 3]));
    expect(changes.every((record) => record.progress?.totalUnits === 3)).toBe(true);
    expect(changes.every((record) => [...(record.progress?.message ?? "")].length <= 64)).toBe(true);
  });
});

interface HarnessOptions {
  ids?: string[];
  freezeClock?: boolean;
  ownerWindowId?: number;
  terminalRecordLimit?: number;
  recoverableTaskRecordLimit?: number;
  recoverableTaskTtlMilliseconds?: number;
  activeOperationLimit?: number;
  onChanged?: (record: Readonly<TargetOperationRecord>) => void;
  claimExternalTask?: OperationEngineHost["claimExternalTask"];
}

function createHarness(mode: TargetMode, options: HarnessOptions = {}) {
  const active = resolvedTarget(mode);
  const client = fakeClient(mode);
  const ids = [...(options.ids ?? [])];
  let generatedId = 0;
  let clock = Date.UTC(2026, 7, 9, 20, 0, 0);
  const assertTarget = vi.fn(async () => active);
  const resolveActiveTarget = vi.fn(async () => active);
  const capability = vi.fn(async (_target: ResolvedOperationTarget, _capabilityId: TargetCapabilityId) => true);
  const refreshTargets = vi.fn(async () => undefined);
  const cancelTask = vi.fn(async () => undefined);
  const reserveTaskClaim = vi.fn((_requestId: string) => true);
  const releaseTaskClaimReservation = vi.fn((_requestId: string) => undefined);
  const claimTask = vi.fn((_taskId: string) => true);
  const claimExternalTask = vi.fn(options.claimExternalTask ?? ((_taskId: string) => true));
  const settleTaskClaim = vi.fn((_taskId: string, _requestId: string) => undefined);
  const host: OperationEngineHost = {
    client,
    ownerWindowId: options.ownerWindowId ?? 7,
    resolveActiveTarget,
    assertTarget,
    resolveJournaledTarget: assertTarget,
    reserveTaskClaim,
    releaseTaskClaimReservation,
    claimTask,
    claimExternalTask,
    settleTaskClaim,
    capability,
    refreshTargets,
    cancelTask,
    now: () => new Date(options.freezeClock ? clock : clock++),
    idFactory: () => ids.shift() ?? `request_${++generatedId}`,
    ...(options.terminalRecordLimit === undefined
      ? {}
      : { terminalRecordLimit: options.terminalRecordLimit }),
    ...(options.recoverableTaskRecordLimit === undefined
      ? {}
      : { recoverableTaskRecordLimit: options.recoverableTaskRecordLimit }),
    ...(options.recoverableTaskTtlMilliseconds === undefined
      ? {}
      : { recoverableTaskTtlMilliseconds: options.recoverableTaskTtlMilliseconds }),
    ...(options.activeOperationLimit === undefined
      ? {}
      : { activeOperationLimit: options.activeOperationLimit }),
    ...(options.onChanged ? { onChanged: options.onChanged } : {}),
  };
  return {
    active,
    client,
    assertTarget,
    resolveActiveTarget,
    capability,
    refreshTargets,
    cancelTask,
    reserveTaskClaim,
    releaseTaskClaimReservation,
    claimExternalTask,
    settleTaskClaim,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    engine: new OperationEngine(host),
  };
}

function fakeClient(mode: TargetMode) {
  const defaultTask = asyncResponse(`task_${mode}`);
  const environment = new Map<string, string>();
  return {
    pingSession: vi.fn(async (_targetId: string, nonce: number) => syncPing(nonce)),
    pingBeacon: vi.fn(async () => defaultTask),
    renameSession: vi.fn(async () => ({})),
    renameBeacon: vi.fn(async () => ({})),
    setEnvSession: vi.fn(async (_targetId: string, name: string, value: string) => {
      environment.set(name, value);
      return { Response: emptyResponse() };
    }),
    setEnvBeacon: vi.fn(async () => defaultTask),
    unsetEnvSession: vi.fn(async (_targetId: string, name: string) => {
      environment.delete(name);
      return { Response: emptyResponse() };
    }),
    unsetEnvBeacon: vi.fn(async () => defaultTask),
    getEnvSession: vi.fn(async (_targetId: string, name: string) => ({
      Variables: [...environment]
        .filter(([key]) => !name || key === name)
        .map(([Key, Value]) => ({ Key, Value })),
      Response: emptyResponse(),
    })),
    reconfigureBeacon: vi.fn(async () => defaultTask),
    openSessionFromBeacon: vi.fn(async () => defaultTask),
    pwdBeacon: vi.fn(async () => defaultTask),
    lsBeacon: vi.fn(async () => defaultTask),
    psBeacon: vi.fn(async () => defaultTask),
    ifconfigBeacon: vi.fn(async () => defaultTask),
    envBeacon: vi.fn(async () => defaultTask),
    whoamiBeacon: vi.fn(async () => defaultTask),
    netstatBeacon: vi.fn(async () => defaultTask),
    mountBeacon: vi.fn(async () => defaultTask),
    memfilesBeacon: vi.fn(async () => defaultTask),
    catBeacon: vi.fn(async () => defaultTask),
    headBeacon: vi.fn(async () => defaultTask),
    tailBeacon: vi.fn(async () => defaultTask),
    grepBeacon: vi.fn(async () => defaultTask),
  } as unknown as OperationEngineHost["client"] & Record<OperationClientMethod, ReturnType<typeof vi.fn>>;
}

function externalBeaconDescriptor(
  overrides: Partial<ExternalOperationDescriptor> = {},
): Readonly<ExternalOperationDescriptor> {
  return Object.freeze({
    cancellation: "best-effort-beacon-task",
    outcomeUnknownAfterSubmission: true,
    taskTimeoutSeconds: 60,
    startMessage: "Reviewed execution submitted.",
    completionMessage: "Reviewed execution completed.",
    failureMessage: "Reviewed execution failed.",
    canceledMessage: "Reviewed execution canceled.",
    outcomeUnknownMessage: "The reviewed task outcome could not be confirmed.",
    ...overrides,
  });
}

type OperationClientMethod =
  | "pingSession"
  | "pingBeacon"
  | "renameSession"
  | "renameBeacon"
  | "setEnvSession"
  | "setEnvBeacon"
  | "unsetEnvSession"
  | "unsetEnvBeacon"
  | "getEnvSession"
  | "reconfigureBeacon"
  | "openSessionFromBeacon"
  | "pwdBeacon"
  | "lsBeacon"
  | "psBeacon"
  | "ifconfigBeacon"
  | "envBeacon"
  | "whoamiBeacon"
  | "netstatBeacon"
  | "mountBeacon"
  | "memfilesBeacon"
  | "catBeacon"
  | "headBeacon"
  | "tailBeacon"
  | "grepBeacon";

function resolvedTarget(mode: TargetMode): ResolvedOperationTarget {
  const summary = targetSummary(mode);
  const ref: TargetRef = {
    mode,
    id: summary.id,
    backendEpoch: 3,
    domainRevision: 9,
    fingerprint: `${mode}:fingerprint`,
  };
  return {
    ref,
    summary,
    authoritativeActiveC2: "mtls://127.0.0.1:8888/private?token=main-only",
    backend: {
      configId: "config_1",
      configName: "M1 test",
      server: "127.0.0.1:31337",
      operator: "operator",
      epoch: 3,
    },
  };
}

function targetSummary(mode: TargetMode): TargetSummary {
  const common = {
    id: `${mode}_1`,
    name: `${mode} target`,
    hostname: "host",
    hostId: "host-id",
    username: "user",
    os: "darwin",
    arch: "arm64",
    transport: "mtls" as const,
    remoteAddress: "127.0.0.1:4444",
    activeC2: "mtls://127.0.0.1:4444",
    executable: "/tmp/test",
    version: "1.0",
    locale: "en-US",
    integrity: "Medium",
    burned: false,
  };
  if (mode === "session") {
    return { ...common, mode, liveness: "active" } satisfies SessionSummary;
  }
  return {
    ...common,
    mode,
    checkinStatus: "on-time",
    intervalMs: 5_000,
    jitterMs: 1_000,
  } satisfies BeaconSummary;
}

function emptyResponse() {
  return { Err: "", Async: false, BeaconID: "", TaskID: "" };
}

function syncPing(nonce: number) {
  return { Nonce: nonce, Response: emptyResponse() };
}

function asyncResponse(taskId: string) {
  return {
    Nonce: 42,
    Response: { Err: "", Async: true, BeaconID: "beacon_1", TaskID: taskId },
  };
}

function pingDisposition(nonce: number): OperationDisposition {
  return {
    kind: "structured-detail",
    title: "Ping response",
    fields: [{ label: "Nonce", value: nonce }],
    truncated: false,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function waitForRecord(engine: OperationEngine, requestId: string): Promise<void> {
  for (let attempt = 0; attempt < 10 && !engine.get(requestId); attempt += 1) {
    await Promise.resolve();
  }
  expect(engine.get(requestId)).toBeDefined();
}

async function waitForState(
  engine: OperationEngine,
  requestId: string,
  state: TargetOperationRecord["state"],
): Promise<void> {
  for (let attempt = 0; attempt < 20 && engine.get(requestId)?.state !== state; attempt += 1) {
    await Promise.resolve();
  }
  expect(engine.get(requestId)?.state).toBe(state);
}

// Compile-time proof that every table input is part of the closed input union.
const _closedInputProof: TargetOperationInput[] = [
  { operationId: "target.ping" },
  { operationId: "target.rename", name: "target" },
  { operationId: "target.env-set", name: "KEY", value: "VALUE" },
  { operationId: "target.env-unset", name: "KEY" },
  { operationId: "beacon.reconfigure", intervalSeconds: 5 },
  { operationId: "beacon.open-session", delaySeconds: 0 },
  { operationId: "beacon.filesystem.pwd" },
  { operationId: "beacon.filesystem.ls", path: "/tmp" },
  { operationId: "beacon.process.list", fullInfo: true },
  { operationId: "beacon.network.interfaces" },
  { operationId: "beacon.environment.list", name: "HOME" },
  { operationId: "beacon.identity.whoami" },
  { operationId: "beacon.network.netstat", tcp: true, udp: false, ip4: true, ip6: false, listen: true },
  { operationId: "beacon.filesystem.mount" },
  { operationId: "beacon.filesystem.memfiles" },
  { operationId: "beacon.filesystem.cat", path: "/tmp/readme.txt" },
  { operationId: "beacon.filesystem.head", path: "/tmp/readme.txt", lines: 8 },
  { operationId: "beacon.filesystem.tail", path: "/tmp/readme.txt", bytes: 512 },
  { operationId: "beacon.filesystem.grep", path: "/tmp", pattern: "needle", recursive: true, before: 2, after: 3 },
];
void _closedInputProof;
