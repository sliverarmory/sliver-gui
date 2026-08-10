// @vitest-environment node

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  SESSION_DESTRUCTIVE_ACTION_IDS,
  SESSION_EDITOR_MAX_BYTES,
  SESSION_WORKBENCH_ARTIFACT_IDS,
  SESSION_WORKBENCH_MAX_ARTIFACT_BYTES,
  type SessionCapturedArtifactResult,
  type SessionDestructiveActionPlan,
  type SessionDestructiveActionPreparation,
  type SessionNativeOpenUploadResult,
  type SessionNativeSaveResult,
  type SessionStagedEditorArtifactResult,
  type SessionWorkbenchInvocationResult,
  type SessionWorkbenchResult,
  parseExecuteSessionDestructiveActionPlanInput,
  parsePrepareSessionDestructiveActionInput,
  parseSessionWorkbenchInput,
  redactSessionEnvironment,
  sessionOperationSupportsPlatform,
} from "./session-contracts.js";

describe("session workbench contracts", () => {
  it("keeps native artifact operations closed, bounded, and free of local paths", () => {
    expect(SESSION_WORKBENCH_ARTIFACT_IDS).toEqual([
      "session.screenshot.capture",
      "session.artifact.save",
      "session.filesystem.download",
      "session.filesystem.upload-open",
      "session.filesystem.stage-text",
      "session.filesystem.stage-hex",
      "session.process.dump",
      "session.registry.read-hive",
    ]);
    expect(SESSION_WORKBENCH_MAX_ARTIFACT_BYTES).toBe(64 * 1_024 * 1_024);

    expect(parseSessionWorkbenchInput({ operationId: "session.screenshot.capture" })).toEqual({
      operationId: "session.screenshot.capture",
    });
    expect(parseSessionWorkbenchInput({
      operationId: "session.filesystem.upload-open",
      remotePath: "/tmp/agent.bin",
      isIOC: false,
      isDirectory: false,
      overwrite: false,
    })).toEqual({
      operationId: "session.filesystem.upload-open",
      remotePath: "/tmp/agent.bin",
      isIOC: false,
      isDirectory: false,
      overwrite: false,
    });

    expect(() => parseSessionWorkbenchInput({
      operationId: "session.filesystem.download",
      path: "/tmp/report.txt",
      maxBytes: SESSION_WORKBENCH_MAX_ARTIFACT_BYTES + 1,
    })).toThrow(/maxBytes/u);
    expect(() => parseSessionWorkbenchInput({
      operationId: "session.filesystem.download",
      path: "/tmp/report.txt",
      maxBytes: 1,
      destination: "loot",
    })).toThrow(/Unexpected session input field/u);
    expect(() => parseSessionWorkbenchInput({
      operationId: "session.filesystem.upload-open",
      sourcePath: "/Users/operator/secret.bin",
      remotePath: "/tmp/secret.bin",
      isIOC: false,
      isDirectory: false,
      overwrite: false,
    })).toThrow(/Unexpected session input field/u);
    expect(() => parseSessionWorkbenchInput({
      operationId: "session.filesystem.upload-open",
      sourceHandle: "A".repeat(43),
      remotePath: "/tmp/secret.bin",
      isIOC: false,
      isDirectory: false,
      overwrite: false,
    })).toThrow(/Unexpected session input field/u);
    expect(() => parseSessionWorkbenchInput({
      operationId: "session.filesystem.upload-open",
      remotePath: "/tmp/archive",
      isIOC: false,
      isDirectory: true,
      overwrite: false,
    })).toThrow(/isDirectory must be false/u);
  });

  it("keeps editor reads and staging closed to 64 KiB payloads", () => {
    expect(SESSION_EDITOR_MAX_BYTES).toBe(64 * 1_024);
    for (const operationId of [
      "session.filesystem.cat",
      "session.filesystem.head",
      "session.filesystem.tail",
      "session.filesystem.read-hex",
    ] as const) {
      expect(parseSessionWorkbenchInput({
        operationId,
        path: "/tmp/report.txt",
        maxBytes: SESSION_EDITOR_MAX_BYTES,
      })).toEqual({ operationId, path: "/tmp/report.txt", maxBytes: SESSION_EDITOR_MAX_BYTES });
      expect(() => parseSessionWorkbenchInput({
        operationId,
        path: "/tmp/report.txt",
        maxBytes: SESSION_EDITOR_MAX_BYTES + 1,
      })).toThrow(/maxBytes/u);
      expect(() => parseSessionWorkbenchInput({ operationId, path: "", maxBytes: 1 })).toThrow(/path/u);
    }

    const maximumText = "a".repeat(SESSION_EDITOR_MAX_BYTES);
    expect(parseSessionWorkbenchInput({
      operationId: "session.filesystem.stage-text",
      content: maximumText,
      encoding: "utf-8",
    })).toEqual({ operationId: "session.filesystem.stage-text", content: maximumText, encoding: "utf-8" });
    expect(parseSessionWorkbenchInput({
      operationId: "session.filesystem.stage-text",
      content: "",
      encoding: "utf-8",
    })).toEqual({ operationId: "session.filesystem.stage-text", content: "", encoding: "utf-8" });
    expect(() => parseSessionWorkbenchInput({
      operationId: "session.filesystem.stage-text",
      content: "€".repeat(Math.floor(SESSION_EDITOR_MAX_BYTES / 3) + 1),
      encoding: "utf-8",
    })).toThrow(/UTF-8 bytes/u);
    expect(() => parseSessionWorkbenchInput({
      operationId: "session.filesystem.stage-text",
      content: "unpaired\ud800",
      encoding: "utf-8",
    })).toThrow(/valid UTF-8/u);

    expect(parseSessionWorkbenchInput({
      operationId: "session.filesystem.stage-hex",
      hex: "00A1ff",
    })).toEqual({ operationId: "session.filesystem.stage-hex", hex: "00a1ff" });
    expect(parseSessionWorkbenchInput({ operationId: "session.filesystem.stage-hex", hex: "" })).toEqual({
      operationId: "session.filesystem.stage-hex",
      hex: "",
    });
    expect(() => parseSessionWorkbenchInput({ operationId: "session.filesystem.stage-hex", hex: "abc" }))
      .toThrow(/even-length hexadecimal/u);
    expect(() => parseSessionWorkbenchInput({ operationId: "session.filesystem.stage-hex", hex: "gg" }))
      .toThrow(/even-length hexadecimal/u);
    expect(() => parseSessionWorkbenchInput({
      operationId: "session.filesystem.stage-hex",
      hex: "aa".repeat(SESSION_EDITOR_MAX_BYTES + 1),
    })).toThrow(/at most/u);
    expect(() => parseSessionWorkbenchInput({
      operationId: "session.filesystem.stage-hex",
      hex: "00",
      path: "/renderer/chosen/path",
    })).toThrow(/Unexpected session input field/u);
  });

  it("rejects renderer target selectors and accepts only scoped opaque artifact handles", () => {
    expect(() => parseSessionWorkbenchInput({
      operationId: "session.filesystem.pwd",
      targetId: "renderer-chosen-session",
    })).toThrow(/Unexpected session input field/u);
    expect(() => parseSessionWorkbenchInput({
      operationId: "session.artifact.save",
      handle: "../../operator-file",
    })).toThrow(/valid session artifact handle/u);
    expect(parseSessionWorkbenchInput({
      operationId: "session.artifact.save",
      handle: "A".repeat(43),
    })).toEqual({ operationId: "session.artifact.save", handle: "A".repeat(43) });
  });

  it("supports registry root browsing and the default unnamed value", () => {
    expect(parseSessionWorkbenchInput({
      operationId: "session.registry.read",
      hive: "HKCU",
      path: "",
      key: "",
    })).toEqual({ operationId: "session.registry.read", hive: "HKCU", path: "", key: "" });
    expect(parseSessionWorkbenchInput({
      operationId: "session.registry.list-subkeys",
      hive: "HKLM",
      path: "",
    })).toEqual({ operationId: "session.registry.list-subkeys", hive: "HKLM", path: "" });
    expect(() => parseSessionWorkbenchInput({
      operationId: "session.registry.read-hive",
      rootHive: "HKLM",
      requestedHive: "",
      maxBytes: 1_024,
    })).toThrow(/requestedHive/u);
    expect(() => parseSessionWorkbenchInput({
      operationId: "session.registry.read-hive",
      rootHive: "HKLM",
      requestedHive: "SAM",
      maxBytes: 1_024,
      path: "",
    })).toThrow(/Unexpected session input field/u);
  });

  it("redacts sensitive environment names while preserving ordinary values", () => {
    expect(redactSessionEnvironment([
      { name: "PATH", value: "/usr/bin" },
      { name: "API_TOKEN", value: "do-not-render" },
      { name: "DATABASE_PASSWORD", value: "do-not-render-either" },
    ])).toEqual([
      { name: "PATH", value: "/usr/bin", sensitive: false, redacted: false },
      { name: "API_TOKEN", sensitive: true, redacted: true },
      { name: "DATABASE_PASSWORD", sensitive: true, redacted: true },
    ]);
  });

  it("enforces the audited platform matrix", () => {
    expect(sessionOperationSupportsPlatform("session.filesystem.memfiles.list", "linux")).toBe(true);
    expect(sessionOperationSupportsPlatform("session.filesystem.memfiles.list", "windows")).toBe(false);
    expect(sessionOperationSupportsPlatform("session.filesystem.chmod", "darwin")).toBe(false);
    expect(sessionOperationSupportsPlatform("session.screenshot.capture", "linux")).toBe(true);
    expect(sessionOperationSupportsPlatform("session.screenshot.capture", "windows")).toBe(true);
    expect(sessionOperationSupportsPlatform("session.screenshot.capture", "darwin")).toBe(false);
    expect(sessionOperationSupportsPlatform("session.process.dump", "linux")).toBe(true);
    expect(sessionOperationSupportsPlatform("session.process.dump", "windows")).toBe(true);
    expect(sessionOperationSupportsPlatform("session.registry.read", "linux")).toBe(false);
  });

  it("requires two-phase plans for replacement, recursive, stop, and registry actions", () => {
    expect(SESSION_DESTRUCTIVE_ACTION_IDS).toEqual(expect.arrayContaining([
      "session.filesystem.cp",
      "session.filesystem.mv",
      "session.filesystem.chmod-recursive",
      "session.filesystem.chown-recursive",
      "session.filesystem.upload-overwrite",
      "session.service.stop",
      "session.registry.write",
      "session.registry.create-key",
      "session.registry.delete-key",
    ]));
    expect(parsePrepareSessionDestructiveActionInput({
      actionId: "session.filesystem.upload-overwrite",
      remotePath: "C:\\Temp\\payload.exe",
      isIOC: true,
      isDirectory: false,
      overwrite: true,
    })).toEqual({
      actionId: "session.filesystem.upload-overwrite",
      remotePath: "C:\\Temp\\payload.exe",
      isIOC: true,
      isDirectory: false,
      overwrite: true,
    });
    expect(() => parsePrepareSessionDestructiveActionInput({
      actionId: "session.filesystem.upload-overwrite",
      sourcePath: "/Users/operator/payload.exe",
      remotePath: "C:\\Temp\\payload.exe",
      isIOC: true,
      isDirectory: false,
      overwrite: true,
    })).toThrow(/Unexpected session input field/u);
    expect(() => parsePrepareSessionDestructiveActionInput({
      actionId: "session.filesystem.upload-overwrite",
      remotePath: "C:\\Temp\\directory",
      isIOC: false,
      isDirectory: true,
      overwrite: true,
    })).toThrow(/isDirectory must be false/u);
    expect(() => parseSessionWorkbenchInput({
      operationId: "session.filesystem.chmod",
      path: "/tmp/tree",
      fileMode: "0755",
      recursive: true,
    })).toThrow(/recursive must be false/u);
    expect(() => parsePrepareSessionDestructiveActionInput({
      actionId: "session.registry.write",
      hive: "HKLM",
      path: "Software\\Example",
      key: "Counter",
      value: { type: "qword", value: "18446744073709551616" },
    })).toThrow(/unsigned 64-bit/u);
  });

  it("allows execution by an opaque plan token only", () => {
    expect(parseExecuteSessionDestructiveActionPlanInput({ token: "plan-token" })).toEqual({
      token: "plan-token",
    });
    expect(() => parseExecuteSessionDestructiveActionPlanInput({
      token: "plan-token",
      actionId: "session.process.terminate",
      pid: 42,
    })).toThrow(/Unexpected session input field/u);
  });

  it("binds destructive confirmations to an exact backend and session identity", () => {
    const plan: SessionDestructiveActionPlan = {
      token: "plan-token",
      expiresAt: "2026-08-10T00:00:00.000Z",
      payloadDigest: "a".repeat(64),
      action: { actionId: "session.filesystem.rm", path: "/tmp/file", recursive: false, force: false },
      target: {
        backend: { id: "backend-id", displayName: "Production" },
        sessionId: "session-id",
        fingerprint: "b".repeat(64),
        name: "implant",
        hostname: "host",
        os: "linux",
      },
      warning: "Review this action",
    };

    expect(plan.target).toEqual({
      backend: { id: "backend-id", displayName: "Production" },
      sessionId: "session-id",
      fingerprint: "b".repeat(64),
      name: "implant",
      hostname: "host",
      os: "linux",
    });
  });

  it("distinguishes native-open cancellation from preparation errors", () => {
    const canceled: SessionDestructiveActionPreparation = { status: "canceled" };
    expect(canceled).toEqual({ status: "canceled" });
  });

  it("binds each artifact operation to a closed result shape", () => {
    expectTypeOf<Extract<SessionWorkbenchResult, { operationId: "session.screenshot.capture" }>[
      "value"
    ]>().toEqualTypeOf<SessionCapturedArtifactResult>();
    expectTypeOf<Extract<SessionWorkbenchResult, { operationId: "session.filesystem.download" }>[
      "value"
    ]>().toEqualTypeOf<SessionNativeSaveResult>();
    expectTypeOf<Extract<SessionWorkbenchResult, { operationId: "session.filesystem.upload-open" }>[
      "value"
    ]>().toEqualTypeOf<SessionNativeOpenUploadResult>();
    expectTypeOf<Extract<SessionWorkbenchResult, { operationId: "session.filesystem.stage-text" }>[
      "value"
    ]>().toEqualTypeOf<SessionStagedEditorArtifactResult>();
    expectTypeOf<Extract<SessionWorkbenchResult, { operationId: "session.filesystem.stage-hex" }>[
      "value"
    ]>().toEqualTypeOf<SessionStagedEditorArtifactResult>();
  });

  it("represents confirmed post-dispatch target rejection separately from uncertainty", () => {
    const failed: SessionWorkbenchInvocationResult = {
      status: "failed",
      operationId: "session.filesystem.upload-open",
      message: "The target rejected the upload.",
    };
    expect(failed).toEqual({
      status: "failed",
      operationId: "session.filesystem.upload-open",
      message: "The target rejected the upload.",
    });
  });
});
