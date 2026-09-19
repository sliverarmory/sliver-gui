import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../../shared/application-settings-contracts";
import type { SliverDesktopAPI, SliverSnapshot } from "../../../shared/contracts";
import type {
  BeaconSummary,
  SessionSummary,
  TargetActionPlan,
  TargetCapabilityState,
  TargetRef,
} from "../../../shared/target-contracts";
import type { BeaconTaskDetail, TargetOperationRecord } from "../../../shared/operation-contracts";
import type {
  ExecutionActionPlan,
  ExecutionCapability,
  ExecutionCatalog,
} from "../../../shared/execution-contracts";
import { SessionWorkspacePage } from "./SessionWorkspacePage";
import { TargetsPage } from "./TargetsPage";
import { renderWithApplicationContextMenu as render } from "../application-context-menu-test-utils";

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
  firstContactAt: "2026-08-09T20:00:00.000Z",
  lastCheckinAt: "2026-08-09T20:01:00.000Z",
  reconnectIntervalMs: 60_000,
  liveness: "active",
};

const beacon: BeaconSummary = {
  ...session,
  mode: "beacon",
  id: "beacon-1",
  name: "warehouse",
  hostname: "edge-linux",
  hostId: "host-2",
  username: "bob",
  os: "linux",
  arch: "amd64",
  checkinStatus: "on-time",
  nextCheckinAt: "2026-08-09T20:02:00.000Z",
  intervalMs: 8_000,
  jitterMs: 0,
  taskCount: 3,
  completedTaskCount: 2,
  nonCompletedTaskCount: 1,
};

const sessionRef: TargetRef = {
  mode: "session",
  id: session.id,
  backendEpoch: 7,
  domainRevision: 3,
  fingerprint: "a".repeat(64),
};

const beaconRef: TargetRef = {
  mode: "beacon",
  id: beacon.id,
  backendEpoch: 7,
  domainRevision: 4,
  fingerprint: "b".repeat(64),
};

const executionBackend = {
  configId: "config-1",
  configName: "M1 test",
  server: "127.0.0.1:53137",
  operator: "m1-verification",
  epoch: 7,
};

function beaconExecutionCapability(): ExecutionCapability {
  return {
    operationId: "privilege.revert",
    available: true,
    modes: ["beacon"],
    platforms: ["linux"],
    risk: "mutating",
    confirmationRequired: true,
    credentialBearing: false,
    artifacts: [],
  };
}

function beaconExecutionCatalog(ref: TargetRef = beaconRef): ExecutionCatalog {
  return {
    target: beacon,
    targetRef: ref,
    backend: executionBackend,
    capabilities: [beaconExecutionCapability()],
  };
}

function beaconExecutionPlan(): ExecutionActionPlan {
  return {
    token: "beacon-execution-plan",
    operationId: "privilege.revert",
    expiresAt: "2026-08-15T23:00:00.000Z",
    risk: "mutating",
    target: { backend: executionBackend, target: beacon, fingerprint: beaconRef.fingerprint },
    warning: "This operation changes the selected beacon identity.",
    fields: [],
    artifacts: [],
  };
}

const capabilities: TargetCapabilityState[] = [
  "target.ping",
  "target.rename",
  "target.terminate",
  "target.task.execute",
  "target.environment.write",
  "session.close",
  "beacon.remove",
  "beacon.reconfigure",
  "beacon.open-session",
  "beacon.tasks.read",
  "beacon.tasks.cancel",
].map((id) => ({ id: id as TargetCapabilityState["id"], available: true }));

function targetSnapshot(active: "session" | "beacon" | "none" = "none"): SliverSnapshot {
  const snapshot = disconnectedSnapshot();
  snapshot.connection = {
    managedServer: null,
    status: "connected",
    server: "127.0.0.1:53137",
    operator: "m1-verification",
    configName: "M1 test",
    version: "1.7.6",
    epoch: 7,
  };
  snapshot.sessions = [session];
  snapshot.beacons = [beacon];
  snapshot.operators = [
    { id: "operator-1", name: "m1-verification", online: true },
    { id: "operator-2", name: "external", online: false },
  ];
  snapshot.domains.sessions = {
    status: "ready",
    revision: 3,
    items: [session],
    page: { limit: 500, total: 1, truncated: false },
  };
  snapshot.domains.beacons = {
    status: "ready",
    revision: 4,
    items: [beacon],
    page: { limit: 500, total: 1, truncated: false },
  };
  snapshot.domains.operators = {
    status: "ready",
    revision: 2,
    items: snapshot.operators,
    page: { limit: 500, total: 2, truncated: false },
  };
  snapshot.targetContext = {
    status: active === "none" ? "none" : "selected",
    activeTarget: active === "session" ? sessionRef : active === "beacon" ? beaconRef : null,
    activeTargetSummary: active === "session" ? session : active === "beacon" ? beacon : null,
    selectableTargets: [sessionRef, beaconRef],
    capabilities: active === "none" ? [] : capabilities,
    beaconWatch: false,
  };
  return snapshot;
}

function operationRecord(overrides: Partial<TargetOperationRecord> = {}): TargetOperationRecord {
  return {
    requestId: "request-1",
    operationId: "target.ping",
    target: sessionRef,
    targetName: session.name,
    backend: {
      configId: "config-1",
      configName: "M1 test",
      server: "127.0.0.1:53137",
      operator: "m1-verification",
      epoch: 7,
    },
    ownership: {
      origin: "local",
      ownerWindowId: 12,
      actor: { attribution: "verified", name: "m1-verification" },
    },
    mode: "session",
    state: "completed",
    attempts: 1,
    createdAt: "2026-08-09T20:02:00.000Z",
    updatedAt: "2026-08-09T20:02:01.000Z",
    finishedAt: "2026-08-09T20:02:01.000Z",
    disposition: { kind: "inline-text", text: "Round-trip: 2 ms", truncated: false },
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function installAPI(overrides: Partial<SliverDesktopAPI> = {}): SliverDesktopAPI {
  const failed = async () => ({ ok: false as const, error: "Not implemented by this test" });
  const api: SliverDesktopAPI = {
    backgroundTarget: vi.fn(failed),
    cancelBeaconTask: vi.fn(failed),
    cancelTargetOperation: vi.fn(failed),
    chooseCertificatePair: vi.fn(failed),
    chooseConfig: vi.fn(failed),
    connectSavedConfig: vi.fn(failed),
    deleteBuild: vi.fn(failed),
    deleteProfile: vi.fn(failed),
    deleteLoot: vi.fn(failed),
    deleteCredential: vi.fn(failed),
    disconnect: vi.fn(failed),
    downloadBuild: vi.fn(failed),
    downloadLoot: vi.fn(failed),
    exitApp: vi.fn(failed),
    getApplicationSettings: vi.fn().mockResolvedValue(DEFAULT_APPLICATION_SETTINGS_STATE),
    getApplicationIcon: vi.fn().mockResolvedValue("dark"),
    onApplicationIconChanged: vi.fn(() => vi.fn()),
    updateApplicationSettings: vi.fn(failed),
    getApplicationUpdateState: vi.fn().mockResolvedValue({
      status: "disabled",
      revision: 0,
      currentVersion: "0.1.0",
      disabledReason: "Updates are not under test.",
    }),
    checkForApplicationUpdates: vi.fn(failed),
    restartToApplyApplicationUpdate: vi.fn(failed),
    executeStopPlan: vi.fn(failed),
    executeTargetActionPlan: vi.fn(failed),
    executeSessionDestructiveActionPlan: vi.fn(failed),
    generate: vi.fn(failed),
    generateFromProfile: vi.fn(failed),
    getBeaconTask: vi.fn(failed),
    getLootDetail: vi.fn(failed),
    revealCredentialSecret: vi.fn(failed),
    getTerminalRuntime: vi.fn(failed),
    getSnapshot: vi.fn().mockResolvedValue(disconnectedSnapshot()),
    getTargetOperation: vi.fn(failed),
    getExecutionResult: vi.fn(failed),
    importConfig: vi.fn(failed),
    listExecutionCatalog: vi.fn(failed),
    listLoot: vi.fn(failed),
    listCredentials: vi.fn(failed),
    listLocalNetworkInterfaces: vi.fn(failed),
    listBeaconTasks: vi.fn().mockResolvedValue({
      ok: true,
      value: { items: [], page: { limit: 100, total: 0, truncated: false } },
    }),
    listSavedConfigs: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    listSessionShells: vi.fn(failed),
    listTargets: vi.fn().mockResolvedValue({
      ok: true,
      value: { items: [], page: { limit: 100, total: 0, truncated: false } },
    }),
    listTargetOperations: vi.fn().mockResolvedValue({
      ok: true,
      value: { items: [], page: { limit: 100, total: 0, truncated: false } },
    }),
    onBeaconTasksInvalidated: vi.fn(() => vi.fn()),
    onSessionShellsChanged: vi.fn(() => vi.fn()),
    onReleaseDownloadChanged: vi.fn(() => vi.fn()),
    onApplicationUpdateChanged: vi.fn(() => vi.fn()),
    onApplicationSettingsChanged: vi.fn(() => vi.fn()),
    onCommandPaletteRequested: vi.fn(() => vi.fn()),
    openStream: vi.fn(),
    openConsoleStream: vi.fn(),
    onOperationChanged: vi.fn(() => vi.fn()),
    onSnapshotChanged: vi.fn(() => vi.fn()),
    openInteractionWindow: vi.fn(failed),
    openCloudDeploymentWindow: vi.fn(failed),
    claimInteractionWindow: vi.fn(failed),
    openSessionShellWindow: vi.fn(failed),
    claimSessionShellWindow: vi.fn(failed),
    openConsoleWindow: vi.fn(failed),
    claimConsoleWindow: vi.fn(failed),
    createConsoleTab: vi.fn(failed),
    closeConsoleTab: vi.fn(failed),
    onConsoleNewTabRequested: vi.fn(() => vi.fn()),
    onConsoleCloseTabRequested: vi.fn(() => vi.fn()),
    onConsoleSelectTabRequested: vi.fn(() => vi.fn()),
    onConsoleSettingsRequested: vi.fn(() => vi.fn()),
    openWindow: vi.fn(failed),
    prepareStopAllJobs: vi.fn(failed),
    prepareStopJob: vi.fn(failed),
    prepareExecutionAction: vi.fn(failed),
    prepareTargetAction: vi.fn(failed),
    prepareSessionDestructiveAction: vi.fn(failed),
    prepareSessionShell: vi.fn(failed),
    refresh: vi.fn(failed),
    removeSavedConfig: vi.fn(failed),
    runSessionWorkbench: vi.fn(failed),
    runExecutionRead: vi.fn(failed),
    actOnSessionShell: vi.fn(failed),
    saveProfile: vi.fn(failed),
    addLoot: vi.fn(failed),
    renameLoot: vi.fn(failed),
    addCredential: vi.fn(failed),
    copyCredentialSecret: vi.fn(failed),
    clearCredentialClipboard: vi.fn(failed),
    selectTarget: vi.fn(failed),
    setBeaconWatch: vi.fn(failed),
    setStagedBuilds: vi.fn(failed),
    startListener: vi.fn(failed),
    submitTargetOperation: vi.fn(failed),
    executeExecutionPlan: vi.fn(failed),
    discardExecutionPlan: vi.fn(failed),
    saveExecutionResult: vi.fn(failed),
    ...overrides,
  };
  Object.defineProperty(window, "sliver", { configurable: true, value: api });
  return api;
}

function sessionWorkspace(snapshot: SliverSnapshot, onSnapshot = vi.fn()): React.JSX.Element {
  const activeSession = snapshot.targetContext.activeTargetSummary?.mode === "session"
    ? snapshot.targetContext.activeTargetSummary
    : null;
  return (
    <SessionWorkspacePage
      route={{
        sessionId: session.id,
        backendEpoch: 7,
        connectionIncarnation: snapshot.connection.incarnation ?? 0,
        targetFingerprint: sessionRef.fingerprint,
      }}
      session={activeSession}
      snapshot={snapshot}
      onBack={vi.fn()}
      onSnapshot={onSnapshot}
    />
  );
}

describe("TargetsPage", () => {
  it("pops out a catalog beacon interaction and keeps the dedicated surface focused", async () => {
    const user = userEvent.setup();
    const openInteractionWindow = vi.fn().mockResolvedValue({ ok: true });
    const listExecutionCatalog = vi.fn().mockResolvedValue({ ok: true, value: beaconExecutionCatalog() });
    installAPI({ listExecutionCatalog, openInteractionWindow });
    const snapshot = targetSnapshot("beacon");
    const { rerender } = render(
      <TargetsPage mode="beacon" snapshot={snapshot} onSnapshot={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "Pop out interaction" }));
    expect(openInteractionWindow).toHaveBeenCalledOnce();
    expect(openInteractionWindow).toHaveBeenCalledWith();

    rerender(
      <TargetsPage
        expectedTarget={beaconRef}
        mode="beacon"
        presentation="dedicated"
        snapshot={snapshot}
        onSnapshot={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "warehouse" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Async task workspace" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Queue a beacon task" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Task queue" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Task completion" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "All target operations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Operator presence" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Execution workbench" })).not.toBeInTheDocument();
    expect(screen.queryByRole("grid", { name: "Sliver beacons" })).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Filter beacons" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Background target" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pop out interaction" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Execution" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show advanced execution" }));
    expect(await screen.findByRole("heading", { name: "Execution workbench" })).toBeInTheDocument();
    expect(listExecutionCatalog).toHaveBeenCalledOnce();
  });

  it("opens beacon execution in a controlled right sheet and tears down its plan on exact-target change", async () => {
    const user = userEvent.setup();
    const reviewedPlan = beaconExecutionPlan();
    const listExecutionCatalog = vi.fn().mockResolvedValue({ ok: true, value: beaconExecutionCatalog() });
    const prepareExecutionAction = vi.fn().mockResolvedValue({ ok: true, value: reviewedPlan });
    const discardExecutionPlan = vi.fn().mockResolvedValue({ ok: true });
    installAPI({ discardExecutionPlan, listExecutionCatalog, prepareExecutionAction });
    const { rerender } = render(
      <TargetsPage mode="beacon" snapshot={targetSnapshot("beacon")} onSnapshot={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "Execution" }));
    const sheet = await screen.findByRole("dialog", { name: "Beacon execution" });
    expect(within(sheet).getByText("Actions remain pinned to the exact selected beacon and backend incarnation.")).toBeInTheDocument();
    expect(await within(sheet).findByRole("heading", { name: "Execution workbench" })).toBeInTheDocument();
    await user.click(within(sheet).getByRole("radio", { name: "Identity" }));
    await user.click(within(sheet).getByRole("button", { name: "Open: Revert identity" }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByRole("alertdialog", { name: "Execute this reviewed action?" });
    expect(prepareExecutionAction).toHaveBeenCalledWith({
      draft: { operationId: "privilege.revert", timeoutSeconds: 30 },
    });

    const replacement = targetSnapshot("beacon");
    const replacementRef: TargetRef = { ...beaconRef, fingerprint: "e".repeat(64) };
    replacement.targetContext.activeTarget = replacementRef;
    replacement.targetContext.selectableTargets = [sessionRef, replacementRef];
    rerender(<TargetsPage mode="beacon" snapshot={replacement} onSnapshot={vi.fn()} />);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Beacon execution" })).not.toBeInTheDocument());
    expect(screen.queryByRole("alertdialog", { name: "Execute this reviewed action?" })).not.toBeInTheDocument();
    await waitFor(() => expect(discardExecutionPlan).toHaveBeenCalledExactlyOnceWith({ token: reviewedPlan.token }));
    expect(listExecutionCatalog).toHaveBeenCalledOnce();
  });

  it("queues a common beacon command and refreshes the selected completion after check-in", async () => {
    const user = userEvent.setup();
    let invalidateTasks: ((target: TargetRef) => void) | undefined;
    let queued = false;
    let task: BeaconTaskDetail = {
      taskId: "task-pwd-1",
      beaconId: beacon.id,
      state: "pending",
      description: "Read working directory",
      createdAt: "2026-08-09T20:03:00.000Z",
      resultAvailable: false,
      cancellation: { available: true },
      localRequestId: "request-pwd-1",
      operationId: "beacon.filesystem.pwd",
      ownership: {
        origin: "local",
        ownerWindowId: 12,
        actor: { attribution: "verified", name: "m1-verification" },
      },
    };
    const submitted = operationRecord({
      requestId: "request-pwd-1",
      operationId: "beacon.filesystem.pwd",
      target: beaconRef,
      targetName: beacon.name,
      mode: "beacon",
      state: "submitted",
      taskId: task.taskId,
    });
    const submitTargetOperation = vi.fn().mockImplementation(async () => {
      queued = true;
      return { ok: true as const, value: submitted };
    });
    const listBeaconTasks = vi.fn().mockImplementation(async () => ({
      ok: true as const,
      value: {
        items: queued ? [task] : [],
        page: { limit: 100, total: queued ? 1 : 0, truncated: false },
      },
    }));
    const getBeaconTask = vi.fn().mockImplementation(async () => ({ ok: true as const, value: task }));
    installAPI({
      getBeaconTask,
      listBeaconTasks,
      submitTargetOperation,
      onBeaconTasksInvalidated: vi.fn((listener) => {
        invalidateTasks = listener;
        return vi.fn();
      }),
    });

    const { rerender } = render(
      <TargetsPage
        expectedTarget={beaconRef}
        mode="beacon"
        presentation="dedicated"
        snapshot={targetSnapshot("beacon")}
        onSnapshot={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Queue task" }));
    await waitFor(() => expect(submitTargetOperation).toHaveBeenCalledWith({ operationId: "beacon.filesystem.pwd" }));
    expect(await screen.findByRole("row", { name: /task-pwd-1/i })).toBeInTheDocument();
    expect(await screen.findByText("Waiting for the beacon")).toBeInTheDocument();
    expect(getBeaconTask).toHaveBeenCalledWith({ taskId: "task-pwd-1" });

    task = {
      ...task,
      state: "sent",
      sentAt: "2026-08-09T20:03:30.000Z",
      cancellation: { available: false, reason: "The task has already been sent" },
    };
    const sentSnapshot = targetSnapshot("beacon");
    sentSnapshot.targetContext.capabilities = sentSnapshot.targetContext.capabilities.map((capability) =>
      capability.id === "beacon.tasks.read"
        ? {
            ...capability,
            reason: { code: "target-state-unknown", message: "Task catalog metadata refreshed" },
          }
        : capability
    );
    rerender(
      <TargetsPage
        expectedTarget={beaconRef}
        mode="beacon"
        presentation="dedicated"
        snapshot={sentSnapshot}
        onSnapshot={vi.fn()}
      />,
    );
    await act(async () => invalidateTasks?.(beaconRef));

    await waitFor(() => expect(getBeaconTask).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("heading", { name: "Select a task" })).not.toBeInTheDocument();
    expect(screen.getByText("Waiting for the beacon")).toBeInTheDocument();

    task = {
      ...task,
      state: "completed",
      completedAt: "2026-08-09T20:04:00.000Z",
      resultAvailable: true,
      cancellation: { available: false, reason: "Only pending tasks can be canceled" },
      disposition: {
        kind: "structured-detail",
        title: "Working directory",
        fields: [{ label: "Path", value: "/opt/sliver" }],
        truncated: false,
      },
    };
    const completedSnapshot = targetSnapshot("beacon");
    completedSnapshot.targetContext.capabilities = completedSnapshot.targetContext.capabilities.map((capability) =>
      capability.id === "beacon.tasks.read"
        ? {
            ...capability,
            reason: { code: "target-state-unknown", message: "Task completion metadata refreshed" },
          }
        : capability
    );
    rerender(
      <TargetsPage
        expectedTarget={beaconRef}
        mode="beacon"
        presentation="dedicated"
        snapshot={completedSnapshot}
        onSnapshot={vi.fn()}
      />,
    );
    await act(async () => invalidateTasks?.(beaconRef));

    expect(await screen.findByText("/opt/sliver")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Select a task" })).not.toBeInTheDocument();
    await waitFor(() => expect(getBeaconTask).toHaveBeenCalledTimes(3));
  });

  it("reconciles a completion that arrives before the initial pending task detail", async () => {
    const user = userEvent.setup();
    let invalidateTasks: ((target: TargetRef) => void) | undefined;
    const pending: BeaconTaskDetail = {
      taskId: "task-race-1",
      beaconId: beacon.id,
      state: "pending",
      description: "Read working directory",
      createdAt: "2026-08-09T20:03:00.000Z",
      resultAvailable: false,
      cancellation: { available: true },
      operationId: "beacon.filesystem.pwd",
      ownership: {
        origin: "local",
        ownerWindowId: 12,
        actor: { attribution: "verified", name: "m1-verification" },
      },
    };
    const completed: BeaconTaskDetail = {
      ...pending,
      state: "completed",
      completedAt: "2026-08-09T20:04:00.000Z",
      resultAvailable: true,
      cancellation: { available: false },
      disposition: {
        kind: "structured-detail",
        title: "Working directory",
        fields: [{ label: "Path", value: "/srv/race-complete" }],
        truncated: false,
      },
    };
    let summary: BeaconTaskDetail = pending;
    const firstDetail = deferred<Awaited<ReturnType<SliverDesktopAPI["getBeaconTask"]>>>();
    const getBeaconTask = vi.fn()
      .mockReturnValueOnce(firstDetail.promise)
      .mockResolvedValue({ ok: true, value: completed });
    installAPI({
      getBeaconTask,
      listBeaconTasks: vi.fn().mockImplementation(async () => ({
        ok: true as const,
        value: { items: [summary], page: { limit: 100, total: 1, truncated: false } },
      })),
      onBeaconTasksInvalidated: vi.fn((listener) => {
        invalidateTasks = listener;
        return vi.fn();
      }),
    });

    render(
      <TargetsPage
        expectedTarget={beaconRef}
        mode="beacon"
        presentation="dedicated"
        snapshot={targetSnapshot("beacon")}
        onSnapshot={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("row", { name: /task-race-1/i }));
    await waitFor(() => expect(getBeaconTask).toHaveBeenCalledTimes(1));
    summary = completed;
    await act(async () => invalidateTasks?.(beaconRef));
    firstDetail.resolve({ ok: true, value: pending });

    expect(await screen.findByText("/srv/race-complete")).toBeInTheDocument();
    expect(getBeaconTask).toHaveBeenCalledTimes(2);
  });

  it("configures a directory listing from the beacon command autocomplete", async () => {
    const user = userEvent.setup();
    const submitTargetOperation = vi.fn().mockResolvedValue({
      ok: true,
      value: operationRecord({
        requestId: "request-ls-1",
        operationId: "beacon.filesystem.ls",
        target: beaconRef,
        targetName: beacon.name,
        mode: "beacon",
        state: "submitted",
        taskId: "task-ls-1",
      }),
    });
    installAPI({ submitTargetOperation });

    render(
      <TargetsPage
        expectedTarget={beaconRef}
        mode="beacon"
        presentation="dedicated"
        snapshot={targetSnapshot("beacon")}
        onSnapshot={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Working directory.*Command/i }));
    await user.click(await screen.findByRole("option", { name: /List directory/i }));
    const path = screen.getByRole("textbox", { name: "Path" });
    await user.clear(path);
    await user.type(path, "/var/tmp");
    await user.click(screen.getByRole("button", { name: "Queue task" }));

    await waitFor(() => expect(submitTargetOperation).toHaveBeenCalledWith({
      operationId: "beacon.filesystem.ls",
      path: "/var/tmp",
    }));

    await user.click(screen.getByRole("button", { name: /List directory.*Command/i }));
    await user.click(await screen.findByRole("option", { name: /List processes/i }));
    await user.click(screen.getByRole("switch", { name: "Include full process details" }));
    await user.click(screen.getByRole("button", { name: "Queue task" }));
    await waitFor(() => expect(submitTargetOperation).toHaveBeenCalledWith({
      operationId: "beacon.process.list",
      fullInfo: true,
    }));

    await user.click(screen.getByRole("button", { name: /List processes.*Command/i }));
    await user.click(await screen.findByRole("option", { name: /Network interfaces/i }));
    await user.click(screen.getByRole("button", { name: "Queue task" }));
    await waitFor(() => expect(submitTargetOperation).toHaveBeenCalledWith({
      operationId: "beacon.network.interfaces",
    }));
  });

  it("does not claim queue insertion when submission returns no exact task ID", async () => {
    const user = userEvent.setup();
    const listBeaconTasks = vi.fn().mockResolvedValue({
      ok: true,
      value: { items: [], page: { limit: 100, total: 0, truncated: false } },
    });
    const submitTargetOperation = vi.fn().mockResolvedValue({
      ok: true,
      value: operationRecord({
        requestId: "request-unknown-1",
        operationId: "beacon.filesystem.pwd",
        target: beaconRef,
        targetName: beacon.name,
        mode: "beacon",
        state: "outcome-unknown",
        message: "The server did not return a task ID.",
      }),
    });
    installAPI({ listBeaconTasks, submitTargetOperation });

    render(
      <TargetsPage
        expectedTarget={beaconRef}
        mode="beacon"
        presentation="dedicated"
        snapshot={targetSnapshot("beacon")}
        onSnapshot={vi.fn()}
      />,
    );
    await waitFor(() => expect(listBeaconTasks).toHaveBeenCalled());
    const refreshCountBeforeSubmit = listBeaconTasks.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Queue task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The server did not return a task ID.");
    expect(listBeaconTasks).toHaveBeenCalledTimes(refreshCountBeforeSubmit);
  });

  it("quarantines a dedicated beacon interaction when its exact identity changes", () => {
    const api = installAPI();
    const snapshot = targetSnapshot("beacon");
    const { rerender } = render(
      <TargetsPage
        expectedTarget={beaconRef}
        mode="beacon"
        presentation="dedicated"
        snapshot={snapshot}
        onSnapshot={vi.fn()}
      />,
    );

    const refreshed = targetSnapshot("beacon");
    const refreshedRef = { ...beaconRef, domainRevision: beaconRef.domainRevision + 1 };
    refreshed.targetContext.activeTarget = refreshedRef;
    refreshed.targetContext.selectableTargets = [sessionRef, refreshedRef];
    rerender(
      <TargetsPage
        expectedTarget={beaconRef}
        mode="beacon"
        presentation="dedicated"
        snapshot={refreshed}
        onSnapshot={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "warehouse" })).toBeInTheDocument();

    const changed = targetSnapshot("beacon");
    const changedRef = { ...refreshedRef, fingerprint: "f".repeat(64) };
    changed.targetContext.activeTarget = changedRef;
    changed.targetContext.selectableTargets = [sessionRef, changedRef];
    rerender(
      <TargetsPage
        expectedTarget={beaconRef}
        mode="beacon"
        presentation="dedicated"
        snapshot={changed}
        onSnapshot={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Beacon interaction unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run ping" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Beacon tasks" })).not.toBeInTheDocument();
    expect(api.openInteractionWindow).not.toHaveBeenCalled();
  });

  it("isolates each route from the other target domain and hides an active target of the other mode", () => {
    installAPI();
    const snapshot = targetSnapshot("beacon");
    snapshot.domains.beacons = {
      ...snapshot.domains.beacons,
      status: "error",
      error: "Beacon inventory failed",
    };
    snapshot.targetContext.unavailableReason = "The active beacon is unavailable";

    render(<TargetsPage mode="session" snapshot={snapshot} onSnapshot={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("grid", { name: "Sliver sessions" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /payments/i })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /warehouse/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Beacon inventory failed")).not.toBeInTheDocument();
    expect(screen.queryByText("Select a session")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run ping" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("filters the bounded inventory and selects the exact authoritative target reference", async () => {
    const user = userEvent.setup();
    const nextSnapshot = targetSnapshot("beacon");
    const selectTarget = vi.fn().mockResolvedValue({ ok: true, value: nextSnapshot });
    const listTargets = vi.fn(async (request: Parameters<SliverDesktopAPI["listTargets"]>[0]) => ({
      ok: true as const,
      value: {
        items: request.mode === "beacon" ? [{ target: beacon, ref: beaconRef }] : [],
        page: {
          limit: 100,
          total: request.mode === "beacon" ? 1 : 0,
          truncated: false,
        },
      },
    }));
    installAPI({ listTargets, selectTarget });
    const onSnapshot = vi.fn();

    render(<TargetsPage mode="beacon" snapshot={targetSnapshot()} onSnapshot={onSnapshot} />);

    expect(screen.queryByRole("row", { name: /payments/i })).not.toBeInTheDocument();
    expect(screen.getByRole("row", { name: /warehouse/i })).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Filter beacons" }), "warehouse");
    expect(screen.queryByRole("row", { name: /payments/i })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("row", { name: /warehouse/i }));

    await waitFor(() => expect(listTargets).toHaveBeenCalledWith({ mode: "beacon", limit: 100, query: "warehouse" }));
    await waitFor(() => expect(selectTarget).toHaveBeenCalledWith(beaconRef));
    expect(selectTarget).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledWith(nextSnapshot);
    expect(screen.getByText("m1-verification")).toBeInTheDocument();
  });

  it("opens the session workspace only after the main process confirms the exact session reference", async () => {
    const user = userEvent.setup();
    const selected = targetSnapshot("session");
    const selectTarget = vi.fn().mockResolvedValue({ ok: true, value: selected });
    const onSnapshot = vi.fn();
    const onOpenSession = vi.fn();
    installAPI({ selectTarget });

    render(
      <TargetsPage
        mode="session"
        snapshot={targetSnapshot()}
        onOpenSession={onOpenSession}
        onSnapshot={onSnapshot}
      />,
    );

    await user.click(screen.getByRole("row", { name: /payments/i }));

    await waitFor(() => expect(selectTarget).toHaveBeenCalledWith(sessionRef));
    expect(onSnapshot).toHaveBeenCalledWith(selected);
    expect(onOpenSession).toHaveBeenCalledWith(session, sessionRef);
    expect(onOpenSession).toHaveBeenCalledOnce();
  });

  it("renames the right-clicked session without opening its interaction workspace", async () => {
    const user = userEvent.setup();
    const secondSession: SessionSummary = { ...session, id: "session-2", name: "secondary" };
    const secondRef: TargetRef = { ...sessionRef, id: secondSession.id, fingerprint: "c".repeat(64) };
    const initial = targetSnapshot("session");
    initial.sessions = [session, secondSession];
    initial.domains.sessions.items = [session, secondSession];
    initial.domains.sessions.page.total = 2;
    initial.targetContext.selectableTargets.push(secondRef);
    const selected: SliverSnapshot = {
      ...initial,
      targetContext: { ...initial.targetContext, activeTarget: secondRef, activeTargetSummary: secondSession },
    };
    const selectTarget = vi.fn().mockResolvedValue({ ok: true, value: selected });
    const submitTargetOperation = vi.fn().mockResolvedValue({
      ok: true,
      value: operationRecord({ operationId: "target.rename", target: secondRef, targetName: secondSession.name }),
    });
    installAPI({ selectTarget, submitTargetOperation });
    const onOpenSession = vi.fn();
    const onSnapshot = (next: SliverSnapshot) => rendered.rerender(
      <TargetsPage mode="session" snapshot={next} onSnapshot={onSnapshot} onOpenSession={onOpenSession} />,
    );
    const rendered = render(
      <TargetsPage mode="session" snapshot={initial} onSnapshot={onSnapshot} onOpenSession={onOpenSession} />,
    );

    const row = screen.getByRole("row", { name: /secondary/i });
    await user.pointer({ target: row, keys: "[MouseRight]" });
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(selectTarget).not.toHaveBeenCalled();
    const sessionActions = within(menu).getAllByRole("menuitem")
      .map((item) => item.textContent)
      .filter((label) => label === "Rename" || label === "Close Session" || label === "Kill Session");
    expect(sessionActions).toEqual([
      "Rename",
      "Close Session",
      "Kill Session",
    ]);
    await user.click(within(menu).getByRole("menuitem", { name: "Rename" }));

    const dialog = await screen.findByRole("dialog", { name: "Rename session" });
    expect(selectTarget).toHaveBeenCalledExactlyOnceWith(secondRef);
    expect(onOpenSession).not.toHaveBeenCalled();
    const input = within(dialog).getByRole("textbox", { name: "Session name" });
    expect(input).toHaveValue("secondary");
    await user.clear(input);
    await user.type(input, "secondary-renamed");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(submitTargetOperation).toHaveBeenCalledExactlyOnceWith({
      operationId: "target.rename",
      name: "secondary-renamed",
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename session" })).not.toBeInTheDocument());
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it.each([
    { label: "Kill Session", actionId: "target.kill" as const, review: "Review kill target" },
    { label: "Close Session", actionId: "session.close" as const, review: "Review close session" },
  ])("reviews $label for the right-clicked session without opening its workspace or executing", async ({ label, actionId, review }) => {
    const user = userEvent.setup();
    const secondSession: SessionSummary = { ...session, id: "session-2", name: "secondary" };
    const secondRef: TargetRef = { ...sessionRef, id: secondSession.id, fingerprint: "c".repeat(64) };
    const initial = targetSnapshot("session");
    initial.sessions = [session, secondSession];
    initial.domains.sessions.items = [session, secondSession];
    initial.domains.sessions.page.total = 2;
    initial.targetContext.selectableTargets.push(secondRef);
    const selected: SliverSnapshot = {
      ...initial,
      targetContext: { ...initial.targetContext, activeTarget: secondRef, activeTargetSummary: secondSession },
    };
    const plan: TargetActionPlan = {
      token: "session-row-plan",
      expiresAt: "2026-08-09T20:10:00.000Z",
      impact: {
        actionId,
        backend: { ...executionBackend, sharedWindowCount: 1 },
        targets: [secondSession],
        totalTargets: 1,
        truncated: false,
        warning: "Review the selected session before continuing.",
      },
    };
    const api = installAPI({
      selectTarget: vi.fn().mockResolvedValue({ ok: true, value: selected }),
      prepareTargetAction: vi.fn().mockResolvedValue({ ok: true, value: plan }),
    });
    const onOpenSession = vi.fn();
    const onSnapshot = (next: SliverSnapshot) => rendered.rerender(
      <TargetsPage mode="session" snapshot={next} onSnapshot={onSnapshot} onOpenSession={onOpenSession} />,
    );
    const rendered = render(
      <TargetsPage mode="session" snapshot={initial} onSnapshot={onSnapshot} onOpenSession={onOpenSession} />,
    );

    fireEvent.contextMenu(screen.getByRole("row", { name: /secondary/i }));
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(api.selectTarget).not.toHaveBeenCalled();
    await user.click(within(menu).getByRole("menuitem", { name: label }));

    const dialog = await screen.findByRole("dialog", { name: review });
    expect(api.selectTarget).toHaveBeenCalledExactlyOnceWith(secondRef);
    expect(api.prepareTargetAction).toHaveBeenCalledExactlyOnceWith({ actionId });
    expect(within(dialog).getByText(/secondary/)).toBeInTheDocument();
    expect(api.executeTargetActionPlan).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it.each([
    { label: "Kill Session", capabilityId: "target.terminate" },
    { label: "Close Session", capabilityId: "session.close" },
  ])("disables $label when unavailable and rechecks capabilities after row selection", async ({ label, capabilityId }) => {
    const user = userEvent.setup();
    const unavailable = targetSnapshot("session");
    unavailable.targetContext.capabilities = capabilities.map((capability) => capability.id === capabilityId
      ? { id: capability.id, available: false, reason: { code: "target-dead", message: "The session is no longer interactive" } }
      : capability);
    const api = installAPI({ selectTarget: vi.fn().mockResolvedValue({ ok: true, value: unavailable }) });
    const rendered = render(<TargetsPage mode="session" snapshot={unavailable} onSnapshot={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("row", { name: /payments/i }));
    rendered.contextMenu.emit();
    expect(await screen.findByRole("menuitem", { name: label })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    rendered.rerender(<TargetsPage mode="session" snapshot={targetSnapshot()} onSnapshot={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("row", { name: /payments/i }));
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: label }));
    await waitFor(() => expect(api.selectTarget).toHaveBeenCalledExactlyOnceWith(sessionRef));
    expect(api.prepareTargetAction).not.toHaveBeenCalled();
    expect(api.executeTargetActionPlan).not.toHaveBeenCalled();
  });

  it("cancels a session rename opened from a table cell without submitting", async () => {
    const user = userEvent.setup();
    const snapshot = targetSnapshot("session");
    const api = installAPI({ selectTarget: vi.fn().mockResolvedValue({ ok: true, value: snapshot }) });
    const rendered = render(<TargetsPage mode="session" snapshot={snapshot} onSnapshot={vi.fn()} />);
    const row = screen.getByRole("row", { name: /payments/i });
    fireEvent.contextMenu(within(row).getByRole("gridcell", { name: /prod-mac/i }));
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    await user.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename session" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename session" })).not.toBeInTheDocument());
    expect(api.submitTargetOperation).not.toHaveBeenCalled();
  });

  it("does not retain row session actions on the table header or background", async () => {
    const user = userEvent.setup();
    installAPI();
    const rendered = render(<TargetsPage mode="session" snapshot={targetSnapshot("session")} onSnapshot={vi.fn()} />);
    const row = screen.getByRole("row", { name: /payments/i });
    fireEvent.contextMenu(row);
    rendered.contextMenu.emit();
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    fireEvent.contextMenu(screen.getByRole("columnheader", { name: "Host & user" }));
    rendered.contextMenu.emit();
    const headerMenu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(headerMenu).queryByRole("menuitem", { name: /Rename|Kill Session|Close Session/ })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    fireEvent.contextMenu(screen.getByRole("heading", { name: "Live sessions" }));
    rendered.contextMenu.emit();
    const backgroundMenu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(backgroundMenu).queryByRole("menuitem", { name: /Rename|Kill Session|Close Session/ })).not.toBeInTheDocument();
  });

  it.each(["Rename", "Kill Session", "Close Session"])("discards a row %s selection reply after a reconnect", async (label) => {
    const user = userEvent.setup();
    const gate = deferred<Awaited<ReturnType<SliverDesktopAPI["selectTarget"]>>>();
    const selectTarget = vi.fn().mockImplementation(() => gate.promise);
    const api = installAPI({ selectTarget });
    const onSnapshot = vi.fn();
    const initial = targetSnapshot("session");
    initial.connection.incarnation = 1;
    const rendered = render(<TargetsPage mode="session" snapshot={initial} onSnapshot={onSnapshot} />);
    fireEvent.contextMenu(screen.getByRole("row", { name: /payments/i }));
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: label }));
    await waitFor(() => expect(selectTarget).toHaveBeenCalledExactlyOnceWith(sessionRef));

    const reconnected = targetSnapshot("session");
    reconnected.connection.incarnation = 2;
    rendered.rerender(<TargetsPage mode="session" snapshot={reconnected} onSnapshot={onSnapshot} />);
    await act(async () => {
      gate.resolve({ ok: true, value: initial });
      await gate.promise;
    });
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(api.prepareTargetAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Rename session" })).not.toBeInTheDocument();
  });

  it.each(["Rename", "Kill Session", "Close Session"])("discards a row %s selection reply after the catalog unmounts", async (label) => {
    const user = userEvent.setup();
    const gate = deferred<Awaited<ReturnType<SliverDesktopAPI["selectTarget"]>>>();
    const selectTarget = vi.fn().mockImplementation(() => gate.promise);
    const api = installAPI({ selectTarget });
    const onSnapshot = vi.fn();
    const snapshot = targetSnapshot("session");
    const rendered = render(<TargetsPage mode="session" snapshot={snapshot} onSnapshot={onSnapshot} />);
    fireEvent.contextMenu(screen.getByRole("row", { name: /payments/i }));
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: label }));
    await waitFor(() => expect(selectTarget).toHaveBeenCalledExactlyOnceWith(sessionRef));

    rendered.unmount();
    await act(async () => {
      gate.resolve({ ok: true, value: snapshot });
      await gate.promise;
    });
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(api.prepareTargetAction).not.toHaveBeenCalled();
  });

  it.each(["Rename", "Kill Session", "Close Session"])("rejects a row %s response that confirms a replacement session", async (label) => {
    const user = userEvent.setup();
    const initial = targetSnapshot("session");
    const replacement = targetSnapshot("session");
    replacement.targetContext.activeTarget = { ...sessionRef, fingerprint: "e".repeat(64) };
    const selectTarget = vi.fn().mockResolvedValue({ ok: true, value: replacement });
    const api = installAPI({ selectTarget });
    const onSnapshot = vi.fn();
    const rendered = render(<TargetsPage mode="session" snapshot={initial} onSnapshot={onSnapshot} />);
    fireEvent.contextMenu(screen.getByRole("row", { name: /payments/i }));
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: label }));
    await waitFor(() => expect(selectTarget).toHaveBeenCalledExactlyOnceWith(sessionRef));
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(api.prepareTargetAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Rename session" })).not.toBeInTheDocument();
  });

  it("opens an already-selected session through the explicit interaction action", async () => {
    const user = userEvent.setup();
    const selected = targetSnapshot("session");
    const selectTarget = vi.fn().mockResolvedValue({ ok: true, value: selected });
    const onOpenSession = vi.fn();
    installAPI({ selectTarget });

    render(
      <TargetsPage
        mode="session"
        snapshot={selected}
        onOpenSession={onOpenSession}
        onSnapshot={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Interact with payments" }));

    await waitFor(() => expect(selectTarget).toHaveBeenCalledWith(sessionRef));
    expect(selectTarget).toHaveBeenCalledOnce();
    expect(onOpenSession).toHaveBeenCalledWith(session, sessionRef);
    expect(onOpenSession).toHaveBeenCalledOnce();
  });

  it("does not open a session workspace when the selection response confirms another target", async () => {
    const user = userEvent.setup();
    const selected = targetSnapshot("beacon");
    const onOpenSession = vi.fn();
    installAPI({ selectTarget: vi.fn().mockResolvedValue({ ok: true, value: selected }) });

    render(
      <TargetsPage
        mode="session"
        snapshot={targetSnapshot()}
        onOpenSession={onOpenSession}
        onSnapshot={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("row", { name: /payments/i }));
    await waitFor(() => expect(window.sliver.selectTarget).toHaveBeenCalledWith(sessionRef));
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("does not open a same-ID replacement when the selected fingerprint differs from the clicked row", async () => {
    const user = userEvent.setup();
    const selected = targetSnapshot("session");
    selected.targetContext.activeTarget = {
      ...sessionRef,
      fingerprint: "f".repeat(64),
    };
    selected.targetContext.selectableTargets = [selected.targetContext.activeTarget];
    const onOpenSession = vi.fn();
    installAPI({ selectTarget: vi.fn().mockResolvedValue({ ok: true, value: selected }) });

    render(
      <TargetsPage
        mode="session"
        snapshot={targetSnapshot()}
        onOpenSession={onOpenSession}
        onSnapshot={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("row", { name: /payments/i }));
    await waitFor(() => expect(window.sliver.selectTarget).toHaveBeenCalledWith(sessionRef));
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("loads and selects target 501 through the opaque target catalog cursor", async () => {
    const user = userEvent.setup();
    const snapshot = targetSnapshot();
    const target501: SessionSummary = {
      ...session,
      id: "session-0500",
      name: "catalog-target-501",
      hostname: "paged-host",
    };
    const target501Ref: TargetRef = {
      mode: "session",
      id: target501.id,
      backendEpoch: 7,
      domainRevision: 3,
      fingerprint: "c".repeat(64),
    };
    snapshot.domains.sessions.page = {
      limit: 500,
      total: 501,
      truncated: true,
      nextCursor: "target:v1:11111111-1111-4111-8111-111111111111",
    };
    const listTargets = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        items: [{ target: target501, ref: target501Ref }],
        page: { limit: 100, total: 501, truncated: false },
      },
    });
    const selectTarget = vi.fn().mockResolvedValue({ ok: true, value: targetSnapshot("session") });
    installAPI({ listTargets, selectTarget });

    render(<TargetsPage mode="session" snapshot={snapshot} onSnapshot={vi.fn()} />);

    expect(screen.getByText("Showing 1 of 501 sessions")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more sessions" }));
    await waitFor(() => expect(listTargets).toHaveBeenCalledWith({
      mode: "session",
      cursor: "target:v1:11111111-1111-4111-8111-111111111111",
      limit: 100,
    }));
    const row = await screen.findByRole("row", { name: /catalog-target-501/i });
    await user.click(row);
    await waitFor(() => expect(selectTarget).toHaveBeenCalledWith(target501Ref));
  });

  it("retains loaded session pages across beacon churn and reseeds on a session revision", async () => {
    const user = userEvent.setup();
    const snapshot = targetSnapshot();
    const pagedSession: SessionSummary = {
      ...session,
      id: "session-0500",
      name: "retained-session-page",
    };
    snapshot.domains.sessions.page = {
      limit: 500,
      total: 501,
      truncated: true,
      nextCursor: "session-page-cursor",
    };
    const listTargets = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        items: [{ target: pagedSession, ref: { ...sessionRef, id: pagedSession.id } }],
        page: { limit: 100, total: 501, truncated: false },
      },
    });
    installAPI({ listTargets });

    const { rerender } = render(<TargetsPage mode="session" snapshot={snapshot} onSnapshot={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Load more sessions" }));
    expect(await screen.findByRole("row", { name: /retained-session-page/i })).toBeInTheDocument();

    const beaconChurn: SliverSnapshot = {
      ...snapshot,
      domains: {
        ...snapshot.domains,
        beacons: { ...snapshot.domains.beacons, revision: snapshot.domains.beacons.revision + 1 },
      },
    };
    rerender(<TargetsPage mode="session" snapshot={beaconChurn} onSnapshot={vi.fn()} />);
    expect(screen.getByRole("row", { name: /retained-session-page/i })).toBeInTheDocument();

    const sessionRefresh: SliverSnapshot = {
      ...beaconChurn,
      domains: {
        ...beaconChurn.domains,
        sessions: { ...beaconChurn.domains.sessions, revision: beaconChurn.domains.sessions.revision + 1 },
      },
    };
    rerender(<TargetsPage mode="session" snapshot={sessionRefresh} onSnapshot={vi.fn()} />);
    await waitFor(() => {
      expect(screen.queryByRole("row", { name: /retained-session-page/i })).not.toBeInTheDocument();
    });
    expect(listTargets).toHaveBeenCalledOnce();
  });

  it("settles base paging after search mode churn and permits a retry", async () => {
    const user = userEvent.setup();
    const snapshot = targetSnapshot();
    snapshot.domains.sessions.page = {
      limit: 500,
      total: 502,
      truncated: true,
      nextCursor: "base-cursor-1",
    };
    const firstBasePage = deferred<Awaited<ReturnType<SliverDesktopAPI["listTargets"]>>>();
    const listTargets = vi.fn((request: Parameters<SliverDesktopAPI["listTargets"]>[0]) => {
      if (request.cursor === "base-cursor-1" && request.query === undefined) {
        return firstBasePage.promise;
      }
      if (request.query !== undefined) {
        return Promise.resolve({
          ok: true as const,
          value: {
            items: [],
            page: { limit: 100, total: 0, truncated: false },
          },
        });
      }
      if (request.cursor === "base-cursor-2") {
        return Promise.resolve({
          ok: true as const,
          value: {
            items: [],
            page: { limit: 100, total: 502, truncated: false },
          },
        });
      }
      throw new Error(`Unexpected target request: ${JSON.stringify(request)}`);
    });
    installAPI({ listTargets });

    render(<TargetsPage mode="session" snapshot={snapshot} onSnapshot={vi.fn()} />);

    const initialLoadMore = screen.getByRole("button", { name: "Load more sessions" });
    await user.click(initialLoadMore);
    expect(initialLoadMore).toHaveAttribute("data-pending", "true");

    await user.type(screen.getByRole("searchbox", { name: "Filter sessions" }), "payments");
    await waitFor(() => expect(listTargets).toHaveBeenCalledWith({
      mode: "session",
      limit: 100,
      query: "payments",
    }));

    await act(async () => {
      firstBasePage.resolve({
        ok: true,
        value: {
          items: [],
          page: {
            limit: 100,
            total: 502,
            truncated: true,
            nextCursor: "base-cursor-2",
          },
        },
      });
      await firstBasePage.promise;
    });

    await user.clear(screen.getByRole("searchbox", { name: "Filter sessions" }));
    const retry = await screen.findByRole("button", { name: "Load more sessions" });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(retry).not.toHaveAttribute("data-pending", "true");

    await user.click(retry);
    await waitFor(() => expect(listTargets).toHaveBeenCalledWith({
      mode: "session",
      cursor: "base-cursor-2",
      limit: 100,
    }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more sessions" })).not.toBeInTheDocument());
  });

  it("searches the complete catalog for target 501 without flashing a false empty state", async () => {
    const user = userEvent.setup();
    const snapshot = targetSnapshot();
    snapshot.domains.sessions.page = {
      limit: 500,
      total: 501,
      truncated: true,
      nextCursor: "target:v1:11111111-1111-4111-8111-111111111111",
    };
    const target501: SessionSummary = {
      ...session,
      id: "session-0500",
      name: "only-hidden-catalog-match",
      hostname: "hidden-paged-host",
    };
    const target501Ref: TargetRef = {
      mode: "session",
      id: target501.id,
      backendEpoch: 7,
      domainRevision: 3,
      fingerprint: "c".repeat(64),
    };
    const sessionSearch = deferred<Awaited<ReturnType<SliverDesktopAPI["listTargets"]>>>();
    const listTargets = vi.fn(() => sessionSearch.promise);
    const selectTarget = vi.fn().mockResolvedValue({ ok: true, value: targetSnapshot("session") });
    installAPI({ listTargets, selectTarget });

    render(<TargetsPage mode="session" snapshot={snapshot} onSnapshot={vi.fn()} />);
    await user.type(
      screen.getByRole("searchbox", { name: "Filter sessions" }),
      "only-hidden-catalog-match",
    );

    expect(await screen.findByText("Searching sessions")).toBeInTheDocument();
    expect(screen.queryByText("No sessions match")).not.toBeInTheDocument();
    await waitFor(() => expect(listTargets).toHaveBeenCalledWith({
      mode: "session",
      limit: 100,
      query: "only-hidden-catalog-match",
    }));
    await act(async () => {
      sessionSearch.resolve({
        ok: true,
        value: {
          items: [{ target: target501, ref: target501Ref }],
          page: { limit: 100, total: 1, truncated: false },
        },
      });
      await sessionSearch.promise;
    });
    const resultRow = await screen.findByRole("row", { name: /only-hidden-catalog-match/i });
    expect(screen.queryByText("No sessions match")).not.toBeInTheDocument();
    await user.click(resultRow);
    await waitFor(() => expect(selectTarget).toHaveBeenCalledWith(target501Ref));
  });

  it("quarantines search results from an earlier connection incarnation", async () => {
    const user = userEvent.setup();
    const staleSessionSearch = deferred<Awaited<ReturnType<SliverDesktopAPI["listTargets"]>>>();
    const currentSessionSearch = deferred<Awaited<ReturnType<SliverDesktopAPI["listTargets"]>>>();
    const gates = [staleSessionSearch, currentSessionSearch];
    const listTargets = vi.fn(() => {
      const gate = gates[listTargets.mock.calls.length - 1];
      if (!gate) throw new Error("Unexpected target search request");
      return gate.promise;
    });
    installAPI({ listTargets });
    const initial = targetSnapshot();
    initial.connection.incarnation = 1;
    const { rerender } = render(<TargetsPage mode="session" snapshot={initial} onSnapshot={vi.fn()} />);

    await user.type(screen.getByRole("searchbox", { name: "Filter sessions" }), "race-result");
    await waitFor(() => expect(listTargets).toHaveBeenCalledTimes(1));

    const reconnected = targetSnapshot();
    reconnected.connection.incarnation = 2;
    rerender(<TargetsPage mode="session" snapshot={reconnected} onSnapshot={vi.fn()} />);
    await waitFor(() => expect(listTargets).toHaveBeenCalledTimes(2));

    const staleTarget = { ...session, id: "stale-search", name: "stale-race-result" };
    await act(async () => {
      staleSessionSearch.resolve({
        ok: true,
        value: {
          items: [{ target: staleTarget, ref: { ...sessionRef, id: staleTarget.id } }],
          page: { limit: 100, total: 1, truncated: false },
        },
      });
      await staleSessionSearch.promise;
    });
    expect(screen.queryByRole("row", { name: /stale-race-result/i })).not.toBeInTheDocument();
    expect(screen.getByText("Searching sessions")).toBeInTheDocument();

    const currentTarget = { ...session, id: "current-search", name: "current-race-result" };
    await act(async () => {
      currentSessionSearch.resolve({
        ok: true,
        value: {
          items: [{ target: currentTarget, ref: { ...sessionRef, id: currentTarget.id } }],
          page: { limit: 100, total: 1, truncated: false },
        },
      });
      await currentSessionSearch.promise;
    });
    expect(await screen.findByRole("row", { name: /current-race-result/i })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /stale-race-result/i })).not.toBeInTheDocument();
  });

  it("ignores a late submitted-operation callback after a same-backend reconnect incarnation", async () => {
    const user = userEvent.setup();
    const staleSubmitGate = deferred<Awaited<ReturnType<SliverDesktopAPI["submitTargetOperation"]>>>();
    const currentSubmitGate = deferred<Awaited<ReturnType<SliverDesktopAPI["submitTargetOperation"]>>>();
    const submitTargetOperation = vi.fn()
      .mockImplementationOnce(() => staleSubmitGate.promise)
      .mockImplementationOnce(() => currentSubmitGate.promise);
    installAPI({ submitTargetOperation });
    const initial = targetSnapshot("session");
    initial.connection.incarnation = 1;
    const { rerender } = render(sessionWorkspace(initial));

    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const nameInput = screen.getByRole("textbox", { name: "Session name" });
    await user.clear(nameInput);
    await user.type(nameInput, "keep-this-draft");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(submitTargetOperation).toHaveBeenCalledWith({
      operationId: "target.rename",
      name: "keep-this-draft",
    }));
    const reconnected = targetSnapshot("session");
    reconnected.connection.incarnation = 2;
    rerender(sessionWorkspace(reconnected));
    await waitFor(() => expect(screen.getByRole("button", { name: "Run ping" })).toBeEnabled());
    expect(screen.queryByRole("textbox", { name: "Session name" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    await user.clear(screen.getByRole("textbox", { name: "Session name" }));
    await user.type(screen.getByRole("textbox", { name: "Session name" }), "current-incarnation-draft");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(submitTargetOperation).toHaveBeenNthCalledWith(2, {
      operationId: "target.rename",
      name: "current-incarnation-draft",
    }));
    expect(screen.getByRole("button", { name: "Rename" })).toHaveAttribute("data-pending", "true");

    await act(async () => {
      staleSubmitGate.resolve({ ok: true, value: operationRecord({ operationId: "target.rename" }) });
      await staleSubmitGate.promise;
    });

    expect(screen.queryByText("Operation submitted")).not.toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /request-1/i })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Session name" })).toHaveValue("current-incarnation-draft");
    expect(screen.getByRole("button", { name: "Rename" })).toHaveAttribute("data-pending", "true");

    await act(async () => {
      currentSubmitGate.resolve({
        ok: true,
        value: operationRecord({ requestId: "request-2", operationId: "target.rename" }),
      });
      await currentSubmitGate.promise;
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename session" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("row", { name: /request-2/i })).toBeInTheDocument();
  });

  it("keeps an operation draft across domain revisions and quarantines a fingerprint replacement", async () => {
    const user = userEvent.setup();
    installAPI();
    const initial = targetSnapshot("session");
    initial.connection.incarnation = 1;
    const { rerender } = render(sessionWorkspace(initial));

    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    await user.clear(screen.getByRole("textbox", { name: "Session name" }));
    await user.type(screen.getByRole("textbox", { name: "Session name" }), "revision-safe-draft");

    const refreshed = targetSnapshot("session");
    refreshed.connection.incarnation = 1;
    const refreshedRef = { ...sessionRef, domainRevision: 4 };
    refreshed.domains.sessions.revision = 4;
    refreshed.targetContext.activeTarget = refreshedRef;
    refreshed.targetContext.selectableTargets = [refreshedRef, beaconRef];
    rerender(sessionWorkspace(refreshed));

    expect(screen.getByRole("textbox", { name: "Session name" })).toHaveValue("revision-safe-draft");
    expect(screen.getByRole("button", { name: "Rename" })).toBeEnabled();

    const changed = targetSnapshot("session");
    changed.connection.incarnation = 1;
    const changedRef = {
      ...sessionRef,
      domainRevision: 5,
      fingerprint: "d".repeat(64),
    };
    changed.domains.sessions.revision = 5;
    changed.targetContext.activeTarget = changedRef;
    changed.targetContext.selectableTargets = [changedRef, beaconRef];
    rerender(sessionWorkspace(changed));

    expect(screen.getByRole("heading", { name: "Session workspace unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Session name" })).not.toBeInTheDocument();
  });

  it("keeps a task modal across domain revisions and closes it for fingerprint or incarnation changes", async () => {
    const user = userEvent.setup();
    const task: BeaconTaskDetail = {
      taskId: "task-identity-1",
      beaconId: beacon.id,
      state: "completed",
      description: "Identity task",
      resultAvailable: true,
      cancellation: { available: false, reason: "Only pending tasks can be canceled" },
      ownership: { origin: "external", actor: { attribution: "unknown" } },
    };
    installAPI({
      getBeaconTask: vi.fn().mockResolvedValue({ ok: true, value: task }),
      listBeaconTasks: vi.fn().mockResolvedValue({
        ok: true,
        value: { items: [task], page: { limit: 100, total: 1, truncated: false } },
      }),
    });
    const initial = targetSnapshot("beacon");
    initial.connection.incarnation = 1;
    const { rerender } = render(<TargetsPage mode="beacon" snapshot={initial} onSnapshot={vi.fn()} />);

    await user.click(await screen.findByRole("row", { name: /task-identity-1/i }));
    expect(await screen.findByRole("dialog", { name: "Identity task" })).toBeInTheDocument();

    const refreshed = targetSnapshot("beacon");
    refreshed.connection.incarnation = 1;
    const refreshedRef = { ...beaconRef, domainRevision: 5 };
    refreshed.domains.beacons.revision = 5;
    refreshed.targetContext.activeTarget = refreshedRef;
    refreshed.targetContext.selectableTargets = [sessionRef, refreshedRef];
    rerender(<TargetsPage mode="beacon" snapshot={refreshed} onSnapshot={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Identity task" })).toBeInTheDocument();

    const changed = targetSnapshot("beacon");
    changed.connection.incarnation = 1;
    const changedRef = {
      ...beaconRef,
      domainRevision: 6,
      fingerprint: "e".repeat(64),
    };
    changed.domains.beacons.revision = 6;
    changed.targetContext.activeTarget = changedRef;
    changed.targetContext.selectableTargets = [sessionRef, changedRef];
    rerender(<TargetsPage mode="beacon" snapshot={changed} onSnapshot={vi.fn()} />);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Identity task" })).not.toBeInTheDocument());
    await user.click(await screen.findByRole("row", { name: /task-identity-1/i }));
    expect(await screen.findByRole("dialog", { name: "Identity task" })).toBeInTheDocument();

    const reconnected = targetSnapshot("beacon");
    reconnected.connection.incarnation = 2;
    reconnected.domains.beacons.revision = 6;
    reconnected.targetContext.activeTarget = changedRef;
    reconnected.targetContext.selectableTargets = [sessionRef, changedRef];
    rerender(<TargetsPage mode="beacon" snapshot={reconnected} onSnapshot={vi.fn()} />);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Identity task" })).not.toBeInTheDocument());
  });

  it("submits a closed operation descriptor and renders decoded history details", async () => {
    const user = userEvent.setup();
    const completed = operationRecord();
    const submitTargetOperation = vi.fn().mockResolvedValue({ ok: true, value: completed });
    const getTargetOperation = vi.fn().mockResolvedValue({ ok: true, value: completed });
    installAPI({ submitTargetOperation, getTargetOperation });

    render(sessionWorkspace(targetSnapshot("session")));

    await user.click(screen.getByRole("button", { name: "Run ping" }));
    await waitFor(() => expect(submitTargetOperation).toHaveBeenCalledWith({ operationId: "target.ping" }));
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    const operationRow = await screen.findByRole("row", { name: /request-1/i });
    await user.click(operationRow);

    const dialog = await screen.findByRole("dialog", { name: "Ping" });
    expect(within(dialog).getByText("Round-trip: 2 ms")).toBeInTheDocument();
    expect(within(dialog).getByText("This window")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Cancel operation" })).not.toBeInTheDocument();
  });

  it("updates lifecycle actions from authoritative capabilities without restarting the page", async () => {
    const user = userEvent.setup();
    installAPI();
    const initial = targetSnapshot("session");
    const { rerender } = render(sessionWorkspace(initial));

    await user.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.getByRole("menuitem", { name: "Kill Session" })).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: "Close Session" })).not.toHaveAttribute("aria-disabled", "true");

    const unavailable = targetSnapshot("session");
    unavailable.targetContext.capabilities = unavailable.targetContext.capabilities.map((capability) =>
      capability.id === "target.terminate" || capability.id === "session.close"
        ? {
            id: capability.id,
            available: false,
            reason: { code: "target-dead", message: "The session is no longer interactive" },
          }
        : capability
    );
    rerender(sessionWorkspace(unavailable));

    expect(screen.getByRole("menuitem", { name: "Kill Session" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: "Close Session" })).toHaveAttribute("aria-disabled", "true");
  });

  it("loads additional operation history with the opaque cursor and retains prior pages", async () => {
    const user = userEvent.setup();
    const newest = operationRecord();
    const older = operationRecord({
      requestId: "request-2",
      createdAt: "2026-08-09T19:58:00.000Z",
      updatedAt: "2026-08-09T19:58:01.000Z",
    });
    const listTargetOperations = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          items: [newest],
          page: { limit: 100, total: 2, truncated: true, nextCursor: "operations-cursor-1" },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { items: [older], page: { limit: 100, total: 2, truncated: false } },
      });
    installAPI({ listTargetOperations });

    render(<TargetsPage mode="session" snapshot={targetSnapshot("session")} onSnapshot={vi.fn()} />);

    expect(await screen.findByRole("row", { name: /request-1/i })).toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 2 operations")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more operations" }));

    await waitFor(() => expect(listTargetOperations).toHaveBeenNthCalledWith(2, {
      cursor: "operations-cursor-1",
      limit: 100,
    }));
    expect(await screen.findByRole("row", { name: /request-2/i })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /request-1/i })).toBeInTheDocument();
    expect(screen.getByText("Showing 2 of 2 operations")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more operations" })).not.toBeInTheDocument();
  });

  it("watches beacon tasks, cancels pending work, and executes an exact lifecycle plan", async () => {
    const user = userEvent.setup();
    const snapshot = targetSnapshot("beacon");
    const watchedSnapshot = targetSnapshot("beacon");
    watchedSnapshot.targetContext.beaconWatch = true;
    const task: BeaconTaskDetail = {
      taskId: "task-1",
      beaconId: beacon.id,
      state: "pending",
      description: "Ping",
      resultAvailable: false,
      cancellation: { available: true },
      localRequestId: "request-2",
      operationId: "target.ping",
      ownership: {
        origin: "local",
        ownerWindowId: 12,
        actor: { attribution: "verified", name: "m1-verification" },
      },
    };
    const plan: TargetActionPlan = {
      token: "plan-token-1",
      expiresAt: "2026-08-09T20:10:00.000Z",
      impact: {
        actionId: "beacon.remove",
        backend: {
          server: "127.0.0.1:53137",
          operator: "m1-verification",
          configName: "M1 test",
          epoch: 7,
          sharedWindowCount: 2,
        },
        targets: [beacon],
        totalTargets: 1,
        truncated: false,
        warning: "Remove this beacon from the server inventory.",
      },
    };
    const setBeaconWatch = vi.fn().mockResolvedValue({ ok: true, value: watchedSnapshot });
    const cancelBeaconTask = vi.fn().mockResolvedValue({ ok: true, value: { ...task, state: "canceled" } });
    const executeTargetActionPlan = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        actionId: "beacon.remove",
        outcomes: [{ requestId: "action_request_1", ownerWindowId: 1, target: beacon, status: "succeeded" }],
        partial: false,
      },
    });
    installAPI({
      setBeaconWatch,
      cancelBeaconTask,
      getBeaconTask: vi.fn().mockResolvedValue({ ok: true, value: task }),
      listBeaconTasks: vi.fn().mockResolvedValue({
        ok: true,
        value: { items: [task], page: { limit: 100, total: 1, truncated: false } },
      }),
      prepareTargetAction: vi.fn().mockResolvedValue({ ok: true, value: plan }),
      executeTargetActionPlan,
      refresh: vi.fn().mockResolvedValue({ ok: true, value: snapshot }),
    });

    render(<TargetsPage mode="beacon" snapshot={snapshot} onSnapshot={vi.fn()} />);

    await user.click(screen.getByRole("switch", { name: "Watch active beacon" }));
    expect(setBeaconWatch).toHaveBeenCalledWith({ enabled: true });

    const taskRow = await screen.findByRole("row", { name: /task-1/i });
    await user.click(taskRow);
    const taskDialog = await screen.findByRole("dialog", { name: "Ping" });
    await user.click(within(taskDialog).getByRole("button", { name: "Cancel task" }));
    await waitFor(() => expect(cancelBeaconTask).toHaveBeenCalledWith({ taskId: "task-1" }));
    await user.click(within(taskDialog).getByText("Close"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Ping" })).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Remove beacon" }));
    const review = await screen.findByRole("dialog", { name: "Review remove beacon" });
    expect(within(review).getByText("Remove this beacon from the server inventory.")).toBeInTheDocument();
    await user.click(within(review).getByRole("button", { name: "Remove beacon" }));
    await waitFor(() => expect(executeTargetActionPlan).toHaveBeenCalledWith({ token: "plan-token-1" }));
    expect(await screen.findByRole("heading", { name: "Target action results" })).toBeInTheDocument();
    expect(within(review).getByText("Succeeded")).toBeInTheDocument();
  });

  it("pages beacon tasks and discloses bounded history when no further cursor is available", async () => {
    const user = userEvent.setup();
    const firstTask: BeaconTaskDetail = {
      taskId: "task-page-1",
      beaconId: beacon.id,
      state: "completed",
      description: "Newest task",
      createdAt: "2026-08-09T20:03:00.000Z",
      resultAvailable: true,
      cancellation: { available: false, reason: "Only pending tasks can be canceled" },
      ownership: {
        origin: "external",
        actor: { attribution: "unknown" },
      },
    };
    const secondTask: BeaconTaskDetail = {
      ...firstTask,
      taskId: "task-page-2",
      description: "Older task",
      createdAt: "2026-08-09T20:02:00.000Z",
    };
    const listBeaconTasks = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          items: [firstTask],
          page: { limit: 100, total: 501, truncated: true, nextCursor: "tasks-cursor-1" },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          items: [secondTask],
          page: { limit: 100, total: 501, truncated: true },
        },
      });
    installAPI({ listBeaconTasks });

    render(<TargetsPage mode="beacon" snapshot={targetSnapshot("beacon")} onSnapshot={vi.fn()} />);

    expect(await screen.findByRole("row", { name: /task-page-1/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more beacon tasks" }));

    await waitFor(() => expect(listBeaconTasks).toHaveBeenNthCalledWith(2, {
      cursor: "tasks-cursor-1",
      limit: 100,
    }));
    expect(await screen.findByRole("row", { name: /task-page-2/i })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /task-page-1/i })).toBeInTheDocument();
    expect(screen.getByText("Showing 2 of 501 beacon tasks")).toBeInTheDocument();
    expect(screen.getByText(
      "Showing 2 of 501 beacon tasks. Older task records are outside the available server task catalog.",
    )).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more beacon tasks" })).not.toBeInTheDocument();
  });
});
