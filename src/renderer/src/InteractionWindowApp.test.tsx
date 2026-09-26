import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnection } from "./components/ConnectionProvider";

import type {
  SliverDesktopAPI,
  SliverSnapshot,
  WindowLaunchContext,
} from "../../shared/contracts";
import type {
  BeaconSummary,
  SessionSummary,
  TargetRef,
} from "../../shared/target-contracts";

interface TestSessionRoute {
  readonly sessionId: string;
  readonly backendEpoch: number;
  readonly connectionIncarnation: number;
  readonly targetFingerprint: string;
}

const childMocks = vi.hoisted(() => ({
  nextSessionSnapshot: undefined as SliverSnapshot | undefined,
  nextSessionRoute: undefined as TestSessionRoute | undefined,
  nextBeaconSnapshot: undefined as SliverSnapshot | undefined,
  nextBeaconTarget: undefined as TargetRef | undefined,
}));

vi.mock("./pages/SessionWorkspacePage", () => ({
  SessionWorkspacePage: (props: {
    allowPopOut?: boolean;
    route: TestSessionRoute;
    session: SessionSummary | null;
    snapshot: SliverSnapshot;
    onSessionChange?: (snapshot: SliverSnapshot, route: TestSessionRoute) => void;
  }) => {
    const { managedServer } = useConnection();
    const active = props.snapshot.targetContext.activeTarget;
    const quarantined = props.session === null ||
      active?.mode !== "session" ||
      active.id !== props.route.sessionId ||
      active.backendEpoch !== props.route.backendEpoch ||
      active.fingerprint !== props.route.targetFingerprint;
    return (
      <section
        aria-label="Mock session interaction"
        data-allow-popout={String(props.allowPopOut)}
        data-managed-deployment={managedServer?.deploymentId}
        data-quarantined={String(quarantined)}
        data-session-id={props.route.sessionId}
        data-target-fingerprint={props.route.targetFingerprint}
      >
        <span>{props.session?.name ?? "Session quarantined"}</span>
        <button
          onClick={() => {
            if (childMocks.nextSessionSnapshot && childMocks.nextSessionRoute) {
              props.onSessionChange?.(childMocks.nextSessionSnapshot, childMocks.nextSessionRoute);
            }
          }}
          type="button"
        >
          Switch mock session
        </button>
      </section>
    );
  },
}));

vi.mock("./pages/TargetsPage", () => ({
  TargetsPage: (props: {
    expectedTarget?: TargetRef;
    mode: string;
    presentation?: string;
    snapshot: SliverSnapshot;
    onSnapshot?: (snapshot: SliverSnapshot) => void;
    onOpenBeacon?: (beacon: BeaconSummary, target: TargetRef) => void;
  }) => {
    const active = props.snapshot.targetContext.activeTarget;
    const summary = props.snapshot.targetContext.activeTargetSummary;
    const expected = props.expectedTarget;
    const quarantined = expected === undefined ||
      active?.mode !== expected.mode ||
      active.id !== expected.id ||
      active.backendEpoch !== expected.backendEpoch ||
      active.fingerprint !== expected.fingerprint ||
      summary?.mode !== expected.mode ||
      summary.id !== expected.id;
    return (
      <section
        aria-label="Mock beacon interaction"
        data-expected-target={expected?.id}
        data-target-fingerprint={expected?.fingerprint}
        data-mode={props.mode}
        data-presentation={props.presentation}
        data-quarantined={String(quarantined)}
      >
        <span>{summary?.name ?? "Beacon quarantined"}</span>
        <button
          onClick={() => {
            const next = childMocks.nextBeaconSnapshot;
            const target = childMocks.nextBeaconTarget;
            const beacon = next?.targetContext.activeTargetSummary;
            if (next && target && beacon?.mode === "beacon") {
              props.onSnapshot?.(next);
              props.onOpenBeacon?.(beacon, target);
            }
          }}
          type="button"
        >
          Switch mock beacon
        </button>
      </section>
    );
  },
}));

import { disconnectedSnapshot } from "../../shared/contracts";
import {
  InteractionWindowApp,
  resetInteractionWindowClaimForTest,
} from "./InteractionWindowApp";

const session: SessionSummary = {
  mode: "session",
  id: "session-1",
  name: "Payments",
  hostname: "prod-mac",
  hostId: "host-session",
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

const secondSession: SessionSummary = {
  ...session,
  id: "session-2",
  name: "Warehouse",
  hostname: "edge-mac",
  hostId: "host-second-session",
  pid: 4002,
};

const beacon: BeaconSummary = {
  ...session,
  mode: "beacon",
  id: "beacon-1",
  name: "Nightly beacon",
  hostname: "edge-linux",
  hostId: "host-beacon",
  username: "bob",
  os: "linux",
  arch: "amd64",
  checkinStatus: "on-time",
  nextCheckinAt: "2026-08-14T20:00:00.000Z",
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

const secondSessionRef: TargetRef = {
  mode: "session",
  id: secondSession.id,
  backendEpoch: 7,
  domainRevision: 3,
  fingerprint: "c".repeat(64),
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
  name: "Warehouse beacon",
};

const secondBeaconRef: TargetRef = {
  ...beaconRef,
  id: secondBeacon.id,
  fingerprint: "d".repeat(64),
};

beforeEach(() => {
  resetInteractionWindowClaimForTest();
});

afterEach(() => {
  cleanup();
  childMocks.nextSessionSnapshot = undefined;
  childMocks.nextSessionRoute = undefined;
  childMocks.nextBeaconSnapshot = undefined;
  childMocks.nextBeaconTarget = undefined;
  document.title = "";
});

describe("InteractionWindowApp", () => {
  it("routes the exact initial session snapshot into a non-recursive workspace", async () => {
    const snapshot = connectedSnapshot(session, sessionRef);
    snapshot.connection.managedServer = { deploymentId: "deployment-1", provider: "aws", name: "Managed lab" };
    const api = installAPI(Promise.resolve({
      ok: true,
      value: interactionContext(snapshot, sessionRef),
    }));

    render(
      <StrictMode>
        <InteractionWindowApp />
      </StrictMode>,
    );

    const workspace = await screen.findByRole("region", { name: "Mock session interaction" });
    expect(workspace).toHaveAttribute("data-session-id", session.id);
    expect(workspace).toHaveAttribute("data-target-fingerprint", sessionRef.fingerprint);
    expect(workspace).toHaveAttribute("data-allow-popout", "false");
    expect(workspace).toHaveAttribute("data-managed-deployment", "deployment-1");
    expect(workspace).toHaveAttribute("data-quarantined", "false");
    expect(api.claimInteractionWindow).toHaveBeenCalledOnce();
    expect(api.onSnapshotChanged).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("region", { name: "Mock beacon interaction" })).not.toBeInTheDocument();
  });

  it("routes the exact initial beacon snapshot with dedicated presentation", async () => {
    const snapshot = connectedSnapshot(beacon, beaconRef);
    installAPI(Promise.resolve({
      ok: true,
      value: interactionContext(snapshot, beaconRef),
    }));

    render(<InteractionWindowApp />);

    const workspace = await screen.findByRole("region", { name: "Mock beacon interaction" });
    expect(workspace).toHaveAttribute("data-mode", "beacon");
    expect(workspace).toHaveAttribute("data-presentation", "dedicated");
    expect(workspace).toHaveAttribute("data-expected-target", beacon.id);
    expect(workspace).toHaveAttribute("data-quarantined", "false");
    expect(screen.queryByRole("region", { name: "Mock session interaction" })).not.toBeInTheDocument();
  });

  it("takes its launch pin only from main even when a snapshot event arrives before the claim", async () => {
    const initial = deferred<Awaited<ReturnType<SliverDesktopAPI["claimInteractionWindow"]>>>();
    const api = installAPI(initial.promise);
    render(<InteractionWindowApp />);

    act(() => api.emit(connectedSnapshot(beacon, beaconRef)));
    const sessionSnapshot = connectedSnapshot(session, sessionRef);
    await act(async () => initial.resolve({ ok: true, value: interactionContext(sessionSnapshot, sessionRef) }));
    const sessionWorkspace = await screen.findByRole("region", { name: "Mock session interaction" });
    expect(sessionWorkspace).toHaveAttribute("data-session-id", session.id);
    expect(sessionWorkspace).toHaveAttribute("data-quarantined", "true");
    expect(screen.queryByRole("region", { name: "Mock beacon interaction" })).not.toBeInTheDocument();
  });

  it("updates the pinned route and snapshot through the session-switch callback", async () => {
    const nextSnapshot = connectedSnapshot(secondSession, secondSessionRef);
    childMocks.nextSessionSnapshot = nextSnapshot;
    childMocks.nextSessionRoute = routeFor(secondSessionRef);
    const initialSnapshot = connectedSnapshot(session, sessionRef);
    installAPI(Promise.resolve({
      ok: true,
      value: interactionContext(initialSnapshot, sessionRef),
    }));
    render(<InteractionWindowApp />);
    await screen.findByText(session.name);

    fireEvent.click(screen.getByRole("button", { name: "Switch mock session" }));

    await waitFor(() => {
      const workspace = screen.getByRole("region", { name: "Mock session interaction" });
      expect(workspace).toHaveAttribute("data-session-id", secondSession.id);
      expect(workspace).toHaveAttribute("data-target-fingerprint", secondSessionRef.fingerprint);
      expect(workspace).toHaveAttribute("data-quarantined", "false");
    });
    expect(screen.getByText(secondSession.name)).toBeInTheDocument();
  });

  it("updates the pinned target through the beacon-switch callback and quarantines later mismatches", async () => {
    const initialSnapshot = connectedSnapshot(beacon, beaconRef);
    const nextSnapshot = connectedSnapshot(secondBeacon, secondBeaconRef);
    childMocks.nextBeaconSnapshot = nextSnapshot;
    childMocks.nextBeaconTarget = secondBeaconRef;
    const api = installAPI(Promise.resolve({
      ok: true,
      value: interactionContext(initialSnapshot, beaconRef),
    }));
    render(<InteractionWindowApp />);
    const workspace = await screen.findByRole("region", { name: "Mock beacon interaction" });
    expect(workspace).toHaveAttribute("data-expected-target", beacon.id);

    fireEvent.click(screen.getByRole("button", { name: "Switch mock beacon" }));

    await waitFor(() => {
      const switchedWorkspace = screen.getByRole("region", { name: "Mock beacon interaction" });
      expect(switchedWorkspace).toHaveAttribute("data-expected-target", secondBeacon.id);
      expect(switchedWorkspace).toHaveAttribute("data-target-fingerprint", secondBeaconRef.fingerprint);
      expect(switchedWorkspace).toHaveAttribute("data-quarantined", "false");
      expect(document.title).toBe(`Interact — ${secondBeacon.name}`);
    });
    expect(screen.getByText(secondBeacon.name)).toBeInTheDocument();
    const switchedWorkspace = screen.getByRole("region", { name: "Mock beacon interaction" });

    act(() => api.emit(initialSnapshot));
    await waitFor(() => expect(switchedWorkspace).toHaveAttribute("data-quarantined", "true"));
    expect(switchedWorkspace).toHaveAttribute("data-expected-target", secondBeacon.id);
    expect(switchedWorkspace).toHaveAttribute("data-target-fingerprint", secondBeaconRef.fingerprint);
    expect(document.title).toBe(`Interact — ${secondBeacon.name}`);

    act(() => api.emit(nextSnapshot));
    await waitFor(() => expect(switchedWorkspace).toHaveAttribute("data-quarantined", "false"));
  });

  it("quarantines a vanished session and a mismatched beacon without retargeting the window", async () => {
    const initialSessionSnapshot = connectedSnapshot(session, sessionRef);
    const sessionApi = installAPI(Promise.resolve({
      ok: true,
      value: interactionContext(initialSessionSnapshot, sessionRef),
    }));
    const { unmount } = render(<InteractionWindowApp />);
    const sessionWorkspace = await screen.findByRole("region", { name: "Mock session interaction" });
    expect(sessionWorkspace).toHaveAttribute("data-quarantined", "false");

    act(() => sessionApi.emit(disconnectedSnapshot()));
    await waitFor(() => expect(sessionWorkspace).toHaveAttribute("data-quarantined", "true"));
    expect(sessionWorkspace).toHaveAttribute("data-session-id", session.id);
    unmount();
    resetInteractionWindowClaimForTest();

    const initialBeaconSnapshot = connectedSnapshot(beacon, beaconRef);
    const beaconApi = installAPI(Promise.resolve({
      ok: true,
      value: interactionContext(initialBeaconSnapshot, beaconRef),
    }));
    render(<InteractionWindowApp />);
    const beaconWorkspace = await screen.findByRole("region", { name: "Mock beacon interaction" });
    expect(beaconWorkspace).toHaveAttribute("data-quarantined", "false");
    act(() => beaconApi.emit(connectedSnapshot(session, sessionRef)));
    await waitFor(() => expect(beaconWorkspace).toHaveAttribute("data-quarantined", "true"));
    expect(beaconWorkspace).toHaveAttribute("data-expected-target", beaconRef.id);
    expect(screen.queryByRole("region", { name: "Mock session interaction" })).not.toBeInTheDocument();
  });

  it("fails closed when a generic window attempts to claim the interaction surface", async () => {
    installAPI(Promise.resolve({
      ok: false,
      error: "This window is not authorized to host an interaction workspace",
    }));

    render(<InteractionWindowApp />);

    expect(await screen.findByText("Interaction unavailable")).toBeInTheDocument();
    expect(screen.getByText("This window is not authorized to host an interaction workspace")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Mock session interaction" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Mock beacon interaction" })).not.toBeInTheDocument();
  });
});

function connectedSnapshot(
  summary: SessionSummary | BeaconSummary,
  target: TargetRef,
): SliverSnapshot {
  const snapshot = disconnectedSnapshot();
  snapshot.connection = {
    managedServer: null,
    status: "connected",
    server: "127.0.0.1:53137",
    operator: "operator",
    configName: "Local",
    epoch: 7,
    incarnation: 4,
  };
  if (summary.mode === "session") {
    snapshot.sessions = [summary];
    snapshot.domains.sessions = {
      status: "ready",
      revision: target.domainRevision,
      items: [summary],
      page: { limit: 100, total: 1, truncated: false },
    };
  } else {
    snapshot.beacons = [summary];
    snapshot.domains.beacons = {
      status: "ready",
      revision: target.domainRevision,
      items: [summary],
      page: { limit: 100, total: 1, truncated: false },
    };
  }
  snapshot.targetContext = {
    status: "selected",
    activeTarget: target,
    activeTargetSummary: summary,
    selectableTargets: [target],
    capabilities: [],
    beaconWatch: false,
  };
  return snapshot;
}

function routeFor(target: TargetRef): TestSessionRoute {
  return {
    sessionId: target.id,
    backendEpoch: target.backendEpoch,
    connectionIncarnation: 4,
    targetFingerprint: target.fingerprint,
  };
}

function interactionContext(
  snapshot: SliverSnapshot,
  target: TargetRef,
): Extract<WindowLaunchContext, { kind: "interaction" }> {
  return { kind: "interaction", snapshot, target };
}

function installAPI(initial: Promise<Awaited<ReturnType<SliverDesktopAPI["claimInteractionWindow"]>>>): {
  readonly emit: (snapshot: SliverSnapshot) => void;
  readonly claimInteractionWindow: ReturnType<typeof vi.fn>;
  readonly onSnapshotChanged: ReturnType<typeof vi.fn>;
} {
  let listener: ((snapshot: SliverSnapshot) => void) | undefined;
  const claimInteractionWindow = vi.fn(() => initial);
  const onSnapshotChanged = vi.fn((next: (snapshot: SliverSnapshot) => void) => {
    listener = next;
    return vi.fn();
  });
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: {
      claimInteractionWindow,
      onSnapshotChanged,
    } as unknown as SliverDesktopAPI,
  });
  return {
    emit(snapshot) {
      if (!listener) throw new Error("Expected the snapshot listener to be installed");
      listener(snapshot);
    },
    claimInteractionWindow,
    onSnapshotChanged,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
