import { contextBridge, ipcRenderer } from "electron";

import type {
  ApplicationSettingsState,
} from "../shared/application-settings-contracts.js";
import type {
  ManagedSshTarget,
  SshTabLaunchContext,
  SshWindowAPI,
} from "../shared/ssh-contracts.js";
import type {
  ApplicationContextMenuActionRequest,
  ApplicationContextMenuAPI,
  ApplicationContextMenuItem,
  ApplicationContextMenuItemKind,
  ApplicationContextMenuItemVariant,
  ApplicationContextMenuRequest,
  ApplicationContextMenuShortcut,
  ApplicationContextMenuVisibilityRequest,
} from "../shared/application-context-menu-contracts.js";

// Keep this sandboxed preload single-file: Electron's sandboxed `require` does
// not load Rollup chunks. Main repeats these literals and the tests lock the
// two allowlists together.
const CHANNELS = Object.freeze({
  claimSshWindow: "sliver:ssh:window:claim",
  listSshTargets: "sliver:ssh:targets:list",
  createSshTab: "sliver:ssh:tab:create",
  reattachSshTab: "sliver:ssh:tab:reattach",
  approveSshHostKey: "sliver:ssh:host-key:approve",
  closeSshTab: "sliver:ssh:tab:close",
  selectSshTab: "sliver:ssh:tab:select",
  renameSshTab: "sliver:ssh:tab:rename",
  getTerminalRuntime: "sliver:ssh:terminal-runtime:get",
  getApplicationSettings: "sliver:ssh:application-settings:get",
  updateApplicationSettings: "sliver:ssh:application-settings:update",
  attach: "sliver:ssh:stream:attach",
  newTabRequested: "sliver:ssh:new-tab-requested",
  closeTabRequested: "sliver:ssh:close-tab-requested",
  selectTabRequested: "sliver:ssh:select-tab-requested",
  settingsRequested: "sliver:ssh:settings-requested",
  tabOpened: "sliver:ssh:tab-opened",
  applicationSettingsChanged: "sliver:application-settings:changed",
});
const CONTEXT_MENU_CHANNELS = Object.freeze({
  menuRequested: "sliver:application-context-menu:requested",
  executeAction: "sliver:application-context-menu:execute-action",
  setOpen: "sliver:application-context-menu:set-open",
  restrictedTarget: "sliver:application-context-menu:restricted-target",
});
const RESTRICTED_CONTEXT_MENU_ATTRIBUTE = "data-application-context-menu-policy" as const;
const RESTRICTED_CONTEXT_MENU_VALUE = "inspect-only" as const;
const RESTRICTED_CONTEXT_MENU_SELECTOR =
  '[data-application-context-menu-policy="inspect-only"]' as const;

const SSH_PROTOCOL_VERSION = 1 as const;
const SSH_MAX_TABS_PER_WINDOW = 10;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TERMINAL_FONT_IDS = new Set(["fira-code", "jetbrains-mono", "cascadia-mono", "source-code-pro"]);
const TERMINAL_CURSOR_STYLES = new Set(["block", "underline", "bar"]);
const APPLICATION_THEMES = new Set(["system", "light", "dark"]);
const APPLICATION_ICONS = new Set(["auto", "light", "dark", "passion"]);
const RESERVED_COMMAND_PALETTE_SHORTCUTS = new Set([
  "alt+f4",
  "mod+0",
  "mod+1",
  "mod+2",
  "mod+3",
  "mod+4",
  "mod+5",
  "mod+6",
  "mod+7",
  "mod+8",
  "mod+9",
  "mod+a",
  "mod+c",
  "mod+h",
  "mod+alt+h",
  "mod+m",
  "mod+n",
  "mod+shift+n",
  "mod+q",
  "mod+r",
  "mod+shift+r",
  "mod+t",
  "mod+v",
  "mod+w",
  "mod+shift+w",
  "mod+x",
  "mod+y",
  "mod+z",
]);
const CONTEXT_MENU_KINDS = new Set<ApplicationContextMenuItemKind>([
  "undo", "redo", "cut", "copy", "paste", "paste-and-match-style", "delete",
  "select-all", "replace-misspelling", "open-link", "copy-link", "copy-image", "inspect",
]);
const CONTEXT_MENU_SHORTCUTS = new Set<ApplicationContextMenuShortcut>([
  "mod+z", "mod+shift+z", "mod+x", "mod+c", "mod+v", "mod+shift+v", "mod+a",
]);
const CONTEXT_MENU_VARIANTS = new Set<ApplicationContextMenuItemVariant>(["default", "danger"]);
const CONTEXT_MENU_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTEXT_MENU_FORBIDDEN_LABEL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const TAB_LABEL_CONTROL_OR_LINE_SEPARATOR_PATTERN = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const TAB_LABEL_FORMAT_CHARACTER_PATTERN = /\p{Cf}/gu;
const TAB_LABEL_VISIBLE_CHARACTER_PATTERN = /[\p{L}\p{N}\p{P}\p{S}]/u;
const TAB_LABEL_ALLOWED_JOINERS = new Set(["\u200c", "\u200d"]);

interface RendererWindowBridge {
  postMessage(message: unknown, targetOrigin: string, transfer: MessagePort[]): void;
}

interface RestrictedMutationRecord {
  readonly type: string;
  readonly target: unknown;
  readonly attributeName?: string | null;
  readonly oldValue?: string | null;
  readonly addedNodes: ArrayLike<unknown>;
}

interface RestrictedMutationObserverConstructor {
  new(callback: (records: readonly RestrictedMutationRecord[]) => void): {
    observe(target: object, options: Record<string, unknown>): void;
  };
}

const tabOpenedListeners = new Set<(context: SshTabLaunchContext) => void>();
const pendingTabContexts = new Map<string, SshTabLaunchContext>();
const applicationSettingsListeners = new Set<(state: ApplicationSettingsState) => void>();
let latestApplicationSettings: ApplicationSettingsState | undefined;

ipcRenderer.on(CHANNELS.tabOpened, (_event, ...payload: unknown[]): void => {
  if (payload.length !== 1) return;
  let context: SshTabLaunchContext;
  try {
    context = parseTabLaunchContext(payload[0]);
  } catch {
    return;
  }
  if (tabOpenedListeners.size === 0) {
    pendingTabContexts.set(context.tabId, context);
    while (pendingTabContexts.size > SSH_MAX_TABS_PER_WINDOW) {
      const oldest = pendingTabContexts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      pendingTabContexts.delete(oldest);
    }
    return;
  }
  for (const listener of tabOpenedListeners) listener(context);
});

ipcRenderer.on(CHANNELS.applicationSettingsChanged, (_event, ...payload: unknown[]): void => {
  if (payload.length !== 1) return;
  let state: ApplicationSettingsState;
  try {
    state = parseApplicationSettingsState(payload[0]);
  } catch {
    return;
  }
  latestApplicationSettings = state;
  for (const listener of applicationSettingsListeners) listener(state);
});

function openSshStream(attachmentToken: string, correlationId: string): void {
  if (!OPAQUE_ID_PATTERN.test(attachmentToken)) {
    throw new TypeError("SSH attachment token is invalid");
  }
  if (!UUID_V4_PATTERN.test(correlationId)) {
    throw new TypeError("SSH stream correlationId must be a UUID v4");
  }

  const channel = new MessageChannel();
  try {
    ipcRenderer.postMessage(
      CHANNELS.attach,
      Object.freeze({ v: SSH_PROTOCOL_VERSION, attachmentToken }),
      [channel.port1],
    );
    rendererWindow().postMessage(
      Object.freeze({
        source: "sliver-preload",
        type: "ssh-stream-port",
        v: SSH_PROTOCOL_VERSION,
        correlationId,
      }),
      "*",
      [channel.port2],
    );
  } catch (error) {
    closePort(channel.port1);
    closePort(channel.port2);
    throw error;
  }
}

const api: SshWindowAPI = {
  claimSshWindow: () => ipcRenderer.invoke(CHANNELS.claimSshWindow),
  listSshTargets: () => ipcRenderer.invoke(CHANNELS.listSshTargets),
  createSshTab: (input) => ipcRenderer.invoke(CHANNELS.createSshTab, input),
  reattachSshTab: (input) => ipcRenderer.invoke(CHANNELS.reattachSshTab, input),
  approveSshHostKey: (input) => ipcRenderer.invoke(CHANNELS.approveSshHostKey, input),
  closeSshTab: (input) => ipcRenderer.invoke(CHANNELS.closeSshTab, input),
  selectSshTab: (input) => ipcRenderer.invoke(CHANNELS.selectSshTab, input),
  renameSshTab: (input) => ipcRenderer.invoke(CHANNELS.renameSshTab, input),
  getTerminalRuntime: () => ipcRenderer.invoke(CHANNELS.getTerminalRuntime),
  getApplicationSettings: () => ipcRenderer.invoke(CHANNELS.getApplicationSettings),
  updateApplicationSettings: (input) => ipcRenderer.invoke(CHANNELS.updateApplicationSettings, input),
  openSshStream,
  onSshNewTabRequested: (listener) => onFixedEvent(CHANNELS.newTabRequested, listener),
  onSshCloseTabRequested: (listener) => onFixedEvent(CHANNELS.closeTabRequested, listener),
  onSshSelectTabRequested: (listener) => {
    requireListener(listener, "SSH tab-selection listener");
    const handler = (_event: Electron.IpcRendererEvent, ...payload: unknown[]): void => {
      if (
        payload.length === 1 &&
        Number.isSafeInteger(payload[0]) &&
        (payload[0] as number) >= 0 &&
        (payload[0] as number) < SSH_MAX_TABS_PER_WINDOW
      ) listener(payload[0] as number);
    };
    ipcRenderer.on(CHANNELS.selectTabRequested, handler);
    return () => ipcRenderer.removeListener(CHANNELS.selectTabRequested, handler);
  },
  onSshSettingsRequested: (listener) => onFixedEvent(CHANNELS.settingsRequested, listener),
  onSshTabOpened: (listener) => {
    requireListener(listener, "SSH tab-opened listener");
    tabOpenedListeners.add(listener);
    const pending = [...pendingTabContexts.values()];
    if (pending.length > 0) {
      queueMicrotask(() => {
        if (!tabOpenedListeners.has(listener)) return;
        for (const context of pending) {
          if (pendingTabContexts.get(context.tabId) !== context) continue;
          pendingTabContexts.delete(context.tabId);
          listener(context);
        }
      });
    }
    return () => tabOpenedListeners.delete(listener);
  },
  onApplicationSettingsChanged: (listener) => {
    requireListener(listener, "application-settings listener");
    applicationSettingsListeners.add(listener);
    const latest = latestApplicationSettings;
    if (latest !== undefined) {
      queueMicrotask(() => {
        if (applicationSettingsListeners.has(listener)) listener(latest);
      });
    }
    return () => applicationSettingsListeners.delete(listener);
  },
};

installRestrictedTargetContextMenuSignal();

contextBridge.exposeInMainWorld("ssh", Object.freeze(api));
contextBridge.exposeInMainWorld("applicationContextMenu", Object.freeze({
  onMenuRequested: (listener) => {
    requireListener(listener, "context-menu listener");
    const handler = (_event: Electron.IpcRendererEvent, ...payload: unknown[]): void => {
      if (payload.length !== 1) return;
      try {
        listener(parseContextMenuRequest(payload[0]));
      } catch {
        // Drop malformed main-to-renderer events instead of widening the bridge.
      }
    };
    ipcRenderer.on(CONTEXT_MENU_CHANNELS.menuRequested, handler);
    return () => ipcRenderer.removeListener(CONTEXT_MENU_CHANNELS.menuRequested, handler);
  },
  executeAction: (request) => ipcRenderer.invoke(
    CONTEXT_MENU_CHANNELS.executeAction,
    parseContextMenuActionRequest(request),
  ),
  setOpen: (request) => ipcRenderer.invoke(
    CONTEXT_MENU_CHANNELS.setOpen,
    parseContextMenuVisibilityRequest(request),
  ),
} satisfies ApplicationContextMenuAPI));

function installRestrictedTargetContextMenuSignal(): void {
  const preloadDocument = (globalThis as {
    document?: {
      addEventListener: (
        type: "contextmenu",
        listener: (event: Event) => void,
        useCapture: boolean,
      ) => void;
      querySelectorAll?: (selector: string) => ArrayLike<unknown>;
    };
  }).document;
  if (!preloadDocument || typeof preloadDocument.addEventListener !== "function") return;

  const restrictedNodes = new WeakSet<object>();
  const markSubtree = (value: unknown): void => {
    const node = objectNode(value);
    if (!node) return;
    restrictedNodes.add(node);
    const children = childNodesOf(node);
    for (let index = 0; index < children.length; index += 1) {
      markSubtree(children[index]);
    }
  };
  const markDeclaredRoots = (value: unknown): void => {
    const node = objectNode(value);
    if (!node) return;
    if (contextMenuPolicyOf(node) === RESTRICTED_CONTEXT_MENU_VALUE) {
      markSubtree(node);
      return;
    }
    const children = childNodesOf(node);
    for (let index = 0; index < children.length; index += 1) {
      markDeclaredRoots(children[index]);
    }
  };

  if (typeof preloadDocument.querySelectorAll === "function") {
    const roots = preloadDocument.querySelectorAll(RESTRICTED_CONTEXT_MENU_SELECTOR);
    for (let index = 0; index < roots.length; index += 1) markSubtree(roots[index]);
  }

  const MutationObserverConstructor = (globalThis as {
    MutationObserver?: RestrictedMutationObserverConstructor;
  }).MutationObserver;
  if (typeof MutationObserverConstructor === "function") {
    const observer = new MutationObserverConstructor((records) => {
      for (const record of records) {
        const target = objectNode(record.target);
        if (record.type === "attributes") {
          if (
            record.attributeName === RESTRICTED_CONTEXT_MENU_ATTRIBUTE &&
            target &&
            (record.oldValue === RESTRICTED_CONTEXT_MENU_VALUE ||
              contextMenuPolicyOf(target) === RESTRICTED_CONTEXT_MENU_VALUE)
          ) markSubtree(target);
          continue;
        }
        if (record.type !== "childList") continue;
        for (let index = 0; index < record.addedNodes.length; index += 1) {
          const addedNode = record.addedNodes[index];
          if (target && restrictedNodes.has(target)) markSubtree(addedNode);
          markDeclaredRoots(addedNode);
        }
      }
    });
    observer.observe(preloadDocument, {
      attributeFilter: [RESTRICTED_CONTEXT_MENU_ATTRIBUTE],
      attributeOldValue: true,
      attributes: true,
      childList: true,
      subtree: true,
    });
  }

  preloadDocument.addEventListener("contextmenu", (event) => {
    if (event.isTrusted && isRestrictedContextMenuTarget(event.target, restrictedNodes)) {
      ipcRenderer.send(CONTEXT_MENU_CHANNELS.restrictedTarget);
    }
  }, true);
}

function isRestrictedContextMenuTarget(
  target: EventTarget | null,
  restrictedNodes: WeakSet<object>,
): boolean {
  let node = objectNode(target);
  const visited = new Set<object>();
  while (node && !visited.has(node)) {
    if (restrictedNodes.has(node)) return true;
    visited.add(node);
    node = parentNodeOf(node);
  }
  return false;
}

function objectNode(value: unknown): object | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

function childNodesOf(node: object): ArrayLike<unknown> {
  if (!("childNodes" in node)) return [];
  const children = node.childNodes;
  return typeof children === "object" && children !== null && "length" in children &&
      typeof children.length === "number"
    ? children as ArrayLike<unknown>
    : [];
}

function parentNodeOf(node: object): object | undefined {
  const record = node as Record<PropertyKey, unknown>;
  for (const key of ["parentNode", "parentElement", "host"] as const) {
    if (!(key in record)) continue;
    const parent = objectNode(record[key]);
    if (parent) return parent;
  }
  return undefined;
}

function contextMenuPolicyOf(node: object): unknown {
  if (!("getAttribute" in node) || typeof node.getAttribute !== "function") return undefined;
  try {
    return node.getAttribute(RESTRICTED_CONTEXT_MENU_ATTRIBUTE);
  } catch {
    return undefined;
  }
}

function parseContextMenuRequest(value: unknown): ApplicationContextMenuRequest {
  const request = exactRecord(value, ["v", "requestId", "x", "y", "items"], "application context menu request");
  if (
    request["v"] !== 1 ||
    !isContextMenuId(request["requestId"]) ||
    !isContextMenuCoordinate(request["x"]) ||
    !isContextMenuCoordinate(request["y"]) ||
    !Array.isArray(request["items"]) ||
    request["items"].length < 1 ||
    request["items"].length > 32
  ) throw new TypeError("Invalid application context menu request");

  const actionIds = new Set<string>();
  const sourceItems = request["items"];
  const items = sourceItems.map((value, index): ApplicationContextMenuItem => {
    const item = record(value, "application context menu item");
    if (item["type"] === "separator") {
      const previous = sourceItems[index - 1];
      if (
        !hasOnlyKeys(item, ["type"]) ||
        index === 0 ||
        index === sourceItems.length - 1 ||
        (typeof previous === "object" && previous !== null &&
          !Array.isArray(previous) && (previous as Record<string, unknown>)["type"] === "separator")
      ) throw new TypeError("Invalid application context menu request");
      return Object.freeze({ type: "separator" });
    }

    const allowedKeys = ["type", "actionId", "kind", "label", "enabled", "shortcut", "variant"];
    if (
      item["type"] !== "action" ||
      Object.keys(item).some((key) => !allowedKeys.includes(key)) ||
      !["type", "actionId", "kind", "label", "enabled"].every((key) => Object.hasOwn(item, key)) ||
      !isContextMenuId(item["actionId"]) ||
      actionIds.has(item["actionId"]) ||
      typeof item["kind"] !== "string" ||
      !CONTEXT_MENU_KINDS.has(item["kind"] as ApplicationContextMenuItemKind) ||
      !isContextMenuLabel(item["label"]) ||
      typeof item["enabled"] !== "boolean" ||
      (item["shortcut"] !== undefined && (
        typeof item["shortcut"] !== "string" ||
        !CONTEXT_MENU_SHORTCUTS.has(item["shortcut"] as ApplicationContextMenuShortcut)
      )) ||
      (item["variant"] !== undefined && (
        typeof item["variant"] !== "string" ||
        !CONTEXT_MENU_VARIANTS.has(item["variant"] as ApplicationContextMenuItemVariant)
      ))
    ) throw new TypeError("Invalid application context menu request");
    actionIds.add(item["actionId"]);
    return Object.freeze({
      type: "action",
      actionId: item["actionId"],
      kind: item["kind"] as ApplicationContextMenuItemKind,
      label: item["label"],
      enabled: item["enabled"],
      ...(item["shortcut"] === undefined
        ? {}
        : { shortcut: item["shortcut"] as ApplicationContextMenuShortcut }),
      ...(item["variant"] === undefined
        ? {}
        : { variant: item["variant"] as ApplicationContextMenuItemVariant }),
    });
  });
  return Object.freeze({
    v: 1,
    requestId: request["requestId"],
    x: request["x"],
    y: request["y"],
    items: Object.freeze(items),
  });
}

function parseContextMenuActionRequest(value: unknown): ApplicationContextMenuActionRequest {
  const request = exactRecord(value, ["requestId", "actionId"], "application context menu action request");
  if (!isContextMenuId(request["requestId"]) || !isContextMenuId(request["actionId"])) {
    throw new TypeError("Invalid application context menu action request");
  }
  return Object.freeze({ requestId: request["requestId"], actionId: request["actionId"] });
}

function parseContextMenuVisibilityRequest(value: unknown): ApplicationContextMenuVisibilityRequest {
  const request = exactRecord(
    value,
    ["requestId", "open"],
    "application context menu visibility request",
  );
  if (!isContextMenuId(request["requestId"]) || typeof request["open"] !== "boolean") {
    throw new TypeError("Invalid application context menu visibility request");
  }
  return Object.freeze({ requestId: request["requestId"], open: request["open"] });
}

function isContextMenuId(value: unknown): value is string {
  return typeof value === "string" && CONTEXT_MENU_ID_PATTERN.test(value);
}

function isContextMenuCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

function isContextMenuLabel(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 &&
    !CONTEXT_MENU_FORBIDDEN_LABEL_PATTERN.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function onFixedEvent(channel: string, listener: () => void): () => void {
  requireListener(listener, "SSH event listener");
  const handler = (_event: Electron.IpcRendererEvent, ...payload: unknown[]): void => {
    if (payload.length === 0) listener();
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

function rendererWindow(): RendererWindowBridge {
  const candidate = (globalThis as { window?: unknown }).window;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("postMessage" in candidate) ||
    typeof candidate.postMessage !== "function"
  ) throw new Error("renderer window bridge is unavailable");
  return candidate as RendererWindowBridge;
}

function closePort(port: MessagePort): void {
  try {
    port.close();
  } catch {
    // A transferred port may already be detached from this realm.
  }
}

function parseTabLaunchContext(value: unknown): SshTabLaunchContext {
  const context = exactRecord(
    value,
    ["tabId", "attachmentToken", "label", "target"],
    "SSH tab context",
  );
  return Object.freeze({
    tabId: opaqueId(context["tabId"], "SSH tab identity"),
    attachmentToken: opaqueId(context["attachmentToken"], "SSH attachment token"),
    label: terminalTabLabel(context["label"], "SSH tab label"),
    target: parseManagedTarget(context["target"]),
  });
}

function parseManagedTarget(value: unknown): ManagedSshTarget {
  const target = record(value, "managed SSH target");
  const optional = target["unavailableReason"] === undefined ? [] : ["unavailableReason"];
  exactKeys(
    target,
    ["deploymentId", "name", "provider", "host", "port", "username", "status", "connectable", ...optional],
    "managed SSH target",
  );
  if (!UUID_V4_PATTERN.test(stringValue(target["deploymentId"]))) throw new TypeError("Invalid SSH deployment identity");
  if (target["provider"] !== "aws" && target["provider"] !== "proxmox") throw new TypeError("Invalid SSH provider");
  if (!new Set(["provisioning", "running", "stopped", "deleting", "failed"]).has(stringValue(target["status"]))) {
    throw new TypeError("Invalid SSH target status");
  }
  if (typeof target["connectable"] !== "boolean") throw new TypeError("Invalid SSH target availability");
  const unavailableReason = target["unavailableReason"];
  if (
    (target["connectable"] && unavailableReason !== undefined) ||
    (!target["connectable"] && !isPlainString(unavailableReason, 1, 512))
  ) throw new TypeError("Invalid SSH target availability reason");
  const parsedUnavailableReason = unavailableReason === undefined
    ? undefined
    : plainString(unavailableReason, 1, 512, "SSH target availability reason");
  const port = target["port"];
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new TypeError("Invalid SSH target port");
  }
  return Object.freeze({
    deploymentId: target["deploymentId"] as string,
    name: terminalTabLabel(target["name"], "SSH target name"),
    provider: target["provider"],
    host: plainString(target["host"], 1, 255, "SSH target host"),
    port: port as number,
    username: plainString(target["username"], 1, 128, "SSH target username"),
    status: target["status"] as ManagedSshTarget["status"],
    connectable: target["connectable"],
    ...(parsedUnavailableReason === undefined ? {} : { unavailableReason: parsedUnavailableReason }),
  });
}

function parseApplicationSettingsState(value: unknown): ApplicationSettingsState {
  const state = exactRecord(
    value,
    ["v", "revision", "theme", "appIcon", "reduceMotion", "commandPaletteShortcut", "terminal"],
    "application settings",
  );
  if (state["v"] !== 3 || !Number.isSafeInteger(state["revision"]) || (state["revision"] as number) < 0) {
    throw new TypeError("Invalid application settings state");
  }
  if (!APPLICATION_THEMES.has(stringValue(state["theme"]))) throw new TypeError("Invalid application theme");
  if (!APPLICATION_ICONS.has(stringValue(state["appIcon"]))) throw new TypeError("Invalid application icon");
  if (typeof state["reduceMotion"] !== "boolean") throw new TypeError("Invalid reduced-motion setting");
  const shortcut = stringValue(state["commandPaletteShortcut"]);
  if (!isCommandPaletteShortcut(shortcut)) throw new TypeError("Invalid command-palette shortcut");
  const terminal = exactRecord(
    state["terminal"],
    ["fontId", "fontSize", "cursorStyle", "cursorBlink", "smoothScrolling"],
    "terminal settings",
  );
  if (!TERMINAL_FONT_IDS.has(stringValue(terminal["fontId"]))) throw new TypeError("Invalid terminal font");
  if (
    !Number.isSafeInteger(terminal["fontSize"]) ||
    (terminal["fontSize"] as number) < 8 ||
    (terminal["fontSize"] as number) > 32
  ) throw new TypeError("Invalid terminal font size");
  if (!TERMINAL_CURSOR_STYLES.has(stringValue(terminal["cursorStyle"]))) throw new TypeError("Invalid terminal cursor");
  if (typeof terminal["cursorBlink"] !== "boolean" || typeof terminal["smoothScrolling"] !== "boolean") {
    throw new TypeError("Invalid terminal behavior");
  }
  return Object.freeze({
    v: 3,
    revision: state["revision"] as number,
    theme: state["theme"] as ApplicationSettingsState["theme"],
    appIcon: state["appIcon"] as ApplicationSettingsState["appIcon"],
    reduceMotion: state["reduceMotion"],
    commandPaletteShortcut: shortcut,
    terminal: Object.freeze({
      fontId: terminal["fontId"] as ApplicationSettingsState["terminal"]["fontId"],
      fontSize: terminal["fontSize"] as number,
      cursorStyle: terminal["cursorStyle"] as ApplicationSettingsState["terminal"]["cursorStyle"],
      cursorBlink: terminal["cursorBlink"],
      smoothScrolling: terminal["smoothScrolling"],
    }),
  });
}

function isCommandPaletteShortcut(value: string): boolean {
  if (value.length > 64 || value !== value.toLowerCase() || RESERVED_COMMAND_PALETTE_SHORTCUTS.has(value)) return false;
  const tokens = value.split("+");
  if (tokens.length < 2 || tokens.some((token) => token === "" || token.trim() !== token)) return false;
  const key = tokens.at(-1);
  const modifiers = tokens.slice(0, -1);
  if (!key || (!/^[a-z0-9]$/u.test(key) && !/^f(?:[1-9]|1[0-2])$/u.test(key))) return false;
  if (!modifiers.includes("mod")) return false;
  const expectedOrder = ["mod", "alt", "shift"];
  return modifiers.length <= expectedOrder.length &&
    modifiers.every((modifier, index) => modifier === expectedOrder.filter((item) => modifiers.includes(item))[index]);
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const candidate = record(value, label);
  exactKeys(candidate, keys, label);
  return candidate;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}

function plainString(value: unknown, minimum: number, maximum: number, label: string): string {
  if (!isPlainString(value, minimum, maximum)) throw new TypeError(`Invalid ${label}`);
  return value;
}

// This preload intentionally stays single-file for Electron's sandbox. Keep
// this mirror aligned with shared/terminal-tab-label.ts.
function terminalTabLabel(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.trim() !== value) {
    throw new TypeError(`Invalid ${label}`);
  }
  if (
    TAB_LABEL_CONTROL_OR_LINE_SEPARATOR_PATTERN.test(value) ||
    !TAB_LABEL_VISIBLE_CHARACTER_PATTERN.test(value)
  ) throw new TypeError(`Invalid ${label}`);
  const formatCharacters = value.match(TAB_LABEL_FORMAT_CHARACTER_PATTERN) ?? [];
  if (!formatCharacters.every((character) => TAB_LABEL_ALLOWED_JOINERS.has(character))) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function isPlainString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requireListener(value: unknown, label: string): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
}
