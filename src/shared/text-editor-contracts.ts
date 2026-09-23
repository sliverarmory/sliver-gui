import type { ApplicationSettingsState } from "./application-settings-contracts.js";
import type { OperationResult } from "./contracts.js";

export const TEXT_EDITOR_MAX_BYTES = 2 * 1024 * 1024;

export const TEXT_EDITOR_IPC = Object.freeze({
  getDocument: "sliver:text-editor:document:get",
  openFile: "sliver:text-editor:file:open",
  save: "sliver:text-editor:file:save",
  setDirty: "sliver:text-editor:dirty:set",
  getApplicationSettings: "sliver:text-editor:application-settings:get",
  applicationSettingsChanged: "sliver:application-settings:changed",
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

export interface TextEditorAPI {
  getDocument(): Promise<OperationResult<TextEditorDocument>>;
  openFile(): Promise<OperationResult<TextEditorDocument | null>>;
  save(input: TextEditorSaveInput): Promise<OperationResult<{ readonly title: string } | null>>;
  setDirty(dirty: boolean): Promise<OperationResult>;
  getApplicationSettings(): Promise<ApplicationSettingsState>;
  onApplicationSettingsChanged(listener: (state: ApplicationSettingsState) => void): () => void;
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
