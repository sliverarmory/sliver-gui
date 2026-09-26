import { useEffect, useMemo, useState } from "react";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../../shared/application-settings-contracts";
import { escapeScriptOutput } from "../../../shared/script-runtime-protocol";
import type { TerminalRuntimeAsset } from "../../../shared/stream-contracts";
import { useApplicationSettings } from "./ApplicationSettingsProvider";
import { applicationTerminalAppearance } from "./application-terminal-appearance";
import {
  GhosttyTerminal,
  type GhosttyTerminalInputSource,
  type GhosttyTerminalTransport,
  type GhosttyTerminalTransportSubscription,
} from "./GhosttyTerminal";

// Main bounds each process output stream to 1 MiB. Leave room for stdout and
// stderr together while protecting the renderer from an unexpectedly large prop.
const MAX_DISPLAY_BYTES = 2 * 1_024 * 1_024;
const OUTPUT_CHUNK_BYTES = 64 * 1_024;
const ACCESSIBLE_TRANSCRIPT_BYTES = 64 * 1_024;
const RESET_TERMINAL = Uint8Array.of(0x1b, 0x63);

export interface ExecutionOutputTerminalProps {
  readonly bytes: Uint8Array;
  readonly resetKey: string | number;
  readonly className?: string;
}

export function ExecutionOutputTerminal({
  bytes,
  resetKey,
  className,
}: ExecutionOutputTerminalProps): React.JSX.Element {
  const settings = useApplicationSettings();
  const [runtime, setRuntime] = useState<TerminalRuntimeAsset>();
  const [error, setError] = useState<string>();
  const transport = useMemo(() => new ExecutionOutputTransport(), [resetKey]);
  const appearance = useMemo(() => ({
    ...applicationTerminalAppearance(
      settings?.settings.terminal ?? DEFAULT_APPLICATION_SETTINGS_STATE.terminal,
      settings?.resolvedTheme ?? "dark",
      settings?.settings.reduceMotion ?? true,
    ),
    cursorBlink: false,
    scrollback: 50_000,
  }), [settings]);
  const transcript = useMemo(() => {
    const prefix = bytes.subarray(0, ACCESSIBLE_TRANSCRIPT_BYTES);
    const text = escapeScriptOutput(new TextDecoder().decode(prefix));
    return bytes.byteLength > ACCESSIBLE_TRANSCRIPT_BYTES
      ? `${text}\n[Accessible transcript limited to the first 64 KiB.]`
      : text;
  }, [bytes]);

  useEffect(() => {
    let active = true;
    void window.sliver.getTerminalRuntime().then((result) => {
      if (!active) return;
      if (!result.ok || !result.value) {
        throw new Error(result.error ?? "Terminal runtime unavailable");
      }
      setRuntime(result.value);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Terminal runtime unavailable");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => { transport.update(bytes); }, [bytes, transport]);
  useEffect(() => () => transport.clear(), [transport]);

  return (
    <div className={["relative flex h-full min-h-0 flex-col", className].filter(Boolean).join(" ")}>
      {bytes.byteLength > MAX_DISPLAY_BYTES ? (
        <p className="mb-2 text-xs text-warning" role="note">
          Terminal display is limited to the first 2 MiB of output.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="p-4 text-sm text-danger">{error}</p>
      ) : runtime ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <GhosttyTerminal
            key={resetKey}
            appearance={appearance}
            ariaLabel="Execution output terminal"
            className="min-h-0 flex-1 w-full overflow-hidden rounded-lg border border-default"
            disableInput
            enableClipboard
            onError={(reason) => setError(reason.message)}
            onReady={() => transport.ready()}
            transport={transport}
            wasmBytes={runtime.bytes}
          />
        </div>
      ) : (
        <p role="status" className="p-4 text-sm text-muted">Loading output terminal…</p>
      )}
      <pre className="sr-only" aria-label="Execution output transcript">{transcript}</pre>
    </div>
  );
}

/** A local output-only transport that replays bounded history after each mount. */
export class ExecutionOutputTransport implements GhosttyTerminalTransport {
  private subscription: GhosttyTerminalTransportSubscription | undefined;
  private output = new Uint8Array();
  private emittedBytes = 0;
  private lastOriginalByte: number | undefined;
  private initialized = false;

  send(_bytes: Uint8Array, _source: GhosttyTerminalInputSource): void {}
  resize(_cols: number, _rows: number): void {}

  subscribe(subscription: GhosttyTerminalTransportSubscription): () => void {
    this.subscription = subscription;
    this.emittedBytes = 0;
    this.lastOriginalByte = undefined;
    this.initialized = false;
    return () => {
      if (this.subscription === subscription) this.subscription = undefined;
    };
  }

  ready(): void {
    this.initialized = true;
    this.flush();
  }

  update(bytes: Uint8Array): void {
    const next = Uint8Array.from(bytes.subarray(0, MAX_DISPLAY_BYTES));
    const changedPrefix = !samePrefix(this.output, next);
    this.output.fill(0);
    this.output = next;
    if (changedPrefix && this.initialized && this.subscription && this.emittedBytes > 0) {
      this.subscription.onOutput(Uint8Array.from(RESET_TERMINAL));
      this.emittedBytes = 0;
      this.lastOriginalByte = undefined;
    }
    this.flush();
  }

  clear(): void {
    this.output.fill(0);
    this.output = new Uint8Array();
    this.emittedBytes = 0;
    this.lastOriginalByte = undefined;
    this.initialized = false;
  }

  private flush(): void {
    if (!this.initialized || !this.subscription || this.emittedBytes >= this.output.byteLength) return;
    // A VT terminal's LF moves down without returning to column zero. Normalize
    // bare LF for display, including when an existing CRLF spans two updates.
    let chunk = new Uint8Array(OUTPUT_CHUNK_BYTES);
    let chunkBytes = 0;
    const emitChunk = (): void => {
      if (chunkBytes === 0) return;
      this.subscription?.onOutput(chunk.slice(0, chunkBytes));
      chunk = new Uint8Array(OUTPUT_CHUNK_BYTES);
      chunkBytes = 0;
    };
    while (this.emittedBytes < this.output.byteLength) {
      const byte = this.output[this.emittedBytes++]!;
      const bareLineFeed = byte === 0x0a && this.lastOriginalByte !== 0x0d;
      if (chunkBytes + (bareLineFeed ? 2 : 1) > chunk.byteLength) emitChunk();
      if (bareLineFeed) chunk[chunkBytes++] = 0x0d;
      chunk[chunkBytes++] = byte;
      this.lastOriginalByte = byte;
    }
    emitChunk();
  }
}

function samePrefix(previous: Uint8Array, next: Uint8Array): boolean {
  if (next.byteLength < previous.byteLength) return false;
  for (let index = 0; index < previous.byteLength; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}
