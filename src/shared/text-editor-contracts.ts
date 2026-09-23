import type { ApplicationSettingsState } from "./application-settings-contracts.js";
import type { OperationResult } from "./contracts.js";
import type { TextEditorSettingsState, TextEditorSettingsUpdateInput } from "./text-editor-settings-contracts.js";

export const TEXT_EDITOR_MAX_BYTES = 2 * 1024 * 1024;

export const TEXT_EDITOR_IPC = Object.freeze({
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

/** Display data only. Native file paths remain private to Electron main. */
export interface TextEditorDocument {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly language: string;
  readonly readOnly: boolean;
  /** Remote documents save back to the captured session and cannot use local file pickers. */
  readonly remote?: boolean;
}

export interface TextEditorSaveInput {
  readonly text: string;
  readonly saveAs: boolean;
}

/** Display-only details for one main-owned remote overwrite review. */
export interface TextEditorRemoteOverwriteRequest {
  readonly requestId: string;
  readonly path: string;
  readonly target: {
    readonly name: string;
    readonly hostname: string;
    readonly sessionId: string;
    readonly backend: {
      readonly id: string;
      readonly displayName: string;
    };
  };
  readonly originalSha256: string;
  readonly newSha256: string;
  readonly warning: string;
}

export interface TextEditorRemoteOverwriteResponse {
  readonly requestId: string;
  readonly confirmed: boolean;
}

export interface TextEditorAPI {
  getDocument(): Promise<OperationResult<TextEditorDocument>>;
  openFile(): Promise<OperationResult<TextEditorDocument | null>>;
  save(input: TextEditorSaveInput): Promise<OperationResult<{ readonly title: string } | null>>;
  setDirty(dirty: boolean): Promise<OperationResult>;
  respondToRemoteOverwrite(input: TextEditorRemoteOverwriteResponse): Promise<OperationResult>;
  onRemoteOverwriteRequested(listener: (request: TextEditorRemoteOverwriteRequest) => void): () => void;
  getApplicationSettings(): Promise<ApplicationSettingsState>;
  onApplicationSettingsChanged(listener: (state: ApplicationSettingsState) => void): () => void;
  getEditorSettings(): Promise<TextEditorSettingsState>;
  updateEditorSettings(input: TextEditorSettingsUpdateInput): Promise<OperationResult<TextEditorSettingsState>>;
  onEditorSettingsChanged(listener: (state: TextEditorSettingsState) => void): () => void;
}

export function parseTextEditorRemoteOverwriteResponse(value: unknown): TextEditorRemoteOverwriteResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid remote overwrite response");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || typeof input["requestId"] !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input["requestId"]) ||
    typeof input["confirmed"] !== "boolean") {
    throw new TypeError("Invalid remote overwrite response");
  }
  return { requestId: input["requestId"], confirmed: input["confirmed"] };
}

export function parseTextEditorSaveInput(value: unknown): TextEditorSaveInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid text editor save request");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || typeof input["text"] !== "string" ||
    typeof input["saveAs"] !== "boolean" || input["text"].length > TEXT_EDITOR_MAX_BYTES) {
    throw new TypeError("Invalid text editor save request");
  }
  return { text: input["text"], saveAs: input["saveAs"] };
}
