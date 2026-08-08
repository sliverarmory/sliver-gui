import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../shared/contracts";
import type { OperationResult, SavedConfigSummary, SliverDesktopAPI } from "../../shared/contracts";
import { App, WindowMenu } from "./App";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function installSliverAPI(
  listSavedConfigs: SliverDesktopAPI["listSavedConfigs"],
): SliverDesktopAPI {
  const api = {
    getSnapshot: vi.fn().mockResolvedValue(disconnectedSnapshot()),
    listSavedConfigs,
    onSnapshotChanged: vi.fn().mockReturnValue(vi.fn()),
    openWindow: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as SliverDesktopAPI;

  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("App startup", () => {
  it("opens the saved configuration selector immediately and keeps a dismissal closed", async () => {
    const user = userEvent.setup();
    const initialCatalog = deferred<OperationResult<SavedConfigSummary[]>>();
    const listSavedConfigs = vi.fn()
      .mockReturnValueOnce(initialCatalog.promise)
      .mockResolvedValue({ ok: true, value: [] });
    installSliverAPI(listSavedConfigs);

    render(<App />);

    expect(screen.getByRole("dialog", { name: "Connect to Sliver" })).toBeInTheDocument();
    expect(screen.getByText("Finding configurations")).toBeInTheDocument();

    initialCatalog.resolve({ ok: true, value: [] });
    await screen.findByText("No saved configurations");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Connect to Sliver" })).not.toBeInTheDocument();
    });

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(listSavedConfigs).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: "Connect to Sliver" })).not.toBeInTheDocument();
  });
});

describe("WindowMenu", () => {
  it("offers only a different-server window while disconnected", async () => {
    const user = userEvent.setup();
    const onOpenWindow = vi.fn().mockResolvedValue(undefined);
    render(<WindowMenu connected={false} onOpenWindow={onOpenWindow} />);

    await user.click(screen.getByRole("button", { name: "New window options" }));

    expect(screen.queryByRole("menuitem", { name: "Same server" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Different server" }));
    expect(onOpenWindow).toHaveBeenCalledWith(false);
  });

  it("offers same-server and different-server windows while connected", async () => {
    const user = userEvent.setup();
    const onOpenWindow = vi.fn().mockResolvedValue(undefined);
    render(<WindowMenu connected onOpenWindow={onOpenWindow} />);

    await user.click(screen.getByRole("button", { name: "New window options" }));
    expect(screen.getByRole("menuitem", { name: "Different server" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Same server" }));
    expect(onOpenWindow).toHaveBeenCalledWith(true);
  });
});
