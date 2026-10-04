// @vitest-environment node

import { commonpb, sliverpb } from "sliver-script";
import { describe, expect, it } from "vitest";

import type {
  ExecutionOperationId,
} from "../shared/execution-contracts.js";
import {
  EXECUTION_BEACON_TASK_DECODE_MESSAGE,
  EXECUTION_BEACON_TASK_DESCRIPTIONS,
  EXECUTION_BEACON_TASK_MAX_RESPONSE_BYTES,
  EXECUTION_BEACON_TASK_MISMATCH_MESSAGE,
  EXECUTION_BEACON_READ_INPUT_MESSAGE,
  EXECUTION_BEACON_TASK_UNVERIFIABLE_MESSAGE,
  ExecutionBeaconTaskDecodeError,
  decodeExecutionBeaconTask,
} from "./execution-beacon-task.js";
import {
  EXECUTION_REMOTE_REJECTION_MESSAGE,
  EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES,
  ExecutionRemoteRejectedError,
} from "./execution-workbench.js";

describe("execution beacon task decoder", () => {
  it("decodes every verifiable beacon action family from exact pinned implant bytes", () => {
    for (const item of actionCases()) {
      const descriptions = EXECUTION_BEACON_TASK_DESCRIPTIONS[item.operationId];
      expect(descriptions).toBeDefined();
      for (const description of descriptions ?? []) {
        const response = item.response();
        const decoded = decodeExecutionBeaconTask({
          operationId: item.operationId,
          description,
          response,
        });

        expect(decoded.kind).toBe("action");
        if (decoded.kind === "action") {
          expect(decoded.value.summary).not.toBe("");
          item.assert(decoded.value);
          decoded.value.stdout?.fill(0);
          decoded.value.stderr?.fill(0);
        }
        expect(isZero(response)).toBe(true);
      }
    }
  });

  it("decodes both read families, pages deterministically, and preserves the correlated task ID", () => {
    const childrenResponse = encodeChildren();
    const first = decodeExecutionBeaconTask({
      operationId: "execution.children",
      description: "ExecuteChildrenReq",
      response: childrenResponse,
      readInput: {
        operationId: "execution.children",
        taskId: "task_children_1",
        limit: 1,
      },
    });

    expect(first.kind).toBe("read");
    if (first.kind !== "read" || first.value.operationId !== "execution.children") return;
    expect(first.value).toMatchObject({
      state: "completed",
      taskId: "task_children_1",
      total: 2,
      truncated: true,
    });
    expect(first.value.items).toHaveLength(1);
    expect(first.value.items[0]).toMatchObject({
      pid: 11,
      path: "/bin/one",
      stdoutBytes: 3,
      stderrBytes: 2,
    });
    expect(first.value.nextCursor).toBe(
      "execution-read:v2:execution.children:task_children_1:1",
    );
    expect(isZero(childrenResponse)).toBe(true);

    const nextResponse = encodeChildren();
    const next = decodeExecutionBeaconTask({
      operationId: "execution.children",
      description: "ExecuteChildrenReq",
      response: nextResponse,
      readInput: {
        operationId: "execution.children",
        taskId: "task_children_1",
        cursor: first.value.nextCursor!,
        limit: 1,
      },
    });
    expect(next.kind).toBe("read");
    if (next.kind === "read" && next.value.operationId === "execution.children") {
      expect(next.value.taskId).toBe("task_children_1");
      expect(next.value.items.map(({ pid }) => pid)).toEqual([12]);
      expect(next.value.nextCursor).toBeUndefined();
    }
    expect(isZero(nextResponse)).toBe(true);

    const privilegesResponse = encodePrivileges();
    const privileges = decodeExecutionBeaconTask({
      operationId: "privilege.get",
      description: "GetPrivsReq",
      response: privilegesResponse,
      readInput: { operationId: "privilege.get", taskId: "task_privs_1" },
    });
    expect(privileges.kind).toBe("read");
    if (privileges.kind === "read" && privileges.value.operationId === "privilege.get") {
      expect(privileges.value).toMatchObject({
        taskId: "task_privs_1",
        processName: "agent.exe",
        processIntegrity: "High",
        total: 1,
      });
      expect(privileges.value.privileges[0]).toMatchObject({
        name: "SeDebugPrivilege",
        enabled: true,
      });
    }
    expect(isZero(privilegesResponse)).toBe(true);
  });

  it("rejects description and mode mismatches with fixed text and zeroizes the response", () => {
    const mismatch = encodeProcess();
    expect(() => decodeExecutionBeaconTask({
      operationId: "execution.process",
      description: "TaskReq",
      response: mismatch,
    })).toThrowError(expect.objectContaining({
      name: "ExecutionBeaconTaskDecodeError",
      reason: "description-mismatch",
      message: EXECUTION_BEACON_TASK_MISMATCH_MESSAGE,
    }));
    expect(isZero(mismatch)).toBe(true);

    const sessionOnly = encodeProcess();
    expect(() => decodeExecutionBeaconTask({
      operationId: "execution.psexec",
      description: "ExecuteReq",
      response: sessionOnly,
    })).toThrow(ExecutionBeaconTaskDecodeError);
    expect(isZero(sessionOnly)).toBe(true);

    const missingReadInput = encodeChildren();
    expect(() => decodeExecutionBeaconTask({
      operationId: "execution.children",
      description: "ExecuteChildrenReq",
      response: missingReadInput,
    })).toThrow(EXECUTION_BEACON_READ_INPUT_MESSAGE);
    expect(isZero(missingReadInput)).toBe(true);

    const actionWithReadInput = encodeProcess();
    expect(() => decodeExecutionBeaconTask({
      operationId: "execution.process",
      description: "ExecuteReq",
      response: actionWithReadInput,
      readInput: { operationId: "execution.children" },
    })).toThrow(EXECUTION_BEACON_READ_INPUT_MESSAGE);
    expect(isZero(actionWithReadInput)).toBe(true);
  });

  it("fails closed on malformed, noncanonical, missing-required-envelope, and oversized payloads", () => {
    const cases: Array<{
      operationId: "execution.process" | "execution.sideload";
      description: string;
      response: Buffer;
    }> = [
      { operationId: "execution.process", description: "ExecuteReq", response: Buffer.alloc(0) },
      { operationId: "execution.process", description: "ExecuteReq", response: Buffer.from([0x0a, 0x02, 0xff]) },
      { operationId: "execution.process", description: "ExecuteReq", response: Buffer.from([0xf8, 0x07, 0x01]) },
      {
        operationId: "execution.sideload",
        description: "SideloadReq",
        response: Buffer.from(sliverpb.Sideload.encode(sliverpb.Sideload.fromPartial({
          Result: "missing envelope",
        })).finish()),
      },
      {
        operationId: "execution.process",
        description: "ExecuteReq",
        response: Buffer.alloc(EXECUTION_BEACON_TASK_MAX_RESPONSE_BYTES + 1, 0x41),
      },
    ];

    for (const item of cases) {
      const { response } = item;
      expect(() => decodeExecutionBeaconTask({
        operationId: item.operationId,
        description: item.description,
        response,
      })).toThrowError(expect.objectContaining({
        name: "ExecutionBeaconTaskDecodeError",
        reason: "invalid-response",
        message: EXECUTION_BEACON_TASK_DECODE_MESSAGE,
      }));
      expect(isZero(response)).toBe(true);
    }
  });

  it("keeps TaskReq shellcode and MSF results uncertain because success and failure are identical", () => {
    for (const operationId of ["execution.shellcode", "execution.msf", "execution.msf-inject"] as const) {
      const response = Buffer.alloc(0);
      expect(() => decodeExecutionBeaconTask({
        operationId,
        description: "TaskReq",
        response,
      })).toThrowError(expect.objectContaining({
        reason: "unverifiable-response",
        message: EXECUTION_BEACON_TASK_UNVERIFIABLE_MESSAGE,
      }));
      expect(isZero(response)).toBe(true);
    }
  });

  it("classifies an envelopeless unsuccessful migration as a fixed target rejection", () => {
    const response = Buffer.from(sliverpb.Migrate.encode(sliverpb.Migrate.fromPartial({
      Success: false,
      Pid: 0,
    })).finish());
    expect(() => decodeExecutionBeaconTask({
      operationId: "execution.migrate",
      description: "InvokeMigrateReq",
      response,
    })).toThrowError(expect.objectContaining({ message: EXECUTION_REMOTE_REJECTION_MESSAGE }));
    expect(isZero(response)).toBe(true);
  });

  it("replaces target Response.Err with fixed text, never remote content, and zeroizes bytes", () => {
    const response = Buffer.from(sliverpb.RunAs.encode(sliverpb.RunAs.fromPartial({
      Output: "must-not-return",
      Response: envelope({ Err: "remote-secret-path and credential" }),
    })).finish());

    let failure: unknown;
    try {
      decodeExecutionBeaconTask({
        operationId: "privilege.run-as",
        description: "RunAsReq",
        response,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ExecutionRemoteRejectedError);
    expect(failure).toMatchObject({ message: EXECUTION_REMOTE_REJECTION_MESSAGE });
    expect(String(failure)).not.toMatch(/remote-secret-path|credential/u);
    expect(isZero(response)).toBe(true);
  });

  it("returns an independent bounded output copy and marks truncation before zeroizing encoded bytes", () => {
    const raw = Buffer.alloc(EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES + 17, 0x41);
    const response = Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.fromPartial({
      Pid: 404,
      Stdout: raw,
    })).finish());
    expect(response.byteLength).toBeLessThan(EXECUTION_BEACON_TASK_MAX_RESPONSE_BYTES);

    const decoded = decodeExecutionBeaconTask({
      operationId: "execution.process",
      description: "ExecuteReq",
      response,
    });

    expect(decoded.kind).toBe("action");
    if (decoded.kind === "action") {
      expect(decoded.value.pid).toBe(404);
      expect(decoded.value.stdout).toHaveLength(EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES);
      expect(decoded.value.stdoutTruncated).toBe(true);
      expect(decoded.value.stdout?.every((byte) => byte === 0x41)).toBe(true);
      expect(decoded.value.stdout).not.toBe(raw);
      decoded.value.stdout?.fill(0);
    }
    expect(isZero(response)).toBe(true);
    raw.fill(0);
  });

  it("includes a process exit code only when main confirms a captured foreground execution", () => {
    for (const status of [0, 23]) {
      for (const processWaited of [false, true]) {
        const response = Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({
          Status: status,
          Pid: 404,
        })).finish());
        const decoded = decodeExecutionBeaconTask({
          operationId: "execution.process",
          description: "ExecuteReq",
          response,
          processWaited,
        });
        expect(decoded.kind).toBe("action");
        if (decoded.kind === "action") {
          expect(decoded.value.exitCode).toBe(processWaited ? status : undefined);
        }
        expect(isZero(response)).toBe(true);
      }
    }
  });
});

interface ActionCase {
  operationId: Exclude<ExecutionOperationId, "execution.children" | "privilege.get" | "execution.psexec" |
    "execution.ssh" | "execution.backdoor" | "execution.dll-hijack" | "privilege.get-system" |
    "execution.shellcode" | "execution.msf" | "execution.msf-inject">;
  response: () => Buffer;
  assert: (result: {
    pid?: number;
    stdout?: Buffer;
    stderr?: Buffer;
  }) => void;
}

function actionCases(): ActionCase[] {
  const noOutput = () => undefined;
  return [
    {
      operationId: "execution.process",
      response: encodeProcess,
      assert: (result) => {
        expect(result.pid).toBe(42);
        expect(result.stdout?.toString()).toBe("stdout");
        expect(result.stderr?.toString()).toBe("stderr");
      },
    },
    {
      operationId: "execution.assembly",
      response: () => Buffer.from(sliverpb.ExecuteAssembly.encode(sliverpb.ExecuteAssembly.fromPartial({
        Output: Buffer.from("assembly-output"),
      })).finish()),
      assert: (result) => expect(result.stdout?.toString()).toBe("assembly-output"),
    },
    {
      operationId: "execution.sideload",
      response: () => Buffer.from(sliverpb.Sideload.encode(sliverpb.Sideload.fromPartial({
        Result: "sideload-output",
        Response: envelope(),
      })).finish()),
      assert: (result) => expect(result.stdout?.toString()).toBe("sideload-output"),
    },
    {
      operationId: "execution.spawn-dll",
      response: () => Buffer.from(sliverpb.SpawnDll.encode(sliverpb.SpawnDll.fromPartial({
        Result: "spawn-output",
      })).finish()),
      assert: (result) => expect(result.stdout?.toString()).toBe("spawn-output"),
    },
    {
      operationId: "execution.migrate",
      response: () => Buffer.from(sliverpb.Migrate.encode(sliverpb.Migrate.fromPartial({
        Success: true,
        Pid: 9001,
      })).finish()),
      assert: (result) => expect(result.pid).toBe(9001),
    },
    {
      operationId: "privilege.run-as",
      response: () => Buffer.from(sliverpb.RunAs.encode(sliverpb.RunAs.fromPartial({
        Output: "run-as-output",
      })).finish()),
      assert: (result) => expect(result.stdout?.toString()).toBe("run-as-output"),
    },
    {
      operationId: "privilege.make-token",
      response: () => Buffer.from(sliverpb.MakeToken.encode(sliverpb.MakeToken.fromPartial({})).finish()),
      assert: noOutput,
    },
    {
      operationId: "privilege.impersonate",
      response: () => Buffer.from(sliverpb.Impersonate.encode(sliverpb.Impersonate.fromPartial({})).finish()),
      assert: noOutput,
    },
    {
      operationId: "privilege.revert",
      response: () => Buffer.from(sliverpb.RevToSelf.encode(sliverpb.RevToSelf.fromPartial({})).finish()),
      assert: noOutput,
    },
  ];
}

function encodeProcess(): Buffer {
  return Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.fromPartial({
    Pid: 42,
    Stdout: Buffer.from("stdout"),
    Stderr: Buffer.from("stderr"),
  })).finish());
}

function encodeChildren(): Buffer {
  return Buffer.from(sliverpb.ExecuteChildren.encode(sliverpb.ExecuteChildren.fromPartial({
    Children: [
      {
        Pid: 11,
        Path: "/bin/one",
        Args: ["--one"],
        StartTime: "1786755723",
        Exited: false,
        Stdout: "abc",
        Stderr: "é",
      },
      {
        Pid: 12,
        Path: "/bin/two",
        Args: [],
        Exited: true,
        ExitCode: 0,
        ExitTime: "1786755724",
      },
    ],
    Response: envelope(),
  })).finish());
}

function encodePrivileges(): Buffer {
  return Buffer.from(sliverpb.GetPrivs.encode(sliverpb.GetPrivs.fromPartial({
    ProcessName: "agent.exe",
    ProcessIntegrity: "High",
    PrivInfo: [{
      Name: "SeDebugPrivilege",
      Description: "Debug programs",
      Enabled: true,
      EnabledByDefault: false,
      Removed: false,
      UsedForAccess: true,
    }],
    Response: envelope(),
  })).finish());
}

function envelope(overrides: Partial<commonpb.Response> = {}): commonpb.Response {
  return commonpb.Response.fromPartial(overrides);
}

function isZero(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0);
}
