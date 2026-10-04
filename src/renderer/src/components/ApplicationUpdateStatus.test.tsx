import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Toast, toast } from "@heroui/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApplicationUpdateState } from "../../../shared/application-update-contracts";
import type { SliverDesktopAPI } from "../../../shared/contracts";
import { ApplicationUpdateStatus } from "./ApplicationUpdateStatus";

let updateListener: ((state: ApplicationUpdateState) => void) | undefined;
const unsubscribe = vi.fn();

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
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

beforeEach(() => {
  updateListener = undefined;
  unsubscribe.mockReset();
  toast.clear();
});

afterEach(() => {
  cleanup();
  toast.clear();
});

describe("application update status", () => {
  it("subscribes before reading state and ignores an older get result", async () => {
    const initial = deferred<ApplicationUpdateState>();
    const calls: string[] = [];
    installUpdateAPI({
      getApplicationUpdateState: vi.fn(() => {
        calls.push("get");
        return initial.promise;
      }),
      onApplicationUpdateChanged: vi.fn((listener) => {
        calls.push("subscribe");
        updateListener = listener;
        return unsubscribe;
      }),
    });

    renderUpdateStatus(true);
    expect(calls).toEqual(["subscribe", "get"]);

    emit({
      status: "ready",
      revision: 4,
      currentVersion: "0.1.0",
      availableVersion: "0.3.0",
    });
    expect(await screen.findByText("Update 0.3.0 ready")).toBeInTheDocument();

    initial.resolve({
      status: "downloading",
      revision: 3,
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progressPercent: 90,
    });
    await act(async () => initial.promise);
    expect(screen.getByText("Update 0.3.0 ready")).toBeInTheDocument();
    expect(screen.queryByText("Downloading 0.2.0")).not.toBeInTheDocument();
  });

  it("shows bounded progress and applies a newer event", async () => {
    installUpdateAPI({
      getApplicationUpdateState: vi.fn().mockResolvedValue({
        status: "downloading",
        revision: 2,
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        progressPercent: 24.6,
      }),
    });

    renderUpdateStatus();
    expect(await screen.findByText("Downloading 0.2.0")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Downloading application update 0.2.0" }))
      .toHaveAttribute("aria-valuenow", "24.6");
    const progressToast = screen.getByText("Downloading 0.2.0").closest('[data-slot="toast"]');
    expect(progressToast).toBeInTheDocument();

    emit({
      status: "downloading",
      revision: 3,
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progressPercent: 53.4,
    });
    expect(await screen.findByText("53%")).toBeInTheDocument();
    expect(screen.getByText("Downloading 0.2.0").closest('[data-slot="toast"]')).toBe(progressToast);

    emit({
      status: "ready",
      revision: 4,
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
    });
    expect(await screen.findByText("Update 0.2.0 ready")).toBeInTheDocument();
  });

  it("checks with zero arguments and accepts the returned revision", async () => {
    const checkForApplicationUpdates = vi.fn().mockResolvedValue({
      ok: true,
      value: { status: "up-to-date", revision: 2, currentVersion: "0.1.0" },
    });
    installUpdateAPI({
      getApplicationUpdateState: vi.fn().mockResolvedValue({
        status: "idle",
        revision: 1,
        currentVersion: "0.1.0",
      }),
      checkForApplicationUpdates,
    });
    const user = userEvent.setup();

    renderUpdateStatus(true);
    await user.click(await screen.findByRole("button", { name: "Check for updates" }));

    expect(checkForApplicationUpdates).toHaveBeenCalledExactlyOnceWith();
    expect(await screen.findByRole("button", { name: "Up to date · 0.1.0" })).toBeInTheDocument();
  });

  it("keeps unavailable updates silent until an explicit check and lets the user dismiss the toast", async () => {
    const disabledState: ApplicationUpdateState = {
      status: "disabled",
      revision: 0,
      currentVersion: "0.1.0",
      disabledReason: "Automatic updates are available in packaged builds.",
    };
    const api = installUpdateAPI({
      getApplicationUpdateState: vi.fn().mockResolvedValue(disabledState),
    });
    const user = userEvent.setup();

    renderUpdateStatus();
    await waitFor(() => expect(api.getApplicationUpdateState).toHaveBeenCalledOnce());
    expect(screen.queryByText("Updates unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Application update")).not.toBeInTheDocument();

    emit(disabledState);
    expect(await screen.findByText("Updates unavailable")).toBeInTheDocument();
    expect(screen.getByText(disabledState.disabledReason)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByText("Updates unavailable")).not.toBeInTheDocument();
    });
  });

  it("requires confirmation, offers Later and Escape, and restarts with zero arguments", async () => {
    const restartToApplyApplicationUpdate = vi.fn().mockResolvedValue({ ok: true });
    installUpdateAPI({
      getApplicationUpdateState: vi.fn().mockResolvedValue({
        status: "ready",
        revision: 3,
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
      }),
      restartToApplyApplicationUpdate,
    });
    const user = userEvent.setup();

    renderUpdateStatus();
    await user.click(await screen.findByRole("button", { name: "Restart" }));
    expect(screen.getByRole("alertdialog", { name: "Restart to apply the update?" })).toBeInTheDocument();
    expect(screen.getByText(/closes every Sliver Desktop window and all managed shells/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Later" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog", { name: "Restart to apply the update?" })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Restart" }));
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog", { name: "Restart to apply the update?" })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Restart" }));
    await user.click(screen.getByRole("button", { name: "Restart and update" }));
    expect(restartToApplyApplicationUpdate).toHaveBeenCalledExactlyOnceWith();
  });

  it("keeps passive update controls out of dedicated surfaces and unsubscribes", async () => {
    installUpdateAPI();
    const view = renderUpdateStatus();
    await waitFor(() => expect(updateListener).toBeDefined());
    expect(screen.queryByText("Application update")).not.toBeInTheDocument();

    emit({ status: "checking", revision: 2, currentVersion: "0.1.0" });
    expect(await screen.findByText("Checking for updates…")).toBeInTheDocument();

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("lets the user dismiss the check toast and keeps download progress dismissed", async () => {
    installUpdateAPI();
    const user = userEvent.setup();
    renderUpdateStatus(true);

    const checkButton = await screen.findByRole("button", { name: "Check for updates" });
    expect(checkButton.closest('[data-slot="toast"]')).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument());

    emit({ status: "checking", revision: 2, currentVersion: "0.1.0" });
    expect(await screen.findByText("Checking for updates…")).toBeInTheDocument();
    emit({
      status: "downloading",
      revision: 3,
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progressPercent: 24.6,
    });
    expect(await screen.findByText("25%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText("Downloading 0.2.0")).not.toBeInTheDocument());

    emit({
      status: "downloading",
      revision: 4,
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progressPercent: 32,
    });
    expect(screen.queryByText("Downloading 0.2.0")).not.toBeInTheDocument();

    emit({ status: "ready", revision: 5, currentVersion: "0.1.0", availableVersion: "0.2.0" });
    expect(await screen.findByText("Update 0.2.0 ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();
  });
});

function renderUpdateStatus(showIdleControl = false) {
  return render(
    <>
      <ApplicationUpdateStatus showIdleControl={showIdleControl} />
      <Toast.Provider maxVisibleToasts={4} placement="bottom" />
    </>,
  );
}

function installUpdateAPI(overrides: Partial<SliverDesktopAPI> = {}): SliverDesktopAPI {
  const api = {
    getApplicationUpdateState: vi.fn().mockResolvedValue({
      status: "idle",
      revision: 1,
      currentVersion: "0.1.0",
    }),
    checkForApplicationUpdates: vi.fn().mockResolvedValue({ ok: false, error: "Unavailable" }),
    restartToApplyApplicationUpdate: vi.fn().mockResolvedValue({ ok: false, error: "Not ready" }),
    onApplicationUpdateChanged: vi.fn((listener: (state: ApplicationUpdateState) => void) => {
      updateListener = listener;
      return unsubscribe;
    }),
    ...overrides,
  } as Partial<SliverDesktopAPI> as SliverDesktopAPI;
  Object.defineProperty(window, "sliver", { configurable: true, value: api });
  return api;
}

function emit(state: ApplicationUpdateState): void {
  if (!updateListener) throw new Error("Application update listener was not installed");
  act(() => updateListener?.(state));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
