import { IPC } from "../shared/contracts.js";

interface ScriptEditorWindow {
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
  webContents: {
    isDestroyed: () => boolean;
    send: (channel: string) => void;
  };
}

interface ScriptEditorCloseDialogOptions<Window extends ScriptEditorWindow> {
  getWindow: (contentsId: number) => Window | undefined;
  getFocusedWindow: () => Window | null;
  showDialog: (owner: Window | undefined) => number;
}

/** Returns the synchronous close decision and restores the draft after cancellation. */
export function confirmDiscardScriptChanges<Window extends ScriptEditorWindow>(
  contentsIds: readonly number[],
  options: ScriptEditorCloseDialogOptions<Window>,
): boolean {
  const focused = options.getFocusedWindow();
  const owner = (): Window | undefined => {
    const candidates = contentsIds.map(options.getWindow).filter((window): window is Window => (
      Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed())
    ));
    return candidates.find((window) => window === focused) ?? candidates[0];
  };

  if (options.showDialog(owner()) === 1) return true;

  // Let the close/quit listener finish cancelling before bringing the editor forward.
  setImmediate(() => {
    const window = owner();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.send(IPC.scriptEditorRequested);
  });
  return false;
}
