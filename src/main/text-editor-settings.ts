import { dirname } from "node:path";

import type { OperationResult } from "../shared/contracts.js";
import {
  DEFAULT_TEXT_EDITOR_SETTINGS_STATE,
  parsePersistedTextEditorSettingsState,
  parseTextEditorSettingsState,
  parseTextEditorSettingsUpdateInput,
  TEXT_EDITOR_SETTINGS_VERSION,
  type TextEditorSettingsState,
  type TextEditorSettingsUpdateInput,
} from "../shared/text-editor-settings-contracts.js";
import { readBoundedRegularFile, writePrivateFileAtomic } from "./secure-file.js";

export const TEXT_EDITOR_SETTINGS_MAX_BYTES = 16 * 1024;
export const STALE_TEXT_EDITOR_SETTINGS_ERROR =
  "Text editor settings changed in another window. Review the latest settings and try again.";

const INVALID_TEXT_EDITOR_SETTINGS_UPDATE_ERROR = "The text editor settings update is invalid.";
const TEXT_EDITOR_SETTINGS_SAVE_ERROR = "Text editor settings could not be saved.";

/** Persists standalone editor preferences without granting renderer filesystem access. */
export class TextEditorSettingsStore {
  readonly filePath: string;
  #state: TextEditorSettingsState;
  #mutationChain: Promise<void> = Promise.resolve();

  private constructor(filePath: string, state: TextEditorSettingsState) {
    this.filePath = filePath;
    this.#state = state;
  }

  static async load(filePath: string): Promise<TextEditorSettingsStore> {
    assertSettingsFilePath(filePath);
    let state = DEFAULT_TEXT_EDITOR_SETTINGS_STATE;
    try {
      const loaded = await readBoundedRegularFile(filePath, {
        label: "Text editor settings",
        maxBytes: TEXT_EDITOR_SETTINGS_MAX_BYTES,
        requirePrivateMode: true,
      });
      try {
        state = parsePersistedTextEditorSettingsState(JSON.parse(loaded.data.toString("utf8")) as unknown);
      } finally {
        loaded.data.fill(0);
      }
    } catch {
      // These preferences hold no document content or authority. Missing,
      // unsupported, or corrupt state falls back until the next valid update.
      state = DEFAULT_TEXT_EDITOR_SETTINGS_STATE;
    }
    return new TextEditorSettingsStore(filePath, state);
  }

  getState(): TextEditorSettingsState {
    return this.#state;
  }

  update(input: TextEditorSettingsUpdateInput): Promise<OperationResult<TextEditorSettingsState>> {
    return this.#serializeMutation(async () => {
      let parsed: TextEditorSettingsUpdateInput;
      try {
        parsed = parseTextEditorSettingsUpdateInput(input);
      } catch {
        return { ok: false, error: INVALID_TEXT_EDITOR_SETTINGS_UPDATE_ERROR };
      }

      if (parsed.expectedRevision !== this.#state.revision) {
        return { ok: false, error: STALE_TEXT_EDITOR_SETTINGS_ERROR };
      }
      if (this.#state.revision === Number.MAX_SAFE_INTEGER) {
        return { ok: false, error: TEXT_EDITOR_SETTINGS_SAVE_ERROR };
      }

      const next = parseTextEditorSettingsState({
        v: TEXT_EDITOR_SETTINGS_VERSION,
        revision: this.#state.revision + 1,
        ...parsed.settings,
      });
      const data = Buffer.from(JSON.stringify(next), "utf8");
      try {
        if (data.length > TEXT_EDITOR_SETTINGS_MAX_BYTES) {
          return { ok: false, error: TEXT_EDITOR_SETTINGS_SAVE_ERROR };
        }
        await writePrivateFileAtomic(this.filePath, data);
      } catch {
        return { ok: false, error: TEXT_EDITOR_SETTINGS_SAVE_ERROR };
      } finally {
        data.fill(0);
      }

      this.#state = next;
      return { ok: true, value: next };
    });
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationChain.then(operation);
    this.#mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function assertSettingsFilePath(filePath: string): void {
  if (typeof filePath !== "string" || filePath.trim() === "" || dirname(filePath) === filePath) {
    throw new TypeError("A bounded text editor settings file path is required");
  }
}
