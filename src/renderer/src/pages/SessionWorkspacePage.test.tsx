import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { SliverDesktopAPI, SliverSnapshot } from "../../../shared/contracts";
import type { SessionSummary, TargetRef } from "../../../shared/target-contracts";
import type { TargetOperationRecord } from "../../../shared/operation-contracts";
import {
  SessionWorkspacePage,
  type SessionWorkspaceRoute,
} from "./SessionWorkspacePage";

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

const sessionRef: TargetRef = {
  mode: "session",
  id: session.id,
  backendEpoch: 7,
  domainRevision: 3,
  fingerprint: "a".repeat(64),
};

const route: SessionWorkspaceRoute = {
  sessionId: session.id,
  backendEpoch: 7,
  connectionIncarnation: 4,
  targetFingerprint: sessionRef.fingerprint,
};

function workspaceSnapshot(activeSession = session): SliverSnapshot {
  const snapshot = disconnectedSnapshot();
  snapshot.connection = {
    status: "connected",
    server: "127.0.0.1:53137",
    operator: "m2-verification",
    configName: "M2 test",
    version: "1.7.6",
    epoch: 7,
    incarnation: 4,
  };
  snapshot.sessions = [activeSession];
  snapshot.domains.sessions = {
    status: "ready",
    revision: 3,
    items: [activeSession],
    page: { limit: 500, total: 1, truncated: false },
  };
  snapshot.targetContext = {
    status: "selected",
    activeTarget: sessionRef,
    activeTargetSummary: activeSession,
    selectableTargets: [sessionRef],
    capabilities: [
      { id: "target.ping", available: true },
      { id: "target.rename", available: true },
      { id: "target.environment.write", available: true },
      { id: "target.terminate", available: true },
      { id: "session.close", available: true },
    ],
    beaconWatch: false,
  };
  return snapshot;
}

function operation(overrides: Partial<TargetOperationRecord> = {}): TargetOperationRecord {
  return {
    requestId: "request-1",
    operationId: "target.ping",
    target: sessionRef,
    targetName: session.name,
    backend: {
      configId: "config-1",
      configName: "M2 test",
      server: "127.0.0.1:53137",
      operator: "m2-verification",
      epoch: 7,
    },
    ownership: {
      origin: "local",
      ownerWindowId: 12,
      actor: { attribution: "verified", name: "m2-verification" },
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

function installAPI(operations: TargetOperationRecord[] = []): Pick<SliverDesktopAPI, "listTargetOperations"> {
  const listTargetOperations = vi.fn().mockResolvedValue({
    ok: true,
    value: { items: operations, page: { limit: 100, total: operations.length, truncated: false } },
  });
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: {
      listTargetOperations,
      onOperationChanged: vi.fn(() => vi.fn()),
    } as unknown as SliverDesktopAPI,
  });
  return { listTargetOperations };
}

describe("SessionWorkspacePage", () => {
  it("renders a clean responsive session workspace and exposes typed panel seams", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const filesPanel = vi.fn(() => <section aria-label="Injected files panel">Remote files</section>);
    installAPI();
    const snapshot = workspaceSnapshot();

    render(
      <SessionWorkspacePage
        panels={{ files: filesPanel }}
        route={route}
        session={session}
        snapshot={snapshot}
        onBack={onBack}
        onSnapshot={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "payments" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Processes" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Environment" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Activity" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Registry" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab").at(-1)).toHaveAccessibleName("Activity");

    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByRole("region", { name: "Injected files panel" })).toHaveTextContent("Remote files");
    expect(filesPanel).toHaveBeenCalledWith(expect.objectContaining({ route, session, snapshot }));

    await user.click(screen.getByRole("button", { name: "Back to live sessions" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("shows Registry only for Windows sessions", () => {
    installAPI();
    const windowsSession: SessionSummary = { ...session, os: "windows", arch: "amd64" };
    const snapshot = workspaceSnapshot(windowsSession);

    render(
      <SessionWorkspacePage
        route={route}
        session={windowsSession}
        snapshot={snapshot}
        onBack={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "Registry" })).toBeInTheDocument();
  });

  it("quarantines a route from another connection incarnation", () => {
    const { listTargetOperations } = installAPI();
    const snapshot = workspaceSnapshot();
    snapshot.connection.incarnation = 5;

    render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={snapshot}
        onBack={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Session workspace unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run ping" })).not.toBeInTheDocument();
    expect(listTargetOperations).not.toHaveBeenCalled();
  });

  it("quarantines a same-ID session replacement with a different main-issued fingerprint", () => {
    const { listTargetOperations } = installAPI();
    const snapshot = workspaceSnapshot();
    snapshot.targetContext.activeTarget = {
      ...sessionRef,
      fingerprint: "b".repeat(64),
    };
    snapshot.targetContext.selectableTargets = [snapshot.targetContext.activeTarget];

    render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={snapshot}
        onBack={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Session workspace unavailable" })).toBeInTheDocument();
    expect(listTargetOperations).not.toHaveBeenCalled();
  });

  it("filters Activity to the exact session, backend epoch, and fingerprint", async () => {
    const user = userEvent.setup();
    const otherSession = operation({
      requestId: "request-other-session",
      target: { ...sessionRef, id: "session-2" },
    });
    const otherEpoch = operation({
      requestId: "request-other-epoch",
      target: { ...sessionRef, backendEpoch: 8 },
      backend: { ...operation().backend, epoch: 8 },
    });
    const replacement = operation({
      requestId: "request-replacement",
      target: { ...sessionRef, fingerprint: "b".repeat(64) },
    });
    installAPI([operation(), otherSession, otherEpoch, replacement]);
    const snapshot = workspaceSnapshot();

    render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={snapshot}
        onBack={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("row", { name: /request-1/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("row", { name: /request-other-session/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("row", { name: /request-other-epoch/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("row", { name: /request-replacement/i })).not.toBeInTheDocument();
    });
    expect(screen.getByText("1 matching operations loaded")).toBeInTheDocument();
  });

  it("replaces stale Activity rows on a fresh refresh while append remains bounded", async () => {
    const user = userEvent.setup();
    const stale = operation({ requestId: "request-stale" });
    const current = operation({ requestId: "request-current", updatedAt: "2026-08-09T20:03:01.000Z" });
    const { listTargetOperations } = installAPI([stale]);
    const snapshot = workspaceSnapshot();

    render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={snapshot}
        onBack={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("row", { name: /request-stale/i })).toBeInTheDocument();
    vi.mocked(listTargetOperations).mockResolvedValueOnce({
      ok: true,
      value: { items: [current], page: { limit: 100, total: 1, truncated: false } },
    });

    await user.click(screen.getByRole("button", { name: "Refresh activity" }));
    expect(await screen.findByRole("row", { name: /request-current/i })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /request-stale/i })).not.toBeInTheDocument();
  });

  it("ignores late results from a same-ID route after its fingerprint is replaced", async () => {
    const user = userEvent.setup();
    const oldRequest = deferred<Awaited<ReturnType<SliverDesktopAPI["listTargetOperations"]>>>();
    const newRequest = deferred<Awaited<ReturnType<SliverDesktopAPI["listTargetOperations"]>>>();
    const { listTargetOperations } = installAPI();
    vi.mocked(listTargetOperations)
      .mockReset()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    const snapshot = workspaceSnapshot();
    const { rerender } = render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={snapshot}
        onBack={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );
    await waitFor(() => expect(listTargetOperations).toHaveBeenCalledTimes(1));

    const replacementRef = { ...sessionRef, fingerprint: "b".repeat(64) };
    const replacementRoute = { ...route, targetFingerprint: replacementRef.fingerprint };
    const replacementSnapshot = workspaceSnapshot();
    replacementSnapshot.targetContext.activeTarget = replacementRef;
    replacementSnapshot.targetContext.selectableTargets = [replacementRef];
    rerender(
      <SessionWorkspacePage
        route={replacementRoute}
        session={session}
        snapshot={replacementSnapshot}
        onBack={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );
    await waitFor(() => expect(listTargetOperations).toHaveBeenCalledTimes(2));

    const newest = operation({ requestId: "request-new", target: replacementRef });
    await act(async () => {
      newRequest.resolve({
        ok: true,
        value: { items: [newest], page: { limit: 100, total: 1, truncated: false } },
      });
    });
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("row", { name: /request-new/i })).toBeInTheDocument();

    await act(async () => {
      oldRequest.resolve({
        ok: true,
        value: { items: [operation({ requestId: "request-stale" })], page: { limit: 100, total: 1, truncated: false } },
      });
    });
    expect(screen.getByRole("row", { name: /request-new/i })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /request-stale/i })).not.toBeInTheDocument();
  });
});
