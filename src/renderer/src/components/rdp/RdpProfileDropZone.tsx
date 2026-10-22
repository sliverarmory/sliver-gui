import { useRef, type ReactNode } from "react";
import { Spinner } from "@heroui/react";
import { DropZone } from "@heroui-pro/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFileImport } from "@fortawesome/free-solid-svg-icons";

interface Props {
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onDropFiles: (files: File[]) => void;
  readonly children: ReactNode;
}

export function RdpProfileDropZone({ disabled, pending, onDropFiles, children }: Props): React.JSX.Element {
  const nativeFiles = useRef(false);
  const droppedFiles = useRef<File[]>([]);
  return <DropZone className="min-h-0 w-full min-w-0" aria-busy={pending}
    onDragEnterCapture={(event) => { nativeFiles.current = event.dataTransfer.types.includes("Files"); }}
    onDragOverCapture={(event) => { nativeFiles.current = event.dataTransfer.types.includes("Files"); }}
    onDropCapture={(event) => {
      // Preload resolves native File objects; the renderer never reads their paths or contents.
      event.preventDefault(); droppedFiles.current = disabled ? [] : Array.from(event.dataTransfer.files);
    }}>
    <DropZone.Area aria-label="Import RDP profiles" isDisabled={disabled}
      className="relative min-h-32 w-full items-stretch justify-start gap-0 rounded-xl border-0 p-0 text-start data-[disabled=true]:opacity-100"
      getDropOperation={() => nativeFiles.current ? "copy" : "cancel"}
      onDrop={() => {
        const files = droppedFiles.current; droppedFiles.current = []; nativeFiles.current = false;
        if (!disabled && files.length) onDropFiles(files);
      }}>
      {({ isDropTarget }) => <>{children}{isDropTarget || pending ? <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl border border-accent bg-accent-soft">
        <div className="flex items-center gap-2 rounded-xl bg-overlay px-5 py-4 text-sm font-medium shadow-overlay" role="status">
          {pending ? <Spinner aria-hidden size="sm" /> : <FontAwesomeIcon aria-hidden icon={faFileImport} />}
          {pending ? "Importing RDP profiles…" : "Drop .rdp files to import profiles"}
        </div>
      </div> : null}</>}
    </DropZone.Area>
  </DropZone>;
}
