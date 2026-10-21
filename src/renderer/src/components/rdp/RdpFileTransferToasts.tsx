import { useEffect, useRef } from "react";
import { ProgressBar, toast } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleCheck, faDownload, faTriangleExclamation, faUpload, faXmark } from "@fortawesome/free-solid-svg-icons";
import type { RdpFileTransferProgress, RdpTab } from "../../../../shared/rdp-contracts";

interface TransferToast {
  id: string;
  dismissed: boolean;
  snapshot: string;
}

/** Transfer notifications live in the global toast overlay, outside desktop layout. */
export function RdpFileTransferToasts({ tabs }: { readonly tabs: readonly RdpTab[] }): null {
  const entries = useRef(new Map<string, TransferToast>());

  useEffect(() => {
    const current = new Set<string>();
    for (const tab of tabs) {
      const progress = tab.fileTransfer;
      if (!progress) continue;
      const key = `${tab.id}:${tab.attempt}:${progress.id}`;
      current.add(key);
      const snapshot = JSON.stringify([tab.label, progress]);
      const entry = entries.current.get(key);
      if (entry?.dismissed || entry?.snapshot === snapshot) continue;
      if (entry && !toast.getQueue().visibleToasts.some(({ key: toastId }) => toastId === entry.id)) {
        entry.dismissed = true;
        continue;
      }
      const active = progress.phase === "preparing" || progress.phase === "transferring";
      const options = {
        description: <TransferContent progress={progress} label={tab.label} />,
        indicator: <FontAwesomeIcon aria-hidden className="size-4" icon={progress.phase === "completed" ? faCircleCheck
          : progress.phase === "failed" ? faTriangleExclamation : progress.phase === "canceled" ? faXmark
          : progress.direction === "send" ? faUpload : faDownload} />,
        variant: progress.phase === "completed" ? "success" as const : progress.phase === "failed" ? "danger" as const
          : progress.phase === "canceled" ? "default" as const : "accent" as const,
        timeout: active ? 0 : progress.phase === "failed" ? 8_000 : 4_000,
      };
      const heading = transferHeading(progress);
      if (entry) {
        toast.update(entry.id, heading, options);
        entry.snapshot = snapshot;
      } else {
        const next: TransferToast = { id: "", dismissed: false, snapshot };
        next.id = toast(heading, { ...options, onClose: () => { next.dismissed = true; } });
        entries.current.set(key, next);
      }
    }
    for (const [key, entry] of entries.current) {
      if (current.has(key)) continue;
      if (!entry.dismissed) toast.close(entry.id);
      entries.current.delete(key);
    }
  }, [tabs]);

  useEffect(() => {
    const owned = entries.current;
    return () => { for (const entry of owned.values()) toast.close(entry.id); owned.clear(); };
  }, []);
  return null;
}

function TransferContent({ progress, label }: { readonly progress: RdpFileTransferProgress; readonly label: string }): React.JSX.Element {
  const active = progress.phase === "preparing" || progress.phase === "transferring";
  const percent = progress.totalBytes > 0 ? Math.min(100, Math.max(0, progress.transferredBytes / progress.totalBytes * 100))
    : progress.totalFiles > 0 ? Math.min(100, progress.completedFiles / progress.totalFiles * 100) : 0;
  return <div className="rdp-transfer-toast min-w-0 w-full space-y-2">
    <div className="flex min-w-0 items-center justify-between gap-4 text-xs leading-5">
      <span className="min-w-0 truncate">{label}</span>
      {active && <span className="shrink-0 tabular-nums">{progress.phase === "preparing" ? "Preparing…" : `${Math.round(percent)}%`}</span>}
    </div>
    {active && <ProgressBar aria-label={`${progress.direction === "send" ? "Sending" : "Receiving"} files · ${label}`}
      className="w-full gap-0" isIndeterminate={progress.phase === "preparing"} maxValue={100} size="sm" value={percent}>
      <ProgressBar.Track className="h-1.5 rounded-full"><ProgressBar.Fill className="rounded-full" /></ProgressBar.Track>
    </ProgressBar>}
    {progress.phase !== "preparing" && <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs leading-5 text-muted tabular-nums">
      <span>{progress.completedFiles} / {progress.totalFiles} {progress.totalFiles === 1 ? "file" : "files"}</span>
      <span>{formatBytes(progress.transferredBytes)} / {formatBytes(progress.totalBytes)}</span>
    </div>}
    {progress.phase === "completed" && progress.direction === "receive" && <p className="text-xs leading-5 text-muted">Ready to paste locally.</p>}
    {progress.phase === "failed" && <p className="text-xs leading-5 text-muted [overflow-wrap:anywhere]">{progress.error ?? "Copy the files again and retry."}</p>}
    {progress.phase === "canceled" && <p className="text-xs leading-5 text-muted">Copy the files again to retry.</p>}
  </div>;
}

function transferHeading(progress: RdpFileTransferProgress): string {
  if (progress.phase === "completed") return progress.direction === "send" ? "Files sent" : "Files received";
  if (progress.phase === "failed") return "File transfer failed";
  if (progress.phase === "canceled") return "File transfer canceled";
  return progress.direction === "send" ? "Sending files" : "Receiving files";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
