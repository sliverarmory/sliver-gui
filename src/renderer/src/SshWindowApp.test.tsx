import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APPLICATION_SETTINGS_STATE,
  type ApplicationSettingsState,
} from "../../shared/application-settings-contracts";
import type { OperationResult } from "../../shared/contracts";
import type {
  ManagedSshTarget,
  SshHostKeyReview,
  SshOpenTabResult,
  SshTabCloseResult,
  SshTabLaunchContext,
  SshWindowAPI,
  SshWindowLaunchContext,
} from "../../shared/ssh-contracts";
import type { TerminalRuntimeAsset } from "../../shared/stream-contracts";
import type { GhosttyTerminalAppearance } from "./components/GhosttyTerminal";
import { ApplicationSettingsProvider } from "./components/ApplicationSettingsProvider";

const openSshTransport = vi.fn();

vi.mock("./components/console-terminal-transport", () => ({
  ConsoleTerminalTransport: {
    open: (...args: unknown[]) => openSshTransport(...args),
  },
}));

vi.mock("./components/GhosttyTerminal", () => ({
  GhosttyTerminal: (props: {
    appearance?: GhosttyTerminalAppearance;
    ariaLabel: string;
    onClose?: (reason?: string) => void;
    onError?: (error: Error) => void;
  }) => (
    <section
      aria-label={props.ariaLabel}
      data-cursor-blink={String(props.appearance?.cursorBlink)}
      data-font-family={props.appearance?.fontFamily}
      data-font-size={props.appearance?.fontSize}
      data-smooth-scroll-duration={props.appearance?.smoothScrollDuration}
      data-terminal-mock
    >
      <button type="button" onClick={() => props.onClose?.("SSH channel closed")}>Exit SSH</button>
      <button type="button" onClick={() => props.onError?.(new Error("Ghostty failed"))}>Fail terminal</button>
    </section>
  ),
}));

import { resetSshWindowStateForTest, SshWindowApp } from "./SshWindowApp";

const awsTarget: ManagedSshTarget = {
  deploymentId: "00000000-0000-4000-8000-000000000001",
  name: "test1",
  provider: "aws",
  host: "44.240.136.251",
  port: 22,
  username: "ubuntu",
  status: "running",
  connectable: true,
};

const proxmoxTarget: ManagedSshTarget = {
  deploymentId: "00000000-0000-4000-8000-000000000002",
  name: "range-vm",
  provider: "proxmox",
  host: "10.0.0.42",
  port: 2222,
  username: "operator",
  status: "running",
  connectable: true,
};

const stoppedTarget: ManagedSshTarget = {
  deploymentId: "00000000-0000-4000-8000-000000000003",
  name: "offline-vm",
  provider: "proxmox",
  host: "10.0.0.43",
  port: 22,
  username: "operator",
  status: "stopped",
  connectable: false,
  unavailableReason: "Start this managed server before connecting",
};

const firstTab: SshTabLaunchContext = {
  tabId: "a".repeat(43),
  attachmentToken: "t".repeat(43),
  target: awsTarget,
};

const secondTab: SshTabLaunchContext = {
  tabId: "b".repeat(43),
  attachmentToken: "u".repeat(43),
  target: proxmoxTarget,
};

const launchContext: SshWindowLaunchContext = {
  kind: "ssh",
  shortcutModifier: "Command",
  tabs: [firstTab],
  activeTabId: firstTab.tabId,
};

beforeEach(() => {
  resetSshWindowStateForTest();
  openSshTransport.mockReset();
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  Reflect.deleteProperty(window, "ssh");
  window.localStorage.clear();
});

describe("SshWindowApp", () => {
  it("claims persisted tabs and attaches Ghostty with the SSH stream and shared terminal appearance", async () => {
    const transport = fakeTransport();
    openSshTransport.mockResolvedValue(transport);
    const api = installAPI();

    render(
      <ApplicationSettingsProvider api={api}>
        <SshWindowApp />
      </ApplicationSettingsProvider>,
    );

    expect(await screen.findByRole("main", { name: "Managed SSH client window" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Managed SSH tabs" })).toBeInTheDocument();
    const tab = screen.getByRole("tab", { name: /test1.*Connected/u });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveAccessibleName(
      "test1, ubuntu@44.240.136.251:22, Connected, shortcut Command+1",
    );
    expect(tab).toHaveTextContent("⌘1");

    const terminal = screen.getByRole("region", {
      name: "SSH session for ubuntu@44.240.136.251:22",
    });
    expect(terminal).toHaveAttribute("data-font-family", '"Fira Code", monospace');
    expect(terminal).toHaveAttribute("data-font-size", "13");
    expect(openSshTransport).toHaveBeenCalledExactlyOnceWith({
      api,
      attachmentToken: firstTab.attachmentToken,
      streamKind: "ssh",
    });
    expect(api.claimSshWindow).toHaveBeenCalledOnce();
    expect(api.getTerminalRuntime).toHaveBeenCalledOnce();
    expect(document.title).toBe("SSH — test1 — ubuntu@44.240.136.251:22");
  });

  it("opens an accessible managed-server picker and keeps different servers mounted per tab", async () => {
    const firstTransport = fakeTransport();
    const secondTransport = fakeTransport();
    openSshTransport.mockResolvedValueOnce(firstTransport).mockResolvedValueOnce(secondTransport);
    const api = installAPI({
      createSshTab: vi.fn(async () => ok<SshOpenTabResult>({
        status: "opened",
        tabId: secondTab.tabId,
        created: true,
        context: secondTab,
      })),
    });
    const user = userEvent.setup();
    render(<SshWindowApp />);
    await screen.findByRole("tab", { name: /test1.*Connected/u });

    await user.click(screen.getByRole("button", { name: "New SSH tab" }));
    expect(await screen.findByRole("heading", { name: "New SSH Session" })).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Switch to test1, ubuntu@44.240.136.251:22",
    })).toBeEnabled();
    expect(screen.getByRole("button", {
      name: "Connect to offline-vm, operator@10.0.0.43:22",
    })).toBeDisabled();
    await user.click(screen.getByRole("button", {
      name: "Connect to range-vm, operator@10.0.0.42:2222",
    }));

    const secondTabButton = await screen.findByRole("tab", { name: /range-vm.*Connected/u });
    expect(secondTabButton).toHaveAttribute("aria-selected", "true");
    expect(api.createSshTab).toHaveBeenCalledExactlyOnceWith({ deploymentId: proxmoxTarget.deploymentId });
    expect(openSshTransport).toHaveBeenLastCalledWith({
      api,
      attachmentToken: secondTab.attachmentToken,
      streamKind: "ssh",
    });
    expect(document.querySelectorAll("[data-terminal-mock]")).toHaveLength(2);

    const firstPanel = document.querySelector(`[data-ssh-terminal-tab-id="${firstTab.tabId}"]`);
    const secondPanel = document.querySelector(`[data-ssh-terminal-tab-id="${secondTab.tabId}"]`);
    expect(firstPanel).toHaveAttribute("aria-hidden", "true");
    expect(firstPanel).toHaveAttribute("inert");
    expect(secondPanel).toHaveAttribute("aria-hidden", "false");
    expect(secondPanel).not.toHaveAttribute("inert");
    expect(firstTransport.close).not.toHaveBeenCalled();
    expect(secondTransport.close).not.toHaveBeenCalled();
  });

  it("requires an explicit fingerprint review before trusting an unknown SSH host key", async () => {
    openSshTransport.mockResolvedValue(fakeTransport());
    const review: SshHostKeyReview = {
      token: "r".repeat(43),
      deploymentId: proxmoxTarget.deploymentId,
      name: proxmoxTarget.name,
      host: proxmoxTarget.host,
      port: proxmoxTarget.port,
      fingerprint: `SHA256:${"f".repeat(43)}`,
      expiresAt: "2026-09-07T20:00:00.000Z",
    };
    const api = installAPI({
      createSshTab: vi.fn(async () => ok<SshOpenTabResult>({ status: "host-key-review", review })),
      approveSshHostKey: vi.fn(async () => ok<SshOpenTabResult>({
        status: "opened",
        tabId: secondTab.tabId,
        created: true,
        context: secondTab,
      })),
    });
    const user = userEvent.setup();
    render(<SshWindowApp />);
    await screen.findByRole("tab", { name: /test1.*Connected/u });

    await user.click(screen.getByRole("button", { name: "New SSH tab" }));
    await user.click(await screen.findByRole("button", {
      name: "Connect to range-vm, operator@10.0.0.42:2222",
    }));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Trust SSH host key?" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /fingerprint.*select to copy/u }))
      .toHaveValue(review.fingerprint);
    expect(screen.getByText(/Approval expires/u)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /range-vm/u })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Trust & Connect" }));

    expect(await screen.findByRole("tab", { name: /range-vm.*Connected/u })).toBeInTheDocument();
    expect(api.approveSshHostKey).toHaveBeenCalledExactlyOnceWith({ token: review.token });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("adopts main-opened tabs, handles shortcuts, and explicitly closes only the selected session", async () => {
    const firstTransport = fakeTransport();
    const secondTransport = fakeTransport();
    openSshTransport.mockResolvedValueOnce(firstTransport).mockResolvedValueOnce(secondTransport);
    const api = installAPI();
    render(<SshWindowApp />);
    const firstTerminal = await screen.findByRole("region", {
      name: "SSH session for ubuntu@44.240.136.251:22",
    });

    act(() => api.listeners.tabOpened?.(secondTab));
    const secondTabButton = await screen.findByRole("tab", { name: /range-vm.*Connected/u });
    expect(secondTabButton).toHaveAttribute("aria-selected", "true");

    const shortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Digit1",
      key: "1",
      metaKey: true,
    });
    act(() => expect(firstTerminal.dispatchEvent(shortcut)).toBe(false));
    expect(screen.getByRole("tab", { name: /test1.*Connected/u })).toHaveAttribute("aria-selected", "true");
    expect(api.selectSshTab).toHaveBeenLastCalledWith({ tabId: firstTab.tabId });

    fireEvent.click(secondTabButton);
    fireEvent.click(screen.getByRole("button", { name: "Close active SSH tab" }));

    await waitFor(() => expect(screen.queryByRole("tab", { name: /range-vm/u })).not.toBeInTheDocument());
    expect(api.closeSshTab).toHaveBeenCalledExactlyOnceWith({ tabId: secondTab.tabId });
    expect(secondTransport.close).toHaveBeenCalledOnce();
    expect(firstTransport.close).not.toHaveBeenCalled();
  });

  it("opens shared terminal settings from the SSH native menu and applies saved settings", async () => {
    openSshTransport.mockResolvedValue(fakeTransport());
    const updatedSettings: ApplicationSettingsState = {
      ...DEFAULT_APPLICATION_SETTINGS_STATE,
      revision: 1,
      terminal: {
        ...DEFAULT_APPLICATION_SETTINGS_STATE.terminal,
        fontSize: 18,
      },
    };
    const api = installAPI({
      updateApplicationSettings: vi.fn(async () => ok(updatedSettings)),
    });
    const user = userEvent.setup();
    render(
      <ApplicationSettingsProvider api={api}>
        <SshWindowApp />
      </ApplicationSettingsProvider>,
    );
    const terminal = await screen.findByRole("region", {
      name: "SSH session for ubuntu@44.240.136.251:22",
    });

    act(() => api.listeners.settings?.());
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Applied to every console, SSH session, and managed shell window.")).toBeInTheDocument();
    const fontSize = screen.getByRole("textbox", { name: "Font size" });
    await user.clear(fontSize);
    await user.type(fontSize, "18");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(terminal).toHaveAttribute("data-font-size", "18"));
    expect(api.updateApplicationSettings).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 0,
      settings: expect.objectContaining({
        terminal: expect.objectContaining({ fontSize: 18 }),
      }),
    }));
  });

  it("detaches renderer transports without closing persisted SSH sessions when the window unmounts", async () => {
    const transport = fakeTransport();
    openSshTransport.mockResolvedValue(transport);
    const api = installAPI();
    const rendered = render(<SshWindowApp />);
    await screen.findByRole("tab", { name: /test1.*Connected/u });

    rendered.unmount();

    expect(transport.close).toHaveBeenCalledOnce();
    expect(api.closeSshTab).not.toHaveBeenCalled();
  });

  it("keeps healthy restored tabs usable and can recover a failed persisted attachment", async () => {
    const failedOriginal = { ...firstTab, attachmentToken: "v".repeat(43) };
    const failedRetry = { ...firstTab, attachmentToken: "w".repeat(43) };
    const recovered = { ...firstTab, attachmentToken: "x".repeat(43) };
    const healthyTransport = fakeTransport();
    const recoveredTransport = fakeTransport();
    openSshTransport.mockImplementation(({ attachmentToken }: { attachmentToken: string }) => {
      if (attachmentToken === failedOriginal.attachmentToken || attachmentToken === failedRetry.attachmentToken) {
        return Promise.reject(new Error("attachment unavailable"));
      }
      if (attachmentToken === secondTab.attachmentToken) return Promise.resolve(healthyTransport);
      if (attachmentToken === recovered.attachmentToken) return Promise.resolve(recoveredTransport);
      return Promise.reject(new Error("unexpected attachment"));
    });
    const reattachSshTab = vi.fn()
      .mockResolvedValueOnce(ok(failedRetry))
      .mockResolvedValueOnce(ok(recovered));
    const api = installAPI({
      claimSshWindow: vi.fn(async () => ok({
        ...launchContext,
        tabs: [failedOriginal, secondTab],
        activeTabId: failedOriginal.tabId,
      })),
      createSshTab: vi.fn(async () => ok<SshOpenTabResult>({
        status: "opened",
        tabId: failedOriginal.tabId,
        created: false,
      })),
      reattachSshTab,
    });
    const user = userEvent.setup();

    render(<SshWindowApp />);

    expect(await screen.findByRole("tab", { name: /range-vm.*Connected/u })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /test1/u })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("1 SSH session could not be restored");

    await user.click(screen.getByRole("button", { name: "New SSH tab" }));
    await user.click(await screen.findByRole("button", {
      name: "Connect to test1, ubuntu@44.240.136.251:22",
    }));

    expect(await screen.findByRole("tab", { name: /test1.*Connected/u })).toBeInTheDocument();
    expect(api.createSshTab).toHaveBeenCalledWith({ deploymentId: awsTarget.deploymentId });
    expect(reattachSshTab).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/could not be restored/u)).not.toBeInTheDocument();
    expect(healthyTransport.close).not.toHaveBeenCalled();
    expect(recoveredTransport.close).not.toHaveBeenCalled();
  });

  it("detaches every claimed session if the Ghostty runtime cannot start", async () => {
    const transport = fakeTransport();
    openSshTransport.mockResolvedValue(transport);
    installAPI({
      getTerminalRuntime: vi.fn(async () => ({
        ok: false as const,
        error: "Ghostty runtime failed integrity verification",
      })),
    });
    render(<SshWindowApp />);

    expect(await screen.findByText("Managed SSH unavailable")).toBeInTheDocument();
    expect(screen.getByText("Ghostty runtime failed integrity verification")).toBeInTheDocument();
    await waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
  });

  it("fails closed when the window cannot claim the dedicated SSH capability", async () => {
    const api = installAPI({
      claimSshWindow: vi.fn(async () => ({
        ok: false as const,
        error: "This window has no SSH capability",
      })),
    });
    render(<SshWindowApp />);

    expect(await screen.findByText("Managed SSH unavailable")).toBeInTheDocument();
    expect(screen.getByText("This window has no SSH capability")).toBeInTheDocument();
    expect(openSshTransport).not.toHaveBeenCalled();
    expect(api.createSshTab).not.toHaveBeenCalled();
  });
});

function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

function runtime(): TerminalRuntimeAsset {
  return {
    version: "0.4.0",
    sha256: "a".repeat(64),
    bytes: new Uint8Array([0, 97, 115, 109]),
  };
}

function fakeTransport() {
  return {
    close: vi.fn(),
    getSnapshot: vi.fn(),
    resize: vi.fn(),
    send: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    subscribeState: vi.fn(() => vi.fn()),
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

interface SshTestListeners {
  newTab?: () => void;
  closeTab?: () => void;
  selectTab?: (index: number) => void;
  settings?: () => void;
  tabOpened?: (context: SshTabLaunchContext) => void;
  applicationSettings?: (settings: ApplicationSettingsState) => void;
}

interface SshAPIOverrides {
  readonly claimSshWindow: () => Promise<OperationResult<SshWindowLaunchContext>>;
  readonly listSshTargets: () => Promise<OperationResult<readonly ManagedSshTarget[]>>;
  readonly createSshTab: (input: { readonly deploymentId: string }) => Promise<OperationResult<SshOpenTabResult>>;
  readonly reattachSshTab: SshWindowAPI["reattachSshTab"];
  readonly approveSshHostKey: (input: { readonly token: string }) => Promise<OperationResult<SshOpenTabResult>>;
  readonly closeSshTab: (input: { readonly tabId: string }) => Promise<OperationResult<SshTabCloseResult>>;
  readonly getTerminalRuntime: () => Promise<OperationResult<TerminalRuntimeAsset>>;
  readonly updateApplicationSettings: SshWindowAPI["updateApplicationSettings"];
}

function installAPI(overrides: Partial<SshAPIOverrides> = {}) {
  const listeners: SshTestListeners = {};
  const api: SshWindowAPI & { readonly listeners: SshTestListeners } = {
    claimSshWindow: vi.fn(overrides.claimSshWindow ?? (async () => ok(launchContext))),
    listSshTargets: vi.fn(overrides.listSshTargets ?? (async () => ok([
      awsTarget,
      proxmoxTarget,
      stoppedTarget,
    ]))),
    createSshTab: vi.fn(overrides.createSshTab ?? (async () => ({
      ok: false as const,
      error: "No additional SSH tab fixture",
    }))),
    reattachSshTab: vi.fn(overrides.reattachSshTab ?? (async ({ tabId }) => {
      const context = [firstTab, secondTab].find((candidate) => candidate.tabId === tabId);
      return context
        ? ok(context)
        : { ok: false as const, error: "No SSH reattachment fixture" };
    })),
    approveSshHostKey: vi.fn(overrides.approveSshHostKey ?? (async () => ({
      ok: false as const,
      error: "No host-key approval fixture",
    }))),
    closeSshTab: vi.fn(overrides.closeSshTab ?? (async () => ok({ remainingTabs: 0 }))),
    selectSshTab: vi.fn(async () => ({ ok: true as const })),
    getTerminalRuntime: vi.fn(overrides.getTerminalRuntime ?? (async () => ok(runtime()))),
    getApplicationSettings: vi.fn(async () => DEFAULT_APPLICATION_SETTINGS_STATE),
    updateApplicationSettings: vi.fn(overrides.updateApplicationSettings ?? (async () => ({
      ok: false as const,
      error: "Application settings updates are not configured by this test",
    }))),
    openSshStream: vi.fn(),
    onApplicationSettingsChanged: vi.fn((listener) => {
      listeners.applicationSettings = listener;
      return vi.fn();
    }),
    onSshNewTabRequested: vi.fn((listener) => {
      listeners.newTab = listener;
      return vi.fn();
    }),
    onSshCloseTabRequested: vi.fn((listener) => {
      listeners.closeTab = listener;
      return vi.fn();
    }),
    onSshSelectTabRequested: vi.fn((listener) => {
      listeners.selectTab = listener;
      return vi.fn();
    }),
    onSshSettingsRequested: vi.fn((listener) => {
      listeners.settings = listener;
      return vi.fn();
    }),
    onSshTabOpened: vi.fn((listener) => {
      listeners.tabOpened = listener;
      return vi.fn();
    }),
    listeners,
  };
  Object.defineProperty(window, "ssh", {
    configurable: true,
    value: api,
  });
  return api;
}
