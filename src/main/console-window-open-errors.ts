export const CONSOLE_WINDOW_OPEN_FAILURE_KINDS = [
  "application-stopping",
  "source-changed",
  "connection-inspection-failed",
  "connection-required",
  "window-restore-failed",
  "window-create-failed",
  "window-register-failed",
  "renderer-load-failed",
] as const;

export type ConsoleWindowOpenFailureKind =
  (typeof CONSOLE_WINDOW_OPEN_FAILURE_KINDS)[number];

interface ConsoleWindowOpenFailureDescription {
  readonly code: `CONSOLE_OPEN_${string}`;
  readonly message: string;
}

const FAILURE_DESCRIPTIONS: Readonly<
  Record<ConsoleWindowOpenFailureKind, ConsoleWindowOpenFailureDescription>
> = Object.freeze({
  "application-stopping": Object.freeze({
    code: "CONSOLE_OPEN_APPLICATION_STOPPING",
    message: "Sliver Desktop is shutting down. Reopen the app before starting a console.",
  }),
  "source-changed": Object.freeze({
    code: "CONSOLE_OPEN_SOURCE_CHANGED",
    message: "The source window changed before its console could be opened. Try again from the active workspace.",
  }),
  "connection-inspection-failed": Object.freeze({
    code: "CONSOLE_OPEN_CONNECTION_CHECK_FAILED",
    message: "Sliver Desktop could not verify the active server connection. Reconnect, then try again.",
  }),
  "connection-required": Object.freeze({
    code: "CONSOLE_OPEN_CONNECTION_REQUIRED",
    message: "Connect to a Sliver server before opening its console.",
  }),
  "window-restore-failed": Object.freeze({
    code: "CONSOLE_OPEN_WINDOW_RESTORE_FAILED",
    message: "The existing Sliver console window could not be restored. Try opening the console again.",
  }),
  "window-create-failed": Object.freeze({
    code: "CONSOLE_OPEN_WINDOW_CREATE_FAILED",
    message: "Sliver Desktop could not create the console window. Restart Sliver Desktop, then try again.",
  }),
  "window-register-failed": Object.freeze({
    code: "CONSOLE_OPEN_WINDOW_REGISTER_FAILED",
    message: "Sliver Desktop could not initialize the console window. Try again, or restart Sliver Desktop if the problem continues.",
  }),
  "renderer-load-failed": Object.freeze({
    code: "CONSOLE_OPEN_RENDERER_LOAD_FAILED",
    message: "The console interface could not be loaded. Restart Sliver Desktop, then try again.",
  }),
});

/**
 * Produce a stable, user-actionable console-open failure without accepting the
 * originating exception. Keeping the exception out of this boundary prevents
 * local paths, configuration material, and native runtime text from crossing
 * IPC into the renderer.
 */
export function consoleWindowOpenError(kind: ConsoleWindowOpenFailureKind): string {
  const description = FAILURE_DESCRIPTIONS[kind];
  return `${description.message} Reference: ${description.code}`;
}
