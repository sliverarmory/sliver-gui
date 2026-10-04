import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { BeaconTaskDetail, OperationDisposition } from "../../../shared/operation-contracts";
import type { BeaconTaskOutputEntry } from "./useBeaconTaskOutputs";
import { BeaconTaskOutput } from "./BeaconInteractionWorkspace";
import { getBeaconTaskPresentation } from "./beacon-task-presentation";

vi.mock("./BeaconExecutionTaskOutput", () => ({ BeaconExecutionTaskOutput: () => <div>Execution output</div> }));
vi.mock("./BeaconExecutionCommand", () => ({ BeaconExecutionCommand: () => <div /> }));

const task: BeaconTaskDetail = {
  taskId: "00000000-0000-4000-8000-000000000001",
  beaconId: "beacon-1",
  state: "completed",
  description: "Task preview",
  resultAvailable: true,
  cancellation: { available: false },
  ownership: { origin: "external", actor: { attribution: "unknown" } },
};
const table: OperationDisposition = { kind: "table", columns: ["Name"], rows: [["preview row"]], truncated: true };
const structured: OperationDisposition = { kind: "structured-detail", title: "Result", fields: [{ label: "Path", value: "/tmp" }], truncated: true };
const text: OperationDisposition = { kind: "inline-text", text: "preview text", truncated: true };

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
});
afterEach(cleanup);
afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

function preview(detail: BeaconTaskDetail | undefined, overrides: Partial<BeaconTaskOutputEntry> = {}): void {
  render(<BeaconTaskOutput
    isCanceling={false}
    output={{ task, detail, error: undefined, isLoading: false, ...overrides }}
    onCancel={vi.fn()}
    onLoad={vi.fn()}
    onRetry={vi.fn()}
  />);
}

const taskKinds: Array<[string, Partial<BeaconTaskDetail>]> = [
  ["working directory", { operationId: "beacon.filesystem.pwd", disposition: structured }],
  ["directory", { operationId: "beacon.filesystem.ls", disposition: table }],
  ["processes", { operationId: "beacon.process.list", disposition: table }],
  ["interfaces", { operationId: "beacon.network.interfaces", disposition: table }],
  ["environment", { operationId: "beacon.environment.list", disposition: table }],
  ["connections", { operationId: "beacon.network.netstat", disposition: table }],
  ["mounts", { operationId: "beacon.filesystem.mount", disposition: table }],
  ["memory files", { operationId: "beacon.filesystem.memfiles", disposition: table }],
  ["file search", { operationId: "beacon.filesystem.grep", disposition: table }],
  ["file contents", { operationId: "beacon.filesystem.cat", disposition: text }],
  ["file head", { operationId: "beacon.filesystem.head", disposition: text }],
  ["file tail", { operationId: "beacon.filesystem.tail", disposition: text }],
  ["registry subkeys", { operationId: "beacon.registry.list-subkeys", disposition: table }],
  ["registry values", { operationId: "beacon.registry.list-values", disposition: table }],
  ["registry read", { operationId: "beacon.registry.read", disposition: structured }],
  ["registry create", { operationId: "beacon.registry.create", disposition: structured }],
  ["registry delete", { operationId: "beacon.registry.delete", disposition: structured }],
  ["registry write", { operationId: "beacon.registry.write", disposition: structured }],
  ["services", { operationId: "beacon.service.list", disposition: table }],
  ["service info", { operationId: "beacon.service.info", disposition: structured }],
  ["service start", { operationId: "beacon.service.start", disposition: structured }],
  ["service stop", { operationId: "beacon.service.stop", disposition: structured }],
  ["execution", { execution: { operationId: "execution.process" } }],
  ["execution read", { executionRead: { operationId: "execution.children", state: "submitted", taskId: task.taskId, items: [], total: 0, truncated: false } }],
  ["generic", { disposition: text }],
  ["decode failure", { error: "Could not decode output", errorKind: "decode-uncertain" }],
];

describe("Beacon task preview details", () => {
  it.each(taskKinds)("offers Details for %s and keeps the GUID out of its preview title", (_name, overrides) => {
    preview({ ...task, ...overrides });
    expect(screen.getByRole("button", { name: "Details" })).toBeVisible();
    const heading = screen.getByRole("heading", { name: getBeaconTaskPresentation({ ...task, ...overrides }).label, level: 3 });
    expect(heading).toBeVisible();
    expect(heading.querySelector("svg")).toBeInTheDocument();
    expect(screen.queryByText(task.taskId)).not.toBeInTheDocument();
  });

  it.each(["pending", "sent", "failed", "canceled"] as const)("offers Details for a %s task", (state) => {
    preview({ ...task, state });
    expect(screen.getByRole("button", { name: "Details" })).toBeVisible();
    expect(screen.queryByText(task.taskId)).not.toBeInTheDocument();
  });

  it.each([
    { isLoading: true }, { error: "Could not load preview" }, {},
  ])("offers Details independently of preview loading %j", (overrides) => {
    preview(undefined, overrides);
    expect(screen.getByRole("button", { name: "Details" })).toBeVisible();
    expect(screen.queryByText(task.taskId)).not.toBeInTheDocument();
  });

  it("directs a shortened preview to Details", () => {
    preview({ ...task, disposition: text });
    expect(screen.getByText("Preview shortened. Open Details to view the full output.")).toBeVisible();
  });

  it("promotes the directory name and icon to the only task title", () => {
    const directoryTask: BeaconTaskDetail = {
      ...task,
      description: "LsReq",
      operationId: "beacon.filesystem.ls",
      disposition: table,
    };
    preview(directoryTask, { task: directoryTask });

    const heading = screen.getByRole("heading", { name: "Directory listing", level: 3 });
    expect(heading.querySelector('[data-icon="folder-open"]')).toBeInTheDocument();
    expect(screen.getAllByText("Directory listing")).toHaveLength(1);
    expect(screen.queryByText("LsReq")).not.toBeInTheDocument();
    expect(screen.queryByText("Filesystem metadata returned by this check-in.")).not.toBeInTheDocument();
    expect(screen.getByText("preview row")).toBeVisible();
  });

  it.each(["pending", "sent", "completed", "failed", "canceled"] as const)("uses the friendly title before a %s task preview loads", (state) => {
    preview(undefined, { task: { ...task, state, description: "LsReq" }, isLoading: true });

    expect(screen.getByRole("heading", { name: "Directory listing", level: 3 })).toBeVisible();
    expect(screen.queryByText("LsReq")).not.toBeInTheDocument();
  });

  it("uses a plain fallback title when a task type is unknown", () => {
    preview(undefined, { task: { ...task, description: "FutureTaskReq" } });

    expect(screen.getByRole("heading", { name: "Beacon task", level: 3 })).toBeVisible();
    expect(screen.queryByText("FutureTaskReq")).not.toBeInTheDocument();
  });
});
