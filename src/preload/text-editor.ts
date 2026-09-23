import { contextBridge, ipcRenderer } from "electron";
import type { ApplicationSettingsState } from "../shared/application-settings-contracts.js";
import type { TextEditorAPI } from "../shared/text-editor-contracts.js";

// Literal channels and type-only imports keep the sandbox preload self-contained.
// Electron main independently validates every request and its sending frame.
const CHANNELS = Object.freeze({
  getDocument: "sliver:text-editor:document:get",
  openFile: "sliver:text-editor:file:open",
  save: "sliver:text-editor:file:save",
  setDirty: "sliver:text-editor:dirty:set",
  getApplicationSettings: "sliver:text-editor:application-settings:get",
  applicationSettingsChanged: "sliver:application-settings:changed",
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
};

contextBridge.exposeInMainWorld("textEditor", Object.freeze(api));
