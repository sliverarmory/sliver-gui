import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar, useSidebar } from "@heroui-pro/react/sidebar";
import { toast } from "@heroui/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot, SLIVER_PROTOCOL_BASELINE_COMMIT, SLIVER_PROTOCOL_COMPATIBILITY } from "../../shared/contracts";
import {
  DEFAULT_APPLICATION_SETTINGS_STATE,
  type ResolvedApplicationIcon,
} from "../../shared/application-settings-contracts";
import { CONSOLE_WINDOW_OPEN_REQUEST_ERROR } from "../../shared/console-contracts";
import type {
  OperationResult,
  SavedConfigSummary,
  SliverDesktopAPI,
  SliverSnapshot,
} from "../../shared/contracts";
import type { BeaconSummary, SessionSummary, TargetRef } from "../../shared/target-contracts";
import { App, ConnectionMenu, NavigationContent, WindowMenu } from "./App";
import { ApplicationSettingsProvider } from "./components/ApplicationSettingsProvider";
import * as connectionContext from "./components/ConnectionProvider";
import { renderWithApplicationContextMenu as render } from "./application-context-menu-test-utils";
import { navigationShortcuts, shortcutAriaKeyShortcuts } from "./navigation-shortcuts";
import { isApplePlatform } from "./components/CommandPaletteShortcut";
import { OPEN_CONSOLE_SHORTCUT } from "./window-shortcuts";

beforeAll(() => {
  vi.stubGlobal("IntersectionObserver", class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

afterEach(() => {
  cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function installSliverAPI(
  listSavedConfigs: SliverDesktopAPI["listSavedConfigs"],
  initialSnapshot = disconnectedSnapshot(),
  captureSnapshotListener?: (listener: (snapshot: SliverSnapshot) => void) => void,
): SliverDesktopAPI {
  const failedOperation = async () => ({ ok: false as const, error: "Not implemented by this test" });
  const api: SliverDesktopAPI = {
    setKeyboardShortcutRecording: vi.fn().mockResolvedValue(undefined),
    chooseConfig: vi.fn(failedOperation),
    chooseCertificatePair: vi.fn(failedOperation),
    backgroundTarget: vi.fn(failedOperation),
    cancelBeaconTask: vi.fn(failedOperation),
    cancelTargetOperation: vi.fn(failedOperation),
    connectSavedConfig: vi.fn(failedOperation),
    deleteBuild: vi.fn(failedOperation),
    deleteProfile: vi.fn(failedOperation),
    deleteLoot: vi.fn(failedOperation),
    deleteCredential: vi.fn(failedOperation),
    disconnect: vi.fn(failedOperation),
    downloadBuild: vi.fn(failedOperation),
    downloadLoot: vi.fn(failedOperation),
    exitApp: vi.fn(failedOperation),
    getApplicationSettings: vi.fn().mockResolvedValue(DEFAULT_APPLICATION_SETTINGS_STATE),
    getApplicationIcon: vi.fn().mockResolvedValue("dark"),
    onApplicationIconChanged: vi.fn(() => vi.fn()),
    updateApplicationSettings: vi.fn(async (input) => ({
      ok: true as const,
      value: {
        v: 2 as const,
        revision: input.expectedRevision + 1,
        ...input.settings,
      },
    })),
    getApplicationUpdateState: vi.fn().mockResolvedValue({
      status: "disabled",
      revision: 0,
      currentVersion: "0.1.0",
      disabledReason: "Updates are not under test.",
    }),
    checkForApplicationUpdates: vi.fn(failedOperation),
    restartToApplyApplicationUpdate: vi.fn(failedOperation),
    generate: vi.fn(failedOperation),
    generateFromProfile: vi.fn(failedOperation),
    getBeaconTask: vi.fn(failedOperation),
    getLootDetail: vi.fn(failedOperation),
    revealCredentialSecret: vi.fn(failedOperation),
    getTerminalRuntime: vi.fn(failedOperation),
    getSnapshot: vi.fn().mockResolvedValue(initialSnapshot),
    getTargetOperation: vi.fn(failedOperation),
    getExecutionResult: vi.fn(failedOperation),
    importConfig: vi.fn(failedOperation),
    listExecutionCatalog: vi.fn(failedOperation),
    listLoot: vi.fn(failedOperation),
    listCredentials: vi.fn(failedOperation),
    listLocalNetworkInterfaces: vi.fn(failedOperation),
    listSavedConfigs,
    listSessionShells: vi.fn(failedOperation),
    listBeaconTasks: vi.fn(failedOperation),
    listTargets: vi.fn(failedOperation),
    listTargetOperations: vi.fn(failedOperation),
    onBeaconTasksInvalidated: vi.fn(() => vi.fn()),
    onSessionShellsChanged: vi.fn(() => vi.fn()),
    onReleaseDownloadChanged: vi.fn(() => vi.fn()),
    onApplicationUpdateChanged: vi.fn(() => vi.fn()),
    onApplicationSettingsChanged: vi.fn(() => vi.fn()),
    onCommandPaletteRequested: vi.fn(() => vi.fn()),
    openStream: vi.fn(),
    openConsoleStream: vi.fn(),
    onOperationChanged: vi.fn(() => vi.fn()),
    onSnapshotChanged: vi.fn((listener: (snapshot: SliverSnapshot) => void) => {
      captureSnapshotListener?.(listener);
      return vi.fn();
    }),
    openInteractionWindow: vi.fn(failedOperation),
    openCloudDeploymentWindow: vi.fn(failedOperation),
    copyManagedServerPublicIp: vi.fn(async () => ({ ok: true as const })),
    claimInteractionWindow: vi.fn(failedOperation),
    openSessionShellWindow: vi.fn(failedOperation),
    claimSessionShellWindow: vi.fn(failedOperation),
    openConsoleWindow: vi.fn(failedOperation),
    claimConsoleWindow: vi.fn(failedOperation),
    createConsoleTab: vi.fn(failedOperation),
    closeConsoleTab: vi.fn(failedOperation),
    onConsoleNewTabRequested: vi.fn(() => vi.fn()),
    onConsoleCloseTabRequested: vi.fn(() => vi.fn()),
    onConsoleSelectTabRequested: vi.fn(() => vi.fn()),
    onConsoleSettingsRequested: vi.fn(() => vi.fn()),
    openWindow: vi.fn(failedOperation),
    prepareStopAllJobs: vi.fn(failedOperation),
    prepareStopJob: vi.fn(failedOperation),
    prepareExecutionAction: vi.fn(failedOperation),
    prepareTargetAction: vi.fn(failedOperation),
    refresh: vi.fn(failedOperation),
    removeSavedConfig: vi.fn(failedOperation),
    saveProfile: vi.fn(failedOperation),
    addLoot: vi.fn(failedOperation),
    renameLoot: vi.fn(failedOperation),
    addCredential: vi.fn(failedOperation),
    copyCredentialSecret: vi.fn(failedOperation),
    clearCredentialClipboard: vi.fn(failedOperation),
    selectTarget: vi.fn(failedOperation),
    setBeaconWatch: vi.fn(failedOperation),
    setStagedBuilds: vi.fn(failedOperation),
    startListener: vi.fn(failedOperation),
    executeStopPlan: vi.fn(failedOperation),
    executeTargetActionPlan: vi.fn(failedOperation),
    executeSessionDestructiveActionPlan: vi.fn(failedOperation),
    prepareSessionDestructiveAction: vi.fn(failedOperation),
    prepareSessionShell: vi.fn(failedOperation),
    runSessionWorkbench: vi.fn(failedOperation),
    runExecutionRead: vi.fn(failedOperation),
    actOnSessionShell: vi.fn(failedOperation),
    submitTargetOperation: vi.fn(failedOperation),
    executeExecutionPlan: vi.fn(failedOperation),
    discardExecutionPlan: vi.fn(failedOperation),
    saveExecutionResult: vi.fn(failedOperation),
  };

  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("App startup", () => {
  it("shares history between keyboard shortcuts and palette commands with matching boundaries", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      managedServer: null,
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
    };
    installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }), snapshot);
    const apple = navigationShortcuts().back.shortcut.startsWith("mod+");
    const backKeys = apple ? "{Meta>}[BracketLeft]{/Meta}" : "{Alt>}{ArrowLeft}{/Alt}";
    const forwardKeys = apple ? "{Meta>}[BracketRight]{/Meta}" : "{Alt>}{ArrowRight}{/Alt}";
    render(<App />);
    await screen.findByRole("heading", { name: "Overview" });

    await user.click(screen.getByRole("button", { name: "Open command palette" }));
    const initialPalette = await screen.findByRole("dialog", { name: "Command palette" });
    expect(within(initialPalette).getByRole("menuitem", { name: /^Go back/u })).toHaveAttribute("aria-disabled", "true");
    expect(within(initialPalette).getByRole("menuitem", { name: /^Go forward/u })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("row", { name: "Jobs & listeners" }));
    await user.click(screen.getByRole("button", { name: "Open command palette" }));
    await user.click(await screen.findByRole("menuitem", { name: /^Settings/u }));
    await screen.findByRole("heading", { name: "Settings" });
    await user.keyboard(backKeys);
    expect(await screen.findByRole("heading", { name: "Jobs & listeners" })).toBeInTheDocument();
    await user.keyboard(forwardKeys);
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open command palette" }));
    const search = await screen.findByRole("searchbox", { name: "Search commands" });
    await user.keyboard(backKeys);
    expect(screen.getByRole("heading", { name: "Settings", hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    await user.type(search, "go back");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(await screen.findByRole("heading", { name: "Jobs & listeners" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open command palette" }));
    const forward = await screen.findByRole("menuitem", { name: /^Go forward/u });
    expect(forward).not.toHaveAttribute("aria-disabled", "true");
    await user.click(forward);
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go forward" })).toBeDisabled();
  });

  it("shares back and forward history across the sidebar and command palette", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      managedServer: null,
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
    };
    installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }), snapshot);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Overview" })).toHaveAttribute("data-current", "true");
    expect(screen.queryByRole("heading", { name: "Jobs & listeners" })).not.toBeInTheDocument();
    const navigation = within(screen.getByRole("navigation", { name: "Window navigation" }));
    const back = navigation.getByRole("button", { name: "Go back" });
    const forward = navigation.getByRole("button", { name: "Go forward" });
    expect(back).toBeDisabled();
    expect(forward).toBeDisabled();

    await user.click(screen.getByRole("row", { name: "Jobs & listeners" }));
    expect(await screen.findByRole("heading", { name: "Jobs & listeners" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open command palette" }));
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    const overview = within(palette).getByRole("menuitem", { name: /^Overview/u });
    expect(within(palette).getAllByRole("menuitem")[0]).toBe(overview);
    expect(overview).not.toHaveAttribute("aria-disabled", "true");
    await user.click(overview);

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Overview" })).toHaveAttribute("data-current", "true");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    expect(back).toBeEnabled();
    expect(forward).toBeDisabled();

    await user.click(back);
    expect(await screen.findByRole("heading", { name: "Jobs & listeners" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Jobs & listeners" })).toHaveAttribute("data-current", "true");
    expect(forward).toBeEnabled();
    await user.click(forward);
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(forward).toBeDisabled();

    await user.click(back);
    await user.click(screen.getByRole("button", { name: "Open command palette" }));
    const reopenedPalette = await screen.findByRole("dialog", { name: "Command palette" });
    await user.click(within(reopenedPalette).getByRole("menuitem", { name: /^Settings/u }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(forward).toBeDisabled();
    await user.click(back);
    expect(await screen.findByRole("heading", { name: "Jobs & listeners" })).toBeInTheDocument();
    await user.click(forward);
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(forward).toBeDisabled();
  });

  it("keeps the window navigation accessible when the sidebar is collapsed", async () => {
    const user = userEvent.setup();
    installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }));
    render(<App />);
    await screen.findByText("No saved configurations");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const navigation = within(screen.getByRole("navigation", { name: "Window navigation" }));
    await user.click(navigation.getByRole("button", { name: "Collapse sidebar" }));
    expect(navigation.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    expect(navigation.getByRole("button", { name: "Go back" })).toBeVisible();
    expect(navigation.getByRole("button", { name: "Go forward" })).toBeVisible();
    await user.click(navigation.getByRole("button", { name: "Expand sidebar" }));
    expect(navigation.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  });

  it("opens the saved configuration selector immediately and keeps a dismissal closed", async () => {
    const user = userEvent.setup();
    const initialCatalog = deferred<OperationResult<SavedConfigSummary[]>>();
    const listSavedConfigs = vi.fn()
      .mockReturnValueOnce(initialCatalog.promise)
      .mockResolvedValue({ ok: true, value: [] });
    installSliverAPI(listSavedConfigs);

    render(<App />);

    expect(screen.getByRole("dialog", { name: "Saved configurations" })).toBeInTheDocument();
    expect(screen.getByText("Finding configurations")).toBeInTheDocument();
    expect(listSavedConfigs).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event("focus"));
    expect(listSavedConfigs).toHaveBeenCalledOnce();

    initialCatalog.resolve({ ok: true, value: [] });
    await screen.findByText("No saved configurations");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
    });

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(listSavedConfigs).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
    expect(screen.queryByText("Connect an operator configuration")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("opens the app-wide command palette and immediately adopts its saved shortcut", async () => {
    const user = userEvent.setup();
    const api = installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }));
    let requestCommandPalette: (() => void) | undefined;
    vi.mocked(api.onCommandPaletteRequested).mockImplementation((listener) => {
      requestCommandPalette = listener;
      return vi.fn();
    });
    render(<App />);

    await screen.findByText("No saved configurations");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    act(() => requestCommandPalette?.());

    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: /Settings/u }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Keyboard Shortcuts" }));
    await user.click(screen.getByRole("button", { name: "Change shortcut for Open command palette" }));
    await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");

    expect(screen.getByLabelText(/(?:Command|Ctrl) \+ Shift \+ P/u)).toBeInTheDocument();
    act(() => requestCommandPalette?.());
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("offers Cloud Deployment by default and opens its window from the command palette", async () => {
    const user = userEvent.setup();
    const api = installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }));
    vi.mocked(api.openCloudDeploymentWindow).mockResolvedValue({ ok: true });
    let requestCommandPalette: (() => void) | undefined;
    vi.mocked(api.onCommandPaletteRequested).mockImplementation((listener) => {
      requestCommandPalette = listener;
      return vi.fn();
    });
    render(<App />);

    await screen.findByText("No saved configurations");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    act(() => requestCommandPalette?.());

    const overview = await screen.findByRole("menuitem", { name: /^Overview/u });
    expect(overview).not.toHaveAttribute("aria-disabled", "true");
    expect(overview).toHaveTextContent("Current");
    const cloudDeployment = await screen.findByRole("menuitem", { name: /Cloud Deployment/u });
    expect(cloudDeployment).not.toHaveAttribute("aria-disabled", "true");
    await user.click(cloudDeployment);

    await waitFor(() => expect(api.openCloudDeploymentWindow).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    });
  });

  it("removes stale opaque config IDs when a catalog refresh fails", async () => {
    const config: SavedConfigSummary = {
      id: "46a72a10-a9ad-43ac-9db4-d108a0065e1c",
      fileName: "operator.cfg",
      displayName: "Production",
      operator: "alice",
      lhost: "sliver.example.test",
      lport: 31337,
      transport: "mtls",
      modifiedAt: "2026-08-09T12:00:00.000Z",
      origin: "preexisting",
      removal: "detach",
      availability: "available",
    };
    const listSavedConfigs = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: [config] })
      .mockResolvedValueOnce({ ok: false, error: "Catalog refresh failed" });
    installSliverAPI(listSavedConfigs);

    render(<App />);

    expect(await screen.findByRole("option", { name: /alice/i })).toBeInTheDocument();
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText("Couldn't load configurations")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /alice/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("runs a trailing catalog scan after an import overlaps a focus refresh", async () => {
    const user = userEvent.setup();
    const initialConfig: SavedConfigSummary = {
      id: "46a72a10-a9ad-43ac-9db4-d108a0065e1c",
      fileName: "operator.cfg",
      displayName: "Production",
      operator: "alice",
      lhost: "sliver.example.test",
      lport: 31337,
      transport: "mtls",
      modifiedAt: "2026-08-09T12:00:00.000Z",
      origin: "preexisting",
      removal: "detach",
      availability: "available",
    };
    const importedConfig: SavedConfigSummary = {
      ...initialConfig,
      id: "fe346126-d70e-42a7-91b8-53081903014f",
      fileName: "managed.cfg",
      displayName: "Imported lab",
      operator: "bob",
      origin: "managed",
      removal: "delete-managed-copy",
    };
    const freshImportedConfig = {
      ...importedConfig,
      id: "59507a02-030f-4aa5-b01f-ad895458f58d",
    };
    const focusCatalog = deferred<OperationResult<SavedConfigSummary[]>>();
    const listSavedConfigs = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: [initialConfig] })
      .mockReturnValueOnce(focusCatalog.promise)
      .mockResolvedValueOnce({ ok: true, value: [freshImportedConfig] });
    const api = installSliverAPI(listSavedConfigs);
    vi.mocked(api.importConfig).mockResolvedValue({ ok: true, value: importedConfig });
    vi.mocked(api.connectSavedConfig).mockResolvedValue({ ok: false, error: "Connection not needed for this test" });

    render(<App />);

    expect(await screen.findByRole("option", { name: /alice/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import a copy" }));
    await user.type(screen.getByRole("textbox", { name: "Local configuration name" }), "Imported lab");
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(listSavedConfigs).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Choose file and import" }));
    await waitFor(() => expect(api.importConfig).toHaveBeenCalledWith({ displayName: "Imported lab" }));
    expect(listSavedConfigs).toHaveBeenCalledTimes(2);

    focusCatalog.resolve({ ok: true, value: [initialConfig] });
    expect(await screen.findByRole("option", { name: /bob/i })).toBeInTheDocument();
    expect(listSavedConfigs).toHaveBeenCalledTimes(3);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connectSavedConfig).toHaveBeenCalledWith(freshImportedConfig.id));
  });

  it("does not replace a newer connection event with the initial snapshot response", async () => {
    const initialResponse = deferred<SliverSnapshot>();
    let emitSnapshot: ((snapshot: SliverSnapshot) => void) | undefined;
    const api = installSliverAPI(
      vi.fn().mockResolvedValue({ ok: true, value: [] }),
      disconnectedSnapshot(),
      (listener) => { emitSnapshot = listener; },
    );
    vi.mocked(api.getSnapshot).mockReturnValue(initialResponse.promise);
    render(<App />);

    const connected = disconnectedSnapshot();
    connected.connection = {
      status: "connected",
      managedServer: { deploymentId: "deployment-1", provider: "aws", name: "Managed lab" },
      operator: "new-operator",
      server: "current.example.test:31337",
    };
    act(() => { emitSnapshot?.(connected); });
    expect(await screen.findAllByRole("button", { name: "Current server: new-operator" })).not.toHaveLength(0);

    await act(async () => { initialResponse.resolve(disconnectedSnapshot()); });
    expect(screen.getAllByRole("button", { name: "Current server: new-operator" })).not.toHaveLength(0);
  });

  it.each(["chooseConfig", "connectSavedConfig", "disconnect", "refresh"] as const)(
    "preserves newer connection metadata when a delayed %s response arrives",
    async (operation) => {
      const user = userEvent.setup();
      const snapshot = disconnectedSnapshot();
      snapshot.connection = {
        status: "connected",
        managedServer: { deploymentId: "deployment-1", provider: "aws", name: "Managed lab" },
        operator: "alice",
        server: "current.example.test:31337",
        incarnation: 4,
      };
      const config: SavedConfigSummary = {
        id: "saved-config",
        fileName: "operator.cfg",
        displayName: "Managed lab",
        operator: "alice",
        lhost: "current.example.test",
        lport: 31337,
        transport: "mtls",
        modifiedAt: "2026-09-16T12:00:00.000Z",
        origin: "preexisting",
        removal: "detach",
        availability: "available",
      };
      let emitSnapshot: ((next: SliverSnapshot) => void) | undefined;
      const api = installSliverAPI(
        vi.fn().mockResolvedValue({ ok: true, value: [config] }),
        snapshot,
        (listener) => { emitSnapshot = listener; },
      );
      let requestCommandPalette: (() => void) | undefined;
      vi.mocked(api.onCommandPaletteRequested).mockImplementation((listener) => {
        requestCommandPalette = listener;
        return vi.fn();
      });
      const response = deferred<OperationResult<SliverSnapshot>>();
      vi.mocked(api[operation]).mockReturnValue(response.promise);
      const provider = vi.spyOn(connectionContext, "ConnectionProvider");

      try {
        render(<App />);
        await waitFor(() => {
          expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
          expect(provider.mock.calls.at(-1)?.[0].connection?.managedServer).toEqual(snapshot.connection.managedServer);
        });

        if (operation === "refresh") {
          act(() => requestCommandPalette?.());
          await user.click(await screen.findByRole("menuitem", { name: /Refresh server/u }));
        } else {
          await user.click(screen.getAllByRole("button", { name: "Current server: alice" })[0]!);
          await user.click(await screen.findByRole("menuitem", {
            name: operation === "disconnect" ? "Disconnect" : "Switch config",
          }));
          if (operation !== "disconnect") {
            await user.click(await screen.findByRole("button", {
              name: operation === "chooseConfig" ? "Open file" : "Connect",
            }));
          }
        }
        await waitFor(() => expect(api[operation]).toHaveBeenCalledOnce());

        const newer: SliverSnapshot = {
          ...snapshot,
          connection: {
            ...snapshot.connection,
            managedServer: operation === "disconnect"
              ? { deploymentId: "deployment-2", provider: "azure", name: "New connection" }
              : null,
            incarnation: operation === "disconnect" ? 5 : 4,
          },
        };
        act(() => { emitSnapshot?.(newer); });
        await act(async () => {
          response.resolve({ ok: true, value: operation === "disconnect" ? disconnectedSnapshot() : snapshot });
        });

        expect(provider.mock.calls.at(-1)?.[0].connection).toEqual(newer.connection);
      } finally {
        provider.mockRestore();
      }
    },
  );

  it("keeps an operationally degraded backend usable without showing a compatibility notice", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      managedServer: null,
      status: "degraded",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.6.0",
      error: "Compiler inventory refresh failed",
    };
    installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }), snapshot);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Server version mismatch" })).not.toBeInTheDocument();
    expect(screen.queryByText("Backend degraded")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
    });
    const header = document.querySelector<HTMLElement>(".app-header");
    if (!header) throw new Error("Application header is missing");
    expect(within(header).queryByRole("button", { name: "Switch config" })).not.toBeInTheDocument();
    expect(within(header).queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Current server: alice" })[0]!);
    await user.click(await screen.findByRole("menuitem", { name: "Switch config" }));
    expect(await screen.findByRole("dialog", { name: "Saved configurations" })).toBeInTheDocument();
  });

  it("shows a mismatched-server notice once per connection epoch and keeps it dismissed on same-epoch updates", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    const mismatchReason = "Sliver 1.8.0 is outside the compatible 1.7.x version series and may be incompatible with this client";
    snapshot.connection = {
      managedServer: null,
      status: "degraded",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.8.0",
      epoch: 41,
      error: mismatchReason,
      capabilities: {
        compatibility: "degraded",
        baselineCommit: SLIVER_PROTOCOL_BASELINE_COMMIT,
        serverVersion: "1.8.0",
        reason: mismatchReason,
        currentSlice: {
          jobs: true,
          listeners: true,
          generation: true,
          builds: true,
          profiles: true,
          events: true,
          targets: true,
          tasks: true,
        },
      },
    };
    let emitSnapshot: ((next: SliverSnapshot) => void) | undefined;
    installSliverAPI(
      vi.fn().mockResolvedValue({ ok: true, value: [] }),
      snapshot,
      (listener) => {
        emitSnapshot = listener;
      },
    );
    render(<App />);

    const dialog = await screen.findByRole("dialog", { name: "Server version mismatch" });
    expect(dialog.querySelector('[data-slot="modal-body"]')).toHaveClass("flex", "flex-col", "gap-3");
    expect(within(dialog).getByText("1.8.0")).toBeInTheDocument();
    expect(within(dialog).getByText(SLIVER_PROTOCOL_COMPATIBILITY.series)).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(SLIVER_PROTOCOL_BASELINE_COMMIT.slice(0, 12));
    expect(dialog).toHaveTextContent(mismatchReason);
    expect(dialog).not.toHaveTextContent("Current M0 features remain available");
    const header = document.querySelector<HTMLElement>(".app-header");
    if (!header) throw new Error("Application header is missing");
    expect(within(header).queryByText("Backend degraded")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Server version mismatch" })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Refresh server state" })).not.toBeInTheDocument();

    if (!emitSnapshot) throw new Error("Snapshot listener was not installed");
    act(() => {
      emitSnapshot?.({
        ...snapshot,
        connection: { ...snapshot.connection, status: "reconnecting" },
      });
    });
    expect(screen.queryByRole("dialog", { name: "Server version mismatch" })).not.toBeInTheDocument();

    act(() => {
      emitSnapshot?.({
        ...snapshot,
        connection: { ...snapshot.connection, epoch: 42 },
      });
    });
    expect(await screen.findByRole("dialog", { name: "Server version mismatch" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Server version mismatch" })).not.toBeInTheDocument();
    });
  });

  it("disconnects the active backend from the current-server menu", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      managedServer: null,
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
    };
    const api = installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }), snapshot);
    vi.mocked(api.disconnect).mockResolvedValue({ ok: true, value: disconnectedSnapshot() });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
    });

    await user.click(screen.getAllByRole("button", { name: "Current server: alice" })[0]!);
    await user.click(await screen.findByRole("menuitem", { name: "Disconnect" }));

    await waitFor(() => expect(api.disconnect).toHaveBeenCalledOnce());
    expect(await screen.findByRole("dialog", { name: "Saved configurations" })).toBeInTheDocument();
    expect(screen.queryByText("Connect an operator configuration")).not.toBeInTheDocument();
  });

  it("opens the active server console from its button and advertised shortcut without config arguments", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      managedServer: null,
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
      incarnation: 9,
    };
    const api = installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }), snapshot);
    vi.mocked(api.openConsoleWindow).mockResolvedValue({ ok: true });

    render(<App />);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "New window options" })).toBeInTheDocument();
    const consoleButton = screen.getByRole("button", { name: "Open Sliver console" });
    expect(consoleButton).toBeEnabled();
    expect(consoleButton).toHaveAttribute("aria-keyshortcuts", shortcutAriaKeyShortcuts(OPEN_CONSOLE_SHORTCUT));
    await user.hover(consoleButton);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Open console for the active server");
    expect(within(tooltip).getByLabelText(/(?:Command|Ctrl) \+ T/u)).toBeInTheDocument();
    await user.click(consoleButton);

    expect(api.openConsoleWindow).toHaveBeenCalledExactlyOnceWith();
    vi.mocked(api.openConsoleWindow).mockClear();
    await user.keyboard(isApplePlatform() ? "{Meta>}t{/Meta}" : "{Control>}t{/Control}");
    expect(api.openConsoleWindow).toHaveBeenCalledExactlyOnceWith();
  });

  it("leaves the console shortcut inactive while disconnected", async () => {
    const user = userEvent.setup();
    const api = installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }));
    render(<App />);
    await screen.findByText("No saved configurations");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Open Sliver console" })).toBeDisabled();
    await user.keyboard(isApplePlatform() ? "{Meta>}t{/Meta}" : "{Control>}t{/Control}");
    expect(api.openConsoleWindow).not.toHaveBeenCalled();
  });

  it("does not expose an IPC exception when opening a console fails", async () => {
    const user = userEvent.setup();
    const danger = vi.spyOn(toast, "danger");
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      managedServer: null,
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
      incarnation: 9,
    };
    const api = installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }), snapshot);
    const privateFailure = "spawn failed for /Users/operator/.sliver-client/configs/production.cfg";
    vi.mocked(api.openConsoleWindow).mockRejectedValue(new Error(privateFailure));

    render(<App />);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Open Sliver console" }));

    await waitFor(() => expect(danger).toHaveBeenCalledWith("Could not open Sliver console", {
      description: CONSOLE_WINDOW_OPEN_REQUEST_ERROR,
    }));
    expect(danger).not.toHaveBeenCalledWith("Could not open Sliver console", {
      description: expect.stringContaining(privateFailure),
    });
  });

  it("keeps the saved configuration selector closed across a delayed connecting snapshot", async () => {
    const connected = disconnectedSnapshot();
    connected.connection = {
      managedServer: null,
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
    };
    let emitSnapshot: ((next: SliverSnapshot) => void) | undefined;
    installSliverAPI(
      vi.fn().mockResolvedValue({ ok: true, value: [] }),
      connected,
      (listener) => { emitSnapshot = listener; },
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
    });
    if (!emitSnapshot) throw new Error("Snapshot listener was not installed");

    act(() => {
      emitSnapshot?.({
        ...connected,
        connection: { ...connected.connection, status: "connecting" },
      });
    });
    expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();

    act(() => { emitSnapshot?.(connected); });
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
  });

  it("reopens the saved configuration selector when connecting ends disconnected", async () => {
    const connected = disconnectedSnapshot();
    connected.connection = {
      managedServer: null,
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
    };
    let emitSnapshot: ((next: SliverSnapshot) => void) | undefined;
    installSliverAPI(
      vi.fn().mockResolvedValue({ ok: true, value: [] }),
      connected,
      (listener) => { emitSnapshot = listener; },
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
    });
    if (!emitSnapshot) throw new Error("Snapshot listener was not installed");

    act(() => {
      emitSnapshot?.({
        ...connected,
        connection: { ...connected.connection, status: "connecting" },
      });
    });
    expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();

    act(() => { emitSnapshot?.(disconnectedSnapshot()); });
    expect(await screen.findByRole("dialog", { name: "Saved configurations" })).toBeInTheDocument();
  });

  it("keeps a manually opened saved configuration selector across usable health changes", async () => {
    const user = userEvent.setup();
    const connected = disconnectedSnapshot();
    connected.connection = {
      managedServer: null,
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
    };
    let emitSnapshot: ((next: SliverSnapshot) => void) | undefined;
    installSliverAPI(
      vi.fn().mockResolvedValue({ ok: true, value: [] }),
      connected,
      (listener) => { emitSnapshot = listener; },
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
    });
    if (!emitSnapshot) throw new Error("Snapshot listener was not installed");
    await user.click(screen.getAllByRole("button", { name: "Current server: alice" })[0]!);
    await user.click(await screen.findByRole("menuitem", { name: "Switch config" }));
    expect(await screen.findByRole("dialog", { name: "Saved configurations" })).toBeInTheDocument();

    act(() => {
      emitSnapshot?.({
        ...connected,
        connection: { ...connected.connection, status: "degraded", error: "Compiler refresh failed" },
      });
    });
    expect(screen.getByRole("dialog", { name: "Saved configurations" })).toBeInTheDocument();

    act(() => {
      emitSnapshot?.({
        ...connected,
        connection: { ...connected.connection, status: "reconnecting", error: "Event stream retrying" },
      });
    });
    expect(screen.getByRole("dialog", { name: "Saved configurations" })).toBeInTheDocument();
  });

  it("closes a manually opened saved configuration selector when connecting succeeds", async () => {
    const user = userEvent.setup();
    const connected = disconnectedSnapshot();
    connected.connection = {
      managedServer: null,
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
    };
    let emitSnapshot: ((next: SliverSnapshot) => void) | undefined;
    installSliverAPI(
      vi.fn().mockResolvedValue({ ok: true, value: [] }),
      connected,
      (listener) => { emitSnapshot = listener; },
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
    });
    if (!emitSnapshot) throw new Error("Snapshot listener was not installed");
    await user.click(screen.getAllByRole("button", { name: "Current server: alice" })[0]!);
    await user.click(await screen.findByRole("menuitem", { name: "Switch config" }));
    expect(await screen.findByRole("dialog", { name: "Saved configurations" })).toBeInTheDocument();

    act(() => {
      emitSnapshot?.({
        ...connected,
        connection: { ...connected.connection, status: "connecting" },
      });
    });
    expect(screen.getByRole("dialog", { name: "Saved configurations" })).toBeInTheDocument();

    act(() => { emitSnapshot?.(connected); });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
    });
  });
});

describe("Current server menu", () => {
  it("opens the application Settings surface from the footer menu", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      managedServer: null,
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
    };
    installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }), snapshot);

    render(<App />);

    const trigger = await screen.findByRole("button", { name: "Current server: alice" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
    });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Settings" }));

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).toBeInTheDocument();
    const icons = within(screen.getByRole("radiogroup", { name: "App icon" }));
    await user.click(icons.getByRole("radio", { name: "Passion" }));
    await user.click(within(screen.getByRole("radiogroup", { name: "Color theme" }))
      .getByRole("radio", { name: "Light" }));

    expect(icons.getByRole("radio", { name: "Passion" })).toHaveAttribute("aria-checked", "true");
  });

  it("opens from the server summary and orders application and server actions nearest the trigger", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      managedServer: null,
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "m0-manual-verification",
      configName: "M0 manual verification",
      version: "1.7.6",
    };
    const onSwitchConfig = vi.fn();
    const onDisconnect = vi.fn();
    const onExitApp = vi.fn();
    const onSettings = vi.fn();

    render(
      <ConnectionMenu
        snapshot={snapshot}
        onDisconnect={onDisconnect}
        onExitApp={onExitApp}
        onSettings={onSettings}
        onSwitchConfig={onSwitchConfig}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Current server: m0-manual-verification" });
    expect(trigger.querySelectorAll('[data-sidebar="label"]')).toHaveLength(1);
    const menuIcon = trigger.querySelector(".connection-summary__menu-icon");
    expect(menuIcon).not.toHaveAttribute("data-sidebar");
    expect(menuIcon).toHaveClass("ms-auto");
    expect(screen.queryByRole("menuitem", { name: "Switch config" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Exit app" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Exit app",
      "Disconnect",
      "Switch config",
      "Settings",
    ]);
    for (const label of ["Exit app", "Disconnect"]) {
      const item = screen.getByRole("menuitem", { name: label });
      expect(item).toHaveClass("menu-item--danger");
      expect(item.querySelector("svg")).toHaveClass("text-danger");
    }
    await user.click(await screen.findByRole("menuitem", { name: "Switch config" }));
    expect(onSwitchConfig).toHaveBeenCalledOnce();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onExitApp).not.toHaveBeenCalled();
    expect(onSettings).not.toHaveBeenCalled();

    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
    expect(onDisconnect).toHaveBeenCalledOnce();

    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Settings" }));
    expect(onSettings).toHaveBeenCalledOnce();

    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Exit app" }));
    expect(onExitApp).toHaveBeenCalledOnce();
  });

  it("keeps application settings and exit available while offline", async () => {
    const user = userEvent.setup();
    const onSettings = vi.fn();
    render(
      <ConnectionMenu
        snapshot={disconnectedSnapshot()}
        onDisconnect={vi.fn()}
        onExitApp={vi.fn()}
        onSettings={onSettings}
        onSwitchConfig={vi.fn()}
      />,
    );

    expect(screen.getByText("Offline")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Application menu, offline" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Exit app",
      "Switch config",
      "Settings",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(onSettings).toHaveBeenCalledOnce();
  });
});

describe("Sidebar navigation", () => {
  function renderNavigation(open: boolean, icon?: ResolvedApplicationIcon) {
    const onViewChange = vi.fn();
    const navigation = (
      <Sidebar.Provider collapsible="icon" open={open}>
        <Sidebar className="app-sidebar">
          <NavigationContent
            snapshot={disconnectedSnapshot()}
            view="operations"
            onDisconnect={vi.fn()}
            onExitApp={vi.fn()}
            onSettings={vi.fn()}
            onSwitchConfig={vi.fn()}
            onViewChange={onViewChange}
          />
        </Sidebar>
      </Sidebar.Provider>
    );
    render(
      icon ? <ApplicationSettingsProvider api={{
        getApplicationSettings: async () => DEFAULT_APPLICATION_SETTINGS_STATE,
        onApplicationSettingsChanged: () => () => {},
        getApplicationIcon: async () => icon,
        onApplicationIconChanged: () => () => {},
      }}>{navigation}</ApplicationSettingsProvider> : navigation,
    );
    return onViewChange;
  }

  it.each([true, false])("places an available Overview first while disconnected (expanded=%s)", async (open) => {
    const user = userEvent.setup();
    const onViewChange = renderNavigation(open);

    const menus = screen.getAllByRole("treegrid");
    expect(menus.map((menu) => menu.getAttribute("aria-label"))).toEqual([
      "Overview navigation",
      "Operational navigation",
      "Interact navigation",
      "Data navigation",
    ]);
    const overview = within(menus[0]!).getByRole("row", { name: "Overview" });
    expect(overview).not.toHaveAttribute("aria-disabled", "true");
    await user.click(overview);
    expect(onViewChange).toHaveBeenCalledExactlyOnceWith("overview");
  });

  it("opens the loot and credential stores from the shared Data navigation", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      managedServer: null,
      status: "connected",
      epoch: 7,
      incarnation: 3,
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
    };
    const api = installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }), snapshot);
    vi.mocked(api.listLoot).mockResolvedValue({
      ok: true,
      value: { items: [], page: { limit: 100, total: 0, truncated: false } },
    });
    vi.mocked(api.listCredentials).mockResolvedValue({
      ok: true,
      value: {
        items: [],
        page: { limit: 100, total: 0, truncated: false },
        collections: [],
        hashTypes: [],
      },
    });

    render(<App />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument());
    const data = screen.getByRole("treegrid", { name: "Data navigation" });
    await user.click(within(data).getByRole("row", { name: "Loot" }));
    expect(await screen.findByRole("heading", { name: "Loot" })).toBeInTheDocument();
    await waitFor(() => expect(api.listLoot).toHaveBeenCalledOnce());

    await user.click(within(data).getByRole("row", { name: "Credentials" }));
    expect(await screen.findByRole("heading", { name: "Credentials" })).toBeInTheDocument();
    await waitFor(() => expect(api.listCredentials).toHaveBeenCalledOnce());
  });

  it.each([
    ["dark", "icon1a-dark.png"],
    ["light", "icon1a-light.png"],
    ["passion", "passion.png"],
  ] as const)("uses the native %s application icon for the sidebar brand mark", async (icon, fileName) => {
    renderNavigation(true, icon);

    const image = document.querySelector<HTMLImageElement>(".brand-mark__image");
    expect(image).not.toBeNull();
    await waitFor(() => expect(image).toHaveAttribute("src", expect.stringContaining(fileName)));
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveAttribute("draggable", "false");
  });

  it("shows labels as tooltips only while collapsed and keeps disabled items inactive", async () => {
    const user = userEvent.setup();
    const onViewChange = renderNavigation(false);
    const generateItem = screen.getByRole("row", { name: "Generate" });

    expect(generateItem).toHaveAttribute("aria-disabled", "true");
    const tooltipTrigger = generateItem.querySelector("[data-slot=tooltip-trigger]");
    expect(tooltipTrigger).not.toBeNull();
    expect(tooltipTrigger?.querySelector('[data-slot="sidebar-menu-item-content"]')).not.toBeNull();
    if (!(tooltipTrigger instanceof HTMLElement)) throw new Error("Generate tooltip trigger is missing");
    await user.hover(tooltipTrigger);
    expect(await screen.findByRole("tooltip", {}, { timeout: 2_000 })).toHaveTextContent("Generate");

    await user.unhover(tooltipTrigger);
    const sessionsItem = screen.getByRole("row", { name: "Sessions" });
    const sessionsTooltipTrigger = sessionsItem.querySelector("[data-slot=tooltip-trigger]");
    if (!(sessionsTooltipTrigger instanceof HTMLElement)) throw new Error("Sessions tooltip trigger is missing");
    await user.hover(sessionsTooltipTrigger);
    expect(await screen.findByRole("tooltip", {}, { timeout: 2_000 })).toHaveTextContent("Sessions");

    await user.unhover(sessionsTooltipTrigger);
    const beaconsItem = screen.getByRole("row", { name: "Beacons" });
    const beaconsTooltipTrigger = beaconsItem.querySelector("[data-slot=tooltip-trigger]");
    if (!(beaconsTooltipTrigger instanceof HTMLElement)) throw new Error("Beacons tooltip trigger is missing");
    await user.hover(beaconsTooltipTrigger);
    expect(await screen.findByRole("tooltip", {}, { timeout: 2_000 })).toHaveTextContent("Beacons");

    await user.click(generateItem);
    expect(onViewChange).not.toHaveBeenCalled();

    cleanup();
    renderNavigation(true);
    const expandedItem = screen.getByRole("row", { name: "Generate" });
    await user.hover(expandedItem);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("keeps interaction and stored operator data in distinct desktop sidebar sections", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      managedServer: null,
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
    };
    snapshot.domains.sessions.page = { limit: 500, total: 501, truncated: true };
    snapshot.domains.beacons.page = { limit: 500, total: 702, truncated: true };
    const onViewChange = vi.fn();

    render(
      <Sidebar.Provider collapsible="icon" open>
        <Sidebar className="app-sidebar">
          <NavigationContent
            snapshot={snapshot}
            view="operations"
            onDisconnect={vi.fn()}
            onExitApp={vi.fn()}
            onSettings={vi.fn()}
            onSwitchConfig={vi.fn()}
            onViewChange={onViewChange}
          />
        </Sidebar>
      </Sidebar.Provider>,
    );

    const infrastructure = screen.getByRole("treegrid", { name: "Operational navigation" });
    const interact = screen.getByRole("treegrid", { name: "Interact navigation" });
    const data = screen.getByRole("treegrid", { name: "Data navigation" });
    expect(within(infrastructure).getAllByRole("row").map((row) => row.getAttribute("aria-label"))).toEqual([
      "Generate",
      "Builds & profiles",
      "Jobs & listeners",
    ]);
    expect(within(infrastructure).queryByRole("row", { name: "Sessions" })).not.toBeInTheDocument();
    expect(within(infrastructure).queryByRole("row", { name: "Beacons" })).not.toBeInTheDocument();
    expect(within(infrastructure).queryByRole("row", { name: "Loot" })).not.toBeInTheDocument();
    const sessionsItem = within(interact).getByRole("row", { name: "Sessions" });
    const beaconsItem = within(interact).getByRole("row", { name: "Beacons" });
    expect(sessionsItem).toBeInTheDocument();
    expect(beaconsItem).toBeInTheDocument();
    expect(within(sessionsItem).getByText("501")).toBeInTheDocument();
    expect(within(beaconsItem).getByText("702")).toBeInTheDocument();
    expect(screen.getByText("Interact")).toBeInTheDocument();
    expect(within(data).getByRole("row", { name: "Loot" })).toBeInTheDocument();
    expect(within(data).getByRole("row", { name: "Credentials" })).toBeInTheDocument();
    expect(within(data).queryByRole("row", { name: "Sessions" })).not.toBeInTheDocument();
    expect(screen.getByText("Data")).toBeInTheDocument();

    await user.click(sessionsItem);
    expect(onViewChange).toHaveBeenCalledWith("sessions");
    await user.click(beaconsItem);
    expect(onViewChange).toHaveBeenCalledWith("beacons");
    await user.click(within(data).getByRole("row", { name: "Loot" }));
    expect(onViewChange).toHaveBeenCalledWith("loot");
    await user.click(within(data).getByRole("row", { name: "Credentials" }));
    expect(onViewChange).toHaveBeenCalledWith("credentials");
  });

  it("keeps Sessions current while an exact row opens the dedicated session workspace", async () => {
    const user = userEvent.setup();
    const session: SessionSummary = {
      mode: "session",
      id: "session-1",
      name: "payments",
      hostname: "prod-mac",
      hostId: "host-1",
      username: "alice",
      os: "darwin",
      arch: "arm64",
      transport: "mtls",
      remoteAddress: "127.0.0.1:4444",
      activeC2: "mtls://127.0.0.1:4444",
      executable: "/tmp/agent",
      version: "1.7.6",
      locale: "en-US",
      integrity: "High",
      burned: false,
      pid: 4001,
      liveness: "active",
    };
    const ref: TargetRef = {
      mode: "session",
      id: session.id,
      backendEpoch: 7,
      domainRevision: 3,
      fingerprint: "a".repeat(64),
    };
    const initial = disconnectedSnapshot();
    initial.connection = {
      managedServer: null,
      status: "connected",
      server: "127.0.0.1:53137",
      operator: "alice",
      configName: "M2 test",
      version: "1.7.6",
      epoch: 7,
      incarnation: 4,
    };
    initial.sessions = [session];
    initial.domains.sessions = {
      status: "ready",
      revision: 3,
      items: [session],
      page: { limit: 500, total: 1, truncated: false },
    };
    initial.targetContext.selectableTargets = [ref];
    const selected: SliverSnapshot = {
      ...initial,
      targetContext: {
        status: "selected",
        activeTarget: ref,
        activeTargetSummary: session,
        selectableTargets: [ref],
        capabilities: [
          { id: "target.ping", available: true },
          { id: "target.rename", available: true },
          { id: "target.environment.write", available: true },
          { id: "target.terminate", available: true },
          { id: "session.close", available: true },
        ],
        beaconWatch: false,
      },
    };
    let emitSnapshot: ((next: SliverSnapshot) => void) | undefined;
    const api = installSliverAPI(
      vi.fn().mockResolvedValue({ ok: true, value: [] }),
      initial,
      (listener) => {
        emitSnapshot = listener;
      },
    );
    vi.mocked(api.selectTarget).mockResolvedValue({ ok: true, value: selected });
    vi.mocked(api.listTargetOperations).mockResolvedValue({
      ok: true,
      value: { items: [], page: { limit: 100, total: 0, truncated: false } },
    });

    render(<App />);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument());
    const interact = screen.getByRole("treegrid", { name: "Interact navigation" });
    await user.click(within(interact).getByRole("row", { name: "Sessions" }));
    await user.click(await screen.findByRole("row", { name: /payments/i }));

    expect(await screen.findByRole("heading", { name: "payments" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Live sessions" })).not.toBeInTheDocument();
    expect(within(interact).getByRole("row", { name: "Sessions" })).toHaveAttribute("data-current", "true");

    const replacementRef = { ...ref, fingerprint: "b".repeat(64) };
    await act(async () => {
      emitSnapshot?.({
        ...selected,
        targetContext: {
          ...selected.targetContext,
          activeTarget: replacementRef,
          selectableTargets: [replacementRef],
        },
      });
    });
    expect(await screen.findByRole("heading", { name: "Session workspace unavailable" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to live sessions" }));
    expect(await screen.findByRole("heading", { name: "Live sessions" })).toBeInTheDocument();
  });

  it("opens a selected beacon in the dedicated async task workspace and returns to the catalog", async () => {
    const user = userEvent.setup();
    const beacon: BeaconSummary = {
      mode: "beacon",
      id: "beacon-1",
      name: "warehouse",
      hostname: "edge-linux",
      hostId: "host-2",
      username: "bob",
      os: "linux",
      arch: "amd64",
      transport: "mtls",
      remoteAddress: "127.0.0.1:4444",
      activeC2: "mtls://127.0.0.1:4444",
      executable: "/tmp/agent",
      version: "1.7.6",
      locale: "en-US",
      integrity: "High",
      burned: false,
      pid: 4002,
      checkinStatus: "on-time",
      nextCheckinAt: "2026-08-09T20:02:00.000Z",
      intervalMs: 8_000,
      jitterMs: 0,
    };
    const ref: TargetRef = {
      mode: "beacon",
      id: beacon.id,
      backendEpoch: 7,
      domainRevision: 4,
      fingerprint: "b".repeat(64),
    };
    const initial = disconnectedSnapshot();
    initial.connection = {
      managedServer: null,
      status: "connected",
      server: "127.0.0.1:53137",
      operator: "alice",
      configName: "M2 test",
      version: "1.7.6",
      epoch: 7,
      incarnation: 4,
    };
    initial.beacons = [beacon];
    initial.domains.beacons = {
      status: "ready",
      revision: 4,
      items: [beacon],
      page: { limit: 500, total: 1, truncated: false },
    };
    initial.targetContext.selectableTargets = [ref];
    const selected: SliverSnapshot = {
      ...initial,
      targetContext: {
        status: "selected",
        activeTarget: ref,
        activeTargetSummary: beacon,
        selectableTargets: [ref],
        capabilities: [
          { id: "target.task.execute", available: true },
          { id: "target.terminate", available: true },
          { id: "beacon.remove", available: true },
          { id: "beacon.tasks.read", available: true },
          { id: "beacon.tasks.cancel", available: true },
        ],
        beaconWatch: false,
      },
    };
    const api = installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }), initial);
    vi.mocked(api.selectTarget).mockResolvedValue({ ok: true, value: selected });
    vi.mocked(api.listTargetOperations).mockResolvedValue({
      ok: true,
      value: { items: [], page: { limit: 100, total: 0, truncated: false } },
    });
    vi.mocked(api.listBeaconTasks).mockResolvedValue({
      ok: true,
      value: { items: [], page: { limit: 100, total: 0, truncated: false } },
    });

    render(<App />);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument());
    const interact = screen.getByRole("treegrid", { name: "Interact navigation" });
    await user.click(within(interact).getByRole("row", { name: "Beacons" }));
    await user.click(await screen.findByRole("row", { name: /warehouse/i }));

    expect(await screen.findByRole("heading", { name: "Async task workspace" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Task queue" })).toBeInTheDocument();
    expect(screen.queryByRole("grid", { name: "Sliver beacons" })).not.toBeInTheDocument();
    expect(within(interact).getByRole("row", { name: "Beacons" })).toHaveAttribute("data-current", "true");

    await user.click(screen.getByRole("button", { name: "Back to live beacons" }));
    expect(await screen.findByRole("heading", { name: "Live beacons" })).toBeInTheDocument();
  });

  it("keeps the Interact section actionable in the mobile sheet", async () => {
    const originalMatchMedia = globalThis.matchMedia;
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      }),
    });
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      managedServer: null,
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
    };
    const onViewChange = vi.fn();

    function MobileProbe() {
      const { isMobile } = useSidebar();
      return <span>{isMobile ? "mobile-ready" : "desktop-ready"}</span>;
    }

    try {
      render(
        <Sidebar.Provider collapsible="icon" defaultOpen>
          <MobileProbe />
          <Sidebar.Trigger aria-label="Open mobile navigation" />
          <Sidebar.Mobile backdrop="blur" className="app-sidebar">
            <NavigationContent
              snapshot={snapshot}
              view="operations"
              onDisconnect={vi.fn()}
              onExitApp={vi.fn()}
              onSettings={vi.fn()}
              onSwitchConfig={vi.fn()}
              onViewChange={onViewChange}
            />
          </Sidebar.Mobile>
        </Sidebar.Provider>,
      );

      await screen.findByText("mobile-ready");
      await user.click(screen.getByRole("button", { name: "Open mobile navigation" }));
      const infrastructure = await screen.findByRole("treegrid", { name: "Operational navigation" });
      const interact = await screen.findByRole("treegrid", { name: "Interact navigation" });
      const data = await screen.findByRole("treegrid", { name: "Data navigation" });
      expect(within(infrastructure).getByRole("row", { name: "Jobs & listeners" })).toBeInTheDocument();
      expect(within(infrastructure).getByRole("row", { name: "Generate" })).toBeInTheDocument();
      expect(within(infrastructure).getByRole("row", { name: "Builds & profiles" })).toBeInTheDocument();
      expect(within(interact).getByRole("row", { name: "Sessions" })).toBeInTheDocument();
      expect(within(data).getByRole("row", { name: "Loot" })).toBeInTheDocument();
      expect(within(data).getByRole("row", { name: "Credentials" })).toBeInTheDocument();
      await user.click(within(interact).getByRole("row", { name: "Beacons" }));
      expect(onViewChange).toHaveBeenCalledWith("beacons");
      await waitFor(() => expect(screen.queryByRole("treegrid", { name: "Interact navigation" })).not.toBeInTheDocument());
    } finally {
      Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: originalMatchMedia });
    }
  });

  it("keeps the current-server menu actionable in the collapsed rail", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      managedServer: null,
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
    };
    const onSwitchConfig = vi.fn();

    render(
      <Sidebar.Provider collapsible="icon" open={false}>
        <Sidebar className="app-sidebar">
          <NavigationContent
            snapshot={snapshot}
            view="operations"
            onDisconnect={vi.fn()}
            onExitApp={vi.fn()}
            onSettings={vi.fn()}
            onSwitchConfig={onSwitchConfig}
            onViewChange={vi.fn()}
          />
        </Sidebar>
      </Sidebar.Provider>,
    );

    const trigger = screen.getByRole("button", { name: "Current server: alice" });
    expect(trigger).toHaveClass("button--icon-only");
    expect(trigger).not.toHaveClass("button--full-width");
    expect(trigger.querySelector(".connection-summary__menu-icon")).not.toHaveClass("ms-auto");
    await user.hover(trigger);
    expect(await screen.findByRole("tooltip", {}, { timeout: 2_000 })).toHaveTextContent("Application menu");
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Switch config" }));
    expect(onSwitchConfig).toHaveBeenCalledOnce();
  });
});

describe("WindowMenu", () => {
  it("shows the native new-window shortcut in its tooltip", async () => {
    const user = userEvent.setup();
    render(<WindowMenu connected onOpenWindow={vi.fn().mockResolvedValue(undefined)} />);

    await user.hover(screen.getByRole("button", { name: "New window options" }));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("New window");
    expect(within(tooltip).getByLabelText(/(?:Command|Ctrl) \+ N/u)).toBeInTheDocument();
  });

  it("offers only a different-server window while disconnected", async () => {
    const user = userEvent.setup();
    const onOpenWindow = vi.fn().mockResolvedValue(undefined);
    render(<WindowMenu connected={false} onOpenWindow={onOpenWindow} />);

    await user.click(screen.getByRole("button", { name: "New window options" }));

    expect(screen.queryByRole("menuitem", { name: "Same server" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Different server" }));
    expect(onOpenWindow).toHaveBeenCalledWith(false);
  });

  it("offers same-server and different-server windows while connected", async () => {
    const user = userEvent.setup();
    const onOpenWindow = vi.fn().mockResolvedValue(undefined);
    render(<WindowMenu connected onOpenWindow={onOpenWindow} />);

    await user.click(screen.getByRole("button", { name: "New window options" }));
    const differentServer = screen.getByRole("menuitem", { name: "Different server" });
    const sameServer = screen.getByRole("menuitem", { name: "Same server" });
    expect(within(differentServer).getByLabelText(/(?:Command|Ctrl) \+ N/u)).toBeInTheDocument();
    expect(within(sameServer).getByLabelText(/(?:Command|Ctrl) \+ Shift \+ N/u)).toBeInTheDocument();
    await user.click(sameServer);
    expect(onOpenWindow).toHaveBeenCalledWith(true);
  });
});
