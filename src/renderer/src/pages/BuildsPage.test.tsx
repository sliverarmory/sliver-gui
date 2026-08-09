import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import { BuildsPage } from "./BuildsPage";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
});

describe("BuildsPage staging authority", () => {
  it("keeps replace-all staging controls read-only for a truncated build inventory", () => {
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { status: "connected" };
    snapshot.builds = [
      {
        name: "visible-build",
        configId: "visible-id",
        target: "linux/amd64",
        format: "executable",
        implantType: "session",
        c2: ["mtls://127.0.0.1:8888"],
        staged: true,
      },
    ];
    snapshot.domains.builds = {
      status: "ready",
      revision: 2,
      updatedAt: "2026-08-09T12:00:00.000Z",
      items: snapshot.builds,
      page: { limit: 500, total: 501, truncated: true, nextCursor: "500" },
    };

    render(<BuildsPage snapshot={snapshot} />);

    expect(screen.getByText("1 of 501 builds")).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 501 builds/i)).toBeInTheDocument();
    expect(screen.getByText(/replace-all update could remove unseen server builds/i)).toBeInTheDocument();
    expect(screen.getByText("Staged")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply staging set" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
