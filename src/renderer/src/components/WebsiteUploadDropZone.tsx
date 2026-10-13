import { useRef, type ReactNode } from "react";
import { ProgressBar, Spinner } from "@heroui/react";
import { DropZone } from "@heroui-pro/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFileArrowUp } from "@fortawesome/free-solid-svg-icons";
import type { WebsiteUploadProgress } from "../../../shared/website-contracts";

interface WebsiteUploadDropZoneProps {
  name: string;
  isDisabled: boolean;
  isPending: boolean;
  progress?: WebsiteUploadProgress | undefined;
  onDropFiles: (files: File[]) => void;
  children: ReactNode;
}

export function WebsiteUploadDropZone({ name, isDisabled, isPending, progress, onDropFiles, children }: WebsiteUploadDropZoneProps): React.JSX.Element {
  const nativeFileDrag = useRef(false);
  const droppedFiles = useRef<File[]>([]);
  const uploadProgress = isPending && progress && progress.totalFiles > 0 ? progress : undefined;

  return (
    <DropZone
      className="mb-20 min-w-0 self-start"
      aria-busy={isPending}
      onDragEnterCapture={(event) => { nativeFileDrag.current = event.dataTransfer.types.includes("Files"); }}
      onDragOverCapture={(event) => { nativeFileDrag.current = event.dataTransfer.types.includes("Files"); }}
      onDropCapture={(event) => {
        // Preserve native directory File objects before React Aria converts them
        // to traversal handles. Only preload resolves their local paths.
        event.preventDefault();
        droppedFiles.current = isDisabled ? [] : Array.from(event.dataTransfer.files);
      }}
    >
      <DropZone.Area
        aria-label={name ? `Upload files or directories to ${name}` : "Select a website to upload files"}
        className="relative w-full items-stretch justify-start gap-0 rounded-2xl border-0 p-0 text-start data-[disabled=true]:opacity-100"
        isDisabled={isDisabled}
        getDropOperation={() => nativeFileDrag.current ? "copy" : "cancel"}
        onDrop={() => {
          const files = droppedFiles.current;
          droppedFiles.current = [];
          nativeFileDrag.current = false;
          if (!isDisabled && files.length) onDropFiles(files);
        }}
      >
        {({ isDropTarget }) => <>
          {children}
          {isDropTarget || isPending ? <div
            className="pointer-events-none absolute inset-2 z-20 rounded-xl border border-accent bg-accent-soft"
          >
            <div className="sticky top-4 mx-auto mt-4 flex w-fit max-w-[90%] flex-col items-center gap-2 rounded-xl bg-overlay px-6 py-4 text-center text-foreground shadow-overlay" role="status">
              {!isPending ? <FontAwesomeIcon aria-hidden className="text-xl text-accent" icon={faFileArrowUp} /> : null}
              <p className="flex items-center gap-2 text-sm font-semibold tabular-nums">
                {isPending ? <Spinner aria-hidden size="sm" /> : null}
                {uploadProgress
                  ? `Uploading ${Math.min(uploadProgress.completedFiles + 1, uploadProgress.totalFiles)} of ${uploadProgress.totalFiles} ${uploadProgress.totalFiles === 1 ? "file" : "files"}`
                  : isPending ? "Uploading website content…" : `Drop to upload to ${name}`}
              </p>
              {uploadProgress ? <ProgressBar aria-label="Website upload progress" className="w-full" size="sm"
                value={uploadProgress.completedFiles} maxValue={uploadProgress.totalFiles}
                valueLabel={`${uploadProgress.completedFiles} of ${uploadProgress.totalFiles} ${uploadProgress.totalFiles === 1 ? "file" : "files"} uploaded`}>
                <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
              </ProgressBar> : null}
              <p className="text-xs text-muted">Files and folder contents go to / · File types detected automatically</p>
            </div>
          </div> : null}
        </>}
      </DropZone.Area>
    </DropZone>
  );
}
