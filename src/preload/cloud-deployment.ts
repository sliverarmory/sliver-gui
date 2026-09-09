import { contextBridge, ipcRenderer } from "electron";

import type {
  CloudDeploymentAPI,
  CloudDeploymentNavigationRequest,
} from "../shared/cloud-deployment-ipc.js";
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
// not load Rollup chunks. The preload test locks this literal to the shared
// main-process contract.
const CHANNELS = Object.freeze({
  getSnapshot: "sliver:cloud-deployment:snapshot:get",
  refreshDeployments: "sliver:cloud-deployment:status:refresh",
  getProvisioningTranscripts: "sliver:cloud-deployment:transcripts:get",
  getTerminalRuntime: "sliver:cloud-deployment:terminal-runtime:get",
  detectCurrentEgressIpv4: "sliver:cloud-deployment:egress-ipv4:detect",
  chooseSshPrivateKey: "sliver:cloud-deployment:ssh-key:choose",
  createCredential: "sliver:cloud-deployment:credential:create",
  loginAwsCredential: "sliver:cloud-deployment:aws:login",
  cancelAwsLogin: "sliver:cloud-deployment:aws:login:cancel",
  beginAzureLogin: "sliver:cloud-deployment:azure:login:begin",
  loginAzureCredential: "sliver:cloud-deployment:azure:login",
  cancelAzureLogin: "sliver:cloud-deployment:azure:login:cancel",
  deleteCredential: "sliver:cloud-deployment:credential:delete",
  testCredential: "sliver:cloud-deployment:credential:test",
  discoverAwsOptions: "sliver:cloud-deployment:aws:options:discover",
  discoverAzureAccounts: "sliver:cloud-deployment:azure:accounts:discover",
  discoverAzureOptions: "sliver:cloud-deployment:azure:options:discover",
  createDeployment: "sliver:cloud-deployment:create",
  runLifecycleAction: "sliver:cloud-deployment:lifecycle",
  updateFirewall: "sliver:cloud-deployment:firewall:update",
  listFirewallRules: "sliver:cloud-deployment:firewall-rules:list",
  createFirewallRule: "sliver:cloud-deployment:firewall-rule:create",
  updateFirewallRule: "sliver:cloud-deployment:firewall-rule:update",
  deleteFirewallRule: "sliver:cloud-deployment:firewall-rule:delete",
  prepareDestroyDeployment: "sliver:cloud-deployment:destroy:prepare",
  executeDestroyDeployment: "sliver:cloud-deployment:destroy:execute",
  openSshWindow: "sliver:cloud-deployment:ssh-window:open",
  approveSshHostKey: "sliver:cloud-deployment:ssh-host-key:approve",
  changed: "sliver:cloud-deployment:changed",
  navigationRequested: "sliver:cloud-deployment:navigation-requested",
  themeChanged: "sliver:cloud-deployment:theme-changed",
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

const themeListeners = new Set<(dark: boolean) => void>();
const navigationListeners = new Set<(request: CloudDeploymentNavigationRequest) => void>();
let latestTheme: boolean | undefined;
let pendingNavigationRequest: CloudDeploymentNavigationRequest | undefined;

ipcRenderer.on(CHANNELS.themeChanged, (_event, ...payload: unknown[]) => {
  if (payload.length !== 1 || typeof payload[0] !== "boolean") return;
  latestTheme = payload[0];
  for (const listener of themeListeners) listener(latestTheme);
});

ipcRenderer.on(CHANNELS.navigationRequested, (_event, ...payload: unknown[]) => {
  const request = parseNavigationRequest(payload);
  if (!request) return;
  if (navigationListeners.size === 0) {
    pendingNavigationRequest = request;
    return;
  }
  pendingNavigationRequest = undefined;
  for (const listener of navigationListeners) listener(request);
});

const api: CloudDeploymentAPI = {
  getSnapshot: () => ipcRenderer.invoke(CHANNELS.getSnapshot),
  refreshDeployments: () => ipcRenderer.invoke(CHANNELS.refreshDeployments),
  getProvisioningTranscripts: () => ipcRenderer.invoke(CHANNELS.getProvisioningTranscripts),
  getTerminalRuntime: () => ipcRenderer.invoke(CHANNELS.getTerminalRuntime),
  detectCurrentEgressIpv4: () => ipcRenderer.invoke(CHANNELS.detectCurrentEgressIpv4),
  chooseSshPrivateKey: () => ipcRenderer.invoke(CHANNELS.chooseSshPrivateKey),
  createCredential: (input) => ipcRenderer.invoke(CHANNELS.createCredential, input),
  loginAwsCredential: (input) => ipcRenderer.invoke(CHANNELS.loginAwsCredential, input),
  cancelAwsLogin: () => ipcRenderer.invoke(CHANNELS.cancelAwsLogin),
  beginAzureLogin: (input) => ipcRenderer.invoke(CHANNELS.beginAzureLogin, input),
  loginAzureCredential: (input) => ipcRenderer.invoke(CHANNELS.loginAzureCredential, input),
  cancelAzureLogin: () => ipcRenderer.invoke(CHANNELS.cancelAzureLogin),
  deleteCredential: (input) => ipcRenderer.invoke(CHANNELS.deleteCredential, input),
  testCredential: (input) => ipcRenderer.invoke(CHANNELS.testCredential, input),
  discoverAwsOptions: (input) => ipcRenderer.invoke(CHANNELS.discoverAwsOptions, input),
  discoverAzureAccounts: () => ipcRenderer.invoke(CHANNELS.discoverAzureAccounts),
  discoverAzureOptions: (input) => ipcRenderer.invoke(CHANNELS.discoverAzureOptions, input),
  createDeployment: (input) => ipcRenderer.invoke(CHANNELS.createDeployment, input),
  runLifecycleAction: (input) => ipcRenderer.invoke(CHANNELS.runLifecycleAction, input),
  updateFirewall: (input) => ipcRenderer.invoke(CHANNELS.updateFirewall, input),
  listFirewallRules: (input) => ipcRenderer.invoke(CHANNELS.listFirewallRules, input),
  createFirewallRule: (input) => ipcRenderer.invoke(CHANNELS.createFirewallRule, input),
  updateFirewallRule: (input) => ipcRenderer.invoke(CHANNELS.updateFirewallRule, input),
  deleteFirewallRule: (input) => ipcRenderer.invoke(CHANNELS.deleteFirewallRule, input),
  prepareDestroyDeployment: (input) => ipcRenderer.invoke(CHANNELS.prepareDestroyDeployment, input),
  executeDestroyDeployment: (input) => ipcRenderer.invoke(CHANNELS.executeDestroyDeployment, input),
  openSshWindow: (input) => ipcRenderer.invoke(CHANNELS.openSshWindow, input),
  approveSshHostKey: (input) => ipcRenderer.invoke(CHANNELS.approveSshHostKey, input),
  onChanged: (listener) => {
    if (typeof listener !== "function") throw new TypeError("change listener must be a function");
    const handler = (_event: Electron.IpcRendererEvent, ...payload: unknown[]): void => {
      if (
        payload.length !== 1 ||
        (payload[0] !== "snapshot" && payload[0] !== "transcripts")
      ) return;
      listener(payload[0]);
    };
    ipcRenderer.on(CHANNELS.changed, handler);
    return () => ipcRenderer.removeListener(CHANNELS.changed, handler);
  },
  onNavigationRequested: (listener) => {
    if (typeof listener !== "function") throw new TypeError("navigation listener must be a function");
    navigationListeners.add(listener);
    const pending = pendingNavigationRequest;
    if (pending) {
      queueMicrotask(() => {
        if (
          navigationListeners.has(listener) &&
          pendingNavigationRequest === pending
        ) {
          pendingNavigationRequest = undefined;
          listener(pending);
        }
      });
    }
    return () => navigationListeners.delete(listener);
  },
  onThemeChanged: (listener) => {
    if (typeof listener !== "function") throw new TypeError("theme listener must be a function");
    themeListeners.add(listener);
    if (latestTheme !== undefined) {
      queueMicrotask(() => {
        if (themeListeners.has(listener) && latestTheme !== undefined) listener(latestTheme);
      });
    }
    return () => themeListeners.delete(listener);
  },
};

installRestrictedTargetContextMenuSignal();

contextBridge.exposeInMainWorld("cloudDeployment", Object.freeze(api));
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

function parseNavigationRequest(payload: readonly unknown[]): CloudDeploymentNavigationRequest | undefined {
  if (payload.length !== 1 || !isRecord(payload[0])) return undefined;
  const request = payload[0];
  if (!isUuidV4(request["deploymentId"])) return undefined;
  if (
    request["view"] === "firewall" &&
    hasExactKeys(request, ["view", "deploymentId"])
  ) {
    return Object.freeze({ view: "firewall", deploymentId: request["deploymentId"] });
  }
  if (
    request["view"] === "deployments" &&
    hasExactKeys(request, ["view", "deploymentId", "action"]) &&
    (request["action"] === "start" ||
      request["action"] === "stop" ||
      request["action"] === "terminate" ||
      request["action"] === "ssh")
  ) {
    return Object.freeze({
      view: "deployments",
      deploymentId: request["deploymentId"],
      action: request["action"],
    });
  }
  return undefined;
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

function isUuidV4(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
