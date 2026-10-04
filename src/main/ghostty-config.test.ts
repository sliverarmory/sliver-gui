// @vitest-environment node

import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GHOSTTY_CONFIG_MAX_BYTES, GhosttyConfigStore, nativeGhosttyThemeDirectories } from "./ghostty-config.js";

let directory = "";

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "sliver-gui-ghostty-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("GhosttyConfigStore", () => {
  it("loads defaults without writing, then creates a private editable config once", async () => {
    const store = await GhosttyConfigStore.load({ directory, themeDirectories: [] });
    expect(store.getState()).toMatchObject({ theme: "", light: { palette: {} }, dark: { palette: {} }, diagnostics: [], revision: 0 });
    await expect(lstat(store.configPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.ensureConfig()).toBe(join(directory, "config"));
    const content = await readFile(store.configPath, "utf8");
    expect(content).toContain("config-file = ~/.sliver-client/gui/ghostty/config");
    await store.ensureConfig();
    expect(await readFile(store.configPath, "utf8")).toBe(content);
    if (process.platform !== "win32") expect((await lstat(store.configPath)).mode & 0o777).toBe(0o600);
  });

  it("discovers native themes while preferring app themes and resolving both app modes", async () => {
    const native = join(directory, "native");
    const own = join(directory, "themes");
    await mkdir(native);
    await mkdir(own);
    await writeFile(join(native, "Ocean"), "background=#000001\nforeground=#ffffff\npalette=1=#ff0000");
    await writeFile(join(own, "Ocean"), "background=#000002\nforeground=#eeeeee\npalette=1=#cc0000");
    await writeFile(join(native, "Paper"), "background=#ffffff\nforeground=#000000");
    await writeFile(join(directory, "config"), "foreground=#123456\ntheme=light:Paper,dark:Ocean\npalette=1=#654321");
    const store = await GhosttyConfigStore.load({ directory, themeDirectories: [native] });
    expect(store.getState().themes).toEqual([{ name: "Ocean", path: join(own, "Ocean") }, { name: "Paper", path: join(native, "Paper") }]);
    expect(store.getState().light).toEqual({ background: "#ffffff", foreground: "#123456", palette: { 1: "#654321" } });
    expect(store.getState().dark).toEqual({ background: "#000002", foreground: "#123456", palette: { 1: "#654321" } });
    expect(store.getState().diagnostics).toEqual([]);
  });

  it("reloads changed absolute theme files without changing revision for unchanged state", async () => {
    const theme = join(directory, "Shared theme");
    await writeFile(theme, "background=#000000");
    await writeFile(join(directory, "config"), `theme=${theme}`);
    const store = await GhosttyConfigStore.load({ directory, themeDirectories: [] });
    const first = store.getState();
    expect(await store.reload()).toBe(first);
    await writeFile(theme, "background=#ffffff");
    const next = await store.reload();
    expect(next.revision).toBe(first.revision + 1);
    expect(next.dark.background).toBe("#ffffff");
    expect(Object.isFrozen(next.dark.palette)).toBe(true);
    expect(Object.isFrozen(next.diagnostics)).toBe(true);
  });

  it("changes only the final theme assignment and preserves custom settings and all other bytes", async () => {
    const original = '# comment\r\ntheme = Old\r\nforeground=#010203\n  theme = Earlier\r\nkeybind=ctrl+x=quit';
    await writeFile(join(directory, "config"), original);
    const store = await GhosttyConfigStore.load({ directory, themeDirectories: [] });
    const result = await store.setTheme("");
    expect(result.ok).toBe(true);
    expect(await readFile(store.configPath, "utf8")).toBe(original.replace("  theme = Earlier", "theme = "));
    expect(store.getState().theme).toBe("");
    expect(store.getState().dark.foreground).toBe("#010203");
    expect(store.getState().diagnostics).toEqual([expect.objectContaining({ message: expect.stringContaining("keybind") })]);
  });

  it("does not read config-file directives or chained themes and clearly reports unsupported options", async () => {
    const external = join(directory, "external");
    await writeFile(external, "foreground=#ff0000");
    await mkdir(join(directory, "themes"));
    await writeFile(join(directory, "themes", "Ocean"), `background=#000000\nconfig-file=${external}\ntheme=Other\ncustom-shader=/tmp/anything.glsl`);
    await writeFile(join(directory, "config"), `theme=Ocean\nconfig-file=${external}\npalette=255=#112233`);
    const store = await GhosttyConfigStore.load({ directory, themeDirectories: [] });
    expect(store.getState().dark).toEqual({ background: "#000000", palette: { 255: "#112233" } });
    expect(store.getState().diagnostics).toHaveLength(5);
    expect(store.getState().diagnostics.every((item) => item.severity === "warning")).toBe(true);
  });

  it("handles missing, oversized, and invalid UTF-8 themes without preventing startup", async () => {
    const theme = join(directory, "theme");
    await writeFile(join(directory, "config"), `theme=${theme}`);
    const store = await GhosttyConfigStore.load({ directory, themeDirectories: [] });
    expect(store.getState().diagnostics).toEqual([expect.objectContaining({ severity: "error", message: expect.stringContaining("not found") })]);
    await writeFile(theme, Buffer.alloc(GHOSTTY_CONFIG_MAX_BYTES + 1));
    expect((await store.reload()).diagnostics).toEqual([expect.objectContaining({ severity: "error", source: theme })]);
    await writeFile(theme, Buffer.from([0xff]));
    expect((await store.reload()).diagnostics).toEqual([expect.objectContaining({ severity: "error", source: theme })]);
  });

  it.runIf(process.platform !== "win32")("rejects theme and config symlinks without replacing their targets", async () => {
    const outside = join(directory, "outside");
    await writeFile(outside, "foreground=#abcdef");
    const theme = join(directory, "linked-theme");
    await symlink(outside, theme);
    await writeFile(join(directory, "config"), `theme=${theme}`);
    const store = await GhosttyConfigStore.load({ directory, themeDirectories: [] });
    expect(store.getState().diagnostics[0]?.severity).toBe("error");
    await rm(store.configPath);
    await symlink(outside, store.configPath);
    expect((await store.setTheme("Ocean")).ok).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("foreground=#abcdef");
    expect((await lstat(store.configPath)).isSymbolicLink()).toBe(true);
  });

  it("rejects theme traversal, malformed mode pairs and injected configuration lines", async () => {
    const store = await GhosttyConfigStore.load({ directory, themeDirectories: [] });
    for (const theme of ["../outside", "folder/theme", "dark:Ocean", "Ocean\ncommand=anything", ".."]) {
      expect((await store.setTheme(theme)).ok).toBe(false);
    }
    await expect(lstat(store.configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("native Ghostty discovery", () => {
  it("includes XDG, macOS user and bundled resources without reading native config", () => {
    const home = join(directory, "home");
    const custom = join(directory, "custom");
    const directories = nativeGhosttyThemeDirectories({ directory, homeDirectory: home, platform: "darwin", environment: {
      XDG_CONFIG_HOME: join(custom, "config"), GHOSTTY_RESOURCES_DIR: join(custom, "resources"), XDG_DATA_DIRS: join(custom, "data"),
    } });
    expect(directories).toEqual(expect.arrayContaining([
      join(custom, "config", "ghostty", "themes"), join(custom, "resources", "themes"), join(custom, "data", "ghostty", "themes"),
      join(home, "Library", "Application Support", "com.mitchellh.ghostty", "themes"),
      resolve("/Applications/Ghostty.app/Contents/Resources/ghostty/themes"),
    ]));
  });
});
