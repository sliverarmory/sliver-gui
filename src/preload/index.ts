import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";

import { createApplicationZoomAPI, type ApplicationZoomResizeTarget } from "./application-zoom.js";
import { WORKSPACE_ZOOM_CHANGED_CHANNEL } from "../shared/application-zoom-contracts.js";

import {
  IPC,
  IPC_INVOKE,
  type SliverDesktopAPI,
  type SliverDesktopInvokeAPI,
  type SliverSnapshot,
} from "../shared/contracts.js";
import {
  APPLICATION_CONTEXT_MENU_IPC,
  parseApplicationContextMenuActionRequest,
  parseApplicationContextMenuRequest,
  parseApplicationContextMenuVisibilityRequest,
  type ApplicationContextMenuAPI,
} from "../shared/application-context-menu-contracts.js";
import type { TargetOperationRecord } from "../shared/operation-contracts.js";
import {
  SESSION_DROPPED_UPLOAD_IPC_CHANNEL,
  parseSessionDroppedUploadInput,
  parseSessionDroppedUploadIpcRequest,
} from "../shared/session-contracts.js";
import {
  LOOT_DROPPED_ADD_IPC_CHANNEL,
  parseDroppedLootIpcRequest,
} from "../shared/operator-data-contracts.js";
import { parseApplicationUpdateState } from "../shared/application-update-contracts.js";
import { isResolvedApplicationIcon, parseApplicationSettingsState } from "../shared/application-settings-contracts.js";
import { parseSliverReleaseDownloadEvent } from "../shared/release-contracts.js";
import {
  STREAM_PROTOCOL_VERSION,
  isOpaqueStreamId,
  parseStreamAttachRequest,
} from "../shared/stream-contracts.js";
import type { TargetRef } from "../shared/target-contracts.js";
import {
  SCRIPT_TASK_IPC, parseScriptTaskCommand, parseScriptTaskSnapshot,
  type ScriptTaskManagerAPI,
} from "../shared/script-task-manager-contracts.js";
import {
  CONSOLE_PROTOCOL_VERSION,
  parseConsoleAttachRequest,
  parseConsoleTabShortcutIndex,
} from "../shared/console-contracts.js";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RESTRICTED_CONTEXT_MENU_ATTRIBUTE = "data-application-context-menu-policy" as const;
const RESTRICTED_CONTEXT_MENU_VALUE = "inspect-only" as const;
const RESTRICTED_CONTEXT_MENU_SELECTOR =
  '[data-application-context-menu-policy="inspect-only"]' as const;

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

function openStream(attachmentToken: string, correlationId: string): void {
  const request = parseStreamAttachRequest({
    v: STREAM_PROTOCOL_VERSION,
    attachmentToken,
  });
  if (typeof correlationId !== "string" || !UUID_V4_PATTERN.test(correlationId)) {
    throw new TypeError("stream correlationId must be a UUID v4");
  }

  const channel = new MessageChannel();
  try {
    ipcRenderer.postMessage(IPC.attach, request, [channel.port1]);
    rendererWindow().postMessage(
      Object.freeze({
        source: "sliver-preload",
        type: "stream-port",
        v: STREAM_PROTOCOL_VERSION,
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

function openConsoleStream(attachmentToken: string, correlationId: string): void {
  const request = parseConsoleAttachRequest({
    v: CONSOLE_PROTOCOL_VERSION,
    attachmentToken,
  });
  if (typeof correlationId !== "string" || !UUID_V4_PATTERN.test(correlationId)) {
    throw new TypeError("console stream correlationId must be a UUID v4");
  }

  const channel = new MessageChannel();
  try {
    ipcRenderer.postMessage(IPC.attachConsole, request, [channel.port1]);
    rendererWindow().postMessage(
      Object.freeze({
        source: "sliver-preload",
        type: "console-stream-port",
        v: CONSOLE_PROTOCOL_VERSION,
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

function rendererWindow(): RendererWindowBridge {
  const candidate = (globalThis as { window?: unknown }).window;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("postMessage" in candidate) ||
    typeof candidate.postMessage !== "function"
  ) {
    throw new Error("renderer window bridge is unavailable");
  }
  return candidate as RendererWindowBridge;
}

function closePort(port: MessagePort): void {
  try {
    port.close();
  } catch {
    // A transferred port may already be detached from this realm.
  }
}

function createInvokeApi(): SliverDesktopInvokeAPI {
  // Generate routes from the shared method-to-channel map so methods cannot be
  // wired to a different same-signature channel. Electron leaves invoke results
  // unconstrained, so keep the transport assertion isolated in this adapter.
  return Object.fromEntries(
    Object.entries(IPC_INVOKE).map(([method, channel]) => [
      method,
      (...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
    ]),
  ) as SliverDesktopInvokeAPI;
}

const api: SliverDesktopAPI = {
  ...createInvokeApi(),
  addDroppedLoot: (file) => {
    let sourcePath: string;
    try {
      sourcePath = webUtils.getPathForFile(file);
    } catch {
      throw new TypeError("Dropped loot must be backed by a local file");
    }
    if (!sourcePath) throw new TypeError("Dropped loot must be backed by a local file");
    return ipcRenderer.invoke(LOOT_DROPPED_ADD_IPC_CHANNEL, parseDroppedLootIpcRequest({ sourcePath }));
  },
  uploadDroppedSessionFile: (file, input) => {
    const parsedInput = parseSessionDroppedUploadInput(input);
    let sourcePath: string;
    try {
      sourcePath = webUtils.getPathForFile(file);
    } catch {
      throw new TypeError("Dropped upload must be backed by a local file");
    }
    if (!sourcePath) throw new TypeError("Dropped upload must be backed by a local file");
    const request = parseSessionDroppedUploadIpcRequest({ sourcePath, input: parsedInput });
    return ipcRenderer.invoke(SESSION_DROPPED_UPLOAD_IPC_CHANNEL, request);
  },
  onScriptsChanged: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on(IPC.scriptsChanged, handler);
    return () => ipcRenderer.removeListener(IPC.scriptsChanged, handler);
  },
  onScriptEditorRequested: (listener) => onFixedEvent(IPC.scriptEditorRequested, listener),
  onSavedConfigsChanged: (listener) => onFixedEvent(IPC.savedConfigsChanged, listener),
  openStream,
  openConsoleStream,
  onSnapshotChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: SliverSnapshot) => listener(snapshot);
    ipcRenderer.on(IPC.snapshotChanged, handler);
    return () => ipcRenderer.removeListener(IPC.snapshotChanged, handler);
  },
  onOperationChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, operation: TargetOperationRecord) => listener(operation);
    ipcRenderer.on(IPC.operationChanged, handler);
    return () => ipcRenderer.removeListener(IPC.operationChanged, handler);
  },
  onBeaconTasksInvalidated: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, target: TargetRef) => listener(target);
    ipcRenderer.on(IPC.beaconTasksInvalidated, handler);
    return () => ipcRenderer.removeListener(IPC.beaconTasksInvalidated, handler);
  },
  onSessionShellsChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, preferredResourceId?: unknown) => {
      if (
        preferredResourceId === undefined ||
        (typeof preferredResourceId === "string" && isOpaqueStreamId(preferredResourceId))
      ) listener(preferredResourceId);
    };
    ipcRenderer.on(IPC.sessionShellsChanged, handler);
    return () => ipcRenderer.removeListener(IPC.sessionShellsChanged, handler);
  },
  onReleaseDownloadChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      try {
        listener(parseSliverReleaseDownloadEvent(value));
      } catch {
        // Drop malformed main-to-renderer events instead of widening the bridge.
      }
    };
    ipcRenderer.on(IPC.releaseDownloadChanged, handler);
    return () => ipcRenderer.removeListener(IPC.releaseDownloadChanged, handler);
  },
  onApplicationUpdateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      try {
        listener(parseApplicationUpdateState(value));
      } catch {
        // Drop malformed main-to-renderer events instead of widening the bridge.
      }
    };
    ipcRenderer.on(IPC.applicationUpdateChanged, handler);
    return () => ipcRenderer.removeListener(IPC.applicationUpdateChanged, handler);
  },
  onApplicationSettingsChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      try {
        listener(parseApplicationSettingsState(value));
      } catch {
        // Drop malformed main-to-renderer events instead of widening the bridge.
      }
    };
    ipcRenderer.on(IPC.applicationSettingsChanged, handler);
    return () => ipcRenderer.removeListener(IPC.applicationSettingsChanged, handler);
  },
  onApplicationIconChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, ...payload: unknown[]): void => {
      if (payload.length !== 1 || !isResolvedApplicationIcon(payload[0])) return;
      listener(payload[0]);
    };
    ipcRenderer.on(IPC.applicationIconChanged, handler);
    return () => ipcRenderer.removeListener(IPC.applicationIconChanged, handler);
  },
  onCommandPaletteRequested: (listener) => onFixedEvent(IPC.commandPaletteRequested, listener),
  onConsoleNewTabRequested: (listener) => onFixedEvent(IPC.consoleNewTabRequested, listener),
  onConsoleCloseTabRequested: (listener) => onFixedEvent(IPC.consoleCloseTabRequested, listener),
  onConsoleSelectTabRequested: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, ...payload: unknown[]): void => {
      if (payload.length !== 1) return;
      try {
        listener(parseConsoleTabShortcutIndex(payload[0]));
      } catch {
        // Drop malformed main-to-renderer events instead of widening the bridge.
      }
    };
    ipcRenderer.on(IPC.consoleSelectTabRequested, handler);
    return () => ipcRenderer.removeListener(IPC.consoleSelectTabRequested, handler);
  },
  onConsoleSettingsRequested: (listener) => onFixedEvent(IPC.consoleSettingsRequested, listener),
};

installRestrictedTargetContextMenuSignal();

contextBridge.exposeInMainWorld("sliver", Object.freeze(api));
contextBridge.exposeInMainWorld("applicationZoom", createApplicationZoomAPI(
  webFrame,
  (globalThis as unknown as { window: ApplicationZoomResizeTarget }).window,
  () => ipcRenderer.send(WORKSPACE_ZOOM_CHANGED_CHANNEL),
));
contextBridge.exposeInMainWorld("applicationContextMenu", Object.freeze({
  onMenuRequested: (listener) => {
    if (typeof listener !== "function") throw new TypeError("context-menu listener must be a function");
    const handler = (_event: Electron.IpcRendererEvent, ...payload: unknown[]): void => {
      if (payload.length !== 1) return;
      try {
        listener(parseApplicationContextMenuRequest(payload[0]));
      } catch {
        // Drop malformed main-to-renderer events instead of widening the bridge.
      }
    };
    ipcRenderer.on(APPLICATION_CONTEXT_MENU_IPC.menuRequested, handler);
    return () => ipcRenderer.removeListener(APPLICATION_CONTEXT_MENU_IPC.menuRequested, handler);
  },
  executeAction: (request) => ipcRenderer.invoke(
    APPLICATION_CONTEXT_MENU_IPC.executeAction,
    parseApplicationContextMenuActionRequest(request),
  ),
  setOpen: (request) => ipcRenderer.invoke(
    APPLICATION_CONTEXT_MENU_IPC.setOpen,
    parseApplicationContextMenuVisibilityRequest(request),
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
      ipcRenderer.send(APPLICATION_CONTEXT_MENU_IPC.restrictedTarget);
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

function onFixedEvent(channel: string, listener: () => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, ...payload: unknown[]): void => {
    if (payload.length === 0) listener();
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// Native menu requests may arrive before React has mounted the script host.
// Keep only the latest edit and one payload-free host request in this document.
const scriptHostListeners = new Set<() => void>();
const scriptEditListeners = new Set<(id: string) => void>();
let scriptHostPending = false;
let scriptEditPending: string | undefined;
ipcRenderer.on(SCRIPT_TASK_IPC.hostRequested, (_event, ...args: unknown[]) => {
  if (args.length !== 0) return;
  scriptHostPending = scriptHostListeners.size === 0;
  for (const listener of scriptHostListeners) listener();
});
ipcRenderer.on(SCRIPT_TASK_IPC.editRequested, (_event, ...args: unknown[]) => {
  if (args.length !== 1 || typeof args[0] !== "string" || !UUID_V4_PATTERN.test(args[0])) return;
  scriptEditPending = scriptEditListeners.size === 0 ? args[0] : undefined;
  for (const listener of scriptEditListeners) listener(args[0]);
});
const scriptTaskApi: ScriptTaskManagerAPI = {
  open: () => ipcRenderer.invoke(SCRIPT_TASK_IPC.open),
  getState: () => ipcRenderer.invoke(SCRIPT_TASK_IPC.getState),
  publish: (snapshot) => ipcRenderer.invoke(SCRIPT_TASK_IPC.publish, parseScriptTaskSnapshot(snapshot)),
  command: (command) => ipcRenderer.invoke(SCRIPT_TASK_IPC.command, parseScriptTaskCommand(command)),
  ownerReady: () => ipcRenderer.invoke(SCRIPT_TASK_IPC.ownerReady),
  onChanged: (listener) => {
    if (typeof listener !== "function") throw new TypeError("Script task listener must be a function");
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      if (args.length !== 1) return;
      try { listener(parseScriptTaskSnapshot(args[0])); } catch { /* Drop malformed data. */ }
    };
    ipcRenderer.on(SCRIPT_TASK_IPC.changed, handler);
    return () => ipcRenderer.removeListener(SCRIPT_TASK_IPC.changed, handler);
  },
  onCommand: (listener) => {
    if (typeof listener !== "function") throw new TypeError("Script command listener must be a function");
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      if (args.length !== 1) return;
      try { listener(parseScriptTaskCommand(args[0])); } catch { /* Drop malformed data. */ }
    };
    ipcRenderer.on(SCRIPT_TASK_IPC.commandRequested, handler);
    return () => ipcRenderer.removeListener(SCRIPT_TASK_IPC.commandRequested, handler);
  },
  onHostRequested: (listener) => {
    if (typeof listener !== "function") throw new TypeError("Script host listener must be a function");
    scriptHostListeners.add(listener);
    queueMicrotask(() => {
      if (scriptHostPending && scriptHostListeners.has(listener)) { scriptHostPending = false; listener(); }
    });
    return () => { scriptHostListeners.delete(listener); };
  },
  onEditRequested: (listener) => {
    if (typeof listener !== "function") throw new TypeError("Script edit listener must be a function");
    scriptEditListeners.add(listener);
    queueMicrotask(() => {
      if (scriptEditPending && scriptEditListeners.has(listener)) {
        const id = scriptEditPending; scriptEditPending = undefined; listener(id);
      }
    });
    return () => { scriptEditListeners.delete(listener); };
  },
  getTerminalRuntime: () => ipcRenderer.invoke(SCRIPT_TASK_IPC.getTerminalRuntime),
  getApplicationSettings: () => ipcRenderer.invoke(SCRIPT_TASK_IPC.getApplicationSettings),
  onApplicationSettingsChanged: (listener) => {
    if (typeof listener !== "function") throw new TypeError("Script settings listener must be a function");
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      if (args.length !== 1) return;
      try { listener(parseApplicationSettingsState(args[0])); } catch { /* Drop malformed settings. */ }
    };
    ipcRenderer.on(IPC.applicationSettingsChanged, handler);
    return () => ipcRenderer.removeListener(IPC.applicationSettingsChanged, handler);
  },
};
contextBridge.exposeInMainWorld("scriptTasks", Object.freeze(scriptTaskApi));
