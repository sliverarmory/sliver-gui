export const APPLICATION_CONTEXT_MENU_VERSION = 1 as const;

export const APPLICATION_CONTEXT_MENU_IPC = Object.freeze({
  menuRequested: "sliver:application-context-menu:requested",
  executeAction: "sliver:application-context-menu:execute-action",
  setOpen: "sliver:application-context-menu:set-open",
  restrictedTarget: "sliver:application-context-menu:restricted-target",
});

export const APPLICATION_CONTEXT_MENU_MAX_ITEMS = 32 as const;
export const APPLICATION_CONTEXT_MENU_MAX_LABEL_LENGTH = 200 as const;
export const APPLICATION_CONTEXT_MENU_MAX_COORDINATE = 1_000_000 as const;

export type ApplicationContextMenuItemKind =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "paste-and-match-style"
  | "delete"
  | "select-all"
  | "replace-misspelling"
  | "open-link"
  | "copy-link"
  | "copy-image"
  | "inspect";

export type ApplicationContextMenuShortcut =
  | "mod+z"
  | "mod+shift+z"
  | "mod+x"
  | "mod+c"
  | "mod+v"
  | "mod+shift+v"
  | "mod+a";

export type ApplicationContextMenuItemVariant = "default" | "danger";

export interface ApplicationContextMenuActionItem {
  readonly type: "action";
  /** Opaque, short-lived capability. It is not a command name. */
  readonly actionId: string;
  /** Stable presentation/suppression key; execution still requires actionId. */
  readonly kind: ApplicationContextMenuItemKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly shortcut?: ApplicationContextMenuShortcut;
  readonly variant?: ApplicationContextMenuItemVariant;
}

export interface ApplicationContextMenuSeparatorItem {
  readonly type: "separator";
}

export type ApplicationContextMenuItem =
  | ApplicationContextMenuActionItem
  | ApplicationContextMenuSeparatorItem;

/**
 * Main-to-renderer model created only from Electron's native context-menu event.
 * Positions are viewport CSS pixels, normalized for the web contents' zoom.
 */
export interface ApplicationContextMenuRequest {
  readonly v: typeof APPLICATION_CONTEXT_MENU_VERSION;
  readonly requestId: string;
  readonly x: number;
  readonly y: number;
  readonly items: readonly ApplicationContextMenuItem[];
}

/** Renderer-to-main request. Payload-bearing action data remains main-owned. */
export interface ApplicationContextMenuActionRequest {
  readonly requestId: string;
  readonly actionId: string;
}

/** Renderer-to-main visibility acknowledgement for one native menu request. */
export interface ApplicationContextMenuVisibilityRequest {
  readonly requestId: string;
  readonly open: boolean;
}

export interface ApplicationContextMenuAPI {
  readonly onMenuRequested: (
    listener: (request: ApplicationContextMenuRequest) => void,
  ) => () => void;
  readonly executeAction: (request: ApplicationContextMenuActionRequest) => Promise<boolean>;
  readonly setOpen: (request: ApplicationContextMenuVisibilityRequest) => Promise<boolean>;
}

const ACTION_ITEM_KEYS = [
  "type",
  "actionId",
  "kind",
  "label",
  "enabled",
  "shortcut",
  "variant",
] as const;
const REQUIRED_ACTION_ITEM_KEYS = ["type", "actionId", "kind", "label", "enabled"] as const;
const REQUEST_KEYS = ["v", "requestId", "x", "y", "items"] as const;
const ACTION_REQUEST_KEYS = ["requestId", "actionId"] as const;
const VISIBILITY_REQUEST_KEYS = ["requestId", "open"] as const;
const CAPABILITY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FORBIDDEN_LABEL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const ITEM_KINDS = new Set<ApplicationContextMenuItemKind>([
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "paste-and-match-style",
  "delete",
  "select-all",
  "replace-misspelling",
  "open-link",
  "copy-link",
  "copy-image",
  "inspect",
]);
const SHORTCUTS = new Set<ApplicationContextMenuShortcut>([
  "mod+z",
  "mod+shift+z",
  "mod+x",
  "mod+c",
  "mod+v",
  "mod+shift+v",
  "mod+a",
]);
const VARIANTS = new Set<ApplicationContextMenuItemVariant>(["default", "danger"]);

export function parseApplicationContextMenuRequest(value: unknown): ApplicationContextMenuRequest {
  const record = requireRecord(value, "request");
  requireExactKeys(record, REQUEST_KEYS, "request");
  if (record["v"] !== APPLICATION_CONTEXT_MENU_VERSION) throw invalid("request");

  const requestId = requireCapabilityId(record["requestId"], "request");
  const x = requireCoordinate(record["x"], "request");
  const y = requireCoordinate(record["y"], "request");
  const rawItems = record["items"];
  if (!Array.isArray(rawItems) || rawItems.length < 1 ||
    rawItems.length > APPLICATION_CONTEXT_MENU_MAX_ITEMS) {
    throw invalid("request");
  }

  const actionIds = new Set<string>();
  const items = rawItems.map((item, index) => {
    const parsed = parseMenuItem(item);
    if (parsed.type === "action") {
      if (actionIds.has(parsed.actionId)) throw invalid("request");
      actionIds.add(parsed.actionId);
    }
    if (
      parsed.type === "separator" &&
      (index === 0 || index === rawItems.length - 1 ||
        (index > 0 && parseItemType(rawItems[index - 1]) === "separator"))
    ) {
      throw invalid("request");
    }
    return parsed;
  });

  return Object.freeze({
    v: APPLICATION_CONTEXT_MENU_VERSION,
    requestId,
    x,
    y,
    items: Object.freeze(items),
  });
}

export function parseApplicationContextMenuActionRequest(
  value: unknown,
): ApplicationContextMenuActionRequest {
  const record = requireRecord(value, "action request");
  requireExactKeys(record, ACTION_REQUEST_KEYS, "action request");
  return Object.freeze({
    requestId: requireCapabilityId(record["requestId"], "action request"),
    actionId: requireCapabilityId(record["actionId"], "action request"),
  });
}

export function parseApplicationContextMenuVisibilityRequest(
  value: unknown,
): ApplicationContextMenuVisibilityRequest {
  const record = requireRecord(value, "visibility request");
  requireExactKeys(record, VISIBILITY_REQUEST_KEYS, "visibility request");
  if (typeof record["open"] !== "boolean") throw invalid("visibility request");
  return Object.freeze({
    requestId: requireCapabilityId(record["requestId"], "visibility request"),
    open: record["open"],
  });
}

function parseMenuItem(value: unknown): ApplicationContextMenuItem {
  const record = requireRecord(value, "request");
  if (record["type"] === "separator") {
    requireExactKeys(record, ["type"], "request");
    return Object.freeze({ type: "separator" });
  }
  if (record["type"] !== "action") throw invalid("request");
  requireAllowedAndRequiredKeys(
    record,
    ACTION_ITEM_KEYS,
    REQUIRED_ACTION_ITEM_KEYS,
    "request",
  );

  const kind = record["kind"];
  const shortcut = record["shortcut"];
  const variant = record["variant"];
  if (typeof kind !== "string" || !ITEM_KINDS.has(kind as ApplicationContextMenuItemKind)) {
    throw invalid("request");
  }
  if (
    shortcut !== undefined &&
    (typeof shortcut !== "string" || !SHORTCUTS.has(shortcut as ApplicationContextMenuShortcut))
  ) {
    throw invalid("request");
  }
  if (
    variant !== undefined &&
    (typeof variant !== "string" || !VARIANTS.has(variant as ApplicationContextMenuItemVariant))
  ) {
    throw invalid("request");
  }
  if (typeof record["enabled"] !== "boolean") throw invalid("request");

  const item: ApplicationContextMenuActionItem = {
    type: "action",
    actionId: requireCapabilityId(record["actionId"], "request"),
    kind: kind as ApplicationContextMenuItemKind,
    label: requireLabel(record["label"]),
    enabled: record["enabled"],
    ...(shortcut === undefined
      ? {}
      : { shortcut: shortcut as ApplicationContextMenuShortcut }),
    ...(variant === undefined
      ? {}
      : { variant: variant as ApplicationContextMenuItemVariant }),
  };
  return Object.freeze(item);
}

function parseItemType(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)["type"];
}

function requireRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(subject);
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  subject: string,
): void {
  const expected = new Set(keys);
  const actual = Object.keys(record);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw invalid(subject);
  }
}

function requireAllowedAndRequiredKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  subject: string,
): void {
  const allowed = new Set(allowedKeys);
  const actual = Object.keys(record);
  if (
    actual.some((key) => !allowed.has(key)) ||
    requiredKeys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw invalid(subject);
  }
}

function requireCapabilityId(value: unknown, subject: string): string {
  if (typeof value !== "string" || !CAPABILITY_ID_PATTERN.test(value)) throw invalid(subject);
  return value;
}

function requireCoordinate(value: unknown, subject: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > APPLICATION_CONTEXT_MENU_MAX_COORDINATE
  ) {
    throw invalid(subject);
  }
  return value;
}

function requireLabel(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > APPLICATION_CONTEXT_MENU_MAX_LABEL_LENGTH ||
    FORBIDDEN_LABEL_PATTERN.test(value)
  ) {
    throw invalid("request");
  }
  return value;
}

function invalid(subject: string): TypeError {
  return new TypeError(`Invalid application context menu ${subject}`);
}
