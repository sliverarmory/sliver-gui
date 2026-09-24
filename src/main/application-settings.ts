import { dirname, isAbsolute } from "node:path";

import {
  APPLICATION_SETTINGS_VERSION,
  DEFAULT_APPLICATION_SETTINGS_STATE,
  parseApplicationSettingsState,
  parsePersistedApplicationSettingsState,
  parseApplicationSettingsUpdateInput,
  type ApplicationSettingsState,
  type ApplicationSettingsUpdateInput,
} from "../shared/application-settings-contracts.js";
import type { OperationResult } from "../shared/contracts.js";
import { readBoundedRegularFile, writePrivateFileAtomic } from "./secure-file.js";

export const APPLICATION_SETTINGS_MAX_BYTES = 64 * 1024;
export const STALE_APPLICATION_SETTINGS_ERROR =
  "Application settings changed in another window. Review the latest settings and try again.";

const INVALID_APPLICATION_SETTINGS_UPDATE_ERROR = "The application settings update is invalid.";
const APPLICATION_SETTINGS_SAVE_ERROR = "Application settings could not be saved.";

export class ApplicationSettingsStore {
  readonly filePath: string;
  #state: ApplicationSettingsState;
  #mutationChain: Promise<void> = Promise.resolve();

  private constructor(filePath: string, state: ApplicationSettingsState) {
    this.filePath = filePath;
    this.#state = state;
  }

  static async load(filePath: string): Promise<ApplicationSettingsStore> {
    assertSettingsFilePath(filePath);
    let state = DEFAULT_APPLICATION_SETTINGS_STATE;
    try {
      const loaded = await readBoundedRegularFile(filePath, {
        label: "Application settings",
        maxBytes: APPLICATION_SETTINGS_MAX_BYTES,
        requirePrivateMode: true,
      });
      try {
        state = parsePersistedApplicationSettingsState(JSON.parse(loaded.data.toString("utf8")) as unknown);
      } finally {
        loaded.data.fill(0);
      }
    } catch {
      // Settings are non-sensitive convenience state. A missing, unreadable,
      // unsupported, or corrupt file must not prevent the application from
      // launching; the next successful update replaces it atomically.
      state = DEFAULT_APPLICATION_SETTINGS_STATE;
    }
    return new ApplicationSettingsStore(filePath, state);
  }

  getState(): ApplicationSettingsState {
    return this.#state;
  }

  update(input: ApplicationSettingsUpdateInput): Promise<OperationResult<ApplicationSettingsState>> {
    return this.#serializeMutation(async () => {
      let parsed: ApplicationSettingsUpdateInput;
      try {
        parsed = parseApplicationSettingsUpdateInput(input);
      } catch {
        return { ok: false, error: INVALID_APPLICATION_SETTINGS_UPDATE_ERROR };
      }
      if (parsed.settings.reportScreenshotDirectory !== null && !isAbsolute(parsed.settings.reportScreenshotDirectory)) {
        return { ok: false, error: INVALID_APPLICATION_SETTINGS_UPDATE_ERROR };
      }

      if (parsed.expectedRevision !== this.#state.revision) {
        return { ok: false, error: STALE_APPLICATION_SETTINGS_ERROR };
      }
      if (this.#state.revision === Number.MAX_SAFE_INTEGER) {
        return { ok: false, error: APPLICATION_SETTINGS_SAVE_ERROR };
      }

      const next = parseApplicationSettingsState({
        v: APPLICATION_SETTINGS_VERSION,
        revision: this.#state.revision + 1,
        ...parsed.settings,
      });
      const data = Buffer.from(JSON.stringify(next), "utf8");
      try {
        if (data.length > APPLICATION_SETTINGS_MAX_BYTES) {
          return { ok: false, error: APPLICATION_SETTINGS_SAVE_ERROR };
        }
        await writePrivateFileAtomic(this.filePath, data);
      } catch {
        return { ok: false, error: APPLICATION_SETTINGS_SAVE_ERROR };
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
    throw new TypeError("A bounded application settings file path is required");
  }
}
