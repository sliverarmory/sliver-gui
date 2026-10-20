import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../shared/application-settings-contracts";
import type { RdpConnectInput, RdpProfile, RdpTab, RdpWindowAPI, RdpWindowState } from "../../shared/rdp-contracts";
import { renderWithApplicationContextMenu } from "./application-context-menu-test-utils";

vi.mock("./components/rdp/RdpDesktop", async () => {
  const React = await import("react");
  return {
    RdpDesktop: React.forwardRef((props: { tab: RdpTab; active: boolean; inputEnabled: boolean }, ref) => {
      React.useImperativeHandle(ref, () => ({ release: vi.fn(), focus: vi.fn(), specialKey: vi.fn(), resizeToWindow: vi.fn() }));
      return <section aria-label={`Remote desktop for ${props.tab.label}`} data-active={props.active} data-input-enabled={props.inputEnabled} />;
    }),
    phaseLabel: (state: string) => state,
  };
});

import { RdpWindowApp } from "./RdpWindowApp";

const firstTab: RdpTab = { id: "first", attempt: 1, label: "Office", host: "office.test", port: 3389, username: "operator", domain: "LAB",
  width: 1280, height: 800, clipboard: true, clipboardReady: true, clipboardAvailable: true, scaleMode: "fit", state: "active" };
const profile: RdpProfile = { id: "saved", label: "Saved desktop", host: "saved.test", port: 3390, username: "admin", domain: "",
  width: 1920, height: 1080, clipboard: false, scaleMode: "fit", hasCredential: true, credentialPersistence: "secure" };
let state: RdpWindowState;
let api: RdpWindowAPI;
let listener: ((value: RdpWindowState) => void) | undefined;
let connectedInput: RdpConnectInput | undefined;

beforeEach(() => {
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  state = { tabs: [], profiles: [], securePersistenceAvailable: true, maxSessions: 4 };
  connectedInput = undefined;
  listener = undefined;
  api = {
    getState: vi.fn(async () => ({ ok: true as const, value: state })),
    connect: vi.fn(async (input) => { connectedInput = { ...input }; const tab = { ...firstTab, ...input, password: undefined }; state = { ...state, tabs: [tab], activeTabId: tab.id }; listener?.(state); return { ok: true as const, value: tab }; }),
    reconnect: vi.fn(async () => ({ ok: true as const, value: firstTab })),
    disconnect: vi.fn(async () => ({ ok: true as const })), closeTab: vi.fn(async () => ({ ok: true as const })),
    selectTab: vi.fn(async (tabId) => { state = { ...state, activeTabId: tabId }; listener?.(state); return { ok: true as const }; }),
    renameTab: vi.fn(async () => ({ ok: true as const })),
    saveProfile: vi.fn(async (input) => { const saved = { ...profile, ...input }; state = { ...state, profiles: [saved] }; listener?.(state); return { ok: true as const, value: saved }; }),
    deleteProfile: vi.fn(async () => ({ ok: true as const })), respondToCertificate: vi.fn(async () => ({ ok: true as const })),
    attach: vi.fn(async () => ({ ok: true as const, value: { tabId: "first", attempt: 1, attachmentToken: "token" } })),
    openRdpStream: vi.fn(), clipboard: vi.fn(async () => ({ ok: true as const })), setInputCapture: vi.fn(async () => ({ ok: true as const })), toggleFullscreen: vi.fn(async () => ({ ok: true as const })),
    getApplicationSettings: vi.fn(async () => DEFAULT_APPLICATION_SETTINGS_STATE),
    onStateChanged: vi.fn((next) => { listener = next; return () => { listener = undefined; }; }),
    onApplicationSettingsChanged: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "rdp", { configurable: true, value: api });
});
afterEach(() => { cleanup(); delete window.rdp; Reflect.deleteProperty(Element.prototype, "getAnimations"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("standalone remote desktop window", () => {
  it("opens with no Sliver configuration and submits a direct connection while clearing password entry", async () => {
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect to a computer" }));
    await user.type(screen.getByLabelText("Computer"), "desktop.test");
    await user.type(screen.getByLabelText("Username"), "operator");
    await user.type(screen.getByLabelText("Password"), "test-password");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(connectedInput).toMatchObject({ host: "desktop.test", port: 3389, username: "operator", password: "test-password", persistence: "none", clipboard: false });
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
    fireEvent.change(screen.getByLabelText("Remember password"), { target: { value: "secure" } });
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ host: "desktop.test", username: "operator" }));
    expect(vi.mocked(api.saveProfile).mock.calls[0]?.[0]).not.toHaveProperty("password");
    expect(connectedInput).toMatchObject({ profileId: "saved", persistence: "secure", password: "private-input" });
  });

  it("reuses a saved credential without returning it to the form", async () => {
    state = { ...state, profiles: [profile] };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect" }));
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Computer")).toHaveValue("saved.test");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(connectedInput).not.toHaveProperty("password");
    expect(connectedInput?.profileId).toBe("saved");
  });

  it("keeps secure persistence unavailable when the host cannot encrypt secrets", async () => {
    state = { ...state, securePersistenceAvailable: false };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Connect to a computer" }));
    expect(screen.getByRole("option", { name: "Save securely on this device" })).toBeDisabled();
    await user.type(screen.getByLabelText("Computer"), "https://not-a-host");
    await user.type(screen.getByLabelText("Username"), "operator");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("without a scheme or path");
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
    await user.click(screen.getByRole("button", { name: "Send clipboard text" }));
    expect(api.clipboard).toHaveBeenCalledWith({ tabId: "second", direction: "send" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Display settings" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Display settings" }));
    expect(screen.getByLabelText("Remote desktop for Lab")).toHaveAttribute("data-input-enabled", "false");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByLabelText("Remote desktop for Lab")).toHaveAttribute("data-input-enabled", "true");
  });

  it("allows the first clipboard send when the channel is ready before remote text exists", async () => {
    state = { ...state, tabs: [{ ...firstTab, clipboardAvailable: false }], activeTabId: firstTab.id };
    const user = userEvent.setup();
    renderWithApplicationContextMenu(<RdpWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Send clipboard text" }));
    expect(api.clipboard).toHaveBeenCalledWith({ tabId: firstTab.id, direction: "send" });
    expect(screen.getByRole("button", { name: "Receive clipboard" })).toBeDisabled();
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
