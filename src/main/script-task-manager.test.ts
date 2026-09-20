// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { SCRIPT_TASK_IPC, SCRIPT_TASK_LIMITS, parseScriptTaskCommand, parseScriptTaskSnapshot, type ScriptTaskManagerSnapshot } from "../shared/script-task-manager-contracts.js";
import { ScriptTaskManagerRelay } from "./script-task-manager.js";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_ID = "123e4567-e89b-42d3-a456-426614174001";
const snapshot = (): ScriptTaskManagerSnapshot => ({
  scripts: [{ id: ID, name: "Hello World", dirty: true, conflict: false, state: { status: "completed", elapsedMs: 12 } }],
  selectedId: ID, records: [{ sequence: 0, level: "log", text: "Hello, world!" }],
  outputReset: 1, run: { name: "Hello World", unsaved: true, editedSinceRun: false }, pending: false,
});

describe("Script Task Manager relay", () => {
  it("keeps snapshots and commands within the exact owner and companion pair", () => {
    const send = vi.fn();
    const relay = new ScriptTaskManagerRelay(send);
    relay.registerOwner(1); relay.registerOwner(2);
    relay.attachManager(1, 11); relay.attachManager(2, 22);
    relay.ownerReady(1); relay.ownerReady(2);
    const first = snapshot(); const second = { ...snapshot(), selectedId: OTHER_ID, scripts: [{ id: OTHER_ID, name: "Other", dirty: false, conflict: false }] };
    relay.publish(1, first); relay.publish(2, second);
    send.mockClear();
    expect(relay.command(11, { type: "run", id: ID })).toEqual({ ok: true });
    expect(send).toHaveBeenCalledExactlyOnceWith(1, SCRIPT_TASK_IPC.commandRequested, { type: "run", id: ID });
    expect(relay.command(22, { type: "run", id: ID }).ok).toBe(false);
    expect(relay.getState(2)).toBe(second);
    relay.publish(1, { ...first, outputReset: 2 });
    expect(send).toHaveBeenLastCalledWith(11, SCRIPT_TASK_IPC.changed, { ...first, outputReset: 2 });
  });

  it("bounds early commands, drains once ready, and drops scripts removed before readiness", () => {
    const send = vi.fn(); const relay = new ScriptTaskManagerRelay(send);
    relay.registerOwner(1); relay.attachManager(1, 11); relay.publish(1, snapshot());
    for (let index = 0; index < SCRIPT_TASK_LIMITS.pendingCommands; index++) expect(relay.command(11, { type: "run", id: ID }).ok).toBe(true);
    expect(relay.command(11, { type: "run", id: ID }).ok).toBe(false);
    send.mockClear(); relay.ownerReady(1);
    expect(send).toHaveBeenCalledTimes(SCRIPT_TASK_LIMITS.pendingCommands);
    relay.ownerReady(1);
    expect(send).toHaveBeenCalledTimes(SCRIPT_TASK_LIMITS.pendingCommands);
    relay.registerOwner(2); relay.attachManager(2, 22); relay.publish(2, snapshot());
    relay.command(22, { type: "run", id: ID });
    relay.publish(2, { scripts: [], records: [], outputReset: 0, pending: false });
    send.mockClear(); relay.ownerReady(2); expect(send).not.toHaveBeenCalled();
  });

  it("preserves output when a companion closes, revokes it when the source retires", () => {
    const relay = new ScriptTaskManagerRelay(vi.fn());
    relay.registerOwner(1); relay.attachManager(1, 11); relay.publish(1, snapshot());
    relay.detachManager(11);
    expect(relay.getState(1)).toEqual(snapshot());
    expect(relay.command(11, { type: "stop", id: ID }).ok).toBe(false);
    relay.attachManager(1, 12);
    expect(relay.removeOwner(1)).toBe(12);
    expect(relay.ownerForManager(12)).toBeUndefined();
    expect(relay.command(12, { type: "run", id: ID }).ok).toBe(false);
    expect(() => relay.getState(1)).toThrow();
    relay.registerOwner(1);
    expect(relay.getState(1).records).toEqual([]);
  });

  it("signals the host and editor with only an opaque script ID", () => {
    const send = vi.fn(); const relay = new ScriptTaskManagerRelay(send);
    relay.registerOwner(1); relay.requestEdit(1, ID);
    expect(send.mock.calls).toEqual([[1, SCRIPT_TASK_IPC.hostRequested], [1, SCRIPT_TASK_IPC.editRequested, ID]]);
  });
});

describe("bounded Script Task Manager protocol", () => {
  it("admits dirty orphan drafts beside a full saved catalog while bounding the display list", () => {
    const scripts = Array.from({ length: SCRIPT_TASK_LIMITS.displayScripts + 1 }, (_, index) => ({
      id: `123e4567-e89b-42d3-a456-${index.toString(16).padStart(12, "0")}`,
      name: `Script ${index}`, dirty: index >= 1000, conflict: index >= 1000,
    }));
    const base = { records: [], outputReset: 0, pending: false };
    expect(parseScriptTaskSnapshot({ ...base, scripts: scripts.slice(0, 1001) }).scripts).toHaveLength(1001);
    expect(parseScriptTaskSnapshot({ ...base, scripts: scripts.slice(0, 2000) }).scripts).toHaveLength(2000);
    expect(() => parseScriptTaskSnapshot({ ...base, scripts })).toThrow();
  });
  it("accepts only display snapshots and fixed UUID commands", () => {
    expect(parseScriptTaskSnapshot(snapshot())).toEqual(snapshot());
    for (const type of ["select", "run", "stop", "clear"] as const) expect(parseScriptTaskCommand({ type, id: ID })).toEqual({ type, id: ID });
  });
  it.each([
    { type: "eval", id: ID }, { type: "run", id: "../secret" }, { type: "run", id: ID, source: "console.log(1)" },
    { type: "run", id: ID, owner: 2 }, null,
  ])("rejects command capability expansion: %j", (value) => { expect(() => parseScriptTaskCommand(value)).toThrow(); });
  it.each([
    (s: ScriptTaskManagerSnapshot) => ({ ...s, source: "source must stay in the owner" }),
    (s: ScriptTaskManagerSnapshot) => ({ ...s, scripts: [...s.scripts, ...s.scripts] }),
    (s: ScriptTaskManagerSnapshot) => ({ ...s, selectedId: OTHER_ID }),
    (s: ScriptTaskManagerSnapshot) => ({ ...s, selectedId: undefined }),
    (s: ScriptTaskManagerSnapshot) => ({ ...s, records: [{ sequence: 0, level: "html", text: "hi" }] }),
    (s: ScriptTaskManagerSnapshot) => ({ ...s, records: [{ sequence: 0, level: "log", text: "x".repeat(16_385) }] }),
    (s: ScriptTaskManagerSnapshot) => ({ ...s, records: [...s.records, ...s.records] }),
    (s: ScriptTaskManagerSnapshot) => ({ ...s, scripts: [{ ...s.scripts[0], source: "secret" }] }),
    (s: ScriptTaskManagerSnapshot) => ({ ...s, scripts: [{ ...s.scripts[0], state: { status: "running", elapsedMs: Infinity } }] }),
    (s: ScriptTaskManagerSnapshot) => ({ ...s, records: Array.from({ length: 4097 }, (_, sequence) => ({ sequence, level: "log", text: "x" })) }),
    (s: ScriptTaskManagerSnapshot) => ({ ...s, records: Array.from({ length: 65 }, (_, sequence) => ({ sequence, level: "log", text: "x".repeat(16_384) })) }),
  ])("rejects malformed, secret-bearing or oversized snapshots", (mutate) => { expect(() => parseScriptTaskSnapshot(mutate(snapshot()))).toThrow(); });
});
