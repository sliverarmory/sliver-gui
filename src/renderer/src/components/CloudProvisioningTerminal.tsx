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

export function CloudProvisioningTerminal({
  api,
  deploymentId,
  transcript,
}: {
  readonly api: CloudDeploymentAPI;
  readonly deploymentId: string;
  readonly transcript: CloudProvisioningTranscript | undefined;
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
    <section aria-label="SSH provisioning output" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">SSH Provisioning Output</h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Read-only stdout from the secure provisioning session.
          </p>
        </div>
        <span className="text-xs text-muted">
          {transcript?.status === "failed"
            ? "Session failed"
            : transcript?.status === "complete"
              ? "Complete"
              : transcript?.chunks.length
                ? "Live"
                : "Waiting for SSH"}
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
          ariaLabel={`Read-only SSH provisioning output for ${deploymentId}`}
          className="h-64 min-h-64 w-full overflow-hidden rounded-xl border border-default bg-black"
          disableInput
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
  #lastSequence = -1;
  #history: Array<{ readonly sequence: number; readonly bytes: Uint8Array }> = [];
  #closeReason: string | undefined;

  send(_bytes: Uint8Array, _source: GhosttyTerminalInputSource): void {
    // The deployment terminal is deliberately output-only.
  }

  resize(_cols: number, _rows: number): void {
    // Provisioning commands are non-interactive and do not need a remote PTY.
  }

  subscribe(subscription: GhosttyTerminalTransportSubscription): () => void {
    for (const { bytes } of this.#history) subscription.onOutput(Uint8Array.from(bytes));
    this.#lastSequence = this.#history.at(-1)?.sequence ?? this.#lastSequence;
    if (this.#closeReason) {
      subscription.onClose(this.#closeReason);
      return () => undefined;
    }
    this.#subscription = subscription;
    return () => {
      if (this.#subscription === subscription) this.#subscription = undefined;
    };
  }

  update(transcript: CloudProvisioningTranscript | undefined): void {
    if (!transcript || this.#closeReason) return;
    if (this.#subscription) {
      for (const chunk of transcript.chunks) {
        if (chunk.sequence <= this.#lastSequence) continue;
        this.#lastSequence = chunk.sequence;
        this.#subscription.onOutput(Uint8Array.from(chunk.bytes));
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
      this.#subscription?.onClose(this.#closeReason);
      this.#subscription = undefined;
    }
  }
}

async function loadCloudTerminalRuntime(api: CloudDeploymentAPI): Promise<TerminalRuntimeAsset> {
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
