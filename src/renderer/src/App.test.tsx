import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar, useSidebar } from "@heroui-pro/react/sidebar";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot, SLIVER_PROTOCOL_BASELINE_COMMIT } from "../../shared/contracts";
import type {
  OperationResult,
  SavedConfigSummary,
  SliverDesktopAPI,
  SliverSnapshot,
} from "../../shared/contracts";
import type { SessionSummary, TargetRef } from "../../shared/target-contracts";
import { App, ConnectionMenu, NavigationContent, WindowMenu } from "./App";

beforeAll(() => {
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
    chooseConfig: vi.fn(failedOperation),
    chooseCertificatePair: vi.fn(failedOperation),
    backgroundTarget: vi.fn(failedOperation),
    cancelBeaconTask: vi.fn(failedOperation),
    cancelTargetOperation: vi.fn(failedOperation),
    connectSavedConfig: vi.fn(failedOperation),
    deleteBuild: vi.fn(failedOperation),
    deleteProfile: vi.fn(failedOperation),
    disconnect: vi.fn(failedOperation),
    downloadBuild: vi.fn(failedOperation),
    exitApp: vi.fn(failedOperation),
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
    getTerminalRuntime: vi.fn(failedOperation),
    getSnapshot: vi.fn().mockResolvedValue(initialSnapshot),
    getTargetOperation: vi.fn(failedOperation),
    getExecutionResult: vi.fn(failedOperation),
    importConfig: vi.fn(failedOperation),
    listExecutionCatalog: vi.fn(failedOperation),
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
    openStream: vi.fn(),
    openConsoleStream: vi.fn(),
    onOperationChanged: vi.fn(() => vi.fn()),
    onSnapshotChanged: vi.fn((listener: (snapshot: SliverSnapshot) => void) => {
      captureSnapshotListener?.(listener);
      return vi.fn();
    }),
    openInteractionWindow: vi.fn(failedOperation),
    claimInteractionWindow: vi.fn(failedOperation),
    openSessionShellWindow: vi.fn(failedOperation),
    claimSessionShellWindow: vi.fn(failedOperation),
    openConsoleWindow: vi.fn(failedOperation),
    claimConsoleWindow: vi.fn(failedOperation),
    createConsoleTab: vi.fn(failedOperation),
    closeConsoleTab: vi.fn(failedOperation),
    onConsoleNewTabRequested: vi.fn(() => vi.fn()),
    onConsoleCloseTabRequested: vi.fn(() => vi.fn()),
    onConsoleSettingsRequested: vi.fn(() => vi.fn()),
    openWindow: vi.fn(failedOperation),
    prepareStopAllJobs: vi.fn(failedOperation),
    prepareStopJob: vi.fn(failedOperation),
    prepareExecutionAction: vi.fn(failedOperation),
    prepareTargetAction: vi.fn(failedOperation),
    refresh: vi.fn(failedOperation),
    removeSavedConfig: vi.fn(failedOperation),
    saveProfile: vi.fn(failedOperation),
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
    expect(screen.getByRole("button", { name: "Saved configurations" })).toBeInTheDocument();
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

  it("keeps an operationally degraded backend usable without showing a compatibility notice", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      status: "degraded",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.6.0",
      error: "Compiler inventory refresh failed",
    };
    installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }), snapshot);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Jobs & listeners" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Server build mismatch" })).not.toBeInTheDocument();
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

  it("shows a mismatched-server notice once per connection epoch and keeps it dismissed on refresh", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    const mismatchReason = "Sliver 1.7.6 is a modified build and has not been verified against the pinned baseline";
    snapshot.connection = {
      status: "degraded",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6 (dirty)",
      epoch: 41,
      error: mismatchReason,
      capabilities: {
        compatibility: "degraded",
        baselineCommit: SLIVER_PROTOCOL_BASELINE_COMMIT,
        serverVersion: "1.7.6 (dirty)",
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
    const api = installSliverAPI(
      vi.fn().mockResolvedValue({ ok: true, value: [] }),
      snapshot,
      (listener) => {
        emitSnapshot = listener;
      },
    );
    vi.mocked(api.refresh).mockResolvedValue({ ok: true, value: snapshot });

    render(<App />);

    const dialog = await screen.findByRole("dialog", { name: "Server build mismatch" });
    expect(dialog.querySelector('[data-slot="modal-body"]')).toHaveClass("flex", "flex-col", "gap-3");
    expect(within(dialog).getByText("1.7.6 (dirty)")).toBeInTheDocument();
    expect(within(dialog).getByText(SLIVER_PROTOCOL_BASELINE_COMMIT.slice(0, 12))).toBeInTheDocument();
    expect(dialog).toHaveTextContent(mismatchReason);
    expect(dialog).not.toHaveTextContent("Current M0 features remain available");
    const header = document.querySelector<HTMLElement>(".app-header");
    if (!header) throw new Error("Application header is missing");
    expect(within(header).queryByText("Backend degraded")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Server build mismatch" })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Refresh server state" }));
    await waitFor(() => expect(api.refresh).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog", { name: "Server build mismatch" })).not.toBeInTheDocument();

    if (!emitSnapshot) throw new Error("Snapshot listener was not installed");
    emitSnapshot({
      ...snapshot,
      connection: { ...snapshot.connection, status: "reconnecting" },
    });
    expect(screen.queryByRole("dialog", { name: "Server build mismatch" })).not.toBeInTheDocument();

    emitSnapshot({
      ...snapshot,
      connection: { ...snapshot.connection, epoch: 42 },
    });
    expect(await screen.findByRole("dialog", { name: "Server build mismatch" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Server build mismatch" })).not.toBeInTheDocument();
    });
  });

  it("disconnects the active backend from the current-server menu", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "alice",
      configName: "Production",
      version: "1.7.6",
    };
    const api = installSliverAPI(vi.fn().mockResolvedValue({ ok: true, value: [] }), snapshot);
    vi.mocked(api.disconnect).mockResolvedValue({ ok: true, value: disconnectedSnapshot() });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Jobs & listeners" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
    });

    await user.click(screen.getAllByRole("button", { name: "Current server: alice" })[0]!);
    await user.click(await screen.findByRole("menuitem", { name: "Disconnect" }));

    await waitFor(() => expect(api.disconnect).toHaveBeenCalledOnce());
    expect(await screen.findByRole("dialog", { name: "Saved configurations" })).toBeInTheDocument();
    expect(screen.queryByText("Connect an operator configuration")).not.toBeInTheDocument();
  });

  it("opens a dedicated console for the active server without renderer-authored config arguments", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
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
    await user.click(consoleButton);

    expect(api.openConsoleWindow).toHaveBeenCalledExactlyOnceWith();
  });

  it("keeps the saved configuration selector closed across a delayed connecting snapshot", async () => {
    const connected = disconnectedSnapshot();
    connected.connection = {
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

    expect(await screen.findByRole("heading", { name: "Jobs & listeners" })).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "Jobs & listeners" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Saved configurations" })).not.toBeInTheDocument();
  });

  it("reopens the saved configuration selector when connecting ends disconnected", async () => {
    const connected = disconnectedSnapshot();
    connected.connection = {
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

    expect(await screen.findByRole("heading", { name: "Jobs & listeners" })).toBeInTheDocument();
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

    expect(await screen.findByRole("heading", { name: "Jobs & listeners" })).toBeInTheDocument();
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

    expect(await screen.findByRole("heading", { name: "Jobs & listeners" })).toBeInTheDocument();
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
  it("opens from the server summary and owns switch-config, disconnect, and exit actions", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
      status: "connected",
      server: "sliver.example.test:31337",
      operator: "m0-manual-verification",
      configName: "M0 manual verification",
      version: "1.7.6",
    };
    const onSwitchConfig = vi.fn();
    const onDisconnect = vi.fn();
    const onExitApp = vi.fn();

    render(
      <ConnectionMenu
        snapshot={snapshot}
        onDisconnect={onDisconnect}
        onExitApp={onExitApp}
        onSwitchConfig={onSwitchConfig}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Current server: m0-manual-verification" });
    expect(trigger.querySelectorAll('[data-sidebar="label"]')).toHaveLength(2);
    expect(screen.queryByRole("menuitem", { name: "Switch config" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Exit app" })).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Switch config",
      "Disconnect",
      "Exit app",
    ]);
    await user.click(await screen.findByRole("menuitem", { name: "Switch config" }));
    expect(onSwitchConfig).toHaveBeenCalledOnce();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onExitApp).not.toHaveBeenCalled();

    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
    expect(onDisconnect).toHaveBeenCalledOnce();

    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Exit app" }));
    expect(onExitApp).toHaveBeenCalledOnce();
  });

  it("leaves the offline summary noninteractive", () => {
    render(
      <ConnectionMenu
        snapshot={disconnectedSnapshot()}
        onDisconnect={vi.fn()}
        onExitApp={vi.fn()}
        onSwitchConfig={vi.fn()}
      />,
    );

    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Current server:/ })).not.toBeInTheDocument();
  });
});

describe("Sidebar navigation", () => {
  function renderNavigation(open: boolean) {
    const onViewChange = vi.fn();
    render(
      <Sidebar.Provider collapsible="icon" open={open}>
        <Sidebar className="app-sidebar">
          <NavigationContent
            snapshot={disconnectedSnapshot()}
            view="operations"
            onDisconnect={vi.fn()}
            onExitApp={vi.fn()}
            onSwitchConfig={vi.fn()}
            onViewChange={onViewChange}
          />
        </Sidebar>
      </Sidebar.Provider>,
    );
    return onViewChange;
  }

  it("uses the approved Sliver creature glyph for the sidebar brand mark", () => {
    renderNavigation(true);

    const image = document.querySelector<HTMLImageElement>(".brand-mark__image");
    expect(image).not.toBeNull();
    expect(image).toHaveAttribute("src", expect.stringContaining("sliver-sidebar.png"));
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveAttribute("draggable", "false");
  });

  it("shows labels as tooltips only while collapsed and keeps disabled items inactive", async () => {
    const user = userEvent.setup();
    const onViewChange = renderNavigation(false);
    const generateItem = screen.getByRole("row", { name: "Generate" });
    const tooltipTrigger = generateItem.querySelector<HTMLElement>("[data-slot=tooltip-trigger]");

    expect(generateItem).toHaveAttribute("aria-disabled", "true");
    expect(tooltipTrigger).not.toBeNull();
    if (!tooltipTrigger) throw new Error("Generate tooltip trigger is missing");
    await user.hover(tooltipTrigger);
    expect(await screen.findByRole("tooltip", {}, { timeout: 2_000 })).toHaveTextContent("Generate");

    await user.unhover(tooltipTrigger);
    const sessionsItem = screen.getByRole("row", { name: "Sessions" });
    const sessionsTooltipTrigger = sessionsItem.querySelector<HTMLElement>("[data-slot=tooltip-trigger]");
    expect(sessionsTooltipTrigger).not.toBeNull();
    if (!sessionsTooltipTrigger) throw new Error("Sessions tooltip trigger is missing");
    await user.hover(sessionsTooltipTrigger);
    expect(await screen.findByRole("tooltip", {}, { timeout: 2_000 })).toHaveTextContent("Sessions");

    await user.unhover(sessionsTooltipTrigger);
    const beaconsItem = screen.getByRole("row", { name: "Beacons" });
    const beaconsTooltipTrigger = beaconsItem.querySelector<HTMLElement>("[data-slot=tooltip-trigger]");
    expect(beaconsTooltipTrigger).not.toBeNull();
    if (!beaconsTooltipTrigger) throw new Error("Beacons tooltip trigger is missing");
    await user.hover(beaconsTooltipTrigger);
    expect(await screen.findByRole("tooltip", {}, { timeout: 2_000 })).toHaveTextContent("Beacons");

    await user.click(generateItem);
    expect(onViewChange).not.toHaveBeenCalled();

    cleanup();
    renderNavigation(true);
    const expandedItem = screen.getByRole("row", { name: "Generate" });
    expect(expandedItem.querySelector("[data-slot=tooltip-trigger]")).toBeNull();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("places Sessions and Beacons in a distinct Interact section on the desktop sidebar", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = {
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
            onSwitchConfig={vi.fn()}
            onViewChange={onViewChange}
          />
        </Sidebar>
      </Sidebar.Provider>,
    );

    const infrastructure = screen.getByRole("treegrid", { name: "Infrastructure navigation" });
    const interact = screen.getByRole("treegrid", { name: "Interact navigation" });
    expect(within(infrastructure).getByRole("row", { name: "Jobs & listeners" })).toBeInTheDocument();
    expect(within(infrastructure).getByRole("row", { name: "Generate" })).toBeInTheDocument();
    expect(within(infrastructure).getByRole("row", { name: "Builds & profiles" })).toBeInTheDocument();
    expect(within(infrastructure).queryByRole("row", { name: "Sessions" })).not.toBeInTheDocument();
    expect(within(infrastructure).queryByRole("row", { name: "Beacons" })).not.toBeInTheDocument();
    const sessionsItem = within(interact).getByRole("row", { name: "Sessions" });
    const beaconsItem = within(interact).getByRole("row", { name: "Beacons" });
    expect(sessionsItem).toBeInTheDocument();
    expect(beaconsItem).toBeInTheDocument();
    expect(within(sessionsItem).getByText("501")).toBeInTheDocument();
    expect(within(beaconsItem).getByText("702")).toBeInTheDocument();
    expect(screen.getByText("Interact")).toBeInTheDocument();

    await user.click(sessionsItem);
    expect(onViewChange).toHaveBeenCalledWith("sessions");
    await user.click(beaconsItem);
    expect(onViewChange).toHaveBeenCalledWith("beacons");
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
              onSwitchConfig={vi.fn()}
              onViewChange={onViewChange}
            />
          </Sidebar.Mobile>
        </Sidebar.Provider>,
      );

      await screen.findByText("mobile-ready");
      await user.click(screen.getByRole("button", { name: "Open mobile navigation" }));
      const infrastructure = await screen.findByRole("treegrid", { name: "Infrastructure navigation" });
      const interact = await screen.findByRole("treegrid", { name: "Interact navigation" });
      expect(within(infrastructure).getByRole("row", { name: "Jobs & listeners" })).toBeInTheDocument();
      expect(within(infrastructure).getByRole("row", { name: "Generate" })).toBeInTheDocument();
      expect(within(infrastructure).getByRole("row", { name: "Builds & profiles" })).toBeInTheDocument();
      expect(within(interact).getByRole("row", { name: "Sessions" })).toBeInTheDocument();
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
            onSwitchConfig={onSwitchConfig}
            onViewChange={vi.fn()}
          />
        </Sidebar>
      </Sidebar.Provider>,
    );

    await user.click(screen.getByRole("button", { name: "Current server: alice" }));
    await user.click(await screen.findByRole("menuitem", { name: "Switch config" }));
    expect(onSwitchConfig).toHaveBeenCalledOnce();
  });
});

describe("WindowMenu", () => {
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
    expect(screen.getByRole("menuitem", { name: "Different server" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Same server" }));
    expect(onOpenWindow).toHaveBeenCalledWith(true);
  });
});
