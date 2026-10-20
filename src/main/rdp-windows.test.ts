// @vitest-environment node
import { EventEmitter } from "node:events";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";
import { RDP_IPC, type RdpTab } from "../shared/rdp-contracts.js";
import { RdpStore } from "./rdp-store.js";
import { RdpWindows } from "./rdp-windows.js";
import type { RdpRuntimeEvent } from "./rdp-runtime.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (event: unknown, raw: unknown) => void>(),
  windows: [] as MockWindow[], runtimes: [] as MockRuntime[],
  clipboard: { readText: vi.fn(async () => "local text"), writeText: vi.fn(async (_value: string) => undefined) },
}));
interface MockWindow extends EventEmitter {
  focused: boolean; visible: boolean;
  webContents: EventEmitter & { id: number; mainFrame: { processId: number; frameToken: string; url: string; isDestroyed: () => boolean }; getURL: () => string; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn>; setIgnoreMenuShortcuts: ReturnType<typeof vi.fn> };
}
interface MockRuntime { send: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; receive: (event: RdpRuntimeEvent) => void; exited: (code: string) => void }
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    BrowserWindow: class extends EventEmitter {
      focused = true; visible = true; destroyed = false;
      webContents = Object.assign(new EventEmitter(), { id: 1, mainFrame: { processId: 10, frameToken: "main", url: "", isDestroyed: () => false },
        getURL: () => this.webContents.mainFrame.url, isDestroyed: () => false, send: vi.fn(), setIgnoreMenuShortcuts: vi.fn() });
      constructor() { super(); mocks.windows.push(this as unknown as MockWindow); }
      isDestroyed = () => this.destroyed;
      isFocused = () => this.focused;
      isVisible = () => this.visible;
      isFullScreen = () => false;
      setFullScreen = vi.fn();
      show = () => { this.visible = true; };
      hide = () => { this.visible = false; };
      focus = () => { this.focused = true; };
      async loadURL(url: string): Promise<void> { this.webContents.mainFrame.url = url; }
      destroy(): void { this.destroyed = true; this.emit("closed"); }
    },
    clipboard: mocks.clipboard, nativeTheme: { shouldUseDarkColors: true },
    ipcMain: { handle: (channel: string, handler: never) => mocks.handlers.set(channel, handler), removeHandler: (channel: string) => mocks.handlers.delete(channel),
      on: (channel: string, handler: never) => mocks.listeners.set(channel, handler), removeListener: (channel: string) => mocks.listeners.delete(channel) },
  };
});
vi.mock("./rdp-runtime.js", () => ({ RdpRuntime: class {
  send = vi.fn(); stop = vi.fn();
  constructor(_executable: string, readonly receive: (event: RdpRuntimeEvent) => void, readonly exited: (code: string) => void) { mocks.runtimes.push(this); }
} }));
vi.mock("./window-options.js", () => ({ rdpWindowOptions: () => ({}) }));

let temporary: string, manager: RdpWindows, store: RdpStore;
let resolveRuntime: ReturnType<typeof vi.fn<() => Promise<string>>>;
const certificate = new X509Certificate(await readFile(new URL("../e2e/fixtures/server.crt.fixture", import.meta.url)));
const certificateEvent = (overrides: Partial<Extract<RdpRuntimeEvent, { type: "certificate" | "peerCertificate" }>> = {}): Extract<RdpRuntimeEvent, { type: "certificate" | "peerCertificate" }> => ({
  type: "certificate", requestId: "challenge-1", endpoint: "rdp.example.test:3389", fingerprint: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
  certificateDer: certificate.raw.toString("base64"), validationKind: "unknownIssuer", canOverride: true, ...overrides,
});
const frame = (seq: number): Extract<RdpRuntimeEvent, { type: "frame" }> => ({ type: "frame", seq, frameId: seq, geometry: 1, width: 800, height: 600,
  x: 0, y: 0, tileWidth: 256, tileHeight: 256, full: true, first: true, last: false, data: new ArrayBuffer(256 * 256 * 4) });
const makePort = () => Object.assign(new EventEmitter(), { start: vi.fn(), postMessage: vi.fn(), close: vi.fn() });
async function attach(tabId: string): Promise<ReturnType<typeof makePort>> {
  const ticket = (await invoke(RDP_IPC.attach, tabId)).value;
  const port = makePort();
  mocks.listeners.get(RDP_IPC.openStream)!({ ...sender(), ports: [port] }, ticket);
  expect(port.start).toHaveBeenCalledOnce();
  return port;
}
const connection = { host: "rdp.example.test", port: 3389, username: "operator", domain: "LAB", width: 800, height: 600, clipboard: true,
  label: "Test desktop", scaleMode: "fit", persistence: "session", password: "test-password-private" };
const sender = (): IpcMainInvokeEvent => ({ sender: mocks.windows[0]!.webContents, senderFrame: mocks.windows[0]!.webContents.mainFrame }) as unknown as IpcMainInvokeEvent;
async function invoke(channel: string, ...args: unknown[]): Promise<{ ok: boolean; value: unknown; error?: string }> {
  return await mocks.handlers.get(channel)!(sender(), ...args) as { ok: boolean; value: unknown; error?: string };
}
async function connect(): Promise<RdpTab> {
  const result = await invoke(RDP_IPC.connect, connection);
  expect(result.ok).toBe(true); return result.value as RdpTab;
}
beforeEach(async () => {
  mocks.windows.length = 0; mocks.runtimes.length = 0; vi.clearAllMocks();
  temporary = await mkdtemp(join(tmpdir(), "rdp-window-test-"));
  resolveRuntime = vi.fn(async () => "/trusted/sliver-rdp");
  store = new RdpStore(join(temporary, "rdp.json"), { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => "basic_text", encryptString: () => { throw new Error("unavailable"); }, decryptString: () => { throw new Error("unavailable"); } });
  manager = new RdpWindows({ rendererUrl: "sliver://app/index.html?surface=rdp", preloadPath: "/trusted/rdp.cjs", store, resolveRuntime,
    getApplicationSettings: () => DEFAULT_APPLICATION_SETTINGS_STATE, prepareWindow: () => undefined });
  await manager.open();
});
afterEach(async () => { manager.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); await rm(temporary, { recursive: true, force: true }); });

describe("RDP main authority", () => {
  it("restores only an existing hidden window without creating a new RDP window", () => {
    const window = mocks.windows[0]!;
    expect(manager.restoreRetainedWindow()).toBe(false);
    window.visible = false; window.focused = false;
    expect(manager.restoreRetainedWindow()).toBe(true);
    expect(window.visible).toBe(true); expect(window.focused).toBe(true);
    window.emit("closed");
    expect(manager.restoreRetainedWindow()).toBe(false);
    expect(mocks.windows).toHaveLength(1);
    manager.dispose();
    expect(manager.restoreRetainedWindow()).toBe(false);
  });

  it("coalesces stalled cursor delivery while retaining both the newest bitmap and position", async () => {
    const tab = await connect(), runtime = mocks.runtimes[0]!, port = await attach(tab.id);
    const cursors = () => port.postMessage.mock.calls.filter(([value]) => value.type === "cursor").map(([value]) => value);
    runtime.receive({ type: "cursor", kind: "default" });
    const bitmap = { type: "cursor" as const, kind: "bitmap" as const, width: 1, height: 1, hotspotX: 0, hotspotY: 0, data: new Uint8Array([10, 20, 30, 255]).buffer };
    for (let index = 0; index < 1000; index += 1) {
      runtime.receive(bitmap);
      runtime.receive({ type: "cursor", kind: "position", x: index, y: index });
    }
    expect(cursors()).toEqual([{ type: "cursor", kind: "default", seq: 1 }]);
    port.emit("message", { data: { type: "cursorAck", seq: 1 } });
    expect(cursors()[1]).toEqual({ type: "cursor", kind: "position", x: 999, y: 999, seq: 2 });
    port.emit("message", { data: { type: "cursorAck", seq: 2 } });
    expect(cursors()[2]).toEqual({ ...bitmap, seq: 3 });
    port.emit("message", { data: { type: "cursorAck", seq: 3 } });
    expect(cursors()).toHaveLength(3);
    expect(runtime.send.mock.calls.some(([value]) => value.type === "cursorAck")).toBe(false);
    expect(port.close).not.toHaveBeenCalled();
  });

  it("replays retained cursor state after port replacement and ignores old-port ACKs", async () => {
    const tab = await connect(), runtime = mocks.runtimes[0]!, oldPort = await attach(tab.id);
    runtime.receive({ type: "cursor", kind: "hidden" });
    runtime.receive({ type: "cursor", kind: "position", x: 44, y: 55 });
    const port = await attach(tab.id);
    expect(oldPort.close).toHaveBeenCalledOnce();
    expect(port.postMessage).toHaveBeenNthCalledWith(1, { type: "ready", protocol: 1 });
    expect(port.postMessage).toHaveBeenNthCalledWith(2, { type: "cursor", kind: "hidden", seq: 2 });
    oldPort.emit("message", { data: { type: "cursorAck", seq: 2 } });
    expect(port.postMessage).toHaveBeenCalledTimes(2);
    port.emit("message", { data: { type: "cursorAck", seq: 2 } });
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "cursor", kind: "position", x: 44, y: 55, seq: 3 });
    expect(port.close).not.toHaveBeenCalled();
    await invoke(RDP_IPC.disconnect, tab.id);
    await invoke(RDP_IPC.reconnect, { tabId: tab.id });
    const newPort = await attach(tab.id);
    expect(newPort.postMessage.mock.calls.filter(([value]) => value.type === "cursor")).toHaveLength(0);
    runtime.receive({ type: "cursor", kind: "default" });
    expect(newPort.postMessage).toHaveBeenCalledTimes(1);
    mocks.runtimes[1]!.receive({ type: "cursor", kind: "default" });
    expect(newPort.postMessage).toHaveBeenLastCalledWith({ type: "cursor", kind: "default", seq: 1 });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2, "1", undefined])("detaches malformed or unknown cursor acknowledgments (%s)", async (seq) => {
    const tab = await connect(), runtime = mocks.runtimes[0]!, port = await attach(tab.id);
    runtime.receive({ type: "cursor", kind: "default" });
    port.emit("message", { data: { type: "cursorAck", seq } });
    expect(port.close).toHaveBeenCalledOnce();
    runtime.receive({ type: "cursor", kind: "hidden" });
    expect(port.postMessage.mock.calls.filter(([value]) => value.type === "cursor")).toHaveLength(1);
  });

  it("rejects repeated cursor ACKs without returning native frame credit", async () => {
    const tab = await connect(), runtime = mocks.runtimes[0]!, port = await attach(tab.id);
    runtime.receive(frame(1)); runtime.receive({ type: "cursor", kind: "default" });
    port.emit("message", { data: { type: "cursorAck", seq: 1 } });
    expect(runtime.send).not.toHaveBeenCalledWith({ type: "ack", seq: 1 });
    port.emit("message", { data: { type: "cursorAck", seq: 1 } });
    expect(port.close).toHaveBeenCalledOnce();
    // Detach returns the still-outstanding frame credit exactly once.
    expect(runtime.send.mock.calls.filter(([value]) => value.type === "ack")).toEqual([[{ type: "ack", seq: 1 }]]);
  });

  it("publishes only changed remote state and clipboard availability", async () => {
    await connect(); const runtime = mocks.runtimes[0]!, publish = mocks.windows[0]!.webContents.send;
    publish.mockClear();
    for (let index = 0; index < 10; index += 1) {
      runtime.receive({ type: "state", state: "active" });
      runtime.receive({ type: "clipboardReady" });
      runtime.receive({ type: "clipboardAvailable", available: true });
    }
    expect(publish).toHaveBeenCalledTimes(3);
    expect(runtime.send.mock.calls.filter(([value]) => value.type === "snapshot")).toHaveLength(1);
  });

  it("sends credentials only to the private runtime after ready, never in state", async () => {
    await connect();
    const runtime = mocks.runtimes[0]!;
    expect(runtime.send).not.toHaveBeenCalled();
    runtime.receive({ type: "ready", protocol: 1 });
    expect(runtime.send).toHaveBeenCalledWith(expect.objectContaining({ type: "connect", password: connection.password }));
    expect(JSON.stringify(manager.state())).not.toContain(connection.password);
    expect(manager.state().tabs[0]?.state).toBe("connecting");
  });
  it("rejects subframes, foreign documents, and foreign windows", async () => {
    for (const event of [
      { ...sender(), senderFrame: { ...sender().senderFrame, frameToken: "subframe" } },
      { ...sender(), sender: { ...sender().sender, id: 99 } },
    ]) expect(await mocks.handlers.get(RDP_IPC.getState)!(event as IpcMainInvokeEvent)).toEqual(expect.objectContaining({ ok: false }));
    mocks.windows[0]!.webContents.mainFrame.url = "sliver://app/index.html?surface=workspace";
    expect((await invoke(RDP_IPC.connect, connection)).ok).toBe(false);
    expect(mocks.runtimes).toHaveLength(0);
  });
  it("revokes attachment tickets on tab close and consumes each ticket once", async () => {
    const tab = await connect(), ticket = (await invoke(RDP_IPC.attach, tab.id)).value as { attachmentToken: string };
    const port = Object.assign(new EventEmitter(), { start: vi.fn(), postMessage: vi.fn(), close: vi.fn() });
    const open = mocks.listeners.get(RDP_IPC.openStream)!;
    open({ ...sender(), ports: [port] }, ticket);
    expect(port.start).toHaveBeenCalledTimes(1);
    const second = Object.assign(new EventEmitter(), { close: vi.fn() });
    open({ ...sender(), ports: [second] }, ticket);
    expect(second.close).toHaveBeenCalledOnce();
    await invoke(RDP_IPC.closeTab, tab.id);
    expect(port.close).toHaveBeenCalled(); expect(mocks.runtimes[0]!.stop).toHaveBeenCalled();
  });
  it("requires focused active sessions for system clipboard and input capture", async () => {
    const tab = await connect(), runtime = mocks.runtimes[0]!;
    runtime.receive({ type: "state", state: "active" }); runtime.receive({ type: "clipboardReady" });
    mocks.windows[0]!.focused = false;
    expect((await invoke(RDP_IPC.clipboard, { tabId: tab.id, direction: "send" })).ok).toBe(false);
    expect(mocks.clipboard.readText).not.toHaveBeenCalled();
    expect((await invoke(RDP_IPC.setInputCapture, { tabId: tab.id, captured: true })).ok).toBe(false);
    mocks.windows[0]!.focused = true;
    expect((await invoke(RDP_IPC.clipboard, { tabId: tab.id, direction: "send" })).ok).toBe(true);
    expect(runtime.send).toHaveBeenCalledWith({ type: "clipboardSend", text: "local text" });
  });
  it("accepts clipboard responses only for an explicit pending receive and cancels on blur", async () => {
    const tab = await connect(), runtime = mocks.runtimes[0]!;
    runtime.receive({ type: "state", state: "active" }); runtime.receive({ type: "clipboardReady" }); runtime.receive({ type: "clipboardAvailable", available: true });
    runtime.receive({ type: "clipboard", text: "unsolicited" }); expect(mocks.clipboard.writeText).not.toHaveBeenCalled();
    const receiving = invoke(RDP_IPC.clipboard, { tabId: tab.id, direction: "receive" });
    runtime.receive({ type: "clipboard", text: "explicit remote text" });
    expect((await receiving).ok).toBe(true); expect(mocks.clipboard.writeText).toHaveBeenCalledWith("explicit remote text");
    const canceled = invoke(RDP_IPC.clipboard, { tabId: tab.id, direction: "receive" });
    mocks.windows[0]!.emit("blur");
    expect((await canceled).ok).toBe(false);
    runtime.receive({ type: "clipboard", text: "late" });
    expect(mocks.clipboard.writeText).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["clipboard-unavailable", "The remote clipboard changed or its text is no longer available. Copy the remote text again, then retry Receive."],
    ["clipboard-invalid", "The remote clipboard did not return valid Unicode text. Copy the remote text again, then retry Receive."],
    ["clipboard-too-large", "The remote clipboard text exceeds the 1 MiB limit. Copy a smaller selection, then retry Receive."],
  ])("keeps the desktop active after %s and reports the receive error", async (code, error) => {
    const tab = await connect(), runtime = mocks.runtimes[0]!, port = await attach(tab.id);
    runtime.receive({ type: "state", state: "active" }); runtime.receive({ type: "clipboardReady" }); runtime.receive({ type: "clipboardAvailable", available: true });
    const receiving = invoke(RDP_IPC.clipboard, { tabId: tab.id, direction: "receive" });
    runtime.receive({ type: "error", code: code! });
    expect(await receiving).toEqual({ ok: false, error });
    expect(manager.state().tabs[0]).toMatchObject({ state: "active", clipboardReady: true, clipboardAvailable: false });
    expect(manager.state().tabs[0]?.error).toBeUndefined();
    expect(runtime.stop).not.toHaveBeenCalled(); expect(port.close).not.toHaveBeenCalled();
    runtime.receive(frame(1));
    expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: "frame", seq: 1 }));
    const unavailable = await invoke(RDP_IPC.clipboard, { tabId: tab.id, direction: "receive" });
    expect(unavailable).toMatchObject({ ok: false, error: "The remote clipboard does not contain text" });
    runtime.receive({ type: "clipboardAvailable", available: true });
    const retry = invoke(RDP_IPC.clipboard, { tabId: tab.id, direction: "receive" });
    runtime.receive({ type: "clipboard", text: "fresh selection" });
    expect(await retry).toEqual({ ok: true });
    expect(mocks.clipboard.writeText).toHaveBeenCalledWith("fresh selection");
  });

  it("clears stale remote clipboard availability when sending local text", async () => {
    const tab = await connect(), runtime = mocks.runtimes[0]!;
    runtime.receive({ type: "state", state: "active" }); runtime.receive({ type: "clipboardReady" }); runtime.receive({ type: "clipboardAvailable", available: true });
    expect((await invoke(RDP_IPC.clipboard, { tabId: tab.id, direction: "send" })).ok).toBe(true);
    expect(manager.state().tabs[0]).toMatchObject({ state: "active", clipboardReady: true, clipboardAvailable: false });
    expect(runtime.send).toHaveBeenLastCalledWith({ type: "clipboardSend", text: "local text" });
    expect((await invoke(RDP_IPC.clipboard, { tabId: tab.id, direction: "receive" })).ok).toBe(false);
    runtime.receive({ type: "clipboardAvailable", available: true });
    expect(manager.state().tabs[0]?.clipboardAvailable).toBe(true);
  });

  it("cancels a concurrent Receive before Send changes clipboard ownership", async () => {
    const tab = await connect(), runtime = mocks.runtimes[0]!;
    runtime.receive({ type: "state", state: "active" }); runtime.receive({ type: "clipboardReady" }); runtime.receive({ type: "clipboardAvailable", available: true });
    const receiving = invoke(RDP_IPC.clipboard, { tabId: tab.id, direction: "receive" });
    expect(await invoke(RDP_IPC.clipboard, { tabId: tab.id, direction: "send" })).toEqual({ ok: true });
    expect(await receiving).toEqual({ ok: false, error: "The remote clipboard request was canceled because local text was sent." });
    runtime.receive({ type: "clipboard", text: "obsolete remote response" });
    expect(mocks.clipboard.writeText).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(manager.state().tabs[0]).toMatchObject({ state: "active", clipboardAvailable: false });
  });

  it("ignores an unsolicited clipboard failure without detaching or publishing a fatal error", async () => {
    await connect(); const runtime = mocks.runtimes[0]!;
    runtime.receive({ type: "state", state: "active" }); runtime.receive({ type: "clipboardReady" });
    const publish = mocks.windows[0]!.webContents.send; publish.mockClear();
    runtime.receive({ type: "error", code: "clipboard-unavailable" });
    expect(manager.state().tabs[0]?.state).toBe("active");
    expect(manager.state().tabs[0]?.error).toBeUndefined();
    expect(publish).not.toHaveBeenCalled(); expect(runtime.stop).not.toHaveBeenCalled();
  });

  it.each([
    ["connection-refused", "The destination refused the RDP connection. Check the hostname, port, and Remote Desktop service."],
    ["authentication-error", "Network Level Authentication could not complete. Check the account, domain, and server authentication policy."],
    ["display-limit", "The remote desktop exceeds the supported display dimensions or pixel limit."],
  ])("preserves the sanitized %s diagnostic from a failed native state", async (code, error) => {
    await connect(); const runtime = mocks.runtimes[0]!;
    runtime.receive({ type: "state", state: "failed", code: code! });
    expect(manager.state().tabs[0]).toMatchObject({ state: "failed", error });
    expect(runtime.stop).toHaveBeenCalledOnce();
    runtime.receive({ type: "terminated", code: "closed" }); runtime.exited("disconnected");
    expect(manager.state().tabs[0]).toMatchObject({ state: "failed", error });
  });

  it.each([
    ["runtime-protocol-error", "The RDP runtime sent an invalid protocol message. Reconnect or reinstall the application if this repeats."],
    ["runtime-input-limit", "The RDP runtime input queue exceeded its limit. Reconnect to recover."],
  ])("shows a controlled explanation for %s", async (code, error) => {
    await connect(); mocks.runtimes[0]!.exited(code!);
    expect(manager.state().tabs[0]).toMatchObject({ state: "failed", error });
  });

  it.each(["private-server-output-with-sensitive-text", "constructor", "__proto__"])("does not expose unknown runtime error text (%s)", async (code) => {
    await connect(); mocks.runtimes[0]!.receive({ type: "error", code });
    expect(manager.state().tabs[0]).toMatchObject({ state: "failed", error: "The RDP connection ended. Reconnect explicitly to try again." });
  });

  it("keeps connections across renderer loss and ignores old-attempt exit after reconnect", async () => {
    const tab = await connect(), first = mocks.runtimes[0]!;
    first.receive({ type: "state", state: "active" });
    mocks.windows[0]!.webContents.emit("render-process-gone");
    expect(first.stop).not.toHaveBeenCalled();
    expect(first.send).toHaveBeenCalledWith({ type: "releaseAll" });
    await invoke(RDP_IPC.disconnect, tab.id);
    const reconnected = await invoke(RDP_IPC.reconnect, { tabId: tab.id });
    expect(reconnected.ok).toBe(true); expect((reconnected.value as RdpTab).attempt).toBe(2);
    first.exited("runtime-exited");
    expect(manager.state().tabs[0]?.state).toBe("connecting");
  });
  it("does not silently reuse passwords when persistence is none", async () => {
    const result = await invoke(RDP_IPC.connect, { ...connection, persistence: "none" }), tab = result.value as RdpTab;
    await invoke(RDP_IPC.disconnect, tab.id);
    expect(await invoke(RDP_IPC.reconnect, { tabId: tab.id })).toEqual(expect.objectContaining({ ok: false, error: "Enter the password to connect" }));
  });
  it("caps sessions and terminates all runtimes at application shutdown", async () => {
    for (let index = 0; index < 4; index += 1) await connect();
    expect((await invoke(RDP_IPC.connect, connection)).ok).toBe(false);
    manager.dispose();
    expect(mocks.runtimes.every((runtime) => runtime.stop.mock.calls.length === 1)).toBe(true);
    expect(mocks.handlers.size).toBe(0);
  });
  it("binds certificate approval to the current challenge and consumes it exactly once", async () => {
    await connect();
    const runtime = mocks.runtimes[0]!;
    runtime.receive(certificateEvent());
    const previous = manager.state().tabs[0]!.review!;
    expect(previous.fingerprint).toBe(certificateEvent().fingerprint);
    expect(previous.canOverride).toBe(true);
    expect(previous.subject).toBe(certificate.subject);
    runtime.receive(certificateEvent({ requestId: "challenge-2" }));
    const current = manager.state().tabs[0]!.review!;
    expect(current.token).not.toBe(previous.token);
    expect((await invoke(RDP_IPC.respondToCertificate, { token: previous.token, decision: "once" })).ok).toBe(false);
    expect(runtime.send.mock.calls.filter(([value]) => value.type === "trustDecision")).toHaveLength(0);
    expect((await invoke(RDP_IPC.respondToCertificate, { token: current.token, decision: "once" })).ok).toBe(true);
    expect(runtime.send).toHaveBeenCalledWith({ type: "trustDecision", requestId: "challenge-2", accept: true });
    expect(manager.state().tabs[0]?.review).toBeUndefined();
    expect((await invoke(RDP_IPC.respondToCertificate, { token: current.token, decision: "pin" })).ok).toBe(false);
    expect(runtime.send.mock.calls.filter(([value]) => value.type === "trustDecision")).toHaveLength(1);
  });

  it("rejects malformed certificate identities and prevents overriding hard validation failures", async () => {
    await connect(); const runtime = mocks.runtimes[0]!;
    expect(() => runtime.receive(certificateEvent({ fingerprint: "0".repeat(64) }))).toThrow("fingerprint mismatch");
    expect(() => runtime.receive(certificateEvent({ requestId: "" }))).toThrow("challenge identity");
    expect(manager.state().tabs[0]?.review).toBeUndefined();
    runtime.receive(certificateEvent({ validationKind: "hardFailure", canOverride: true }));
    const review = manager.state().tabs[0]!.review!;
    expect(review.canOverride).toBe(false);
    expect((await invoke(RDP_IPC.respondToCertificate, { token: review.token, decision: "once" })).ok).toBe(false);
    expect((await invoke(RDP_IPC.respondToCertificate, { token: review.token, decision: "pin" })).ok).toBe(false);
    expect((await invoke(RDP_IPC.respondToCertificate, { token: review.token, decision: "reject" })).ok).toBe(true);
    expect(runtime.send).toHaveBeenCalledWith({ type: "trustDecision", requestId: "challenge-1", accept: false });
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it("expires certificate approval and cancels a pending review on renderer loss", async () => {
    vi.useFakeTimers();
    const tab = await connect(); const runtime = mocks.runtimes[0]!;
    runtime.receive(certificateEvent()); const token = manager.state().tabs[0]!.review!.token;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.state().tabs[0]).toMatchObject({ state: "failed", error: "Certificate approval expired" });
    expect((await invoke(RDP_IPC.respondToCertificate, { token, decision: "once" })).ok).toBe(false);
    expect(runtime.stop).toHaveBeenCalledOnce();
    await invoke(RDP_IPC.reconnect, { tabId: tab.id });
    const second = mocks.runtimes[1]!;
    second.receive(certificateEvent()); const secondToken = manager.state().tabs[0]!.review!.token;
    mocks.windows[0]!.webContents.emit("render-process-gone");
    expect(second.stop).toHaveBeenCalledOnce();
    expect((await invoke(RDP_IPC.respondToCertificate, { token: secondToken, decision: "once" })).ok).toBe(false);
  });

  it("terminates and publishes pin persistence failures without accepting the certificate", async () => {
    await connect(); const runtime = mocks.runtimes[0]!;
    runtime.receive(certificateEvent()); const token = manager.state().tabs[0]!.review!.token;
    vi.spyOn(store, "savePin").mockRejectedValueOnce(new Error("disk failure"));
    const result = await invoke(RDP_IPC.respondToCertificate, { token, decision: "pin" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("could not be saved") });
    expect(manager.state().tabs[0]).toMatchObject({ state: "failed", error: "The certificate pin could not be saved" });
    expect(manager.state().tabs[0]?.review).toBeUndefined();
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.send.mock.calls.filter(([value]) => value.type === "trustDecision")).toHaveLength(0);
    expect(mocks.windows[0]!.webContents.send).toHaveBeenLastCalledWith(RDP_IPC.stateChanged, manager.state());
  });

  it("does not approve a different connection attempt after a delayed pin write", async () => {
    const tab = await connect(); const first = mocks.runtimes[0]!;
    first.receive(certificateEvent()); const token = manager.state().tabs[0]!.review!.token;
    let finishPin: (() => void) | undefined;
    vi.spyOn(store, "savePin").mockImplementationOnce(() => new Promise((resolve) => { finishPin = resolve; }));
    const approval = invoke(RDP_IPC.respondToCertificate, { token, decision: "pin" });
    expect((await invoke(RDP_IPC.respondToCertificate, { token, decision: "once" })).ok).toBe(false);
    await invoke(RDP_IPC.disconnect, tab.id); await invoke(RDP_IPC.reconnect, { tabId: tab.id });
    finishPin?.();
    expect((await approval).ok).toBe(false);
    expect(mocks.runtimes.every((runtime) => runtime.send.mock.calls.every(([value]) => value.type !== "trustDecision"))).toBe(true);
    expect(manager.state().tabs[0]).toMatchObject({ attempt: 2, state: "connecting" });
  });

  it("accounts frame credit exactly once and rejects duplicate acknowledgments", async () => {
    const tab = await connect(), runtime = mocks.runtimes[0]!, port = await attach(tab.id);
    runtime.send.mockClear();
    runtime.receive(frame(1)); runtime.receive(frame(2));
    expect(runtime.send).not.toHaveBeenCalled();
    port.emit("message", { data: { type: "ack", seq: 1 } });
    expect(runtime.send).toHaveBeenCalledExactlyOnceWith({ type: "ack", seq: 1 });
    port.emit("message", { data: { type: "ack", seq: 1 } });
    expect(port.close).toHaveBeenCalledOnce();
    expect(runtime.send).toHaveBeenCalledWith({ type: "ack", seq: 2 });
    expect(runtime.send.mock.calls.filter(([value]) => value.type === "ack" && value.seq === 1)).toHaveLength(1);
    runtime.receive(frame(3));
    expect(runtime.send).toHaveBeenCalledWith({ type: "ack", seq: 3 });
  });

  it("revokes old port generations and attempt tickets while allowing fresh frame sequences", async () => {
    const tab = await connect(), first = mocks.runtimes[0]!, oldPort = await attach(tab.id);
    first.receive(frame(1));
    const fresh = await attach(tab.id);
    first.send.mockClear();
    oldPort.emit("message", { data: { type: "ack", seq: 1 } });
    oldPort.emit("message", { data: { type: "snapshot" } });
    expect(first.send).not.toHaveBeenCalled();
    const ticket = (await invoke(RDP_IPC.attach, tab.id)).value;
    await invoke(RDP_IPC.disconnect, tab.id); await invoke(RDP_IPC.reconnect, { tabId: tab.id });
    const stale = makePort(); mocks.listeners.get(RDP_IPC.openStream)!({ ...sender(), ports: [stale] }, ticket);
    expect(stale.close).toHaveBeenCalledOnce(); expect(stale.start).not.toHaveBeenCalled();
    const current = await attach(tab.id), second = mocks.runtimes[1]!;
    second.receive(frame(1)); second.send.mockClear();
    fresh.emit("message", { data: { type: "ack", seq: 1 } });
    expect(second.send).not.toHaveBeenCalled();
    current.emit("message", { data: { type: "ack", seq: 1 } });
    expect(second.send).toHaveBeenCalledExactlyOnceWith({ type: "ack", seq: 1 });
  });

  it("bounds display credit and rejects repeated runtime sequence numbers", async () => {
    const tab = await connect(), runtime = mocks.runtimes[0]!;
    await attach(tab.id);
    runtime.receive(frame(1));
    expect(() => runtime.receive(frame(1))).toThrow("sequence repeated");
    for (let seq = 2; seq <= 32; seq += 1) runtime.receive(frame(seq));
    expect(() => runtime.receive(frame(33))).toThrow("credit exceeded");
    // The real RdpRuntime catches decoder callbacks and terminates on this error.
    runtime.exited("runtime-protocol-error");
    expect(manager.state().tabs[0]?.state).toBe("failed");
  });

  it("requires capture for input and releases it on blur, local escape and port detach", async () => {
    const tab = await connect(), runtime = mocks.runtimes[0]!, port = await attach(tab.id), window = mocks.windows[0]!;
    runtime.receive({ type: "state", state: "active" });
    const input = { type: "input", events: [{ kind: "key", scanCode: 30, extended: false, down: true }] };
    runtime.send.mockClear(); port.emit("message", { data: input }); expect(runtime.send).not.toHaveBeenCalled();
    expect((await invoke(RDP_IPC.setInputCapture, { tabId: tab.id, captured: true })).ok).toBe(true);
    port.emit("message", { data: input }); expect(runtime.send).toHaveBeenCalledWith(input);
    expect(window.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    window.emit("blur"); runtime.send.mockClear(); port.emit("message", { data: input }); expect(runtime.send).not.toHaveBeenCalled();
    await invoke(RDP_IPC.setInputCapture, { tabId: tab.id, captured: true });
    window.webContents.emit("before-input-event", {}, { key: "Escape", control: true, alt: true });
    expect(window.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    runtime.send.mockClear(); port.emit("message", { data: input }); expect(runtime.send).not.toHaveBeenCalled();
    await invoke(RDP_IPC.setInputCapture, { tabId: tab.id, captured: true });
    port.emit("close");
    expect(window.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    expect((await invoke(RDP_IPC.setInputCapture, { tabId: tab.id, captured: true })).ok).toBe(false);
  });

  it("cancels connection preparation before launching a helper when the tab closes", async () => {
    let finishResolve: ((value: string) => void) | undefined;
    resolveRuntime.mockImplementationOnce(() => new Promise((resolve) => { finishResolve = resolve; }));
    const connecting = invoke(RDP_IPC.connect, connection);
    await vi.waitFor(() => expect(resolveRuntime).toHaveBeenCalledOnce());
    const tab = manager.state().tabs[0]!;
    expect((await invoke(RDP_IPC.closeTab, tab.id)).ok).toBe(true);
    finishResolve?.("/trusted/sliver-rdp");
    expect((await connecting).ok).toBe(false);
    expect(mocks.runtimes).toHaveLength(0);
    expect(manager.state().tabs).toHaveLength(0);
  });

  it("does not remove a newer reconnect attempt when an older runtime resolver completes", async () => {
    let firstResolve: ((value: string) => void) | undefined;
    let secondResolve: ((value: string) => void) | undefined;
    resolveRuntime.mockImplementationOnce(() => new Promise((resolve) => { firstResolve = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { secondResolve = resolve; }));
    const connecting = invoke(RDP_IPC.connect, connection);
    await vi.waitFor(() => expect(firstResolve).toBeDefined());
    const tab = manager.state().tabs[0]!;
    await invoke(RDP_IPC.disconnect, tab.id);
    const reconnecting = invoke(RDP_IPC.reconnect, { tabId: tab.id });
    await vi.waitFor(() => expect(secondResolve).toBeDefined());
    firstResolve?.("/trusted/sliver-rdp");
    expect((await connecting).ok).toBe(false);
    expect(manager.state().tabs[0]).toMatchObject({ id: tab.id, attempt: 2, state: "connecting" });
    secondResolve?.("/trusted/sliver-rdp");
    expect((await reconnecting).ok).toBe(true);
    expect(mocks.runtimes).toHaveLength(1);
  });

  it("keeps the active-tab reference valid when initial runtime resolution fails", async () => {
    const first = await connect();
    resolveRuntime.mockRejectedValueOnce(new Error("runtime missing"));
    expect((await invoke(RDP_IPC.connect, connection)).ok).toBe(false);
    expect(manager.state().tabs).toHaveLength(1);
    expect(manager.state().activeTabId).toBe(first.id);
    await invoke(RDP_IPC.closeTab, first.id);
    resolveRuntime.mockRejectedValueOnce(new Error("runtime missing"));
    expect((await invoke(RDP_IPC.connect, connection)).ok).toBe(false);
    expect(manager.state().tabs).toHaveLength(0);
    expect(manager.state().activeTabId).toBeUndefined();
  });

  it("does not send pre-authentication input cleanup to a helper that is still connecting", async () => {
    const tab = await connect(), runtime = mocks.runtimes[0]!, port = await attach(tab.id);
    runtime.receive({ type: "ready", protocol: 1 });
    runtime.send.mockClear();
    await invoke(RDP_IPC.setInputCapture, { tabId: tab.id, captured: false });
    port.emit("message", { data: { type: "releaseAll" } });
    mocks.windows[0]!.emit("blur");
    expect(runtime.send.mock.calls.filter(([value]) => value.type === "releaseAll")).toHaveLength(0);
    runtime.receive({ type: "state", state: "active" });
    port.emit("message", { data: { type: "releaseAll" } });
    expect(runtime.send).toHaveBeenCalledWith({ type: "releaseAll" });
  });

  it("retains a requested resize for explicit reconnect without changing the active canvas extent", async () => {
    const tab = await connect(), first = mocks.runtimes[0]!, port = await attach(tab.id);
    first.receive({ type: "state", state: "active" });
    const resize = { type: "resize", width: 1600, height: 900, scaleFactor: 200 };
    port.emit("message", { data: resize });
    expect(first.send).toHaveBeenCalledWith(resize);
    expect(manager.state().tabs[0]).toMatchObject({ width: 800, height: 600, attempt: 1 });
    first.receive({ type: "resizeFallback" });
    expect(manager.state().tabs[0]?.error).toBe("Disconnect, then reconnect to apply the requested 1600×900 desktop size.");
    await invoke(RDP_IPC.disconnect, tab.id);
    expect((await invoke(RDP_IPC.reconnect, { tabId: tab.id })).value).toMatchObject({ width: 1600, height: 900, attempt: 2 });
    const second = mocks.runtimes[1]!;
    second.receive({ type: "ready", protocol: 1 });
    expect(second.send).toHaveBeenCalledWith(expect.objectContaining({ type: "connect", width: 1600, height: 900 }));
  });

  it("does not retain malformed resize dimensions for reconnect", async () => {
    const tab = await connect(), runtime = mocks.runtimes[0]!, port = await attach(tab.id);
    runtime.receive({ type: "state", state: "active" });
    port.emit("message", { data: { type: "resize", width: 8192, height: 8192, scaleFactor: 100 } });
    expect(port.close).toHaveBeenCalledOnce();
    await invoke(RDP_IPC.disconnect, tab.id);
    expect((await invoke(RDP_IPC.reconnect, { tabId: tab.id })).value).toMatchObject({ width: 800, height: 600, attempt: 2 });
  });

});
