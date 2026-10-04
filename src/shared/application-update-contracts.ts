export const APPLICATION_UPDATE_VERSION_MAX_LENGTH = 64 as const;
export const APPLICATION_UPDATE_MESSAGE_MAX_LENGTH = 240 as const;

export type ApplicationUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "trust-required"
  | "available"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "error";

interface ApplicationUpdateStateBase {
  readonly revision: number;
  readonly currentVersion: string;
}

export type ApplicationUpdateState =
  | (ApplicationUpdateStateBase & {
      readonly status: "disabled";
      readonly disabledReason: string;
    })
  | (ApplicationUpdateStateBase & {
      readonly status: "idle";
    })
  | (ApplicationUpdateStateBase & {
      readonly status: "checking";
    })
  | (ApplicationUpdateStateBase & {
      readonly status: "trust-required";
      readonly message: string;
    })
  | (ApplicationUpdateStateBase & {
      readonly status: "available";
      readonly availableVersion: string;
    })
  | (ApplicationUpdateStateBase & {
      readonly status: "downloading";
      readonly availableVersion: string;
      readonly progressPercent: number;
    })
  | (ApplicationUpdateStateBase & {
      readonly status: "ready";
      readonly availableVersion: string;
    })
  | (ApplicationUpdateStateBase & {
      readonly status: "up-to-date";
    })
  | (ApplicationUpdateStateBase & {
      readonly status: "error";
      readonly error: string;
    });

const VERSION_PATTERN = /^v?[0-9][0-9A-Za-z.+-]{0,63}$/u;
const FORBIDDEN_MESSAGE_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\]/u;

export function parseApplicationUpdateState(value: unknown): ApplicationUpdateState {
  const state = requireRecord(value);
  const status = requireStatus(state["status"]);
  const revision = requireRevision(state["revision"]);
  const currentVersion = requireVersion(state["currentVersion"]);

  switch (status) {
    case "disabled": {
      requireExactKeys(state, ["status", "revision", "currentVersion", "disabledReason"]);
      return Object.freeze({
        status,
        revision,
        currentVersion,
        disabledReason: requireMessage(state["disabledReason"]),
      });
    }
    case "idle":
    case "checking":
    case "up-to-date": {
      requireExactKeys(state, ["status", "revision", "currentVersion"]);
      return Object.freeze({ status, revision, currentVersion });
    }
    case "trust-required": {
      requireExactKeys(state, ["status", "revision", "currentVersion", "message"]);
      return Object.freeze({ status, revision, currentVersion, message: requireMessage(state["message"]) });
    }
    case "available":
    case "ready": {
      requireExactKeys(state, ["status", "revision", "currentVersion", "availableVersion"]);
      return Object.freeze({
        status,
        revision,
        currentVersion,
        availableVersion: requireVersion(state["availableVersion"]),
      });
    }
    case "downloading": {
      requireExactKeys(state, [
        "status",
        "revision",
        "currentVersion",
        "availableVersion",
        "progressPercent",
      ]);
      return Object.freeze({
        status,
        revision,
        currentVersion,
        availableVersion: requireVersion(state["availableVersion"]),
        progressPercent: requireProgress(state["progressPercent"]),
      });
    }
    case "error": {
      requireExactKeys(state, ["status", "revision", "currentVersion", "error"]);
      return Object.freeze({
        status,
        revision,
        currentVersion,
        error: requireMessage(state["error"]),
      });
    }
  }
}

export function initialApplicationUpdateIdle(
  currentVersion: string,
  revision = 0,
): ApplicationUpdateState {
  return parseApplicationUpdateState({ status: "idle", revision, currentVersion });
}

export function initialApplicationUpdateDisabled(
  currentVersion: string,
  disabledReason: string,
  revision = 0,
): ApplicationUpdateState {
  return parseApplicationUpdateState({ status: "disabled", revision, currentVersion, disabledReason });
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid application update state");
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  const actual = Object.keys(record);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new TypeError("Invalid application update state");
  }
}

function requireStatus(value: unknown): ApplicationUpdateStatus {
  const statuses: readonly ApplicationUpdateStatus[] = [
    "disabled",
    "idle",
    "checking",
    "trust-required",
    "available",
    "downloading",
    "ready",
    "up-to-date",
    "error",
  ];
  if (typeof value !== "string" || !statuses.includes(value as ApplicationUpdateStatus)) {
    throw new TypeError("Invalid application update state");
  }
  return value as ApplicationUpdateStatus;
}

function requireRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Invalid application update state");
  }
  return value;
}

function requireVersion(value: unknown): string {
  if (typeof value !== "string" || value.length > APPLICATION_UPDATE_VERSION_MAX_LENGTH || !VERSION_PATTERN.test(value)) {
    throw new TypeError("Invalid application update state");
  }
  return value;
}

function requireProgress(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new TypeError("Invalid application update state");
  }
  return value;
}

function requireMessage(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > APPLICATION_UPDATE_MESSAGE_MAX_LENGTH ||
    FORBIDDEN_MESSAGE_PATTERN.test(value) ||
    value.includes("://")
  ) {
    throw new TypeError("Invalid application update state");
  }
  return value;
}
