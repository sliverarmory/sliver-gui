import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Toast, toast } from "@heroui/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SliverReleaseDownloadEvent } from "../../../shared/release-contracts";
import type { SliverDesktopAPI } from "../../../shared/contracts";
import { ReleaseDownloadToasts, formatBytes } from "./ReleaseDownloadToasts";

const downloadId = "8e577480-5dc2-4dde-aa58-23c8f1770627";
let releaseListener: ((event: SliverReleaseDownloadEvent) => void) | undefined;
const unsubscribe = vi.fn();

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  releaseListener = undefined;
  unsubscribe.mockReset();
  toast.clear();
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: {
      onReleaseDownloadChanged: vi.fn((listener: (event: SliverReleaseDownloadEvent) => void) => {
        releaseListener = listener;
        return unsubscribe;
      }),
    } as Pick<SliverDesktopAPI, "onReleaseDownloadChanged"> as SliverDesktopAPI,
  });
});

afterEach(() => {
  cleanup();
  toast.clear();
});

describe("release download toasts", () => {
  it("shows indeterminate startup, determinate progress, and a completion toast", async () => {
    render(
      <>
        <ReleaseDownloadToasts />
        <Toast.Provider maxVisibleToasts={4} placement="bottom" />
      </>,
    );
    emit({
      status: "started",
      downloadId,
      artifact: "server",
      os: "linux",
      arch: "amd64",
    });

    expect(await screen.findByText("Sliver server")).toBeInTheDocument();
    expect(screen.getByText("Linux / amd64")).toBeInTheDocument();
    expect(screen.getByText("Starting")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Downloading Sliver server/ })).not.toHaveAttribute("aria-valuenow");
    const progressToastId = toast.getQueue().visibleToasts[0]?.key;

    emit({
      status: "progress",
      downloadId,
      artifact: "server",
      os: "linux",
      arch: "amd64",
      version: "v1.7.3",
      fileName: "sliver-server_linux-amd64",
      receivedBytes: 25 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
    });
    expect(await screen.findByText("25%")).toBeInTheDocument();
    expect(screen.getByText("25.0 MB / 100.0 MB")).toBeInTheDocument();
    expect(screen.getByText("Linux / amd64 · v1.7.3")).toBeInTheDocument();
    expect(screen.getByText("sliver-server_linux-amd64")).toBeInTheDocument();
    expect(screen.queryByText("Starting")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Downloading Sliver server/ })).toHaveAttribute("aria-valuenow", "25");
    expect(toast.getQueue().visibleToasts.map(({ key }) => key)).toEqual([progressToastId]);

    emit({
      status: "progress",
      downloadId,
      artifact: "server",
      os: "linux",
      arch: "amd64",
      version: "v1.7.3",
      fileName: "sliver-server_linux-amd64",
      receivedBytes: 75 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
    });
    expect(await screen.findByText("75%")).toBeInTheDocument();
    expect(screen.getByText("75.0 MB / 100.0 MB")).toBeInTheDocument();
    expect(screen.queryByText("25%")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Downloading Sliver server/ })).toHaveAttribute("aria-valuenow", "75");
    expect(toast.getQueue().visibleToasts.map(({ key }) => key)).toEqual([progressToastId]);

    emit({
      status: "completed",
      downloadId,
      artifact: "server",
      os: "linux",
      arch: "amd64",
      version: "v1.7.3",
      fileName: "sliver-server_linux-amd64",
      receivedBytes: 100 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
    });
    expect(await screen.findByText("Download complete")).toBeInTheDocument();
    expect(screen.getByText("sliver-server_linux-amd64 was saved to Downloads.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());
  });

  it("replaces the progress toast with a bounded failure message", async () => {
    render(
      <>
        <ReleaseDownloadToasts />
        <Toast.Provider maxVisibleToasts={4} placement="bottom" />
      </>,
    );
    emit({
      status: "started",
      downloadId,
      artifact: "client",
      os: "windows",
      arch: "arm64",
    });
    expect(await screen.findByText("Sliver console client")).toBeInTheDocument();
    expect(screen.getByText("Windows / arm64")).toBeInTheDocument();

    emit({
      status: "failed",
      downloadId,
      artifact: "client",
      os: "windows",
      arch: "arm64",
      error: "GitHub returned HTTP 503 for the release download",
    });
    expect(await screen.findByText("Download failed")).toBeInTheDocument();
    expect(screen.getByText("GitHub returned HTTP 503 for the release download")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());
  });

  it("labels Crackstation downloads distinctly", async () => {
    render(
      <>
        <ReleaseDownloadToasts />
        <Toast.Provider maxVisibleToasts={4} placement="bottom" />
      </>,
    );
    emit({
      status: "started",
      downloadId,
      artifact: "crackstation",
      os: "darwin",
      arch: "arm64",
    });

    expect(await screen.findByText("Sliver Crackstation")).toBeInTheDocument();
    expect(screen.getByText("macOS / arm64")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Downloading Sliver Crackstation/ })).toBeInTheDocument();
  });

  it("unsubscribes and closes active progress toasts on unmount", async () => {
    const view = render(
      <>
        <ReleaseDownloadToasts />
        <Toast.Provider maxVisibleToasts={4} placement="bottom" />
      </>,
    );
    emit({
      status: "started",
      downloadId,
      artifact: "client",
      os: "macos",
      arch: "arm64",
    });
    expect(await screen.findByText("Sliver console client")).toBeInTheDocument();

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByText("Sliver console client")).not.toBeInTheDocument());
  });
});

describe("download byte formatting", () => {
  it.each([
    [512, "512 B"],
    [1_536, "1.5 KB"],
    [2.5 * 1024 * 1024, "2.5 MB"],
  ])("formats %s bytes", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

function emit(event: SliverReleaseDownloadEvent): void {
  if (!releaseListener) throw new Error("Release download listener was not installed");
  act(() => releaseListener?.(event));
}
