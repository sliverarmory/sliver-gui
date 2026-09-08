import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { faCopy, faPaste } from "@fortawesome/free-solid-svg-icons";
import { toast } from "@heroui/react";
import type { Terminal } from "ghostty-web";

import { useApplicationContextMenuScope } from "./ApplicationContextMenu";

interface GhosttyTerminalClipboardProps {
  readonly children: ReactNode;
  readonly terminal: Terminal | undefined;
  readonly hostRef: RefObject<HTMLDivElement | null>;
  readonly canPaste: boolean;
  readonly getSelection: () => string;
  readonly paste: (text: string) => void;
}

/** Explicit clipboard actions use Ghostty's buffer, never the browser's editable host. */
export function GhosttyTerminalClipboard({
  children,
  terminal,
  hostRef,
  canPaste,
  getSelection,
  paste,
}: GhosttyTerminalClipboardProps): React.JSX.Element {
  const [selection, setSelection] = useState("");
  const mounted = useRef(false);
  const current = useRef({ terminal, canPaste, getSelection, paste });
  current.current = { terminal, canPaste, getSelection, paste };
  const isMac = navigator.platform.toLowerCase().includes("mac");

  const isCurrent = (expected: Terminal | undefined): boolean => {
    const host = hostRef.current;
    return mounted.current && expected !== undefined && current.current.terminal === expected &&
      host !== null && host.isConnected && !host.closest("[inert]");
  };

  const copySelection = async (text: string, expected = terminal): Promise<void> => {
    if (!text || !isCurrent(expected)) return;
    try {
      requireClipboardGesture();
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
    } catch {
      toast.danger("Could not copy terminal selection", {
        description: "Clipboard access failed. Select the text and try Copy again.",
      });
    }
  };

  const pasteClipboard = async (expected = terminal): Promise<void> => {
    if (!isCurrent(expected) || !current.current.canPaste) return;
    try {
      requireClipboardGesture();
      if (!navigator.clipboard?.readText) throw new Error("Clipboard unavailable");
      const text = await navigator.clipboard.readText();
      // A tab switch, reconnect, close, or unmount must not redirect a pending paste.
      if (!text || !isCurrent(expected) || !current.current.canPaste) return;
      current.current.paste(text);
      expected?.focus();
    } catch {
      toast.danger("Could not paste into terminal", {
        description: "Use clipboard text of at most 64 KiB without NUL bytes and try Paste again.",
      });
    }
  };

  const scope = useApplicationContextMenuScope({
    builtInPolicy: "inspect-only",
    actions: [
      {
        id: "terminal-copy",
        label: "Copy",
        icon: faCopy,
        isDisabled: !terminal || selection.length === 0,
        shortcut: isMac ? "⌘C" : "Ctrl+Shift+C",
        // Preserve the selection that was present when this menu was opened.
        onAction: () => copySelection(selection),
      },
      {
        id: "terminal-paste",
        label: "Paste",
        icon: faPaste,
        isDisabled: !terminal || !canPaste,
        shortcut: isMac ? "⌘V" : "Ctrl+Shift+V",
        onAction: () => pasteClipboard(),
      },
    ],
  });

  useEffect(() => {
    setSelection(terminal ? getSelection() : "");
    const subscription = terminal?.onSelectionChange(() => setSelection(getSelection()));
    return () => subscription?.dispose();
  }, [getSelection, terminal]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !terminal) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.altKey || !isCurrent(terminal)) return;
      const modifier = isMac
        ? event.metaKey && !event.ctrlKey && !event.shiftKey
        : event.ctrlKey && event.shiftKey && !event.metaKey;
      const key = event.key.toLowerCase();
      if (!modifier || (key !== "c" && key !== "v")) return;
      // Consume the shortcut before Ghostty can encode it as terminal input.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (key === "c") void copySelection(current.current.getSelection(), terminal);
      else void pasteClipboard(terminal);
    };
    host.addEventListener("keydown", onKeyDown, true);
    return () => host.removeEventListener("keydown", onKeyDown, true);
  }, [hostRef, isMac, terminal]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  return (
    <div
      {...scope}
      className="contents"
      // Ghostty 0.4.0 clears selection without emitting onSelectionChange.
      // Refresh before the menu takes focus and snapshots these scoped actions.
      onContextMenuCapture={() => setSelection(terminal ? getSelection() : "")}
    >
      {children}
    </div>
  );
}

function requireClipboardGesture(): void {
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    throw new Error("Clipboard access requires an explicit operator action");
  }
}
