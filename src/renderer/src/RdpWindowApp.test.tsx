import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toast, toast } from "@heroui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../shared/application-settings-contracts";
import type { RdpConnectInput, RdpFileTransferProgressEvent, RdpImportResult, RdpProfile, RdpSocks5Proxy, RdpTab, RdpWindowAPI, RdpWindowState } from "../../shared/rdp-contracts";
import { renderWithApplicationContextMenu } from "./application-context-menu-test-utils";
import { ApplicationSettingsProvider } from "./components/ApplicationSettingsProvider";

vi.mock("./components/rdp/RdpDesktop", async () => {
  const React = await import("react");
  return {
    RdpDesktop: React.forwardRef((props: { tab: RdpTab; active: boolean; inputEnabled: boolean; autoResize: boolean; highDpi: boolean }, ref) => {
      React.useImperativeHandle(ref, () => ({ release: vi.fn(), focus: vi.fn(), specialKey: vi.fn(), resizeToWindow: vi.fn(), savePreview: vi.fn(async () => undefined) }));
      return <section aria-label={`Remote desktop for ${props.tab.label}`} data-active={props.active} data-input-enabled={props.inputEnabled} data-auto-resize={props.autoResize} data-high-dpi={props.highDpi} />;
    }),
    phaseLabel: (state: string) => state,
  };
});

import { RdpWindowApp } from "./RdpWindowApp";

const firstTab: RdpTab = { id: "first", attempt: 1, label: "Office", host: "office.test", port: 3389, username: "operator", domain: "LAB",
  width: 1280, height: 800, clipboard: true, clipboardReady: true, clipboardAvailable: true, scaleMode: "fit", state: "active" };
const profile: RdpProfile = { id: "saved", label: "Saved desktop", host: "saved.test", port: 3390, username: "admin", domain: "",
  width: 1920, height: 1080, clipboard: false, scaleMode: "fit", hasCredential: true, credentialPersistence: "secure" };
const proxy: RdpSocks5Proxy = { id: "socks5-proxy-one", label: "Workstation", host: "127.0.0.1", port: 1080, authentication: "none", available: true };
let state: RdpWindowState;
let api: RdpWindowAPI;
let listener: ((value: RdpWindowState) => void) | undefined;
let progressListener: ((value: RdpFileTransferProgressEvent) => void) | undefined;
let importListener: ((value: RdpImportResult) => void) | undefined;
let connectedInput: RdpConnectInput | undefined;

beforeEach(() => {
  vi.spyOn(toast, "success").mockReturnValue("success-toast");
  vi.spyOn(toast, "danger").mockReturnValue("error-toast");
  vi.spyOn(toast, "warning").mockReturnValue("warning-toast");
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  state = { tabs: [], profiles: [], securePersistenceAvailable: true, maxSessions: 4 };
  connectedInput = undefined;
  listener = undefined;
  progressListener = undefined;
  importListener = undefined;
  api = {
    getState: vi.fn(async () => ({ ok: true as const, value: state })),
    openNetworkManager: vi.fn(async () => ({ ok: true as const })),
    startSessionProxy: vi.fn(async () => ({ ok: true as const, value: proxy })),
    connect: vi.fn(async (input) => { connectedInput = { ...input }; const { password: _password, proxyPassword: _proxyPassword, ...options } = input; const tab = { ...firstTab, ...options, ...(input.temporaryId ? { temporary: true } : {}) }; const { pendingConnection: _pending, ...remaining } = state; state = { ...remaining, tabs: [tab], activeTabId: tab.id }; listener?.(state); return { ok: true as const, value: tab }; }),
    cancelTemporary: vi.fn(async () => { const { pendingConnection: _pending, ...remaining } = state; state = remaining; listener?.(state); return { ok: true as const }; }),
    reconnect: vi.fn(async () => ({ ok: true as const, value: firstTab })),
    disconnect: vi.fn(async () => ({ ok: true as const })), closeTab: vi.fn(async () => ({ ok: true as const })),
    selectTab: vi.fn(async (tabId) => { state = { ...state, activeTabId: tabId }; listener?.(state); return { ok: true as const }; }),
    renameTab: vi.fn(async () => ({ ok: true as const })),
    saveProfile: vi.fn(async (input) => { const saved = { ...profile, ...input }; state = { ...state, profiles: [saved] }; listener?.(state); return { ok: true as const, value: saved }; }),
    importProfiles: vi.fn(async () => ({ ok: true as const, value: { canceled: true, items: [] } })),
    importDroppedProfiles: vi.fn(async () => ({ ok: true as const, value: { canceled: true, items: [] } })),
    deleteProfile: vi.fn(async () => ({ ok: true as const })), respondToCertificate: vi.fn(async () => ({ ok: true as const })),
    savePreview: vi.fn(async () => ({ ok: true as const })),
    attach: vi.fn(async () => ({ ok: true as const, value: { tabId: "first", attempt: 1, attachmentToken: "token" } })),
    openRdpStream: vi.fn(), clipboard: vi.fn(async () => ({ ok: true as const })), setInputCapture: vi.fn(async () => ({ ok: true as const })), toggleFullscreen: vi.fn(async () => ({ ok: true as const })),
    getApplicationSettings: vi.fn(async () => DEFAULT_APPLICATION_SETTINGS_STATE),
    updateApplicationSettings: vi.fn(async (input) => ({ ok: true as const, value: { ...DEFAULT_APPLICATION_SETTINGS_STATE, ...input.settings, revision: input.expectedRevision + 1 } })),
    onStateChanged: vi.fn((next) => { listener = next; return () => { listener = undefined; }; }),
    onFileTransferProgress: vi.fn((next) => { progressListener = next; return () => { progressListener = undefined; }; }),
    onProfilesImported: vi.fn((next) => { importListener = next; return () => { importListener = undefined; }; }),
    onApplicationSettingsChanged: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "rdp", { configurable: true, value: api });
});
afterEach(() => { cleanup(); toast.clear(); delete window.rdp; Reflect.deleteProperty(Element.prototype, "getAnimations"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function dropProfiles(target: HTMLElement, files: File[]): void {
  const dataTransfer = { dropEffect: "none", effectAllowed: "all", files, types: ["Files"],
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    getData: () => "", setData: () => undefined, clearData: () => undefined, setDragImage: () => undefined,
  } as unknown as DataTransfer;
  const area = target.closest<HTMLElement>(".drop-zone__area")!;
  fireEvent.dragEnter(area, { dataTransfer }); fireEvent.drop(area, { dataTransfer });
}

describe("standalone remote desktop window", () => {
  it("offers live Sliver sessions from window state and saves the created proxy route", async () => {
    const session = { id: "live-session-one", sessionId: "11111111-1111-4111-8111-111111111111", label: "Workstation", hostname: "workstation.test" };
    state = { ...state, socks5Sessions: [session], profiles: [{ ...profile, username: "", hasCredential: false, credentialPersistence: "none" }] };
    const user = userEvent.setup(); renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect to Saved desktop" }));
    await user.click(screen.getByRole("button", { name: "Networking" }));
    await user.click(screen.getByRole("button", { name: "Connection route" }));
    await user.click(await screen.findByRole("menuitemradio", { name: (name) => name.startsWith(`Via ${session.label}`) }));
    expect(api.startSessionProxy).toHaveBeenCalledExactlyOnceWith(session.id);
    await waitFor(() => expect(screen.getByLabelText("Connection route")).toHaveAttribute("data-route-value", proxy.id));
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ networking: { kind: "socks5", proxyId: proxy.id } })));
    expect(api.connect).not.toHaveBeenCalled();
  });

  it.each(["nla", "remote-screen"] as const)("asks for a fresh manual proxy password on a saved %s profile", async (signInMode) => {
    const networking = { kind: "socks5-manual" as const, host: "proxy.test", port: 1080, username: "proxy-user" };
    state = { ...state, profiles: [{ ...profile, signInMode, networking }] };
    const user = userEvent.setup(); renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect to Saved desktop" }));
    const editor = await screen.findByRole("dialog", { name: "Edit Remote Desktop" });
    expect(within(editor).getByLabelText("Proxy password")).toHaveValue("");
    expect(api.connect).not.toHaveBeenCalled();
    if (signInMode === "nla") expect(within(editor).getByLabelText("Password")).toHaveAttribute("placeholder", "Use saved credential");
    else expect(within(editor).queryByLabelText("Password")).not.toBeInTheDocument();
    await user.type(within(editor).getByLabelText("Proxy password"), "proxy-secret");
    await user.click(within(editor).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ profileId: profile.id, networking, proxyPassword: "proxy-secret", persistence: signInMode === "nla" ? "secure" : "none" }));
    expect(connectedInput).not.toHaveProperty("password");
    expect(api.saveProfile).not.toHaveBeenCalled();
  });

  it("quick-connects a saved manual proxy with no proxy authentication", async () => {
    const networking = { kind: "socks5-manual" as const, host: "proxy.test", port: 1080 };
    state = { ...state, profiles: [{ ...profile, networking }] };
    const user = userEvent.setup(); renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect to Saved desktop" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ networking, persistence: "secure" }));
    expect(connectedInput).not.toHaveProperty("password");
    expect(connectedInput).not.toHaveProperty("proxyPassword");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["nla", "remote-screen"] as const)("reconnects %s through an authenticated manual proxy without resending remembered RDP credentials", async (signInMode) => {
    const networking = { kind: "socks5-manual" as const, host: "proxy.test", port: 1080, username: "proxy-user" };
    const tab = { ...firstTab, signInMode, networking, state: "disconnected" as const };
    state = { ...state, tabs: [tab], activeTabId: tab.id };
    let request: Parameters<RdpWindowAPI["reconnect"]>[0] | undefined;
    vi.mocked(api.reconnect).mockImplementation(async (input) => { request = { ...input }; return { ok: false, error: "Proxy authentication failed." }; });
    const user = userEvent.setup(); renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Reconnect" }));
    const dialog = await screen.findByRole("dialog", { name: "Reconnect to Remote Desktop" });
    if (signInMode === "nla") expect(within(dialog).getByLabelText("Password")).toHaveValue("");
    else expect(within(dialog).queryByLabelText("Password")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Reconnect" }));
    expect(within(dialog).getByLabelText("Proxy password")).toHaveAttribute("aria-invalid", "true");
    expect(api.reconnect).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText("Proxy password"), "proxy-secret");
    await user.click(within(dialog).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(request).toEqual({ tabId: tab.id, proxyPassword: "proxy-secret" }));
    expect(vi.mocked(api.reconnect).mock.calls[0]![0]).not.toHaveProperty("proxyPassword");
    expect(within(dialog).getByLabelText("Proxy password")).toHaveValue("");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Proxy authentication failed.");
  });

  it("clears both reconnect drafts on cancel and sends newly supplied RDP and proxy passwords only once", async () => {
    const networking = { kind: "socks5-manual" as const, host: "proxy.test", port: 1080, username: "proxy-user" };
    state = { ...state, tabs: [{ ...firstTab, networking, state: "disconnected" }], activeTabId: firstTab.id };
    let request: Parameters<RdpWindowAPI["reconnect"]>[0] | undefined;
    vi.mocked(api.reconnect).mockImplementation(async (input) => { request = { ...input }; return { ok: true, value: firstTab }; });
    const user = userEvent.setup(); renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Reconnect" }));
    let dialog = screen.getByRole("dialog", { name: "Reconnect to Remote Desktop" });
    await user.type(within(dialog).getByLabelText("Password"), "discarded-rdp"); await user.type(within(dialog).getByLabelText("Proxy password"), "discarded-proxy");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    dialog = screen.getByRole("dialog", { name: "Reconnect to Remote Desktop" });
    expect(within(dialog).getByLabelText("Password")).toHaveValue(""); expect(within(dialog).getByLabelText("Proxy password")).toHaveValue("");
    await user.type(within(dialog).getByLabelText("Password"), "fresh-rdp"); await user.type(within(dialog).getByLabelText("Proxy password"), "fresh-proxy");
    await user.click(within(dialog).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(request).toEqual({ tabId: firstTab.id, password: "fresh-rdp", proxyPassword: "fresh-proxy" }));
    expect(vi.mocked(api.reconnect).mock.calls[0]![0]).not.toHaveProperty("password");
    expect(vi.mocked(api.reconnect).mock.calls[0]![0]).not.toHaveProperty("proxyPassword");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("subscribes before reading state and presents an OS-launch import only once", async () => {
    const result: RdpImportResult = { canceled: false, items: [{ name: "opened.rdp", profile, warnings: ["Unsupported settings were ignored."] }] };
    vi.mocked(api.getState).mockImplementationOnce(async () => {
      expect(importListener).toBeDefined();
      importListener?.(result);
      state = { ...state, profiles: [profile] };
      return { ok: true, value: state };
    });
    const user = userEvent.setup(); const view = renderWithApplicationContextMenu(<RdpWindowApp />);
    const summary = await screen.findByRole("dialog", { name: "RDP import results" });
    expect(summary).toHaveTextContent("opened.rdp");
    expect(api.connect).not.toHaveBeenCalled();
    await user.click(within(summary).getByRole("button", { name: "Done" }));
    act(() => { listener?.(state); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Connect to Saved desktop" })).toBeInTheDocument();
    view.unmount();
    expect(importListener).toBeUndefined();
  });

  it("defers OS import results until the connection editor closes", async () => {
    const user = userEvent.setup(); renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "New connection" }));
    const editor = await screen.findByRole("dialog", { name: "New Remote Desktop" });
    await user.type(within(editor).getByLabelText("Computer"), "draft.test");
    act(() => { importListener?.({ canceled: false, items: [{ name: "opened.rdp", warnings: [], error: "Invalid RDP address." }] }); });
    expect(screen.queryByRole("dialog", { name: "RDP import results" })).not.toBeInTheDocument();
    expect(within(editor).getByLabelText("Computer")).toHaveValue("draft.test");
    await user.click(within(editor).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("dialog", { name: "RDP import results" })).toHaveTextContent("Invalid RDP address.");
  });

  it("imports native picker results into saved connections without connecting", async () => {
    vi.mocked(api.importProfiles).mockImplementation(async () => {
      state = { ...state, profiles: [profile] }; listener?.(state);
      return { ok: true, value: { canceled: false, items: [{ name: "desktop.rdp", profile, warnings: [] }] } };
    });
    const user = userEvent.setup(); renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Import .rdp" }));
    await waitFor(() => expect(api.importProfiles).toHaveBeenCalledOnce());
    expect(await screen.findByRole("button", { name: "Connect to Saved desktop" })).toBeInTheDocument();
    expect(api.connect).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("1 profile imported");
  });

  it("leaves saved connections unchanged when the import picker is canceled", async () => {
    const user = userEvent.setup(); renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Import .rdp" }));
    await waitFor(() => expect(api.importProfiles).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog", { name: "RDP import results" })).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
  });

  it("summarizes per-file import warnings and failures without connecting", async () => {
    vi.mocked(api.importProfiles).mockResolvedValue({ ok: true, value: { canceled: false, items: [
      { name: "desktop.rdp", profile, warnings: ["Unsupported settings were ignored."] },
      { name: "invalid.rdp", warnings: [], error: "Invalid RDP address." },
    ] } });
    const user = userEvent.setup(); renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Import .rdp" }));
    const summary = await screen.findByRole("dialog", { name: "RDP import results" });
    expect(summary).toHaveTextContent("1 of 2 profiles imported.");
    expect(summary).toHaveTextContent("desktop.rdp");
    expect(summary).toHaveTextContent("Unsupported settings were ignored.");
    expect(summary).toHaveTextContent("Invalid RDP address.");
    expect(api.connect).not.toHaveBeenCalled();
    await user.click(within(summary).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it.each([false, true])("passes native dropped files to preload on an %s populated grid", async (populated) => {
    state = { ...state, profiles: populated ? [profile] : [] };
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Import .rdp" })).toBeEnabled());
    const file = new File(["full address:s:desktop.test"], "desktop.rdp");
    const read = vi.fn(); Object.defineProperty(file, "text", { value: read });
    dropProfiles(screen.getByLabelText("Import RDP profiles"), [file]);
    await waitFor(() => expect(api.importDroppedProfiles).toHaveBeenCalledExactlyOnceWith([file]));
    expect(read).not.toHaveBeenCalled();
    expect(api.importProfiles).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
  });

  it("ignores another drop while importing and reports the first failure", async () => {
    let finish!: (result: Awaited<ReturnType<RdpWindowAPI["importDroppedProfiles"]>>) => void;
    vi.mocked(api.importDroppedProfiles).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Import .rdp" })).toBeEnabled());
    const target = screen.getByLabelText("Import RDP profiles");
    dropProfiles(target, [new File([], "one.rdp")]);
    await waitFor(() => expect(api.importDroppedProfiles).toHaveBeenCalledOnce());
    dropProfiles(target, [new File([], "two.rdp")]);
    expect(api.importDroppedProfiles).toHaveBeenCalledOnce();
    await act(async () => { finish({ ok: false, error: "The file could not be imported." }); });
    expect(toast.danger).toHaveBeenCalledWith("Remote Desktop action failed", { description: "The file could not be imported." });
  });

  it("opens the full editor for an imported NLA profile without a username", async () => {
    state = { ...state, profiles: [{ ...profile, username: "", hasCredential: false, credentialPersistence: "none" }] };
    const user = userEvent.setup(); renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect to Saved desktop" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Remote Desktop" });
    expect(within(dialog).getByLabelText("Username")).toHaveValue("");
    expect(within(dialog).getByLabelText("Computer")).toHaveValue(profile.host);
    expect(api.connect).not.toHaveBeenCalled();
  });

  it.each(["missing", "stopped"])("opens the editor when a saved profile's proxy is %s", async (availability) => {
    state = { ...state, profiles: [{ ...profile, networking: { kind: "socks5", proxyId: proxy.id } }],
      socks5Proxies: availability === "missing" ? [] : [{ ...proxy, available: false }] };
    const user = userEvent.setup(); renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect to Saved desktop" }));
    await screen.findByRole("dialog", { name: "Edit Remote Desktop" });
    expect(screen.getByLabelText("Connection route")).toHaveAttribute("data-route-value", proxy.id);
    expect(api.connect).not.toHaveBeenCalled();
  });

  it("preserves the saved proxy during quick connect and delegates reconnect to the same tab", async () => {
    const networking = { kind: "socks5" as const, proxyId: proxy.id };
    state = { ...state, socks5Proxies: [proxy], profiles: [{ ...profile, networking }] };
    const user = userEvent.setup(); renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect to Saved desktop" }));
    await waitFor(() => expect(connectedInput).toHaveProperty("networking", networking));
    act(() => { state = { ...state, tabs: state.tabs.map((tab) => ({ ...tab, state: "disconnected" })) }; listener?.(state); });
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    await user.click(within(screen.getByRole("dialog", { name: "Reconnect to Remote Desktop" })).getByRole("button", { name: "Reconnect" }));
    expect(api.reconnect).toHaveBeenCalledWith({ tabId: state.tabs[0]!.id });
    expect(state.tabs[0]!.networking).toEqual(networking);
  });

  it("opens a pending Overview connection and submits fresh credentials without saving a profile", async () => {
    state = { ...state, profiles: [profile], pendingConnection: { id: "temporary-one", label: "Windows workstation", host: "127.0.0.1", port: 42001 } };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    const dialog = await screen.findByRole("dialog", { name: "Connect to Remote Desktop" });
    expect(within(dialog).getByLabelText("Computer")).toHaveValue("127.0.0.1");
    expect(within(dialog).getByLabelText("Computer")).toHaveAttribute("readonly");
    expect(within(dialog).getByLabelText("Port")).toHaveAttribute("readonly");
    expect(within(dialog).queryByLabelText("Remember password")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save profile" })).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Username"), "Administrator");
    await user.type(within(dialog).getByLabelText("Password"), "private-input");
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ temporaryId: "temporary-one", host: "127.0.0.1", port: 42001,
      persistence: "none", username: "Administrator", password: "private-input" }));
    expect(connectedInput).not.toHaveProperty("profileId");
    expect(api.saveProfile).not.toHaveBeenCalled();
    expect(await screen.findByText("Temporary connection")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancels an incoming temporary connection and resets credentials for the next request", async () => {
    state = { ...state, tabs: [firstTab], activeTabId: firstTab.id };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    const desktop = await screen.findByLabelText("Remote desktop for Office");
    act(() => { state = { ...state, pendingConnection: { id: "temporary-one", label: "Windows one", host: "127.0.0.1", port: 42001 } }; listener?.(state); });
    const dialog = await screen.findByRole("dialog", { name: "Connect to Remote Desktop" });
    expect(desktop).toHaveAttribute("data-input-enabled", "false");
    await user.type(within(dialog).getByLabelText("Password"), "private-input");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(api.cancelTemporary).toHaveBeenCalledWith("temporary-one"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(desktop).toHaveAttribute("data-input-enabled", "true");
    act(() => { state = { ...state, pendingConnection: { id: "temporary-two", label: "Windows two", host: "127.0.0.1", port: 42002 } }; listener?.(state); });
    await screen.findByRole("dialog", { name: "Connect to Remote Desktop" });
    expect(screen.getByLabelText("Connection name")).toHaveValue("Windows two");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("offers trust once for a temporary certificate and removes reconnect after disconnect", async () => {
    state = { ...state, tabs: [{ ...firstTab, temporary: true, state: "certificate-review", review: { token: "review", host: "127.0.0.1", port: 42001, fingerprint: "SHA256:reviewed", subject: "CN=office.test", issuer: "CN=office.test", validFrom: "2026-01-01", validTo: "2027-01-01", reason: "Untrusted certificate", canOverride: true, expiresAt: "2026-12-01" } }], activeTabId: "first" };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await screen.findByRole("heading", { name: "Review Server Certificate" });
    expect(screen.queryByRole("button", { name: "Trust and remember" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Trust once" }));
    expect(api.respondToCertificate).toHaveBeenCalledWith({ token: "review", decision: "once" });
    act(() => { state = { ...state, tabs: [{ ...firstTab, temporary: true, state: "disconnected" }] }; listener?.(state); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close remote desktop tab" })).toBeEnabled();
  });

  it("keeps a temporary startup failure visible after main has consumed its pending request", async () => {
    state = { ...state, pendingConnection: { id: "temporary-one", label: "Windows workstation", host: "127.0.0.1", port: 42001 } };
    vi.mocked(api.connect).mockImplementation(async () => {
      const { pendingConnection: _pending, ...remaining } = state;
      state = remaining; listener?.(state);
      return { ok: false, error: "The Windows session disconnected." };
    });
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    const dialog = await screen.findByRole("dialog", { name: "Connect to Remote Desktop" });
    await user.type(within(dialog).getByLabelText("Username"), "Administrator");
    await user.type(within(dialog).getByLabelText("Password"), "private-input");
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(toast.danger).toHaveBeenCalledWith("Could not start Remote Desktop", { description: "The Windows session disconnected." });
  });

  it("opens with no Sliver configuration and submits a direct connection while clearing password entry", async () => {
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect to a computer" }));
    await user.type(screen.getByLabelText("Computer"), "desktop.test");
    await user.type(screen.getByLabelText("Username"), "operator");
    await user.type(screen.getByLabelText("Password"), "test-password");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(connectedInput).toMatchObject({ host: "desktop.test", port: 3389, username: "operator", password: "test-password", persistence: "none", clipboard: true });
    expect(api.saveProfile).not.toHaveBeenCalled();
    expect(await screen.findByLabelText("Remote desktop for desktop.test")).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("saves only profile metadata, then associates remembered credentials with the selected profile", async () => {
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect to a computer" }));
    await user.type(screen.getByLabelText("Computer"), "desktop.test");
    await user.type(screen.getByLabelText("Username"), "operator");
    await user.type(screen.getByLabelText("Password"), "private-input");
    await user.click(screen.getByRole("button", { name: "Remember password" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Save securely on this device" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ host: "desktop.test", username: "operator" }));
    expect(vi.mocked(api.saveProfile).mock.calls[0]?.[0]).not.toHaveProperty("password");
    expect(connectedInput).toMatchObject({ profileId: "saved", persistence: "secure", password: "private-input" });
  });

  it("connects a saved card immediately using its credential without opening a form", async () => {
    state = { ...state, profiles: [profile] };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect to Saved desktop" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(connectedInput).toEqual({ profileId: "saved", label: "Saved desktop", host: "saved.test", port: 3390,
      username: "admin", domain: "", width: 1920, height: 1080, clipboard: false, scaleMode: "fit", persistence: "secure" });
    expect(api.saveProfile).not.toHaveBeenCalled();
    expect(await screen.findByLabelText("Remote desktop for Saved desktop")).toBeInTheDocument();
  });

  it("opens a remote-screen profile immediately without asking for or sending credentials", async () => {
    state = { ...state, profiles: [{ ...profile, signInMode: "remote-screen", username: "", domain: "", hasCredential: false, credentialPersistence: "none" }] };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    expect(await screen.findByText("Sign in on the remote screen")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect to Saved desktop" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(connectedInput).toMatchObject({ profileId: profile.id, signInMode: "remote-screen", username: "", domain: "", persistence: "none" });
    expect(connectedInput).not.toHaveProperty("password");
    expect(api.saveProfile).not.toHaveBeenCalled();
  });

  it.each(["nla", "remote-screen"] as const)("reconnects a %s tab with the appropriate credential flow", async (signInMode) => {
    state = { ...state, tabs: [{ ...firstTab, signInMode, state: "disconnected" }], activeTabId: firstTab.id };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Reconnect" }));
    if (signInMode === "remote-screen") {
      await waitFor(() => expect(api.reconnect).toHaveBeenCalledExactlyOnceWith({ tabId: firstTab.id }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("dialog", { name: "Reconnect to Remote Desktop" })).toBeInTheDocument();
      expect(api.reconnect).not.toHaveBeenCalled();
    }
  });

  it("shows saved frames beside first-session placeholders and opens cards with the keyboard", async () => {
    const preview = { dataUrl: "data:image/jpeg;base64,/9j/2Q==", width: 480, height: 270, capturedAt: "2026-10-19T12:00:00Z" };
    state = { ...state, profiles: [{ ...profile, domain: "LAB", preview }, { ...profile, id: "new", label: "New desktop" }] };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    const saved = await screen.findByRole("region", { name: "Saved profiles" });
    expect(within(saved).getByRole("img", { name: "Last saved desktop for Saved desktop" })).toHaveAttribute("src", preview.dataUrl);
    expect(within(saved).getByText("LAB\\admin")).toBeInTheDocument();
    expect(within(saved).getByText("No preview yet")).toBeInTheDocument();
    expect(screen.queryByText("Your Windows desktops")).not.toBeInTheDocument();
    const card = within(saved).getByRole("button", { name: "Connect to Saved desktop" });
    card.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(connectedInput).toMatchObject({ profileId: "saved", host: "saved.test", domain: "LAB" });
    expect(connectedInput).not.toHaveProperty("preview");
    expect(connectedInput).not.toHaveProperty("hasCredential");
  });

  it("opens the full editor only from Edit and keeps context-menu Connect direct", async () => {
    state = { ...state, profiles: [profile] };
    const user = userEvent.setup();
    const { contextMenu } = renderWithApplicationContextMenu(<RdpWindowApp />);
    const card = await screen.findByRole("button", { name: "Connect to Saved desktop" });
    fireEvent.contextMenu(card);
    contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    expect(await screen.findByRole("dialog", { name: "Edit Remote Desktop" })).toBeInTheDocument();
    expect(screen.getByLabelText("Computer")).toHaveValue("saved.test");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(api.connect).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.contextMenu(card);
    contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks only for a missing password and clears it after an unsuccessful connection", async () => {
    state = { ...state, profiles: [{ ...profile, hasCredential: false, credentialPersistence: "none" }] };
    vi.mocked(api.connect).mockImplementationOnce(async (input) => {
      connectedInput = { ...input };
      return { ok: false, error: "The remote desktop could not be reached." };
    });
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect to Saved desktop" }));
    const prompt = screen.getByRole("dialog", { name: "Connect to Saved desktop" });
    expect(within(prompt).queryByLabelText("Computer")).not.toBeInTheDocument();
    expect(within(prompt).getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(api.connect).not.toHaveBeenCalled();
    await user.type(within(prompt).getByLabelText("Password"), "temporary-password");
    fireEvent.change(within(prompt).getByLabelText("Remember password"), { target: { value: "session" } });
    await user.click(within(prompt).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(connectedInput).toMatchObject({ profileId: "saved", password: "temporary-password", persistence: "session" });
    expect(vi.mocked(api.connect).mock.calls[0]?.[0]).not.toHaveProperty("password");
    expect(within(prompt).getByLabelText("Password")).toHaveValue("");
    expect(await within(prompt).findByRole("alert")).toHaveTextContent("could not be reached");
    await user.type(within(prompt).getByLabelText("Password"), "retry-password");
    await user.click(within(prompt).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(connectedInput).toMatchObject({ password: "retry-password", profileId: "saved" });
  });

  it("allows canceling password entry and avoids unavailable secure storage", async () => {
    state = { ...state, profiles: [profile], securePersistenceAvailable: false };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect to Saved desktop" }));
    const prompt = screen.getByRole("dialog", { name: "Connect to Saved desktop" });
    expect(within(prompt).getByLabelText("Remember password")).toHaveValue("none");
    expect(within(prompt).getByRole("option", { name: "Save securely on this device" })).toBeDisabled();
    await user.type(within(prompt).getByLabelText("Password"), "discarded-password");
    await user.click(within(prompt).getByRole("button", { name: "Cancel" }));
    expect(api.connect).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Connect to Saved desktop" }));
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("submits only one direct connection while the first click is pending", async () => {
    state = { ...state, profiles: [profile] };
    let finish!: (result: Awaited<ReturnType<RdpWindowAPI["connect"]>>) => void;
    vi.mocked(api.connect).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    const card = await screen.findByRole("button", { name: "Connect to Saved desktop" });
    await user.dblClick(card);
    expect(api.connect).toHaveBeenCalledOnce();
    expect(card).toHaveAttribute("aria-disabled", "true");
    await act(async () => finish({ ok: false, error: "Connection canceled" }));
    expect(card).not.toHaveAttribute("aria-disabled", "true");
    expect(toast.danger).toHaveBeenCalledWith("Remote Desktop action failed", { description: "Connection canceled" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("deletes a preview card only after confirmation without opening a connection", async () => {
    state = { ...state, profiles: [profile] };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Delete Saved desktop" }));
    expect(screen.getByRole("dialog", { name: "Delete Profile" })).toHaveTextContent("saved preview");
    expect(api.deleteProfile).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Edit Remote Desktop" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete profile" }));
    await waitFor(() => expect(api.deleteProfile).toHaveBeenCalledWith("saved"));
    expect(api.connect).not.toHaveBeenCalled();
  });

  it("shows connection status in the gallery and respects the session limit", async () => {
    state = { ...state, profiles: [profile], tabs: [{ ...firstTab, ...profile, id: firstTab.id, profileId: profile.id }], activeTabId: firstTab.id, maxSessions: 1 };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Saved profiles" }));
    const gallery = screen.getByRole("dialog", { name: "Saved Connections" });
    expect(within(gallery).getByText("Connected")).toBeInTheDocument();
    const card = within(gallery).getByRole("button", { name: "Connect to Saved desktop" });
    expect(card).toHaveAttribute("aria-disabled", "true");
    await user.click(card);
    expect(api.connect).not.toHaveBeenCalled();
    expect(within(gallery).getByRole("button", { name: "Delete Saved desktop" })).toBeEnabled();
    expect(screen.getByLabelText("Remote desktop for Saved desktop")).toHaveAttribute("data-input-enabled", "false");
    await act(async () => { listener?.({ ...state, profiles: [{ ...profile, host: "replacement.test" }] }); });
    expect(within(gallery).queryByText("Connected")).not.toBeInTheDocument();
  });

  it("keeps secure persistence unavailable when the host cannot encrypt secrets", async () => {
    state = { ...state, securePersistenceAvailable: false };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect to a computer" }));
    await user.click(screen.getByRole("button", { name: "Remember password" }));
    expect(screen.getByRole("menuitemradio", { name: "Save securely on this device" })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await user.type(screen.getByLabelText("Computer"), "https://not-a-host");
    await user.type(screen.getByLabelText("Username"), "operator");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByLabelText("Computer")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Computer")).toHaveAccessibleDescription(/without a scheme, path, or port/u);
    expect(api.connect).not.toHaveBeenCalled();
  });

  it("keeps certificate decisions explicit and disables override for hard failures", async () => {
    state = { ...state, tabs: [{ ...firstTab, state: "certificate-review", review: { token: "review", host: firstTab.host, port: 3389, fingerprint: "SHA256:reviewed", subject: "CN=office.test", issuer: "CN=office.test", validFrom: "2026-01-01", validTo: "2027-01-01", reason: "Invalid signature", canOverride: false, expiresAt: "2026-12-01" } }], activeTabId: "first" };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    expect(await screen.findByRole("heading", { name: "Review Server Certificate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trust once" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Trust and remember" })).toBeDisabled();
    expect(screen.getByText("SHA256:reviewed")).toBeInTheDocument();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel connection" }));
    expect(api.respondToCertificate).toHaveBeenCalledWith({ token: "review", decision: "reject" });
  });

  it("targets clipboard actions at the selected tab and suspends desktop input for dialogs", async () => {
    state = { ...state, tabs: [firstTab, { ...firstTab, id: "second", label: "Lab" }], activeTabId: "first" };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("tab", { name: "Lab" }));
    await user.click(screen.getByRole("button", { name: "Send clipboard" }));
    expect(api.clipboard).toHaveBeenCalledWith({ tabId: "second", direction: "send" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Configuration" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Configuration" }));
    expect(screen.getByLabelText("Remote desktop for Lab")).toHaveAttribute("data-input-enabled", "false");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByLabelText("Remote desktop for Lab")).toHaveAttribute("data-input-enabled", "true");
  });

  it("allows the first clipboard send when the channel is ready before remote text exists", async () => {
    state = { ...state, tabs: [{ ...firstTab, clipboardAvailable: false }], activeTabId: firstTab.id };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Send clipboard" }));
    expect(api.clipboard).toHaveBeenCalledWith({ tabId: firstTab.id, direction: "send" });
    expect(screen.getByRole("button", { name: "Receive clipboard" })).toBeDisabled();
  });

  it("receives an advertised file clipboard without an advertised text format", async () => {
    state = { ...state, tabs: [{ ...firstTab, clipboardAvailable: false, clipboardFilesAvailable: true, clipboardFilesSupported: true }], activeTabId: firstTab.id };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    const receive = await screen.findByRole("button", { name: "Receive clipboard" });
    expect(receive).toBeEnabled();
    await user.click(receive);
    expect(api.clipboard).toHaveBeenCalledWith({ tabId: firstTab.id, direction: "receive" });
    expect(toast.success).not.toHaveBeenCalled();
    await act(async () => { listener?.({ ...state, tabs: [{ ...state.tabs[0]!, clipboard: false }] }); });
    expect(receive).toBeDisabled();
  });

  it.each(["completed", "failed"] as const)("uses the file transfer outcome instead of duplicate manual %s feedback", async (phase) => {
    state = { ...state, tabs: [{ ...firstTab, clipboardAvailable: false, clipboardFilesAvailable: true }], activeTabId: firstTab.id };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    const receive = await screen.findByRole("button", { name: "Receive clipboard" });
    vi.mocked(api.clipboard).mockImplementation(async () => {
      const progress = { id: "receive-files", direction: "receive" as const, phase, transferredBytes: phase === "completed" ? 4 : 0,
        totalBytes: 4, completedFiles: phase === "completed" ? 1 : 0, totalFiles: 1, ...(phase === "failed" ? { error: "File read failed" } : {}) };
      state = { ...state, tabs: [{ ...state.tabs[0]!, fileTransfer: progress }] };
      progressListener?.({ tabId: firstTab.id, attempt: firstTab.attempt, progress });
      return phase === "completed" ? { ok: true } : { ok: false, error: "File read failed" };
    });
    await user.click(receive);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.danger).not.toHaveBeenCalled();
    expect(toast.getQueue().visibleToasts).toHaveLength(1);
    expect(toast.getQueue().visibleToasts[0]!.content.title).toBe(phase === "completed" ? "Files received" : "File transfer failed");
  });

  it("ignores file progress from an earlier connection attempt", async () => {
    state = { ...state, tabs: [firstTab], activeTabId: firstTab.id };
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await screen.findByRole("tab", { name: "Office" });
    await act(async () => { progressListener?.({ tabId: firstTab.id, attempt: firstTab.attempt - 1,
      progress: { id: "old-copy", direction: "send", phase: "transferring", transferredBytes: 2, totalBytes: 4, completedFiles: 0, totalFiles: 1 } }); });
    expect(toast.getQueue().visibleToasts).toHaveLength(0);
  });

  it("skips the clipboard-ready notice when file sending has already started", async () => {
    state = { ...state, tabs: [firstTab], activeTabId: firstTab.id };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    const send = await screen.findByRole("button", { name: "Send clipboard" });
    vi.mocked(api.clipboard).mockImplementation(async () => {
      const progress = { id: "fast-send", direction: "send" as const, phase: "transferring" as const,
        transferredBytes: 2, totalBytes: 4, completedFiles: 0, totalFiles: 1 };
      state = { ...state, tabs: [{ ...firstTab, fileTransfer: progress }] };
      progressListener?.({ tabId: firstTab.id, attempt: firstTab.attempt, progress });
      return { ok: true };
    });
    await user.click(send);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.getQueue().visibleToasts[0]!.content.title).toBe("Sending files");
  });

  it("keeps compact file progress ahead of older snapshots without replacing the desktop", async () => {
    state = { ...state, tabs: [firstTab], activeTabId: firstTab.id };
    renderWithApplicationContextMenu(<><RdpWindowApp /><Toast.Provider placement="bottom" /></>);
    const desktop = await screen.findByLabelText("Remote desktop for Office");
    const progress = { id: "current-copy", direction: "receive" as const, phase: "transferring" as const,
      transferredBytes: 512, totalBytes: 1024, completedFiles: 0, totalFiles: 1 };
    await act(async () => { progressListener?.({ tabId: firstTab.id, attempt: firstTab.attempt, progress }); });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    await act(async () => { listener?.({ ...state, tabs: [{ ...firstTab, fileTransfer: { ...progress, phase: "preparing", transferredBytes: 0 } }] }); });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    await act(async () => { progressListener?.({ tabId: firstTab.id, attempt: firstTab.attempt,
      progress: { ...progress, phase: "completed", transferredBytes: 1024, completedFiles: 1 } }); });
    expect(await screen.findByText("Files received")).toBeInTheDocument();
    await act(async () => { listener?.({ ...state, tabs: [{ ...firstTab, fileTransfer: progress }] }); });
    expect(screen.getByText("Files received")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Remote desktop for Office")).toBe(desktop);
  });

  it("uses icon-only clipboard actions with tooltips for both directions", async () => {
    state = { ...state, tabs: [firstTab], activeTabId: firstTab.id };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    for (const label of ["Send clipboard", "Receive clipboard"]) {
      const button = await screen.findByRole("button", { name: label });
      expect(button.textContent).toBe("");
      expect(button.querySelector("svg")).toBeInTheDocument();
      await user.hover(button);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(label);
      await user.unhover(button);
      await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    }
  });

  it("defaults transparent clipboard off and saves it independently of the connection clipboard preference", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getApplicationSettings).mockResolvedValue({ ...DEFAULT_APPLICATION_SETTINGS_STATE,
      rdp: { clipboard: false, transparentClipboard: false } });
    renderWithApplicationContextMenu(<ApplicationSettingsProvider api={api}><RdpWindowApp /></ApplicationSettingsProvider>);
    await user.click(await screen.findByRole("button", { name: "Configuration" }));
    const toggle = screen.getByRole("switch", { name: "Transparent clipboard" });
    expect(toggle).not.toBeChecked();
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(api.updateApplicationSettings).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ rdp: { clipboard: false, transparentClipboard: true } }),
    }));
    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(api.updateApplicationSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ rdp: { clipboard: false, transparentClipboard: false } }),
    }));
  });

  it("keeps transparent clipboard off if its settings update fails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateApplicationSettings).mockResolvedValue({ ok: false, error: "Settings could not be saved." });
    renderWithApplicationContextMenu(<ApplicationSettingsProvider api={api}><RdpWindowApp /></ApplicationSettingsProvider>);
    await user.click(await screen.findByRole("button", { name: "Configuration" }));
    const toggle = screen.getByRole("switch", { name: "Transparent clipboard" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    await waitFor(() => expect(api.updateApplicationSettings).toHaveBeenCalledOnce());
    expect(toggle).not.toBeChecked();
    expect(toast.danger).toHaveBeenCalledWith("Settings not saved", expect.anything());
  });

  it("shows clipboard success and repeated operation failures as toasts without adding desktop banners", async () => {
    state = { ...state, tabs: [firstTab], activeTabId: firstTab.id };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    const desktop = await screen.findByLabelText("Remote desktop for Office");
    const main = screen.getByRole("main", { name: "Remote Desktop" });
    const children = Array.from(main.children);
    await user.click(screen.getByRole("button", { name: "Send clipboard" }));
    expect(toast.success).toHaveBeenCalledWith("Clipboard ready to paste on the remote desktop.");
    await user.click(screen.getByRole("button", { name: "Receive clipboard" }));
    expect(toast.success).toHaveBeenCalledWith("Remote content copied to the clipboard.");
    vi.mocked(api.clipboard).mockResolvedValue({ ok: false, error: "Remote clipboard timed out." });
    await user.click(screen.getByRole("button", { name: "Receive clipboard" }));
    await user.click(screen.getByRole("button", { name: "Receive clipboard" }));
    expect(toast.danger).toHaveBeenCalledTimes(2);
    expect(toast.danger).toHaveBeenLastCalledWith("Remote Desktop action failed", { description: "Remote clipboard timed out." });
    expect(Array.from(main.children)).toEqual(children);
    expect(screen.getByLabelText("Remote desktop for Office")).toBe(desktop);
    expect(within(main).queryByText("Clipboard ready to paste on the remote desktop.")).not.toBeInTheDocument();
    expect(within(main).queryByText("Remote clipboard timed out.")).not.toBeInTheDocument();
    await act(async () => { listener?.({ ...state, tabs: [{ ...firstTab, state: "disconnected" }] }); });
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(within(screen.getByRole("dialog", { name: "Reconnect to Remote Desktop" })).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("announces each active session warning once across repeated updates and tab switches", async () => {
    const warning = "The requested desktop size was not accepted.";
    const warnedTab = { ...firstTab, error: warning };
    state = { ...state, tabs: [warnedTab, { ...firstTab, id: "second", label: "Lab" }], activeTabId: firstTab.id };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await screen.findByRole("tab", { name: "Office" });
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith("Remote Desktop warning", { description: warning });
    await act(async () => { listener?.({ ...state, tabs: [...state.tabs] }); });
    await user.click(screen.getByRole("tab", { name: "Lab" }));
    await user.click(screen.getByRole("tab", { name: "Office" }));
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    await act(async () => { listener?.({ ...state, tabs: [{ ...warnedTab, attempt: 2 }] }); });
    expect(toast.warning).toHaveBeenCalledTimes(2);
    await act(async () => { listener?.({ ...state, tabs: [{ ...firstTab, attempt: 2 }] }); });
    await act(async () => { listener?.({ ...state, tabs: [{ ...warnedTab, attempt: 2 }] }); });
    expect(toast.warning).toHaveBeenCalledTimes(3);
  });

  it("enables high-DPI scaling alongside automatic resize and shares the setting across desktop tabs", async () => {
    state = { ...state, tabs: [firstTab, { ...firstTab, id: "second", label: "Lab" }], activeTabId: firstTab.id };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Configuration" }));
    const automatic = screen.getByRole("switch", { name: "Resize desktop with window" });
    const highDpi = screen.getByRole("switch", { name: "Scale desktop for high-DPI displays" });
    expect(highDpi).not.toBeChecked();
    expect(highDpi).toBeDisabled();
    await user.click(automatic);
    expect(highDpi).toBeEnabled();
    await user.click(highDpi);
    expect(screen.getByLabelText("Remote desktop for Office")).toHaveAttribute("data-auto-resize", "true");
    expect(screen.getByLabelText("Remote desktop for Office")).toHaveAttribute("data-high-dpi", "true");
    expect(screen.getByLabelText("Remote desktop for Lab")).toHaveAttribute("data-high-dpi", "true");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("tab", { name: "Lab" }));
    await user.click(screen.getByRole("button", { name: "Configuration" }));
    expect(screen.getByRole("switch", { name: "Scale desktop for high-DPI displays" })).toBeChecked();
    await user.click(screen.getByRole("switch", { name: "Resize desktop with window" }));
    expect(screen.getByRole("switch", { name: "Scale desktop for high-DPI displays" })).toBeDisabled();
    expect(screen.getByLabelText("Remote desktop for Lab")).toHaveAttribute("data-auto-resize", "false");
  });

  it("uses a fresh state event when initialization finishes after it", async () => {
    let finish: ((value: Awaited<ReturnType<RdpWindowAPI["getState"]>>) => void) | undefined;
    vi.mocked(api.getState).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await act(async () => { listener?.({ ...state, tabs: [firstTab], activeTabId: firstTab.id }); });
    await act(async () => { finish?.({ ok: true as const, value: state }); });
    expect(screen.getByRole("tab", { name: "Office" })).toBeInTheDocument();
  });
});
