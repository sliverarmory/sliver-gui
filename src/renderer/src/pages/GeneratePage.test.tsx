import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { OperationResult, SavedArtifact, SliverDesktopAPI } from "../../../shared/contracts";
import { GeneratePage, parseNumberInput } from "./GeneratePage";

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
  Reflect.deleteProperty(window, "sliver");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function readyGenerationSnapshot() {
  const snapshot = disconnectedSnapshot();
  snapshot.connection = { status: "connected" };
  snapshot.domains.compiler = {
    status: "ready",
    revision: 1,
    updatedAt: "2026-08-09T12:00:00.000Z",
    items: [{ os: "linux", arch: "arm64", format: "executable", supported: true }],
    page: { limit: 500, total: 1, truncated: false },
  };
  snapshot.domains.profiles = {
    status: "empty",
    revision: 1,
    updatedAt: "2026-08-09T12:00:00.000Z",
    items: [],
    page: { limit: 500, total: 0, truncated: false },
  };
  return snapshot;
}

describe("GeneratePage action footer", () => {
  it("keeps the reusable profile form and build actions outside the scrolling form body", () => {
    render(<GeneratePage snapshot={disconnectedSnapshot()} />);

    const profileField = screen.getByRole("textbox", { name: "Reusable profile name" });
    const footer = profileField.closest("footer");

    expect(footer).not.toBeNull();
    if (!footer) throw new Error("Reusable profile field is not inside the Generate footer");

    expect(footer).toHaveClass("generate-page__footer");
    expect(footer).toHaveAccessibleName("Generate actions");
    expect(within(footer).getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "Save profile" })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "Generate and save" })).toBeInTheDocument();

    const scrollingContent = footer.previousElementSibling;
    expect(scrollingContent).toHaveClass("generate-page__content");
    expect(scrollingContent).not.toContainElement(footer);
  });

  it("does not fabricate compiler targets while the authoritative domain is idle", () => {
    render(<GeneratePage snapshot={disconnectedSnapshot()} />);

    expect(screen.getByText("Compiler targets are not loaded")).toBeInTheDocument();
    expect(screen.getByText("0 compiler targets")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Generate and save" })).toBeDisabled();
  });

  it("enables generation only for targets advertised by the connected server", () => {
    const snapshot = readyGenerationSnapshot();

    render(<GeneratePage snapshot={snapshot} />);

    expect(screen.getByText("1 compiler targets")).toBeInTheDocument();
    expect(screen.queryByText("Compiler targets are not loaded")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Generate and save" })).toBeEnabled();
    expect(screen.getByText(/without a scheme default to mTLS/i)).toBeInTheDocument();
  });

  it("shows build progress and disables the complete generation form while compiling", async () => {
    const user = userEvent.setup();
    const build = deferred<OperationResult<SavedArtifact>>();
    const generate = vi.fn().mockReturnValue(build.promise);
    Object.defineProperty(window, "sliver", {
      configurable: true,
      value: { generate } as Pick<SliverDesktopAPI, "generate"> as SliverDesktopAPI,
    });

    render(<GeneratePage snapshot={readyGenerationSnapshot()} />);

    const generateButton = screen.getByRole("button", { name: "Generate and save" });
    await user.click(generateButton);

    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generateButton).toHaveAttribute("data-pending");
    expect(within(generateButton).getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Implant generation configuration" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("textbox", { name: "Build name" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Operating system/i })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "Reconnect delay (seconds)" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Obfuscate symbols" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Reusable profile name" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();

    build.resolve({
      ok: true,
      value: { fileName: "implant", size: 0, implantName: "implant", buildId: "build-id", saved: false },
    });

    await waitFor(() => expect(generateButton).not.toHaveAttribute("data-pending"));
    expect(within(generateButton).queryByRole("status", { name: "Loading" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Build name" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled();
  });

  it("keeps profile saves disabled when the server inventory is truncated", () => {
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { status: "connected" };
    snapshot.domains.compiler = {
      status: "ready",
      revision: 1,
      updatedAt: "2026-08-09T12:00:00.000Z",
      items: [{ os: "linux", arch: "amd64", format: "executable", supported: true }],
      page: { limit: 500, total: 1, truncated: false },
    };
    snapshot.domains.profiles = {
      status: "ready",
      revision: 1,
      updatedAt: "2026-08-09T12:00:00.000Z",
      items: [],
      page: { limit: 500, total: 501, truncated: true, nextCursor: "500" },
    };

    render(<GeneratePage snapshot={snapshot} />);

    expect(screen.getByText(/Saving is unavailable while the profile inventory is incomplete or stale/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Generate and save" })).toBeEnabled();
  });
});

describe("GeneratePage numeric input parsing", () => {
  it("accepts finite numbers and rejects values that would poison typed form state", () => {
    expect(parseNumberInput("31337")).toBe(31_337);
    expect(parseNumberInput("1.5")).toBe(1.5);
    expect(parseNumberInput("not-a-number")).toBeUndefined();
    expect(parseNumberInput("Infinity")).toBeUndefined();
  });
});
