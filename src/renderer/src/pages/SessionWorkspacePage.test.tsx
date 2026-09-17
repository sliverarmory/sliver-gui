import { useEffect } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

const otherSession: SessionSummary = {
  ...session,
  id: "session-2",
  name: "analytics",
  hostname: "prod-linux",
  hostId: "host-2",
  username: "bob",
  os: "linux",
  arch: "amd64",
  pid: 4002,
};

const otherSessionRef: TargetRef = {
  mode: "session",
  id: otherSession.id,
  backendEpoch: 7,
  domainRevision: 3,
  fingerprint: "b".repeat(64),
};

const thirdSession: SessionSummary = {
  ...session,
  id: "session-3",
  name: "billing",
  hostname: "prod-windows",
  hostId: "host-3",
  username: "carol",
  os: "windows",
  arch: "amd64",
  pid: 4003,
};

const thirdSessionRef: TargetRef = {
  mode: "session",
  id: thirdSession.id,
  backendEpoch: 7,
  domainRevision: 3,
  fingerprint: "c".repeat(64),
};

const route: SessionWorkspaceRoute = {
  sessionId: session.id,
  backendEpoch: 7,
  connectionIncarnation: 4,
  targetFingerprint: sessionRef.fingerprint,
};

const otherRoute: SessionWorkspaceRoute = {
  ...route,
  sessionId: otherSession.id,
  targetFingerprint: otherSessionRef.fingerprint,
};

function workspaceSnapshot(activeSession = session): SliverSnapshot {
  const snapshot = disconnectedSnapshot();
  snapshot.connection = {
    managedServer: null,
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

function switchableWorkspaceSnapshot(): SliverSnapshot {
  const snapshot = workspaceSnapshot();
  snapshot.sessions = [session, otherSession];
  snapshot.domains.sessions = {
    ...snapshot.domains.sessions,
    items: [session, otherSession],
    page: { limit: 500, total: 2, truncated: false },
  };
  snapshot.targetContext.selectableTargets = [sessionRef, otherSessionRef];
  return snapshot;
}

function selectedOtherSessionSnapshot(): SliverSnapshot {
  const snapshot = switchableWorkspaceSnapshot();
  snapshot.targetContext = {
    ...snapshot.targetContext,
    activeTarget: otherSessionRef,
    activeTargetSummary: otherSession,
  };
  return snapshot;
}

function selectedThirdSessionSnapshot(): SliverSnapshot {
  const snapshot = switchableWorkspaceSnapshot();
  snapshot.sessions.push(thirdSession);
  snapshot.domains.sessions = {
    ...snapshot.domains.sessions,
    items: [...snapshot.domains.sessions.items, thirdSession],
    page: { limit: 500, total: 3, truncated: false },
  };
  snapshot.targetContext = {
    ...snapshot.targetContext,
    activeTarget: thirdSessionRef,
    activeTargetSummary: thirdSession,
    selectableTargets: [...snapshot.targetContext.selectableTargets, thirdSessionRef],
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

function installAPI(operations: TargetOperationRecord[] = []): Pick<
  SliverDesktopAPI,
  "listExecutionCatalog" | "listTargetOperations" | "listSessionShells" | "openInteractionWindow" | "selectTarget"
> & {
  emitOperationChanged: (operation: TargetOperationRecord) => void;
} {
  let operationChangedListener: ((operation: TargetOperationRecord) => void) | undefined;
  const listExecutionCatalog = vi.fn().mockResolvedValue({
    ok: true,
    value: {
      target: session,
      targetRef: sessionRef,
      backend: {
        configId: "config-1",
        configName: "M2 test",
        server: "127.0.0.1:53137",
        operator: "m2-verification",
        epoch: 7,
      },
      capabilities: [],
    },
  });
  const listTargetOperations = vi.fn().mockResolvedValue({
    ok: true,
    value: { items: operations, page: { limit: 100, total: operations.length, truncated: false } },
  });
  const listSessionShells = vi.fn().mockResolvedValue({
    ok: true,
    value: { resources: [], metrics: {} },
  });
  const openInteractionWindow = vi.fn().mockResolvedValue({ ok: true });
  const selectTarget = vi.fn().mockResolvedValue({ ok: false, error: "No selection configured" });
  const api = {
    listExecutionCatalog,
    listSessionShells,
    listTargetOperations,
    openInteractionWindow,
    selectTarget,
    onBeaconTasksInvalidated: vi.fn(() => vi.fn()),
    onOperationChanged: vi.fn((listener: (operation: TargetOperationRecord) => void) => {
      operationChangedListener = listener;
      return vi.fn(() => {
        if (operationChangedListener === listener) operationChangedListener = undefined;
      });
    }),
  } as unknown as SliverDesktopAPI;
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: api,
  });
  return {
    listExecutionCatalog,
    listSessionShells,
    listTargetOperations,
    openInteractionWindow,
    selectTarget,
    emitOperationChanged: (operation) => operationChangedListener?.(operation),
  };
}

describe("SessionWorkspacePage", () => {
  it.each(["embedded", "dedicated"] as const)("renames a session from the %s header using the shared dialog", async (presentation) => {
    const user = userEvent.setup();
    installAPI();
    const submitTargetOperation = vi.fn().mockResolvedValue({
      ok: true,
      value: operation({ operationId: "target.rename" }),
    });
    Object.assign(window.sliver, { submitTargetOperation });
    const onSnapshot = vi.fn();
    const view = render(
      <SessionWorkspacePage
        presentation={presentation}
        route={route}
        session={session}
        snapshot={workspaceSnapshot()}
        onSnapshot={onSnapshot}
      />,
    );

    const actions = screen.getByRole("button", { name: "Session actions" });
    expect(actions.closest("header")).toContainElement(screen.getByRole("heading", { name: session.name }));
    await user.click(actions);
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const firstDialog = await screen.findByRole("dialog", { name: "Rename session" });
    expect(within(firstDialog).getByRole("textbox", { name: "Session name" })).toHaveValue(session.name);
    await user.click(within(firstDialog).getByRole("button", { name: "Cancel" }));
    expect(submitTargetOperation).not.toHaveBeenCalled();

    await user.click(actions);
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename session" });
    await user.clear(within(dialog).getByRole("textbox", { name: "Session name" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Session name" }), "payments-new");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename session" })).not.toBeInTheDocument());
    expect(submitTargetOperation).toHaveBeenCalledExactlyOnceWith({ operationId: "target.rename", name: "payments-new" });
    const renamed = { ...session, name: "payments-new" };
    view.rerender(
      <SessionWorkspacePage
        presentation={presentation}
        route={route}
        session={renamed}
        snapshot={workspaceSnapshot(renamed)}
        onSnapshot={onSnapshot}
      />,
    );
    expect(screen.getByRole("heading", { name: "payments-new" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ping" }));
    expect(screen.queryByRole("menuitemradio", { name: "Rename" })).not.toBeInTheDocument();
  });

  it("renders a clean responsive session workspace and exposes typed panel seams", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const filesPanel = vi.fn(() => <section aria-label="Injected files panel">Remote files</section>);
    const networkPanel = vi.fn(() => <section aria-label="Injected network panel">Network inventory</section>);
    const executionPanel = vi.fn(() => <section aria-label="Injected execution panel">Execution workbench</section>);
    const terminalUnmounted = vi.fn();
    const TerminalProbe = (): React.JSX.Element => {
      useEffect(() => () => terminalUnmounted(), []);
      return <section aria-label="Injected terminal panel">Managed terminal</section>;
    };
    const terminalPanel = vi.fn(() => <TerminalProbe />);
    installAPI();
    const snapshot = workspaceSnapshot();

    render(
      <SessionWorkspacePage
        panels={{ execution: executionPanel, files: filesPanel, network: networkPanel, terminal: terminalPanel }}
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
    expect(screen.getByRole("tab", { name: "Network" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Execution" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Environment" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Shell" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Terminal" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Activity" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Registry" })).not.toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    const overviewIndex = tabs.findIndex((tab) => tab.textContent?.includes("Overview"));
    const filesIndex = tabs.findIndex((tab) => tab.textContent?.includes("Files"));
    const processesIndex = tabs.findIndex((tab) => tab.textContent?.includes("Processes"));
    const networkIndex = tabs.findIndex((tab) => tab.textContent?.includes("Network"));
    const executionIndex = tabs.findIndex((tab) => tab.textContent?.includes("Execution"));
    const environmentIndex = tabs.findIndex((tab) => tab.textContent?.includes("Environment"));
    const terminalIndex = tabs.findIndex((tab) => tab.getAttribute("aria-label") === "Shell" || tab.textContent?.includes("Shell"));
    const activityIndex = tabs.findIndex((tab) => tab.getAttribute("aria-label") === "Activity" || tab.textContent?.includes("Activity"));
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(activityIndex).toBe(terminalIndex + 1);
    expect(overviewIndex).toBe(0);
    expect(executionIndex).toBe(overviewIndex + 1);
    expect(filesIndex).toBe(executionIndex + 1);
    expect(processesIndex).toBe(filesIndex + 1);
    expect(networkIndex).toBe(processesIndex + 1);
    expect(environmentIndex).toBe(networkIndex + 1);
    expect(screen.queryByRole("region", { name: "Injected network panel" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByRole("region", { name: "Injected files panel" })).toHaveTextContent("Remote files");
    expect(filesPanel).toHaveBeenCalledWith(expect.objectContaining({ route, session, snapshot }));

    await user.click(screen.getByRole("tab", { name: "Network" }));
    expect(screen.getByRole("region", { name: "Injected network panel" })).toHaveTextContent("Network inventory");
    expect(networkPanel).toHaveBeenCalledWith(expect.objectContaining({ route, session, snapshot }));

    await user.click(screen.getByRole("tab", { name: "Execution" }));
    expect(screen.queryByRole("region", { name: "Injected network panel" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Injected execution panel" })).toHaveTextContent("Execution workbench");
    expect(executionPanel).toHaveBeenCalledWith(expect.objectContaining({ route, session, snapshot }));

    await user.click(screen.getByRole("tab", { name: "Shell" }));
    const mountedTerminal = screen.getByRole("region", { name: "Injected terminal panel" });
    expect(mountedTerminal).toHaveTextContent("Managed terminal");
    expect(terminalPanel).toHaveBeenCalledWith(expect.objectContaining({ route, session, snapshot }));
    const mountedTerminalPanel = mountedTerminal.closest("[role=tabpanel]");
    expect(mountedTerminalPanel).not.toHaveAttribute("data-inert");

    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(terminalUnmounted).not.toHaveBeenCalled();
    expect(mountedTerminalPanel).toHaveAttribute("data-inert", "true");
    expect(mountedTerminalPanel).toHaveClass("data-[inert=true]:hidden");
    await user.click(screen.getByRole("tab", { name: "Shell" }));
    expect(screen.getByRole("region", { name: "Injected terminal panel" })).toBe(mountedTerminal);
    expect(mountedTerminalPanel).not.toHaveAttribute("data-inert");

    await user.click(screen.getByRole("button", { name: "Back to live sessions" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("keeps Sessions in the breadcrumb and switches with an exact main-issued reference", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    const next = selectedOtherSessionSnapshot();
    vi.mocked(api.selectTarget).mockResolvedValue({ ok: true, value: next });
    const onSessionChange = vi.fn();

    render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={switchableWorkspaceSnapshot()}
        onBack={vi.fn()}
        onSessionChange={onSessionChange}
        onSnapshot={vi.fn()}
      />,
    );

    expect(screen.getByRole("navigation", { name: "Session workspace breadcrumbs" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "payments" })).toHaveAttribute("aria-current", "page");
    const trigger = screen.getByRole("button", { name: "Sessions, switch session" });
    expect(trigger.closest("a")).toBeNull();
    await user.click(trigger);
    expect(await screen.findByRole("menuitemradio", { name: /payments/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: "View all sessions" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("menuitemradio", { name: /analytics/i }));

    await waitFor(() => expect(api.listSessionShells).toHaveBeenCalledExactlyOnceWith({}));
    await waitFor(() => expect(api.selectTarget).toHaveBeenCalledExactlyOnceWith(otherSessionRef));
    expect(onSessionChange).toHaveBeenCalledExactlyOnceWith(next, {
      sessionId: otherSession.id,
      backendEpoch: 7,
      connectionIncarnation: 4,
      targetFingerprint: otherSessionRef.fingerprint,
    });
  });

  it("mounts the execution workbench with the exact active session reference", async () => {
    const user = userEvent.setup();
    const api = installAPI();

    render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={workspaceSnapshot()}
        onBack={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );

    expect(api.listExecutionCatalog).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Execution" }));
    expect(await screen.findByRole("heading", { name: "Execution workbench" })).toBeInTheDocument();
    expect(api.listExecutionCatalog).toHaveBeenCalledOnce();
  });

  it("commits an exact selection response after its requested-target event arrives first", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    const selection = deferred<Awaited<ReturnType<SliverDesktopAPI["selectTarget"]>>>();
    vi.mocked(api.selectTarget).mockReturnValue(selection.promise);
    const onSessionChange = vi.fn();
    const onSnapshot = vi.fn();
    const onBack = vi.fn();
    const { rerender } = render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={switchableWorkspaceSnapshot()}
        onBack={onBack}
        onSessionChange={onSessionChange}
        onSnapshot={onSnapshot}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Sessions, switch session" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /analytics/i }));
    await waitFor(() => expect(api.selectTarget).toHaveBeenCalledExactlyOnceWith(otherSessionRef));

    const requestedSnapshot = selectedOtherSessionSnapshot();
    rerender(
      <SessionWorkspacePage
        route={route}
        session={otherSession}
        snapshot={requestedSnapshot}
        onBack={onBack}
        onSessionChange={onSessionChange}
        onSnapshot={onSnapshot}
      />,
    );
    expect(screen.getByRole("heading", { name: "Session workspace unavailable" })).toBeInTheDocument();

    await act(async () => {
      selection.resolve({ ok: true, value: requestedSnapshot });
      await selection.promise;
    });
    await waitFor(() => expect(onSessionChange).toHaveBeenCalledExactlyOnceWith(requestedSnapshot, otherRoute));
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an unrelated target event",
      finalState: () => ({ route, session: thirdSession, snapshot: selectedThirdSessionSnapshot() }),
    },
    {
      name: "a disconnect",
      finalState: () => ({ route, session: null, snapshot: disconnectedSnapshot() }),
    },
    {
      name: "a route change",
      finalState: () => ({ route: otherRoute, session: otherSession, snapshot: selectedOtherSessionSnapshot() }),
    },
  ])("quarantines an earlier selection response after $name", async ({ finalState }) => {
    const user = userEvent.setup();
    const api = installAPI();
    const selection = deferred<Awaited<ReturnType<SliverDesktopAPI["selectTarget"]>>>();
    vi.mocked(api.selectTarget).mockReturnValue(selection.promise);
    const onSessionChange = vi.fn();
    const onSnapshot = vi.fn();
    const onBack = vi.fn();
    const { rerender } = render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={switchableWorkspaceSnapshot()}
        onBack={onBack}
        onSessionChange={onSessionChange}
        onSnapshot={onSnapshot}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Sessions, switch session" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /analytics/i }));
    await waitFor(() => expect(api.selectTarget).toHaveBeenCalledExactlyOnceWith(otherSessionRef));

    const requestedSnapshot = selectedOtherSessionSnapshot();
    rerender(
      <SessionWorkspacePage
        route={route}
        session={otherSession}
        snapshot={requestedSnapshot}
        onBack={onBack}
        onSessionChange={onSessionChange}
        onSnapshot={onSnapshot}
      />,
    );
    const final = finalState();
    rerender(
      <SessionWorkspacePage
        route={final.route}
        session={final.session}
        snapshot={final.snapshot}
        onBack={onBack}
        onSessionChange={onSessionChange}
        onSnapshot={onSnapshot}
      />,
    );

    await act(async () => {
      selection.resolve({ ok: true, value: requestedSnapshot });
      await selection.promise;
    });
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("discloses partial inventory and returns to the full sessions view", async () => {
    const user = userEvent.setup();
    installAPI();
    const snapshot = switchableWorkspaceSnapshot();
    snapshot.domains.sessions.page = { limit: 2, total: 5, truncated: true };
    const onBack = vi.fn();

    render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={snapshot}
        onBack={onBack}
        onSessionChange={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Sessions, switch session" }));
    const viewAll = await screen.findByRole("button", { name: /View all sessions/i });
    expect(viewAll).toHaveTextContent("Showing 2 of 5 available sessions");
    await user.click(viewAll);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("requires confirmation before a session switch closes managed shells", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    vi.mocked(api.listSessionShells).mockResolvedValue({
      ok: true,
      value: { resources: [{ resourceId: "shell-1" }, { resourceId: "shell-2" }], metrics: {} },
    } as unknown as Awaited<ReturnType<SliverDesktopAPI["listSessionShells"]>>);
    vi.mocked(api.selectTarget).mockResolvedValue({ ok: true, value: selectedOtherSessionSnapshot() });

    render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={switchableWorkspaceSnapshot()}
        onBack={vi.fn()}
        onSessionChange={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Sessions, switch session" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /analytics/i }));

    expect(await screen.findByRole("alertdialog", { name: "Switch sessions and close managed shells?" })).toBeInTheDocument();
    expect(api.selectTarget).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Close shells and switch" }));
    await waitFor(() => expect(api.selectTarget).toHaveBeenCalledExactlyOnceWith(otherSessionRef));
  });

  it("pops out the whole interaction through the zero-argument bridge", async () => {
    const user = userEvent.setup();
    const api = installAPI();

    render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={workspaceSnapshot()}
        onBack={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pop out interaction" }));
    await waitFor(() => expect(api.openInteractionWindow).toHaveBeenCalledOnce());
    expect(api.openInteractionWindow).toHaveBeenCalledWith();
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

  it("updates Activity rows from operation events without a refresh control", async () => {
    const user = userEvent.setup();
    const stale = operation({ requestId: "request-live", state: "submitted" });
    const current = operation({ requestId: "request-live", updatedAt: "2026-08-09T20:03:01.000Z" });
    const { emitOperationChanged } = installAPI([stale]);
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
    const staleRow = await screen.findByRole("row", { name: /request-live/i });
    expect(within(staleRow).getByText("Submitted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh activity" })).not.toBeInTheDocument();

    act(() => {
      emitOperationChanged(current);
    });
    await waitFor(() => {
      const currentRow = screen.getByRole("row", { name: /request-live/i });
      expect(within(currentRow).getByText("Completed")).toBeInTheDocument();
      expect(within(currentRow).queryByText("Submitted")).not.toBeInTheDocument();
    });
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
