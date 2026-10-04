// @vitest-environment node

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { SESSION_EDITOR_MAX_BYTES } from "../shared/session-contracts.js";
import {
  SessionFileEditConflictError,
  SessionFileEditPreflightError,
  verifySessionFileEditPrecondition,
} from "./session-file-edit.js";

describe("verifySessionFileEditPrecondition", () => {
  it("verifies the exact full-file digest and clears returned bytes", async () => {
    const bytes = Buffer.from("reviewed content", "utf8");
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const client = {
      downloadFileSession: vi.fn(async () => ({
        Exists: true,
        IsDir: false,
        Data: bytes,
        Response: { Err: "" },
      })),
    };

    await expect(verifySessionFileEditPrecondition(
      client as never,
      "session-1",
      "/tmp/file.txt",
      expectedSha256,
    )).resolves.toBeUndefined();
    expect(client.downloadFileSession).toHaveBeenCalledWith("session-1", "/tmp/file.txt", {
      maxBytes: SESSION_EDITOR_MAX_BYTES + 1,
      fromEnd: false,
    });
    expect(bytes.every((value) => value === 0)).toBe(true);
  });

  it("fails closed for changed, oversized, missing, directory, and target-rejected content", async () => {
    const expectedSha256 = "0".repeat(64);
    const cases = [
      { Exists: true, IsDir: false, Data: Buffer.from("changed"), Response: { Err: "" }, error: SessionFileEditConflictError },
      { Exists: true, IsDir: false, Data: Buffer.alloc(SESSION_EDITOR_MAX_BYTES + 1, 7), Response: { Err: "" }, error: SessionFileEditConflictError },
      { Exists: false, IsDir: false, Data: Buffer.from("secret"), Response: { Err: "" }, error: SessionFileEditPreflightError },
      { Exists: true, IsDir: true, Data: Buffer.from("secret"), Response: { Err: "" }, error: SessionFileEditPreflightError },
      { Exists: true, IsDir: false, Data: Buffer.from("secret"), Response: { Err: "TOP-SECRET /remote/path" }, error: SessionFileEditPreflightError },
    ];

    for (const testCase of cases) {
      const client = { downloadFileSession: vi.fn(async () => testCase) };
      const promise = verifySessionFileEditPrecondition(
        client as never,
        "session-1",
        "/tmp/file.txt",
        expectedSha256,
      );
      await expect(promise).rejects.toBeInstanceOf(testCase.error);
      await expect(promise).rejects.not.toThrow(/TOP-SECRET|remote\/path/u);
      expect(testCase.Data.every((value) => value === 0)).toBe(true);
    }
  });

  it("rejects malformed expected digests before dispatch", async () => {
    const client = { downloadFileSession: vi.fn() };
    await expect(verifySessionFileEditPrecondition(
      client as never,
      "session-1",
      "/tmp/file.txt",
      "ABC",
    )).rejects.toThrow(/lowercase SHA-256/u);
    expect(client.downloadFileSession).not.toHaveBeenCalled();
  });
});
