import { describe, expect, it } from "vitest";

import type { BeaconSummary, SessionSummary } from "../../../shared/target-contracts";
import {
  beaconCheckinTiming,
  beaconTaskCountLabel,
  filterTargets,
  formatDuration,
  isOperationCancelable,
  operationLabel,
  operationStateColor,
  targetRowKey,
  targetStatus,
  taskStateColor,
} from "./target-page-model";

const session: SessionSummary = {
  mode: "session",
  id: "session-1",
  name: "payments",
  hostname: "prod-mac",
  hostId: "host-1",
  username: "alice",
  os: "darwin",
  arch: "arm64",
  transport: "mtls",
  remoteAddress: "127.0.0.1:4444",
  activeC2: "mtls://127.0.0.1:4444",
  executable: "/tmp/agent",
  version: "1.7.6",
  locale: "en-US",
  integrity: "High",
  burned: false,
  liveness: "active",
};

const beacon: BeaconSummary = {
  ...session,
  mode: "beacon",
  id: "beacon-1",
  name: "warehouse",
  hostname: "edge-linux",
  username: "bob",
  os: "linux",
  arch: "amd64",
  checkinStatus: "overdue",
  taskCount: 7,
  nonCompletedTaskCount: 2,
};

describe("target page model", () => {
  it("filters across identity and transport fields while preserving mode filters", () => {
    expect(filterTargets([session, beacon], "all", "ALICE")).toEqual([session]);
    expect(filterTargets([session, beacon], "beacon", "linux")).toEqual([beacon]);
    expect(filterTargets([session, beacon], "session", "edge")).toEqual([]);
    expect(filterTargets([session, beacon], "all", "mtls://127")).toEqual([session, beacon]);
  });

  it("uses collision-safe row keys and semantic liveness labels", () => {
    expect(targetRowKey(session)).toBe("session:session-1");
    expect(targetRowKey(beacon)).toBe("beacon:beacon-1");
    expect(targetStatus(session)).toEqual({ label: "Active", color: "success" });
    expect(targetStatus(beacon)).toEqual({ label: "Overdue", color: "warning" });
  });

  it("derives beacon timing from the reported next check-in without adding interval or jitter", () => {
    const nowMs = Date.parse("2026-09-26T16:25:00.000Z");
    const futureBeacon = {
      ...beacon,
      nextCheckinAt: "2026-09-26T16:26:05.000Z",
      intervalMs: 60_000,
      jitterMs: 30_000,
    };
    expect(beaconCheckinTiming(futureBeacon, nowMs)).toEqual({
      status: { label: "On time", color: "success" },
      countdown: "In 1m 05s",
    });
    expect(targetStatus(futureBeacon, nowMs)).toEqual({ label: "On time", color: "success" });
    expect(targetStatus(futureBeacon)).toEqual({ label: "Overdue", color: "warning" });
    expect(targetStatus(session, nowMs)).toEqual({ label: "Active", color: "success" });
  });

  it.each([
    [-1_001, "In 2s", "On time", "success"],
    [-1_000, "In 1s", "On time", "success"],
    [-0.5, "In 1s", "On time", "success"],
    [0, "Due now", "On time", "success"],
    [0.5, "Overdue by 1s", "Overdue", "warning"],
    [1_000, "Overdue by 1s", "Overdue", "warning"],
    [1_001, "Overdue by 2s", "Overdue", "warning"],
    [5_000, "Overdue by 5s", "Overdue", "warning"],
  ])("handles deadline offset %d milliseconds", (offsetMs, countdown, label, color) => {
    const nextCheckinAt = "2026-09-26T16:26:05.000Z";
    const nextCheckinMs = Date.parse(nextCheckinAt);
    expect(beaconCheckinTiming({ ...beacon, nextCheckinAt }, nextCheckinMs + offsetMs)).toEqual({
      status: { label, color },
      countdown,
    });
  });

  it.each([
    [59_000, "59s"],
    [59_001, "1m 00s"],
    [60_000, "1m 00s"],
    [3_599_000, "59m 59s"],
    [3_600_000, "1h 00m 00s"],
    [3_723_000, "1h 02m 03s"],
    [86_400_000, "1d 00h 00m 00s"],
    [183_845_000, "2d 03h 04m 05s"],
  ])("formats a check-in duration of %d milliseconds", (durationMs, label) => {
    const nextCheckinAt = "2026-09-26T16:26:05.000Z";
    const nextCheckinMs = Date.parse(nextCheckinAt);
    expect(beaconCheckinTiming({ ...beacon, nextCheckinAt }, nextCheckinMs - durationMs).countdown).toBe(`In ${label}`);
    expect(beaconCheckinTiming({ ...beacon, nextCheckinAt }, nextCheckinMs + durationMs).countdown).toBe(`Overdue by ${label}`);
  });

  it("resets timing immediately when the server reports a newer expected check-in", () => {
    const nowMs = Date.parse("2026-09-26T16:26:10.000Z");
    expect(beaconCheckinTiming({ ...beacon, nextCheckinAt: "2026-09-26T16:26:05.000Z" }, nowMs).countdown)
      .toBe("Overdue by 5s");
    expect(beaconCheckinTiming({ ...beacon, nextCheckinAt: "2026-09-26T16:27:05.000Z" }, nowMs)).toEqual({
      status: { label: "On time", color: "success" },
      countdown: "In 55s",
    });
  });

  it("uses neutral timing for missing or invalid timestamps and clocks", () => {
    const unknownTiming = { status: { label: "Unknown", color: "default" }, countdown: "Not reported" };
    expect(beaconCheckinTiming(beacon, Date.now())).toEqual(unknownTiming);
    for (const nextCheckinAt of ["", "not-a-date", "2026-99-99T00:00:00.000Z"]) {
      expect(beaconCheckinTiming({ ...beacon, nextCheckinAt }, Date.now())).toEqual(unknownTiming);
    }
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 8.64e15 + 1]) {
      expect(beaconCheckinTiming({ ...beacon, nextCheckinAt: "2026-09-26T16:26:05.000Z" }, nowMs)).toEqual(unknownTiming);
    }
  });

  it("keeps sent tasks distinct and only marks active operations cancellable", () => {
    expect(taskStateColor("sent")).toBe("default");
    expect(operationStateColor("outcome-unknown")).toBe("warning");
    expect(isOperationCancelable({ state: "running", cancellation: "best-effort-beacon-task" })).toBe(true);
    expect(isOperationCancelable({ state: "submitting", cancellation: "not-supported" })).toBe(false);
    expect(isOperationCancelable({ state: "cancel-requested", cancellation: "best-effort-beacon-task" })).toBe(false);
    expect(isOperationCancelable({ state: "completed", cancellation: "best-effort-beacon-task" })).toBe(false);
  });

  it("labels both dispatcher and exhaustive journal-only session operation IDs", () => {
    expect(operationLabel("target.ping")).toBe("Ping");
    expect(operationLabel("session.filesystem.ls")).toBe("List directory");
    expect(operationLabel("session.filesystem.read-hex")).toBe("Read file as hex");
    expect(operationLabel("session.filesystem.add-to-loot")).toBe("Add file to loot");
    expect(operationLabel("session.filesystem.chmod-recursive")).toBe("Change file modes recursively");
    expect(operationLabel("session.registry.write")).toBe("Write registry value");
  });

  it("formats bounded target timing and task counts for compact tables", () => {
    expect(formatDuration(500)).toBe("500 ms");
    expect(formatDuration(8_000)).toBe("8 s");
    expect(formatDuration(90_000)).toBe("1.5 min");
    expect(beaconTaskCountLabel(beacon)).toBe("2 non-completed / 7 total");
  });
});
