import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@heroui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpConnectInput, RdpPendingConnection, RdpProfile, RdpSaveProfileInput, RdpSocks5Proxy, RdpTab, RdpWindowAPI } from "../../../../shared/rdp-contracts";
import { DEFAULT_APPLICATION_SETTINGS_STATE, type ApplicationSettingsState, type ApplicationSettingsUpdateInput } from "../../../../shared/application-settings-contracts";
import { ApplicationSettingsProvider, type ApplicationSettingsAPI } from "../ApplicationSettingsProvider";
import { RdpConnectDialog } from "./RdpConnectDialog";

const profile: RdpProfile = {
  id: "saved-desktop", label: "Office", host: "office.test", port: 3389, username: "operator", domain: "LAB",
  width: 1920, height: 1080, clipboard: false, scaleMode: "fit", hasCredential: false, credentialPersistence: "none",
};
const proxy: RdpSocks5Proxy = { id: "socks5-proxy-one", label: "Workstation", host: "127.0.0.1", port: 1080, authentication: "username-password", available: true };
const session = { id: "live-session-one", sessionId: "11111111-1111-4111-8111-111111111111", label: "Workstation (operator)", hostname: "workstation.test" };
const autoProxy: RdpSocks5Proxy = { ...proxy, label: "Lab server · workstation.test", viaSessionId: session.id };
const manualRoute = { kind: "socks5-manual" as const, host: "proxy.test", port: 1080, username: "proxy-user" };
let api: RdpWindowAPI;
let connectedInput: RdpConnectInput | undefined;
let onConnected = vi.fn<(tabId: string) => void>();
let onProfileSaved = vi.fn<() => void>();

beforeEach(() => {
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  connectedInput = undefined;
  onConnected = vi.fn<(tabId: string) => void>();
  onProfileSaved = vi.fn<() => void>();
  api = {
    connect: vi.fn(async (input: RdpConnectInput) => {
      // The production bridge copies before the form deletes its password field.
      connectedInput = { ...input };
      const tab: RdpTab = { ...profile, ...input, id: "connected-desktop", attempt: 1, state: "connecting",
        clipboardReady: false, clipboardAvailable: false };
      return { ok: true as const, value: tab };
    }),
    saveProfile: vi.fn(async (input: RdpSaveProfileInput) => ({ ok: true as const, value: { ...profile, ...input } })),
    cancelTemporary: vi.fn(async () => ({ ok: true as const })),
    openNetworkManager: vi.fn(async () => ({ ok: true as const })),
    startSessionProxy: vi.fn(async (id: string) => ({ ok: true as const, value: { ...autoProxy, viaSessionId: id } })),
  } as unknown as RdpWindowAPI;
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(initial?: RdpProfile): void {
  render(<RdpConnectDialog api={api} initial={initial} securePersistenceAvailable
    onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
}

function change(label: string, value: string): HTMLElement {
  const field = screen.getByLabelText(label);
  fireEvent.change(field, { target: { value } });
  return field;
}

async function chooseRoute(user: ReturnType<typeof userEvent.setup>, value: string): Promise<void> {
  if (!screen.queryByRole("menu", { name: "Connection route" })) await user.click(screen.getByRole("button", { name: "Connection route" }));
  const menu = await screen.findByRole("menu", { name: "Connection route" });
  const item = within(menu).getAllByRole("menuitemradio").find((candidate) => candidate.getAttribute("data-route-value") === value);
  expect(item).toBeDefined();
  await user.click(item!);
}

async function chooseDropdown(user: ReturnType<typeof userEvent.setup>, label: string, value: string): Promise<void> {
  if (!screen.queryByRole("menu", { name: label })) await user.click(screen.getByRole("button", { name: label }));
  const menu = await screen.findByRole("menu", { name: label });
  const item = within(menu).getAllByRole("menuitemradio").find((candidate) => candidate.getAttribute("data-selected-value") === value);
  expect(item).toBeDefined();
  await user.click(item!);
}

function expectFieldError(label: string, text: RegExp): void {
  const field = screen.getByLabelText(label);
  expect(field).toHaveAttribute("aria-invalid", "true");
  expect(field).toHaveAccessibleDescription(text);
}

function routeItems(): HTMLElement[] { return within(screen.getByRole("menu", { name: "Connection route" })).getAllByRole("menuitemradio"); }

function routeValues(): (string | null)[] { return routeItems().map((item) => item.getAttribute("data-route-value")); }

describe("Remote Desktop connection form", () => {
  it("shows session hostnames without repeating a matching name or adding an empty hostname", async () => {
    const matching = { ...session, id: "matching", label: "WORKSTATION.TEST" };
    const unknown = { ...session, id: "unknown", label: "Unnamed host", hostname: "" };
    const user = userEvent.setup();
    render(<RdpConnectDialog api={api} initial={profile} socks5Sessions={[session, matching, unknown]} securePersistenceAvailable
      onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    await user.click(screen.getByRole("button", { name: "Networking" }));
    await user.click(screen.getByRole("button", { name: "Connection route" }));
    const choices = routeItems();
    expect(choices[2]).toHaveAccessibleName(new RegExp(`^Via Workstation \\(operator\\) · ${session.hostname}`, "u"));
    expect(choices[3]).toHaveAccessibleName(/^Via WORKSTATION.TESTSession ID:/u);
    expect(choices[4]).toHaveAccessibleName(/^Via Unnamed hostSession ID:/u);
    expect(choices[2]).toHaveAccessibleDescription(`Session ID: ${session.sessionId}`);
  });

  it("keeps the same menu choices through repeated Via switches and authoritative proxy updates", async () => {
    const other = { ...session, id: "second-session", label: "Other session", hostname: "second.test" };
    const secondProxy = { ...autoProxy, id: "auto-two", label: "Lab server · second.test", port: 42002, viaSessionId: other.id };
    const explicitProxy = { ...proxy, id: "network-manager-proxy", label: "Explicit proxy" };
    vi.mocked(api.startSessionProxy).mockImplementation(async (id) => ({ ok: true, value: id === session.id ? autoProxy : secondProxy }));
    const props = { api, initial: profile, socks5Sessions: [session, other], securePersistenceAvailable: true,
      onClose: vi.fn(), onConnected, onProfileSaved };
    const user = userEvent.setup(); const view = render(<RdpConnectDialog {...props} socks5Proxies={[explicitProxy]} />);
    await user.click(screen.getByRole("button", { name: "Networking" }));
    await user.click(screen.getByRole("button", { name: "Connection route" }));
    const originalValues = routeValues(); const originalLabels = routeItems().map((item) => item.textContent);
    expect(originalValues).toEqual(["", "manual", `session:${session.id}`, `session:${other.id}`, explicitProxy.id]);
    for (const chosen of [session, other, session]) {
      await chooseRoute(user, `session:${chosen.id}`);
      const selected = chosen.id === session.id ? autoProxy : secondProxy;
      const trigger = screen.getByRole("button", { name: "Connection route" });
      await waitFor(() => expect(trigger).toHaveAttribute("data-route-value", selected.id));
      expect(trigger).toHaveTextContent(`${selected.label} — ${selected.host}:${selected.port}`);
      view.rerender(<RdpConnectDialog {...props} socks5Proxies={[explicitProxy, autoProxy, secondProxy]} />);
      await user.click(trigger);
      expect(routeValues()).toEqual(originalValues);
      expect(routeItems().map((item) => item.textContent)).toEqual(originalLabels);
      expect(routeItems().find((item) => item.getAttribute("data-route-value") === `session:${chosen.id}`)).toHaveAttribute("aria-checked", "true");
      expect(routeItems().filter((item) => item.getAttribute("aria-checked") === "true")).toHaveLength(1);
    }
    await chooseRoute(user, explicitProxy.id);
    expect(api.startSessionProxy).toHaveBeenCalledTimes(3);
    change("Password", "explicit-proxy-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toHaveProperty("networking", { kind: "socks5", proxyId: explicitProxy.id }));
  });

  it("reopens a saved auto proxy with its endpoint displayed and its original Via choice checked", async () => {
    const explicitProxy = { ...proxy, id: "explicit-proxy" };
    const user = userEvent.setup();
    render(<RdpConnectDialog api={api} initial={{ ...profile, networking: { kind: "socks5", proxyId: autoProxy.id } }}
      socks5Sessions={[session]} socks5Proxies={[autoProxy, explicitProxy]} securePersistenceAvailable
      onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    const trigger = screen.getByRole("button", { name: "Connection route" });
    expect(trigger).toHaveTextContent(`${autoProxy.label} — ${autoProxy.host}:${autoProxy.port}`);
    expect(trigger).toHaveAttribute("data-route-value", autoProxy.id);
    await user.click(trigger);
    expect(routeValues()).toEqual(["", "manual", `session:${session.id}`, explicitProxy.id]);
    expect(routeItems()[2]).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Escape}");
    change("Password", "saved-route-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toHaveProperty("networking", { kind: "socks5", proxyId: autoProxy.id }));
    expect(api.startSessionProxy).not.toHaveBeenCalled();
  });

  it("preserves entered credentials and memory policy when selecting the already-checked available Via route", async () => {
    const user = userEvent.setup();
    render(<RdpConnectDialog api={api} initial={{ ...profile, networking: { kind: "socks5", proxyId: autoProxy.id } }}
      socks5Sessions={[session]} socks5Proxies={[autoProxy]} securePersistenceAvailable
      onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    change("Password", "keep-this-draft");
    await chooseDropdown(user, "Remember password", "session");
    await chooseRoute(user, `session:${session.id}`);
    expect(screen.getByLabelText("Password")).toHaveValue("keep-this-draft");
    expect(screen.getByRole("button", { name: "Remember password" })).toHaveAttribute("data-selected-value", "session");
    expect(screen.getByRole("button", { name: "Connection route" })).toHaveAttribute("data-route-value", autoProxy.id);
    expect(api.startSessionProxy).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled(); expect(api.saveProfile).not.toHaveBeenCalled();
  });

  it.each(["stopped", "removed", "session gone"] as const)("retains an unavailable %s auto proxy without adding a stale proxy option", async (availability) => {
    const props = { api, initial: { ...profile, networking: { kind: "socks5" as const, proxyId: autoProxy.id } },
      securePersistenceAvailable: true, onClose: vi.fn(), onConnected, onProfileSaved };
    const user = userEvent.setup(); const view = render(<RdpConnectDialog {...props} socks5Sessions={[session]} socks5Proxies={[autoProxy]} />);
    view.rerender(<RdpConnectDialog {...props} socks5Sessions={availability === "session gone" ? [] : [session]}
      socks5Proxies={availability === "removed" ? [] : [{ ...autoProxy, available: false }]} />);
    const trigger = screen.getByRole("button", { name: "Connection route" });
    expect(trigger).toHaveTextContent(`${autoProxy.label} — ${autoProxy.host}:${autoProxy.port} (unavailable)`);
    change("Password", "route-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("selected SOCKS5 proxy is unavailable");
    expect(api.connect).not.toHaveBeenCalled();
    await user.click(trigger);
    expect(routeValues()).toEqual(["", "manual", `session:${session.id}`]);
    expect(routeItems()[2]).toHaveAttribute("aria-checked", "true");
    if (availability === "session gone") expect(routeItems()[2]).toHaveAttribute("aria-disabled", "true");
    else {
      const replacement = { ...autoProxy, id: "new-auto-proxy", port: 42003 };
      vi.mocked(api.startSessionProxy).mockResolvedValue({ ok: true, value: replacement });
      await chooseRoute(user, `session:${session.id}`);
      expect(trigger).toHaveAttribute("data-route-value", replacement.id);
      expect(trigger).toHaveTextContent(`${replacement.label} — ${replacement.host}:${replacement.port}`);
      await user.click(trigger);
      expect(routeValues()).toEqual(["", "manual", `session:${session.id}`]);
    }
  });

  it("does not revive a proxy when inventory observes and removes it before the start response arrives", async () => {
    let finish!: (result: Awaited<ReturnType<RdpWindowAPI["startSessionProxy"]>>) => void;
    vi.mocked(api.startSessionProxy).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const props = { api, initial: profile, socks5Sessions: [session], securePersistenceAvailable: true,
      onClose: vi.fn(), onConnected, onProfileSaved };
    const user = userEvent.setup(); const view = render(<RdpConnectDialog {...props} />);
    await user.click(screen.getByRole("button", { name: "Networking" }));
    await chooseRoute(user, `session:${session.id}`);
    view.rerender(<RdpConnectDialog {...props} socks5Proxies={[autoProxy]} />);
    view.rerender(<RdpConnectDialog {...props} socks5Proxies={[]} />);
    await act(async () => { finish({ ok: true, value: autoProxy }); });
    const trigger = screen.getByRole("button", { name: "Connection route" });
    expect(trigger).toHaveTextContent(`${autoProxy.label} — ${autoProxy.host}:${autoProxy.port} (unavailable)`);
    change("Password", "route-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("selected SOCKS5 proxy is unavailable");
    expect(api.connect).not.toHaveBeenCalled();
    await user.click(trigger);
    expect(routeValues()).toEqual(["", "manual", `session:${session.id}`]);
    expect(routeItems()[2]).toHaveAttribute("aria-checked", "true");
  });

  it("keeps a failed switch to another Via session selected without restoring the previous auto proxy", async () => {
    const other = { ...session, id: "second-session", label: "Other", hostname: "other.test" };
    vi.mocked(api.startSessionProxy).mockResolvedValue({ ok: false, error: "The session disconnected." });
    const user = userEvent.setup();
    render(<RdpConnectDialog api={api} initial={{ ...profile, networking: { kind: "socks5", proxyId: autoProxy.id } }}
      socks5Sessions={[session, other]} socks5Proxies={[autoProxy]} securePersistenceAvailable
      onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    await chooseRoute(user, `session:${other.id}`);
    expect(await screen.findByRole("alert")).toHaveTextContent("The session disconnected.");
    const trigger = screen.getByRole("button", { name: "Connection route" });
    expect(trigger).toHaveAttribute("data-route-value", `session:${other.id}`);
    expect(trigger).toHaveTextContent(`Via ${other.label} · ${other.hostname}`);
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
    await user.click(trigger);
    expect(routeValues()).toEqual(["", "manual", `session:${session.id}`, `session:${other.id}`]);
    expect(routeItems()[3]).toHaveAttribute("aria-checked", "true");
  });

  it("changes password memory with Enter and Space without submitting an otherwise valid connection", async () => {
    const user = userEvent.setup(); mount(profile); change("Password", "ready-to-connect");
    const trigger = screen.getByRole("button", { name: "Remember password" });
    trigger.focus(); await user.keyboard("{Enter}");
    expect(await screen.findByRole("menuitemradio", { name: "Do not save" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(trigger).toHaveAttribute("data-selected-value", "session");
    trigger.focus(); await user.keyboard(" ");
    expect(await screen.findByRole("menuitemradio", { name: "Until the app quits" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Do not save" })).toHaveAttribute("aria-checked", "false");
    await user.keyboard("{Escape}");
    expect(api.connect).not.toHaveBeenCalled(); expect(api.saveProfile).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Password")).toHaveValue("ready-to-connect");
  });

  it("disables secure password memory when storage is unavailable and keeps session memory selectable", async () => {
    const user = userEvent.setup();
    render(<RdpConnectDialog api={api} initial={{ ...profile, hasCredential: true, credentialPersistence: "secure" }}
      securePersistenceAvailable={false} onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    const trigger = screen.getByRole("button", { name: "Remember password" });
    expect(trigger).toHaveAttribute("data-selected-value", "none");
    await user.click(trigger);
    const secure = screen.getByRole("menuitemradio", { name: "Save securely on this device" });
    expect(secure).toHaveAttribute("aria-disabled", "true");
    await user.click(secure);
    expect(trigger).toHaveAttribute("data-selected-value", "none");
    await user.click(screen.getByRole("menuitemradio", { name: "Until the app quits" }));
    expect(trigger).toHaveAttribute("data-selected-value", "session");
    expect(api.connect).not.toHaveBeenCalled(); expect(api.saveProfile).not.toHaveBeenCalled();
  });

  it("selects Custom with the keyboard without submitting and seeds unedited dimensions from each chosen preset", async () => {
    const user = userEvent.setup(); mount(profile); change("Password", "ready-to-connect");
    const trigger = screen.getByRole("button", { name: "Desktop resolution" });
    trigger.focus(); await user.keyboard(" ");
    expect(await screen.findByRole("menuitemradio", { name: "1920 × 1080" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{End}{Enter}");
    expect(trigger).toHaveAttribute("data-selected-value", "custom");
    expect(screen.getByLabelText("Desktop width")).toHaveValue("1920");
    expect(screen.getByLabelText("Desktop height")).toHaveValue("1080");
    await chooseDropdown(user, "Desktop resolution", "2560x1440");
    await chooseDropdown(user, "Desktop resolution", "custom");
    expect(screen.getByLabelText("Desktop width")).toHaveValue("2560");
    expect(screen.getByLabelText("Desktop height")).toHaveValue("1440");
    expect(api.connect).not.toHaveBeenCalled(); expect(api.saveProfile).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Password")).toHaveValue("ready-to-connect");
  });

  it("selects a route with the keyboard and marks only the current route checked", async () => {
    const user = userEvent.setup(); mount(profile);
    await user.click(screen.getByRole("button", { name: "Networking" }));
    const trigger = screen.getByRole("button", { name: "Connection route" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const direct = await screen.findByRole("menuitemradio", { name: "Direct" });
    expect(direct).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Manual SOCKS5" })).toHaveAttribute("aria-checked", "false");
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(trigger).toHaveAttribute("data-route-value", "manual"));
    expect(screen.getByLabelText("Proxy address")).toBeInTheDocument();
    await user.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: "Manual SOCKS5" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Direct" })).toHaveAttribute("aria-checked", "false");
  });

  it("disambiguates duplicate session labels with actual IDs while routing only by the opaque capability", async () => {
    const other = { ...session, id: "other-opaque-capability", sessionId: "22222222-2222-4222-8222-222222222222" };
    const user = userEvent.setup();
    render(<RdpConnectDialog api={api} initial={profile} socks5Sessions={[session, other]} securePersistenceAvailable
      onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    await user.click(screen.getByRole("button", { name: "Networking" }));
    await user.click(screen.getByRole("button", { name: "Connection route" }));
    const choices = screen.getAllByRole("menuitemradio", { name: (name) => name.startsWith(`Via ${session.label}`) });
    expect(choices).toHaveLength(2);
    expect(choices[0]).toHaveAccessibleDescription(`Session ID: ${session.sessionId}`);
    expect(choices[1]).toHaveAccessibleDescription(`Session ID: ${other.sessionId}`);
    expect(within(choices[0]!).getByText(`Session ID: ${session.sessionId}`)).toBeVisible();
    expect(within(choices[1]!).getByText(`Session ID: ${other.sessionId}`)).toBeVisible();
    await user.click(choices[1]!);
    expect(api.startSessionProxy).toHaveBeenCalledExactlyOnceWith(other.id);
    expect(api.startSessionProxy).not.toHaveBeenCalledWith(other.sessionId);
    await waitFor(() => expect(screen.getByRole("button", { name: "Connection route" })).toHaveAttribute("data-route-value", proxy.id));
  });

  it("creates a Via session proxy immediately and saves and connects through its returned ID before inventory catches up", async () => {
    const user = userEvent.setup();
    render(<RdpConnectDialog api={api} initial={profile} socks5Sessions={[session]} securePersistenceAvailable
      onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    await user.click(screen.getByRole("button", { name: "Networking" }));
    await user.click(screen.getByRole("button", { name: "Connection route" }));
    const via = screen.getByRole("menuitemradio", { name: (name) => name.startsWith(`Via ${session.label}`) });
    expect(via).toHaveAttribute("data-route-value", `session:${session.id}`);
    expect(via).toHaveAccessibleDescription(`Session ID: ${session.sessionId}`);
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Use a SOCKS5 proxy created in Networking to reach this computer through a Sliver session.")).not.toBeInTheDocument();
    change("Connection name", "Unsaved connection"); change("Password", "old-route-secret");
    await chooseRoute(user, `session:${session.id}`);
    expect(api.startSessionProxy).toHaveBeenCalledExactlyOnceWith(session.id);
    await waitFor(() => expect(screen.getByLabelText("Connection route")).toHaveAttribute("data-route-value", proxy.id));
    expect(screen.getByLabelText("Connection name")).toHaveValue("Unsaved connection");
    expect(screen.getByLabelText("Computer")).toHaveValue(profile.host);
    expect(screen.getByLabelText("Username")).toHaveValue(profile.username);
    expect(screen.getByLabelText("Password")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      label: "Unsaved connection", networking: { kind: "socks5", proxyId: proxy.id },
    })));
    expect(vi.mocked(api.saveProfile).mock.calls[0]![0]).not.toHaveProperty("sessionId");
    change("Password", "new-route-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ host: profile.host, profileId: profile.id,
      networking: { kind: "socks5", proxyId: proxy.id }, password: "new-route-secret" }));
    expect(api.startSessionProxy).toHaveBeenCalledOnce();
  });

  it("locks form changes, saving, connecting and closing while a session proxy is starting", async () => {
    let finish!: (result: Awaited<ReturnType<RdpWindowAPI["startSessionProxy"]>>) => void;
    vi.mocked(api.startSessionProxy).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const onClose = vi.fn(); const user = userEvent.setup();
    render(<RdpConnectDialog api={api} initial={profile} socks5Sessions={[session]} securePersistenceAvailable
      onClose={onClose} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    await user.click(screen.getByRole("button", { name: "Networking" }));
    await chooseRoute(user, `session:${session.id}`);
    expect(screen.getByRole("status")).toHaveTextContent("Starting SOCKS5 proxy");
    for (const label of ["Connection route", "Connection name", "Computer", "Username", "Password", "Remember password", "Desktop resolution"]) expect(screen.getByLabelText(label)).toBeDisabled();
    for (const name of ["Connect", "Save profile", "Cancel", "Open Network manager"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Connection route" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.submit(screen.getByLabelText("Computer").closest("form")!);
    expect(screen.getByLabelText("Connection route")).toHaveAttribute("data-route-value", `session:${session.id}`);
    expect(api.connect).not.toHaveBeenCalled(); expect(api.saveProfile).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    await act(async () => { finish({ ok: true, value: proxy }); });
    expect(screen.getByLabelText("Connection route")).toHaveAttribute("data-route-value", proxy.id);
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["rejected", "thrown", "unavailable"] as const)("keeps a %s session setup selected and blocks submission until an explicit route change", async (failure) => {
    if (failure === "rejected") vi.mocked(api.startSessionProxy).mockResolvedValue({ ok: false, error: "The Sliver session disconnected." });
    if (failure === "thrown") vi.mocked(api.startSessionProxy).mockRejectedValue(new Error("The Sliver session disconnected."));
    if (failure === "unavailable") vi.mocked(api.startSessionProxy).mockResolvedValue({ ok: true, value: { ...proxy, available: false } });
    const user = userEvent.setup();
    render(<RdpConnectDialog api={api} initial={profile} socks5Sessions={[session]} securePersistenceAvailable
      onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    await user.click(screen.getByRole("button", { name: "Networking" }));
    await chooseRoute(user, `session:${session.id}`);
    expect(await screen.findByRole("alert")).toHaveTextContent(failure === "unavailable" ? /proxy is unavailable/u : /session disconnected/u);
    expect(screen.getByLabelText("Connection route")).toHaveAttribute("data-route-value", `session:${session.id}`);
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
    change("Password", "new-secret"); fireEvent.submit(screen.getByLabelText("Computer").closest("form")!);
    expect(api.connect).not.toHaveBeenCalled(); expect(api.saveProfile).not.toHaveBeenCalled();
    await chooseRoute(user, "");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    change("Password", "direct-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(connectedInput).not.toHaveProperty("networking");
  });

  it.each(["stopped", "removed"] as const)("hands a created proxy's lifetime to inventory so a later %s proxy cannot remain usable", async (availability) => {
    const props = { api, initial: profile, socks5Sessions: [session], securePersistenceAvailable: true,
      onClose: vi.fn(), onConnected, onProfileSaved };
    const user = userEvent.setup(); const view = render(<RdpConnectDialog {...props} />);
    await user.click(screen.getByRole("button", { name: "Networking" }));
    await chooseRoute(user, `session:${session.id}`);
    await waitFor(() => expect(screen.getByLabelText("Connection route")).toHaveAttribute("data-route-value", proxy.id));
    view.rerender(<RdpConnectDialog {...props} socks5Proxies={[proxy]} />);
    view.rerender(<RdpConnectDialog {...props} socks5Proxies={availability === "removed" ? [] : [{ ...proxy, available: false }]} />);
    change("Password", "route-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("selected SOCKS5 proxy is unavailable");
    expect(screen.getByLabelText("Connection route")).toHaveAttribute("data-route-value", proxy.id);
    expect(api.connect).not.toHaveBeenCalled();
  });

  it("retains a disconnected session's failed option when the session leaves inventory", async () => {
    let finish!: (result: Awaited<ReturnType<RdpWindowAPI["startSessionProxy"]>>) => void;
    vi.mocked(api.startSessionProxy).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const props = { api, initial: profile, securePersistenceAvailable: true, onClose: vi.fn(), onConnected, onProfileSaved };
    const user = userEvent.setup(); const view = render(<RdpConnectDialog {...props} socks5Sessions={[session]} />);
    await user.click(screen.getByRole("button", { name: "Networking" }));
    await chooseRoute(user, `session:${session.id}`);
    view.rerender(<RdpConnectDialog {...props} socks5Sessions={[]} />);
    await act(async () => { finish({ ok: false, error: "The Sliver session disconnected." }); });
    expect(screen.getByLabelText("Connection route")).toHaveAttribute("data-route-value", `session:${session.id}`);
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Connection route" }));
    const unavailable = screen.getByRole("menuitemradio", { name: (name) => name.startsWith(`Via ${session.label} · ${session.hostname} (unavailable)`) });
    expect(unavailable).toHaveAttribute("aria-disabled", "true");
    expect(unavailable).toHaveAccessibleDescription(`Session ID: ${session.sessionId}`);
    expect(api.connect).not.toHaveBeenCalled();
  });

  it("keeps Direct and Manual SOCKS5 available without any Sliver sessions", async () => {
    const user = userEvent.setup(); mount();
    await user.click(screen.getByRole("button", { name: "Networking" }));
    expect(screen.getByLabelText("Connection route")).toHaveAttribute("data-route-value", "");
    await user.click(screen.getByRole("button", { name: "Connection route" }));
    expect(screen.getByRole("menuitemradio", { name: "Direct" })).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitemradio", { name: "Manual SOCKS5" })).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("menuitemradio", { name: /^Via /u })).not.toBeInTheDocument();
    expect(api.startSessionProxy).not.toHaveBeenCalled();
  });

  it("connects through a manual proxy without requiring a Sliver workspace or proxy authentication", async () => {
    const user = userEvent.setup(); mount(profile);
    await user.click(screen.getByRole("button", { name: "Networking" }));
    await chooseRoute(user, "manual");
    expect(screen.getByLabelText("Proxy port")).toHaveValue("1080");
    expect(screen.queryByLabelText("Proxy password")).not.toBeInTheDocument();
    change("Proxy address", "proxy.test"); change("Password", "rdp-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ networking: { kind: "socks5-manual", host: "proxy.test", port: 1080 }, password: "rdp-secret" }));
    expect(connectedInput?.networking).not.toHaveProperty("username");
    expect(connectedInput).not.toHaveProperty("proxyPassword");
    expect(connectedInput).not.toHaveProperty("profileId");
    expect(api.openNetworkManager).not.toHaveBeenCalled();
  });

  it("saves authenticated manual proxy metadata without a password and sends the password only when connecting", async () => {
    const user = userEvent.setup(); mount({ ...profile, networking: manualRoute });
    expect(screen.getByLabelText("Connection route")).toHaveAttribute("data-route-value", "manual");
    expect(screen.getByLabelText("Proxy password")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ id: profile.id, networking: manualRoute })));
    expect(vi.mocked(api.saveProfile).mock.calls[0]![0]).not.toHaveProperty("proxyPassword");
    change("Password", "rdp-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expectFieldError("Proxy password", /proxy password/u);
    expect(api.connect).not.toHaveBeenCalled();
    change("Proxy password", "proxy-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ profileId: profile.id, networking: manualRoute, password: "rdp-secret", proxyPassword: "proxy-secret" }));
    const retainedRequest = vi.mocked(api.connect).mock.calls[0]![0];
    expect(retainedRequest).not.toHaveProperty("password"); expect(retainedRequest).not.toHaveProperty("proxyPassword");
    expect(screen.getByLabelText("Password")).toHaveValue(""); expect(screen.getByLabelText("Proxy password")).toHaveValue("");
  });

  it("uses an unchanged saved RDP credential while asking for a fresh manual proxy password", async () => {
    const networking = { ...manualRoute, username: " proxy-user " };
    const user = userEvent.setup(); mount({ ...profile, networking, hasCredential: true, credentialPersistence: "secure" });
    expect(screen.getByLabelText("Password")).toHaveAttribute("placeholder", "Use saved credential");
    change("Proxy password", " proxy-secret ");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ profileId: profile.id, persistence: "secure", proxyPassword: " proxy-secret ", networking }));
    expect(connectedInput).not.toHaveProperty("password");
    expect(api.saveProfile).not.toHaveBeenCalled();
  });

  it("asks for a fresh RDP password when a manual profile's secure credential is unavailable", async () => {
    const user = userEvent.setup();
    render(<RdpConnectDialog api={api} initial={{ ...profile, networking: manualRoute, hasCredential: true, credentialPersistence: "secure" }}
      securePersistenceAvailable={false} onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    expect(screen.getByLabelText("Password")).not.toHaveAttribute("placeholder", "Use saved credential");
    change("Proxy password", "proxy-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expectFieldError("Password", /Windows account password/u);
    expect(api.connect).not.toHaveBeenCalled();
    change("Password", "rdp-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ profileId: profile.id, password: "rdp-secret", proxyPassword: "proxy-secret", persistence: "none" }));
  });

  it("requires the manual proxy password even when Windows sign-in happens on the remote screen", async () => {
    const user = userEvent.setup(); mount({ ...profile, networking: manualRoute, signInMode: "remote-screen", username: "", domain: "" });
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expectFieldError("Proxy password", /proxy password/u);
    change("Proxy password", "proxy-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ signInMode: "remote-screen", persistence: "none", username: "", domain: "", proxyPassword: "proxy-secret" }));
    expect(connectedInput).not.toHaveProperty("password");
  });

  it.each([
    ["Proxy address", "other-proxy.test"], ["Proxy port", "1081"], ["Proxy username", "other-proxy-user"],
    ["Username", "other-operator"], ["Domain", "OTHER"], ["Computer", "other-desktop.test"], ["Port", "3390"],
  ])("clears both password drafts when %s changes", (field, next) => {
    mount({ ...profile, networking: manualRoute, hasCredential: true, credentialPersistence: "secure" });
    change("Password", "rdp-secret"); change("Proxy password", "proxy-secret");
    change(field, next);
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Proxy password")).toHaveValue("");
    expect(screen.getByLabelText("Remember password")).toHaveAttribute("data-selected-value", "none");
    expect(screen.getByLabelText("Password")).not.toHaveAttribute("placeholder", "Use saved credential");
  });

  it("clears proxy secrets across route changes and Cancel", async () => {
    const user = userEvent.setup(); const onClose = vi.fn();
    render(<RdpConnectDialog api={api} initial={{ ...profile, networking: manualRoute }} securePersistenceAvailable onClose={onClose} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    change("Password", "rdp-secret"); change("Proxy password", "proxy-secret");
    await chooseRoute(user, "");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    await chooseRoute(user, "manual");
    expect(screen.getByLabelText("Proxy password")).toHaveValue("");
    change("Password", "rdp-secret"); change("Proxy password", "proxy-secret");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Password")).toHaveValue(""); expect(screen.getByLabelText("Proxy password")).toHaveValue("");
  });

  it.each(["Proxy address", "Proxy port", "Proxy username"])("detaches an unsaved profile when its manual %s changes", async (field) => {
    const user = userEvent.setup(); mount({ ...profile, networking: manualRoute, hasCredential: true, credentialPersistence: "secure" });
    change(field, field === "Proxy port" ? "1081" : field === "Proxy address" ? "other.test" : "other-user");
    change("Password", "rdp-secret"); change("Proxy password", "proxy-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(connectedInput).not.toHaveProperty("profileId");
    expect(connectedInput).toHaveProperty("persistence", "none");
  });

  it("clears both request passwords and input drafts if the bridge throws synchronously", async () => {
    const user = userEvent.setup(); mount({ ...profile, networking: manualRoute });
    vi.mocked(api.connect).mockImplementation(() => { throw new Error("Connection unavailable."); });
    change("Password", "rdp-secret"); change("Proxy password", "proxy-secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection unavailable.");
    expect(vi.mocked(api.connect).mock.calls[0]![0]).not.toHaveProperty("password");
    expect(vi.mocked(api.connect).mock.calls[0]![0]).not.toHaveProperty("proxyPassword");
    expect(screen.getByLabelText("Password")).toHaveValue(""); expect(screen.getByLabelText("Proxy password")).toHaveValue("");
  });

  it("opens the Network manager without losing form drafts and reports failures inline", async () => {
    let finish!: (result: Awaited<ReturnType<RdpWindowAPI["openNetworkManager"]>>) => void;
    vi.mocked(api.openNetworkManager).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup(); mount({ ...profile, networking: manualRoute });
    change("Connection name", "Unsaved name"); change("Password", "rdp-secret"); change("Proxy password", "proxy-secret");
    const open = screen.getByRole("button", { name: "Open Network manager" });
    await user.click(open);
    expect(open).toBeDisabled();
    expect(api.openNetworkManager).toHaveBeenCalledOnce();
    await act(async () => { finish({ ok: false, error: "Connect a Sliver workspace first." }); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Connect a Sliver workspace first.");
    expect(screen.getByLabelText("Connection name")).toHaveValue("Unsaved name");
    expect(screen.getByLabelText("Password")).toHaveValue("rdp-secret"); expect(screen.getByLabelText("Proxy password")).toHaveValue("proxy-secret");
    expect(api.connect).not.toHaveBeenCalled(); expect(api.saveProfile).not.toHaveBeenCalled();
    vi.mocked(api.openNetworkManager).mockResolvedValue({ ok: true });
    await user.click(open);
    await waitFor(() => expect(open).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Connection name")).toHaveValue("Unsaved name");
  });

  it("keeps Networking collapsed and Direct by default, then sends a selected managed proxy ID", async () => {
    const user = userEvent.setup();
    render(<RdpConnectDialog api={api} socks5Proxies={[proxy]} securePersistenceAvailable
      onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    expect(screen.getByRole("button", { name: "Networking" })).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "Networking" }));
    expect(screen.getByLabelText("Connection route")).toHaveAttribute("data-route-value", "");
    await chooseRoute(user, proxy.id);
    change("Computer", "internal.test"); change("Username", "operator"); change("Password", "private-input");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ host: "internal.test", networking: { kind: "socks5", proxyId: proxy.id } }));
    expect(connectedInput?.networking).not.toHaveProperty("host");
    expect(connectedInput?.networking).not.toHaveProperty("authentication");
  });

  it.each(["missing", "stopped"])("retains a %s proxy on save and rejects connecting without silently using Direct", async (availability) => {
    const user = userEvent.setup();
    const networking = { kind: "socks5" as const, proxyId: proxy.id };
    render(<RdpConnectDialog api={api} initial={{ ...profile, networking }} socks5Proxies={availability === "missing" ? [] : [{ ...proxy, available: false }]}
      securePersistenceAvailable onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    expect(screen.getByRole("button", { name: "Networking" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Connection route")).toHaveAttribute("data-route-value", proxy.id);
    change("Password", "private-input");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("selected SOCKS5 proxy is unavailable");
    expect(api.connect).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ networking })));
    expect(screen.getByLabelText("Connection route")).toHaveAttribute("data-route-value", proxy.id);
  });

  it("clears saved credential eligibility and profile association when changing the route", async () => {
    const user = userEvent.setup();
    render(<RdpConnectDialog api={api} initial={{ ...profile, hasCredential: true, credentialPersistence: "session" }} socks5Proxies={[proxy]}
      securePersistenceAvailable onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    await user.click(screen.getByRole("button", { name: "Networking" }));
    await chooseRoute(user, proxy.id);
    expect(screen.getByLabelText("Remember password")).toHaveAttribute("data-selected-value", "none");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expectFieldError("Password", /Enter the Windows account password/u);
    change("Password", "private-input");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(connectedInput).not.toHaveProperty("profileId");
    expect(connectedInput).toHaveProperty("networking.proxyId", proxy.id);
  });

  it("keeps a temporary Overview connection's route fixed", async () => {
    const user = userEvent.setup();
    render(<RdpConnectDialog api={api} temporary={{ id: "temporary-one", label: "Windows host", host: "127.0.0.1", port: 42001 }} socks5Proxies={[proxy]}
      securePersistenceAvailable onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    await user.click(screen.getByRole("button", { name: "Networking" }));
    expect(screen.getByText("This temporary connection uses the selected Sliver session.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Connection route")).not.toBeInTheDocument();
  });

  it("allows saving an imported profile with no account but requires the account before connecting", async () => {
    const user = userEvent.setup(); mount({ ...profile, username: "", domain: "" });
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ username: "" })));
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expectFieldError("Username", /Windows username/u);
    expect(api.connect).not.toHaveBeenCalled();
  });

  it("defaults to NLA and clears all account values when switching to remote-screen sign-in", async () => {
    const user = userEvent.setup();
    mount({ ...profile, hasCredential: true, credentialPersistence: "secure" });
    const mode = screen.getByRole("switch", { name: "Sign in on the remote screen" });
    expect(mode).not.toBeChecked();
    expect(screen.getByText("Requires a server that allows connections without NLA.")).toBeInTheDocument();
    change("Password", "private-input");
    await user.click(mode);
    for (const label of ["Username", "Domain", "Password", "Remember password"]) expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    await user.click(mode);
    for (const label of ["Username", "Domain", "Password"]) expect(screen.getByLabelText(label)).toHaveValue("");
    expect(screen.getByLabelText("Remember password")).toHaveAttribute("data-selected-value", "none");
    change("Username", profile.username); change("Domain", profile.domain);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expectFieldError("Password", /Enter the Windows account password/u);
    expect(api.connect).not.toHaveBeenCalled();
    change("Password", "replacement-input");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ password: "replacement-input", persistence: "none" }));
    expect(connectedInput).not.toHaveProperty("signInMode");
  });

  it("sends no credentials or persistence when connecting with remote-screen sign-in", async () => {
    const user = userEvent.setup();
    mount();
    change("Computer", "desktop.test"); change("Username", "operator"); change("Domain", "LAB"); change("Password", "private-input");
    await chooseDropdown(user, "Remember password", "secure");
    await user.click(screen.getByRole("switch", { name: "Sign in on the remote screen" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ signInMode: "remote-screen", username: "", domain: "", persistence: "none" }));
    expect(connectedInput).not.toHaveProperty("password");
    expect(connectedInput).not.toHaveProperty("profileId");
    expect(api.saveProfile).not.toHaveBeenCalled();
  });

  it("saves and restores the remote-screen mode without account fields", async () => {
    const user = userEvent.setup();
    mount(); change("Computer", "desktop.test");
    await user.click(screen.getByRole("switch", { name: "Sign in on the remote screen" }));
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ signInMode: "remote-screen", username: "", domain: "" })));
    expect(vi.mocked(api.saveProfile).mock.calls[0]![0]).not.toHaveProperty("password");
    cleanup();
    mount({ ...profile, signInMode: "remote-screen", username: "", domain: "", hasCredential: false, credentialPersistence: "none" });
    expect(screen.getByRole("switch", { name: "Sign in on the remote screen" })).toBeChecked();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ profileId: profile.id, signInMode: "remote-screen", username: "", domain: "", persistence: "none" }));
    expect(connectedInput).not.toHaveProperty("password");
  });

  it("supports remote-screen sign-in through a temporary Overview connection", async () => {
    const user = userEvent.setup();
    render(<RdpConnectDialog api={api} temporary={{ id: "temporary-one", label: "Windows host", host: "127.0.0.1", port: 42001 }}
      securePersistenceAvailable onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    await user.click(screen.getByRole("switch", { name: "Sign in on the remote screen" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ temporaryId: "temporary-one", signInMode: "remote-screen", username: "", domain: "", persistence: "none" }));
    expect(connectedInput).not.toHaveProperty("password");
    expect(api.saveProfile).not.toHaveBeenCalled();
  });

  it.each(["nla", "remote-screen"] as const)("detaches an unsaved sign-in mode change from an existing %s profile", async (signInMode) => {
    const user = userEvent.setup();
    mount({ ...profile, signInMode, ...(signInMode === "remote-screen" ? { username: "", domain: "" } : {}) });
    await user.click(screen.getByRole("switch", { name: "Sign in on the remote screen" }));
    if (signInMode === "remote-screen") { change("Username", "operator"); change("Password", "private-input"); }
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(connectedInput).not.toHaveProperty("profileId");
    expect(connectedInput).toMatchObject({ persistence: "none" });
    if (signInMode === "remote-screen") expect(connectedInput).not.toHaveProperty("signInMode");
    else expect(connectedInput).toHaveProperty("signInMode", "remote-screen");
    expect(api.saveProfile).not.toHaveBeenCalled();
  });

  it("creates a new NLA profile when remembering credentials after an unsaved remote-screen mode change", async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveProfile).mockImplementation(async (input) => ({ ok: true, value: { ...profile, ...input, id: "new-nla-profile" } }));
    mount({ ...profile, signInMode: "remote-screen", username: "", domain: "" });
    await user.click(screen.getByRole("switch", { name: "Sign in on the remote screen" }));
    change("Username", "operator"); change("Password", "private-input");
    await chooseDropdown(user, "Remember password", "session");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledOnce());
    expect(vi.mocked(api.saveProfile).mock.calls[0]![0]).not.toHaveProperty("id");
    expect(vi.mocked(api.saveProfile).mock.calls[0]![0]).not.toHaveProperty("signInMode");
    expect(connectedInput).toMatchObject({ profileId: "new-nla-profile", username: "operator", password: "private-input", persistence: "session" });
  });

  it("reuses the original profile after its changed sign-in mode is explicitly saved", async () => {
    const user = userEvent.setup();
    mount(profile);
    await user.click(screen.getByRole("switch", { name: "Sign in on the remote screen" }));
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ id: profile.id, signInMode: "remote-screen" })));
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedInput).toMatchObject({ profileId: profile.id, signInMode: "remote-screen" }));
    expect(api.saveProfile).toHaveBeenCalledOnce();
  });

  it("ignores saved credentials and persistence when connecting through a temporary endpoint", async () => {
    const user = userEvent.setup();
    const temporary: RdpPendingConnection = { id: "temporary-one", label: "Windows host", host: "127.0.0.1", port: 42001 };
    render(<RdpConnectDialog api={api} temporary={temporary} initial={{ ...profile, hasCredential: true, credentialPersistence: "secure" }}
      securePersistenceAvailable onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    expect(screen.getByLabelText("Username")).toHaveValue("");
    expect(screen.getByLabelText("Domain")).toHaveValue("");
    expect(screen.getByLabelText("Computer")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Port")).toHaveAttribute("readonly");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(api.connect).not.toHaveBeenCalled();
    change("Username", "Administrator"); change("Password", "private-input");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    expect(connectedInput).toMatchObject({ temporaryId: temporary.id, host: temporary.host, port: temporary.port, persistence: "none", password: "private-input" });
    expect(connectedInput).not.toHaveProperty("profileId");
    expect(api.saveProfile).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("keeps temporary cancellation failures visible and allows retry without retaining the password", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.mocked(api.cancelTemporary).mockResolvedValueOnce({ ok: false, error: "Forward could not be stopped." });
    render(<RdpConnectDialog api={api} temporary={{ id: "temporary-one", label: "Windows host", host: "127.0.0.1", port: 42001 }}
      securePersistenceAvailable onClose={onClose} onConnected={onConnected} onProfileSaved={onProfileSaved} />);
    change("Password", "private-input");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Forward could not be stopped.");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Password")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(api.cancelTemporary).toHaveBeenCalledTimes(2);
  });

  it("enables clipboard for a new connection and retains a saved profile's explicit choice", () => {
    mount();
    expect(screen.getByRole("switch", { name: "Clipboard" })).toBeChecked();
    cleanup();
    mount(profile);
    expect(screen.getByRole("switch", { name: "Clipboard" })).not.toBeChecked();
  });

  it("remembers the clipboard default immediately without saving a profile or connecting", async () => {
    const user = userEvent.setup();
    const settingsApi = installSettings();
    const view = renderWithSettings(settingsApi);
    const clipboard = screen.getByRole("switch", { name: "Clipboard" });
    await waitFor(() => expect(clipboard).toBeEnabled());
    await user.click(clipboard);
    await waitFor(() => expect(settingsApi.updateApplicationSettings).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ rdp: { clipboard: false, transparentClipboard: false } }),
    })));
    await waitFor(() => expect(clipboard).toBeEnabled());
    expect(api.saveProfile).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
    view.unmount();
    renderWithSettings(settingsApi);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Clipboard" })).toBeEnabled());
    expect(screen.getByRole("switch", { name: "Clipboard" })).not.toBeChecked();
  });

  it("loads the remembered choice before enabling submissions", async () => {
    let resolveSettings!: (settings: ApplicationSettingsState) => void;
    const settingsApi = installSettings();
    settingsApi.getApplicationSettings = vi.fn(() => new Promise<ApplicationSettingsState>((resolve) => { resolveSettings = resolve; }));
    renderWithSettings(settingsApi);
    expect(screen.getByRole("switch", { name: "Clipboard" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    await act(async () => { resolveSettings({ ...DEFAULT_APPLICATION_SETTINGS_STATE, rdp: { clipboard: false, transparentClipboard: false } }); });
    expect(screen.getByRole("switch", { name: "Clipboard" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("keeps a profile's clipboard choice when the remembered default differs", async () => {
    renderWithSettings(installSettings(), profile);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Clipboard" })).toBeEnabled());
    expect(screen.getByRole("switch", { name: "Clipboard" })).not.toBeChecked();
  });

  it("restores the clipboard choice and shows feedback if saving the preference fails", async () => {
    const user = userEvent.setup();
    const settingsApi = installSettings();
    settingsApi.updateApplicationSettings = vi.fn(async () => ({ ok: false as const, error: "Disk is unavailable." }));
    renderWithSettings(settingsApi);
    const clipboard = screen.getByRole("switch", { name: "Clipboard" });
    await waitFor(() => expect(clipboard).toBeEnabled());
    await user.click(clipboard);
    expect(await screen.findByRole("alert")).toHaveTextContent("The clipboard preference could not be saved.");
    expect(clipboard).toBeChecked();
    expect(clipboard).toBeEnabled();
  });

  it("defaults to 1280x800, offers common resolutions, and submits the selected preset", async () => {
    const user = userEvent.setup();
    mount();
    const resolution = screen.getByRole("button", { name: "Desktop resolution" });
    expect(resolution).toHaveAttribute("data-selected-value", "1280x800");
    expect(screen.queryByLabelText("Desktop width")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Desktop height")).not.toBeInTheDocument();
    await user.click(resolution);
    const choices = screen.getAllByRole("menuitemradio");
    for (const value of ["1920x1080", "2560x1440", "3840x2160", "custom"]) {
      expect(choices.some((choice) => choice.getAttribute("data-selected-value") === value)).toBe(true);
    }
    expect(screen.getByRole("menuitemradio", { name: "Custom" })).toHaveAttribute("data-selected-value", "custom");
    await chooseDropdown(user, "Desktop resolution", "3840x2160");
    change("Computer", "desktop.test");
    change("Username", "operator");
    change("Password", "test-password");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(connectedInput).toMatchObject({ host: "desktop.test", width: 3840, height: 2160, password: "test-password" });
    expect(onConnected).toHaveBeenCalledWith("connected-desktop");
  });

  it("reveals dimensions only for Custom and preserves the custom dimensions across preset changes", async () => {
    const user = userEvent.setup();
    mount(profile);
    await chooseDropdown(user, "Desktop resolution", "custom");
    change("Desktop width", "1700");
    change("Desktop height", "950");
    await chooseDropdown(user, "Desktop resolution", "2560x1440");
    expect(screen.queryByLabelText("Desktop width")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Desktop height")).not.toBeInTheDocument();
    await chooseDropdown(user, "Desktop resolution", "custom");
    expect(screen.getByLabelText("Desktop width")).toHaveValue("1700");
    expect(screen.getByLabelText("Desktop height")).toHaveValue("950");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ width: 1700, height: 950 })));
  });

  it.each([
    [1920, 1080, "1920x1080"],
    [3840, 2160, "3840x2160"],
    [1700, 950, "custom"],
  ] as const)("preserves a saved profile's %s×%s resolution", async (width, height, value) => {
    const user = userEvent.setup();
    mount({ ...profile, width, height });
    expect(screen.getByRole("button", { name: "Desktop resolution" })).toHaveAttribute("data-selected-value", value);
    if (value === "custom") {
      await chooseDropdown(user, "Desktop resolution", "2560x1440");
      await chooseDropdown(user, "Desktop resolution", "custom");
      expect(screen.getByLabelText("Desktop width")).toHaveValue(String(width));
      expect(screen.getByLabelText("Desktop height")).toHaveValue(String(height));
    } else expect(screen.queryByLabelText("Desktop width")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ id: profile.id, width, height })));
    expect(api.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["Computer", "https://desktop.test", "desktop.test", /hostname|IP address|scheme|path/iu],
    ["Port", "70000", "3389", /port|65535/iu],
    ["Username", "operator\u0001", "operator", /control characters/iu],
  ] as const)("associates the %s error and blocks both actions until corrected", async (label, invalid, valid, message) => {
    const user = userEvent.setup();
    mount(profile);
    fireEvent.blur(change(label, invalid));
    expectFieldError(label, message);
    change("Password", "test-password");
    for (const action of ["Connect", "Save profile"]) {
      await user.click(screen.getByRole("button", { name: action }));
      expect(api.connect).not.toHaveBeenCalled();
      expect(api.saveProfile).not.toHaveBeenCalled();
    }
    change(label, valid);
    expect(screen.getByLabelText(label)).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(label)).not.toHaveAccessibleDescription(message);
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledOnce());
  });

  it.each(["Connect", "Save profile"])("validates required metadata inline before %s", async (action) => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: action }));
    expectFieldError("Computer", /hostname|IP address|computer/iu);
    if (action === "Connect") expectFieldError("Username", /username/iu);
    expect(screen.getByLabelText("Computer")).toHaveFocus();
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.saveProfile).not.toHaveBeenCalled();
  });

  it.each([
    ["199", "900", "Desktop width"],
    ["1700", "8193", "Desktop height"],
    ["8192", "8192", "Desktop width"],
  ] as const)("rejects custom %s×%s on blur and both submit actions", async (width, height, invalidField) => {
    const user = userEvent.setup();
    mount(profile);
    await chooseDropdown(user, "Desktop resolution", "custom");
    change("Desktop width", width);
    change("Desktop height", height);
    fireEvent.blur(screen.getByLabelText(invalidField));
    expectFieldError(invalidField, /pixels|8192|200|million/iu);
    change("Password", "test-password");
    for (const action of ["Connect", "Save profile"]) {
      await user.click(screen.getByRole("button", { name: action }));
      expect(api.connect).not.toHaveBeenCalled();
      expect(api.saveProfile).not.toHaveBeenCalled();
    }
    change("Desktop width", "1700");
    change("Desktop height", "950");
    expect(screen.getByLabelText(invalidField)).not.toHaveAttribute("aria-invalid", "true");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledOnce());
  });

  it("requires a password to connect but allows saving metadata without one", async () => {
    const user = userEvent.setup();
    mount(profile);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expectFieldError("Password", /password/iu);
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.saveProfile).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledOnce());
    expect(vi.mocked(api.saveProfile).mock.calls[0]?.[0]).not.toHaveProperty("password");
    expect(onProfileSaved).toHaveBeenCalledOnce();
    expect(api.connect).not.toHaveBeenCalled();
  });

  it("shows profile-save success in a toast while keeping failures inline", async () => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, "success");
    mount(profile);
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(success).toHaveBeenCalledExactlyOnceWith("Profile saved", {
      description: "Passwords are stored only when you connect with a remember option.",
    }));
    expect(screen.getByRole("dialog").querySelector('[role="status"]')).toBeNull();
    expect(screen.queryByText("Profile saved. Passwords are stored only when you connect with a remember option.")).not.toBeInTheDocument();
    vi.mocked(api.saveProfile).mockResolvedValueOnce({ ok: false, error: "The profile could not be saved." });
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The profile could not be saved.");
    expect(success).toHaveBeenCalledOnce();
  });

  it("reuses a matching saved credential with normalized host and trimmed account fields", async () => {
    const user = userEvent.setup();
    mount({ ...profile, hasCredential: true, credentialPersistence: "session" });
    change("Computer", " OFFICE.TEST ");
    change("Username", " operator ");
    change("Domain", " LAB ");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(connectedInput).toMatchObject({ profileId: profile.id, username: "operator", domain: "LAB" });
    expect(connectedInput).not.toHaveProperty("password");
  });

  it.each([
    ["Computer", "other.test"], ["Port", "3390"], ["Username", "other-user"], ["Domain", "OTHER"],
  ])("requires a password when a saved credential's %s changes", async (label, value) => {
    const user = userEvent.setup();
    mount({ ...profile, hasCredential: true, credentialPersistence: "session" });
    change(label!, value!);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expectFieldError("Password", /password/iu);
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.saveProfile).not.toHaveBeenCalled();
  });

  it("stops offering a saved credential when saving the edited profile removes it", async () => {
    const user = userEvent.setup();
    mount({ ...profile, hasCredential: true, credentialPersistence: "session" });
    change("Computer", "other.test");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledOnce());
    // The save response reports hasCredential:false; returning to the old host
    // must not reuse stale eligibility from the initial profile.
    change("Computer", profile.host);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expectFieldError("Password", /password/iu);
    expect(api.connect).not.toHaveBeenCalled();
  });
});

function installSettings(): ApplicationSettingsAPI {
  let settings = DEFAULT_APPLICATION_SETTINGS_STATE;
  return {
    getApplicationSettings: vi.fn(async () => settings),
    onApplicationSettingsChanged: vi.fn(() => () => undefined),
    updateApplicationSettings: vi.fn(async (input: ApplicationSettingsUpdateInput) => {
      settings = { ...settings, ...input.settings, revision: input.expectedRevision + 1 };
      return { ok: true as const, value: settings };
    }),
  };
}

function renderWithSettings(settingsApi: ApplicationSettingsAPI, initial?: RdpProfile): ReturnType<typeof render> {
  return render(<ApplicationSettingsProvider api={settingsApi}>
    <RdpConnectDialog api={api} initial={initial} securePersistenceAvailable
      onClose={vi.fn()} onConnected={onConnected} onProfileSaved={onProfileSaved} />
  </ApplicationSettingsProvider>);
}
