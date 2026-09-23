import { contextBridge, ipcRenderer } from "electron";
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
import type { ApplicationSettingsState } from "../shared/application-settings-contracts.js";
import type { TextEditorAPI, TextEditorRemoteOverwriteRequest } from "../shared/text-editor-contracts.js";
import type {
  TextEditorSettingsState,
  TextEditorSettingsUpdateInput,
  TextEditorSettingsValues,
} from "../shared/text-editor-settings-contracts.js";

// Literal channels and type-only imports keep the sandbox preload self-contained.
// Electron main independently validates every request and its sending frame.
const CHANNELS = Object.freeze({
  getDocument: "sliver:text-editor:document:get",
  openFile: "sliver:text-editor:file:open",
  save: "sliver:text-editor:file:save",
  setDirty: "sliver:text-editor:dirty:set",
  respondToRemoteOverwrite: "sliver:text-editor:remote-overwrite:respond",
  remoteOverwriteRequested: "sliver:text-editor:remote-overwrite:requested",
  getApplicationSettings: "sliver:text-editor:application-settings:get",
  applicationSettingsChanged: "sliver:application-settings:changed",
  getEditorSettings: "sliver:text-editor:settings:get",
  updateEditorSettings: "sliver:text-editor:settings:update",
  editorSettingsChanged: "sliver:text-editor:settings:changed",
});

// Mirror the fixed application context-menu bridge without runtime imports so
// this sandboxed preload remains one self-contained bundle.
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

const api: TextEditorAPI = {
  getDocument: () => ipcRenderer.invoke(CHANNELS.getDocument),
  openFile: () => ipcRenderer.invoke(CHANNELS.openFile),
  save: (input) => {
    if (!input || typeof input !== "object" || Object.keys(input).length !== 2 ||
      typeof input.text !== "string" || input.text.length > 2 * 1024 * 1024 ||
      typeof input.saveAs !== "boolean") throw new TypeError("Invalid text editor save request");
    return ipcRenderer.invoke(CHANNELS.save, { text: input.text, saveAs: input.saveAs });
  },
  setDirty: (dirty) => {
    if (typeof dirty !== "boolean") throw new TypeError("Invalid text editor dirty state");
    return ipcRenderer.invoke(CHANNELS.setDirty, dirty);
  },
  respondToRemoteOverwrite: (input) => {
    if (!input || typeof input !== "object" || Object.keys(input).length !== 2 ||
      typeof input.requestId !== "string" || !isRequestId(input.requestId) ||
      typeof input.confirmed !== "boolean") throw new TypeError("Invalid remote overwrite response");
    return ipcRenderer.invoke(CHANNELS.respondToRemoteOverwrite, {
      requestId: input.requestId,
      confirmed: input.confirmed,
    });
  },
  onRemoteOverwriteRequested: (listener) => {
    if (typeof listener !== "function") throw new TypeError("Remote overwrite listener must be a function");
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      if (args.length === 1 && isRemoteOverwriteRequest(args[0])) listener(args[0]);
    };
    ipcRenderer.on(CHANNELS.remoteOverwriteRequested, handler);
    return () => ipcRenderer.removeListener(CHANNELS.remoteOverwriteRequested, handler);
  },
  getApplicationSettings: () => ipcRenderer.invoke(CHANNELS.getApplicationSettings),
  onApplicationSettingsChanged: (listener) => {
    if (typeof listener !== "function") throw new TypeError("Text editor settings listener must be a function");
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
        listener(args[0] as ApplicationSettingsState);
      }
    };
    ipcRenderer.on(CHANNELS.applicationSettingsChanged, handler);
    return () => ipcRenderer.removeListener(CHANNELS.applicationSettingsChanged, handler);
  },
  getEditorSettings: () => ipcRenderer.invoke(CHANNELS.getEditorSettings),
  updateEditorSettings: (input) => {
    if (!isTextEditorSettingsUpdateInput(input)) throw new TypeError("Invalid text editor settings update");
    return ipcRenderer.invoke(CHANNELS.updateEditorSettings, input);
  },
  onEditorSettingsChanged: (listener) => {
    if (typeof listener !== "function") throw new TypeError("Editor settings listener must be a function");
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      if (args.length === 1 && isTextEditorSettingsState(args[0])) listener(args[0]);
    };
    ipcRenderer.on(CHANNELS.editorSettingsChanged, handler);
    return () => ipcRenderer.removeListener(CHANNELS.editorSettingsChanged, handler);
  },
};

const EDITOR_SETTING_KEYS = [
  "fontId", "fontSize", "tabSize", "insertSpaces", "minimap", "wordWrap", "lineNumbers",
  "renderWhitespace", "stickyScroll", "bracketPairColorization", "fontLigatures",
] as const;
const EDITOR_FONT_IDS = new Set(["fira-code", "jetbrains-mono", "cascadia-mono", "source-code-pro"]);
const EDITOR_LINE_NUMBERS = new Set(["on", "relative", "off"]);
const EDITOR_WHITESPACE = new Set(["none", "selection", "boundary", "trailing", "all"]);

function isTextEditorSettingsValues(value: unknown): value is TextEditorSettingsValues {
  if (!hasExactKeys(value, EDITOR_SETTING_KEYS)) return false;
  return EDITOR_FONT_IDS.has(value["fontId"] as string) &&
    Number.isSafeInteger(value["fontSize"]) && (value["fontSize"] as number) >= 8 &&
    (value["fontSize"] as number) <= 32 &&
    Number.isSafeInteger(value["tabSize"]) && (value["tabSize"] as number) >= 1 &&
    (value["tabSize"] as number) <= 8 &&
    typeof value["insertSpaces"] === "boolean" && typeof value["minimap"] === "boolean" &&
    typeof value["wordWrap"] === "boolean" && EDITOR_LINE_NUMBERS.has(value["lineNumbers"] as string) &&
    EDITOR_WHITESPACE.has(value["renderWhitespace"] as string) &&
    typeof value["stickyScroll"] === "boolean" && typeof value["bracketPairColorization"] === "boolean" &&
    typeof value["fontLigatures"] === "boolean";
}

function isTextEditorSettingsState(value: unknown): value is TextEditorSettingsState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (!hasExactKeys(state, ["v", "revision", ...EDITOR_SETTING_KEYS]) || state["v"] !== 1 ||
    !Number.isSafeInteger(state["revision"]) || (state["revision"] as number) < 0) return false;
  const settings = Object.fromEntries(EDITOR_SETTING_KEYS.map((key) => [key, state[key]]));
  return isTextEditorSettingsValues(settings);
}

function isTextEditorSettingsUpdateInput(value: unknown): value is TextEditorSettingsUpdateInput {
  if (!hasExactKeys(value, ["expectedRevision", "settings"])) return false;
  return Number.isSafeInteger(value["expectedRevision"]) && (value["expectedRevision"] as number) >= 0 &&
    isTextEditorSettingsValues(value["settings"]);
}

function hasExactKeys<const K extends string>(value: unknown, keys: readonly K[]): value is Record<K, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRequestId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isRemoteOverwriteRequest(value: unknown): value is TextEditorRemoteOverwriteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (Object.keys(request).length !== 6 || typeof request["requestId"] !== "string" ||
    !isRequestId(request["requestId"]) || typeof request["path"] !== "string" ||
    request["path"].length === 0 || request["path"].length > 16_384 ||
    typeof request["originalSha256"] !== "string" || typeof request["newSha256"] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(request["originalSha256"]) || !/^[0-9a-f]{64}$/u.test(request["newSha256"]) ||
    typeof request["warning"] !== "string" || request["warning"].length > 4_096) return false;
  const target = request["target"];
  if (!target || typeof target !== "object" || Array.isArray(target) || Object.keys(target).length !== 4) return false;
  const typedTarget = target as Record<string, unknown>;
  if (!["name", "hostname", "sessionId"].every((key) => typeof typedTarget[key] === "string" &&
    (typedTarget[key] as string).length <= 1_024)) return false;
  const backend = typedTarget["backend"];
  if (!backend || typeof backend !== "object" || Array.isArray(backend) || Object.keys(backend).length !== 2) return false;
  const typedBackend = backend as Record<string, unknown>;
  return typeof typedBackend["id"] === "string" && typedBackend["id"].length <= 1_024 &&
    typeof typedBackend["displayName"] === "string" && typedBackend["displayName"].length <= 1_024;
}

installRestrictedTargetContextMenuSignal();

contextBridge.exposeInMainWorld("textEditor", Object.freeze(api));
contextBridge.exposeInMainWorld("applicationContextMenu", Object.freeze({
  onMenuRequested: (listener) => {
    if (typeof listener !== "function") throw new TypeError("context-menu listener must be a function");
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
    for (let index = 0; index < children.length; index += 1) markSubtree(children[index]);
  };
  const markDeclaredRoots = (value: unknown): void => {
    const node = objectNode(value);
    if (!node) return;
    if (contextMenuPolicyOf(node) === RESTRICTED_CONTEXT_MENU_VALUE) {
      markSubtree(node);
      return;
    }
    const children = childNodesOf(node);
    for (let index = 0; index < children.length; index += 1) markDeclaredRoots(children[index]);
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
  if (!isRecord(value) || !hasExactKeys(value, ["v", "requestId", "x", "y", "items"])) {
    throw new TypeError("Invalid application context menu request");
  }
  const { items, requestId, v, x, y } = value;
  if (
    v !== 1 || !isContextMenuId(requestId) || !isContextMenuCoordinate(x) ||
    !isContextMenuCoordinate(y) || !Array.isArray(items) || items.length < 1 || items.length > 32
  ) throw new TypeError("Invalid application context menu request");

  const actionIds = new Set<string>();
  const parsedItems = items.map((item, index): ApplicationContextMenuItem => {
    if (!isRecord(item)) throw new TypeError("Invalid application context menu request");
    if (item["type"] === "separator") {
      const previous = items[index - 1];
      if (
        !hasExactKeys(item, ["type"]) || index === 0 || index === items.length - 1 ||
        (isRecord(previous) && previous["type"] === "separator")
      ) throw new TypeError("Invalid application context menu request");
      return Object.freeze({ type: "separator" });
    }
    const keys = Object.keys(item);
    if (
      item["type"] !== "action" ||
      keys.some((key) => !["type", "actionId", "kind", "label", "enabled", "shortcut", "variant"].includes(key)) ||
      !["type", "actionId", "kind", "label", "enabled"].every((key) => Object.hasOwn(item, key)) ||
      !isContextMenuId(item["actionId"]) || actionIds.has(item["actionId"]) ||
      typeof item["kind"] !== "string" || !CONTEXT_MENU_KINDS.has(item["kind"] as ApplicationContextMenuItemKind) ||
      !isContextMenuLabel(item["label"]) || typeof item["enabled"] !== "boolean" ||
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
      ...(item["shortcut"] === undefined ? {} : {
        shortcut: item["shortcut"] as ApplicationContextMenuShortcut,
      }),
      ...(item["variant"] === undefined ? {} : {
        variant: item["variant"] as ApplicationContextMenuItemVariant,
      }),
    });
  });
  return Object.freeze({
    v: 1,
    requestId,
    x,
    y,
    items: Object.freeze(parsedItems),
  });
}

function parseContextMenuActionRequest(value: unknown): ApplicationContextMenuActionRequest {
  if (
    !isRecord(value) || !hasExactKeys(value, ["requestId", "actionId"]) ||
    !isContextMenuId(value["requestId"]) || !isContextMenuId(value["actionId"])
  ) throw new TypeError("Invalid application context menu action request");
  return Object.freeze({ requestId: value["requestId"], actionId: value["actionId"] });
}

function parseContextMenuVisibilityRequest(value: unknown): ApplicationContextMenuVisibilityRequest {
  if (
    !isRecord(value) || !hasExactKeys(value, ["requestId", "open"]) ||
    !isContextMenuId(value["requestId"]) || typeof value["open"] !== "boolean"
  ) throw new TypeError("Invalid application context menu visibility request");
  return Object.freeze({ requestId: value["requestId"], open: value["open"] });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
