// @vitest-environment node

import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceZoomSettings } from "./workspace-zoom-settings.js";

let directory = "";
let filePath = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sliver-gui-workspace-zoom-"));
  filePath = join(directory, "gui", "workspace-zoom.json");
  await mkdir(join(directory, "gui"));
});

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("WorkspaceZoomSettings", () => {
  it("uses 100% when no GUI preference exists and persists native zoom changes privately", async () => {
    const settings = await WorkspaceZoomSettings.load(filePath);
    expect(settings.getFactor()).toBe(1);

    settings.setFactor(1.25);
    expect(settings.getFactor()).toBe(1.25);
    await settings.flush();

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ v: 1, zoomFactor: 1.25 });
    const stats = await lstat(filePath);
    expect(stats.isFile()).toBe(true);
    if (process.platform !== "win32") expect(stats.mode & 0o777).toBe(0o600);
    expect((await WorkspaceZoomSettings.load(filePath)).getFactor()).toBe(1.25);
  });

  it("keeps the latest zoom across rapid changes and reset", async () => {
    const settings = await WorkspaceZoomSettings.load(filePath);
    settings.setFactor(1.1);
    settings.setFactor(1.25);
    settings.setFactor(1);
    await settings.flush();

    expect(settings.getFactor()).toBe(1);
    expect((await WorkspaceZoomSettings.load(filePath)).getFactor()).toBe(1);
  });

  it.each([
    "not-json",
    JSON.stringify({ v: 2, zoomFactor: 1.25 }),
    JSON.stringify({ v: 1, zoomFactor: 0 }),
    JSON.stringify({ v: 1, zoomFactor: 12 }),
    JSON.stringify({ v: 1, zoomFactor: "1.25" }),
    JSON.stringify({ v: 1, zoomFactor: 1.25, unknown: true }),
  ])("falls back to 100% for malformed or unsupported settings %#", async (contents) => {
    await writeFile(filePath, contents, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(filePath, 0o600);
    expect((await WorkspaceZoomSettings.load(filePath)).getFactor()).toBe(1);
  });

  it("does not read through a symbolic link", async () => {
    const target = join(directory, "target.json");
    await writeFile(target, JSON.stringify({ v: 1, zoomFactor: 1.5 }), { mode: 0o600 });
    await symlink(target, filePath);
    expect((await WorkspaceZoomSettings.load(filePath)).getFactor()).toBe(1);
  });

  it.runIf(process.platform !== "win32")("ignores a preference file readable by other users", async () => {
    await writeFile(filePath, JSON.stringify({ v: 1, zoomFactor: 1.5 }), { mode: 0o644 });
    await chmod(filePath, 0o644);
    expect((await WorkspaceZoomSettings.load(filePath)).getFactor()).toBe(1);
  });

  it("ignores invalid live values without damaging a saved factor", async () => {
    const settings = await WorkspaceZoomSettings.load(filePath);
    settings.setFactor(0.9);
    await settings.flush();
    settings.setFactor(Number.NaN);
    settings.setFactor(Infinity);
    settings.setFactor(0.1);
    settings.setFactor(6);
    await settings.flush();
    expect(settings.getFactor()).toBe(0.9);
    expect((await WorkspaceZoomSettings.load(filePath)).getFactor()).toBe(0.9);
  });
});
