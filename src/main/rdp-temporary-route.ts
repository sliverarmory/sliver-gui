import type { SliverClientAdapter } from "./sliver-client-adapter.js";

/** Main-only ownership of one loopback listener. Never expose this handle over IPC. */
export interface RdpTemporaryRoute {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
  isActive(): boolean;
}

export async function createRdpTemporaryRoute(
  client: Pick<SliverClientAdapter, "startPortForward">,
  sessionId: string,
  assertCurrent: () => void,
): Promise<RdpTemporaryRoute> {
  assertCurrent();
  const forward = await client.startPortForward(sessionId, {
    bind: { host: "127.0.0.1", port: 0 },
    target: { host: "127.0.0.1", port: 3389 },
    keepAliveSeconds: 30,
    connectTimeoutSeconds: 30,
    closeTimeoutSeconds: 5,
    maxConnections: 4,
    maxBufferedBytesPerConnection: 512 * 1024,
  }, { timeoutSeconds: 30 });
  try {
    assertCurrent();
    if (forward.sessionId !== sessionId || forward.bind.host !== "127.0.0.1" ||
      !Number.isInteger(forward.bind.port) || forward.bind.port < 1 || forward.bind.port > 65535 ||
      forward.target.host !== "127.0.0.1" || forward.target.port !== 3389 || forward.state.status !== "listening") {
      throw new Error("The temporary RDP route did not open a loopback listener");
    }
  } catch (error) {
    await forward.close();
    throw error;
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  return Object.freeze({
    host: "127.0.0.1",
    port: forward.bind.port,
    close(): Promise<void> {
      closed = true;
      // Close the captured handle even after its source window changes backend.
      return closing ??= Promise.resolve().then(() => forward.close());
    },
    isActive(): boolean {
      if (closed || forward.state.status !== "listening") return false;
      try { assertCurrent(); return true; } catch { return false; }
    },
  });
}
