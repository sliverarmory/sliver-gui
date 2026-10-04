import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toast, toast } from "@heroui/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type {
  BuildSummary,
  OperationResult,
  ProfileSummary,
  SavedArtifact,
  SliverDesktopAPI,
  SliverSnapshot,
} from "../../../shared/contracts";
import { BuildsPage } from "./BuildsPage";

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
  snapshot.connection = { managedServer: null, status: "connected" };
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

function inventorySnapshot(buildCount: number, profileCount: number): SliverSnapshot {
  const snapshot = disconnectedSnapshot();
  const builds: BuildSummary[] = Array.from({ length: buildCount }, (_, index) => ({
    name: `build-${String(index + 1).padStart(2, "0")}`,
    configId: `build-config-${index + 1}`,
    target: index % 2 === 0 ? "windows/amd64" : "linux/amd64",
    format: "executable",
    implantType: "session",
    c2: ["mtls://127.0.0.1:8888"],
    staged: false,
  }));
  const profiles: ProfileSummary[] = Array.from({ length: profileCount }, (_, index) => ({
    id: `profile-id-${index + 1}`,
    name: `profile-${String(index + 1).padStart(2, "0")}`,
    target: index % 2 === 0 ? "windows/amd64" : "linux/amd64",
    format: "executable",
    implantType: "session",
    c2: ["mtls://127.0.0.1:8888"],
  }));

  snapshot.connection = { managedServer: null, status: "connected" };
  snapshot.builds = builds;
  snapshot.profiles = profiles;
  snapshot.domains.builds = {
    status: builds.length === 0 ? "empty" : "ready",
    revision: 1,
    updatedAt: "2026-08-31T12:00:00.000Z",
    items: builds,
    page: { limit: 500, total: builds.length, truncated: false },
  };
  snapshot.domains.profiles = {
    status: profiles.length === 0 ? "empty" : "ready",
    revision: 1,
    updatedAt: "2026-08-31T12:00:00.000Z",
    items: profiles,
    page: { limit: 500, total: profiles.length, truncated: false },
  };
  return snapshot;
}

describe("BuildsPage", () => {
  it("switches between the builds and profiles tables", async () => {
    const user = userEvent.setup();
    render(<BuildsPage snapshot={disconnectedSnapshot()} />);

    expect(screen.getByRole("tab", { name: "Builds" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Profiles" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("grid", { name: "Archived Sliver builds" })).toBeInTheDocument();
    expect(screen.queryByRole("grid", { name: "Sliver generation profiles" })).not.toBeInTheDocument();
    expectCardHeader(
      "Archived builds",
      "HTTP staging changes are unavailable until the complete build inventory is loaded.",
    );

    await user.click(screen.getByRole("tab", { name: "Profiles" }));

    expect(screen.getByRole("tab", { name: "Profiles" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("grid", { name: "Archived Sliver builds" })).not.toBeInTheDocument();
    expect(screen.getByRole("grid", { name: "Sliver generation profiles" })).toBeInTheDocument();
    expectCardHeader("Generation profiles", "Reusable configurations stored on the connected server.");
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

    await user.click(screen.getByRole("tab", { name: "Profiles" }));
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

    await user.click(screen.getByRole("tab", { name: "Profiles" }));
    await user.click(screen.getByRole("button", { name: "Generate from profile" }));
    expect(await screen.findByText("Generating implant")).toBeInTheDocument();

    generation.resolve({ ok: false, error: "compiler unavailable" });

    expect(await screen.findByText("Profile generation failed")).toBeInTheDocument();
    expect(screen.getByText("compiler unavailable")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Generating implant")).not.toBeInTheDocument());
  });

  it("paginates the eager build and profile inventories independently", async () => {
    const user = userEvent.setup();
    render(<BuildsPage snapshot={inventorySnapshot(12, 12)} />);

    expect(screen.getByText("build-01")).toBeInTheDocument();
    expect(screen.getByText("build-10")).toBeInTheDocument();
    expect(screen.queryByText("build-11")).not.toBeInTheDocument();
    expect(screen.getByText("1–10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous build page" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next build page" }));

    expect(screen.queryByText("build-01")).not.toBeInTheDocument();
    expect(screen.getByText("build-11")).toBeInTheDocument();
    expect(screen.getByText("build-12")).toBeInTheDocument();
    expect(screen.getByText("11–12")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next build page" })).toBeDisabled();

    await user.click(screen.getByRole("tab", { name: "Profiles" }));

    expect(screen.getByText("profile-01")).toBeInTheDocument();
    expect(screen.queryByText("profile-11")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next profile page" }));
    expect(screen.getByText("profile-11")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Builds" }));
    expect(screen.getByText("build-11")).toBeInTheDocument();
    expect(screen.queryByText("build-01")).not.toBeInTheDocument();
  });

  it("supports numbered page jumps and compact ellipsis windows", async () => {
    const user = userEvent.setup();
    render(<BuildsPage snapshot={inventorySnapshot(81, 0)} />);

    expect(screen.getByRole("button", { name: "builds page 1" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "builds page 8" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "builds page 5" }));

    expect(screen.getByText("build-41")).toBeInTheDocument();
    expect(screen.getByText("build-50")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "builds page 5" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "builds page 2" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "builds page 9" }));
    expect(screen.getByText("build-81")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "builds page 9" })).toHaveAttribute("aria-current", "page");
  });

  it("sorts the complete loaded inventory before selecting a page", async () => {
    const user = userEvent.setup();
    const snapshot = inventorySnapshot(11, 0);
    snapshot.builds = [...snapshot.builds.slice(1), snapshot.builds[0]!];
    snapshot.domains.builds.items = snapshot.builds;

    render(<BuildsPage snapshot={snapshot} />);

    expect(screen.queryByText("build-01")).not.toBeInTheDocument();
    await user.click(screen.getByRole("columnheader", { name: "Build" }));
    expect(await screen.findByText("build-01")).toBeInTheDocument();
    expect(screen.queryByText("build-11")).not.toBeInTheDocument();
  });

  it("preserves staging selections across build pages", async () => {
    const user = userEvent.setup();
    const setStagedBuilds = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, "sliver", {
      configurable: true,
      value: { setStagedBuilds } as Pick<SliverDesktopAPI, "setStagedBuilds"> as SliverDesktopAPI,
    });

    render(<BuildsPage snapshot={inventorySnapshot(11, 0)} />);

    await user.click(within(screen.getByRole("row", { name: /build-01/ })).getByLabelText("Select row"));
    await user.click(screen.getByRole("button", { name: "Next build page" }));
    await user.click(within(screen.getByRole("row", { name: /build-11/ })).getByLabelText("Select row"));
    await user.click(screen.getByRole("button", { name: "Apply staging set" }));

    await waitFor(() => expect(setStagedBuilds).toHaveBeenCalledOnce());
    expect(new Set(setStagedBuilds.mock.calls[0]?.[0])).toEqual(new Set(["build-01", "build-11"]));
  });

  it("selects and clears the current build page with the header checkbox", async () => {
    const user = userEvent.setup();
    const setStagedBuilds = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, "sliver", {
      configurable: true,
      value: { setStagedBuilds } as Pick<SliverDesktopAPI, "setStagedBuilds"> as SliverDesktopAPI,
    });

    render(<BuildsPage snapshot={inventorySnapshot(11, 0)} />);

    await user.click(screen.getByLabelText("Select all"));
    await user.click(screen.getByRole("button", { name: "Apply staging set" }));

    await waitFor(() => expect(setStagedBuilds).toHaveBeenCalledOnce());
    expect(new Set(setStagedBuilds.mock.calls[0]?.[0])).toEqual(new Set(
      Array.from({ length: 10 }, (_, index) => `build-${String(index + 1).padStart(2, "0")}`),
    ));

    await user.click(screen.getByLabelText("Select all"));
    expect(screen.queryByRole("button", { name: "Apply staging set" })).not.toBeInTheDocument();
  });

  it("clamps a table page when the eager inventory shrinks", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<BuildsPage snapshot={inventorySnapshot(11, 0)} />);

    await user.click(screen.getByRole("button", { name: "Next build page" }));
    expect(screen.getByText("build-11")).toBeInTheDocument();

    rerender(<BuildsPage snapshot={inventorySnapshot(2, 0)} />);

    expect(screen.getByText("build-01")).toBeInTheDocument();
    expect(screen.getByText("build-02")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "builds table pages" })).not.toBeInTheDocument();
  });

  it("keeps replace-all staging controls read-only for a truncated build inventory", () => {
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { managedServer: null, status: "connected" };
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
    expect(screen.queryByLabelText("Select row")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Select all")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "builds table pages" })).not.toBeInTheDocument();
  });
});

function expectCardHeader(title: string, subtitle: string): void {
  const header = screen.getByText(title).closest<HTMLElement>(".card__header");
  expect(header).not.toBeNull();
  if (!header) throw new Error(`${title} is not inside a card header`);
  expect(header).toHaveClass("flex-row", "items-center", "gap-3");
  expect(within(header).getByText(subtitle)).toBeInTheDocument();
  expect(header.querySelector(".section-icon")).toHaveAttribute("aria-hidden", "true");
}
