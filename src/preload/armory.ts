import { contextBridge, ipcRenderer } from "electron";

import type { ApplicationSettingsState } from "../shared/application-settings-contracts.js";
import type {
  ArmoryAPI,
  ArmoryProgress,
  ArmoryTabId,
} from "../shared/armory-contracts.js";
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
// not load Rollup chunks. Main repeats strict runtime validation for every
// request; this bridge only exposes the fixed Armory capability surface.
const CHANNELS = Object.freeze({
  getContext: "sliver:armory:context:get",
  snapshot: "sliver:armory:snapshot",
  refreshCatalog: "sliver:armory:catalog:refresh",
  updateAll: "sliver:armory:update-all",
  install: "sliver:armory:install",
  installBundle: "sliver:armory:bundle:install",
  uninstall: "sliver:armory:uninstall",
  saveSource: "sliver:armory:source:save",
  removeSource: "sliver:armory:source:remove",
  installLocal: "sliver:armory:local:install",
  copyPublicKey: "sliver:armory:public-key:copy",
  openRepository: "sliver:armory:repository:open",
  getApplicationSettings: "sliver:armory:application-settings:get",
  changed: "sliver:armory:changed",
  progress: "sliver:armory:progress",
  navigationRequested: "sliver:armory:navigation-requested",
  applicationSettingsChanged: "sliver:application-settings:changed",
});

// Mirror the Cloud Deployment context-menu bridge without runtime imports so
// this sandboxed preload remains self-contained. auxiliary-context-menu.test.ts
// checks these copies against the shared context-menu contracts.
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

const ARMORY_TABS = new Set<ArmoryTabId>(["manage", "install", "sources"]);
const ARMORY_PROGRESS_KEYS = [
  "operation", "phase", "packageName", "completedPackages", "totalPackages", "downloadedBytes",
  "currentBytes", "currentTotalBytes", "bytesPerSecond",
] as const;

function parseArmoryProgress(value: unknown): ArmoryProgress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid Armory progress");
  const progress = value as Record<string, unknown>;
  const keys = Object.keys(progress);
  if (keys.length !== ARMORY_PROGRESS_KEYS.length || keys.some((key) => !(ARMORY_PROGRESS_KEYS as readonly string[]).includes(key))) {
    throw new TypeError("Invalid Armory progress");
  }
  const operation = progress["operation"];
  const phase = progress["phase"];
  const packageName = progress["packageName"];
  const completedPackages = progress["completedPackages"];
  const totalPackages = progress["totalPackages"];
  const downloadedBytes = progress["downloadedBytes"];
  const currentBytes = progress["currentBytes"];
  const currentTotalBytes = progress["currentTotalBytes"];
  const bytesPerSecond = progress["bytesPerSecond"];
  const safeCount = (number: unknown): number is number => typeof number === "number" && Number.isSafeInteger(number) && number >= 0;
  if ((operation !== "install" && operation !== "install-bundle" && operation !== "update-all") ||
      (phase !== "preparing" && phase !== "downloading" && phase !== "verifying" && phase !== "installing") ||
      (packageName !== null && (typeof packageName !== "string" || !packageName.length || packageName.length > 256 ||
        /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(packageName))) ||
      !safeCount(completedPackages) || !safeCount(totalPackages) || completedPackages > totalPackages ||
      !safeCount(downloadedBytes) || !safeCount(currentBytes) || currentBytes > downloadedBytes ||
      (currentTotalBytes !== null && (!safeCount(currentTotalBytes) || currentBytes > currentTotalBytes)) ||
      !safeCount(bytesPerSecond)) {
    throw new TypeError("Invalid Armory progress");
  }
  return { operation, phase, packageName, completedPackages, totalPackages, downloadedBytes,
    currentBytes, currentTotalBytes, bytesPerSecond };
}

const navigationListeners = new Set<(tab: ArmoryTabId) => void>();
let pendingNavigationTab: ArmoryTabId | undefined;

ipcRenderer.on(CHANNELS.navigationRequested, (_event, ...payload: unknown[]) => {
  const tab = payload.length === 1 && ARMORY_TABS.has(payload[0] as ArmoryTabId)
    ? payload[0] as ArmoryTabId
    : undefined;
  if (!tab) return;
  if (navigationListeners.size === 0) {
    pendingNavigationTab = tab;
    return;
  }
  pendingNavigationTab = undefined;
  for (const listener of navigationListeners) listener(tab);
});

const api: ArmoryAPI = {
  getContext: () => ipcRenderer.invoke(CHANNELS.getContext),
  snapshot: () => ipcRenderer.invoke(CHANNELS.snapshot),
  refreshCatalog: () => ipcRenderer.invoke(CHANNELS.refreshCatalog),
  updateAll: () => ipcRenderer.invoke(CHANNELS.updateAll),
  install: (input) => ipcRenderer.invoke(CHANNELS.install, input),
  installBundle: (input) => ipcRenderer.invoke(CHANNELS.installBundle, input),
  uninstall: (input) => ipcRenderer.invoke(CHANNELS.uninstall, input),
  saveSource: (input) => ipcRenderer.invoke(CHANNELS.saveSource, input),
  removeSource: (input) => ipcRenderer.invoke(CHANNELS.removeSource, input),
  installLocal: (input) => ipcRenderer.invoke(CHANNELS.installLocal, input),
  copyPublicKey: (input) => ipcRenderer.invoke(CHANNELS.copyPublicKey, input),
  openRepository: (input) => ipcRenderer.invoke(CHANNELS.openRepository, input),
  getApplicationSettings: () => ipcRenderer.invoke(CHANNELS.getApplicationSettings),
  onChanged: (listener) => {
    if (typeof listener !== "function") throw new TypeError("change listener must be a function");
    const handler = (): void => listener();
    ipcRenderer.on(CHANNELS.changed, handler);
    return () => {
      ipcRenderer.removeListener(CHANNELS.changed, handler);
    };
  },
  onProgress: (listener) => {
    if (typeof listener !== "function") throw new TypeError("progress listener must be a function");
    const handler = (_event: Electron.IpcRendererEvent, ...payload: unknown[]): void => {
      if (payload.length !== 1) return;
      try { listener(parseArmoryProgress(payload[0])); }
      catch { /* Drop malformed main-to-renderer events. */ }
    };
    ipcRenderer.on(CHANNELS.progress, handler);
    return () => ipcRenderer.removeListener(CHANNELS.progress, handler);
  },
  onNavigationRequested: (listener) => {
    if (typeof listener !== "function") throw new TypeError("navigation listener must be a function");
    navigationListeners.add(listener);
    const pending = pendingNavigationTab;
    if (pending) {
      queueMicrotask(() => {
        if (navigationListeners.has(listener) && pendingNavigationTab === pending) {
          pendingNavigationTab = undefined;
          listener(pending);
        }
      });
    }
    return () => navigationListeners.delete(listener);
  },
  onApplicationSettingsChanged: (listener) => {
    if (typeof listener !== "function") throw new TypeError("settings listener must be a function");
    const handler = (_event: Electron.IpcRendererEvent, ...payload: unknown[]): void => {
      if (payload.length !== 1 || typeof payload[0] !== "object" || payload[0] === null) return;
      listener(payload[0] as ApplicationSettingsState);
    };
    ipcRenderer.on(CHANNELS.applicationSettingsChanged, handler);
    return () => ipcRenderer.removeListener(CHANNELS.applicationSettingsChanged, handler);
  },
};

installRestrictedTargetContextMenuSignal();

contextBridge.exposeInMainWorld("armory", Object.freeze(api));
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
  if (!isRecord(value) || !hasExactKeys(value, ["v", "requestId", "x", "y", "items"])) {
    throw new TypeError("Invalid application context menu request");
  }
  const { items, requestId, v, x, y } = value;
  if (
    v !== 1 ||
    !isContextMenuId(requestId) ||
    !isContextMenuCoordinate(x) ||
    !isContextMenuCoordinate(y) ||
    !Array.isArray(items) ||
    items.length < 1 ||
    items.length > 32
  ) throw new TypeError("Invalid application context menu request");

  const actionIds = new Set<string>();
  const parsedItems = items.map((item, index): ApplicationContextMenuItem => {
    if (!isRecord(item)) throw new TypeError("Invalid application context menu request");
    if (item["type"] === "separator") {
      const previous = items[index - 1];
      if (
        !hasExactKeys(item, ["type"]) ||
        index === 0 ||
        index === items.length - 1 ||
        (isRecord(previous) && previous["type"] === "separator")
      ) throw new TypeError("Invalid application context menu request");
      return Object.freeze({ type: "separator" });
    }
    const keys = Object.keys(item);
    if (
      item["type"] !== "action" ||
      keys.some((key) => !["type", "actionId", "kind", "label", "enabled", "shortcut", "variant"].includes(key)) ||
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
    requestId,
    x,
    y,
    items: Object.freeze(parsedItems),
  });
}

function parseContextMenuActionRequest(value: unknown): ApplicationContextMenuActionRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["requestId", "actionId"]) ||
    !isContextMenuId(value["requestId"]) ||
    !isContextMenuId(value["actionId"])
  ) throw new TypeError("Invalid application context menu action request");
  return Object.freeze({ requestId: value["requestId"], actionId: value["actionId"] });
}

function parseContextMenuVisibilityRequest(value: unknown): ApplicationContextMenuVisibilityRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["requestId", "open"]) ||
    !isContextMenuId(value["requestId"]) ||
    typeof value["open"] !== "boolean"
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

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
