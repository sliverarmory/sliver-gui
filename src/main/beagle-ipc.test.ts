// @vitest-environment node
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BEAGLE_IPC_INVOKE } from "../shared/beagle-contracts.js";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";
import { registerBeagleIpcHandlers, unregisterBeagleIpcHandlers, type BeagleIpcServices, type BeagleIpcManager } from "./beagle-ipc.js";
import { emptyBeagleWorkspace } from "../shared/beagle-workspace.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  fromWebContents: vi.fn(), open: vi.fn(), save: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  dialog: { showOpenDialog: mocks.open, showSaveDialog: mocks.save },
  ipcMain: { handle: (name: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => mocks.handlers.set(name, handler),
    removeHandler: (name: string) => mocks.handlers.delete(name) },
}));
const url = "sliver://app/index.html?surface=beagle";
const window = { isDestroyed: () => false } as BrowserWindow;
function event(): IpcMainInvokeEvent {
  const frame = { processId: 123, frameToken: "beagle-main", url, isDestroyed: () => false };
  return { sender: { id: 12, mainFrame: frame, getURL: () => url, isDestroyed: () => false }, senderFrame: frame } as unknown as IpcMainInvokeEvent;
}
function services(): BeagleIpcServices & { manager: BeagleIpcManager } {
  const manager = Object.fromEntries([
    "getState", "createProject", "selectProject", "configureBinary", "importFiles", "analyze", "query", "getQueries",
    "runSavedQuery", "search", "entity", "neighborhood", "paths", "tag", "compose", "exportGraphToFile",
    "renameProject", "archiveProject", "restoreArchivedProject", "cleanup", "setRetention", "backupProject", "restoreProject",
    "getWorkspace", "saveWorkspace", "importQueries", "exportQueries", "exportResult", "relayTargets", "aclOrigins", "getRules", "previewRules", "applyRules", "getOperation", "cancelOperation",
  ].map((name) => [name, vi.fn().mockResolvedValue({ marker: name })])) as unknown as BeagleIpcManager;
  return { manager, getManager: () => manager, getApplicationSettings: () => DEFAULT_APPLICATION_SETTINGS_STATE };
}
function invoke(channel: string, fixture: IpcMainInvokeEvent, ...args: unknown[]): unknown {
  return mocks.handlers.get(channel)!(fixture, ...args);
}
beforeEach(() => { vi.resetAllMocks(); mocks.handlers.clear(); mocks.fromWebContents.mockReturnValue(window); });
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("Beagle IPC", () => {
  it("binds requests and dialog locks to each trusted window independently", async () => {
    const first = services();
    const second = services();
    const otherWindow = { isDestroyed: () => false } as BrowserWindow;
    const firstEvent = event();
    const secondEvent = event();
    mocks.fromWebContents.mockImplementation((contents) => contents === secondEvent.sender ? otherWindow : window);
    registerBeagleIpcHandlers({
      getManager: (candidate) => candidate === window ? first.manager : candidate === otherWindow ? second.manager : undefined,
      getApplicationSettings: () => DEFAULT_APPLICATION_SETTINGS_STATE,
    }, url, () => true);
    let finish!: (value: unknown) => void;
    mocks.open.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = invoke(BEAGLE_IPC_INVOKE.importFiles, firstEvent);
    const id = "11111111-1111-4111-8111-111111111111";
    await expect(invoke(BEAGLE_IPC_INVOKE.selectProject, firstEvent, { id })).resolves.toMatchObject({ ok: false });
    await expect(invoke(BEAGLE_IPC_INVOKE.selectProject, secondEvent, { id })).resolves.toMatchObject({ ok: true });
    await expect(invoke(BEAGLE_IPC_INVOKE.query, secondEvent, { cypher: "RETURN 1" })).resolves.toMatchObject({ ok: true });
    expect(second.manager.selectProject).toHaveBeenCalledExactlyOnceWith({ id });
    expect(second.manager.query).toHaveBeenCalledExactlyOnceWith({ cypher: "RETURN 1" });
    expect(first.manager.selectProject).not.toHaveBeenCalled();
    expect(first.manager.query).not.toHaveBeenCalled();
    finish({ canceled: false, filePaths: ["/tmp/first.zip"] });
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(first.manager.importFiles).toHaveBeenCalledExactlyOnceWith(["/tmp/first.zip"]);
    expect(second.manager.importFiles).not.toHaveBeenCalled();
  });

  it("rejects a window without a workspace before accessing request fields", async () => {
    const service = services();
    registerBeagleIpcHandlers({ ...service, getManager: () => undefined }, url, () => true);
    const getter = vi.fn();
    await expect(invoke(BEAGLE_IPC_INVOKE.query, event(), Object.defineProperty({}, "cypher", { get: getter, enumerable: true })))
      .resolves.toMatchObject({ ok: false, error: "AD Explorer workspace is unavailable" });
    expect(getter).not.toHaveBeenCalled();
    expect(service.manager.query).not.toHaveBeenCalled();
  });

  it("registers only its typed capability surface and removes every handler", () => {
    registerBeagleIpcHandlers(services(), url, () => true);
    expect([...mocks.handlers.keys()].sort()).toEqual(Object.values(BEAGLE_IPC_INVOKE).sort());
    unregisterBeagleIpcHandlers();
    expect(mocks.handlers.size).toBe(0);
  });
  it("checks window and exact main-frame document before parsing inputs", async () => {
    const manager = services();
    const authorize = vi.fn().mockReturnValue(false);
    registerBeagleIpcHandlers(manager, url, authorize);
    const getter = vi.fn();
    const input = Object.defineProperty({}, "cypher", { get: getter, enumerable: true });
    await expect(invoke(BEAGLE_IPC_INVOKE.query, event(), input)).resolves.toMatchObject({ ok: false });
    expect(getter).not.toHaveBeenCalled();
    authorize.mockReturnValue(true);
    for (const alteration of [
      (fixture: IpcMainInvokeEvent) => ({ ...fixture, senderFrame: { ...fixture.senderFrame, frameToken: "subframe" } }),
      (fixture: IpcMainInvokeEvent) => ({ ...fixture, senderFrame: { ...fixture.senderFrame, url: `${url}&untrusted=true` } }),
      (fixture: IpcMainInvokeEvent) => ({ ...fixture, sender: { ...fixture.sender, getURL: () => "sliver://app/index.html" } }),
    ]) {
      await expect(invoke(BEAGLE_IPC_INVOKE.query, alteration(event()) as IpcMainInvokeEvent, { cypher: "RETURN 1" }))
        .resolves.toMatchObject({ ok: false });
    }
    expect(manager.manager.query).not.toHaveBeenCalled();
  });
  it("rejects malformed requests and forwards parameterized queries without reinterpretation", async () => {
    const service = services();
    registerBeagleIpcHandlers(service, url, () => true);
    await expect(invoke(BEAGLE_IPC_INVOKE.query, event(), { cypher: "RETURN 1", path: "/tmp/other.db" })).resolves.toMatchObject({ ok: false });
    await expect(invoke(BEAGLE_IPC_INVOKE.importFiles, event(), ["/tmp/unapproved.zip"])).resolves.toMatchObject({ ok: false });
    const input = { cypher: "MATCH (n) WHERE n.name = $name RETURN n", parameters: { name: "$(touch /tmp/injection)" } };
    await expect(invoke(BEAGLE_IPC_INVOKE.query, event(), input)).resolves.toMatchObject({ ok: true });
    expect(service.manager.query).toHaveBeenCalledExactlyOnceWith(input);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("holds project selection during native dialogs and rechecks trust before importing", async () => {
    const service = services();
    const authorize = vi.fn().mockReturnValue(true);
    registerBeagleIpcHandlers(service, url, authorize);
    let finish!: (value: unknown) => void;
    mocks.open.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = invoke(BEAGLE_IPC_INVOKE.importFiles, event());
    await expect(invoke(BEAGLE_IPC_INVOKE.createProject, event(), { name: "Other" })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("in progress") });
    authorize.mockReturnValue(false);
    finish({ canceled: false, filePaths: ["/tmp/collection.zip"] });
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(service.manager.importFiles).not.toHaveBeenCalled();
    authorize.mockReturnValue(true);
    await expect(invoke(BEAGLE_IPC_INVOKE.createProject, event(), { name: "Other" })).resolves.toMatchObject({ ok: true });
  });
  it("forwards validated search offsets and rejects renderer-selected page sizes", async () => {
    const service = services();
    registerBeagleIpcHandlers(service, url, () => true);
    const input = { term: "ALICE", offset: 100 };
    await expect(invoke(BEAGLE_IPC_INVOKE.search, event(), input)).resolves.toMatchObject({ ok: true });
    expect(service.manager.search).toHaveBeenCalledExactlyOnceWith(input);
    for (const invalid of [{ term: "ALICE", offset: -1 }, { term: "ALICE", limit: 10_000 }]) {
      await expect(invoke(BEAGLE_IPC_INVOKE.search, event(), invalid)).resolves.toMatchObject({ ok: false });
    }
    expect(service.manager.search).toHaveBeenCalledTimes(1);
  });
  it("authorizes neighborhood pages and validates actual traversal filters", async () => {
    const service = services();
    registerBeagleIpcHandlers(service, url, () => true);
    const input = { objectid: "G", view: "group-members", offset: 250 };
    await expect(invoke(BEAGLE_IPC_INVOKE.neighborhood, event(), input)).resolves.toMatchObject({ ok: true });
    expect(service.manager.neighborhood).toHaveBeenCalledExactlyOnceWith(input);
    await expect(invoke(BEAGLE_IPC_INVOKE.neighborhood, event(), { ...input, limit: 9000 })).resolves.toMatchObject({ ok: false });
    const path = { source: "U", via: ["G"], target: "C", relationshipKinds: ["MemberOf", "AdminTo"] };
    await expect(invoke(BEAGLE_IPC_INVOKE.paths, event(), path)).resolves.toMatchObject({ ok: true });
    expect(service.manager.paths).toHaveBeenCalledExactlyOnceWith(path);
    await expect(invoke(BEAGLE_IPC_INVOKE.paths, event(), { ...path, relationshipKinds: ["NotAnAttackPathKind"] })).resolves.toMatchObject({ ok: false });
  });
  it("handles import cancellation without writing and never accepts renderer file paths", async () => {
    const service = services();
    registerBeagleIpcHandlers(service, url, () => true);
    mocks.open.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(invoke(BEAGLE_IPC_INVOKE.importFiles, event())).resolves.toMatchObject({ ok: true, value: { report: null } });
    expect(service.manager.importFiles).not.toHaveBeenCalled();
    mocks.open.mockResolvedValue({ canceled: false, filePaths: ["/tmp/approved.zip"] });
    await expect(invoke(BEAGLE_IPC_INVOKE.importFiles, event())).resolves.toMatchObject({ ok: true });
    expect(service.manager.importFiles).toHaveBeenCalledExactlyOnceWith(["/tmp/approved.zip"]);
  });
  it("allows autosaves during a native dialog without releasing its project mutation lock", async () => {
    const service = services();
    registerBeagleIpcHandlers(service, url, () => true);
    let finish!: (value: unknown) => void;
    mocks.open.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = invoke(BEAGLE_IPC_INVOKE.importFiles, event(), { mode: "replace" });
    const id = "11111111-1111-4111-8111-111111111111";
    await expect(invoke(BEAGLE_IPC_INVOKE.getOperation, event())).resolves.toMatchObject({ ok: true });
    await expect(invoke(BEAGLE_IPC_INVOKE.cancelOperation, event(), { id })).resolves.toMatchObject({ ok: true });
    expect(service.manager.cancelOperation).toHaveBeenCalledWith({ id });
    const input = { projectId: id, workspace: emptyBeagleWorkspace(id) };
    await expect(invoke(BEAGLE_IPC_INVOKE.saveWorkspace, event(), input)).resolves.toMatchObject({ ok: true });
    expect(service.manager.saveWorkspace).toHaveBeenCalledExactlyOnceWith(input);
    await expect(invoke(BEAGLE_IPC_INVOKE.selectProject, event(), { id })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("in progress") });
    expect(service.manager.selectProject).not.toHaveBeenCalled();
    finish({ canceled: false, filePaths: ["/tmp/approved.zip"] });
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(service.manager.importFiles).toHaveBeenCalledWith(["/tmp/approved.zip"], { mode: "replace" });
  });
  it("accepts overlapping autosaves without blocking foreground operations", async () => {
    const service = services();
    registerBeagleIpcHandlers(service, url, () => true);
    const id = "11111111-1111-4111-8111-111111111111";
    const first = emptyBeagleWorkspace(id);
    const latest = { ...first, legacyMigrated: true };
    let finish!: (value: typeof first) => void;
    vi.mocked(service.manager.saveWorkspace).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce(latest);
    const pending = invoke(BEAGLE_IPC_INVOKE.saveWorkspace, event(), { projectId: id, workspace: first });
    await expect(invoke(BEAGLE_IPC_INVOKE.saveWorkspace, event(), { projectId: id, workspace: latest })).resolves.toEqual({ ok: true, value: latest });
    await expect(invoke(BEAGLE_IPC_INVOKE.analyze, event())).resolves.toMatchObject({ ok: true });
    expect(service.manager.saveWorkspace).toHaveBeenCalledTimes(2);
    finish(first);
    await expect(pending).resolves.toEqual({ ok: true, value: first });
  });
  it("passes autosaves to the service queue during analysis and keeps mutations exclusive", async () => {
    const service = services();
    registerBeagleIpcHandlers(service, url, () => true);
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    vi.mocked(service.manager.analyze).mockImplementation(async () => {
      await completed;
      return { state: await service.manager.getState(), report: {} };
    });
    const pending = invoke(BEAGLE_IPC_INVOKE.analyze, event());
    const id = "11111111-1111-4111-8111-111111111111";
    await expect(invoke(BEAGLE_IPC_INVOKE.saveWorkspace, event(), { projectId: id, workspace: emptyBeagleWorkspace(id) })).resolves.toMatchObject({ ok: true });
    await expect(invoke(BEAGLE_IPC_INVOKE.createProject, event(), { name: "Other" })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("in progress") });
    finish();
    await expect(pending).resolves.toMatchObject({ ok: true });
  });
  it("still authorizes and validates nonexclusive workspace saves", async () => {
    const service = services();
    const authorize = vi.fn().mockReturnValue(false);
    registerBeagleIpcHandlers(service, url, authorize);
    const id = "11111111-1111-4111-8111-111111111111";
    const input = { projectId: id, workspace: emptyBeagleWorkspace(id) };
    await expect(invoke(BEAGLE_IPC_INVOKE.saveWorkspace, event(), input)).resolves.toMatchObject({ ok: false, error: "Untrusted AD Explorer renderer" });
    authorize.mockReturnValue(true);
    await expect(invoke(BEAGLE_IPC_INVOKE.saveWorkspace, event(), { ...input, path: "/tmp/other.json" })).resolves.toMatchObject({ ok: false });
    await expect(invoke(BEAGLE_IPC_INVOKE.saveWorkspace, event(), { ...input, projectId: "22222222-2222-4222-8222-222222222222" })).resolves.toMatchObject({ ok: false });
    expect(service.manager.saveWorkspace).not.toHaveBeenCalled();
  });
  it("publishes streamed exports from private sibling files only after a trust recheck", async () => {
    const directory = await mkdtemp(join(tmpdir(), "beagle-ipc-export-")); directories.push(directory);
    const destination = join(directory, "graph.json");
    await writeFile(destination, "original");
    const service = services(); const authorize = vi.fn().mockReturnValue(true);
    registerBeagleIpcHandlers(service, url, authorize);
    mocks.save.mockResolvedValue({ canceled: false, filePath: destination });
    vi.mocked(service.manager.exportGraphToFile).mockImplementation(async (path) => {
      expect(path).not.toBe(destination); expect(path).toMatch(/\.tmp\.json$/u);
      await writeFile(path, "complete graph", { flag: "wx", mode: 0o600 });
      authorize.mockReturnValue(false);
    });
    await expect(invoke(BEAGLE_IPC_INVOKE.exportGraph, event())).resolves.toMatchObject({ ok: false });
    expect(await readFile(destination, "utf8")).toBe("original");
    expect(await readdir(directory)).toEqual(["graph.json"]);
    authorize.mockReturnValue(true);
    vi.mocked(service.manager.exportGraphToFile).mockImplementation(async (path) => { await writeFile(path, "complete graph", { flag: "wx", mode: 0o600 }); });
    await expect(invoke(BEAGLE_IPC_INVOKE.exportGraph, event())).resolves.toEqual({ ok: true, value: { cancelled: false } });
    expect(await readFile(destination, "utf8")).toBe("complete graph");
    expect(await readdir(directory)).toEqual(["graph.json"]);
  });
  it("uses main-selected backup and query files and wraps canceled imports", async () => {
    const service = services();
    registerBeagleIpcHandlers(service, url, () => true);
    mocks.open.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(invoke(BEAGLE_IPC_INVOKE.importQueries, event())).resolves.toEqual({ ok: true, value: { cancelled: true, queries: [] } });
    await expect(invoke(BEAGLE_IPC_INVOKE.restoreProject, event(), { path: "/tmp/injected.beagle" })).resolves.toMatchObject({ ok: false });
    mocks.open.mockResolvedValue({ canceled: false, filePaths: ["/tmp/approved.beagle"] });
    await expect(invoke(BEAGLE_IPC_INVOKE.restoreProject, event())).resolves.toMatchObject({ ok: true });
    expect(service.manager.restoreProject).toHaveBeenCalledWith("/tmp/approved.beagle");
    vi.mocked(service.manager.importQueries).mockResolvedValue([]);
    mocks.open.mockResolvedValue({ canceled: false, filePaths: ["/tmp/approved.zip"] });
    await expect(invoke(BEAGLE_IPC_INVOKE.importQueries, event())).resolves.toEqual({ ok: true, value: { cancelled: false, queries: [] } });
    expect(service.manager.importQueries).toHaveBeenCalledWith("/tmp/approved.zip");
  });
  it("validates rules and edge identities before forwarding new capabilities", async () => {
    const service = services();
    registerBeagleIpcHandlers(service, url, () => true);
    const configuration = { groups: [{ label: "Tag_Owned", seeds: [], expansion: "none", exclusions: [], tier: false, enabled: true, priority: 0 }] };
    await expect(invoke(BEAGLE_IPC_INVOKE.previewRules, event(), { configuration })).resolves.toMatchObject({ ok: true });
    expect(service.manager.previewRules).toHaveBeenCalledExactlyOnceWith({ configuration });
    await expect(invoke(BEAGLE_IPC_INVOKE.applyRules, event(), { configuration, path: "injected" })).resolves.toMatchObject({ ok: false });
    const edge = { source: "source", target: "target", kind: "GenericAll" };
    await expect(invoke(BEAGLE_IPC_INVOKE.aclOrigins, event(), edge)).resolves.toMatchObject({ ok: true });
    await expect(invoke(BEAGLE_IPC_INVOKE.relayTargets, event(), edge)).resolves.toMatchObject({ ok: true });
    expect(service.manager.aclOrigins).toHaveBeenCalledWith(edge); expect(service.manager.relayTargets).toHaveBeenCalledWith(edge);
    await expect(invoke(BEAGLE_IPC_INVOKE.cancelOperation, event(), { id: "../../database" })).resolves.toMatchObject({ ok: false });
  });
});
