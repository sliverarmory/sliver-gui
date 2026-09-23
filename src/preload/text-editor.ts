import { contextBridge, ipcRenderer } from "electron";
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

contextBridge.exposeInMainWorld("textEditor", Object.freeze(api));
