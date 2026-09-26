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
import { TargetExecutionWorkbench } from "./TargetExecutionWorkbench";
import { TargetsPage } from "./TargetsPage";
import { formatTimestamp } from "./target-page-model";
import { renderWithApplicationContextMenu as render } from "../application-context-menu-test-utils";

interface IntersectionObserverRecord {
  readonly callback: IntersectionObserverCallback;
  readonly root: Element | Document | null;
  readonly observed: Element[];
  disconnected: boolean;
}

const intersectionObserverRecords: IntersectionObserverRecord[] = [];

beforeAll(() => {
  vi.stubGlobal("IntersectionObserver", class IntersectionObserver {
    readonly record: IntersectionObserverRecord;

    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.record = {
        callback,
        root: options?.root ?? null,
        observed: [],
        disconnected: false,
      };
      intersectionObserverRecords.push(this.record);
    }

    observe(target: Element) {
      this.record.observed.push(target);
    }

    unobserve(target: Element) {
      const index = this.record.observed.indexOf(target);
      if (index >= 0) this.record.observed.splice(index, 1);
    }

    disconnect() {
      this.record.disconnected = true;
    }
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
  intersectionObserverRecords.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
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

const secondBeacon: BeaconSummary = {
  ...beacon,
  id: "beacon-2",
  name: "nightly",
  hostname: "nightly-linux",
  username: "carol",
  checkinStatus: "overdue",
};

const secondBeaconRef: TargetRef = {
  ...beaconRef,
  id: secondBeacon.id,
  fingerprint: "c".repeat(64),
};

const rowInteractionCases = [
  { mode: "session", label: "Interact", destination: "current" },
  { mode: "session", label: "Interact in new window", destination: "popout" },
  { mode: "beacon", label: "Interact", destination: "current" },
  { mode: "beacon", label: "Interact in new window", destination: "popout" },
] as const;

const rowActionRaceCases = [
  { mode: "session", label: "Rename" },
  { mode: "session", label: "Kill Session" },
  { mode: "session", label: "Close Session" },
  ...rowInteractionCases,
] as const;

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

function switchableBeaconSnapshot(active: "first" | "second" = "first"): SliverSnapshot {
  const snapshot = targetSnapshot("beacon");
  snapshot.beacons = [beacon];
  snapshot.domains.beacons.items = [beacon, secondBeacon];
  snapshot.domains.beacons.page = { limit: 500, total: 2, truncated: false };
  snapshot.targetContext.selectableTargets = [sessionRef, beaconRef, secondBeaconRef];
  if (active === "second") {
    snapshot.targetContext.activeTarget = secondBeaconRef;
    snapshot.targetContext.activeTargetSummary = secondBeacon;
  }
  return snapshot;
}

function beaconTaskDetail(overrides: Partial<BeaconTaskDetail> = {}): BeaconTaskDetail {
  return {
    taskId: "task-output-1",
    beaconId: beacon.id,
    state: "completed",
    description: "Read working directory",
    createdAt: "2026-08-09T20:03:00.000Z",
    completedAt: "2026-08-09T20:04:00.000Z",
    resultAvailable: true,
    cancellation: { available: false },
    operationId: "beacon.filesystem.pwd",
    ownership: { origin: "external", actor: { attribution: "unknown" } },
    disposition: {
      kind: "structured-detail",
      title: "Working directory",
      fields: [{ label: "Path", value: "/srv/first-output" }],
      truncated: false,
    },
    ...overrides,
  };
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
    addDroppedLoot: vi.fn(failed),
    uploadDroppedSessionFile: vi.fn(failed),
    onSavedConfigsChanged: vi.fn(() => vi.fn()),
    setKeyboardShortcutRecording: vi.fn().mockResolvedValue(undefined),
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
    chooseReportScreenshotDirectory: vi.fn(failed),
    reportScreenshot: vi.fn(failed),
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
    readExecutionOutput: vi.fn(failed),
    addExecutionOutputToLoot: vi.fn(failed),
    importConfig: vi.fn(failed),
    listExecutionCatalog: vi.fn(failed),
    listInstalledBofs: vi.fn(failed),
    listDotNetAssemblies: vi.fn(failed),
    listDotNetExecutionHistory: vi.fn(failed),
    clearDotNetExecutionHistory: vi.fn(failed),
    chooseDotNetAssemblyFile: vi.fn(failed),
    chooseBofDirectory: vi.fn(failed),
    chooseBofArgumentFile: vi.fn(failed),
    runBof: vi.fn(failed),
    listBofExecutionHistory: vi.fn(failed),
    clearBofExecutionHistory: vi.fn(failed),
    getBofExecutionResult: vi.fn(failed),
    saveBofOutput: vi.fn(failed),
    addBofOutputToLoot: vi.fn(failed),
    listProcessExecutionHistory: vi.fn(failed),
    clearProcessExecutionHistory: vi.fn(failed),
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
    onProcessExecutionHistoryChanged: vi.fn(() => vi.fn()),
    onDotNetExecutionHistoryChanged: vi.fn(() => vi.fn()),
    onBofExecutionHistoryChanged: vi.fn(() => vi.fn()),
    onSnapshotChanged: vi.fn(() => vi.fn()),
    openInteractionWindow: vi.fn(failed),
    openCloudDeploymentWindow: vi.fn(failed),
    copyManagedServerSshCommand: vi.fn(async () => ({ ok: true as const })),
    copyManagedServerPublicIp: vi.fn(async () => ({ ok: true as const })),
    claimInteractionWindow: vi.fn(failed),
    openSessionShellWindow: vi.fn(failed),
    claimSessionShellWindow: vi.fn(failed),
    openSessionPanelWindow: vi.fn(failed),
    claimSessionPanelWindow: vi.fn(failed),
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
    openRemoteTextEditor: vi.fn(failed),
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

function emitIntersection(
  record: IntersectionObserverRecord,
  target: Element,
  targetTop: number,
  rootTop = 0,
): void {
  record.callback([{
    boundingClientRect: { top: targetTop } as DOMRectReadOnly,
    intersectionRatio: targetTop < rootTop ? 0 : 1,
    intersectionRect: {} as DOMRectReadOnly,
    isIntersecting: targetTop >= rootTop,
    rootBounds: { top: rootTop } as DOMRectReadOnly,
    target,
    time: 0,
  }], {} as IntersectionObserver);
}

describe("TargetsPage", () => {
  it.each(["none", "beacon"] as const)("keeps the beacon catalog full width with %s selected and no detail sidebar", (active) => {
    installAPI();
    render(<TargetsPage mode="beacon" snapshot={targetSnapshot(active)} onSnapshot={vi.fn()} />);

    const grid = screen.getByRole("grid", { name: "Sliver beacons" });
    expect(within(grid).getByRole("button", { name: "Interact with warehouse" })).toBeInTheDocument();
    expect(within(grid).getByRole("columnheader", { name: "Last check-in" })).toBeInTheDocument();
    expect(within(grid).getByRole("columnheader", { name: "Next check-in" })).toBeInTheDocument();
    expect(within(grid).getByRole("columnheader", { name: "Interval / jitter" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "warehouse" })).not.toBeInTheDocument();
    expect(screen.queryByText("Select a beacon")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Capabilities" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Watch active beacon" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pop out interaction" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Execution" })).not.toBeInTheDocument();
  });

  it("opens the exact beacon through its named Interact button after authoritative confirmation", async () => {
    const user = userEvent.setup();
    const selected = targetSnapshot("beacon");
    const confirmedBeacon = { ...beacon, name: "confirmed-warehouse" };
    selected.targetContext.activeTargetSummary = confirmedBeacon;
    const selectTarget = vi.fn().mockResolvedValue({ ok: true, value: selected });
    const onOpenBeacon = vi.fn();
    const onSnapshot = vi.fn();
    installAPI({ selectTarget });
    render(<TargetsPage mode="beacon" snapshot={targetSnapshot()} onSnapshot={onSnapshot} onOpenBeacon={onOpenBeacon} />);

    await user.click(screen.getByRole("button", { name: "Interact with warehouse" }));

    expect(selectTarget).toHaveBeenCalledExactlyOnceWith(beaconRef);
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(selected);
    expect(onOpenBeacon).toHaveBeenCalledExactlyOnceWith(confirmedBeacon, beaconRef);
  });

  it.each(["mode", "ID", "fingerprint", "incarnation"])("rejects a beacon Interact confirmation with a changed %s", async (changed) => {
    const user = userEvent.setup();
    const selected = targetSnapshot("beacon");
    if (changed === "mode") selected.targetContext = targetSnapshot("session").targetContext;
    if (changed === "ID") {
      selected.targetContext.activeTarget = { ...beaconRef, id: "different-beacon" };
      selected.targetContext.activeTargetSummary = { ...beacon, id: "different-beacon" };
    }
    if (changed === "fingerprint") selected.targetContext.activeTarget = { ...beaconRef, fingerprint: "f".repeat(64) };
    if (changed === "incarnation") selected.connection.incarnation = 1;
    const selectTarget = vi.fn().mockResolvedValue({ ok: true, value: selected });
    const onOpenBeacon = vi.fn();
    const onSnapshot = vi.fn();
    installAPI({ selectTarget });
    render(<TargetsPage mode="beacon" snapshot={targetSnapshot()} onSnapshot={onSnapshot} onOpenBeacon={onOpenBeacon} />);

    await user.click(screen.getByRole("button", { name: "Interact with warehouse" }));

    expect(selectTarget).toHaveBeenCalledExactlyOnceWith(beaconRef);
    expect(onOpenBeacon).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("switches from the Beacons breadcrumb using the exact main-issued reference and confirmed summary", async () => {
    const user = userEvent.setup();
    const confirmed = switchableBeaconSnapshot("second");
    const confirmedBeacon = { ...secondBeacon, name: "confirmed-nightly" };
    confirmed.targetContext.activeTargetSummary = confirmedBeacon;
    const selectTarget = vi.fn().mockResolvedValue({ ok: true, value: confirmed });
    const onOpenBeacon = vi.fn();
    const onSnapshot = vi.fn();
    installAPI({ selectTarget });
    render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={switchableBeaconSnapshot()} onSnapshot={onSnapshot} onOpenBeacon={onOpenBeacon} />);

    const trigger = screen.getByRole("button", { name: "Beacons, switch beacon" });
    expect(trigger.closest("a")).toBeNull();
    await user.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Beacons, switch beacon" });
    const current = within(menu).getByRole("menuitemradio", { name: /warehouse.*Current/ });
    expect(current).toHaveAttribute("aria-checked", "true");
    expect(current).toHaveTextContent("edge-linux");
    expect(current).toHaveTextContent("bob");
    expect(current).toHaveTextContent("On time");
    const next = within(menu).getByRole("menuitemradio", { name: /nightly/ });
    expect(next).toHaveAttribute("aria-checked", "false");
    expect(next).toHaveTextContent("nightly-linux");
    expect(next).toHaveTextContent("carol");
    expect(next).toHaveTextContent("Overdue");
    expect(screen.queryByRole("button", { name: /View all beacons/ })).not.toBeInTheDocument();
    await user.click(next);

    await waitFor(() => expect(selectTarget).toHaveBeenCalledExactlyOnceWith(secondBeaconRef));
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(confirmed);
    expect(onOpenBeacon).toHaveBeenCalledExactlyOnceWith(confirmedBeacon, secondBeaconRef);
  });

  it("keeps the current beacon selected without making another selection request", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    const onOpenBeacon = vi.fn();
    const onSnapshot = vi.fn();
    render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={switchableBeaconSnapshot()} onSnapshot={onSnapshot} onOpenBeacon={onOpenBeacon} />);

    await user.click(screen.getByRole("button", { name: "Beacons, switch beacon" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /warehouse.*Current/ }));

    expect(api.selectTarget).not.toHaveBeenCalled();
    expect(onOpenBeacon).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "warehouse" })).toBeInTheDocument();
  });

  it("omits beacon choices without a current-epoch exact reference", async () => {
    const user = userEvent.setup();
    installAPI();
    const snapshot = switchableBeaconSnapshot();
    const stale = { ...secondBeacon, id: "stale-beacon", name: "stale-nightly" };
    const unreferenced = { ...secondBeacon, id: "unreferenced-beacon", name: "unreferenced-nightly" };
    snapshot.beacons = [...snapshot.beacons, stale, unreferenced];
    snapshot.targetContext.selectableTargets = [...snapshot.targetContext.selectableTargets, { ...secondBeaconRef, id: stale.id, backendEpoch: 6 }];
    render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={snapshot} onSnapshot={vi.fn()} onOpenBeacon={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Beacons, switch beacon" }));
    const menu = await screen.findByRole("menu", { name: "Beacons, switch beacon" });
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(2);
    expect(within(menu).queryByText("stale-nightly")).not.toBeInTheDocument();
    expect(within(menu).queryByText("unreferenced-nightly")).not.toBeInTheDocument();
  });

  it("rejects a breadcrumb switch when the server confirms another fingerprint", async () => {
    const user = userEvent.setup();
    const confirmed = switchableBeaconSnapshot("second");
    confirmed.targetContext.activeTarget = { ...secondBeaconRef, fingerprint: "f".repeat(64) };
    const selectTarget = vi.fn().mockResolvedValue({ ok: true, value: confirmed });
    const onOpenBeacon = vi.fn();
    const onSnapshot = vi.fn();
    installAPI({ selectTarget });
    render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={switchableBeaconSnapshot()} onSnapshot={onSnapshot} onOpenBeacon={onOpenBeacon} />);

    await user.click(screen.getByRole("button", { name: "Beacons, switch beacon" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /nightly/ }));

    expect(selectTarget).toHaveBeenCalledExactlyOnceWith(secondBeaconRef);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onOpenBeacon).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "warehouse" })).toBeInTheDocument();
  });

  it("ignores a pending breadcrumb switch after a reconnect", async () => {
    const user = userEvent.setup();
    const selection = deferred<Awaited<ReturnType<SliverDesktopAPI["selectTarget"]>>>();
    const selectTarget = vi.fn().mockReturnValue(selection.promise);
    const onOpenBeacon = vi.fn();
    const onSnapshot = vi.fn();
    installAPI({ selectTarget });
    const initial = switchableBeaconSnapshot();
    const rendered = render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={initial} onSnapshot={onSnapshot} onOpenBeacon={onOpenBeacon} />);
    await user.click(screen.getByRole("button", { name: "Beacons, switch beacon" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /nightly/ }));
    await waitFor(() => expect(selectTarget).toHaveBeenCalledExactlyOnceWith(secondBeaconRef));

    const reconnected = switchableBeaconSnapshot();
    reconnected.connection.incarnation = 1;
    rendered.rerender(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={reconnected} onSnapshot={onSnapshot} onOpenBeacon={onOpenBeacon} />);
    await act(async () => selection.resolve({ ok: true, value: switchableBeaconSnapshot("second") }));

    expect(onOpenBeacon).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it.each(["requested", "unrelated"] as const)("handles a %s active-target event while a breadcrumb selection is pending", async (eventTarget) => {
    const user = userEvent.setup();
    const selection = deferred<Awaited<ReturnType<SliverDesktopAPI["selectTarget"]>>>();
    const selectTarget = vi.fn().mockReturnValue(selection.promise);
    const onOpenBeacon = vi.fn();
    const onSnapshot = vi.fn();
    installAPI({ selectTarget });
    const rendered = render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={switchableBeaconSnapshot()} onSnapshot={onSnapshot} onOpenBeacon={onOpenBeacon} />);
    await user.click(screen.getByRole("button", { name: "Beacons, switch beacon" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /nightly/ }));
    await waitFor(() => expect(selectTarget).toHaveBeenCalledExactlyOnceWith(secondBeaconRef));

    const next = switchableBeaconSnapshot("second");
    const eventSnapshot = switchableBeaconSnapshot("second");
    if (eventTarget === "unrelated") {
      eventSnapshot.targetContext.activeTarget = { ...secondBeaconRef, id: "beacon-3", fingerprint: "d".repeat(64) };
      eventSnapshot.targetContext.activeTargetSummary = { ...secondBeacon, id: "beacon-3", name: "unrelated-beacon" };
    }
    rendered.rerender(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={eventSnapshot} onSnapshot={onSnapshot} onOpenBeacon={onOpenBeacon} />);
    await act(async () => selection.resolve({ ok: true, value: next }));

    if (eventTarget === "requested") {
      expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(next);
      expect(onOpenBeacon).toHaveBeenCalledExactlyOnceWith(secondBeacon, secondBeaconRef);
    } else {
      expect(onSnapshot).not.toHaveBeenCalled();
      expect(onOpenBeacon).not.toHaveBeenCalled();
    }
  });

  it("offers the full beacon catalog when the breadcrumb inventory is partial", async () => {
    const user = userEvent.setup();
    installAPI();
    const snapshot = switchableBeaconSnapshot();
    snapshot.domains.beacons.page = { limit: 2, total: 5, truncated: true };
    const onBack = vi.fn();
    render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={snapshot} onSnapshot={vi.fn()} onOpenBeacon={vi.fn()} onBack={onBack} />);

    await user.click(screen.getByRole("button", { name: "Beacons, switch beacon" }));
    const viewAll = await screen.findByRole("button", { name: /View all beacons/ });
    expect(viewAll).toHaveTextContent("Showing 2 of 5 available beacons");
    await user.click(viewAll);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("discloses a partial beacon inventory without a catalog button in a popout", async () => {
    const user = userEvent.setup();
    installAPI();
    const snapshot = switchableBeaconSnapshot();
    snapshot.domains.beacons.page = { limit: 2, total: 5, truncated: true };
    render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={snapshot} onSnapshot={vi.fn()} onOpenBeacon={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Beacons, switch beacon" }));
    expect(await screen.findByText(/^Showing 2 of 5 available beacons\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /View all beacons/ })).not.toBeInTheDocument();
  });

  it("updates check-in countdowns and overdue status locally, resets on check-in, and releases its timer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const setInterval = vi.spyOn(window, "setInterval");
    const clearInterval = vi.spyOn(window, "clearInterval");
    const nowMs = Date.parse("2026-08-09T20:02:00.000Z");
    vi.setSystemTime(nowMs);
    const snapshot = targetSnapshot();
    const imminentBeacon: BeaconSummary = { ...beacon, nextCheckinAt: new Date(nowMs + 2_000).toISOString() };
    snapshot.beacons = [imminentBeacon];
    snapshot.domains.beacons.items = [imminentBeacon];
    const api = installAPI();
    const { rerender, unmount } = render(<TargetsPage mode="beacon" snapshot={snapshot} onSnapshot={vi.fn()} />);
    await act(async () => {});
    const grid = screen.getByRole("grid", { name: "Sliver beacons" });
    expect(within(grid).getByText("In 2s")).toBeInTheDocument();
    expect(within(grid).getByText("On time")).toBeInTheDocument();
    expect(within(grid).getByText(formatTimestamp(beacon.lastCheckinAt))).toBeInTheDocument();
    expect(within(grid).getByText("8 s / 0 ms")).toBeInTheDocument();
    const timerIndex = setInterval.mock.calls.findIndex((call) => call[1] === 1_000);
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    const tick = setInterval.mock.calls[timerIndex]?.[0];
    if (typeof tick !== "function") throw new Error("Check-in countdown interval was not installed");
    const timer = setInterval.mock.results[timerIndex]?.value;
    expect(setInterval.mock.calls.filter((call) => call[1] === 1_000)).toHaveLength(1);
    const operationLoads = vi.mocked(api.listTargetOperations).mock.calls.length;

    await act(async () => { vi.setSystemTime(nowMs + 1_000); tick(); });
    expect(within(grid).getByText("In 1s")).toBeInTheDocument();
    await act(async () => { vi.setSystemTime(nowMs + 2_000); tick(); });
    expect(within(grid).getByText("Due now")).toBeInTheDocument();
    expect(within(grid).getByText("On time")).toBeInTheDocument();
    await act(async () => { vi.setSystemTime(nowMs + 3_000); tick(); });
    expect(within(grid).getByText("Overdue by 1s")).toBeInTheDocument();
    expect(within(grid).getByText("Overdue")).toBeInTheDocument();

    const checkedInBeacon: BeaconSummary = {
      ...imminentBeacon,
      lastCheckinAt: new Date(nowMs + 3_000).toISOString(),
      nextCheckinAt: new Date(nowMs + 33_000).toISOString(),
    };
    const updated: SliverSnapshot = {
      ...snapshot,
      beacons: [checkedInBeacon],
      domains: {
        ...snapshot.domains,
        beacons: { ...snapshot.domains.beacons, revision: 5, items: [checkedInBeacon] },
      },
    };
    rerender(<TargetsPage mode="beacon" snapshot={updated} onSnapshot={vi.fn()} />);
    expect(within(grid).getByText("In 30s")).toBeInTheDocument();
    expect(within(grid).getByText("On time")).toBeInTheDocument();
    expect(within(grid).queryByText("Overdue")).not.toBeInTheDocument();
    expect(vi.mocked(api.listTargetOperations).mock.calls.length).toBe(operationLoads);
    expect(api.listBeaconTasks).not.toHaveBeenCalled();
    expect(api.listTargets).not.toHaveBeenCalled();
    expect(api.refresh).not.toHaveBeenCalled();
    expect(api.getSnapshot).not.toHaveBeenCalled();
    expect(api.setBeaconWatch).not.toHaveBeenCalled();
    unmount();
    expect(clearInterval).toHaveBeenCalledWith(timer);
  });

  it("shows neutral timing for a beacon without an expected check-in and skips catalog timers for sessions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const setInterval = vi.spyOn(window, "setInterval");
    const clearInterval = vi.spyOn(window, "clearInterval");
    const snapshot = targetSnapshot();
    const unknownBeacon = { ...beacon };
    delete unknownBeacon.nextCheckinAt;
    snapshot.beacons = [unknownBeacon];
    snapshot.domains.beacons.items = [unknownBeacon];
    installAPI();
    const { rerender } = render(<TargetsPage mode="beacon" snapshot={snapshot} onSnapshot={vi.fn()} />);
    await act(async () => {});
    const row = screen.getByRole("row", { name: /warehouse/i });
    expect(within(row).getByText("Unknown")).toBeInTheDocument();
    expect(within(row).getByText("Not reported")).toBeInTheDocument();
    const timerIndex = setInterval.mock.calls.findIndex((call) => call[1] === 1_000);
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    const timer = setInterval.mock.results[timerIndex]?.value;
    rerender(<TargetsPage mode="session" snapshot={snapshot} onSnapshot={vi.fn()} />);
    expect(clearInterval).toHaveBeenCalledWith(timer);
    expect(setInterval.mock.calls.filter((call) => call[1] === 1_000)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Interact with payments" })).toBeInTheDocument();
  });

  it("pops out a catalog beacon interaction and keeps the dedicated surface focused", async () => {
    const user = userEvent.setup();
    const openInteractionWindow = vi.fn().mockResolvedValue({ ok: true });
    const listExecutionCatalog = vi.fn().mockResolvedValue({ ok: true, value: beaconExecutionCatalog() });
    const snapshot = targetSnapshot("beacon");
    const selectTarget = vi.fn().mockResolvedValue({ ok: true, value: snapshot });
    installAPI({ listExecutionCatalog, openInteractionWindow, selectTarget });
    const rendered = render(
      <TargetsPage mode="beacon" snapshot={snapshot} onSnapshot={vi.fn()} />,
    );

    fireEvent.contextMenu(screen.getByRole("row", { name: /warehouse/i }));
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    await user.click(within(menu).getByRole("menuitem", { name: "Interact in new window" }));
    await waitFor(() => expect(selectTarget).toHaveBeenCalledExactlyOnceWith(beaconRef));
    await waitFor(() => expect(openInteractionWindow).toHaveBeenCalledExactlyOnceWith());

    rendered.rerender(
      <TargetsPage
        expectedTarget={beaconRef}
        mode="beacon"
        presentation="dedicated"
        snapshot={snapshot}
        onSnapshot={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "warehouse" })).toBeInTheDocument();
    const breadcrumbs = screen.getByRole("navigation", { name: "Beacon workspace breadcrumbs" });
    expect(within(breadcrumbs).getByText("Beacons")).toBeInTheDocument();
    expect(within(breadcrumbs).getByText("warehouse")).toBeInTheDocument();
    expect(within(breadcrumbs).queryByRole("button", { name: "Beacons, switch beacon" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Async task workspace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to live beacons" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Queue a beacon task" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Task queue" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Task output" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tablist", { name: "Beacon task views" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "All target operations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Operator presence" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Execution workbench" })).not.toBeInTheDocument();
    expect(screen.queryByRole("grid", { name: "Sliver beacons" })).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Filter beacons" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Background target" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pop out interaction" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Execution" })).not.toBeInTheDocument();

    expect(screen.queryByRole("heading", { name: "Advanced execution" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show advanced execution" })).not.toBeInTheDocument();
    expect(listExecutionCatalog).not.toHaveBeenCalled();
  });

  it.each(["embedded", "popout"] as const)("shows a compact beacon summary in the %s interaction", (surface) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-08-09T20:01:58.000Z"));
    installAPI();
    render(
      <TargetsPage
        expectedTarget={beaconRef}
        mode="beacon"
        presentation="dedicated"
        snapshot={targetSnapshot("beacon")}
        {...(surface === "embedded" ? { onBack: vi.fn() } : {})}
        onSnapshot={vi.fn()}
      />,
    );

    const heading = screen.getByRole("heading", { name: beacon.name });
    const summary = heading.closest("header");
    expect(summary).toHaveAttribute("aria-label", "Beacon summary");
    if (!summary) throw new Error("The beacon summary header is missing");
    expect(within(summary).getByText("On time")).toBeInTheDocument();
    expect(within(summary).getByText("bob on edge-linux")).toBeInTheDocument();
    expect(within(summary).getByText(beacon.id)).toBeInTheDocument();
    expect(within(summary).getByText("Platform")).toBeInTheDocument();
    expect(within(summary).getByText("linux/amd64")).toBeInTheDocument();
    expect(within(summary).getByText("Process")).toBeInTheDocument();
    expect(within(summary).getByText("4001")).toBeInTheDocument();
    expect(within(summary).getByText("Last check-in")).toBeInTheDocument();
    expect(within(summary).getByText(formatTimestamp(beacon.lastCheckinAt))).toBeInTheDocument();
    expect(within(summary).getByText("Next check-in")).toBeInTheDocument();
    expect(within(summary).getByText("2s")).toBeInTheDocument();
    expect(within(summary).getByRole("button", { name: "Beacon details" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("switch", { name: "Watch active beacon" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Queue a beacon task" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Task queue" })).toHaveAttribute("aria-selected", "true");
  });

  it("refreshes the beacon summary from snapshots and handles missing metadata", () => {
    installAPI();
    const { rerender } = render(
      <TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={targetSnapshot("beacon")} onSnapshot={vi.fn()} />,
    );
    const updatedBeacon: BeaconSummary = {
      ...beacon,
      name: "renamed-warehouse",
      hostname: "edge-windows",
      username: "administrator",
      os: "windows",
      arch: "arm64",
      pid: 5002,
      lastCheckinAt: "2026-08-09T20:05:00.000Z",
      checkinStatus: "overdue",
    };
    const updated = targetSnapshot("beacon");
    updated.beacons = [updatedBeacon];
    updated.domains.beacons.items = [updatedBeacon];
    updated.targetContext.activeTargetSummary = updatedBeacon;
    rerender(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={updated} onSnapshot={vi.fn()} />);

    const summary = screen.getByRole("heading", { name: updatedBeacon.name }).closest("header");
    if (!summary) throw new Error("The refreshed beacon summary header is missing");
    expect(within(summary).getByText("Overdue")).toBeInTheDocument();
    expect(within(summary).getByText("administrator on edge-windows")).toBeInTheDocument();
    expect(within(summary).getByText("windows/arm64")).toBeInTheDocument();
    expect(within(summary).getByText("5002")).toBeInTheDocument();
    expect(within(summary).getByText(formatTimestamp(updatedBeacon.lastCheckinAt))).toBeInTheDocument();
    expect(within(summary).queryByText("bob on edge-linux")).not.toBeInTheDocument();

    const missingBeacon: BeaconSummary = {
      ...updatedBeacon,
      name: "",
      hostname: "",
      username: "",
      os: "",
      arch: "",
      checkinStatus: "unknown",
    };
    delete missingBeacon.pid;
    delete missingBeacon.lastCheckinAt;
    delete missingBeacon.nextCheckinAt;
    const missing = targetSnapshot("beacon");
    missing.beacons = [missingBeacon];
    missing.domains.beacons.items = [missingBeacon];
    missing.targetContext.activeTargetSummary = missingBeacon;
    rerender(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={missing} onSnapshot={vi.fn()} />);

    const missingSummary = screen.getByRole("heading", { name: "Unnamed beacon" }).closest("header");
    if (!missingSummary) throw new Error("The fallback beacon summary header is missing");
    expect(within(missingSummary).getByText("Unknown")).toBeInTheDocument();
    expect(within(missingSummary).getByText("Unknown user on unknown host")).toBeInTheDocument();
    expect(within(missingSummary).getByText("unknown/unknown")).toBeInTheDocument();
    expect(within(missingSummary).getAllByText("Not reported")).toHaveLength(3);
  });

  it("counts down in the beacon header, resets on check-in and beacon switch, and releases its timer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const setInterval = vi.spyOn(window, "setInterval");
    const clearInterval = vi.spyOn(window, "clearInterval");
    const nowMs = Date.parse("2026-08-09T20:02:00.000Z");
    vi.setSystemTime(nowMs);
    const imminentBeacon: BeaconSummary = { ...beacon, nextCheckinAt: new Date(nowMs + 2_000).toISOString() };
    const snapshot = targetSnapshot("beacon");
    snapshot.beacons = [imminentBeacon];
    snapshot.domains.beacons.items = [imminentBeacon];
    snapshot.targetContext.activeTargetSummary = imminentBeacon;
    const api = installAPI();
    const { rerender, unmount } = render(
      <TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={snapshot} onSnapshot={vi.fn()} />,
    );
    await act(async () => {});
    const summary = screen.getByRole("heading", { name: beacon.name }).closest("header");
    if (!summary) throw new Error("The beacon countdown header is missing");
    expect(within(summary).getByText("2s")).toHaveAttribute("title", formatTimestamp(imminentBeacon.nextCheckinAt));
    expect(within(summary).getByText("On time")).toBeInTheDocument();
    const timerIndex = setInterval.mock.calls.findIndex((call) => call[1] === 1_000);
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    const tick = setInterval.mock.calls[timerIndex]?.[0];
    if (typeof tick !== "function") throw new Error("The beacon header countdown interval was not installed");
    const timer = setInterval.mock.results[timerIndex]?.value;
    const operationLoads = vi.mocked(api.listTargetOperations).mock.calls.length;
    const taskLoads = vi.mocked(api.listBeaconTasks).mock.calls.length;

    await act(async () => { vi.setSystemTime(nowMs + 1_000); tick(); });
    expect(within(summary).getByText("1s")).toBeInTheDocument();
    await act(async () => { vi.setSystemTime(nowMs + 2_000); tick(); });
    expect(within(summary).getByText("Due now")).toBeInTheDocument();
    expect(within(summary).getByText("On time")).toBeInTheDocument();
    await act(async () => { vi.setSystemTime(nowMs + 3_000); tick(); });
    expect(within(summary).getByText("Overdue by 1s")).toBeInTheDocument();
    expect(within(summary).getByText("Overdue")).toBeInTheDocument();
    expect(vi.mocked(api.listTargetOperations).mock.calls.length).toBe(operationLoads);
    expect(vi.mocked(api.listBeaconTasks).mock.calls.length).toBe(taskLoads);
    expect(api.refresh).not.toHaveBeenCalled();
    expect(api.getSnapshot).not.toHaveBeenCalled();
    expect(api.setBeaconWatch).not.toHaveBeenCalled();

    const checkedInBeacon: BeaconSummary = {
      ...imminentBeacon,
      lastCheckinAt: new Date(nowMs + 3_000).toISOString(),
      nextCheckinAt: new Date(nowMs + 33_000).toISOString(),
    };
    const checkedIn = targetSnapshot("beacon");
    checkedIn.beacons = [checkedInBeacon];
    checkedIn.domains.beacons.items = [checkedInBeacon];
    checkedIn.targetContext.activeTargetSummary = checkedInBeacon;
    rerender(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={checkedIn} onSnapshot={vi.fn()} />);
    expect(within(summary).getByText("30s")).toBeInTheDocument();
    expect(within(summary).getByText("On time")).toBeInTheDocument();
    expect(within(summary).getByText(formatTimestamp(checkedInBeacon.lastCheckinAt))).toBeInTheDocument();

    const switchedBeacon: BeaconSummary = { ...secondBeacon, nextCheckinAt: new Date(nowMs + 7_000).toISOString() };
    const switched = switchableBeaconSnapshot("second");
    switched.beacons = [checkedInBeacon, switchedBeacon];
    switched.domains.beacons.items = [checkedInBeacon, switchedBeacon];
    switched.targetContext.activeTargetSummary = switchedBeacon;
    rerender(<TargetsPage expectedTarget={secondBeaconRef} mode="beacon" presentation="dedicated" snapshot={switched} onSnapshot={vi.fn()} />);
    const switchedSummary = screen.getByRole("heading", { name: secondBeacon.name }).closest("header");
    if (!switchedSummary) throw new Error("The switched beacon countdown header is missing");
    expect(within(switchedSummary).getByText("4s")).toBeInTheDocument();
    expect(within(switchedSummary).getByText("On time")).toBeInTheDocument();
    expect(setInterval.mock.calls.filter((call) => call[1] === 1_000)).toHaveLength(1);
    unmount();
    expect(clearInterval).toHaveBeenCalledWith(timer);
  });

  it.each(["missing", "invalid"] as const)("shows neutral header timing for a %s next check-in and stops timing on quarantine", async (timestamp) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const setInterval = vi.spyOn(window, "setInterval");
    const clearInterval = vi.spyOn(window, "clearInterval");
    const unknownBeacon = { ...beacon };
    if (timestamp === "missing") delete unknownBeacon.nextCheckinAt;
    else unknownBeacon.nextCheckinAt = "not-a-timestamp";
    const snapshot = targetSnapshot("beacon");
    snapshot.beacons = [unknownBeacon];
    snapshot.domains.beacons.items = [unknownBeacon];
    snapshot.targetContext.activeTargetSummary = unknownBeacon;
    installAPI();
    const { rerender } = render(
      <TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={snapshot} onSnapshot={vi.fn()} />,
    );
    await act(async () => {});
    const summary = screen.getByRole("heading", { name: beacon.name }).closest("header");
    if (!summary) throw new Error("The neutral beacon countdown header is missing");
    expect(within(summary).getByText("Unknown")).toBeInTheDocument();
    expect(within(summary).getByText("Not reported")).toBeInTheDocument();
    const timerIndex = setInterval.mock.calls.findIndex((call) => call[1] === 1_000);
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    const timer = setInterval.mock.results[timerIndex]?.value;

    const quarantined = targetSnapshot("beacon");
    quarantined.targetContext.activeTarget = { ...beaconRef, fingerprint: "f".repeat(64) };
    rerender(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={quarantined} onSnapshot={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Beacon interaction unavailable" })).toBeInTheDocument();
    expect(clearInterval).toHaveBeenCalledWith(timer);
    expect(screen.queryByText("Next check-in")).not.toBeInTheDocument();

    rerender(<TargetsPage mode="session" snapshot={targetSnapshot("session")} onSnapshot={vi.fn()} />);
    expect(setInterval.mock.calls.filter((call) => call[1] === 1_000)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Interact with payments" })).toBeInTheDocument();
  });

  it("reveals beacon details on demand and collapses them when switching beacons", async () => {
    const user = userEvent.setup();
    installAPI();
    const { rerender } = render(
      <TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={switchableBeaconSnapshot()} onSnapshot={vi.fn()} />,
    );
    const toggle = screen.getByRole("button", { name: "Beacon details" });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("switch", { name: "Watch active beacon" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove beacon" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: beacon.name })).toHaveLength(1);
    expect(screen.getAllByText("Platform")).toHaveLength(1);
    expect(screen.getAllByText("Process")).toHaveLength(1);
    expect(screen.getAllByText("Last check-in")).toHaveLength(1);

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("switch", { name: "Watch active beacon" })).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    rerender(
      <TargetsPage expectedTarget={secondBeaconRef} mode="beacon" presentation="dedicated" snapshot={switchableBeaconSnapshot("second")} onSnapshot={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: secondBeacon.name })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beacon details" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("switch", { name: "Watch active beacon" })).not.toBeInTheDocument();
  });

  it.each(["app-content", "interaction-window__content"] as const)("observes the beacon summary in the %s viewport without resetting on metadata updates", (viewportClass) => {
    installAPI();
    const initializeViewport = (viewport: HTMLDivElement | null): void => {
      if (viewport) viewport.scrollTop = 120;
    };
    const view = render(
      <div className={viewportClass} ref={initializeViewport}>
        <TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={targetSnapshot("beacon")} onSnapshot={vi.fn()} />
      </div>,
    );
    const marker = view.container.querySelector(".beacon-workspace__scroll-marker");
    const sticky = view.container.querySelector(".beacon-workspace__sticky");
    const viewport = view.container.querySelector<HTMLDivElement>(`.${viewportClass}`);
    if (!marker || !sticky || !viewport) throw new Error("The beacon sticky summary markup is incomplete");
    const summary = screen.getByRole("heading", { name: beacon.name }).closest("header");
    expect(sticky).toContainElement(summary);
    expect(sticky).not.toContainElement(screen.getByRole("heading", { name: "Queue a beacon task" }));
    expect(sticky).toHaveAttribute("data-stuck", "false");
    expect(viewport.scrollTop).toBe(0);
    const observer = intersectionObserverRecords.find((candidate) => candidate.observed.includes(marker));
    expect(observer?.root).toBe(viewport);
    if (!observer) throw new Error("The beacon scroll marker was not observed");

    act(() => emitIntersection(observer, marker, 39, 40));
    expect(sticky).toHaveAttribute("data-stuck", "true");
    act(() => emitIntersection(observer, marker, 40, 40));
    expect(sticky).toHaveAttribute("data-stuck", "false");
    act(() => emitIntersection(observer, marker, 39, 40));
    viewport.scrollTop = 140;
    const refreshedBeacon = { ...beacon, name: "refreshed-warehouse", pid: 5002 };
    const refreshed = targetSnapshot("beacon");
    refreshed.beacons = [refreshedBeacon];
    refreshed.domains.beacons.items = [refreshedBeacon];
    refreshed.targetContext.activeTargetSummary = refreshedBeacon;
    view.rerender(
      <div className={viewportClass} ref={initializeViewport}>
        <TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={refreshed} onSnapshot={vi.fn()} />
      </div>,
    );
    expect(screen.getByRole("heading", { name: refreshedBeacon.name })).toBeInTheDocument();
    expect(sticky).toHaveAttribute("data-stuck", "true");
    expect(viewport.scrollTop).toBe(140);
    expect(observer.disconnected).toBe(false);
    expect(intersectionObserverRecords.filter((candidate) => candidate.observed.includes(marker))).toHaveLength(1);
    view.unmount();
    expect(observer.disconnected).toBe(true);
  });

  it("replaces the beacon summary observer on target switches and disconnects it on quarantine", () => {
    installAPI();
    const view = render(
      <div className="app-content">
        <TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={switchableBeaconSnapshot()} onSnapshot={vi.fn()} />
      </div>,
    );
    const marker = view.container.querySelector(".beacon-workspace__scroll-marker");
    const sticky = view.container.querySelector(".beacon-workspace__sticky");
    const viewport = view.container.querySelector<HTMLDivElement>(".app-content");
    if (!marker || !sticky || !viewport) throw new Error("The beacon switch observer markup is incomplete");
    const initialObserver = intersectionObserverRecords.find((candidate) => candidate.observed.includes(marker));
    if (!initialObserver) throw new Error("The initial beacon marker was not observed");
    viewport.scrollTop = 140;
    act(() => emitIntersection(initialObserver, marker, -1));
    expect(sticky).toHaveAttribute("data-stuck", "true");

    view.rerender(
      <div className="app-content">
        <TargetsPage expectedTarget={secondBeaconRef} mode="beacon" presentation="dedicated" snapshot={switchableBeaconSnapshot("second")} onSnapshot={vi.fn()} />
      </div>,
    );
    const switchedMarker = view.container.querySelector(".beacon-workspace__scroll-marker");
    const switchedSticky = view.container.querySelector(".beacon-workspace__sticky");
    if (!switchedMarker || !switchedSticky) throw new Error("The switched beacon observer markup is incomplete");
    expect(initialObserver.disconnected).toBe(true);
    expect(viewport.scrollTop).toBe(0);
    expect(switchedSticky).toHaveAttribute("data-stuck", "false");
    const switchedObserver = intersectionObserverRecords.find((candidate) => candidate.observed.includes(switchedMarker));
    expect(switchedObserver?.root).toBe(viewport);
    if (!switchedObserver) throw new Error("The switched beacon marker was not observed");
    expect(switchedObserver).not.toBe(initialObserver);

    const quarantined = switchableBeaconSnapshot("second");
    quarantined.targetContext.activeTarget = { ...secondBeaconRef, fingerprint: "f".repeat(64) };
    view.rerender(
      <div className="app-content">
        <TargetsPage expectedTarget={secondBeaconRef} mode="beacon" presentation="dedicated" snapshot={quarantined} onSnapshot={vi.fn()} />
      </div>,
    );
    expect(screen.getByRole("heading", { name: "Beacon interaction unavailable" })).toBeInTheDocument();
    expect(switchedObserver.disconnected).toBe(true);
    expect(view.container.querySelector(".beacon-workspace__scroll-marker")).toBeNull();
  });

  it("does not observe a beacon header without a viewport or on catalog and session pages", () => {
    installAPI();
    const view = render(
      <TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={targetSnapshot("beacon")} onSnapshot={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: beacon.name })).toBeInTheDocument();
    expect(intersectionObserverRecords).toHaveLength(0);
    view.rerender(
      <div className="app-content">
        <TargetsPage mode="beacon" snapshot={targetSnapshot("beacon")} onSnapshot={vi.fn()} />
      </div>,
    );
    expect(screen.getByRole("grid", { name: "Sliver beacons" })).toBeInTheDocument();
    expect(intersectionObserverRecords).toHaveLength(0);
    view.rerender(
      <div className="app-content">
        <TargetsPage mode="session" snapshot={targetSnapshot("session")} onSnapshot={vi.fn()} />
      </div>,
    );
    expect(screen.getByRole("grid", { name: "Sliver sessions" })).toBeInTheDocument();
    expect(intersectionObserverRecords).toHaveLength(0);
  });

  it("keeps beacon command controls beside task views without advanced execution", async () => {
    const user = userEvent.setup();
    const listExecutionCatalog = vi.fn().mockResolvedValue({ ok: true, value: beaconExecutionCatalog() });
    installAPI({ listExecutionCatalog });
    render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={targetSnapshot("beacon")} onBack={vi.fn()} onSnapshot={vi.fn()} />);
    await act(async () => {});

    const composer = screen.getByRole("region", { name: "Queue a beacon task" });
    const tasks = screen.getByRole("region", { name: "Beacon tasks" });
    const leftColumn = composer.parentElement;
    if (!leftColumn) throw new Error("The beacon composer column is incomplete");
    expect(tasks.parentElement).toBe(leftColumn.parentElement);
    expect(leftColumn).not.toContainElement(tasks);
    expect(within(tasks).getByRole("tab", { name: "Task queue" })).toHaveAttribute("aria-selected", "true");
    expect(within(tasks).getByRole("grid", { name: "Beacon task queue" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Advanced execution" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show advanced execution" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Beacon details" }));
    expect(screen.queryByRole("heading", { name: "Execution workbench" })).not.toBeInTheDocument();
    expect(listExecutionCatalog).not.toHaveBeenCalled();
  });

  it("keeps shared beacon execution available and discards its review when the exact identity changes", async () => {
    const user = userEvent.setup();
    const reviewedPlan = beaconExecutionPlan();
    const replacementRef: TargetRef = { ...beaconRef, fingerprint: "e".repeat(64) };
    const listExecutionCatalog = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: beaconExecutionCatalog() })
      .mockResolvedValue({ ok: true, value: beaconExecutionCatalog(replacementRef) });
    const prepareExecutionAction = vi.fn().mockResolvedValue({ ok: true, value: reviewedPlan });
    const discardExecutionPlan = vi.fn().mockResolvedValue({ ok: true });
    installAPI({ discardExecutionPlan, listExecutionCatalog, prepareExecutionAction });
    const { rerender } = render(
      <TargetExecutionWorkbench expectedTarget={beaconRef} targetIdentity={`shared-beacon:${beaconRef.fingerprint}`} />,
    );

    expect(await screen.findByRole("heading", { name: "Execution workbench" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Identity" }));
    await user.click(screen.getByRole("button", { name: "Open: Revert identity" }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByRole("alertdialog", { name: "Execute this reviewed action?" });
    expect(prepareExecutionAction).toHaveBeenCalledWith({
      draft: { operationId: "privilege.revert", timeoutSeconds: 30 },
    });

    rerender(<TargetExecutionWorkbench expectedTarget={replacementRef} targetIdentity={`shared-beacon:${replacementRef.fingerprint}`} />);

    expect(screen.queryByRole("alertdialog", { name: "Execute this reviewed action?" })).not.toBeInTheDocument();
    await waitFor(() => expect(discardExecutionPlan).toHaveBeenCalledExactlyOnceWith({ token: reviewedPlan.token }));
    await waitFor(() => expect(listExecutionCatalog).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "Execution workbench" })).toBeInTheDocument();
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
    expect(screen.getByRole("tab", { name: "Task queue" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(getBeaconTask).toHaveBeenCalledWith({ taskId: "task-pwd-1" }));
    await user.click(screen.getByRole("tab", { name: "Task output" }));
    expect(await screen.findByText("Waiting for the beacon")).toBeInTheDocument();

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
    expect(screen.queryByRole("heading", { name: "No task output" })).not.toBeInTheDocument();
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
    expect(screen.queryByRole("heading", { name: "No task output" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("tab", { name: "Task output" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Task output" }));
    summary = completed;
    await act(async () => invalidateTasks?.(beaconRef));
    firstDetail.resolve({ ok: true, value: pending });

    expect(await screen.findByText("/srv/race-complete")).toBeInTheDocument();
    expect(getBeaconTask).toHaveBeenCalledTimes(2);
  });

  it("automatically appends task outputs and keeps decoded history cached across catalog refreshes", async () => {
    const user = userEvent.setup();
    const first = beaconTaskDetail();
    const second = beaconTaskDetail({
      taskId: "task-output-2",
      disposition: {
        kind: "structured-detail",
        title: "Working directory",
        fields: [{ label: "Path", value: "/srv/appended-output" }],
        truncated: false,
      },
    });
    let listedTasks = [first];
    let invalidateTasks: ((target: TargetRef) => void) | undefined;
    const getBeaconTask = vi.fn().mockImplementation(async ({ taskId }) => ({
      ok: true,
      value: taskId === first.taskId ? first : second,
    }));
    const listBeaconTasks = vi.fn().mockImplementation(async () => ({
      ok: true,
      value: { items: listedTasks, page: { limit: 100, total: listedTasks.length, truncated: false } },
    }));
    installAPI({
      getBeaconTask,
      listBeaconTasks,
      onBeaconTasksInvalidated: vi.fn((listener) => {
        invalidateTasks = listener;
        return vi.fn();
      }),
    });
    render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={targetSnapshot("beacon")} onSnapshot={vi.fn()} />);

    await waitFor(() => expect(getBeaconTask).toHaveBeenCalledWith({ taskId: first.taskId }));
    expect(screen.getByRole("tab", { name: "Task queue" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Task output" }));
    const output = screen.getByRole("tabpanel", { name: "Task output" });
    expect(await within(output).findByText("/srv/first-output")).toBeInTheDocument();
    listedTasks = [second];
    await act(async () => invalidateTasks?.(beaconRef));
    expect(await within(output).findByText("/srv/appended-output")).toBeInTheDocument();
    expect(within(output).getByText("/srv/first-output")).toBeInTheDocument();
    expect(within(output).getAllByRole("article")).toHaveLength(2);
    expect(getBeaconTask).toHaveBeenCalledTimes(2);
    await act(async () => invalidateTasks?.(beaconRef));
    await waitFor(() => expect(listBeaconTasks).toHaveBeenCalledTimes(3));
    expect(getBeaconTask).toHaveBeenCalledTimes(2);
    expect(within(output).queryByText("Origin")).not.toBeInTheDocument();
    expect(within(output).queryByText("Created")).not.toBeInTheDocument();
    expect(within(output).queryByText("Sent")).not.toBeInTheDocument();
    expect(output.querySelector("dl")).toBeNull();
  });

  it("opens pending task status in output history and lets operators return to the queue", async () => {
    const user = userEvent.setup();
    const pending = beaconTaskDetail({ state: "pending", resultAvailable: false, cancellation: { available: true } });
    delete pending.completedAt;
    delete pending.disposition;
    const getBeaconTask = vi.fn().mockResolvedValue({ ok: true, value: pending });
    installAPI({
      getBeaconTask,
      listBeaconTasks: vi.fn().mockResolvedValue({
        ok: true,
        value: { items: [pending], page: { limit: 100, total: 1, truncated: false } },
      }),
    });
    render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={targetSnapshot("beacon")} onSnapshot={vi.fn()} />);

    expect(screen.getByRole("tab", { name: "Task queue" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Task output" }));
    const emptyOutput = screen.getByRole("tabpanel", { name: "Task output" });
    expect(within(emptyOutput).getByRole("heading", { name: "No task output" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Task queue" }));
    await user.click(await screen.findByRole("row", { name: /task-output-1/i }));
    await waitFor(() => expect(getBeaconTask).toHaveBeenCalledWith({ taskId: pending.taskId }));
    expect(screen.getByRole("tab", { name: "Task output" })).toHaveAttribute("aria-selected", "true");
    const output = screen.getByRole("tabpanel", { name: "Task output" });
    expect(await within(output).findByText("Waiting for the beacon")).toBeInTheDocument();
    expect(within(output).getByRole("button", { name: "Cancel task" })).toBeEnabled();
    expect(screen.queryByRole("grid", { name: "Beacon task queue" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Task queue" }));
    expect(screen.getByRole("grid", { name: "Beacon task queue" })).toBeInTheDocument();
    expect(screen.queryByText("Waiting for the beacon")).not.toBeInTheDocument();
  });

  it("cancels an earlier pending output entry after inspecting another task", async () => {
    const user = userEvent.setup();
    const first = beaconTaskDetail({ state: "pending", resultAvailable: false, cancellation: { available: true } });
    delete first.completedAt;
    delete first.disposition;
    const second = { ...first, taskId: "task-pending-2", description: "List processes" };
    let currentFirst = first;
    const cancelBeaconTask = vi.fn().mockImplementation(async () => {
      currentFirst = { ...first, state: "canceled", cancellation: { available: false } };
      return { ok: true, value: currentFirst };
    });
    installAPI({
      cancelBeaconTask,
      getBeaconTask: vi.fn().mockImplementation(async ({ taskId }) => ({
        ok: true,
        value: taskId === first.taskId ? currentFirst : second,
      })),
      listBeaconTasks: vi.fn().mockImplementation(async () => ({
        ok: true,
        value: { items: [currentFirst, second], page: { limit: 100, total: 2, truncated: false } },
      })),
    });
    render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={targetSnapshot("beacon")} onSnapshot={vi.fn()} />);

    await user.click(await screen.findByRole("row", { name: /task-output-1/i }));
    const firstEntry = await screen.findByRole("article", { name: `Task output ${first.taskId}` });
    expect(await within(firstEntry).findByRole("button", { name: "Cancel task" })).toBeEnabled();
    await user.click(screen.getByRole("tab", { name: "Task queue" }));
    await user.click(screen.getByRole("row", { name: /task-pending-2/i }));
    const output = screen.getByRole("tabpanel", { name: "Task output" });
    const secondEntry = within(output).getByRole("article", { name: `Task output ${second.taskId}` });
    expect(await within(secondEntry).findByText("Waiting for the beacon")).toBeInTheDocument();
    const currentFirstEntry = within(output).getByRole("article", { name: `Task output ${first.taskId}` });
    await user.click(within(currentFirstEntry).getByRole("button", { name: "Cancel task" }));
    await waitFor(() => expect(cancelBeaconTask).toHaveBeenCalledExactlyOnceWith({ taskId: first.taskId }));
    expect(await within(currentFirstEntry).findByText("Canceled")).toBeInTheDocument();
    expect(within(currentFirstEntry).queryByRole("button", { name: "Cancel task" })).not.toBeInTheDocument();
    expect(within(secondEntry).getByText("Waiting for the beacon")).toBeInTheDocument();
  });

  it("opens the completed output entry while keeping other output history visible as details load", async () => {
    const user = userEvent.setup();
    const first = beaconTaskDetail();
    const second = beaconTaskDetail({
      taskId: "task-output-2",
      disposition: {
        kind: "structured-detail",
        title: "Working directory",
        fields: [{ label: "Path", value: "/srv/second-output" }],
        truncated: false,
      },
    });
    const secondDetail = deferred<Awaited<ReturnType<SliverDesktopAPI["getBeaconTask"]>>>();
    const getBeaconTask = vi.fn().mockImplementation(({ taskId }) =>
      taskId === first.taskId ? Promise.resolve({ ok: true, value: first }) : secondDetail.promise
    );
    installAPI({
      getBeaconTask,
      listBeaconTasks: vi.fn().mockResolvedValue({
        ok: true,
        value: { items: [first, second], page: { limit: 100, total: 2, truncated: false } },
      }),
    });
    render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={targetSnapshot("beacon")} onSnapshot={vi.fn()} />);

    await waitFor(() => expect(getBeaconTask).toHaveBeenCalledTimes(2));
    await user.click(await screen.findByRole("row", { name: /task-output-1/i }));
    expect(screen.getByRole("tab", { name: "Task output" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("/srv/first-output")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Beacon task outputs" })).toBeInTheDocument();
    const firstEntry = screen.getByRole("article", { name: `Task output ${first.taskId}` });
    await waitFor(() => expect(firstEntry).toHaveFocus());
    await user.click(screen.getByRole("tab", { name: "Task queue" }));
    await user.click(screen.getByRole("row", { name: /task-output-2/i }));
    expect(screen.getByRole("tab", { name: "Task output" })).toHaveAttribute("aria-selected", "true");
    const loadingOutput = screen.getByRole("tabpanel", { name: "Task output" });
    const secondEntry = within(loadingOutput).getByRole("article", { name: `Task output ${second.taskId}` });
    expect(within(secondEntry).getByText("Loading task output…")).toBeInTheDocument();
    expect(within(loadingOutput).getByText("/srv/first-output")).toBeInTheDocument();
    await waitFor(() => expect(secondEntry).toHaveFocus());
    await act(async () => secondDetail.resolve({ ok: true, value: second }));
    expect(await within(loadingOutput).findByText("/srv/second-output")).toBeInTheDocument();
    expect(within(loadingOutput).queryByText("Loading task output…")).not.toBeInTheDocument();
    expect(within(loadingOutput).getByText("/srv/first-output")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Task queue" }));
    await user.click(screen.getByRole("tab", { name: "Task output" }));
    expect(screen.getByText("/srv/second-output")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Task queue" }));
    screen.getByRole("row", { name: /task-output-1/i }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("tab", { name: "Task output" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByRole("article", { name: `Task output ${first.taskId}` })).toHaveFocus());
    expect(await screen.findByText("/srv/first-output")).toBeInTheDocument();
    expect(getBeaconTask).toHaveBeenCalledTimes(2);
  });

  it("isolates failed output entries and retries them without replacing successful history", async () => {
    const user = userEvent.setup();
    const task = beaconTaskDetail();
    const successful = beaconTaskDetail({
      taskId: "task-successful-1",
      disposition: {
        kind: "structured-detail",
        title: "Working directory",
        fields: [{ label: "Path", value: "/srv/successful-history" }],
        truncated: false,
      },
    });
    let failedAttempts = 0;
    const getBeaconTask = vi.fn().mockImplementation(async ({ taskId }) => {
      if (taskId === successful.taskId) return { ok: true, value: successful };
      failedAttempts += 1;
      return failedAttempts === 1
        ? { ok: false, error: "The task detail could not be fetched" }
        : { ok: true, value: task };
    });
    installAPI({
      getBeaconTask,
      listBeaconTasks: vi.fn().mockResolvedValue({
        ok: true,
        value: { items: [task, successful], page: { limit: 100, total: 2, truncated: false } },
      }),
    });
    render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={targetSnapshot("beacon")} onSnapshot={vi.fn()} />);

    await waitFor(() => expect(getBeaconTask).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("tab", { name: "Task output" }));
    const output = screen.getByRole("tabpanel", { name: "Task output" });
    const failedEntry = within(output).getByRole("article", { name: `Task output ${task.taskId}` });
    expect(await within(failedEntry).findByRole("alert")).toHaveTextContent("The task detail could not be fetched");
    expect(within(failedEntry).getByRole("button", { name: "Retry task output" })).toBeEnabled();
    expect(await within(output).findByText("/srv/successful-history")).toBeInTheDocument();
    expect(within(output).queryByText("Loading task output…")).not.toBeInTheDocument();
    expect(within(output).queryByText("/srv/first-output")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Task queue" }));
    await user.click(screen.getByRole("row", { name: /task-output-1/i }));
    expect(await screen.findByText("/srv/first-output")).toBeInTheDocument();
    expect(screen.getByText("/srv/successful-history")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Task output" })).toHaveAttribute("aria-selected", "true");
    expect(getBeaconTask).toHaveBeenCalledTimes(3);
  });

  it.each(["button", "queue"] as const)("retries a decode-uncertain output through the %s without a new task revision", async (retry) => {
    const user = userEvent.setup();
    const task = beaconTaskDetail();
    const uncertain = {
      ...task,
      error: "The task response could not be decoded yet",
      errorKind: "decode-uncertain" as const,
    };
    delete uncertain.disposition;
    const successful = beaconTaskDetail({
      taskId: "task-stable-output",
      disposition: {
        kind: "structured-detail",
        title: "Working directory",
        fields: [{ label: "Path", value: "/srv/stable-output" }],
        truncated: false,
      },
    });
    let decodeAttempts = 0;
    let invalidateTasks: ((target: TargetRef) => void) | undefined;
    const getBeaconTask = vi.fn().mockImplementation(async ({ taskId }) => {
      if (taskId === successful.taskId) return { ok: true, value: successful };
      decodeAttempts += 1;
      return { ok: true, value: decodeAttempts === 1 ? uncertain : task };
    });
    const listBeaconTasks = vi.fn().mockImplementation(async () => ({
      ok: true,
      value: { items: [{ ...task }, { ...successful }], page: { limit: 100, total: 2, truncated: false } },
    }));
    installAPI({
      getBeaconTask,
      listBeaconTasks,
      onBeaconTasksInvalidated: vi.fn((listener) => {
        invalidateTasks = listener;
        return vi.fn();
      }),
    });
    render(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={targetSnapshot("beacon")} onSnapshot={vi.fn()} />);

    await waitFor(() => expect(getBeaconTask).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("tab", { name: "Task output" }));
    const entry = screen.getByRole("article", { name: `Task output ${task.taskId}` });
    expect(await within(entry).findByRole("alert")).toHaveTextContent(uncertain.error);
    expect(screen.getByText("/srv/stable-output")).toBeInTheDocument();
    await act(async () => invalidateTasks?.(beaconRef));
    await waitFor(() => expect(listBeaconTasks).toHaveBeenCalledTimes(2));
    expect(getBeaconTask).toHaveBeenCalledTimes(2);

    if (retry === "button") {
      await user.click(within(entry).getByRole("button", { name: "Retry task output" }));
    } else {
      await user.click(screen.getByRole("tab", { name: "Task queue" }));
      await user.click(screen.getByRole("row", { name: /task-output-1/i }));
    }
    const decodedEntry = screen.getByRole("article", { name: `Task output ${task.taskId}` });
    expect(await within(decodedEntry).findByText("/srv/first-output")).toBeInTheDocument();
    expect(within(decodedEntry).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(decodedEntry).queryByRole("button", { name: "Retry task output" })).not.toBeInTheDocument();
    expect(screen.getByText("/srv/stable-output")).toBeInTheDocument();
    expect(getBeaconTask).toHaveBeenCalledTimes(3);
  });

  it("resets task tabs on a beacon switch and ignores a previous beacon's pending output", async () => {
    const user = userEvent.setup();
    const first = beaconTaskDetail();
    const second = beaconTaskDetail({
      taskId: "task-nightly-1",
      beaconId: secondBeacon.id,
      disposition: {
        kind: "structured-detail",
        title: "Working directory",
        fields: [{ label: "Path", value: "/srv/nightly-output" }],
        truncated: false,
      },
    });
    let listedTasks = [first];
    const firstDetail = deferred<Awaited<ReturnType<SliverDesktopAPI["getBeaconTask"]>>>();
    const getBeaconTask = vi.fn().mockImplementation(({ taskId }) =>
      taskId === first.taskId ? firstDetail.promise : Promise.resolve({ ok: true, value: second })
    );
    installAPI({
      getBeaconTask,
      listBeaconTasks: vi.fn().mockImplementation(async () => ({
        ok: true,
        value: { items: listedTasks, page: { limit: 100, total: listedTasks.length, truncated: false } },
      })),
    });
    const { rerender } = render(
      <TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={switchableBeaconSnapshot()} onSnapshot={vi.fn()} />,
    );
    await user.click(await screen.findByRole("row", { name: /task-output-1/i }));
    expect(screen.getByRole("tab", { name: "Task output" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Loading task output…")).toBeInTheDocument();
    listedTasks = [second];
    rerender(<TargetsPage expectedTarget={secondBeaconRef} mode="beacon" presentation="dedicated" snapshot={switchableBeaconSnapshot("second")} onSnapshot={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Task queue" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("row", { name: /task-nightly-1/i })).toBeInTheDocument();
    await act(async () => firstDetail.resolve({ ok: true, value: first }));
    expect(screen.getByRole("tab", { name: "Task queue" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Task output" }));
    const output = screen.getByRole("tabpanel", { name: "Task output" });
    expect(await within(output).findByText("/srv/nightly-output")).toBeInTheDocument();
    expect(within(output).getAllByRole("article")).toHaveLength(1);
    expect(within(output).queryByText("/srv/first-output")).not.toBeInTheDocument();
    expect(within(output).queryByText("Loading task output…")).not.toBeInTheDocument();
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

  it.each(rowInteractionCases)("confirms the exact right-clicked $mode before $destination interaction", async ({ mode, label, destination }) => {
    const user = userEvent.setup();
    const secondTarget = mode === "session"
      ? { ...session, id: "session-secondary", name: "secondary-session" }
      : { ...beacon, id: "beacon-secondary", name: "secondary-beacon" };
    const secondRef: TargetRef = { ...(mode === "session" ? sessionRef : beaconRef), id: secondTarget.id, fingerprint: "c".repeat(64) };
    const initial = targetSnapshot(mode);
    if (secondTarget.mode === "session") {
      initial.sessions = [session, secondTarget];
      initial.domains.sessions.items = initial.sessions;
      initial.domains.sessions.page.total = 2;
    } else {
      initial.beacons = [beacon, secondTarget];
      initial.domains.beacons.items = initial.beacons;
      initial.domains.beacons.page.total = 2;
    }
    initial.targetContext.selectableTargets = [...initial.targetContext.selectableTargets, secondRef];
    const confirmedTarget = { ...secondTarget, name: "confirmed-secondary" };
    const selected: SliverSnapshot = {
      ...initial,
      targetContext: { ...initial.targetContext, activeTarget: secondRef, activeTargetSummary: confirmedTarget },
    };
    const gate = deferred<Awaited<ReturnType<SliverDesktopAPI["selectTarget"]>>>();
    const events: string[] = [];
    const selectTarget = vi.fn(() => { events.push("select"); return gate.promise; });
    const openInteractionWindow = vi.fn(async () => { events.push("popout"); return { ok: true as const }; });
    const onSnapshot = vi.fn((_snapshot: SliverSnapshot) => { events.push("snapshot"); });
    const onOpenSession = vi.fn(() => { events.push("session"); });
    const onOpenBeacon = vi.fn(() => { events.push("beacon"); });
    const api = installAPI({ selectTarget, openInteractionWindow });
    const rendered = render(<TargetsPage mode={mode} snapshot={initial} onSnapshot={onSnapshot} onOpenSession={onOpenSession} onOpenBeacon={onOpenBeacon} />);
    fireEvent.contextMenu(screen.getByRole("row", { name: new RegExp(secondTarget.name) }));
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.slice(0, 2).map((item) => item.textContent)).toEqual(["Interact", "Interact"]);
    expect(items[0]).toHaveAccessibleName("Interact");
    expect(items[1]).toHaveAccessibleName("Interact in new window");
    expect(selectTarget).not.toHaveBeenCalled();
    await user.click(within(menu).getByRole("menuitem", { name: label }));
    await waitFor(() => expect(selectTarget).toHaveBeenCalledExactlyOnceWith(secondRef));
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(onOpenBeacon).not.toHaveBeenCalled();
    expect(openInteractionWindow).not.toHaveBeenCalled();

    await act(async () => { gate.resolve({ ok: true, value: selected }); await gate.promise; });
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(selected);
    if (destination === "popout") {
      expect(openInteractionWindow).toHaveBeenCalledExactlyOnceWith();
      expect(onOpenSession).not.toHaveBeenCalled();
      expect(onOpenBeacon).not.toHaveBeenCalled();
      expect(events).toEqual(["select", "snapshot", "popout"]);
    } else {
      const expectedCallback = mode === "session" ? onOpenSession : onOpenBeacon;
      const otherCallback = mode === "session" ? onOpenBeacon : onOpenSession;
      expect(expectedCallback).toHaveBeenCalledExactlyOnceWith(confirmedTarget, secondRef);
      expect(otherCallback).not.toHaveBeenCalled();
      expect(openInteractionWindow).not.toHaveBeenCalled();
      expect(events).toEqual(["select", "snapshot", mode]);
    }
    expect(api.prepareTargetAction).not.toHaveBeenCalled();
    expect(api.submitTargetOperation).not.toHaveBeenCalled();
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

  it.each(rowActionRaceCases)("discards a $mode row $label selection reply after a reconnect", async ({ mode, label }) => {
    const user = userEvent.setup();
    const gate = deferred<Awaited<ReturnType<SliverDesktopAPI["selectTarget"]>>>();
    const selectTarget = vi.fn().mockImplementation(() => gate.promise);
    const api = installAPI({ selectTarget });
    const onSnapshot = vi.fn();
    const onOpenSession = vi.fn();
    const onOpenBeacon = vi.fn();
    const ref = mode === "session" ? sessionRef : beaconRef;
    const initial = targetSnapshot(mode);
    initial.connection.incarnation = 1;
    const rendered = render(<TargetsPage mode={mode} snapshot={initial} onSnapshot={onSnapshot} onOpenSession={onOpenSession} onOpenBeacon={onOpenBeacon} />);
    fireEvent.contextMenu(screen.getByRole("row", { name: mode === "session" ? /payments/i : /warehouse/i }));
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: label }));
    await waitFor(() => expect(selectTarget).toHaveBeenCalledExactlyOnceWith(ref));

    const reconnected = targetSnapshot(mode);
    reconnected.connection.incarnation = 2;
    rendered.rerender(<TargetsPage mode={mode} snapshot={reconnected} onSnapshot={onSnapshot} onOpenSession={onOpenSession} onOpenBeacon={onOpenBeacon} />);
    await act(async () => {
      gate.resolve({ ok: true, value: initial });
      await gate.promise;
    });
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(onOpenBeacon).not.toHaveBeenCalled();
    expect(api.openInteractionWindow).not.toHaveBeenCalled();
    expect(api.prepareTargetAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Rename session" })).not.toBeInTheDocument();
  });

  it.each(rowActionRaceCases)("discards a $mode row $label selection reply after the catalog unmounts", async ({ mode, label }) => {
    const user = userEvent.setup();
    const gate = deferred<Awaited<ReturnType<SliverDesktopAPI["selectTarget"]>>>();
    const selectTarget = vi.fn().mockImplementation(() => gate.promise);
    const api = installAPI({ selectTarget });
    const onSnapshot = vi.fn();
    const onOpenSession = vi.fn();
    const onOpenBeacon = vi.fn();
    const ref = mode === "session" ? sessionRef : beaconRef;
    const snapshot = targetSnapshot(mode);
    const rendered = render(<TargetsPage mode={mode} snapshot={snapshot} onSnapshot={onSnapshot} onOpenSession={onOpenSession} onOpenBeacon={onOpenBeacon} />);
    fireEvent.contextMenu(screen.getByRole("row", { name: mode === "session" ? /payments/i : /warehouse/i }));
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: label }));
    await waitFor(() => expect(selectTarget).toHaveBeenCalledExactlyOnceWith(ref));

    rendered.unmount();
    await act(async () => {
      gate.resolve({ ok: true, value: snapshot });
      await gate.promise;
    });
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(onOpenBeacon).not.toHaveBeenCalled();
    expect(api.openInteractionWindow).not.toHaveBeenCalled();
    expect(api.prepareTargetAction).not.toHaveBeenCalled();
  });

  it.each(rowActionRaceCases)("rejects a $mode row $label response that confirms a replacement target", async ({ mode, label }) => {
    const user = userEvent.setup();
    const ref = mode === "session" ? sessionRef : beaconRef;
    const initial = targetSnapshot(mode);
    const replacement = targetSnapshot(mode);
    replacement.targetContext.activeTarget = { ...ref, fingerprint: "e".repeat(64) };
    const selectTarget = vi.fn().mockResolvedValue({ ok: true, value: replacement });
    const api = installAPI({ selectTarget });
    const onSnapshot = vi.fn();
    const onOpenSession = vi.fn();
    const onOpenBeacon = vi.fn();
    const rendered = render(<TargetsPage mode={mode} snapshot={initial} onSnapshot={onSnapshot} onOpenSession={onOpenSession} onOpenBeacon={onOpenBeacon} />);
    fireEvent.contextMenu(screen.getByRole("row", { name: mode === "session" ? /payments/i : /warehouse/i }));
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: label }));
    await waitFor(() => expect(selectTarget).toHaveBeenCalledExactlyOnceWith(ref));
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(onOpenBeacon).not.toHaveBeenCalled();
    expect(api.openInteractionWindow).not.toHaveBeenCalled();
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

  it.each(["session", "beacon"] as const)(
    "keeps %s search rows visible across a domain refresh without using stale target references",
    async (mode) => {
      const user = userEvent.setup();
      const target = mode === "session" ? session : beacon;
      const initialRef = mode === "session" ? sessionRef : beaconRef;
      const refreshedRef = { ...initialRef, domainRevision: initialRef.domainRevision + 1 };
      const refreshedTarget = { ...target, name: `${target.name}-updated` };
      const refreshedSearch = deferred<Awaited<ReturnType<SliverDesktopAPI["listTargets"]>>>();
      const page = { limit: 100, total: 1, truncated: false };
      const listTargets = vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { items: [{ target, ref: initialRef }], page } })
        .mockImplementationOnce(() => refreshedSearch.promise);
      const selectTarget = vi.fn().mockResolvedValue({ ok: true, value: targetSnapshot(mode) });
      installAPI({ listTargets, selectTarget });
      const initial = targetSnapshot();
      const rendered = render(<TargetsPage mode={mode} snapshot={initial} onSnapshot={vi.fn()} />);

      await user.type(screen.getByRole("searchbox", { name: `Filter ${mode}s` }), target.name);
      await waitFor(() => expect(listTargets).toHaveBeenCalledOnce());
      expect(await screen.findByRole("row", { name: new RegExp(target.name) })).toBeInTheDocument();

      const refreshed = targetSnapshot();
      if (mode === "session") {
        refreshed.domains.sessions = { ...refreshed.domains.sessions, revision: refreshedRef.domainRevision };
      } else {
        refreshed.domains.beacons = { ...refreshed.domains.beacons, revision: refreshedRef.domainRevision };
      }
      refreshed.targetContext.selectableTargets = [
        mode === "session" ? refreshedRef : sessionRef,
        mode === "beacon" ? refreshedRef : beaconRef,
      ];
      rendered.rerender(<TargetsPage mode={mode} snapshot={refreshed} onSnapshot={vi.fn()} />);

      const staleRow = screen.getByRole("row", { name: new RegExp(target.name) });
      expect(staleRow).toBeInTheDocument();
      await waitFor(() => expect(listTargets).toHaveBeenCalledTimes(2));
      expect(staleRow).toBeInTheDocument();
      if (mode === "session") {
        expect(screen.getByRole("button", { name: `Interact with ${target.name}` })).toBeDisabled();
      }
      await user.click(staleRow);
      expect(selectTarget).not.toHaveBeenCalled();
      fireEvent.contextMenu(staleRow);
      expect(screen.queryByRole("menuitem", { name: "Interact" })).not.toBeInTheDocument();

      await act(async () => {
        refreshedSearch.resolve({ ok: true, value: { items: [{ target: refreshedTarget, ref: refreshedRef }], page } });
        await refreshedSearch.promise;
      });
      if (mode === "session") {
        expect(screen.getByRole("button", { name: `Interact with ${refreshedTarget.name}` })).toBeEnabled();
      }
      await user.click(await screen.findByRole("row", { name: new RegExp(refreshedTarget.name) }));
      await waitFor(() => expect(selectTarget).toHaveBeenCalledExactlyOnceWith(refreshedRef));
    },
  );

  it.each(["query", "backend"] as const)(
    "clears settled search rows when the %s identity changes",
    async (change) => {
      const user = userEvent.setup();
      const oldTarget = { ...session, name: "payments-old" };
      const newTarget = { ...session, id: "session-new", name: "payments-new" };
      const newRef = { ...sessionRef, id: newTarget.id };
      const nextSearch = deferred<Awaited<ReturnType<SliverDesktopAPI["listTargets"]>>>();
      const page = { limit: 100, total: 1, truncated: false };
      const listTargets = vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { items: [{ target: oldTarget, ref: sessionRef }], page } })
        .mockImplementationOnce(() => nextSearch.promise);
      installAPI({ listTargets });
      const initial = targetSnapshot();
      initial.connection.incarnation = 1;
      const rendered = render(<TargetsPage mode="session" snapshot={initial} onSnapshot={vi.fn()} />);
      const search = screen.getByRole("searchbox", { name: "Filter sessions" });

      await user.type(search, "payments");
      expect(await screen.findByRole("row", { name: /payments-old/i })).toBeInTheDocument();

      if (change === "query") {
        await user.clear(search);
        await user.type(search, "pay");
      } else {
        const reconnected = targetSnapshot();
        reconnected.connection.incarnation = 2;
        rendered.rerender(<TargetsPage mode="session" snapshot={reconnected} onSnapshot={vi.fn()} />);
      }
      expect(screen.queryByRole("row", { name: /payments-old/i })).not.toBeInTheDocument();
      await waitFor(() => expect(listTargets).toHaveBeenCalledTimes(2));
      expect(screen.getByText("Searching sessions")).toBeInTheDocument();

      await act(async () => {
        nextSearch.resolve({ ok: true, value: { items: [{ target: newTarget, ref: newRef }], page } });
        await nextSearch.promise;
      });
      expect(await screen.findByRole("row", { name: /payments-new/i })).toBeInTheDocument();
      expect(screen.queryByRole("row", { name: /payments-old/i })).not.toBeInTheDocument();
    },
  );

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

    const { rerender } = render(<TargetsPage mode="beacon" snapshot={snapshot} onSnapshot={vi.fn()} />);

    const taskRow = await screen.findByRole("row", { name: /task-1/i });
    await user.click(taskRow);
    const taskDialog = await screen.findByRole("dialog", { name: "Ping" });
    await user.click(within(taskDialog).getByRole("button", { name: "Cancel task" }));
    await waitFor(() => expect(cancelBeaconTask).toHaveBeenCalledWith({ taskId: "task-1" }));
    await user.click(within(taskDialog).getByText("Close"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Ping" })).not.toBeInTheDocument());

    rerender(<TargetsPage expectedTarget={beaconRef} mode="beacon" presentation="dedicated" snapshot={snapshot} onSnapshot={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Beacon details" }));
    await user.click(screen.getByRole("switch", { name: "Watch active beacon" }));
    expect(setBeaconWatch).toHaveBeenCalledWith({ enabled: true });

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
