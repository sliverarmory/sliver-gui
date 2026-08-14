import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { SliverDesktopAPI, SliverSnapshot } from "../../../shared/contracts";
import type {
  BeaconSummary,
  SessionSummary,
  TargetActionPlan,
  TargetCapabilityState,
  TargetRef,
} from "../../../shared/target-contracts";
import type { BeaconTaskDetail, TargetOperationRecord } from "../../../shared/operation-contracts";
import { SessionWorkspacePage } from "./SessionWorkspacePage";
import { TargetsPage } from "./TargetsPage";

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
    disconnect: vi.fn(failed),
    downloadBuild: vi.fn(failed),
    exitApp: vi.fn(failed),
    executeStopPlan: vi.fn(failed),
    executeTargetActionPlan: vi.fn(failed),
    executeSessionDestructiveActionPlan: vi.fn(failed),
    generate: vi.fn(failed),
    generateFromProfile: vi.fn(failed),
    getBeaconTask: vi.fn(failed),
    getTerminalRuntime: vi.fn(failed),
    getSnapshot: vi.fn().mockResolvedValue(disconnectedSnapshot()),
    getTargetOperation: vi.fn(failed),
    importConfig: vi.fn(failed),
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
    openStream: vi.fn(),
    onOperationChanged: vi.fn(() => vi.fn()),
    onSnapshotChanged: vi.fn(() => vi.fn()),
    openSessionShellWindow: vi.fn(failed),
    claimSessionShellWindow: vi.fn(failed),
    openWindow: vi.fn(failed),
    prepareStopAllJobs: vi.fn(failed),
    prepareStopJob: vi.fn(failed),
    prepareTargetAction: vi.fn(failed),
    prepareSessionDestructiveAction: vi.fn(failed),
    prepareSessionShell: vi.fn(failed),
    refresh: vi.fn(failed),
    removeSavedConfig: vi.fn(failed),
    runSessionWorkbench: vi.fn(failed),
    actOnSessionShell: vi.fn(failed),
    saveProfile: vi.fn(failed),
    selectTarget: vi.fn(failed),
    setBeaconWatch: vi.fn(failed),
    setStagedBuilds: vi.fn(failed),
    startListener: vi.fn(failed),
    submitTargetOperation: vi.fn(failed),
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

    await user.click(screen.getByRole("button", { name: "Ping" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Rename" }));
    const nameInput = screen.getByRole("textbox", { name: "New target name" });
    await user.type(nameInput, "keep-this-draft");
    await user.click(screen.getByRole("button", { name: "Run rename" }));
    await waitFor(() => expect(submitTargetOperation).toHaveBeenCalledWith({
      operationId: "target.rename",
      name: "keep-this-draft",
    }));
    const reconnected = targetSnapshot("session");
    reconnected.connection.incarnation = 2;
    rerender(sessionWorkspace(reconnected));
    await waitFor(() => expect(screen.getByRole("button", { name: "Run ping" })).toBeEnabled());
    expect(screen.queryByRole("textbox", { name: "New target name" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ping" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Rename" }));
    await user.type(screen.getByRole("textbox", { name: "New target name" }), "current-incarnation-draft");
    await user.click(screen.getByRole("button", { name: "Run rename" }));
    await waitFor(() => expect(submitTargetOperation).toHaveBeenNthCalledWith(2, {
      operationId: "target.rename",
      name: "current-incarnation-draft",
    }));
    expect(screen.getByRole("button", { name: "Run rename" })).toHaveAttribute("data-pending", "true");

    await act(async () => {
      staleSubmitGate.resolve({ ok: true, value: operationRecord({ operationId: "target.rename" }) });
      await staleSubmitGate.promise;
    });

    expect(screen.queryByText("Operation submitted")).not.toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /request-1/i })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "New target name" })).toHaveValue("current-incarnation-draft");
    expect(screen.getByRole("button", { name: "Run rename" })).toHaveAttribute("data-pending", "true");

    await act(async () => {
      currentSubmitGate.resolve({
        ok: true,
        value: operationRecord({ requestId: "request-2", operationId: "target.rename" }),
      });
      await currentSubmitGate.promise;
    });
    expect(screen.getByRole("textbox", { name: "New target name" })).toHaveValue("");
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("row", { name: /request-2/i })).toBeInTheDocument();
  });

  it("keeps an operation draft across domain revisions and quarantines a fingerprint replacement", async () => {
    const user = userEvent.setup();
    installAPI();
    const initial = targetSnapshot("session");
    initial.connection.incarnation = 1;
    const { rerender } = render(sessionWorkspace(initial));

    await user.click(screen.getByRole("button", { name: "Ping" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Rename" }));
    await user.type(screen.getByRole("textbox", { name: "New target name" }), "revision-safe-draft");

    const refreshed = targetSnapshot("session");
    refreshed.connection.incarnation = 1;
    const refreshedRef = { ...sessionRef, domainRevision: 4 };
    refreshed.domains.sessions.revision = 4;
    refreshed.targetContext.activeTarget = refreshedRef;
    refreshed.targetContext.selectableTargets = [refreshedRef, beaconRef];
    rerender(sessionWorkspace(refreshed));

    expect(screen.getByRole("textbox", { name: "New target name" })).toHaveValue("revision-safe-draft");
    expect(screen.getByRole("button", { name: "Run rename" })).toBeEnabled();

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
    expect(screen.queryByRole("textbox", { name: "New target name" })).not.toBeInTheDocument();
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

  it("updates lifecycle actions from authoritative capabilities without restarting the page", () => {
    installAPI();
    const initial = targetSnapshot("session");
    const { rerender } = render(sessionWorkspace(initial));

    expect(screen.getByRole("button", { name: "Kill target" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close session" })).toBeEnabled();

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

    expect(screen.getByRole("button", { name: "Kill target" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close session" })).toBeDisabled();
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
