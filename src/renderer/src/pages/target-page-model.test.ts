import { describe, expect, it } from "vitest";

import type { BeaconSummary, SessionSummary } from "../../../shared/target-contracts";
import {
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
