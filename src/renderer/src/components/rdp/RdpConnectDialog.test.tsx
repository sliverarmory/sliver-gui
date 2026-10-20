import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpConnectInput, RdpProfile, RdpSaveProfileInput, RdpTab, RdpWindowAPI } from "../../../../shared/rdp-contracts";
import { DEFAULT_APPLICATION_SETTINGS_STATE, type ApplicationSettingsState, type ApplicationSettingsUpdateInput } from "../../../../shared/application-settings-contracts";
import { ApplicationSettingsProvider, type ApplicationSettingsAPI } from "../ApplicationSettingsProvider";
import { RdpConnectDialog } from "./RdpConnectDialog";

const profile: RdpProfile = {
  id: "saved-desktop", label: "Office", host: "office.test", port: 3389, username: "operator", domain: "LAB",
  width: 1920, height: 1080, clipboard: false, scaleMode: "fit", hasCredential: false, credentialPersistence: "none",
};
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

function expectFieldError(label: string, text: RegExp): void {
  const field = screen.getByLabelText(label);
  expect(field).toHaveAttribute("aria-invalid", "true");
  expect(field).toHaveAccessibleDescription(text);
}

describe("Remote Desktop connection form", () => {
  it("enables clipboard for a new connection and retains a saved profile's explicit choice", () => {
    mount();
    expect(screen.getByRole("switch", { name: "Text clipboard" })).toBeChecked();
    cleanup();
    mount(profile);
    expect(screen.getByRole("switch", { name: "Text clipboard" })).not.toBeChecked();
  });

  it("remembers the clipboard default immediately without saving a profile or connecting", async () => {
    const user = userEvent.setup();
    const settingsApi = installSettings();
    const view = renderWithSettings(settingsApi);
    const clipboard = screen.getByRole("switch", { name: "Text clipboard" });
    await waitFor(() => expect(clipboard).toBeEnabled());
    await user.click(clipboard);
    await waitFor(() => expect(settingsApi.updateApplicationSettings).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ rdp: { clipboard: false } }),
    })));
    await waitFor(() => expect(clipboard).toBeEnabled());
    expect(api.saveProfile).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
    view.unmount();
    renderWithSettings(settingsApi);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Text clipboard" })).toBeEnabled());
    expect(screen.getByRole("switch", { name: "Text clipboard" })).not.toBeChecked();
  });

  it("loads the remembered choice before enabling submissions", async () => {
    let resolveSettings!: (settings: ApplicationSettingsState) => void;
    const settingsApi = installSettings();
    settingsApi.getApplicationSettings = vi.fn(() => new Promise<ApplicationSettingsState>((resolve) => { resolveSettings = resolve; }));
    renderWithSettings(settingsApi);
    expect(screen.getByRole("switch", { name: "Text clipboard" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    await act(async () => { resolveSettings({ ...DEFAULT_APPLICATION_SETTINGS_STATE, rdp: { clipboard: false } }); });
    expect(screen.getByRole("switch", { name: "Text clipboard" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("keeps a profile's clipboard choice when the remembered default differs", async () => {
    renderWithSettings(installSettings(), profile);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Text clipboard" })).toBeEnabled());
    expect(screen.getByRole("switch", { name: "Text clipboard" })).not.toBeChecked();
  });

  it("restores the clipboard choice and shows feedback if saving the preference fails", async () => {
    const user = userEvent.setup();
    const settingsApi = installSettings();
    settingsApi.updateApplicationSettings = vi.fn(async () => ({ ok: false as const, error: "Disk is unavailable." }));
    renderWithSettings(settingsApi);
    const clipboard = screen.getByRole("switch", { name: "Text clipboard" });
    await waitFor(() => expect(clipboard).toBeEnabled());
    await user.click(clipboard);
    expect(await screen.findByRole("alert")).toHaveTextContent("The text clipboard preference could not be saved.");
    expect(clipboard).toBeChecked();
    expect(clipboard).toBeEnabled();
  });

  it("defaults to 1280x800, offers common resolutions, and submits the selected preset", async () => {
    const user = userEvent.setup();
    mount();
    const resolution = screen.getByRole("combobox", { name: "Desktop resolution" });
    expect(resolution).toHaveValue("1280x800");
    for (const value of ["1920x1080", "2560x1440", "3840x2160", "custom"]) {
      expect(resolution.querySelector(`option[value="${value}"]`)).not.toBeNull();
    }
    expect(screen.getByRole("option", { name: "Custom" })).toHaveValue("custom");
    expect(screen.queryByLabelText("Desktop width")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Desktop height")).not.toBeInTheDocument();
    await user.selectOptions(resolution, "3840x2160");
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
    const resolution = screen.getByRole("combobox", { name: "Desktop resolution" });
    await user.selectOptions(resolution, "custom");
    change("Desktop width", "1700");
    change("Desktop height", "950");
    await user.selectOptions(resolution, "2560x1440");
    expect(screen.queryByLabelText("Desktop width")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Desktop height")).not.toBeInTheDocument();
    await user.selectOptions(resolution, "custom");
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
    expect(screen.getByRole("combobox", { name: "Desktop resolution" })).toHaveValue(value);
    if (value === "custom") {
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
    ["Username", "   ", "operator", /username/iu],
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
    expectFieldError("Username", /username/iu);
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
    await user.selectOptions(screen.getByRole("combobox", { name: "Desktop resolution" }), "custom");
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
