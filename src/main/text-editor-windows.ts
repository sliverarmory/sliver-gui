import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { BrowserWindow, dialog, ipcMain, nativeTheme, type IpcMainInvokeEvent, type WebContents } from "electron";

import type { ApplicationSettingsState } from "../shared/application-settings-contracts.js";
import type { OperationResult } from "../shared/contracts.js";
import {
  parseTextEditorSettingsUpdateInput,
  type TextEditorSettingsState,
  type TextEditorSettingsUpdateInput,
} from "../shared/text-editor-settings-contracts.js";
import {
  parseTextEditorRemoteOverwriteResponse, parseTextEditorSaveInput, TEXT_EDITOR_IPC, TEXT_EDITOR_MAX_BYTES,
  type TextEditorDocument, type TextEditorRemoteOverwriteRequest, type TextEditorSaveInput,
} from "../shared/text-editor-contracts.js";
import { SESSION_EDITOR_MAX_BYTES, type SessionDestructiveActionPlan } from "../shared/session-contracts.js";
import { hardenWindow, isSameRendererDocument } from "./security.js";
import { textEditorWindowOptions } from "./window-options.js";

interface TextEditorWindowsOptions {
  readonly rendererUrl: string;
  readonly preloadPath: string;
  readonly icon?: string;
  readonly getApplicationSettings: () => ApplicationSettingsState;
  readonly getEditorSettings: () => TextEditorSettingsState;
  readonly updateEditorSettings: (input: TextEditorSettingsUpdateInput) => Promise<OperationResult<TextEditorSettingsState>>;
  readonly prepareWindow: (window: BrowserWindow) => void;
  readonly onLocalFileSaved?: (path: string) => void;
  readonly remote?: {
    load(source: WebContents, remotePath: string): Promise<{
      title: string; text: string; expectedSha256: string; binding: unknown;
    }>;
    save(binding: unknown, remotePath: string, expectedSha256: string, text: string,
      confirm: (plan: SessionDestructiveActionPlan) => Promise<boolean>): Promise<{ expectedSha256: string } | null>;
  };
}

export interface InitialTextEditorDocument {
  readonly title?: string;
  readonly text?: string;
  readonly language?: string;
  readonly readOnly?: boolean;
  /** Main-owned path; never accepted from renderer input. */
  readonly localFilePath?: string;
  /** Digest captured when a main-owned file was opened. */
  readonly localFileSha256?: string;
  readonly bom?: boolean;
  readonly remote?: { binding: unknown; path: string; expectedSha256: string };
}

interface EditorState {
  readonly window: BrowserWindow;
  document: TextEditorDocument;
  filePath?: string;
  localFileSha256?: string;
  remote?: { binding: unknown; path: string; expectedSha256: string };
  bom: boolean;
  eol: "\r\n" | "\n" | "\r" | undefined;
  dirty: boolean;
  dirtyRevision: number;
  busy: boolean;
  allowClose: boolean;
  pendingRemoteOverwrite?: {
    readonly requestId: string;
    readonly resolve: (confirmed: boolean) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  };
}

const INVOKE_CHANNELS = [TEXT_EDITOR_IPC.getDocument, TEXT_EDITOR_IPC.openFile,
  TEXT_EDITOR_IPC.save, TEXT_EDITOR_IPC.setDirty, TEXT_EDITOR_IPC.respondToRemoteOverwrite,
  TEXT_EDITOR_IPC.getApplicationSettings, TEXT_EDITOR_IPC.getEditorSettings, TEXT_EDITOR_IPC.updateEditorSettings];

class EditorError extends Error {}
export class RemoteTextEditorError extends Error {}

/** Owns local file authority; the reusable renderer sees only document data. */
export class TextEditorWindows {
  readonly #options: TextEditorWindowsOptions;
  readonly #states = new Map<number, EditorState>();
  #disposed = false;

  constructor(options: TextEditorWindowsOptions) {
    this.#options = options;
    for (const channel of INVOKE_CHANNELS) {
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        try {
          const state = this.#requireSender(event);
          if (channel === TEXT_EDITOR_IPC.save) {
            if (args.length !== 1) throw new EditorError("Invalid text editor save request");
            return await this.#save(state, event, parseTextEditorSaveInput(args[0]));
          }
          if (channel === TEXT_EDITOR_IPC.setDirty) {
            if (args.length !== 1 || typeof args[0] !== "boolean") throw new EditorError("Invalid text editor dirty state");
            state.dirty = args[0];
            state.dirtyRevision += 1;
            state.allowClose = false;
            this.#setTitle(state);
            return { ok: true };
          }
          if (channel === TEXT_EDITOR_IPC.respondToRemoteOverwrite) {
            if (args.length !== 1) throw new EditorError("Invalid remote overwrite response");
            const response = parseTextEditorRemoteOverwriteResponse(args[0]);
            const pending = state.pendingRemoteOverwrite;
            if (!pending || pending.requestId !== response.requestId) {
              throw new EditorError("The remote overwrite review is no longer active");
            }
            delete state.pendingRemoteOverwrite;
            clearTimeout(pending.timer);
            pending.resolve(response.confirmed);
            return { ok: true };
          }
          if (channel === TEXT_EDITOR_IPC.updateEditorSettings) {
            if (args.length !== 1) throw new EditorError("Invalid text editor settings update");
            const result = await this.#options.updateEditorSettings(parseTextEditorSettingsUpdateInput(args[0]));
            if (result.ok && result.value) this.#publishEditorSettings(result.value);
            return result;
          }
          if (args.length !== 0) throw new EditorError("Unexpected text editor arguments");
          if (channel === TEXT_EDITOR_IPC.getDocument) return { ok: true, value: { ...state.document } };
          if (channel === TEXT_EDITOR_IPC.getApplicationSettings) return this.#options.getApplicationSettings();
          if (channel === TEXT_EDITOR_IPC.getEditorSettings) return this.#options.getEditorSettings();
          return await this.#openFile(state, event);
        } catch (error) {
          return { ok: false, error: error instanceof EditorError || error instanceof RemoteTextEditorError
            ? error.message : "The text editor request could not be completed" };
        }
      });
    }
  }

  async open(initial: InitialTextEditorDocument = {}): Promise<void> {
    if (this.#disposed) throw new Error("Text editor windows are disposed");
    const text = initial.text ?? "";
    validateText(text);
    const title = displayTitle(initial.title ?? "Untitled");
    const language = initial.language ?? languageForTitle(title);
    if (!/^[a-z0-9_-]{1,64}$/iu.test(language)) throw new EditorError("Invalid editor language");
    const settings = this.#options.getApplicationSettings();
    const dark = settings.theme === "system" ? nativeTheme.shouldUseDarkColors : settings.theme === "dark";
    const window = new BrowserWindow(textEditorWindowOptions(this.#options.preloadPath, process.platform, this.#options.icon, dark));
    const state: EditorState = {
      window, document: { id: randomUUID(), title, text, language, readOnly: initial.readOnly ?? false,
        ...(initial.remote ? { remote: true } : {}) },
      ...(initial.remote ? { remote: initial.remote } : {}),
      ...(initial.localFilePath ? { filePath: initial.localFilePath } : {}),
      ...(initial.localFileSha256 ? { localFileSha256: initial.localFileSha256 } : {}),
      bom: initial.bom ?? false, eol: detectEol(text), dirty: false, dirtyRevision: 0, busy: false, allowClose: false,
    };
    const contentsId = window.webContents.id;
    this.#states.set(contentsId, state);
    hardenWindow(window, this.#options.rendererUrl, this.#options.rendererUrl);
    window.on("close", (event) => {
      if (state.allowClose) return;
      const wasDirty = state.dirty;
      if (!this.#canDiscard(state)) event.preventDefault();
      else if (wasDirty) state.allowClose = true;
    });
    window.webContents.on("will-prevent-unload", (event) => {
      // preventDefault here explicitly permits Electron to complete the unload.
      // A renderer veto can arrive before its dirty-state IPC. Always prompt
      // unless the user already explicitly approved discarding those changes.
      if (state.allowClose || this.#canDiscard(state, true)) event.preventDefault();
    });
    window.webContents.on("did-start-navigation", () => this.#cancelRemoteOverwrite(state));
    window.webContents.on("render-process-gone", () => this.#cancelRemoteOverwrite(state));
    window.webContents.once("destroyed", () => this.#cancelRemoteOverwrite(state));
    window.once("closed", () => {
      this.#cancelRemoteOverwrite(state);
      this.#states.delete(contentsId);
    });
    this.#setTitle(state);
    try {
      this.#options.prepareWindow(window);
      await window.loadURL(this.#options.rendererUrl);
    } catch (error) {
      this.#states.delete(contentsId);
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  async openLocalFile(path: string, language?: string): Promise<void> {
    const focusExisting = (): boolean => {
      const existing = [...this.#states.values()].find((state) => state.filePath === path && !state.window.isDestroyed());
      if (!existing) return false;
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.show();
      existing.window.focus();
      return true;
    };
    if (focusExisting()) return;
    const bytes = await readBoundedFile(path);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new EditorError("Only UTF-8 text files can be opened"); }
    // Another request can finish opening the same file while this read waits.
    if (focusExisting()) return;
    await this.open({ title: basename(path), text, localFilePath: path,
      localFileSha256: createHash("sha256").update(bytes).digest("hex"),
      ...(language ? { language } : {}),
      bom: bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf });
  }

  async openRemote(source: WebContents, remotePath: string): Promise<void> {
    if (!this.#options.remote) throw new EditorError("Remote text editing is unavailable");
    if (typeof remotePath !== "string" || !remotePath.trim()) throw new EditorError("Select a remote file to edit");
    const loaded = await this.#options.remote.load(source, remotePath);
    validateText(loaded.text);
    if (Buffer.byteLength(loaded.text, "utf8") > SESSION_EDITOR_MAX_BYTES ||
      !/^[0-9a-f]{64}$/u.test(loaded.expectedSha256)) {
      throw new EditorError("The remote file is too large or incomplete for text editing");
    }
    await this.open({ title: loaded.title, text: loaded.text,
      remote: { binding: loaded.binding, path: remotePath, expectedSha256: loaded.expectedSha256 } });
  }

  /** Call before app shutdown begins, while cancelling quit is still possible. */
  allowQuit(): boolean {
    const states = [...this.#states.values()].filter((state) => !state.window.isDestroyed());
    for (const state of states) if ((state.busy || !state.allowClose) && !this.#canDiscard(state)) return false;
    // Clean windows receive no discard approval: their renderer may still
    // report a pending edit through beforeunload before dirty IPC catches up.
    for (const state of states) state.allowClose = state.allowClose || state.dirty;
    return true;
  }

  cancelQuit(): void {
    for (const state of this.#states.values()) state.allowClose = false;
  }

  dispose(): void {
    this.#disposed = true;
    for (const channel of INVOKE_CHANNELS) ipcMain.removeHandler(channel);
    for (const state of this.#states.values()) {
      this.#cancelRemoteOverwrite(state);
      if (!state.window.isDestroyed()) state.window.destroy();
    }
    this.#states.clear();
  }

  #requireSender(event: IpcMainInvokeEvent): EditorState {
    const { sender, senderFrame } = event;
    const state = this.#states.get(sender.id);
    if (this.#disposed || !state || state.window.isDestroyed() || sender.isDestroyed() ||
      state.window.webContents !== sender || !senderFrame || senderFrame.isDestroyed()) {
      throw new EditorError("The text editor request was rejected");
    }
    const mainFrame = sender.mainFrame;
    if (mainFrame.isDestroyed() || mainFrame.processId !== senderFrame.processId ||
      mainFrame.frameToken !== senderFrame.frameToken ||
      !isSameRendererDocument(sender.getURL(), this.#options.rendererUrl) ||
      !isSameRendererDocument(senderFrame.url, this.#options.rendererUrl)) {
      throw new EditorError("The text editor request was rejected");
    }
    return state;
  }

  #canDiscard(state: EditorState, forcePrompt = false): boolean {
    if (state.busy) {
      dialog.showMessageBoxSync(state.window, { type: "info", title: "Text Editor", message: "Wait for the file operation to finish before closing.", buttons: ["OK"] });
      return false;
    }
    if (!state.dirty && !forcePrompt) return true;
    return dialog.showMessageBoxSync(state.window, {
      type: "warning", title: "Unsaved changes", message: `Discard changes to ${state.document.title}?`,
      detail: "Your unsaved changes will be lost.", buttons: ["Cancel", "Discard Changes"],
      defaultId: 0, cancelId: 0, noLink: true,
    }) === 1;
  }

  #setTitle(state: EditorState): void {
    state.window.setTitle(`${state.dirty ? "● " : ""}${state.document.title} — Text Editor`);
    state.window.setDocumentEdited(state.dirty);
  }

  #cancelRemoteOverwrite(state: EditorState): void {
    const pending = state.pendingRemoteOverwrite;
    if (!pending) return;
    delete state.pendingRemoteOverwrite;
    clearTimeout(pending.timer);
    pending.resolve(false);
  }

  #publishEditorSettings(settings: TextEditorSettingsState): void {
    for (const state of this.#states.values()) {
      if (!state.window.isDestroyed() && !state.window.webContents.isDestroyed()) {
        try {
          state.window.webContents.send(TEXT_EDITOR_IPC.editorSettingsChanged, settings);
        } catch {
          // A retiring editor cannot receive preference broadcasts. The store
          // has already committed, and remaining windows still need the update.
        }
      }
    }
  }

  async #confirmRemoteOverwrite(
    state: EditorState,
    event: IpcMainInvokeEvent,
    remotePath: string,
    originalSha256: string,
    plan: SessionDestructiveActionPlan,
  ): Promise<boolean> {
    this.#requireSender(event);
    if (state.pendingRemoteOverwrite) throw new RemoteTextEditorError("Another remote overwrite review is already active");
    const newSha256 = plan.artifact?.sha256;
    if (!newSha256 || !/^[0-9a-f]{64}$/u.test(newSha256)) {
      throw new RemoteTextEditorError("The staged remote edit could not be verified");
    }
    const expiresAt = Date.parse(plan.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new RemoteTextEditorError("The remote overwrite review has expired");
    }
    const request: TextEditorRemoteOverwriteRequest = {
      requestId: randomUUID(),
      path: remotePath,
      target: {
        name: plan.target.name,
        hostname: plan.target.hostname,
        sessionId: plan.target.sessionId,
        backend: {
          id: plan.target.backend.id,
          displayName: plan.target.backend.displayName,
        },
      },
      originalSha256,
      newSha256,
      warning: plan.warning,
    };
    return await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (state.pendingRemoteOverwrite?.requestId !== request.requestId) return;
        delete state.pendingRemoteOverwrite;
        resolve(false);
      }, Math.min(expiresAt - Date.now(), 2_147_483_647));
      timer.unref();
      state.pendingRemoteOverwrite = { requestId: request.requestId, resolve, timer };
      try {
        state.window.webContents.send(TEXT_EDITOR_IPC.remoteOverwriteRequested, request);
      } catch {
        delete state.pendingRemoteOverwrite;
        clearTimeout(timer);
        reject(new RemoteTextEditorError("The remote overwrite review could not be displayed"));
      }
    });
  }

  async #openFile(state: EditorState, event: IpcMainInvokeEvent): Promise<OperationResult<TextEditorDocument | null>> {
    if (state.busy) throw new EditorError("Another file operation is already in progress");
    if (!this.#canDiscard(state)) return { ok: true, value: null };
    state.busy = true;
    state.allowClose = false;
    const revision = state.dirtyRevision;
    try {
      const result = await dialog.showOpenDialog(state.window, { title: "Open text file", properties: ["openFile"] });
      this.#requireSender(event);
      const path = result.filePaths[0];
      if (result.canceled || !path) return { ok: true, value: null };
      const bytes = await readBoundedFile(path);
      this.#requireSender(event);
      if (state.dirtyRevision !== revision) throw new EditorError("The document changed while opening a file. Open it again to continue.");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new EditorError("Only UTF-8 text files can be opened"); }
      validateText(text);
      const title = displayTitle(basename(path));
      state.document = { id: randomUUID(), title, text, language: languageForTitle(title), readOnly: false };
      state.filePath = path;
      delete state.localFileSha256;
      delete state.remote;
      state.bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      state.eol = detectEol(text);
      state.dirty = false;
      state.allowClose = false;
      this.#setTitle(state);
      return { ok: true, value: { ...state.document } };
    } finally { state.busy = false; }
  }

  async #save(state: EditorState, event: IpcMainInvokeEvent, input: TextEditorSaveInput): Promise<OperationResult<{ title: string } | null>> {
    if (state.document.readOnly) throw new EditorError("This document is read-only");
    if (state.busy) throw new EditorError("Another file operation is already in progress");
    validateText(input.text);
    if (state.remote) {
      if (input.saveAs) throw new EditorError("Save As is unavailable for remote files");
      if (Buffer.byteLength(input.text, "utf8") > SESSION_EDITOR_MAX_BYTES) {
        throw new EditorError("Remote text files must be 64 KiB or smaller");
      }
      if (!this.#options.remote) throw new EditorError("Remote text editing is unavailable");
      state.busy = true;
      state.allowClose = false;
      try {
        const remote = state.remote;
        const saved = await this.#options.remote.save(remote.binding, remote.path, remote.expectedSha256, input.text, async (plan) => {
          return await this.#confirmRemoteOverwrite(state, event, remote.path, remote.expectedSha256, plan);
        });
        this.#requireSender(event);
        if (!saved) return { ok: true, value: null };
        remote.expectedSha256 = saved.expectedSha256;
        state.document = { ...state.document, text: input.text };
        return { ok: true, value: { title: state.document.title } };
      } finally { state.busy = false; }
    }
    const text = state.eol ? input.text.replace(/\r\n|\r|\n/gu, state.eol) : input.text;
    const bytes = Buffer.from(`${state.bom ? "\ufeff" : ""}${text}`, "utf8");
    if (bytes.length > TEXT_EDITOR_MAX_BYTES) throw new EditorError("Text files must be 2 MiB or smaller");
    state.busy = true;
    state.allowClose = false;
    try {
      let path = state.filePath;
      if (!path || input.saveAs) {
        const result = await dialog.showSaveDialog(state.window, { title: "Save text file", defaultPath: path ?? state.document.title });
        this.#requireSender(event);
        if (result.canceled || !result.filePath) return { ok: true, value: null };
        path = result.filePath;
      }
      const destination = path;
      const expectedSha256 = state.localFileSha256;
      await writeAtomically(destination, bytes, () => { this.#requireSender(event); },
        expectedSha256 && !input.saveAs
          ? () => assertLocalFileUnchanged(destination, expectedSha256)
          : undefined);
      this.#requireSender(event);
      state.filePath = path;
      if (state.localFileSha256) state.localFileSha256 = createHash("sha256").update(bytes).digest("hex");
      this.#options.onLocalFileSaved?.(path);
      const title = displayTitle(basename(path));
      state.document = { ...state.document, title, text: input.text };
      this.#setTitle(state);
      // The renderer compares the saved snapshot to its current text. Edits
      // made during this asynchronous write must retain their dirty state.
      return { ok: true, value: { title } };
    } finally { state.busy = false; }
  }
}

function validateText(text: string): void {
  if (typeof text !== "string" || text.length > TEXT_EDITOR_MAX_BYTES || Buffer.byteLength(text, "utf8") > TEXT_EDITOR_MAX_BYTES) {
    throw new EditorError("Text files must be 2 MiB or smaller");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
    throw new EditorError("Only text files can be opened; binary control bytes were detected");
  }
  if (/[\ud800-\udfff]/u.test(text)) throw new EditorError("Only valid UTF-8 text can be saved");
}

async function readBoundedFile(path: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) throw new EditorError("Select a regular text file, not a symbolic link");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new EditorError("Select a regular text file");
    if (metadata.size > TEXT_EDITOR_MAX_BYTES) throw new EditorError("Text files must be 2 MiB or smaller");
    const bytes = Buffer.alloc(TEXT_EDITOR_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > TEXT_EDITOR_MAX_BYTES) throw new EditorError("Text files must be 2 MiB or smaller");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

async function assertLocalFileUnchanged(path: string, expectedSha256: string): Promise<void> {
  let bytes: Buffer | undefined;
  try {
    bytes = await readBoundedFile(path);
    if (createHash("sha256").update(bytes).digest("hex") === expectedSha256) return;
  } catch { /* Missing or unreadable files also require an explicit choice. */ }
  finally { bytes?.fill(0); }
  throw new EditorError("This file changed outside the editor. Close and reopen it to load the latest version, or use Save As to keep your edits.");
}

async function writeAtomically(
  path: string,
  bytes: Buffer,
  assertSender: () => void,
  verifyDestination?: () => Promise<void>,
): Promise<void> {
  const temporaryPath = join(dirname(path), `.text-editor-${randomUUID()}.tmp`);
  let mode = 0o600;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) throw new EditorError("Select a regular file destination, not a symbolic link");
    mode = metadata.mode & 0o777;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  try {
    const file = await open(temporaryPath, "wx", mode);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally { await file.close(); }
    if (verifyDestination) await verifyDestination();
    assertSender();
    await rename(temporaryPath, path);
  } finally { await rm(temporaryPath, { force: true }); }
}

function displayTitle(title: string): string {
  return title.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "").slice(0, 255) || "Untitled";
}

function detectEol(text: string): EditorState["eol"] {
  const endings = new Set(text.match(/\r\n|\r|\n/gu));
  return endings.size === 1 ? [...endings][0] as EditorState["eol"] : undefined;
}

function languageForTitle(title: string): string {
  const lowerTitle = title.toLowerCase();
  if ([".bashrc", ".bash_profile", ".bash_login", ".profile"].includes(lowerTitle)) return "shell";
  const languages: Record<string, string> = {
    ".txt": "plaintext", ".log": "plaintext", ".md": "markdown", ".json": "json",
    ".xml": "xml", ".html": "html", ".htm": "html", ".css": "css",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".ts": "typescript", ".tsx": "typescript",
    ".yml": "yaml", ".yaml": "yaml", ".sh": "shell", ".bash": "shell", ".zsh": "shell",
    ".ps1": "powershell", ".psm1": "powershell", ".psd1": "powershell",
  };
  return languages[extname(title).toLowerCase()] ?? "plaintext";
}
