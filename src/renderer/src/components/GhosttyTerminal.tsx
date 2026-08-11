import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  FitAddon,
  Ghostty,
  Terminal,
  type IDisposable,
  type ITheme,
} from "ghostty-web";

import { STREAM_MAX_TERMINAL_DIMENSION } from "../../../shared/stream-contracts";

import { TerminalOutputSanitizer } from "./terminal-output-sanitizer";

const MIN_TERMINAL_DIMENSION = 1;
const RESIZE_DEBOUNCE_MS = 100;
const RESPONSE_BUDGET_WINDOW_MS = 1_000;
const DEFAULT_TERMINAL_RESPONSE_BUDGET_BYTES = 4 * 1024;
const MAX_TERMINAL_RESPONSE_BUDGET_BYTES = 64 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 256 * 1024;
const MAX_EXPLICIT_TEXT_BYTES = 64 * 1024;
const MAX_OPERATOR_FRAME_BYTES = MAX_EXPLICIT_TEXT_BYTES + 32;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type GhosttyTerminalInputSource = "operator" | "terminal-response";

export interface GhosttyTerminalTransportSubscription {
  onOutput: (bytes: Uint8Array) => void;
  onClose: (reason?: string) => void;
}

export interface GhosttyTerminalTransport {
  send: (bytes: Uint8Array, source: GhosttyTerminalInputSource) => void;
  resize: (cols: number, rows: number) => void;
  subscribe: (subscription: GhosttyTerminalTransportSubscription) => () => void;
}

export interface GhosttyTerminalHandle {
  focus: () => void;
  getSelection: () => string;
  paste: (text: string) => void;
}

export interface GhosttyTerminalAppearance {
  cursorBlink?: boolean;
  cursorStyle?: "block" | "underline" | "bar";
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
  theme?: ITheme;
}

export interface GhosttyTerminalProps {
  wasmBytes: ArrayBuffer | Uint8Array;
  transport: GhosttyTerminalTransport;
  appearance?: GhosttyTerminalAppearance;
  ariaLabel?: string;
  className?: string;
  terminalResponseBudgetBytes?: number;
  onClose?: (reason?: string) => void;
  onError?: (error: Error) => void;
  onReady?: () => void;
}

type TerminalState = "loading" | "ready" | "closed" | "failed";

/**
 * A renderer-only Ghostty boundary. It consumes caller-supplied, pinned WASM
 * bytes without invoking Ghostty.load/init (and therefore without fetch), owns
 * one isolated WASM instance per mount, and exposes no terminal host callback.
 */
export const GhosttyTerminal = forwardRef<GhosttyTerminalHandle, GhosttyTerminalProps>(
  function GhosttyTerminal(
    {
      appearance,
      ariaLabel = "Interactive session terminal",
      className,
      onClose,
      onError,
      onReady,
      terminalResponseBudgetBytes,
      transport,
      wasmBytes,
    },
    forwardedRef,
  ): React.JSX.Element {
    const hostRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | undefined>(undefined);
    const onCloseRef = useLatest(onClose);
    const onErrorRef = useLatest(onError);
    const onReadyRef = useLatest(onReady);
    const [terminalState, setTerminalState] = useState<TerminalState>("loading");

    useImperativeHandle(forwardedRef, () => ({
      focus: () => terminalRef.current?.focus(),
      getSelection: () => boundedText(terminalRef.current?.getSelection() ?? ""),
      paste: (text: string) => {
        const bytes = textEncoder.encode(text);
        if (text.includes("\0")) throw new Error("Terminal paste cannot contain NUL bytes");
        if (bytes.byteLength > MAX_EXPLICIT_TEXT_BYTES) {
          throw new RangeError(`Terminal paste exceeds ${MAX_EXPLICIT_TEXT_BYTES} bytes`);
        }
        terminalRef.current?.paste(text);
      },
    }), []);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      let disposed = false;
      let streamClosed = false;
      let terminal: Terminal | undefined;
      let fitAddon: FitAddon | undefined;
      let inputSubscription: IDisposable | undefined;
      let resizeSubscription: IDisposable | undefined;
      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingResize: { cols: number; rows: number } | undefined;
      let lastResize: { cols: number; rows: number } | undefined;
      let remoteWriteDepth = 0;
      let currentWriteResponseBytes = 0;
      let responseWindowStartedAt = Date.now();
      let responseWindowBytes = 0;
      let pendingOutputBytes = 0;
      const pendingOutput: Uint8Array[] = [];
      const sanitizer = new TerminalOutputSanitizer();
      const responseBudget = normalizedResponseBudget(terminalResponseBudgetBytes);
      setTerminalState("loading");

      const reportError = (error: unknown): void => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        onErrorRef.current?.(normalized);
      };

      const denyModifiedLink = (event: MouseEvent): void => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const denyNativeTransfer = (event: Event): void => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };

      host.addEventListener("click", denyModifiedLink, true);
      host.addEventListener("auxclick", denyModifiedLink, true);
      host.addEventListener("contextmenu", denyNativeTransfer, true);
      host.addEventListener("copy", denyNativeTransfer, true);
      host.addEventListener("cut", denyNativeTransfer, true);
      host.addEventListener("paste", denyNativeTransfer, true);

      const sendTerminalData = (data: string): void => {
        if (disposed || streamClosed) return;
        const bytes = textEncoder.encode(data);

        if (remoteWriteDepth > 0) {
          const now = Date.now();
          if (now - responseWindowStartedAt >= RESPONSE_BUDGET_WINDOW_MS) {
            responseWindowStartedAt = now;
            responseWindowBytes = 0;
          }
          if (
            bytes.byteLength === 0 ||
            currentWriteResponseBytes + bytes.byteLength > responseBudget ||
            responseWindowBytes + bytes.byteLength > responseBudget
          ) return;

          currentWriteResponseBytes += bytes.byteLength;
          responseWindowBytes += bytes.byteLength;
          transport.send(bytes, "terminal-response");
          return;
        }

        if (bytes.byteLength === 0 || bytes.byteLength > MAX_OPERATOR_FRAME_BYTES) return;
        transport.send(bytes, "operator");
      };

      const writeRemoteOutput = (bytes: Uint8Array): void => {
        if (!terminal || disposed || bytes.byteLength === 0) return;
        currentWriteResponseBytes = 0;
        remoteWriteDepth += 1;
        try {
          terminal.write(bytes);
        } finally {
          remoteWriteDepth -= 1;
        }
      };

      const queueFilteredOutput = (filtered: Uint8Array): void => {
        if (terminal) {
          writeRemoteOutput(filtered);
          return;
        }
        if (pendingOutputBytes + filtered.byteLength > MAX_PENDING_OUTPUT_BYTES) {
          filtered.fill(0);
          reportError(new Error("Terminal output arrived faster than the runtime could initialize"));
          return;
        }
        pendingOutput.push(filtered);
        pendingOutputBytes += filtered.byteLength;
      };

      const queueOrWriteOutput = (bytes: Uint8Array): void => {
        const filtered = sanitizer.filter(bytes);
        if (filtered.byteLength > 0) queueFilteredOutput(filtered);
      };

      const flushSanitizer = (): void => {
        const trailing = sanitizer.finish();
        if (trailing.byteLength > 0) queueFilteredOutput(trailing);
      };

      const unsubscribeTransport = transport.subscribe({
        onOutput: (bytes) => {
          if (!disposed && !streamClosed) queueOrWriteOutput(bytes);
        },
        onClose: (reason) => {
          if (disposed || streamClosed) return;
          flushSanitizer();
          streamClosed = true;
          setTerminalState("closed");
          onCloseRef.current?.(reason);
        },
      });

      const scheduleResize = (cols: number, rows: number): void => {
        if (disposed || streamClosed) return;
        const next = {
          cols: clampDimension(cols),
          rows: clampDimension(rows),
        };
        if (
          (lastResize?.cols === next.cols && lastResize.rows === next.rows) ||
          (pendingResize?.cols === next.cols && pendingResize.rows === next.rows)
        ) return;

        pendingResize = next;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resizeTimer = undefined;
          if (disposed || streamClosed || !pendingResize) return;
          const size = pendingResize;
          pendingResize = undefined;
          if (lastResize?.cols === size.cols && lastResize.rows === size.rows) return;
          lastResize = size;
          transport.resize(size.cols, size.rows);
        }, RESIZE_DEBOUNCE_MS);
      };

      const initialize = async (): Promise<void> => {
        const ownedWasmBytes = copyBytes(wasmBytes);
        let wasmModule: WebAssembly.Module;
        try {
          wasmModule = await WebAssembly.compile(ownedWasmBytes);
        } finally {
          ownedWasmBytes.fill(0);
        }
        if (disposed) return;

        const wasmInstance = await WebAssembly.instantiate(wasmModule, {
          env: {
            // Do not bridge Ghostty/WASM log strings into the renderer console.
            log: () => undefined,
          },
        });
        if (disposed) return;

        const ghostty = new Ghostty(wasmInstance);
        terminal = new Terminal({
          cursorBlink: appearance?.cursorBlink ?? true,
          cursorStyle: appearance?.cursorStyle ?? "block",
          fontFamily: appearance?.fontFamily ?? "SFMono-Regular, Consolas, Liberation Mono, monospace",
          fontSize: boundedNumber(appearance?.fontSize, 8, 32, 13),
          ghostty,
          scrollback: boundedNumber(appearance?.scrollback, 0, 50_000, 5_000),
          smoothScrollDuration: 0,
          ...(appearance?.theme ? { theme: appearance.theme } : {}),
        });
        terminalRef.current = terminal;
        inputSubscription = terminal.onData(sendTerminalData);
        resizeSubscription = terminal.onResize(({ cols, rows }) => scheduleResize(cols, rows));
        fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(host);
        disablePinnedGhosttyAutoCopy(terminal);
        host.setAttribute("aria-label", ariaLabel);
        // Terminal.open focuses its hidden textarea. Return focus to the
        // workspace tab/trigger until the operator explicitly focuses here.
        terminal.blur();
        fitAddon.fit();
        fitAddon.observeResize();

        for (const pending of pendingOutput.splice(0)) {
          pendingOutputBytes -= pending.byteLength;
          writeRemoteOutput(pending);
          pending.fill(0);
        }
        scheduleResize(terminal.cols, terminal.rows);
        if (disposed) return;
        setTerminalState(streamClosed ? "closed" : "ready");
        onReadyRef.current?.();
      };

      void initialize().catch((error: unknown) => {
        if (disposed) return;
        inputSubscription?.dispose();
        resizeSubscription?.dispose();
        terminalRef.current = undefined;
        terminal?.dispose();
        terminal = undefined;
        setTerminalState("failed");
        reportError(error);
      });

      return () => {
        disposed = true;
        unsubscribeTransport();
        if (resizeTimer) clearTimeout(resizeTimer);
        inputSubscription?.dispose();
        resizeSubscription?.dispose();
        terminalRef.current = undefined;
        terminal?.dispose();
        terminal = undefined;
        fitAddon = undefined;
        sanitizer.reset();
        for (const pending of pendingOutput) pending.fill(0);
        pendingOutput.length = 0;
        pendingOutputBytes = 0;
        host.removeEventListener("click", denyModifiedLink, true);
        host.removeEventListener("auxclick", denyModifiedLink, true);
        host.removeEventListener("contextmenu", denyNativeTransfer, true);
        host.removeEventListener("copy", denyNativeTransfer, true);
        host.removeEventListener("cut", denyNativeTransfer, true);
        host.removeEventListener("paste", denyNativeTransfer, true);
      };
    }, [
      appearance?.cursorBlink,
      appearance?.cursorStyle,
      appearance?.fontFamily,
      appearance?.fontSize,
      appearance?.scrollback,
      appearance?.theme,
      ariaLabel,
      onCloseRef,
      onErrorRef,
      onReadyRef,
      terminalResponseBudgetBytes,
      transport,
      wasmBytes,
    ]);

    return (
      <div
        className={["relative h-full min-h-0 w-full overflow-hidden bg-black font-mono", className]
          .filter(Boolean)
          .join(" ")}
        data-terminal-state={terminalState}
      >
        <div
          ref={hostRef}
          aria-busy={terminalState === "loading"}
          aria-label={ariaLabel}
          className="h-full min-h-0 w-full overflow-hidden p-2"
        />
        {terminalState === "failed" ? (
          <p className="absolute inset-0 grid place-items-center text-sm text-danger" role="alert">
            Terminal runtime unavailable
          </p>
        ) : null}
      </div>
    );
  },
);

function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function copyBytes(bytes: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  return copy;
}

function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return MIN_TERMINAL_DIMENSION;
  return Math.max(
    MIN_TERMINAL_DIMENSION,
    Math.min(STREAM_MAX_TERMINAL_DIMENSION, Math.trunc(value)),
  );
}

function normalizedResponseBudget(value: number | undefined): number {
  return boundedNumber(
    value,
    1,
    MAX_TERMINAL_RESPONSE_BUDGET_BYTES,
    DEFAULT_TERMINAL_RESPONSE_BUDGET_BYTES,
  );
}

function boundedNumber(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function boundedText(value: string): string {
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength <= MAX_EXPLICIT_TEXT_BYTES) return value;
  return textDecoder.decode(bytes.subarray(0, MAX_EXPLICIT_TEXT_BYTES));
}

/**
 * ghostty-web 0.4.0's SelectionManager copies directly through
 * navigator.clipboard on mouseup and double-click. That bypasses DOM copy
 * event mediation, so neutralize the exact pinned internal seam while keeping
 * selection itself available to the parent-owned explicit Copy action. Fail
 * closed if a package update changes the reviewed shape.
 */
function disablePinnedGhosttyAutoCopy(terminal: Terminal): void {
  const selectionManager = (
    terminal as unknown as {
      selectionManager?: {
        copyToClipboard?: unknown;
      };
    }
  ).selectionManager;

  if (!selectionManager || typeof selectionManager.copyToClipboard !== "function") {
    throw new Error("Unsupported Ghostty selection manager; automatic copy was not disabled");
  }

  Object.defineProperty(selectionManager, "copyToClipboard", {
    configurable: false,
    enumerable: false,
    value: () => Promise.resolve(),
    writable: false,
  });
}
