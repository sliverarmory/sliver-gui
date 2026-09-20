import { useEffect, useMemo, useState } from "react";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../../shared/application-settings-contracts";
import { escapeScriptOutput, SCRIPT_LIMITS, type ScriptConsoleRecord } from "../../../shared/script-runtime-protocol";
import type { TerminalRuntimeAsset } from "../../../shared/stream-contracts";
import { useApplicationSettings } from "./ApplicationSettingsProvider";
import { applicationTerminalAppearance } from "./application-terminal-appearance";
import { GhosttyTerminal, type GhosttyTerminalTransport, type GhosttyTerminalTransportSubscription } from "./GhosttyTerminal";

export function scriptOutputText(records: readonly ScriptConsoleRecord[]): string {
  return records.map((record) => escapeScriptOutput(record.text) + "\n").join("");
}

export function ScriptOutputTerminal({ records, resetKey, className, onReady }: {
  records: readonly ScriptConsoleRecord[];
  resetKey: string | number;
  className?: string;
  onReady?: () => void;
}): React.JSX.Element {
  const settings = useApplicationSettings();
  const [runtime, setRuntime] = useState<TerminalRuntimeAsset>();
  const [error, setError] = useState<string>();
  const transport = useMemo(() => new ScriptOutputTransport(), [resetKey]);
  const appearance = useMemo(() => ({
    ...applicationTerminalAppearance(
      settings?.settings.terminal ?? DEFAULT_APPLICATION_SETTINGS_STATE.terminal,
      settings?.resolvedTheme ?? "dark", settings?.settings.reduceMotion ?? true,
    ),
    cursorBlink: false,
    scrollback: 5_000,
  }), [settings]);

  useEffect(() => {
    let active = true;
    void window.sliver.getTerminalRuntime().then((result) => {
      if (!active) return;
      if (!result.ok || !result.value) throw new Error(result.error ?? "Terminal runtime unavailable");
      setRuntime(result.value);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Terminal runtime unavailable");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => { transport.update(records); }, [records, transport]);

  return (
    <div className={`relative h-full min-h-0 ${className ?? ""}`}>
      {error ? <p role="alert" className="p-4 text-sm text-danger">{error}</p> : runtime ? (
        <GhosttyTerminal
          key={resetKey} ariaLabel="Script output terminal" disableInput enableClipboard
          transport={transport} wasmBytes={runtime.bytes} appearance={appearance}
          className="h-full min-h-0 w-full overflow-hidden"
          onReady={() => { transport.ready(); onReady?.(); }}
          onError={(reason) => setError(reason.message)}
        />
      ) : <p role="status" className="p-4 text-sm text-muted">Loading output terminal…</p>}
      <pre className="sr-only" aria-label="Script output transcript">{scriptOutputText(records)}</pre>
    </div>
  );
}

/** A local output transport. Input and terminal responses have no destination. */
export class ScriptOutputTransport implements GhosttyTerminalTransport {
  private subscription: GhosttyTerminalTransportSubscription | undefined;
  private records: readonly ScriptConsoleRecord[] = [];
  private lastSequence = -1;
  private initialized = false;
  private bytes = 0;

  send(): void {}
  resize(): void {}
  subscribe(subscription: GhosttyTerminalTransportSubscription): () => void {
    // Ghostty recreates its emulator when the theme changes. Replay the bounded
    // transcript into each new emulator instead of retaining its old cursor.
    this.lastSequence = -1;
    this.bytes = 0;
    this.initialized = false;
    this.subscription = subscription;
    return () => { if (this.subscription === subscription) this.subscription = undefined; };
  }
  ready(): void { this.initialized = true; this.flush(); }
  update(records: readonly ScriptConsoleRecord[]): void {
    this.records = records.slice(0, SCRIPT_LIMITS.outputRecords);
    this.flush();
  }
  private flush(): void {
    if (!this.initialized || !this.subscription) return;
    for (const record of this.records) {
      if (record.sequence <= this.lastSequence) continue;
      const text = escapeScriptOutput(record.text).slice(0, SCRIPT_LIMITS.recordBytes);
      const color = record.level === "error" ? "\x1b[31m" : record.level === "warn" ? "\x1b[33m" : record.level === "debug" ? "\x1b[90m" : "";
      const encoded = new TextEncoder().encode(color + text.replace(/\n/gu, "\r\n") + "\x1b[0m\r\n");
      // Includes trusted color/newline overhead, with a fixed total ceiling.
      if (this.bytes + encoded.byteLength > SCRIPT_LIMITS.outputBytes * 2) break;
      this.bytes += encoded.byteLength;
      this.lastSequence = record.sequence;
      this.subscription.onOutput(encoded);
    }
  }
}
