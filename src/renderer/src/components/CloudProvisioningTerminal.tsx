import { useEffect, useRef, useState } from "react";

import type {
  CloudDeploymentAPI,
  CloudProvisioningTranscript,
} from "../../../shared/cloud-deployment-ipc";
import type { TerminalRuntimeAsset } from "../../../shared/stream-contracts";
import {
  GhosttyTerminal,
  type GhosttyTerminalAppearance,
  type GhosttyTerminalInputSource,
  type GhosttyTerminalTransport,
  type GhosttyTerminalTransportSubscription,
} from "./GhosttyTerminal";

let cachedCloudTerminalRuntime: TerminalRuntimeAsset | undefined;
let pendingCloudTerminalRuntime: Promise<TerminalRuntimeAsset> | undefined;
type TerminalRuntimeAPI = Pick<CloudDeploymentAPI, "getTerminalRuntime">;
const CLOUD_PROVISIONING_TERMINAL_APPEARANCE = Object.freeze({
  cursorBlink: false,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: 12,
  scrollback: 5_000,
  theme: Object.freeze({
    background: "#09090b",
    foreground: "#e4e4e7",
    cursor: "#71717a",
    selectionBackground: "#27272a",
  }),
}) satisfies GhosttyTerminalAppearance;

export interface CloudProvisioningTerminalLabels {
  readonly sectionAriaLabel?: string;
  readonly title?: string;
  readonly description?: string;
  readonly terminalAriaLabel?: string;
  readonly waiting?: string;
  readonly live?: string;
  readonly complete?: string;
  readonly failed?: string;
}

export function CloudProvisioningTerminal({
  api,
  deploymentId,
  transcript,
  labels,
}: {
  readonly api: TerminalRuntimeAPI;
  readonly deploymentId: string;
  readonly transcript: CloudProvisioningTranscript | undefined;
  readonly labels?: CloudProvisioningTerminalLabels;
}): React.JSX.Element {
  const transportRef = useRef<ReadonlyProvisioningTransport | undefined>(undefined);
  if (!transportRef.current) transportRef.current = new ReadonlyProvisioningTransport();
  const transport = transportRef.current;
  const [runtime, setRuntime] = useState<TerminalRuntimeAsset | undefined>(cachedCloudTerminalRuntime);
  const [runtimeError, setRuntimeError] = useState<string | undefined>();

  useEffect(() => {
    transport.update(transcript);
  }, [transcript, transport]);

  useEffect(() => {
    let active = true;
    if (runtime) return () => { active = false; };
    void loadCloudTerminalRuntime(api).then((loaded) => {
      if (active) setRuntime(loaded);
    }).catch((error: unknown) => {
      if (active) setRuntimeError(error instanceof Error ? error.message : "Terminal runtime is unavailable");
    });
    return () => { active = false; };
  }, [api, runtime]);

  return (
    <section aria-label={labels?.sectionAriaLabel ?? "SSH provisioning output"} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{labels?.title ?? "SSH Provisioning Output"}</h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            {labels?.description ?? "Read-only stdout from the secure provisioning session."}
          </p>
        </div>
        <span className="text-xs text-muted">
          {transcript?.status === "failed"
            ? labels?.failed ?? "Session failed"
            : transcript?.status === "complete"
              ? labels?.complete ?? "Complete"
              : transcript?.chunks.length
                ? labels?.live ?? "Live"
                : labels?.waiting ?? "Waiting for SSH"}
        </span>
      </div>
      {transcript?.truncated ? (
        <p className="text-xs text-warning">Earlier output was removed from this bounded in-memory transcript.</p>
      ) : null}
      {runtimeError ? (
        <div className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground" role="alert">
          {runtimeError}
        </div>
      ) : runtime ? (
        <GhosttyTerminal
          key={deploymentId}
          appearance={CLOUD_PROVISIONING_TERMINAL_APPEARANCE}
          ariaLabel={labels?.terminalAriaLabel ?? `Read-only SSH provisioning output for ${deploymentId}`}
          className="h-64 min-h-64 w-full overflow-hidden rounded-xl border border-default bg-black"
          disableInput
          onReady={() => transport.ready()}
          transport={transport}
          wasmBytes={runtime.bytes}
        />
      ) : (
        <div aria-label="Loading SSH terminal" className="grid h-64 place-items-center rounded-xl border border-default bg-black text-xs text-zinc-400">
          Loading terminal…
        </div>
      )}
    </section>
  );
}

export class ReadonlyProvisioningTransport implements GhosttyTerminalTransport {
  #subscription: GhosttyTerminalTransportSubscription | undefined;
  #ready = false;
  #lastSequence = -1;
  #lastOriginalByte: number | undefined;
  #history: Array<{ readonly sequence: number; readonly bytes: Uint8Array }> = [];
  #closeReason: string | undefined;

  send(_bytes: Uint8Array, _source: GhosttyTerminalInputSource): void {
    // The deployment terminal is deliberately output-only.
  }

  resize(_cols: number, _rows: number): void {
    // Provisioning commands are non-interactive and do not need a remote PTY.
  }

  subscribe(subscription: GhosttyTerminalTransportSubscription): () => void {
    this.#subscription = subscription;
    this.#ready = false;
    this.#lastSequence = -1;
    this.#lastOriginalByte = undefined;
    return () => {
      if (this.#subscription === subscription) this.#subscription = undefined;
    };
  }

  ready(): void {
    if (!this.#subscription || this.#ready) return;
    this.#ready = true;
    for (const { sequence, bytes } of this.#history) {
      this.#lastSequence = sequence;
      this.#subscription.onOutput(this.#displayBytes(bytes));
    }
    if (this.#closeReason) {
      this.#subscription.onClose(this.#closeReason);
      this.#subscription = undefined;
    }
  }

  update(transcript: CloudProvisioningTranscript | undefined): void {
    if (!transcript || this.#closeReason) return;
    if (this.#ready && this.#subscription) {
      for (const chunk of transcript.chunks) {
        if (chunk.sequence <= this.#lastSequence) continue;
        this.#lastSequence = chunk.sequence;
        this.#subscription.onOutput(this.#displayBytes(chunk.bytes));
      }
    }
    for (const { bytes } of this.#history) bytes.fill(0);
    this.#history = transcript.chunks.map(({ sequence, bytes }) => ({
      sequence,
      bytes: Uint8Array.from(bytes),
    }));
    if (transcript.status !== "streaming") {
      this.#closeReason = transcript.status === "failed"
        ? "SSH provisioning failed"
        : "SSH provisioning complete";
      if (this.#ready && this.#subscription) {
        this.#subscription.onClose(this.#closeReason);
        this.#subscription = undefined;
      }
    }
  }

  #displayBytes(bytes: Uint8Array): Uint8Array {
    // A VT terminal's LF advances a row without returning to column zero.
    // SSH exec stdout is not a PTY stream, so normalize bare LF only for this
    // display. Keep the original byte across chunks to preserve split CRLF.
    const lastOriginalByte = this.#lastOriginalByte;
    let previous = lastOriginalByte;
    let bareLineFeeds = 0;
    for (const byte of bytes) {
      if (byte === 0x0a && previous !== 0x0d) bareLineFeeds += 1;
      previous = byte;
    }
    const display = new Uint8Array(bytes.byteLength + bareLineFeeds);
    previous = lastOriginalByte;
    let offset = 0;
    for (const byte of bytes) {
      if (byte === 0x0a && previous !== 0x0d) display[offset++] = 0x0d;
      display[offset++] = byte;
      previous = byte;
    }
    this.#lastOriginalByte = previous;
    return display;
  }
}

async function loadCloudTerminalRuntime(api: TerminalRuntimeAPI): Promise<TerminalRuntimeAsset> {
  if (cachedCloudTerminalRuntime) return cachedCloudTerminalRuntime;
  if (pendingCloudTerminalRuntime) return pendingCloudTerminalRuntime;
  const request = api.getTerminalRuntime()
    .then((result) => {
      if (!result.ok || !result.value) throw new Error(result.error ?? "Terminal runtime is unavailable");
      const bytes = Uint8Array.from(result.value.bytes);
      cachedCloudTerminalRuntime = Object.freeze({
        version: result.value.version,
        sha256: result.value.sha256,
        bytes,
      });
      return cachedCloudTerminalRuntime;
    })
    .catch((error: unknown) => {
      cachedCloudTerminalRuntime = undefined;
      throw error;
    })
    .finally(() => {
      if (pendingCloudTerminalRuntime === request) pendingCloudTerminalRuntime = undefined;
    });
  pendingCloudTerminalRuntime = request;
  return request;
}
