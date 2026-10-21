import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { Toast, toast } from "@heroui/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpFileTransferProgress, RdpTab } from "../../../../shared/rdp-contracts";
import { RdpFileTransferToasts } from "./RdpFileTransferToasts";

const progress: RdpFileTransferProgress = { id: "copy-1", direction: "receive", phase: "preparing", transferredBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0 };
const tab: RdpTab = { id: "office", attempt: 1, label: "Office", host: "office.test", port: 3389, username: "operator", domain: "",
  width: 800, height: 600, clipboard: true, clipboardReady: true, clipboardAvailable: false, scaleMode: "fit", state: "active", fileTransfer: progress };

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
});
afterAll(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(Element.prototype, "getAnimations"); });
beforeEach(() => toast.clear());
afterEach(() => { cleanup(); toast.clear(); });

function content(tabs: readonly RdpTab[]): React.JSX.Element {
  return <><RdpFileTransferToasts tabs={tabs} /><Toast.Provider maxVisibleToasts={4} placement="bottom" /></>;
}

function update(phase: RdpFileTransferProgress["phase"], changed: Partial<RdpFileTransferProgress> = {}): RdpTab {
  return { ...tab, fileTransfer: { ...progress, phase, totalBytes: 1024, totalFiles: 2, ...changed } };
}

describe("RDP file transfer toasts", () => {
  it("keeps one toast while preparation becomes progress and completion", async () => {
    const view = render(content([tab]));
    const heading = await screen.findByText("Receiving files", { exact: true });
    const notification = heading.closest('[data-slot="toast"]');
    const toastId = toast.getQueue().visibleToasts[0]!.key;
    expect(notification).toBeInTheDocument();
    expect(screen.getByText("Preparing…")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Receiving files · Office" })).not.toHaveAttribute("aria-valuenow");
    expect(toast.getQueue().visibleToasts[0]!.timeout).toBe(0);

    view.rerender(content([update("transferring", { transferredBytes: 512, completedFiles: 1 })]));
    expect(await screen.findByText("50%")).toBeInTheDocument();
    expect(screen.getByText("512 B / 1.0 KiB")).toBeInTheDocument();
    expect(screen.getByText("1 / 2 files")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Receiving files · Office" })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("Receiving files", { exact: true }).closest('[data-slot="toast"]')).toBe(notification);
    expect(toast.getQueue().visibleToasts[0]!.key).toBe(toastId);

    view.rerender(content([update("completed", { transferredBytes: 1024, completedFiles: 2 })]));
    expect(await screen.findByText("Files received")).toBeInTheDocument();
    expect(screen.getByText("Ready to paste locally.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("Files received").closest('[data-slot="toast"]')).toBe(notification);
    expect(toast.getQueue().visibleToasts[0]!.key).toBe(toastId);
    expect(toast.getQueue().visibleToasts[0]!.timeout).toBe(4000);
  });

  it.each(["failed", "canceled"] as const)("replaces transfer progress with its %s outcome", async (phase) => {
    const view = render(content([update("transferring", { direction: "send", transferredBytes: 256 })]));
    const id = toast.getQueue().visibleToasts[0]!.key;
    expect(await screen.findByRole("progressbar", { name: "Sending files · Office" })).toHaveAttribute("aria-valuenow", "25");
    view.rerender(content([update(phase, { direction: "send", transferredBytes: 256, error: "The remote file could not be read." })]));
    expect(await screen.findByText(phase === "failed" ? "File transfer failed" : "File transfer canceled")).toBeInTheDocument();
    expect(screen.getByText(phase === "failed" ? "The remote file could not be read." : "Copy the files again to retry.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(toast.getQueue().visibleToasts).toHaveLength(1);
    expect(toast.getQueue().visibleToasts[0]!.key).toBe(id);
  });

  it("does not reopen a dismissed transfer for later progress or completion", async () => {
    const view = render(content([update("transferring")]));
    const id = toast.getQueue().visibleToasts[0]!.key;
    act(() => toast.close(id));
    view.rerender(content([update("transferring", { transferredBytes: 512 })]));
    view.rerender(content([update("completed", { transferredBytes: 1024, completedFiles: 2 })]));
    await waitFor(() => expect(screen.queryByText("Receiving files", { exact: true })).not.toBeInTheDocument());
    expect(screen.queryByText("Files received")).not.toBeInTheDocument();
    view.rerender(content([{ ...tab, fileTransfer: { ...progress, id: "copy-2" } }]));
    expect(await screen.findByText("Receiving files", { exact: true })).toBeInTheDocument();
    expect(toast.getQueue().visibleToasts[0]!.key).not.toBe(id);
  });

  it("tracks different sessions separately even when transfer identifiers match", async () => {
    const lab = { ...tab, id: "lab", label: "Lab", fileTransfer: { ...progress, direction: "send" as const } };
    const view = render(content([tab, lab]));
    expect(await screen.findByRole("progressbar", { name: "Receiving files · Office" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Sending files · Lab" })).toBeInTheDocument();
    expect(toast.getQueue().visibleToasts).toHaveLength(2);
    view.rerender(content([update("completed", { transferredBytes: 1024, completedFiles: 2 }), lab]));
    expect(await screen.findByText("Files received")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Sending files · Lab" })).toBeInTheDocument();
  });

  it("uses file count progress for empty files and removes notifications with their session", async () => {
    const view = render(content([update("transferring", { totalBytes: 0, completedFiles: 1 })]));
    expect(await screen.findByText("50%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    view.rerender(content([]));
    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());
  });

  it("does not duplicate an outcome on unchanged snapshots", async () => {
    const completed = update("completed", { direction: "send", transferredBytes: 1024, completedFiles: 2 });
    const view = render(content([completed]));
    const heading = await screen.findByText("Files sent");
    const notification = heading.closest('[data-slot="toast"]') as HTMLElement;
    view.rerender(content([{ ...completed, fileTransfer: { ...completed.fileTransfer! } }]));
    expect(toast.getQueue().visibleToasts).toHaveLength(1);
    expect(within(notification).getByText("Files sent")).toBeInTheDocument();
  });

  it("continues updating transfers beyond the provider's visual toast limit", async () => {
    const tabs = [tab, ...["Lab", "Build", "Server"].map((label) => ({ ...tab, id: label.toLowerCase(), label }))];
    const view = render(content(tabs));
    const originalIds = toast.getQueue().visibleToasts.map((item) => item.key);
    act(() => { toast("Clipboard ready to paste on the remote desktop.", { timeout: 0 }); });
    expect(toast.getQueue().visibleToasts).toHaveLength(5);
    view.rerender(content([update("transferring", { transferredBytes: 512 }), ...tabs.slice(1)]));
    const bar = document.querySelector('[aria-label="Receiving files · Office"]');
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(toast.getQueue().visibleToasts).toHaveLength(5);
    expect(toast.getQueue().visibleToasts.map((item) => item.key)).toEqual(expect.arrayContaining(originalIds));
  });

  it("keeps active transfer toasts open beyond ordinary toast timeouts", async () => {
    vi.useFakeTimers();
    try {
      render(content([update("transferring", { transferredBytes: 512 })]));
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(toast.getQueue().visibleToasts).toHaveLength(1);
      expect(toast.getQueue().visibleToasts[0]!.timeout).toBe(0);
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    } finally { vi.useRealTimers(); }
  });
});
