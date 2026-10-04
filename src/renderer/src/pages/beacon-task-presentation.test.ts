import { describe, expect, it } from "vitest";
import { faFolderOpen } from "@fortawesome/free-solid-svg-icons";

import historicalTaskSource from "../../../main/historical-beacon-task.ts?raw";
import commandMatrixSource from "../../../main/beacon-command-matrix.ts?raw";
import executionTaskSource from "../../../main/execution-beacon-task.ts?raw";
import { EXECUTION_OPERATION_IDS } from "../../../shared/execution-contracts";
import { TARGET_OPERATION_IDS, type BeaconTaskDetail } from "../../../shared/operation-contracts";
import { getBeaconTaskPresentation } from "./beacon-task-presentation";

function task(description: string, overrides: Partial<BeaconTaskDetail> = {}): BeaconTaskDetail {
  return {
    taskId: "task-presentation",
    beaconId: "beacon-presentation",
    description,
    state: "completed",
    resultAvailable: true,
    ownership: { origin: "external", actor: { attribution: "unknown" } },
    cancellation: { available: false },
    ...overrides,
  };
}

describe("getBeaconTaskPresentation", () => {
  it("gives every known beacon wire type a friendly label and icon", () => {
    // Read source as text so renderer tests never initialize main-process code.
    const historical = [...historicalTaskSource.matchAll(/^  (\w+): \[/gmu)].map((match) => match[1]!);
    const matrix = [...commandMatrixSource.matchAll(/"taskDescription": "([^"]+)"/gu)].map((match) => match[1]!);
    const executionDescriptions = executionTaskSource.split("export const EXECUTION_BEACON_TASK_DESCRIPTIONS")[1]?.split("as const satisfies")[0] ?? "";
    const execution = [...executionDescriptions.matchAll(/"([A-Z][A-Za-z]+Req)"/gu)].map((match) => match[1]!);
    expect(historical.length).toBeGreaterThan(75);
    expect(matrix).toContain("KillReq");
    expect(execution).toContain("InvokeInProcExecuteAssemblyReq");

    for (const description of new Set([...historical, ...matrix, ...execution])) {
      const presentation = getBeaconTaskPresentation(task(description));
      expect(presentation.label, description).not.toBe(description);
      expect(presentation.label, description).not.toBe("Beacon task");
      expect(presentation.label, description).not.toMatch(/Req$/u);
      expect(presentation.icon.iconName, description).toBeTruthy();
    }
  });

  it("uses Directory listing and its folder icon for both summaries and details", () => {
    expect(getBeaconTaskPresentation(task("LsReq"))).toEqual({ label: "Directory listing", icon: faFolderOpen });
    expect(getBeaconTaskPresentation(task("LsReq", { operationId: "beacon.filesystem.ls" })))
      .toEqual({ label: "Directory listing", icon: faFolderOpen });
  });

  it("maps every correlated target and execution operation", () => {
    for (const operationId of TARGET_OPERATION_IDS) {
      expect(getBeaconTaskPresentation(task("FutureReq", { operationId })).label, operationId).not.toBe("Beacon task");
    }
    for (const operationId of EXECUTION_OPERATION_IDS) {
      expect(getBeaconTaskPresentation(task("FutureReq", { execution: { operationId } })).label, operationId).not.toBe("Beacon task");
    }
  });

  it("uses correlated operation identities before ambiguous wire descriptions", () => {
    expect(getBeaconTaskPresentation(task("DownloadReq", { operationId: "beacon.filesystem.head" })).label).toBe("File beginning");
    expect(getBeaconTaskPresentation(task("DownloadReq", { operationId: "beacon.filesystem.tail" })).label).toBe("File ending");
    expect(getBeaconTaskPresentation(task("TaskReq")).label).toBe("Payload execution");
    expect(getBeaconTaskPresentation(task("TaskReq", { execution: { operationId: "execution.shellcode" } })).label).toBe("Shellcode execution");
    expect(getBeaconTaskPresentation(task("CallExtensionReq", { execution: { operationId: "bof.execute" } })).label).toBe("BOF output");
    expect(getBeaconTaskPresentation(task("FutureReq", {
      executionRead: { operationId: "execution.children", state: "completed", items: [], total: 0, truncated: false },
    })).label).toBe("Background processes");
  });

  it.each(["", "  ", "FutureNestedReq", "FutureResponse", "FutureTask", "sliverpb.Unknown", "unknown_task", "__proto__", "constructor", "toString"])
    ("keeps unknown technical description %j out of the interface", (description) => {
      expect(getBeaconTaskPresentation(task(description)).label).toBe("Beacon task");
    });

  it("preserves readable custom descriptions and ignores inherited map properties", () => {
    expect(getBeaconTaskPresentation(task("  Check working directory  ")).label).toBe("Check working directory");
    expect(getBeaconTaskPresentation(task("Health check", {
      operationId: "toString" as BeaconTaskDetail["operationId"] & string,
    })).label).toBe("Health check");
  });
});
