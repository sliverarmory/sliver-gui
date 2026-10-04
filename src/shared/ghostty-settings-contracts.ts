import type { OperationResult } from "./contracts.js";
import type { GhosttyConfigState } from "./ghostty-theme.js";

export const GHOSTTY_SETTINGS_IPC = {
  get: "sliver:ghostty-settings:get",
  reload: "sliver:ghostty-settings:reload",
  setTheme: "sliver:ghostty-settings:set-theme",
  edit: "sliver:ghostty-settings:edit",
  changed: "sliver:ghostty-settings:changed",
} as const;

export interface GhosttySettingsSnapshot extends GhosttyConfigState {
  readonly nativeTerminalTransparency: boolean;
}

/** Appearance-only bridge. No renderer-supplied filesystem paths are opened. */
export interface GhosttySettingsAPI {
  getConfig(): Promise<GhosttySettingsSnapshot>;
  reloadConfig(): Promise<GhosttySettingsSnapshot>;
  setTheme(theme: string): Promise<OperationResult<GhosttySettingsSnapshot>>;
  editConfig(): Promise<OperationResult>;
  onChanged(listener: (state: GhosttySettingsSnapshot) => void): () => void;
}
