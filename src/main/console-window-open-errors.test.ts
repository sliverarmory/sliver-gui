import { describe, expect, it } from "vitest";

import {
  CONSOLE_WINDOW_OPEN_FAILURE_KINDS,
  consoleWindowOpenError,
  type ConsoleWindowOpenFailureKind,
} from "./console-window-open-errors.js";

const references = {
  "application-stopping": "CONSOLE_OPEN_APPLICATION_STOPPING",
  "source-changed": "CONSOLE_OPEN_SOURCE_CHANGED",
  "connection-inspection-failed": "CONSOLE_OPEN_CONNECTION_CHECK_FAILED",
  "connection-required": "CONSOLE_OPEN_CONNECTION_REQUIRED",
  "window-restore-failed": "CONSOLE_OPEN_WINDOW_RESTORE_FAILED",
  "window-create-failed": "CONSOLE_OPEN_WINDOW_CREATE_FAILED",
  "window-register-failed": "CONSOLE_OPEN_WINDOW_REGISTER_FAILED",
  "renderer-load-failed": "CONSOLE_OPEN_RENDERER_LOAD_FAILED",
} satisfies Record<ConsoleWindowOpenFailureKind, string>;

describe("console window open errors", () => {
  it("provides a unique stable reference and recovery guidance for every failure kind", () => {
    const actualReferences = CONSOLE_WINDOW_OPEN_FAILURE_KINDS.map((kind) => {
      const error = consoleWindowOpenError(kind);
      const match = /^(.*?) Reference: (CONSOLE_OPEN_[A-Z_]+)$/u.exec(error);
      expect(match?.[1]?.trim().length, kind).toBeGreaterThan(0);
      expect(match?.[2], kind).toBe(references[kind]);
      return match?.[2];
    });
    expect(new Set(actualReferences).size).toBe(CONSOLE_WINDOW_OPEN_FAILURE_KINDS.length);
  });
});
