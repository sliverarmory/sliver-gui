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
  type OperationEngineHost,
  type ResolvedOperationTarget,
} from "./operation-engine.js";

describe("OperationEngine", () => {
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
  ];

  it.each(asyncCases)("correlates an exact async task ID for %s", async (input, method, timeout) => {
    const harness = createHarness("beacon");
    const taskId = `task_${method}`;
    harness.client[method].mockResolvedValueOnce(asyncResponse(taskId));

    const record = await harness.engine.submit(input);

    expect(record).toMatchObject({ state: "submitted", taskId, attempts: 1 });
    expect(harness.engine.findByTask(taskId, harness.active.ref.id)?.requestId).toBe(record.requestId);
    expect(harness.client[method].mock.calls[0]?.at(-1)).toBe(timeout);
    expect(harness.refreshTargets).toHaveBeenCalled();
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
  ownerWindowId?: number;
  terminalRecordLimit?: number;
  recoverableTaskRecordLimit?: number;
  recoverableTaskTtlMilliseconds?: number;
  activeOperationLimit?: number;
  onChanged?: (record: Readonly<TargetOperationRecord>) => void;
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
  const host: OperationEngineHost = {
    client,
    ownerWindowId: options.ownerWindowId ?? 7,
    resolveActiveTarget,
    assertTarget,
    resolveJournaledTarget: assertTarget,
    reserveTaskClaim: () => true,
    releaseTaskClaimReservation: () => undefined,
    claimTask: () => true,
    settleTaskClaim: () => undefined,
    capability,
    refreshTargets,
    cancelTask,
    now: () => new Date(clock++),
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
  } as unknown as OperationEngineHost["client"] & Record<OperationClientMethod, ReturnType<typeof vi.fn>>;
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
  | "openSessionFromBeacon";

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
];
void _closedInputProof;
