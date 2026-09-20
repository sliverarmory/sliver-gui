// @vitest-environment node

import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SCRIPT_LIMITS } from "../shared/script-contracts.js";
import { ScriptStore } from "./script-store.js";
import * as secureFiles from "./secure-file.js";

const nativeDialogs = vi.hoisted(() => ({ showSaveDialog: vi.fn(), showOpenDialog: vi.fn() }));
vi.mock("electron", () => ({ dialog: nativeDialogs }));

import { exportScriptFile, importScriptFile } from "./script-file-dialogs.js";

const owner = {} as BrowserWindow;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sliver-script-files-"));
  nativeDialogs.showSaveDialog.mockReset().mockResolvedValue({ canceled: true });
  nativeDialogs.showOpenDialog.mockReset().mockResolvedValue({ canceled: true, filePaths: [] });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("native script export", () => {
  it("sanitizes a basename before presenting a parented Save As dialog, and cancellation writes nothing", async () => {
    await expect(exportScriptFile(owner, { name: "../../folder\\chosen.js", source: "console.log('unsaved');" }, () => undefined))
      .resolves.toEqual({ ok: true, value: { canceled: true } });
    expect(nativeDialogs.showSaveDialog).toHaveBeenCalledExactlyOnceWith(owner, {
      title: "Export script",
      defaultPath: "chosen.js",
      filters: [{ name: "JavaScript", extensions: ["js"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["", "\ufeffconsole.log('😀');\r\n", "x".repeat(SCRIPT_LIMITS.sourceBytes)])(
    "preserves a validated source snapshot exactly at the native-selected destination (%#)", async (source) => {
      const destination = join(root, "operator-selected.custom");
      await chmod(root, 0o755);
      await writeFile(destination, "previous bytes");
      nativeDialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
      await expect(exportScriptFile(owner, { name: "Suggested", source }, () => undefined))
        .resolves.toEqual({ ok: true, value: { canceled: false } });
      expect(await readFile(destination, "utf8")).toBe(source);
      expect(await readdir(root)).toEqual(["operator-selected.custom"]);
      if (process.platform !== "win32") {
        expect((await stat(root)).mode & 0o777).toBe(0o755);
        expect((await stat(destination)).mode & 0o777).toBe(0o600);
      }
    },
  );

  it("validates source and exact fields before opening a native dialog", async () => {
    for (const input of [
      { name: "Snapshot", source: "x".repeat(SCRIPT_LIMITS.sourceBytes + 1) },
      { name: "Snapshot", source: "\ud800" },
      { name: "Snapshot", source: "", path: join(root, "outside.js") },
      { name: "bad\nname", source: "" },
    ]) await expect(exportScriptFile(owner, input, () => undefined)).rejects.toThrow();
    expect(nativeDialogs.showSaveDialog).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("preserves existing content when authorization expires immediately before the atomic commit", async () => {
    const destination = join(root, "existing.js");
    await writeFile(destination, "existing");
    nativeDialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
    let checks = 0;
    const authorize = (): void => { if (++checks === 4) throw new Error("Window changed"); };
    await expect(exportScriptFile(owner, { name: "Snapshot", source: "changed" }, authorize))
      .resolves.toMatchObject({ ok: false });
    expect(await readFile(destination, "utf8")).toBe("existing");
    expect(await readdir(root)).toEqual(["existing.js"]);
  });

  it("refuses existing and dangling symlinks without following or replacing them", async () => {
    const target = join(root, "target.js");
    await writeFile(target, "retained");
    for (const [name, value] of [["link.js", target], ["dangling.js", join(root, "missing.js")]]) {
      const destination = join(root, name!);
      await symlink(value!, destination);
      nativeDialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
      await expect(exportScriptFile(owner, { name: "Snapshot", source: "changed" }, () => undefined))
        .resolves.toMatchObject({ ok: false });
      expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    }
    expect(await readFile(target, "utf8")).toBe("retained");
  });

  it("reports native dialog and destination failures without exposing local paths", async () => {
    nativeDialogs.showSaveDialog.mockRejectedValueOnce(new Error(`private path: ${root}`));
    const dialogFailure = await exportScriptFile(owner, { name: "Snapshot", source: "" }, () => undefined);
    expect(dialogFailure).toMatchObject({ ok: false });
    expect(JSON.stringify(dialogFailure)).not.toContain(root);
    nativeDialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: join(root, "missing-directory", "file.js") });
    await expect(exportScriptFile(owner, { name: "Snapshot", source: "" }, () => undefined)).resolves.toMatchObject({ ok: false });
    expect(await readdir(root)).toEqual([]);
  });

  it("reports an atomic writer failure and preserves the selected file", async () => {
    const destination = join(root, "retained.js");
    await writeFile(destination, "retained");
    nativeDialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
    const writer = vi.spyOn(secureFiles, "writePrivateArtifactFileAtomic")
      .mockRejectedValueOnce(new Error(`EACCES ${destination}`));
    try {
      const result = await exportScriptFile(owner, { name: "Snapshot", source: "changed" }, () => undefined);
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).not.toContain(destination);
      expect(await readFile(destination, "utf8")).toBe("retained");
    } finally { writer.mockRestore(); }
  });
});

describe("native script import", () => {
  const library = (): ScriptStore => new ScriptStore(join(root, "client", "gui", "scripts"));

  it("parents a single-file JavaScript picker and cancellation leaves the lazy library untouched", async () => {
    await expect(importScriptFile(owner, library(), () => undefined))
      .resolves.toEqual({ ok: true, value: { canceled: true } });
    expect(nativeDialogs.showOpenDialog).toHaveBeenCalledExactlyOnceWith(owner, {
      title: "Import script",
      filters: [{ name: "JavaScript", extensions: ["js"] }],
      properties: ["openFile"],
    });
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["", "\ufeffconsole.log('😀');\r\n", "x".repeat(SCRIPT_LIMITS.sourceBytes)])(
    "imports source bytes without executing them and saves only a UUID.js library filename (%#)", async (source) => {
      const selectedPath = join(root, "Imported Name.JS");
      await writeFile(selectedPath, source);
      nativeDialogs.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selectedPath] });
      const store = library();
      const result = await importScriptFile(owner, store, () => undefined);
      expect(result).toMatchObject({ ok: true, value: { canceled: false, script: { name: "Imported Name", source } } });
      if (!result.ok || result.value.canceled) throw new Error("Expected an imported script");
      expect(result.value.script.id).toMatch(/^[0-9a-f-]{36}$/u);
      const directory = join(root, "client", "gui", "scripts");
      expect(await readdir(directory)).toContain(`${result.value.script.id}.js`);
      expect(await readdir(directory)).not.toContain("Imported Name.js");
      expect((await store.read({ id: result.value.script.id })).source).toBe(source);
      expect(await readFile(selectedPath, "utf8")).toBe(source);
    },
  );

  it("rejects oversized, invalid UTF-8, non-JavaScript and multiple selections before library creation", async () => {
    const invalidUtf8 = join(root, "invalid.js");
    const oversized = join(root, "oversized.js");
    const textFile = join(root, "script.txt");
    await writeFile(invalidUtf8, Buffer.from([0xff, 0xfe]));
    await writeFile(oversized, "x".repeat(SCRIPT_LIMITS.sourceBytes + 1));
    await writeFile(textFile, "console.log('hello');");
    for (const paths of [[invalidUtf8], [oversized], [textFile], [], [invalidUtf8, oversized]]) {
      nativeDialogs.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: paths });
      await expect(importScriptFile(owner, library(), () => undefined)).resolves.toMatchObject({ ok: false });
      expect(await readdir(root)).not.toContain("client");
    }
  });

  it("rejects symlinks, dangling links and directories without modifying the library", async () => {
    const target = join(root, "target.js");
    const link = join(root, "link.js");
    const dangling = join(root, "dangling.js");
    const directory = join(root, "directory.js");
    await writeFile(target, "console.log('hello');");
    await symlink(target, link);
    await symlink(join(root, "missing.js"), dangling);
    await mkdir(directory);
    for (const path of [link, dangling, directory]) {
      nativeDialogs.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] });
      await expect(importScriptFile(owner, library(), () => undefined)).resolves.toMatchObject({ ok: false });
      expect(await readdir(root)).not.toContain("client");
    }
  });

  it("revokes a stale invoking document after its dialog closes", async () => {
    const selectedPath = join(root, "selected.js");
    await writeFile(selectedPath, "console.log('hello');");
    let current = true;
    nativeDialogs.showOpenDialog.mockImplementation(async () => {
      current = false;
      return { canceled: false, filePaths: [selectedPath] };
    });
    await expect(importScriptFile(owner, library(), () => {
      if (!current) throw new Error("Document changed");
    })).resolves.toMatchObject({ ok: false });
    expect(await readdir(root)).toEqual(["selected.js"]);
  });

  it("reports native import dialog failures without creating the library", async () => {
    nativeDialogs.showOpenDialog.mockRejectedValueOnce(new Error(`private path: ${root}`));
    const result = await importScriptFile(owner, library(), () => undefined);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(await readdir(root)).toEqual([]);
  });
});
