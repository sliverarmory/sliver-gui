import {
  RDP_PORT_MESSAGE,
  RDP_PROTOCOL_VERSION,
  type RdpHostMessage,
  type RdpViewerMessage,
  type RdpWindowAPI,
} from "../../../../shared/rdp-contracts";

/** A port belongs to one attempt; no global stream or raw IPC is exposed. */
export class RdpTransport {
  readonly #port: MessagePort;
  #closed = false;

  private constructor(port: MessagePort, onMessage: (message: RdpHostMessage) => void, onError: (message: string) => void) {
    this.#port = port;
    port.onmessage = (event: MessageEvent<unknown>): void => {
      if (this.#closed) return;
      if (!isRecord(event.data) || typeof event.data["type"] !== "string") {
        onError("The remote desktop sent an invalid display message.");
        this.close();
        return;
      }
      try {
        onMessage(event.data as unknown as RdpHostMessage);
      } catch {
        onError("The remote desktop display stream is invalid. Reattach the viewer to recover.");
        this.close();
      }
    };
    port.onmessageerror = (): void => {
      onError("The remote desktop display stream could not be read.");
      this.close();
    };
    port.start();
  }

  static async open(
    api: RdpWindowAPI,
    tabId: string,
    attempt: number,
    signal: AbortSignal,
    onMessage: (message: RdpHostMessage) => void,
    onError: (message: string) => void,
  ): Promise<RdpTransport> {
    signal.throwIfAborted();
    const result = await api.attach(tabId);
    signal.throwIfAborted();
    if (!result.ok) throw new Error(result.error);
    if (result.value.tabId !== tabId || result.value.attempt !== attempt) throw new Error("This remote desktop connection has changed. Reattach its viewer.");
    const correlationId = crypto.randomUUID();
    return await new Promise<RdpTransport>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timeout);
        window.removeEventListener("message", accept);
        signal.removeEventListener("abort", abort);
      };
      const abort = (): void => { cleanup(); reject(new DOMException("Viewer attachment cancelled", "AbortError")); };
      const accept = (event: MessageEvent<unknown>): void => {
        if (event.source !== window || !isRecord(event.data) || event.data["type"] !== RDP_PORT_MESSAGE ||
          event.data["correlationId"] !== correlationId) return;
        cleanup();
        if (event.ports.length !== 1 || !event.ports[0]) {
          for (const port of event.ports) port.close();
          reject(new Error("The remote desktop attachment is invalid."));
          return;
        }
        if (signal.aborted) { event.ports[0].close(); reject(new DOMException("Viewer attachment cancelled", "AbortError")); return; }
        resolve(new RdpTransport(event.ports[0], onMessage, onError));
      };
      const timeout = setTimeout(() => { cleanup(); reject(new Error("The remote desktop viewer could not attach. Try again.")); }, 10_000);
      window.addEventListener("message", accept);
      signal.addEventListener("abort", abort, { once: true });
      try { api.openRdpStream(result.value.attachmentToken, correlationId); }
      catch (error) { cleanup(); reject(error); }
    });
  }

  send(message: RdpViewerMessage): void {
    if (this.#closed) return;
    this.#port.postMessage(message);
  }

  close(): void {
    if (this.#closed) return;
    try { this.#port.postMessage({ type: "releaseAll" } satisfies RdpViewerMessage); } catch { /* A detached port is already revoked. */ }
    this.#closed = true;
    this.#port.onmessage = null;
    this.#port.onmessageerror = null;
    this.#port.close();
  }
}

export function isRdpReady(value: RdpHostMessage): boolean {
  return value.type === "ready" && value.protocol === RDP_PROTOCOL_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
