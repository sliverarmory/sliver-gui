import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./pages/SessionTerminalPanel", () => ({
  SessionTerminalPanel: (props: {
    preferredResourceId?: string;
    presentation: string;
    route: { sessionId: string; targetFingerprint: string };
    session: { name: string };
  }) => (
    <section
      aria-label="Dedicated terminal panel"
      data-preferred-resource={props.preferredResourceId}
      data-presentation={props.presentation}
      data-session-id={props.route.sessionId}
      data-target-fingerprint={props.route.targetFingerprint}
    >
      {props.session.name}
    </section>
  ),
}));

import { disconnectedSnapshot } from "../../shared/contracts";
import type { SliverDesktopAPI, SliverSnapshot } from "../../shared/contracts";
import type { SessionSummary, TargetRef } from "../../shared/target-contracts";
import {
  SessionShellWindowApp,
  resetSessionShellWindowClaimForTest,
} from "./SessionShellWindowApp";

const session: SessionSummary = {
  mode: "session",
  id: "session-popout",
  name: "Popout session",
  hostname: "host-popout",
  hostId: "host-id",
  username: "operator",
  os: "darwin",
  arch: "arm64",
  transport: "mtls",
  remoteAddress: "127.0.0.1:4444",
  activeC2: "mtls://127.0.0.1:4444",
  executable: "/tmp/implant",
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
  resetSessionShellWindowClaimForTest();
});

afterEach(() => {
  cleanup();
});

describe("SessionShellWindowApp", () => {
  it("claims once under StrictMode and renders only the exact dedicated session surface", async () => {
    const snapshot = connectedSnapshot();
    const claimSessionShellWindow = vi.fn().mockResolvedValue({
      ok: true,
      value: { kind: "session-shell", snapshot, preferredResourceId: "R".repeat(43) },
    });
    installAPI({ claimSessionShellWindow });

    render(
      <StrictMode>
        <SessionShellWindowApp />
      </StrictMode>,
    );

    const panel = await screen.findByRole("region", { name: "Dedicated terminal panel" });
    expect(panel).toHaveAttribute("data-presentation", "dedicated");
    expect(panel).toHaveAttribute("data-preferred-resource", "R".repeat(43));
    expect(panel).toHaveAttribute("data-session-id", session.id);
    expect(panel).toHaveAttribute("data-target-fingerprint", target.fingerprint);
    expect(claimSessionShellWindow).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Connect to Sliver")).not.toBeInTheDocument();
  });

  it("quarantines the dedicated surface when the exact target disappears", async () => {
    const snapshot = connectedSnapshot();
    let snapshotListener: ((next: SliverSnapshot) => void) | undefined;
    installAPI({
      claimSessionShellWindow: vi.fn().mockResolvedValue({
        ok: true,
        value: { kind: "session-shell", snapshot },
      }),
      onSnapshotChanged: vi.fn((listener: (next: SliverSnapshot) => void) => {
        snapshotListener = listener;
        return vi.fn();
      }),
    });

    render(<SessionShellWindowApp />);
    await screen.findByRole("region", { name: "Dedicated terminal panel" });

    snapshotListener?.(disconnectedSnapshot());

    await waitFor(() => expect(screen.getByText("Session no longer available")).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "Dedicated terminal panel" })).not.toBeInTheDocument();
  });

  it("fails closed when a generic window attempts to claim the dedicated surface", async () => {
    installAPI({
      claimSessionShellWindow: vi.fn().mockResolvedValue({
        ok: false,
        error: "This window is not authorized to host managed shells",
      }),
    });

    render(<SessionShellWindowApp />);

    expect(await screen.findByText("Managed shells unavailable")).toBeInTheDocument();
    expect(screen.getByText("This window is not authorized to host managed shells")).toBeInTheDocument();
  });
});

function connectedSnapshot(): SliverSnapshot {
  const snapshot = disconnectedSnapshot();
  snapshot.connection = {
    status: "connected",
    server: "127.0.0.1:53137",
    operator: "operator",
    configName: "Local",
    epoch: 7,
    incarnation: 4,
  };
  snapshot.sessions = [session];
  snapshot.domains.sessions = {
    status: "ready",
    revision: 2,
    items: [session],
    page: { limit: 100, total: 1, truncated: false },
  };
  snapshot.targetContext = {
    status: "selected",
    activeTarget: target,
    activeTargetSummary: session,
    selectableTargets: [target],
    capabilities: [],
    beaconWatch: false,
  };
  return snapshot;
}

function installAPI(overrides: Partial<SliverDesktopAPI>): void {
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: {
      claimSessionShellWindow: vi.fn(),
      onSnapshotChanged: vi.fn(() => vi.fn()),
      ...overrides,
    } as unknown as SliverDesktopAPI,
  });
}
