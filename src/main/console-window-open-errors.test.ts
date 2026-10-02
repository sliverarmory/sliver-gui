import { describe, expect, it } from "vitest";

import {
  CONSOLE_WINDOW_OPEN_FAILURE_KINDS,
  consoleWindowOpenError,
} from "./console-window-open-errors.js";

describe("console window open errors", () => {
  it("provides a unique stable reference and recovery guidance for every failure kind", () => {
    const errors = CONSOLE_WINDOW_OPEN_FAILURE_KINDS.map(consoleWindowOpenError);
    const references = errors.map((error) => {
      const match = /Reference: (CONSOLE_OPEN_[A-Z_]+)$/u.exec(error);
      expect(match, error).not.toBeNull();
      return match?.[1];
    });

    expect(new Set(references).size).toBe(CONSOLE_WINDOW_OPEN_FAILURE_KINDS.length);
    expect(errors).toMatchInlineSnapshot(`
      [
        "Sliver Desktop is shutting down. Reopen the app before starting a console. Reference: CONSOLE_OPEN_APPLICATION_STOPPING",
        "The source window changed before its console could be opened. Try again from the active workspace. Reference: CONSOLE_OPEN_SOURCE_CHANGED",
        "Sliver Desktop could not verify the active server connection. Reconnect, then try again. Reference: CONSOLE_OPEN_CONNECTION_CHECK_FAILED",
        "Connect to a Sliver server before opening its console. Reference: CONSOLE_OPEN_CONNECTION_REQUIRED",
        "The existing Sliver console window could not be restored. Try opening the console again. Reference: CONSOLE_OPEN_WINDOW_RESTORE_FAILED",
        "Sliver Desktop could not create the console window. Restart Sliver Desktop, then try again. Reference: CONSOLE_OPEN_WINDOW_CREATE_FAILED",
        "Sliver Desktop could not initialize the console window. Try again, or restart Sliver Desktop if the problem continues. Reference: CONSOLE_OPEN_WINDOW_REGISTER_FAILED",
        "The console interface could not be loaded. Restart Sliver Desktop, then try again. Reference: CONSOLE_OPEN_RENDERER_LOAD_FAILED",
      ]
    `);
  });
});
