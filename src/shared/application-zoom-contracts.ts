export interface ApplicationZoomAPI {
  getFactor(): number;
  reset(): void;
  onChanged(listener: (factor: number) => void): () => void;
}

/** Notification only. Electron main reads the actual zoom from the sending window. */
export const WORKSPACE_ZOOM_CHANGED_CHANNEL = "sliver:workspace-zoom:changed";
