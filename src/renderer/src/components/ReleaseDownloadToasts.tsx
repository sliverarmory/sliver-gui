import { useEffect, useRef, useSyncExternalStore } from "react";
import { ProgressBar, toast } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDownload } from "@fortawesome/free-solid-svg-icons";

import type { SliverReleaseDownloadEvent } from "../../../shared/release-contracts";

const downloadStates = new Map<string, SliverReleaseDownloadEvent>();
const downloadStateListeners = new Map<string, Set<() => void>>();

export function ReleaseDownloadToasts(): null {
  const toastIds = useRef(new Map<string, string>());

  useEffect(() => {
    const activeToastIds = toastIds.current;
    const unsubscribe = window.sliver.onReleaseDownloadChanged((event) => {
      setDownloadState(event);
      if (event.status === "started" || event.status === "progress") {
        if (!activeToastIds.has(event.downloadId)) {
          const toastId = toast(downloadTitle(event), {
            description: <ReleaseDownloadProgress downloadId={event.downloadId} />,
            indicator: <FontAwesomeIcon aria-hidden icon={faDownload} />,
            timeout: 0,
            variant: "accent",
          });
          activeToastIds.set(event.downloadId, toastId);
        }
        return;
      }

      const toastId = activeToastIds.get(event.downloadId);
      if (toastId) toast.close(toastId);
      activeToastIds.delete(event.downloadId);
      if (event.status === "completed") {
        toast.success("Download complete", {
          description: `${event.fileName} was saved to Downloads.`,
        });
      } else {
        toast.danger("Download failed", { description: event.error });
      }
      scheduleDownloadStateRemoval(event.downloadId);
    });
    return () => {
      unsubscribe();
      for (const toastId of activeToastIds.values()) toast.close(toastId);
      activeToastIds.clear();
    };
  }, []);

  return null;
}

function ReleaseDownloadProgress({ downloadId }: { readonly downloadId: string }): React.JSX.Element | null {
  const state = useSyncExternalStore(
    (listener) => subscribeToDownloadState(downloadId, listener),
    () => downloadStates.get(downloadId),
    () => downloadStates.get(downloadId),
  );
  if (!state) return null;
  if (state.status === "started") {
    return (
      <div className="mt-2 w-72 max-w-full">
        <ProgressBar isIndeterminate aria-label={`${downloadTitle(state)} progress`} size="sm">
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      </div>
    );
  }
  if (state.status === "failed") return null;
  const percentage = state.totalBytes === 0 ? 0 : (state.receivedBytes / state.totalBytes) * 100;
  return (
    <div className="mt-2 w-72 max-w-full space-y-2">
      <div className="flex min-w-0 items-center justify-between gap-3 text-xs text-muted">
        <span className="truncate">{state.fileName}</span>
        <span className="shrink-0 tabular-nums">
          {Math.min(100, Math.round(percentage))}% · {formatBytes(state.receivedBytes)} / {formatBytes(state.totalBytes)}
        </span>
      </div>
      <ProgressBar
        aria-label={`${downloadTitle(state)} progress`}
        maxValue={100}
        size="sm"
        value={percentage}
      >
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
    </div>
  );
}

function setDownloadState(event: SliverReleaseDownloadEvent): void {
  downloadStates.set(event.downloadId, event);
  for (const listener of downloadStateListeners.get(event.downloadId) ?? []) listener();
}

function subscribeToDownloadState(downloadId: string, listener: () => void): () => void {
  const listeners = downloadStateListeners.get(downloadId) ?? new Set();
  listeners.add(listener);
  downloadStateListeners.set(downloadId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) downloadStateListeners.delete(downloadId);
  };
}

function scheduleDownloadStateRemoval(downloadId: string): void {
  setTimeout(() => {
    downloadStates.delete(downloadId);
    downloadStateListeners.delete(downloadId);
  }, 10_000);
}

function downloadTitle(event: Pick<SliverReleaseDownloadEvent, "artifact" | "os" | "arch">): string {
  const artifact = event.artifact === "server" ? "server" : "console client";
  return `Downloading Sliver ${artifact} · ${operatingSystemLabel(event.os)} / ${architectureLabel(event.arch)}`;
}

function operatingSystemLabel(value: string): string {
  if (value === "darwin" || value === "macos") return "macOS";
  if (value === "linux") return "Linux";
  if (value === "windows") return "Windows";
  if (value === "freebsd") return "FreeBSD";
  return value;
}

function architectureLabel(value: string): string {
  if (value === "amd64") return "amd64";
  return value;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
