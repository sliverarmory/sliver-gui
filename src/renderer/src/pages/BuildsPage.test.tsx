import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toast, toast } from "@heroui/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { OperationResult, SavedArtifact, SliverDesktopAPI } from "../../../shared/contracts";
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
  toast.clear();
  Reflect.deleteProperty(window, "sliver");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function profileGenerationSnapshot() {
  const snapshot = disconnectedSnapshot();
  const profile = {
    id: "profile-1",
    name: "test-profile-1",
    target: "windows/amd64",
    format: "executable" as const,
    implantType: "session" as const,
    c2: ["mtls://127.0.0.1:8888"],
  };
  snapshot.connection = { status: "connected" };
  snapshot.profiles = [profile];
  snapshot.domains.profiles = {
    status: "ready",
    revision: 1,
    updatedAt: "2026-08-29T13:00:00.000Z",
    items: [profile],
    page: { limit: 500, total: 1, truncated: false },
  };
  return snapshot;
}

describe("BuildsPage", () => {
  it("keeps section titles and subtitles in the icon row", () => {
    render(<BuildsPage snapshot={disconnectedSnapshot()} />);

    for (const [title, subtitle] of [
      ["Archived builds", "HTTP staging changes are unavailable until the complete build inventory is loaded."],
      ["Generation profiles", "Reusable configurations stored on the connected server."],
    ] as const) {
      const header = screen.getByText(title).closest<HTMLElement>(".card__header");
      expect(header).not.toBeNull();
      if (!header) throw new Error(`${title} is not inside a card header`);
      expect(header).toHaveClass("flex-row", "items-center", "gap-3");
      expect(within(header).getByText(subtitle)).toBeInTheDocument();
      expect(header.querySelector(".section-icon")).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("shows a spinner toast until profile generation succeeds", async () => {
    const user = userEvent.setup();
    const generation = deferred<OperationResult<SavedArtifact>>();
    const generateFromProfile = vi.fn().mockReturnValue(generation.promise);
    Object.defineProperty(window, "sliver", {
      configurable: true,
      value: { generateFromProfile } as Pick<SliverDesktopAPI, "generateFromProfile"> as SliverDesktopAPI,
    });

    render(
      <>
        <BuildsPage snapshot={profileGenerationSnapshot()} />
        <Toast.Provider maxVisibleToasts={4} placement="bottom" />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Generate from profile" }));

    expect(generateFromProfile).toHaveBeenCalledWith({ profileName: "test-profile-1", name: "" });
    expect(await screen.findByText("Generating implant")).toBeInTheDocument();
    expect(screen.getByText("Building from test-profile-1. This can take several minutes.")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();

    generation.resolve({
      ok: true,
      value: { fileName: "implant.exe", size: 123, implantName: "implant", buildId: "build-1", saved: true },
    });

    expect(await screen.findByText("Artifact generated")).toBeInTheDocument();
    expect(screen.getByText("implant.exe")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Generating implant")).not.toBeInTheDocument());
  });

  it("replaces the profile generation spinner with the server failure", async () => {
    const user = userEvent.setup();
    const generation = deferred<OperationResult<SavedArtifact>>();
    Object.defineProperty(window, "sliver", {
      configurable: true,
      value: {
        generateFromProfile: vi.fn().mockReturnValue(generation.promise),
      } as Pick<SliverDesktopAPI, "generateFromProfile"> as SliverDesktopAPI,
    });

    render(
      <>
        <BuildsPage snapshot={profileGenerationSnapshot()} />
        <Toast.Provider maxVisibleToasts={4} placement="bottom" />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Generate from profile" }));
    expect(await screen.findByText("Generating implant")).toBeInTheDocument();

    generation.resolve({ ok: false, error: "compiler unavailable" });

    expect(await screen.findByText("Profile generation failed")).toBeInTheDocument();
    expect(screen.getByText("compiler unavailable")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Generating implant")).not.toBeInTheDocument());
  });

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
