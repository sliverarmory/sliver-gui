// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RDP_IPC, RDP_PORT_MESSAGE, type RdpConnectInput, type RdpTab, type RdpWindowAPI, type RdpWindowState } from "../shared/rdp-contracts.js";
import { APPLICATION_CONTEXT_MENU_IPC, type ApplicationContextMenuAPI } from "../shared/application-context-menu-contracts.js";
import { DEFAULT_APPLICATION_SETTINGS_STATE, DEFAULT_APPLICATION_SETTINGS_VALUES } from "../shared/application-settings-contracts.js";
import { RDP_PREVIEW_FIXTURE } from "../tests/rdp-preview-fixture.js";

const mocks = vi.hoisted(() => ({
  expose: vi.fn(), invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(), on: vi.fn(), removeListener: vi.fn(), postMessage: vi.fn(), send: vi.fn(),
}));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener, postMessage: mocks.postMessage, send: mocks.send } }));
await import("./rdp.js");
const bridge = (): RdpWindowAPI => mocks.expose.mock.calls.find(([name]) => name === "rdp")![1] as RdpWindowAPI;
const contextMenu = (): ApplicationContextMenuAPI => mocks.expose.mock.calls.find(([name]) => name === "applicationContextMenu")![1] as ApplicationContextMenuAPI;
const token = "a".repeat(43);
const correlationId = "11111111-1111-4111-8111-111111111111";
const tab: RdpTab = { id: "tab", attempt: 1, label: "Desktop", host: "desktop.test", port: 3389, username: "operator", domain: "LAB", width: 1280, height: 800, clipboard: false, scaleMode: "fit", state: "connecting", clipboardReady: true, clipboardAvailable: false };
const state: RdpWindowState = { tabs: [tab], profiles: [], activeTabId: tab.id, securePersistenceAvailable: true, maxSessions: 4 };

beforeEach(() => {
  mocks.invoke.mockReset(); mocks.on.mockClear(); mocks.removeListener.mockClear(); mocks.postMessage.mockClear();
  mocks.invoke.mockImplementation(async (channel) => {
    if (channel === RDP_IPC.getState) return { ok: true, value: state };
    if (channel === RDP_IPC.connect || channel === RDP_IPC.reconnect) return { ok: true, value: tab };
    if (channel === RDP_IPC.attach) return { ok: true, value: { tabId: tab.id, attempt: 1, attachmentToken: token } };
    if (channel === RDP_IPC.getApplicationSettings) return DEFAULT_APPLICATION_SETTINGS_STATE;
    return { ok: true };
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("RDP sandbox preload", () => {
  it("exposes only frozen dedicated desktop and context-menu bridges", () => {
    expect(mocks.expose.mock.calls.map(([name]) => name)).toEqual(["rdp", "applicationContextMenu"]);
    expect(Object.isFrozen(bridge())).toBe(true);
    expect(Object.isFrozen(contextMenu())).toBe(true);
    expect(Object.keys(bridge())).not.toContain("invoke");
    expect(Object.keys(bridge())).not.toContain("send");
  });

  it("validates direct connection requests before crossing IPC and strips no hidden authority", async () => {
    const input: RdpConnectInput = { host: tab.host, port: tab.port, username: tab.username, domain: tab.domain, width: tab.width, height: tab.height, clipboard: false, label: tab.label, scaleMode: "fit", password: "test-value", persistence: "none" };
    await bridge().connect(input);
    expect(mocks.invoke).toHaveBeenCalledWith(RDP_IPC.connect, input);
    expect(() => bridge().connect({ ...input, executable: "/tmp/other" } as never)).toThrow();
    expect(() => bridge().connect({ ...input, host: "https://desktop.test" })).toThrow();
    expect(() => bridge().connect({ ...input, width: 8192, height: 8192 })).toThrow();
    expect(() => bridge().connect({ ...input, password: "bad\0value" })).toThrow();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("accepts bounded JPEG previews only through the current tab and attempt request", async () => {
    const input = { tabId: "tab", attempt: 1, dataUrl: RDP_PREVIEW_FIXTURE.dataUrl };
    expect(await bridge().savePreview(input)).toEqual({ ok: true });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(RDP_IPC.savePreview, input);
    for (const invalid of [{ ...input, profileId: "other" }, { ...input, attempt: -1 }, { ...input, dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }]) {
      expect(() => bridge().savePreview(invalid as never)).toThrow();
    }
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it("exposes validated immutable saved frames while accepting legacy profiles without previews", async () => {
    const profile = { id: "profile", host: tab.host, port: tab.port, username: tab.username, domain: tab.domain, width: tab.width, height: tab.height,
      clipboard: false, label: tab.label, scaleMode: "fit", hasCredential: false, credentialPersistence: "none" };
    for (const raw of [profile, { ...profile, preview: RDP_PREVIEW_FIXTURE }]) {
      mocks.invoke.mockResolvedValueOnce({ ok: true, value: { ...state, profiles: [raw] } });
      const result = await bridge().getState();
      expect(result).toEqual({ ok: true, value: { ...state, profiles: [raw] } });
      if (result.ok && result.value.profiles[0]?.preview) expect(Object.isFrozen(result.value.profiles[0].preview)).toBe(true);
    }
    mocks.invoke.mockResolvedValueOnce({ ok: true, value: { ...state, profiles: [{ ...profile, preview: { ...RDP_PREVIEW_FIXTURE, width: 9999 } }] } });
    await expect(bridge().getState()).rejects.toThrow();
  });

  it("narrowly maps control calls and rejects mixed clipboard, capture and certificate requests", async () => {
    await bridge().disconnect("tab"); await bridge().closeTab("tab"); await bridge().selectTab("tab");
    await bridge().renameTab({ tabId: "tab", label: "New name" }); await bridge().deleteProfile("profile");
    await bridge().respondToCertificate({ token, decision: "once" }); await bridge().clipboard({ tabId: "tab", direction: "send" });
    await bridge().setInputCapture({ tabId: "tab", captured: true }); await bridge().toggleFullscreen();
    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).toEqual([RDP_IPC.disconnect, RDP_IPC.closeTab, RDP_IPC.selectTab, RDP_IPC.renameTab, RDP_IPC.deleteProfile, RDP_IPC.respondToCertificate, RDP_IPC.clipboard, RDP_IPC.setInputCapture, RDP_IPC.toggleFullscreen]);
    expect(() => bridge().respondToCertificate({ token, decision: "ignore-all" } as never)).toThrow();
    expect(() => bridge().respondToCertificate({ token: "wrong", decision: "once" })).toThrow();
    expect(() => bridge().clipboard({ tabId: "tab", direction: "send", text: "hidden" } as never)).toThrow();
    expect(() => bridge().setInputCapture({ tabId: "tab", captured: "true" } as never)).toThrow();
  });

  it("validates application settings updates and their response before crossing the bridge", async () => {
    const input = { expectedRevision: 0, settings: { ...DEFAULT_APPLICATION_SETTINGS_VALUES, rdp: { clipboard: false, transparentClipboard: false } } };
    const updated = { ...DEFAULT_APPLICATION_SETTINGS_STATE, ...input.settings, revision: 1 };
    mocks.invoke.mockResolvedValueOnce({ ok: true, value: updated });
    expect(await bridge().updateApplicationSettings(input)).toEqual({ ok: true, value: updated });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(RDP_IPC.updateApplicationSettings, input);
    expect(() => bridge().updateApplicationSettings({ ...input, expectedRevision: -1 })).toThrow();
    expect(() => bridge().updateApplicationSettings({ ...input, settings: { ...input.settings, rdp: { clipboard: "false" } } } as never)).toThrow();
    expect(() => bridge().updateApplicationSettings({ ...input, path: "/tmp/settings.json" } as never)).toThrow();
    expect(mocks.invoke).toHaveBeenCalledOnce();
    mocks.invoke.mockResolvedValueOnce({ ok: true, value: { ...updated, rdp: { clipboard: "false" } } });
    await expect(bridge().updateApplicationSettings(input)).rejects.toThrow("Invalid application settings state");
  });

  it("preserves settings update errors for renderer feedback", async () => {
    const input = { expectedRevision: 0, settings: DEFAULT_APPLICATION_SETTINGS_VALUES };
    const failure = { ok: false, error: "Application settings changed in another window" };
    mocks.invoke.mockResolvedValueOnce(failure);
    expect(await bridge().updateApplicationSettings(input)).toEqual(failure);
    mocks.invoke.mockRejectedValueOnce(new Error("Settings service unavailable"));
    await expect(bridge().updateApplicationSettings(input)).rejects.toThrow("Settings service unavailable");
  });

  it("validates snapshots and events without exposing Electron events or extra secret fields", async () => {
    const initial = await bridge().getState();
    expect(initial).toEqual({ ok: true, value: state });
    if (initial.ok) expect(Object.isFrozen(initial.value.tabs)).toBe(true);
    const callback = vi.fn();
    const remove = bridge().onStateChanged(callback);
    const handler = mocks.on.mock.calls.find(([channel]) => channel === RDP_IPC.stateChanged)![1] as (event: unknown, ...args: unknown[]) => void;
    handler({ sender: "secret native event" }, state);
    handler({}, { ...state, tabs: [{ ...tab, password: "must-never-cross" }] });
    handler({}, { ...state, activeTabId: "missing" });
    handler({}, state, "extra");
    expect(callback).toHaveBeenCalledExactlyOnceWith(state);
    remove(); expect(mocks.removeListener).toHaveBeenCalledWith(RDP_IPC.stateChanged, handler);
    mocks.invoke.mockResolvedValueOnce({ ok: true, value: { ...state, profiles: [{ ...tab, hasCredential: true, credentialPersistence: "secure", password: "hidden" }] } });
    await expect(bridge().getState()).rejects.toThrow();
  });

  it("creates a one-use MessageChannel only for a valid attachment and correlation", () => {
    const port1 = { close: vi.fn() }, port2 = { close: vi.fn() };
    const postMessage = vi.fn();
    const channel = vi.fn(function () { return { port1, port2 }; });
    vi.stubGlobal("MessageChannel", channel);
    vi.stubGlobal("window", { postMessage });
    expect(() => bridge().openRdpStream("bad", correlationId)).toThrow();
    expect(() => bridge().openRdpStream(token, "bad")).toThrow();
    expect(channel).not.toHaveBeenCalled();
    bridge().openRdpStream(token, correlationId);
    expect(mocks.postMessage).toHaveBeenCalledExactlyOnceWith(RDP_IPC.openStream, { attachmentToken: token }, [port1]);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: RDP_PORT_MESSAGE, correlationId }, "*", [port2]);
    postMessage.mockImplementationOnce(() => { throw new Error("closed"); });
    expect(() => bridge().openRdpStream(token, correlationId)).toThrow("closed");
    expect(port1.close).toHaveBeenCalledOnce(); expect(port2.close).toHaveBeenCalledOnce();
  });

  it("retains the shared context-menu capability boundary", () => {
    const listener = vi.fn();
    contextMenu().onMenuRequested(listener);
    const handler = mocks.on.mock.calls.find(([channel]) => channel === APPLICATION_CONTEXT_MENU_IPC.menuRequested)![1] as (event: unknown, ...args: unknown[]) => void;
    const value = { v: 1, requestId: correlationId, x: 20, y: 30, items: [{ type: "action", actionId: "22222222-2222-4222-8222-222222222222", kind: "copy", label: "Copy", enabled: true }] };
    handler({}, value); handler({}, { ...value, path: "/tmp/extra" });
    expect(listener).toHaveBeenCalledExactlyOnceWith(value);
    expect(() => contextMenu().executeAction({ requestId: correlationId, actionId: "copy" })).toThrow();
  });
});
