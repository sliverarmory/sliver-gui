// @vitest-environment node
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BEAGLE_IPC_INVOKE } from "../shared/beagle-contracts.js";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";
import { registerBeagleIpcHandlers, unregisterBeagleIpcHandlers, type BeagleIpcServices } from "./beagle-ipc.js";

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
function services(): BeagleIpcServices {
  return { manager: Object.fromEntries([
    "getState", "createProject", "selectProject", "configureBinary", "importFiles", "analyze", "query", "getQueries",
    "runSavedQuery", "search", "entity", "neighborhood", "paths", "tag", "compose", "exportGraph",
  ].map((name) => [name, vi.fn().mockResolvedValue({ marker: name })])) as unknown as BeagleIpcServices["manager"],
  getApplicationSettings: () => DEFAULT_APPLICATION_SETTINGS_STATE };
}
function invoke(channel: string, fixture: IpcMainInvokeEvent, ...args: unknown[]): unknown {
  return mocks.handlers.get(channel)!(fixture, ...args);
}
beforeEach(() => { vi.resetAllMocks(); mocks.handlers.clear(); mocks.fromWebContents.mockReturnValue(window); });

describe("Beagle IPC", () => {
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
});
