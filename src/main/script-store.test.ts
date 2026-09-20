// @vitest-environment node

import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HELLO_WORLD_SCRIPT_SOURCE, SCRIPT_LIMITS } from "../shared/script-contracts.js";
import * as secureFiles from "./secure-file.js";
import { ScriptStore } from "./script-store.js";

let root: string;
let directory: string;
let store: ScriptStore;
let changed = vi.fn<() => void>();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sliver-scripts-"));
  directory = join(root, "client", "gui", "scripts");
  changed = vi.fn<() => void>();
  store = new ScriptStore(directory, changed);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("main-owned script library", () => {
  it("initializes lazily with one persistent, private Hello World and never reseeds a deleted example", async () => {
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    const first = await store.list();
    expect(first.warnings).toEqual([]);
    expect(first.scripts).toHaveLength(1);
    const hello = await store.read({ id: first.scripts[0]!.id });
    expect(hello).toMatchObject({ name: "Hello World", source: HELLO_WORLD_SCRIPT_SOURCE });
    expect(hello.id).toMatch(/^[a-f0-9-]{36}$/u);
    expect(await new ScriptStore(directory).list()).toEqual(first);
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, `${hello.id}.js`))).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "names.json"))).mode & 0o777).toBe(0o600);
    }
    await store.remove({ id: hello.id, expectedRevision: hello.revision });
    expect(await new ScriptStore(directory).list()).toEqual({ scripts: [], warnings: [] });
    expect(await readdir(directory)).toEqual(["names.json"]);
  });

  it("keeps names in metadata and source paths strictly UUID-only", async () => {
    const created = await store.create({ name: "../../operator / \\ startup", source: "console.log('saved');\n" });
    expect(await readFile(join(directory, `${created.id}.js`), "utf8")).toBe(created.source);
    const manifest = JSON.parse(await readFile(join(directory, "names.json"), "utf8"));
    expect(manifest).toMatchObject({ version: 1, initialized: true, names: { [created.id]: created.name } });
    expect((await readdir(directory)).every((name) => name === "names.json" || /^[a-f0-9-]{36}\.js$/u.test(name))).toBe(true);
    expect(() => store.read({ id: "../names.json" })).toThrow(/UUID/u);
    expect(() => store.create({ name: "", source: "" })).toThrow(/name/u);
    expect(() => store.create({ name: "Bad", source: "😀".repeat(SCRIPT_LIMITS.sourceBytes / 3) })).toThrow(/512 KiB/u);
  });

  it("serializes creates and rejects stale saves, renames, and deletes without losing either window's edits", async () => {
    const created = await Promise.all(Array.from({ length: 12 }, (_, index) => store.create({ name: `Script ${index}`, source: "1" })));
    expect(new Set(created.map(({ id }) => id)).size).toBe(12);
    expect((await store.list()).scripts).toHaveLength(13);
    const current = created[0]!;
    const saves = await Promise.allSettled([
      store.save({ id: current.id, source: "first", expectedRevision: current.revision }),
      store.save({ id: current.id, source: "second", expectedRevision: current.revision }),
    ]);
    expect(saves.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
    expect((await store.read({ id: current.id })).source).toBe("first");
    await expect(store.rename({ id: current.id, name: "Stale", expectedRevision: current.revision })).rejects.toThrow(/changed/u);
    await expect(store.remove({ id: current.id, expectedRevision: current.revision })).rejects.toThrow(/changed/u);
    const saved = await store.read({ id: current.id });
    const renamed = await store.rename({ id: current.id, name: "New name", expectedRevision: saved.revision });
    expect(renamed.revision).not.toBe(saved.revision);
    expect(renamed.source).toBe("first");
    expect(changed).toHaveBeenCalledTimes(14);
  });

  it("detects external source edits before save or delete", async () => {
    const created = await store.create({ name: "External", source: "before" });
    await writeFile(join(directory, `${created.id}.js`), "outside edit", { mode: 0o600 });
    await expect(store.save({ id: created.id, source: "stale", expectedRevision: created.revision })).rejects.toThrow(/changed/u);
    await expect(store.remove({ id: created.id, expectedRevision: created.revision })).rejects.toThrow(/changed/u);
    expect((await store.read({ id: created.id })).source).toBe("outside edit");
  });

  it("recovers orphan source without auto-running or reseeding and can adopt its name", async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    await writeFile(join(directory, `${id}.js`), "console.log('recovered');", { mode: 0o600 });
    const catalog = await store.list();
    expect(catalog.scripts).toHaveLength(1);
    expect(catalog.warnings.join(" ")).toMatch(/Recovered script/u);
    const recovered = await store.read({ id });
    const renamed = await store.rename({ id, name: "Recovered work", expectedRevision: recovered.revision });
    expect(renamed.source).toBe(recovered.source);
    expect((await store.list()).warnings).toEqual([]);
  });

  it("preserves corrupt metadata, exposes recoverable source, and blocks mutations until repair", async () => {
    const created = await store.create({ name: "Keep", source: "precious draft" });
    const broken = "{incomplete names file";
    await writeFile(join(directory, "names.json"), broken, { mode: 0o600 });
    const catalog = await new ScriptStore(directory).list();
    expect(catalog.warnings[0]).toMatch(/names.json.*invalid/u);
    expect((await store.read({ id: created.id })).source).toBe("precious draft");
    await expect(store.create({ name: "Blocked", source: "" })).rejects.toThrow(/repair/u);
    await expect(store.save({ id: created.id, source: "blocked", expectedRevision: created.revision })).rejects.toThrow(/repair/u);
    expect(await readFile(join(directory, "names.json"), "utf8")).toBe(broken);
    expect(await readFile(join(directory, `${created.id}.js`), "utf8")).toBe("precious draft");
  });

  it("reports missing source and preserves its metadata entry", async () => {
    const created = await store.create({ name: "Missing", source: "before" });
    await unlink(join(directory, `${created.id}.js`));
    const catalog = await store.list();
    expect(catalog.scripts.some(({ id }) => id === created.id)).toBe(false);
    expect(catalog.warnings.join(" ")).toMatch(/source file is missing/u);
    expect(JSON.parse(await readFile(join(directory, "names.json"), "utf8")).names[created.id]).toBe("Missing");
  });

  it("retains source when a create metadata commit fails, making the orphan recoverable", async () => {
    await store.list();
    vi.spyOn(secureFiles, "writePrivateFileAtomic").mockRejectedValueOnce(new Error("Simulated metadata failure"));
    await expect(store.create({ name: "Interrupted", source: "preserve this" })).rejects.toThrow(/Simulated/u);
    const catalog = await store.list();
    const recovered = catalog.scripts.find(({ name }) => name.startsWith("Recovered"))!;
    expect((await store.read({ id: recovered.id })).source).toBe("preserve this");
    expect(catalog.warnings.join(" ")).toMatch(/Recovered/u);
  });

  it("rejects source links, nonprivate files, and swapped application directory links", async () => {
    const created = await store.create({ name: "Safe", source: "safe" });
    const outside = join(root, "outside.js");
    await writeFile(outside, "outside", { mode: 0o600 });
    await unlink(join(directory, `${created.id}.js`));
    await symlink(outside, join(directory, `${created.id}.js`));
    await expect(store.read({ id: created.id })).rejects.toThrow(/safely/u);
    await expect(store.save({ id: created.id, source: "overwrite", expectedRevision: created.revision })).rejects.toThrow(/safely/u);
    expect(await readFile(outside, "utf8")).toBe("outside");
    await rm(directory, { recursive: true });
    const linked = join(root, "linked");
    await mkdir(linked);
    await symlink(linked, directory, process.platform === "win32" ? "junction" : "dir");
    await expect(store.list()).rejects.toThrow(/directory changed/u);
    await expect(new ScriptStore(directory).list()).rejects.toThrow(/symbolic links/u);
  });

  it.skipIf(process.platform === "win32")("rejects nonprivate source permissions", async () => {
    const created = await store.create({ name: "Permissions", source: "private" });
    await chmod(join(directory, `${created.id}.js`), 0o644);
    await expect(store.read({ id: created.id })).rejects.toThrow(/safely/u);
  });

  it("revalidates a queued renderer capability before committing files", async () => {
    await store.list();
    const authorize = vi.fn(() => { throw new Error("Renderer changed"); });
    await expect(store.create({ name: "Stale renderer", source: "" }, authorize)).rejects.toThrow(/Renderer changed/u);
    expect((await store.list()).scripts).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
  });
});
