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
          const toastId = toast(<ReleaseDownloadHeading downloadId={event.downloadId} />, {
            description: <ReleaseDownloadProgress downloadId={event.downloadId} />,
            indicator: <FontAwesomeIcon aria-hidden className="size-4" icon={faDownload} />,
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

function ReleaseDownloadHeading({ downloadId }: { readonly downloadId: string }): React.JSX.Element | null {
  const state = useDownloadState(downloadId);
  if (!state || state.status === "failed") return null;
  return (
    <span className="flex min-w-0 items-center justify-between gap-4">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{artifactTitle(state.artifact)}</span>
        <span className="text-xs font-normal text-muted tabular-nums [overflow-wrap:anywhere]">
          {operatingSystemLabel(state.os)} / {architectureLabel(state.arch)}
          {state.status !== "started" ? ` · ${state.version}` : ""}
        </span>
      </span>
      <span className="shrink-0 rounded-lg bg-default px-3 py-1.5 text-sm font-medium text-accent tabular-nums">
        {state.status === "started" ? "Starting" : `${Math.round(downloadPercentage(state))}%`}
      </span>
    </span>
  );
}

function ReleaseDownloadProgress({ downloadId }: { readonly downloadId: string }): React.JSX.Element | null {
  const state = useDownloadState(downloadId);
  if (!state || state.status === "failed") return null;
  const isStarting = state.status === "started";
  return (
    <div className="release-download-toast min-w-0 w-full space-y-2">
      <ProgressBar
        aria-label={`${downloadTitle(state)} progress`}
        className="w-full gap-0"
        isIndeterminate={isStarting}
        maxValue={100}
        size="sm"
        value={isStarting ? 0 : downloadPercentage(state)}
      >
        <ProgressBar.Track className="h-1.5 rounded-full">
          <ProgressBar.Fill className="rounded-full" />
        </ProgressBar.Track>
      </ProgressBar>
      {!isStarting ? (
        <div className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-xs leading-5 text-muted sm:grid-cols-[minmax(0,1fr)_auto]">
          <span className="min-w-0 [overflow-wrap:anywhere]">{state.fileName}</span>
          <span className="justify-self-end whitespace-nowrap tabular-nums">
            {formatBytes(state.receivedBytes)} / {formatBytes(state.totalBytes)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function useDownloadState(downloadId: string): SliverReleaseDownloadEvent | undefined {
  return useSyncExternalStore(
    (listener) => subscribeToDownloadState(downloadId, listener),
    () => downloadStates.get(downloadId),
    () => downloadStates.get(downloadId),
  );
}

function downloadPercentage(state: { readonly receivedBytes: number; readonly totalBytes: number }): number {
  return state.totalBytes === 0 ? 0 : Math.min(100, (state.receivedBytes / state.totalBytes) * 100);
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
  return `Downloading ${artifactTitle(event.artifact)} · ${operatingSystemLabel(event.os)} / ${architectureLabel(event.arch)}`;
}

function artifactTitle(value: SliverReleaseDownloadEvent["artifact"]): string {
  const artifact = value === "server"
    ? "server"
    : value === "client"
      ? "console client"
      : "Crackstation";
  return `Sliver ${artifact}`;
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
