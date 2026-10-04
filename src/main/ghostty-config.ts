import { mkdir, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import type { OperationResult } from "../shared/contracts.js";
import {
  applyGhosttyAppearance,
  ghosttyThemeForMode,
  parseGhosttyConfig,
  type GhosttyConfigDiagnostic,
  type GhosttyConfigState,
  type GhosttyThemeAppearance,
  type GhosttyThemeCatalogEntry,
} from "../shared/ghostty-theme.js";
import { readBoundedRegularFile, writePrivateFileAtomic, writePrivateFileExclusiveAtomic } from "./secure-file.js";

export const GHOSTTY_CONFIG_MAX_BYTES = 256 * 1024;
const MAX_CATALOG_ENTRIES = 4096;
const MAX_DIAGNOSTICS = 100;

export const GHOSTTY_CONFIG_TEMPLATE = `# Sliver GUI terminal appearance, using Ghostty's configuration format.
# Documentation: https://ghostty.org/docs/config/reference
# Choose a discovered native Ghostty theme or an absolute theme-file path:
# theme = Catppuccin Mocha
# theme = light:Catppuccin Latte,dark:Catppuccin Mocha
# Your own theme files can be placed in the themes directory next to this file.
# Colors below override the selected theme. Empty values reset to app defaults.
# background = #1e1e2e
# foreground = #cdd6f4
# cursor-color = #f5e0dc
# cursor-text = #1e1e2e
# selection-background = #585b70
# selection-foreground = #cdd6f4
# palette = 0=#45475a
# background-opacity = 0.85
# The embedded runtime currently renders palette entries 0-15. Entries 16-255
# and unsupported Ghostty settings are preserved and reported in app settings.
# Native fonts, commands, keybindings, shaders, and config-file directives are
# not applied by this embedded terminal. Font and cursor preferences use the UI.
# To share this file with native Ghostty, add the following to its config:
# config-file = ~/.sliver-client/gui/ghostty/config
`;

export interface GhosttyConfigStoreOptions {
  /** Expected production path: ~/.sliver-client/gui/ghostty. */
  directory: string;
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Replaces native discovery, mainly for tests. The GUI themes directory is always first. */
  themeDirectories?: readonly string[];
}

export class GhosttyConfigStore {
  readonly configPath: string;
  readonly themesDirectory: string;
  readonly #themeDirectories: readonly string[];
  #state: GhosttyConfigState;
  #mutationChain: Promise<void> = Promise.resolve();

  private constructor(options: GhosttyConfigStoreOptions) {
    if (!isAbsolute(options.directory)) throw new TypeError("The Ghostty configuration directory must be absolute.");
    this.configPath = join(options.directory, "config");
    this.themesDirectory = join(options.directory, "themes");
    this.#themeDirectories = [...new Set([
      this.themesDirectory,
      ...(options.themeDirectories ?? nativeGhosttyThemeDirectories(options)),
    ].filter((directory) => isAbsolute(directory)))].slice(0, 24);
    this.#state = freezeState({
      configPath: this.configPath, themesDirectory: this.themesDirectory, theme: "", themes: [],
      light: { palette: {} }, dark: { palette: {} }, diagnostics: [], revision: 0,
    });
  }

  static async load(options: GhosttyConfigStoreOptions): Promise<GhosttyConfigStore> {
    const store = new GhosttyConfigStore(options);
    await store.reload();
    return store;
  }

  getState(): GhosttyConfigState {
    return this.#state;
  }

  /** Creates the editable config exclusively, never replacing an existing file. */
  async ensureConfig(): Promise<string> {
    await mkdir(this.themesDirectory, { recursive: true, mode: 0o700 });
    try {
      await writePrivateFileExclusiveAtomic(this.configPath, Buffer.from(GHOSTTY_CONFIG_TEMPLATE, "utf8"));
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    // Existing links and special files must not be handed to the editor.
    await readConfigFile(this.configPath);
    return this.configPath;
  }

  reload(): Promise<GhosttyConfigState> {
    return this.#serialize(() => this.#reload());
  }

  setTheme(theme: string): Promise<OperationResult<GhosttyConfigState>> {
    return this.#serialize(async () => {
      if (!validThemeSetting(theme)) return { ok: false, error: "The Ghostty theme selection is invalid." };
      try {
        await this.ensureConfig();
        const current = await readConfigFile(this.configPath);
        const newline = current.includes("\r\n") ? "\r\n" : "\n";
        const lastTheme = [...current.matchAll(/^[\t ]*theme[\t ]*=[^\r\n]*/gmu)].at(-1);
        // Change only the effective theme assignment. Retain comments, unknown
        // options and color overrides byte-for-byte (including the newline style).
        const replacement = `theme = ${theme}`;
        const updated = lastTheme
          ? current.slice(0, lastTheme.index) + replacement + current.slice(lastTheme.index + lastTheme[0].length)
          : current + (current.length > 0 && !current.endsWith("\n") ? newline : "") + replacement + newline;
        const data = Buffer.from(updated, "utf8");
        if (data.length > GHOSTTY_CONFIG_MAX_BYTES) return { ok: false, error: "The Ghostty config exceeds the size limit." };
        await writePrivateFileAtomic(this.configPath, data);
        return { ok: true, value: await this.#reload() };
      } catch {
        return { ok: false, error: "The Ghostty theme could not be saved. Check the config file and its permissions." };
      }
    });
  }

  async #reload(): Promise<GhosttyConfigState> {
    const diagnostics: GhosttyConfigDiagnostic[] = [];
    let text = "";
    try {
      text = await readConfigFile(this.configPath);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) diagnostics.push({ source: this.configPath, severity: "error", message: "The config must be a readable regular file no larger than 256 KiB." });
    }
    const parsed = parseGhosttyConfig(text, this.configPath);
    diagnostics.push(...parsed.diagnostics);
    const theme = parsed.entries.findLast((entry) => entry.key === "theme")?.value ?? "";
    const themes = await this.#catalog(diagnostics);
    const resolved = new Map<string, GhosttyThemeAppearance>();
    const appearances: Record<"light" | "dark", GhosttyThemeAppearance> = { light: { palette: {} }, dark: { palette: {} } };
    for (const mode of ["light", "dark"] as const) {
      let selected = "";
      try {
        selected = ghosttyThemeForMode(theme, mode);
        if (!validThemeName(selected)) throw new Error("A theme must be a name or an absolute file path.");
      } catch (error) {
        diagnostics.push({ source: this.configPath, severity: "error", message: error instanceof Error ? error.message : "The theme selection is invalid." });
      }
      if (selected) {
        let base = resolved.get(selected);
        if (!base) {
          base = await this.#resolveTheme(selected, diagnostics);
          resolved.set(selected, base);
        }
        appearances[mode] = base;
      }
      const applied = applyGhosttyAppearance(appearances[mode], parsed.entries, this.configPath);
      appearances[mode] = applied.appearance;
      diagnostics.push(...applied.diagnostics);
    }
    for (const entry of parsed.entries.filter((entry) => entry.key === "config-file")) {
      diagnostics.push({ source: this.configPath, line: entry.line, severity: "warning", message: "config-file is preserved for native Ghostty; the embedded terminal reads appearance from this file and its selected theme only." });
    }
    const uniqueDiagnostics = [...new Map(diagnostics.map((item) => [JSON.stringify(item), item])).values()];
    const next: GhosttyConfigState = {
      configPath: this.configPath, themesDirectory: this.themesDirectory, theme, themes,
      light: appearances.light, dark: appearances.dark,
      diagnostics: uniqueDiagnostics.slice(0, MAX_DIAGNOSTICS), revision: this.#state.revision,
    };
    if (JSON.stringify(next) !== JSON.stringify(this.#state)) {
      next.revision += 1;
      this.#state = freezeState(next);
    }
    return this.#state;
  }

  async #resolveTheme(name: string, diagnostics: GhosttyConfigDiagnostic[]): Promise<GhosttyThemeAppearance> {
    const candidates = isAbsolute(name) ? [name] : this.#themeDirectories.map((directory) => join(directory, name));
    for (const path of candidates) {
      let text: string;
      try {
        text = await readConfigFile(path);
      } catch (error) {
        if (hasCode(error, "ENOENT")) continue;
        diagnostics.push({ source: path, severity: "error", message: "The theme must be a readable regular file no larger than 256 KiB." });
        return { palette: {} };
      }
      const parsed = parseGhosttyConfig(text, path);
      const applied = applyGhosttyAppearance({ palette: {} }, parsed.entries, path);
      diagnostics.push(...parsed.diagnostics, ...applied.diagnostics);
      for (const entry of parsed.entries.filter((entry) => entry.key === "theme" || entry.key === "config-file")) {
        diagnostics.push({ source: path, line: entry.line, severity: "warning", message: `${entry.key} is ignored inside theme files, as in native Ghostty.` });
      }
      return applied.appearance;
    }
    diagnostics.push({ source: this.configPath, severity: "error", message: `Theme “${name}” was not found. Install it in the GUI themes directory or use an absolute theme-file path.` });
    return { palette: {} };
  }

  async #catalog(diagnostics: GhosttyConfigDiagnostic[]): Promise<GhosttyThemeCatalogEntry[]> {
    const found = new Map<string, GhosttyThemeCatalogEntry>();
    let scanned = 0;
    for (const directory of this.#themeDirectories) {
      try {
        const handle = await opendir(directory);
        for await (const entry of handle) {
          scanned += 1;
          if (scanned > MAX_CATALOG_ENTRIES) {
            diagnostics.push({ source: directory, severity: "warning", message: "The theme catalog reached its 4096-entry limit." });
            return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
          }
          if (entry.isFile() && !entry.name.startsWith(".") && validThemeName(entry.name) && !found.has(entry.name)) {
            found.set(entry.name, { name: entry.name, path: join(directory, entry.name) });
          }
        }
      } catch (error) {
        if (!hasCode(error, "ENOENT")) diagnostics.push({ source: directory, severity: "warning", message: "This theme directory could not be read." });
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationChain.then(operation);
    this.#mutationChain = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function nativeGhosttyThemeDirectories(options: GhosttyConfigStoreOptions): string[] {
  const home = options.homeDirectory ?? homedir();
  const env = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const xdg = env["XDG_CONFIG_HOME"];
  const directories = [join(xdg && isAbsolute(xdg) ? xdg : join(home, ".config"), "ghostty", "themes")];
  if (platform === "darwin") directories.push(
    join(home, "Library", "Application Support", "com.mitchellh.ghostty", "themes"),
    join(home, "Applications", "Ghostty.app", "Contents", "Resources", "ghostty", "themes"),
    "/Applications/Ghostty.app/Contents/Resources/ghostty/themes",
  );
  const resources = env["GHOSTTY_RESOURCES_DIR"];
  if (resources && isAbsolute(resources)) directories.push(join(resources, "themes"));
  for (const directory of (env["XDG_DATA_DIRS"] ?? "/usr/local/share:/usr/share").split(delimiter).slice(0, 8)) {
    if (isAbsolute(directory)) directories.push(join(directory, "ghostty", "themes"));
  }
  if (platform === "darwin") directories.push("/opt/homebrew/share/ghostty/themes");
  return [...new Set(directories.map((directory) => resolve(directory)))];
}

async function readConfigFile(path: string): Promise<string> {
  const file = await readBoundedRegularFile(path, { label: "Ghostty config", maxBytes: GHOSTTY_CONFIG_MAX_BYTES });
  try { return new TextDecoder("utf-8", { fatal: true }).decode(file.data); }
  finally { file.data.fill(0); }
}

function validThemeSetting(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f"]/u.test(value) || value.trim() !== value) return false;
  try { return validThemeName(ghosttyThemeForMode(value, "light")) && validThemeName(ghosttyThemeForMode(value, "dark")); }
  catch { return false; }
}

function validThemeName(value: string): boolean {
  return !/[\u0000-\u001f\u007f"]/u.test(value) && (isAbsolute(value) || (!value.includes("/") && !value.includes("\\") && value !== "." && value !== ".."));
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

function freezeState(state: GhosttyConfigState): GhosttyConfigState {
  for (const appearance of [state.light, state.dark]) {
    Object.freeze(appearance.palette);
    Object.freeze(appearance);
  }
  state.themes.forEach(Object.freeze);
  state.diagnostics.forEach(Object.freeze);
  Object.freeze(state.themes);
  Object.freeze(state.diagnostics);
  return Object.freeze(state);
}
