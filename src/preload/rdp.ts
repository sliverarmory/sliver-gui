import { contextBridge, ipcRenderer } from "electron";
import { parseApplicationSettingsState, parseApplicationSettingsUpdateInput } from "../shared/application-settings-contracts.js";
import {
  APPLICATION_CONTEXT_MENU_IPC,
  parseApplicationContextMenuActionRequest,
  parseApplicationContextMenuRequest,
  parseApplicationContextMenuVisibilityRequest,
  type ApplicationContextMenuAPI,
} from "../shared/application-context-menu-contracts.js";
import {
  RDP_IPC,
  RDP_MAX_SESSIONS,
  RDP_PORT_MESSAGE,
  type RdpAttachment,
  type RdpCertificateReview,
  type RdpProfile,
  type RdpTab,
  type RdpWindowAPI,
  type RdpWindowState,
  type RdpFileTransferProgressEvent,
} from "../shared/rdp-contracts.js";
import { parseRdpConnect, parseRdpFileTransferProgress, parseRdpOptions, parseRdpPreview, parseRdpProfile, parseRdpSavePreview, rdpBoolean, rdpInteger, rdpPassword, rdpRecord, rdpString } from "../shared/rdp-validation.js";
import type { OperationResult } from "../shared/contracts.js";

const OPTIONS = ["host", "port", "username", "domain", "width", "height", "clipboard", "signInMode"];
const PROFILE = [...OPTIONS, "id", "label", "scaleMode"];
const ID = /^[A-Za-z0-9_-]{43}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const api: RdpWindowAPI = {
  getState: () => invokeValue(RDP_IPC.getState, parseState),
  connect: (input) => {
    keys(input, [...PROFILE.filter((key) => key !== "id"), "password", "profileId", "persistence", "temporaryId"]);
    return invokeValue(RDP_IPC.connect, parseTab, parseRdpConnect(input));
  },
  cancelTemporary: (id) => invokeEmpty(RDP_IPC.cancelTemporary, identity(id)),
  reconnect: (input) => {
    const item = keys(input, ["tabId", "password"]);
    return invokeValue(RDP_IPC.reconnect, parseTab, { tabId: identity(item["tabId"]), ...(item["password"] === undefined ? {} : { password: rdpPassword(item["password"]) }) });
  },
  disconnect: (id) => invokeEmpty(RDP_IPC.disconnect, identity(id)),
  closeTab: (id) => invokeEmpty(RDP_IPC.closeTab, identity(id)),
  selectTab: (id) => invokeEmpty(RDP_IPC.selectTab, identity(id)),
  renameTab: (input) => { const item = keys(input, ["tabId", "label"]); return invokeEmpty(RDP_IPC.renameTab, { tabId: identity(item["tabId"]), label: rdpString(item["label"], 120) }); },
  saveProfile: (input) => { keys(input, PROFILE); return invokeValue(RDP_IPC.saveProfile, parseProfile, parseRdpProfile(input)); },
  savePreview: (input) => invokeEmpty(RDP_IPC.savePreview, parseRdpSavePreview(input)),
  deleteProfile: (id) => invokeEmpty(RDP_IPC.deleteProfile, identity(id)),
  respondToCertificate: (input) => {
    const item = keys(input, ["token", "decision"]);
    const decision = item["decision"];
    if (decision !== "reject" && decision !== "once" && decision !== "pin") throw new TypeError("Invalid certificate decision");
    return invokeEmpty(RDP_IPC.respondToCertificate, { token: opaque(item["token"]), decision });
  },
  attach: (id) => invokeValue(RDP_IPC.attach, parseAttachment, identity(id)),
  openRdpStream: (attachmentToken, correlationId) => {
    opaque(attachmentToken);
    if (typeof correlationId !== "string" || !UUID.test(correlationId)) throw new TypeError("Invalid RDP stream correlation ID");
    const channel = new MessageChannel();
    try {
      ipcRenderer.postMessage(RDP_IPC.openStream, { attachmentToken }, [channel.port1]);
      rendererWindow().postMessage({ type: RDP_PORT_MESSAGE, correlationId }, "*", [channel.port2]);
    } catch (error) { channel.port1.close(); channel.port2.close(); throw error; }
  },
  clipboard: (input) => {
    const item = keys(input, ["tabId", "direction"]);
    if (item["direction"] !== "send" && item["direction"] !== "receive") throw new TypeError("Invalid RDP clipboard direction");
    return invokeEmpty(RDP_IPC.clipboard, { tabId: identity(item["tabId"]), direction: item["direction"] });
  },
  setInputCapture: (input) => {
    const item = keys(input, ["tabId", "captured"]);
    return invokeEmpty(RDP_IPC.setInputCapture, { tabId: identity(item["tabId"]), captured: rdpBoolean(item["captured"]) });
  },
  toggleFullscreen: () => invokeEmpty(RDP_IPC.toggleFullscreen),
  getApplicationSettings: async () => parseApplicationSettingsState(await ipcRenderer.invoke(RDP_IPC.getApplicationSettings)),
  updateApplicationSettings: (input) => invokeValue(RDP_IPC.updateApplicationSettings, parseApplicationSettingsState, parseApplicationSettingsUpdateInput(input)),
  onStateChanged: (listener) => subscribe(RDP_IPC.stateChanged, parseState, listener),
  onFileTransferProgress: (listener) => subscribe(RDP_IPC.fileTransferProgress, parseTransferEvent, listener),
  onApplicationSettingsChanged: (listener) => subscribe(RDP_IPC.applicationSettingsChanged, parseApplicationSettingsState, listener),
};

contextBridge.exposeInMainWorld("rdp", Object.freeze(api));
contextBridge.exposeInMainWorld("applicationContextMenu", Object.freeze({
  onMenuRequested: (listener) => subscribe(APPLICATION_CONTEXT_MENU_IPC.menuRequested, parseApplicationContextMenuRequest, listener),
  executeAction: (input) => ipcRenderer.invoke(APPLICATION_CONTEXT_MENU_IPC.executeAction, parseApplicationContextMenuActionRequest(input)).then((value) => value === true),
  setOpen: (input) => ipcRenderer.invoke(APPLICATION_CONTEXT_MENU_IPC.setOpen, parseApplicationContextMenuVisibilityRequest(input)).then((value) => value === true),
} satisfies ApplicationContextMenuAPI));

async function invokeValue<T>(channel: string, parse: (value: unknown) => T, ...args: unknown[]): Promise<OperationResult<T>> {
  const result = rdpRecord(await ipcRenderer.invoke(channel, ...args));
  if (result["ok"] === false) return { ok: false, error: displayText(result["error"], 2048) } as OperationResult<T>;
  if (result["ok"] !== true || !Object.hasOwn(result, "value")) throw new TypeError("Invalid RDP response");
  return { ok: true, value: parse(result["value"]) } as OperationResult<T>;
}

async function invokeEmpty(channel: string, ...args: unknown[]): Promise<OperationResult> {
  const result = rdpRecord(await ipcRenderer.invoke(channel, ...args));
  if (result["ok"] === false) return { ok: false, error: displayText(result["error"], 2048) };
  if (result["ok"] !== true) throw new TypeError("Invalid RDP response");
  return { ok: true };
}

function subscribe<T>(channel: string, parse: (value: unknown) => T, listener: (value: T) => void): () => void {
  if (typeof listener !== "function") throw new TypeError("RDP event listener must be a function");
  const handler = (_event: Electron.IpcRendererEvent, ...payload: unknown[]): void => {
    if (payload.length !== 1) return;
    let value: T;
    try { value = parse(payload[0]); } catch { return; }
    listener(value);
  };
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

function parseState(raw: unknown): RdpWindowState {
  const value = keys(raw, ["tabs", "profiles", "activeTabId", "pendingConnection", "securePersistenceAvailable", "maxSessions"]);
  if (!Array.isArray(value["tabs"]) || value["tabs"].length > 128 || !Array.isArray(value["profiles"]) || value["profiles"].length > 256) throw new TypeError("Invalid RDP state");
  const tabs = value["tabs"].map(parseTab);
  const profiles = value["profiles"].map(parseProfile);
  if (new Set(tabs.map(({ id }) => id)).size !== tabs.length || new Set(profiles.map(({ id }) => id)).size !== profiles.length) throw new TypeError("Duplicate RDP identities");
  const activeTabId = value["activeTabId"] === undefined ? undefined : identity(value["activeTabId"]);
  if (activeTabId !== undefined && !tabs.some(({ id }) => id === activeTabId)) throw new TypeError("Invalid active RDP tab");
  const pending = value["pendingConnection"] === undefined ? undefined : keys(value["pendingConnection"], ["id", "label", "host", "port"]);
  if (pending && pending["host"] !== "127.0.0.1") throw new TypeError("Invalid temporary RDP endpoint");
  return Object.freeze({ tabs: Object.freeze(tabs), profiles: Object.freeze(profiles),
    ...(pending === undefined ? {} : { pendingConnection: Object.freeze({ id: identity(pending["id"]), label: rdpString(pending["label"], 120), host: "127.0.0.1", port: rdpInteger(pending["port"], 1, 65535) }) }),
    ...(activeTabId === undefined ? {} : { activeTabId }), securePersistenceAvailable: rdpBoolean(value["securePersistenceAvailable"]),
    maxSessions: rdpInteger(value["maxSessions"], 1, RDP_MAX_SESSIONS) });
}

function parseTab(raw: unknown): RdpTab {
  const value = keys(raw, [...PROFILE, "attempt", "profileId", "temporary", "state", "error", "review", "clipboardReady", "clipboardAvailable", "clipboardFilesAvailable", "clipboardFilesSupported", "fileTransfer"]);
  const state = value["state"];
  if (state !== "connecting" && state !== "certificate-review" && state !== "authenticating" && state !== "active" && state !== "disconnected" && state !== "failed") throw new TypeError("Invalid RDP connection state");
  return Object.freeze({ ...parseRdpOptions(value), id: identity(value["id"]), label: rdpString(value["label"], 120), scaleMode: scale(value["scaleMode"]),
    attempt: rdpInteger(value["attempt"], 0, Number.MAX_SAFE_INTEGER), state, clipboardReady: rdpBoolean(value["clipboardReady"]), clipboardAvailable: rdpBoolean(value["clipboardAvailable"]),
    ...(value["clipboardFilesAvailable"] === undefined ? {} : { clipboardFilesAvailable: rdpBoolean(value["clipboardFilesAvailable"]) }),
    ...(value["clipboardFilesSupported"] === undefined ? {} : { clipboardFilesSupported: rdpBoolean(value["clipboardFilesSupported"]) }),
    ...(value["fileTransfer"] === undefined ? {} : { fileTransfer: parseRdpFileTransferProgress(value["fileTransfer"]) }),
    ...(value["profileId"] === undefined ? {} : { profileId: identity(value["profileId"]) }),
    ...(value["temporary"] === undefined ? {} : { temporary: rdpBoolean(value["temporary"]) }),
    ...(value["error"] === undefined ? {} : { error: displayText(value["error"], 2048) }),
    ...(value["review"] === undefined ? {} : { review: parseCertificate(value["review"]) }) });
}

function parseTransferEvent(raw: unknown): RdpFileTransferProgressEvent {
  const value = keys(raw, ["tabId", "attempt", "progress"]);
  return Object.freeze({ tabId: identity(value["tabId"]), attempt: rdpInteger(value["attempt"], 1, Number.MAX_SAFE_INTEGER),
    progress: parseRdpFileTransferProgress(value["progress"]) });
}

function parseProfile(raw: unknown): RdpProfile {
  const value = keys(raw, [...PROFILE, "hasCredential", "credentialPersistence", "preview"]);
  const persistence = value["credentialPersistence"];
  if (persistence !== "none" && persistence !== "session" && persistence !== "secure") throw new TypeError("Invalid RDP credential state");
  return Object.freeze({ ...parseRdpOptions(value), id: identity(value["id"]), label: rdpString(value["label"], 120), scaleMode: scale(value["scaleMode"]),
    hasCredential: rdpBoolean(value["hasCredential"]), credentialPersistence: persistence,
    ...(value["preview"] === undefined ? {} : { preview: parseRdpPreview(value["preview"]) }) });
}

function parseCertificate(raw: unknown): RdpCertificateReview {
  const value = keys(raw, ["token", "host", "port", "fingerprint", "subject", "issuer", "validFrom", "validTo", "reason", "canOverride", "expiresAt"]);
  const fingerprint = rdpString(value["fingerprint"], 128);
  if (!/^[0-9a-f]{64}$/iu.test(fingerprint)) throw new TypeError("Invalid RDP certificate fingerprint");
  const expiresAt = rdpString(value["expiresAt"], 100);
  if (!Number.isFinite(Date.parse(expiresAt))) throw new TypeError("Invalid RDP certificate expiry");
  return Object.freeze({ token: opaque(value["token"]), host: rdpString(value["host"], 253), port: rdpInteger(value["port"], 1, 65535), fingerprint,
    subject: displayText(value["subject"], 8192), issuer: displayText(value["issuer"], 8192), validFrom: displayText(value["validFrom"], 256),
    validTo: displayText(value["validTo"], 256), reason: displayText(value["reason"], 2048), canOverride: rdpBoolean(value["canOverride"]), expiresAt });
}

function parseAttachment(raw: unknown): RdpAttachment {
  const value = keys(raw, ["tabId", "attempt", "attachmentToken"]);
  return Object.freeze({ tabId: identity(value["tabId"]), attempt: rdpInteger(value["attempt"], 0, Number.MAX_SAFE_INTEGER), attachmentToken: opaque(value["attachmentToken"]) });
}
function keys(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  const value = rdpRecord(raw);
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError("Unexpected RDP request field");
  return value;
}
function identity(value: unknown): string { return rdpString(value, 80); }
function opaque(value: unknown): string { if (typeof value !== "string" || !ID.test(value)) throw new TypeError("Invalid RDP attachment capability"); return value; }
function scale(value: unknown): "fit" | "actual" { if (value !== "fit" && value !== "actual") throw new TypeError("Invalid RDP scale mode"); return value; }
function displayText(value: unknown, maximum: number): string { if (typeof value !== "string" || value.length > maximum || value.includes("\0")) throw new TypeError("Invalid RDP display text"); return value; }
function rendererWindow(): { postMessage(message: unknown, targetOrigin: string, transfer: MessagePort[]): void } {
  const value = (globalThis as { window?: { postMessage(message: unknown, targetOrigin: string, transfer: MessagePort[]): void } }).window;
  if (!value) throw new TypeError("The RDP renderer is unavailable");
  return value;
}

const RESTRICTED_CONTEXT_MENU_ATTRIBUTE = "data-application-context-menu-policy";
const RESTRICTED_CONTEXT_MENU_VALUE = "inspect-only";
const RESTRICTED_CONTEXT_MENU_SELECTOR = '[data-application-context-menu-policy="inspect-only"]';

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


installRestrictedTargetContextMenuSignal();
