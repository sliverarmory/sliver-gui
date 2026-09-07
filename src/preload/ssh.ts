import { contextBridge, ipcRenderer } from "electron";

import type {
  ApplicationSettingsState,
} from "../shared/application-settings-contracts.js";
import type {
  ManagedSshTarget,
  SshTabLaunchContext,
  SshWindowAPI,
} from "../shared/ssh-contracts.js";

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

const SSH_PROTOCOL_VERSION = 1 as const;
const SSH_MAX_TABS_PER_WINDOW = 10;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TERMINAL_FONT_IDS = new Set(["fira-code", "jetbrains-mono", "cascadia-mono", "source-code-pro"]);
const TERMINAL_CURSOR_STYLES = new Set(["block", "underline", "bar"]);
const APPLICATION_THEMES = new Set(["system", "light", "dark"]);
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

interface RendererWindowBridge {
  postMessage(message: unknown, targetOrigin: string, transfer: MessagePort[]): void;
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

contextBridge.exposeInMainWorld("ssh", Object.freeze(api));

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
  const context = exactRecord(value, ["tabId", "attachmentToken", "target"], "SSH tab context");
  return Object.freeze({
    tabId: opaqueId(context["tabId"], "SSH tab identity"),
    attachmentToken: opaqueId(context["attachmentToken"], "SSH attachment token"),
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
    name: plainString(target["name"], 1, 128, "SSH target name"),
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
    ["v", "revision", "theme", "reduceMotion", "commandPaletteShortcut", "terminal"],
    "application settings",
  );
  if (state["v"] !== 2 || !Number.isSafeInteger(state["revision"]) || (state["revision"] as number) < 0) {
    throw new TypeError("Invalid application settings state");
  }
  if (!APPLICATION_THEMES.has(stringValue(state["theme"]))) throw new TypeError("Invalid application theme");
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
    v: 2,
    revision: state["revision"] as number,
    theme: state["theme"] as ApplicationSettingsState["theme"],
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
