import { describe, expect, it } from "vitest";
import {
  EXECUTION_OPERATION_IDS,
  parseAddExecutionOutputToLootInput,
  parseExecuteExecutionPlanInput,
  parseExecutionActionDraft,
  parsePrepareExecutionActionInput,
  parseReadExecutionOutputInput,
  parseRunExecutionReadInput,
  parseSaveExecutionResultInput,
} from "./execution-contracts.js";

describe("execution contracts", () => {
  it("keeps every M4 operation in a closed unique inventory", () => {
    expect(new Set(EXECUTION_OPERATION_IDS).size).toBe(19);
    expect(EXECUTION_OPERATION_IDS).toContain("execution.psexec");
    expect(EXECUTION_OPERATION_IDS).toContain("privilege.get-system");
  });

  it("parses bounded read requests and rejects mutating IDs", () => {
    expect(parseRunExecutionReadInput({ operationId: "execution.children", limit: 25 })).toEqual({
      operationId: "execution.children",
      limit: 25,
    });
    expect(parseRunExecutionReadInput({
      operationId: "privilege.get",
      taskId: "task_m4_read_1",
      cursor: "execution-read:v1:privilege.get:100",
    })).toEqual({
      operationId: "privilege.get",
      taskId: "task_m4_read_1",
      cursor: "execution-read:v1:privilege.get:100",
    });
    expect(() => parseRunExecutionReadInput({ operationId: "execution.process" })).toThrow(/allowed execution read/u);
    expect(() => parseRunExecutionReadInput({ operationId: "privilege.get", extra: true })).toThrow(/unexpected/u);
  });

  it("enforces execute background, environment, and Windows-branch invariants", () => {
    const base = {
      operationId: "execution.process",
      path: "/usr/bin/id",
      args: ["-u"],
      captureOutput: true,
      background: false,
      inheritEnvironment: false,
      environment: [{ name: "LANG", value: "C" }],
      useToken: false,
      hideWindow: false,
      timeoutSeconds: 60,
    };
    expect(parseExecutionActionDraft(base)).toEqual(base);
    expect(() => parseExecutionActionDraft({ ...base, background: true })).toThrow(/cannot capture/u);
    expect(() => parseExecutionActionDraft({ ...base, useToken: true })).toThrow(/cannot include environment/u);
    expect(() => parseExecutionActionDraft({ ...base, environment: [{ name: "A=B", value: "x" }] })).toThrow(/environment names/u);
  });

  it("requires exact assembly and migrate preconditions", () => {
    const assembly = {
      operationId: "execution.assembly",
      args: [],
      process: "notepad.exe",
      isDll: true,
      architecture: "x84",
      processArgs: [],
      inProcess: false,
      amsiBypass: false,
      etwBypass: false,
      timeoutSeconds: 60,
    };
    expect(() => parseExecutionActionDraft(assembly)).toThrow(/className and method/u);
    expect(parseExecutionActionDraft({ ...assembly, className: "Example.Type", method: "Run" })).toMatchObject({
      operationId: "execution.assembly",
      className: "Example.Type",
      method: "Run",
    });
    expect(() => parseExecutionActionDraft({
      operationId: "execution.migrate",
      pid: 42,
      processName: "explorer.exe",
      timeoutSeconds: 60,
    })).toThrow(/exactly one/u);
  });

  it("clones credential bytes and rejects unknown credential shapes", () => {
    const password = new Uint8Array([115, 101, 99, 114, 101, 116]);
    const prepared = parsePrepareExecutionActionInput({
      draft: {
        operationId: "privilege.make-token",
        username: "operator",
        domain: "LAB",
        password,
        logonType: "new-credentials",
        timeoutSeconds: 60,
      },
    });
    expect(prepared.draft.operationId).toBe("privilege.make-token");
    if (prepared.draft.operationId !== "privilege.make-token") throw new Error("unexpected draft");
    expect(prepared.draft.password).not.toBe(password);
    expect([...prepared.draft.password]).toEqual([...password]);
    password.fill(0);
    expect([...prepared.draft.password]).not.toEqual([...password]);

    expect(() => parseExecutionActionDraft({
      operationId: "execution.ssh",
      hostname: "server",
      port: 22,
      username: "root",
      command: ["id"],
      authentication: { kind: "agent" },
      timeoutSeconds: 60,
    })).toThrow(/authentication kind/u);
  });

  it("validates every non-secret field before cloning credentials", () => {
    const secretText = "credential-must-not-appear";
    const malformedDrafts = [
      (password: Uint8Array) => ({
        operationId: "execution.ssh",
        hostname: "server",
        port: 22,
        username: "root",
        command: ["id"],
        authentication: { kind: "password", password },
        timeoutSeconds: 0,
      }),
      (password: Uint8Array) => ({
        operationId: "privilege.run-as",
        username: "operator",
        domain: "LAB",
        password,
        process: "cmd.exe",
        args: "/c whoami",
        showWindow: false,
        netOnly: false,
        timeoutSeconds: 0,
      }),
      (password: Uint8Array) => ({
        operationId: "privilege.make-token",
        username: "operator",
        domain: "LAB",
        password,
        logonType: "new-credentials",
        timeoutSeconds: 0,
      }),
    ];

    for (const malformedDraft of malformedDrafts) {
      const password = Uint8Array.from(Buffer.from(secretText, "utf8"));
      let failure: unknown;
      try {
        parseExecutionActionDraft(malformedDraft(password));
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(TypeError);
      expect(String(failure)).not.toContain(secretText);
      // The shared parser never mutates its caller-owned view. IPC owns that
      // raw clone and scrubs it independently at the process boundary.
      expect(Buffer.from(password).toString("utf8")).toBe(secretText);
      password.fill(0);
    }
  });

  it("requires exact opaque result and plan capabilities", () => {
    expect(parseExecuteExecutionPlanInput({ token: "abc_DEF-123" })).toEqual({ token: "abc_DEF-123" });
    expect(parseSaveExecutionResultInput({ requestId: "request_1", stream: "stderr" })).toEqual({
      requestId: "request_1",
      stream: "stderr",
    });
    expect(parseReadExecutionOutputInput({ requestId: "request_1", stream: "combined" })).toEqual({
      requestId: "request_1",
      stream: "combined",
    });
    expect(parseAddExecutionOutputToLootInput({ requestId: "request_1", stream: "stdout", name: "  Report  " })).toEqual({
      requestId: "request_1",
      stream: "stdout",
      name: "Report",
    });
    expect(parseAddExecutionOutputToLootInput({ requestId: "request_1", stream: "stderr", name: "" }).name).toBe("");
    expect(() => parseExecuteExecutionPlanInput({ token: "../escape" })).toThrow(/unsupported/u);
    expect(() => parseSaveExecutionResultInput({ requestId: "request_1", stream: "all" })).toThrow(/stdout/u);
    expect(() => parseReadExecutionOutputInput({ requestId: "request_1", stream: "all" })).toThrow(/stdout/u);
    expect(() => parseReadExecutionOutputInput({ requestId: "request_1", stream: "stdout", targetId: "other" })).toThrow(/unexpected/u);
    expect(() => parseAddExecutionOutputToLootInput({ requestId: "request_1", stream: "stdout", name: "\u001b[31m" })).toThrow(/control/u);
    expect(() => parseAddExecutionOutputToLootInput({ requestId: "request_1", stream: "stdout", name: "x".repeat(257) })).toThrow(/256/u);
    expect(() => parseAddExecutionOutputToLootInput({ requestId: "request_1", stream: "stdout", name: "", path: "/tmp/file" })).toThrow(/unexpected/u);
  });
});
