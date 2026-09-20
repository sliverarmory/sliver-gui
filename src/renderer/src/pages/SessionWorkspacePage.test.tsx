import { useEffect } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { SliverDesktopAPI, SliverSnapshot } from "../../../shared/contracts";
import type { SessionSummary, TargetActionPlan, TargetRef } from "../../../shared/target-contracts";
import type { TargetOperationRecord } from "../../../shared/operation-contracts";
import {
  SessionWorkspacePage,
  type SessionWorkspaceRoute,
} from "./SessionWorkspacePage";

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

describe("SessionWorkspacePage", () => {
  it("keeps the embedded session summary and tabs together while reporting the stuck state", () => {
    installAPI();
    const view = render(
      <div className="app-content">
        <SessionWorkspacePage
          route={route}
          session={session}
          snapshot={workspaceSnapshot()}
          onSnapshot={vi.fn()}
        />
      </div>,
    );

    const marker = view.container.querySelector(".session-workspace__scroll-marker");
    const sticky = view.container.querySelector(".session-workspace__sticky");
    const viewport = view.container.querySelector(".app-content");
    expect(marker).toBeInstanceOf(HTMLDivElement);
    expect(sticky).toBeInstanceOf(HTMLDivElement);
    expect(viewport).toBeInstanceOf(HTMLDivElement);
    if (!marker || !sticky || !viewport) throw new Error("Session sticky test markup is incomplete");

    const summary = screen.getByRole("heading", { name: session.name }).closest("header");
    const tablist = screen.getByRole("tablist", { name: "Session interaction sections" });
    const panel = screen.getByRole("tabpanel");
    expect(sticky).toHaveAttribute("data-stuck", "false");
    expect(sticky).toContainElement(summary);
    expect(sticky).toContainElement(tablist);
    expect(sticky).not.toContainElement(panel);

    const observer = intersectionObserverRecords.find((candidate) => candidate.observed.includes(marker));
    expect(observer?.root).toBe(viewport);
    if (!observer) throw new Error("Session sticky marker was not observed");

    act(() => emitIntersection(observer, marker, -1));
    expect(sticky).toHaveAttribute("data-stuck", "true");

    act(() => emitIntersection(observer, marker, 1));
    expect(sticky).toHaveAttribute("data-stuck", "false");

    view.unmount();
    expect(observer.disconnected).toBe(true);
  });

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
    expect(actions).toHaveTextContent("");
    expect(actions.closest("header")).toContainElement(screen.getByRole("heading", { name: session.name }));
    await user.click(actions);
    const actionMenu = await screen.findByRole("menu", { name: "Session actions" });
    expect(within(actionMenu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Rename",
      "Close Session",
      "Kill Session",
    ]);
    await user.click(within(actionMenu).getByRole("menuitem", { name: "Rename" }));
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

    expect(screen.getByRole("heading", { name: "Ping" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ping" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "Rename" })).not.toBeInTheDocument();
  });

  it("adds, edits, and clears environment variables from the compact Environment flow", async () => {
    const user = userEvent.setup();
    installAPI();
    const submitTargetOperation = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: operation({ requestId: "environment-add", operationId: "target.env-set" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: operation({ requestId: "environment-edit", operationId: "target.env-set" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: operation({ requestId: "environment-clear", operationId: "target.env-unset" }),
      });
    let environmentLoads = 0;
    const runSessionWorkbench = vi.fn(async (input: Parameters<SliverDesktopAPI["runSessionWorkbench"]>[0]) => {
      if (input.operationId !== "session.environment.list") {
        throw new Error(`Unexpected operation ${input.operationId}`);
      }
      environmentLoads += 1;
      const proxyValue = environmentLoads === 2
        ? "http://127.0.0.1:8080"
        : environmentLoads === 3
          ? "http://127.0.0.1:9090"
          : undefined;
      const items = [
        { name: "PATH", value: "/usr/bin", sensitive: false, redacted: false },
        ...(proxyValue
          ? [{ name: "HTTP_PROXY", value: proxyValue, sensitive: false, redacted: false }]
          : []),
      ];
      return {
        ok: true as const,
        value: {
          status: "completed" as const,
          result: {
            operationId: "session.environment.list" as const,
            value: {
              items,
              page: { limit: 100, total: items.length, truncated: false },
            },
          },
        },
      };
    });
    Object.assign(window.sliver, { runSessionWorkbench, submitTargetOperation });

    render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={workspaceSnapshot()}
        onSnapshot={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Ping" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ping" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Environment" }));
    expect(await screen.findByRole("row", { name: /PATH/u })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Environment actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Variable name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Variable value" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New variable" }));
    const addDialog = await screen.findByRole("dialog", { name: "Add environment variable" });
    await user.type(within(addDialog).getByRole("textbox", { name: "Variable name" }), "HTTP_PROXY");
    await user.type(within(addDialog).getByRole("textbox", { name: "Variable value" }), "http://127.0.0.1:8080");
    await user.click(within(addDialog).getByRole("button", { name: "Add variable" }));
    await waitFor(() => expect(submitTargetOperation).toHaveBeenNthCalledWith(1, {
      operationId: "target.env-set",
      name: "HTTP_PROXY",
      value: "http://127.0.0.1:8080",
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add environment variable" })).not.toBeInTheDocument());

    let proxyRow = await screen.findByRole("row", { name: /HTTP_PROXY/u });
    expect(within(proxyRow).getByText("http://127.0.0.1:8080")).toBeInTheDocument();
    const environmentGrid = screen.getByRole("grid", { name: "Session environment variables" });
    const editProxy = within(proxyRow).getByRole("button", { name: "Edit HTTP_PROXY" });
    const clearProxy = within(proxyRow).getByRole("button", { name: "Clear HTTP_PROXY" });
    expect(environmentGrid.closest('[data-slot="data-grid"]')).toHaveClass("[--background:var(--surface)]");
    expect(editProxy).toHaveClass("button--icon-only");
    expect(editProxy).not.toHaveTextContent("Edit");
    expect(clearProxy).toHaveClass("button--icon-only");
    expect(clearProxy).not.toHaveTextContent("Clear");
    expect(editProxy.closest('[role="gridcell"]')).toHaveAttribute("data-pinned", "end");
    await user.click(editProxy);
    const editDialog = await screen.findByRole("dialog", { name: "Edit environment variable" });
    expect(within(editDialog).getByRole("textbox", { name: "Variable name" })).toHaveValue("HTTP_PROXY");
    const value = within(editDialog).getByRole("textbox", { name: "Variable value" });
    expect(value).toHaveValue("http://127.0.0.1:8080");
    await user.clear(value);
    await user.type(value, "http://127.0.0.1:9090");
    await user.click(within(editDialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(submitTargetOperation).toHaveBeenNthCalledWith(2, {
      operationId: "target.env-set",
      name: "HTTP_PROXY",
      value: "http://127.0.0.1:9090",
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit environment variable" })).not.toBeInTheDocument());

    proxyRow = await screen.findByRole("row", { name: /HTTP_PROXY/u });
    expect(within(proxyRow).getByText("http://127.0.0.1:9090")).toBeInTheDocument();
    await user.click(within(proxyRow).getByRole("button", { name: "Clear HTTP_PROXY" }));
    await waitFor(() => expect(submitTargetOperation).toHaveBeenNthCalledWith(3, {
      operationId: "target.env-unset",
      name: "HTTP_PROXY",
    }));
    expect(await screen.findByText("Loaded 1 of 1 environment variables")).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /HTTP_PROXY/u })).not.toBeInTheDocument();
    expect(runSessionWorkbench.mock.calls.filter(([input]) => input.operationId === "session.environment.list")).toHaveLength(4);

    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("row", { name: /environment-add/u })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /environment-edit/u })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /environment-clear/u })).toBeInTheDocument();
  });

  it.each([
    ["Kill Session", "target.kill", "Review kill target"],
    ["Close Session", "session.close", "Review close session"],
  ] as const)("opens the existing review before %s from the header menu", async (label, actionId, heading) => {
    const user = userEvent.setup();
    installAPI();
    const plan: TargetActionPlan = {
      token: "session-review-token",
      expiresAt: "2026-08-09T20:10:00.000Z",
      impact: {
        actionId,
        backend: {
          server: "127.0.0.1:53137",
          operator: "m2-verification",
          configName: "M2 test",
          epoch: 7,
          sharedWindowCount: 1,
        },
        targets: [session],
        totalTargets: 1,
        truncated: false,
        warning: "Review the selected session before continuing.",
      },
    };
    const prepareTargetAction = vi.fn().mockResolvedValue({ ok: true, value: plan });
    const executeTargetActionPlan = vi.fn();
    Object.assign(window.sliver, { prepareTargetAction, executeTargetActionPlan });
    render(<SessionWorkspacePage route={route} session={session} snapshot={workspaceSnapshot()} onSnapshot={vi.fn()} />);

    expect(screen.queryByRole("heading", { name: "Session Controls" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(await screen.findByRole("menuitem", { name: label }));

    const review = await screen.findByRole("dialog", { name: heading });
    expect(prepareTargetAction).toHaveBeenCalledExactlyOnceWith({ actionId });
    expect(within(review).getByText(session.name)).toBeInTheDocument();
    expect(executeTargetActionPlan).not.toHaveBeenCalled();
    await user.click(within(review).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: heading })).not.toBeInTheDocument();
    expect(executeTargetActionPlan).not.toHaveBeenCalled();
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

  it("blocks environment mutations while an exact session selection is pending", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    const selection = deferred<Awaited<ReturnType<SliverDesktopAPI["selectTarget"]>>>();
    vi.mocked(api.selectTarget).mockReturnValue(selection.promise);
    const submitTargetOperation = vi.fn();
    const runSessionWorkbench = vi.fn(async (input: Parameters<SliverDesktopAPI["runSessionWorkbench"]>[0]) => ({
      ok: true as const,
      value: {
        status: "completed" as const,
        result: {
          operationId: input.operationId,
          value: {
            items: [{ name: "PATH", value: "/usr/bin", sensitive: false, redacted: false }],
            page: { limit: 100, total: 1, truncated: false },
          },
        },
      },
    }));
    Object.assign(window.sliver, { runSessionWorkbench, submitTargetOperation });

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

    await user.click(screen.getByRole("tab", { name: "Environment" }));
    const pathRow = await screen.findByRole("row", { name: /PATH/u });
    const newVariable = screen.getByRole("button", { name: "New variable" });
    await user.click(screen.getByRole("button", { name: "Sessions, switch session" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /analytics/i }));
    await waitFor(() => expect(api.selectTarget).toHaveBeenCalledExactlyOnceWith(otherSessionRef));

    const workspace = screen.getByRole("heading", { name: "payments" }).closest("section");
    expect(workspace).toHaveAttribute("inert");
    expect(newVariable).toBeDisabled();
    expect(within(pathRow).getByRole("button", { name: "Edit PATH" })).toBeDisabled();
    expect(within(pathRow).getByRole("button", { name: "Clear PATH" })).toBeDisabled();
    newVariable.click();
    within(pathRow).getByRole("button", { name: "Clear PATH" }).click();
    expect(screen.queryByRole("dialog", { name: "Add environment variable" })).not.toBeInTheDocument();
    expect(submitTargetOperation).not.toHaveBeenCalled();

    await act(async () => {
      selection.resolve({ ok: false, error: "Switch canceled" });
      await selection.promise;
    });
    await waitFor(() => expect(newVariable).toBeEnabled());
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

  it("fills each Activity page with up to one hundred matching session rows", async () => {
    const user = userEvent.setup();
    const firstSessionPage = Array.from({ length: 60 }, (_, index) => operation({
      requestId: `request-current-${String(index + 1).padStart(3, "0")}`,
    }));
    const unrelated = Array.from({ length: 40 }, (_, index) => operation({
      requestId: `request-other-${String(index + 1).padStart(3, "0")}`,
      target: otherSessionRef,
    }));
    const secondSessionPage = Array.from({ length: 40 }, (_, index) => operation({
      requestId: `request-current-${String(index + 61).padStart(3, "0")}`,
    }));
    const older = operation({ requestId: "request-older", updatedAt: "2026-08-09T19:59:59.000Z" });
    const { listTargetOperations } = installAPI();
    vi.mocked(listTargetOperations).mockImplementation(async (input) => {
      if (input.cursor === "activity-3") {
        return { ok: true, value: { items: [older], page: { limit: 100, total: 141, truncated: false } } };
      }
      if (input.cursor === "activity-2") {
        return {
          ok: true,
          value: {
            items: secondSessionPage,
            page: { limit: 100, total: 141, truncated: true, nextCursor: "activity-3" },
          },
        };
      }
      return {
        ok: true,
        value: {
          items: [...firstSessionPage, ...unrelated],
          page: { limit: 100, total: 141, truncated: true, nextCursor: "activity-2" },
        },
      };
    });

    render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={workspaceSnapshot()}
        onBack={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("100 matching operations loaded")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /request-current-100/i })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /request-other-001/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /request-older/i })).not.toBeInTheDocument();
    expect(listTargetOperations).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(listTargetOperations).toHaveBeenNthCalledWith(2, { limit: 100, cursor: "activity-2" });
    expect(listTargetOperations).toHaveBeenNthCalledWith(3, { limit: 100, cursor: "activity-3" });

    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(await screen.findByRole("row", { name: /request-older/i })).toBeInTheDocument();
    expect(screen.getByText("101 matching operations loaded")).toBeInTheDocument();
    expect(listTargetOperations).toHaveBeenCalledTimes(3);
  });

  it("hides Activity load-more when only unrelated global history remains", async () => {
    const user = userEvent.setup();
    const matching = Array.from({ length: 100 }, (_, index) => operation({
      requestId: `request-current-${String(index + 1).padStart(3, "0")}`,
    }));
    const unrelated = operation({ requestId: "request-unrelated-older", target: otherSessionRef });
    const { listTargetOperations } = installAPI();
    vi.mocked(listTargetOperations).mockImplementation(async (input) => ({
      ok: true,
      value: input.cursor === "activity-2"
        ? { items: [unrelated], page: { limit: 100, total: 101, truncated: false } }
        : {
            items: matching,
            page: { limit: 100, total: 101, truncated: true, nextCursor: "activity-2" },
          },
    }));

    render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={workspaceSnapshot()}
        onBack={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("100 matching operations loaded")).toBeInTheDocument();
    await waitFor(() => expect(listTargetOperations).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Load older activity" })).not.toBeInTheDocument();
  });

  it("keeps new live Activity rows inside the current one-hundred-row page", async () => {
    const user = userEvent.setup();
    const initial = Array.from({ length: 100 }, (_, index) => operation({
      requestId: `request-current-${String(index + 1).padStart(3, "0")}`,
    }));
    const { emitOperationChanged, listTargetOperations } = installAPI(initial);

    render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={workspaceSnapshot()}
        onBack={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("100 matching operations loaded")).toBeInTheDocument();
    act(() => emitOperationChanged(operation({
      requestId: "request-live-new",
      updatedAt: "2026-08-09T20:03:01.000Z",
    })));

    expect(await screen.findByRole("row", { name: /request-live-new/i })).toBeInTheDocument();
    expect(screen.getByText("100 matching operations loaded")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(await screen.findByText("101 matching operations loaded")).toBeInTheDocument();
    expect(listTargetOperations).toHaveBeenCalledTimes(1);
  });

  it("preserves a live Activity event that arrives while its first page is pending", async () => {
    const pending = deferred<Awaited<ReturnType<SliverDesktopAPI["listTargetOperations"]>>>();
    const historical = operation({ requestId: "request-historical" });
    const live = operation({
      requestId: "request-live-during-load",
      updatedAt: "2026-08-09T20:03:01.000Z",
    });
    const { emitOperationChanged, listTargetOperations } = installAPI();
    vi.mocked(listTargetOperations).mockReturnValue(pending.promise);

    render(
      <SessionWorkspacePage
        route={route}
        session={session}
        snapshot={workspaceSnapshot()}
        onBack={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );

    act(() => emitOperationChanged(live));
    await act(async () => pending.resolve({
      ok: true,
      value: { items: [historical], page: { limit: 100, total: 1, truncated: false } },
    }));

    await userEvent.setup().click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("row", { name: /request-live-during-load/i })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /request-historical/i })).toBeInTheDocument();
    expect(screen.getByText("2 matching operations loaded")).toBeInTheDocument();
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
