import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionWorkspacePanelContext } from "./pages/SessionWorkspacePage";
import { useConnection } from "./components/ConnectionProvider";

vi.mock("./pages/TargetExecutionWorkbench", () => ({
  TargetExecutionWorkbench: (props: {
    expectedTarget: TargetRef;
    onPopOut?: () => Promise<void>;
    presentation?: string;
    targetIdentity: string;
  }) => {
    const { managedServer } = useConnection();
    return (
      <section
        aria-label="Mock execution workbench"
        data-target-id={props.expectedTarget.id}
        data-target-fingerprint={props.expectedTarget.fingerprint}
        data-target-identity={props.targetIdentity}
        data-presentation={props.presentation}
        data-can-popout={Boolean(props.onPopOut)}
        data-managed-deployment={managedServer?.deploymentId}
      />
    );
  },
}));

vi.mock("./pages/session-workbench-panels", () => ({
  SessionFilesPanel: (props: SessionWorkspacePanelContext) => (
    <section
      aria-label="Mock file browser"
      data-session-id={props.session.id}
      data-route-incarnation={props.route.connectionIncarnation}
      data-can-popout={Boolean(props.onPopOutPanel)}
    />
  ),
  SessionRegistryPanel: (props: SessionWorkspacePanelContext) => (
    <section
      aria-label="Mock registry editor"
      data-session-id={props.session.id}
      data-can-popout={Boolean(props.onPopOutPanel)}
    />
  ),
}));

import { disconnectedSnapshot } from "../../shared/contracts";
import type { OperationResult, SliverDesktopAPI, SliverSnapshot, WindowLaunchContext } from "../../shared/contracts";
import type { SessionSummary, TargetRef } from "../../shared/target-contracts";
import {
  SessionPanelWindowApp,
  resetSessionPanelWindowClaimForTest,
} from "./SessionPanelWindowApp";

const session: SessionSummary = {
  mode: "session",
  id: "session-panel-1",
  name: "Panel session",
  hostname: "host-panel",
  hostId: "host-id",
  username: "operator",
  os: "windows",
  arch: "amd64",
  transport: "mtls",
  remoteAddress: "127.0.0.1:4444",
  activeC2: "mtls://127.0.0.1:4444",
  executable: "C:\\implant.exe",
  version: "1.0.0",
  locale: "en-US",
  integrity: "High",
  burned: false,
  pid: 4200,
  liveness: "active",
};

const target: TargetRef = {
  mode: "session",
  id: session.id,
  backendEpoch: 7,
  domainRevision: 2,
  fingerprint: "a".repeat(64),
};

beforeEach(() => {
  resetSessionPanelWindowClaimForTest();
});

afterEach(() => {
  cleanup();
});

describe("SessionPanelWindowApp", () => {
  it("claims once under StrictMode and renders a standalone Execution workbench without a recursive pop-out", async () => {
    const snapshot = connectedSnapshot();
    snapshot.connection.managedServer = { deploymentId: "deployment-1", provider: "aws", name: "Managed lab" };
    const api = installAPI(Promise.resolve({ ok: true, value: panelContext("execution", snapshot) }));

    render(<StrictMode><SessionPanelWindowApp /></StrictMode>);

    const workbench = await screen.findByRole("region", { name: "Mock execution workbench" });
    expect(workbench).toHaveAttribute("data-target-id", target.id);
    expect(workbench).toHaveAttribute("data-target-fingerprint", target.fingerprint);
    expect(workbench).toHaveAttribute("data-target-identity", `7:4:session:${session.id}:${target.fingerprint}`);
    expect(workbench).toHaveAttribute("data-presentation", "dedicated");
    expect(workbench).toHaveAttribute("data-can-popout", "false");
    expect(workbench).toHaveAttribute("data-managed-deployment", "deployment-1");
    expect(api.claimSessionPanelWindow).toHaveBeenCalledOnce();
    expect(document.title).toBe("Execution — Panel session");
  });

  it.each([
    ["files", "Mock file browser"],
    ["registry", "Mock registry editor"],
  ] as const)("renders %s with exact session context and no recursive pop-out", async (panel, label) => {
    const snapshot = connectedSnapshot();
    installAPI(Promise.resolve({ ok: true, value: panelContext(panel, snapshot) }));

    render(<SessionPanelWindowApp />);

    const editor = await screen.findByRole("region", { name: label });
    expect(editor).toHaveAttribute("data-session-id", session.id);
    expect(editor).toHaveAttribute("data-can-popout", "false");
    if (panel === "files") expect(editor).toHaveAttribute("data-route-incarnation", "4");
    expect(screen.queryByRole("region", { name: "Mock execution workbench" })).not.toBeInTheDocument();
  });

  it("keeps a newer snapshot event when the launch claim resolves late", async () => {
    const stale = connectedSnapshot();
    stale.connection.managedServer = { deploymentId: "removed", provider: "aws", name: "Removed lab" };
    const claim = deferred<OperationResult<WindowLaunchContext>>();
    const api = installAPI(claim.promise);
    render(<SessionPanelWindowApp />);

    act(() => api.emit(connectedSnapshot()));
    await act(async () => claim.resolve({ ok: true, value: panelContext("execution", stale) }));

    expect(await screen.findByRole("region", { name: "Mock execution workbench" }))
      .not.toHaveAttribute("data-managed-deployment");
  });

  it("quarantines the editor when the exact target or connection incarnation changes", async () => {
    const snapshot = connectedSnapshot();
    const api = installAPI(Promise.resolve({ ok: true, value: panelContext("files", snapshot) }));
    render(<SessionPanelWindowApp />);
    await screen.findByRole("region", { name: "Mock file browser" });

    const changedTarget = connectedSnapshot();
    changedTarget.targetContext.activeTarget = { ...target, fingerprint: "b".repeat(64) };
    act(() => api.emit(changedTarget));
    await waitFor(() => expect(screen.getByText("Session no longer available")).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "Mock file browser" })).not.toBeInTheDocument();

    const changedConnection = connectedSnapshot();
    changedConnection.connection.incarnation = 5;
    act(() => api.emit(changedConnection));
    expect(screen.queryByRole("region", { name: "Mock file browser" })).not.toBeInTheDocument();
  });

  it("rejects Registry on a non-Windows session and rejects a mismatched launch target", async () => {
    const linux = connectedSnapshot({ ...session, os: "linux" });
    installAPI(Promise.resolve({ ok: true, value: panelContext("registry", linux) }));
    const { unmount } = render(<SessionPanelWindowApp />);
    expect(await screen.findByText("The dedicated panel context did not match its main-owned session")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Mock registry editor" })).not.toBeInTheDocument();
    unmount();

    resetSessionPanelWindowClaimForTest();
    const mismatched = connectedSnapshot();
    installAPI(Promise.resolve({
      ok: true,
      value: { ...panelContext("execution", mismatched), target: { ...target, domainRevision: 99 } },
    }));
    render(<SessionPanelWindowApp />);
    expect(await screen.findByText("The dedicated panel context did not match its main-owned session")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Mock execution workbench" })).not.toBeInTheDocument();
  });

  it("fails closed when the window is not authorized to claim a session panel", async () => {
    installAPI(Promise.resolve({ ok: false, error: "Session panel claim denied" }));
    render(<SessionPanelWindowApp />);

    expect(await screen.findByText("Session panel claim denied")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Mock file browser" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Mock registry editor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Mock execution workbench" })).not.toBeInTheDocument();
  });
});

function connectedSnapshot(summary: SessionSummary = session): SliverSnapshot {
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
  snapshot.sessions = [summary];
  snapshot.domains.sessions = {
    status: "ready",
    revision: 2,
    items: [summary],
    page: { limit: 100, total: 1, truncated: false },
  };
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

function panelContext(panel: "execution" | "files" | "registry", snapshot: SliverSnapshot): Extract<WindowLaunchContext, { kind: "session-panel" }> {
  return { kind: "session-panel", panel, snapshot, target };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function installAPI(claim: Promise<OperationResult<WindowLaunchContext>>): {
  emit: (snapshot: SliverSnapshot) => void;
  claimSessionPanelWindow: ReturnType<typeof vi.fn>;
} {
  let listener: ((snapshot: SliverSnapshot) => void) | undefined;
  const claimSessionPanelWindow = vi.fn(() => claim);
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: {
      claimSessionPanelWindow,
      onSnapshotChanged: vi.fn((next: (snapshot: SliverSnapshot) => void) => {
        listener = next;
        return vi.fn();
      }),
    } as unknown as SliverDesktopAPI,
  });
  return {
    emit(snapshot) {
      if (!listener) throw new Error("Expected snapshot subscription before emission");
      listener(snapshot);
    },
    claimSessionPanelWindow,
  };
}
