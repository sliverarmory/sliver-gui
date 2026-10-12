import { useRef, type ReactNode } from "react";
import { DropZone } from "@heroui-pro/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFileArrowUp } from "@fortawesome/free-solid-svg-icons";

interface WebsiteUploadDropZoneProps {
  name: string;
  isDisabled: boolean;
  isPending: boolean;
  onDropFiles: (files: File[]) => void;
  children: ReactNode;
}

export function WebsiteUploadDropZone({ name, isDisabled, isPending, onDropFiles, children }: WebsiteUploadDropZoneProps): React.JSX.Element {
  const nativeFileDrag = useRef(false);
  const droppedFiles = useRef<File[]>([]);

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
              <FontAwesomeIcon aria-hidden className="text-xl text-accent" icon={faFileArrowUp} />
              <p className="text-sm font-semibold">{isPending ? "Uploading website content…" : `Drop to upload to ${name}`}</p>
              <p className="text-xs text-muted">Files and folder contents go to / · File types detected automatically</p>
            </div>
          </div> : null}
        </>}
      </DropZone.Area>
    </DropZone>
  );
}
