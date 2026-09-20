import {
  AZURE_SSH_PORT,
  isUuidV4,
  type CloudDeploymentStatus,
  type CloudProvider,
} from "./cloud-deployment-contracts.js";
import type {
  ApplicationSettingsState,
  ApplicationSettingsUpdateInput,
} from "./application-settings-contracts.js";
import type { OperationResult } from "./contracts.js";
import type { TerminalRuntimeAsset } from "./stream-contracts.js";
import {
  TERMINAL_TAB_LABEL_MAX_LENGTH,
  isTerminalTabLabel,
} from "./terminal-tab-label.js";

export const SSH_PROTOCOL_VERSION = 1 as const;
export const SSH_MAX_TABS_PER_WINDOW = 10 as const;
export const SSH_TAB_LABEL_MAX_LENGTH = TERMINAL_TAB_LABEL_MAX_LENGTH;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_HOST_LENGTH = 255;
const MAX_USERNAME_LENGTH = 128;

export interface ManagedSshTarget {
  readonly deploymentId: string;
  readonly name: string;
  readonly provider: CloudProvider;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly status: CloudDeploymentStatus;
  readonly connectable: boolean;
  readonly unavailableReason?: string;
}

export interface SshTabLaunchContext {
  readonly tabId: string;
  readonly attachmentToken: string;
  readonly label: string;
  readonly target: ManagedSshTarget;
}

export interface SshWindowLaunchContext {
  readonly kind: "ssh";
  readonly shortcutModifier: "Command" | "Control";
  readonly tabs: readonly SshTabLaunchContext[];
  readonly activeTabId?: string;
}

export interface SshDeploymentInput {
  readonly deploymentId: string;
}

export interface SshTabInput {
  readonly tabId: string;
}

export interface SshTabRenameInput extends SshTabInput {
  readonly label: string;
}

export interface SshTabRenameResult {
  readonly tabId: string;
  readonly label: string;
}

export interface SshTabCloseResult {
  readonly remainingTabs: number;
}

export interface SshHostKeyReview {
  readonly token: string;
  readonly deploymentId: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly expiresAt: string;
}

export interface SshHostKeyReviewInput {
  readonly token: string;
}

export type SshOpenTabResult =
  | {
      readonly status: "opened";
      readonly tabId: string;
      readonly created: boolean;
      readonly context?: SshTabLaunchContext;
    }
  | {
      readonly status: "host-key-review";
      readonly review: SshHostKeyReview;
    };

export interface SshAttachRequest {
  readonly v: typeof SSH_PROTOCOL_VERSION;
  readonly attachmentToken: string;
}

export interface SshWindowAPI {
  claimSshWindow(): Promise<OperationResult<SshWindowLaunchContext>>;
  listSshTargets(): Promise<OperationResult<readonly ManagedSshTarget[]>>;
  createSshTab(input: SshDeploymentInput): Promise<OperationResult<SshOpenTabResult>>;
  reattachSshTab(input: SshTabInput): Promise<OperationResult<SshTabLaunchContext>>;
  approveSshHostKey(input: SshHostKeyReviewInput): Promise<OperationResult<SshOpenTabResult>>;
  closeSshTab(input: SshTabInput): Promise<OperationResult<SshTabCloseResult>>;
  selectSshTab(input: SshTabInput): Promise<OperationResult>;
  copySshCommand(input: SshTabInput): Promise<OperationResult>;
  renameSshTab(input: SshTabRenameInput): Promise<OperationResult<SshTabRenameResult>>;
  getTerminalRuntime(): Promise<OperationResult<TerminalRuntimeAsset>>;
  getApplicationSettings(): Promise<ApplicationSettingsState>;
  updateApplicationSettings(input: ApplicationSettingsUpdateInput): Promise<OperationResult<ApplicationSettingsState>>;
  openSshStream(attachmentToken: string, correlationId: string): void;
  onSshNewTabRequested(listener: () => void): () => void;
  onSshCloseTabRequested(listener: () => void): () => void;
  onSshSelectTabRequested(listener: (index: number) => void): () => void;
  onSshSettingsRequested(listener: () => void): () => void;
  onSshTabOpened(listener: (context: SshTabLaunchContext) => void): () => void;
  onApplicationSettingsChanged(listener: (state: ApplicationSettingsState) => void): () => void;
}

export function isOpaqueSshId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

export function parseSshDeploymentInput(value: unknown): SshDeploymentInput {
  const record = requireExactRecord(value, ["deploymentId"], "SSH deployment request");
  if (!isUuidV4(record["deploymentId"])) invalid("SSH deployment identity is invalid");
  return Object.freeze({ deploymentId: record["deploymentId"] });
}

export function parseSshTabInput(value: unknown): SshTabInput {
  const record = requireExactRecord(value, ["tabId"], "SSH tab request");
  return Object.freeze({ tabId: requireOpaqueId(record["tabId"], "SSH tab identity") });
}

export function parseSshTabRenameInput(value: unknown): SshTabRenameInput {
  const record = requireExactRecord(value, ["tabId", "label"], "SSH tab rename request");
  return Object.freeze({
    tabId: requireOpaqueId(record["tabId"], "SSH tab identity"),
    label: requireTerminalTabLabel(record["label"], "SSH tab label"),
  });
}

export function parseSshTabRenameResult(value: unknown): SshTabRenameResult {
  const record = requireExactRecord(value, ["tabId", "label"], "SSH tab rename result");
  return Object.freeze({
    tabId: requireOpaqueId(record["tabId"], "SSH tab identity"),
    label: requireTerminalTabLabel(record["label"], "SSH tab label"),
  });
}

export function parseSshTabId(value: unknown): string {
  return requireOpaqueId(value, "SSH tab identity");
}

export function parseSshHostKeyReviewInput(value: unknown): SshHostKeyReviewInput {
  const record = requireExactRecord(value, ["token"], "SSH host-key review request");
  return Object.freeze({ token: requireOpaqueId(record["token"], "SSH host-key review token") });
}

export function parseSshHostKeyReview(value: unknown): SshHostKeyReview {
  const record = requireExactRecord(
    value,
    ["token", "deploymentId", "name", "host", "port", "fingerprint", "expiresAt"],
    "SSH host-key review",
  );
  if (!isUuidV4(record["deploymentId"])) invalid("SSH host-key review deployment identity is invalid");
  if (typeof record["fingerprint"] !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(record["fingerprint"])) {
    invalid("SSH host-key review fingerprint is invalid");
  }
  if (typeof record["expiresAt"] !== "string" || !Number.isFinite(Date.parse(record["expiresAt"]))) {
    invalid("SSH host-key review expiry is invalid");
  }
  return Object.freeze({
    token: requireOpaqueId(record["token"], "SSH host-key review token"),
    deploymentId: record["deploymentId"],
    name: requirePlainString(record["name"], "SSH host-key review name", 1, SSH_TAB_LABEL_MAX_LENGTH),
    host: requirePlainString(record["host"], "SSH host-key review host", 1, MAX_HOST_LENGTH),
    port: requireInteger(record["port"], "SSH host-key review port", 1, 65_535),
    fingerprint: record["fingerprint"],
    expiresAt: record["expiresAt"],
  });
}

export function parseSshOpenTabResult(value: unknown): SshOpenTabResult {
  const record = requireRecord(value, "SSH open-tab result");
  if (record["status"] === "host-key-review") {
    requireExactKeys(record, ["status", "review"], "SSH open-tab result");
    return Object.freeze({ status: "host-key-review", review: parseSshHostKeyReview(record["review"]) });
  }
  if (record["status"] !== "opened") invalid("SSH open-tab result status is invalid");
  const optional = record["context"] === undefined ? [] : ["context"];
  requireExactKeys(record, ["status", "tabId", "created", ...optional], "SSH open-tab result");
  if (typeof record["created"] !== "boolean") invalid("SSH open-tab result creation state is invalid");
  return Object.freeze({
    status: "opened",
    tabId: requireOpaqueId(record["tabId"], "SSH tab identity"),
    created: record["created"],
    ...(record["context"] === undefined ? {} : { context: parseSshTabLaunchContext(record["context"]) }),
  });
}

export function parseSshTabShortcutIndex(value: unknown): number {
  return requireInteger(value, "SSH tab shortcut index", 0, SSH_MAX_TABS_PER_WINDOW - 1);
}

export function parseSshAttachRequest(value: unknown): SshAttachRequest {
  const record = requireExactRecord(value, ["v", "attachmentToken"], "SSH attachment request");
  if (record["v"] !== SSH_PROTOCOL_VERSION) invalid("SSH attachment protocol is unsupported");
  return Object.freeze({
    v: SSH_PROTOCOL_VERSION,
    attachmentToken: requireOpaqueId(record["attachmentToken"], "SSH attachment token"),
  });
}

export function parseManagedSshTarget(value: unknown): ManagedSshTarget {
  const record = requireRecord(value, "managed SSH target");
  const optional = record["unavailableReason"] === undefined ? [] : ["unavailableReason"];
  requireExactKeys(
    record,
    ["deploymentId", "name", "provider", "host", "port", "username", "status", "connectable", ...optional],
    "managed SSH target",
  );
  if (!isUuidV4(record["deploymentId"])) invalid("managed SSH target deployment identity is invalid");
  const provider = record["provider"];
  if (provider !== "aws" && provider !== "azure") invalid("managed SSH target provider is invalid");
  const port = requireInteger(record["port"], "managed SSH target port", 1, 65_535);
  if (provider === "azure" && port !== AZURE_SSH_PORT) {
    invalid(`managed Azure SSH target port must be ${AZURE_SSH_PORT}`);
  }
  const status = record["status"];
  if (!isCloudDeploymentStatus(status)) invalid("managed SSH target status is invalid");
  if (typeof record["connectable"] !== "boolean") invalid("managed SSH target availability is invalid");
  const unavailableReason = record["unavailableReason"];
  if (
    (record["connectable"] && unavailableReason !== undefined) ||
    (!record["connectable"] && !boundedPlainString(unavailableReason, 1, 512))
  ) invalid("managed SSH target availability reason is invalid");
  const parsedUnavailableReason = typeof unavailableReason === "string"
    ? unavailableReason
    : undefined;
  return Object.freeze({
    deploymentId: record["deploymentId"],
    name: requireTerminalTabLabel(record["name"], "managed SSH target name"),
    provider,
    host: requirePlainString(record["host"], "managed SSH target host", 0, MAX_HOST_LENGTH),
    port,
    username: requirePlainString(record["username"], "managed SSH target username", 1, MAX_USERNAME_LENGTH),
    status,
    connectable: record["connectable"],
    ...(parsedUnavailableReason === undefined ? {} : { unavailableReason: parsedUnavailableReason }),
  });
}

export function parseSshTabLaunchContext(value: unknown): SshTabLaunchContext {
  const record = requireExactRecord(
    value,
    ["tabId", "attachmentToken", "label", "target"],
    "SSH tab launch context",
  );
  return Object.freeze({
    tabId: requireOpaqueId(record["tabId"], "SSH tab identity"),
    attachmentToken: requireOpaqueId(record["attachmentToken"], "SSH attachment token"),
    label: requireTerminalTabLabel(record["label"], "SSH tab label"),
    target: parseManagedSshTarget(record["target"]),
  });
}

export function parseSshWindowLaunchContext(value: unknown): SshWindowLaunchContext {
  const record = requireRecord(value, "SSH window launch context");
  const optional = record["activeTabId"] === undefined ? [] : ["activeTabId"];
  requireExactKeys(record, ["kind", "shortcutModifier", "tabs", ...optional], "SSH window launch context");
  if (record["kind"] !== "ssh") invalid("SSH window kind is invalid");
  const shortcutModifier = record["shortcutModifier"];
  if (shortcutModifier !== "Command" && shortcutModifier !== "Control") {
    invalid("SSH window shortcut modifier is invalid");
  }
  if (!Array.isArray(record["tabs"]) || record["tabs"].length > SSH_MAX_TABS_PER_WINDOW) {
    invalid("SSH window tabs are invalid");
  }
  const tabs = Object.freeze(record["tabs"].map(parseSshTabLaunchContext));
  if (new Set(tabs.map(({ tabId }) => tabId)).size !== tabs.length) invalid("SSH window tab identities are duplicated");
  const activeTabId = record["activeTabId"] === undefined
    ? undefined
    : requireOpaqueId(record["activeTabId"], "active SSH tab identity");
  if (activeTabId !== undefined && !tabs.some(({ tabId }) => tabId === activeTabId)) {
    invalid("active SSH tab is unavailable");
  }
  return Object.freeze({
    kind: "ssh",
    shortcutModifier,
    tabs,
    ...(activeTabId === undefined ? {} : { activeTabId }),
  });
}

function isCloudDeploymentStatus(value: unknown): value is CloudDeploymentStatus {
  return value === "provisioning" || value === "running" || value === "stopped" ||
    value === "deleting" || value === "failed";
}

function requireExactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const record = requireRecord(value, label);
  requireExactKeys(record, keys, label);
  return record;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    invalid(`${label} has an invalid shape`);
  }
}

function requireOpaqueId(value: unknown, label: string): string {
  if (!isOpaqueSshId(value)) invalid(`${label} is invalid`);
  return value;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${label} is invalid`);
  }
  return value as number;
}

function requirePlainString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (!boundedPlainString(value, minimum, maximum)) invalid(`${label} is invalid`);
  return value;
}

function requireTerminalTabLabel(value: unknown, label: string): string {
  if (!isTerminalTabLabel(value)) invalid(`${label} is invalid`);
  return value;
}

function boundedPlainString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function invalid(message: string): never {
  throw new TypeError(message);
}
