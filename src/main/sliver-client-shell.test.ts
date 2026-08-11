// @vitest-environment node

import {
  SHELL_GRACEFUL_CLOSE_TIMEOUT_MILLISECONDS,
  SHELL_OUTPUT_BUFFER_MAX_BYTES,
  SliverClient,
  TUNNEL_STREAM_MAX_PAYLOAD_BYTES,
  type SliverClientConfig,
} from "sliver-script";
import type { DeepPartial } from "../../vendor/sliver-script/lib/pb/rpcpb/services.js";
import type { TunnelData } from "../../vendor/sliver-script/lib/pb/sliverpb/sliver.js";
import {
  TUNNEL_MANAGER_MAX_ACTIVE_TUNNELS,
  TUNNEL_MANAGER_MAX_QUEUED_FRAMES_PER_TUNNEL,
  TunnelManager,
} from "../../vendor/sliver-script/lib/internal/tunnelManager.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const activeHarnesses = new Set<TunnelHarness>();

afterEach(async () => {
  await Promise.all([...activeHarnesses].map((harness) => harness.stop()));
});

describe("bounded Sliver session shell wrapper", () => {
  it("registers early output before the exact bind and shell sequence", async () => {
    const order: string[] = [];
    const harness = new TunnelHarness(true, (message) => {
      if (message.Data?.length === 0) order.push("bind");
    });
    const createTunnel = vi.fn(async () => {
      order.push("create");
      return { TunnelID: "tunnel-early", SessionID: "session-42" };
    });
    const shell = vi.fn(async () => {
      order.push("shell");
      harness.incoming.push(tunnelMessage("tunnel-early", "session-42", Buffer.from("ready> ")));
      return shellResponse("tunnel-early", "/bin/zsh", 4242, true);
    });
    const closeTunnel = vi.fn(async () => ({}));
    const client = clientWithShellRpc(harness.manager, { createTunnel, shell, closeTunnel });

    const handle = await client.startShellSession("session-42", {
      path: "/bin/zsh",
      pty: true,
      rows: 32,
      cols: 120,
      outputBufferBytes: SHELL_OUTPUT_BUFFER_MAX_BYTES * 10,
    }, 0);

    expect(order).toEqual(["create", "bind", "shell"]);
    expect(createTunnel).toHaveBeenCalledWith(
      { SessionID: "session-42" },
      { signal: expect.any(AbortSignal) },
    );
    expect(harness.outbound[0]).toEqual({
      TunnelID: "tunnel-early",
      SessionID: "session-42",
      Data: Buffer.alloc(0),
    });
    expect(shell).toHaveBeenCalledWith(
      {
        Path: "/bin/zsh",
        EnablePTY: true,
        Pid: 0,
        Rows: 32,
        Cols: 120,
        TunnelID: "tunnel-early",
        Request: {
          Async: false,
          Timeout: "0",
          BeaconID: "",
          SessionID: "session-42",
        },
      },
      { signal: expect.any(AbortSignal) },
    );
    await expect(handle.output[Symbol.asyncIterator]().next()).resolves.toEqual({
      value: Uint8Array.from(Buffer.from("ready> ")),
      done: false,
    });
    expect(handle).toMatchObject({
      id: "tunnel-early",
      pid: 4242,
      path: "/bin/zsh",
      ptyRequested: true,
    });

    await handle.close();
  });

  it.each([
    ["target rejection", async () => shellResponse(
      "tunnel-failure",
      "/bin/sh",
      0,
      true,
      "TOP-SECRET-TARGET-DETAIL",
    )],
    ["RPC rejection", async () => {
      throw new Error("TOP-SECRET-RPC-DETAIL");
    }],
  ])("cleans up every partial tunnel after %s without reflecting remote errors", async (_label, shellImpl) => {
    const harness = new TunnelHarness();
    const closeTunnel = vi.fn(async () => ({}));
    const client = clientWithShellRpc(harness.manager, {
      createTunnel: vi.fn(async () => ({ TunnelID: "tunnel-failure", SessionID: "session-failure" })),
      shell: vi.fn(shellImpl),
      closeTunnel,
    });

    const start = client.startShellSession("session-failure", {
      path: "/bin/sh",
      pty: true,
      rows: 24,
      cols: 80,
    }, 0);
    await expect(start).rejects.toThrow("Unable to start shell session");
    await expect(start).rejects.not.toThrow(/TOP-SECRET/u);

    expect(closeTunnel).toHaveBeenCalledOnce();
    expect(closeTunnel).toHaveBeenCalledWith(
      { TunnelID: "tunnel-failure", SessionID: "session-failure" },
      { signal: expect.any(AbortSignal) },
    );
    expect(harness.outbound.filter((message) => (message.Data?.length ?? 0) > 0).map((message) =>
      Buffer.from(message.Data!).toString("utf8"))).toEqual(["exit\n", "logout\n"]);
    expect(harness.manager.stats()).toEqual({ activeTunnels: 0, queuedFrames: 0, queuedBytes: 0 });
  });

  it.each([0, 1, 0x8000_0000])("rejects unsafe shell PID %i before minting a managed handle", async (pid) => {
    const harness = new TunnelHarness();
    const closeTunnel = vi.fn(async () => ({}));
    const client = clientWithShellRpc(harness.manager, {
      createTunnel: vi.fn(async () => ({ TunnelID: `unsafe-pid-${pid}`, SessionID: "session-unsafe" })),
      shell: vi.fn(async () => shellResponse(`unsafe-pid-${pid}`, "/bin/sh", pid, true)),
      closeTunnel,
    });

    await expect(client.startShellSession("session-unsafe", {
      path: "/bin/sh",
      pty: true,
      rows: 24,
      cols: 80,
    }, 0)).rejects.toThrow("Unable to start shell session");

    expect(closeTunnel).toHaveBeenCalledOnce();
    expect(harness.outbound.filter((message) => (message.Data?.length ?? 0) > 0).map((message) =>
      Buffer.from(message.Data!).toString("utf8"))).toEqual(["exit\n", "logout\n"]);
    expect(harness.manager.stats()).toEqual({ activeTunnels: 0, queuedFrames: 0, queuedBytes: 0 });
  });

  it("serializes and chunks immutable input, gates resize, and closes idempotently", async () => {
    const closeOrder: string[] = [];
    const harness = new TunnelHarness(true, (message) => {
      const data = Buffer.from(message.Data ?? []).toString("utf8");
      if (data) closeOrder.push(`write:${data}`);
    });
    const shellResize = vi.fn(async () => ({}));
    const closeTunnel = vi.fn(async () => {
      closeOrder.push("closeTunnel");
      return {};
    });
    const client = clientWithShellRpc(harness.manager, {
      createTunnel: vi.fn(async () => ({ TunnelID: "tunnel-io", SessionID: "session-io" })),
      shell: vi.fn(async () => shellResponse("tunnel-io", "/bin/bash", 101, true)),
      shellResize,
      closeTunnel,
    });
    const handle = await client.startShellSession("session-io", {
      path: "/bin/bash",
      pty: true,
      rows: 40,
      cols: 132,
    }, 0);
    harness.outbound.splice(0, harness.outbound.length);

    const first = Uint8Array.from({ length: (TUNNEL_STREAM_MAX_PAYLOAD_BYTES * 2) + 3 }, (_value, index) => index % 251);
    const expectedFirst = Buffer.from(first);
    const second = Buffer.from("second-write");
    const firstWrite = handle.write(first);
    first.fill(0);
    const secondWrite = handle.write(second);
    second.fill(0);
    await Promise.all([firstWrite, secondWrite]);

    const frames = harness.outbound.filter((message) => (message.Data?.length ?? 0) > 0);
    expect(frames.map((message) => message.Data!.length)).toEqual([
      TUNNEL_STREAM_MAX_PAYLOAD_BYTES,
      TUNNEL_STREAM_MAX_PAYLOAD_BYTES,
      3,
      Buffer.byteLength("second-write"),
    ]);
    expect(Buffer.concat(frames.map((message) => Buffer.from(message.Data!)))).toEqual(
      Buffer.concat([expectedFirst, Buffer.from("second-write")]),
    );

    await handle.resize(52, 160);
    expect(shellResize).toHaveBeenCalledWith(
      {
        Rows: 52,
        Cols: 160,
        TunnelID: "tunnel-io",
        Request: {
          Async: false,
          Timeout: "0",
          BeaconID: "",
          SessionID: "session-io",
        },
      },
      { signal: expect.any(AbortSignal) },
    );

    const firstClose = handle.close();
    const secondClose = handle.close();
    expect(firstClose).toBe(secondClose);
    await Promise.all([firstClose, secondClose]);
    expect(closeOrder.slice(-3)).toEqual(["write:exit\n", "write:logout\n", "closeTunnel"]);
    expect(closeTunnel).toHaveBeenCalledOnce();
    await expect(handle.write("after close")).rejects.toThrow("Shell session is closed");
  });

  it("bounds graceful close before canceling an unconsumed tunnel", async () => {
    vi.useFakeTimers();
    try {
      const harness = new TunnelHarness(false);
      const closeTunnel = vi.fn(async () => ({}));
      const client = clientWithShellRpc(harness.manager, {
        createTunnel: vi.fn(async () => ({ TunnelID: "close-stall", SessionID: "session-close-stall" })),
        shell: vi.fn(async () => shellResponse("close-stall", "/bin/sh", 404, true)),
        closeTunnel,
      });
      const starting = client.startShellSession("session-close-stall", {
        path: "/bin/sh",
        pty: true,
        rows: 24,
        cols: 80,
      }, 0);
      await harness.pullOutgoing();
      const handle = await starting;

      const closing = handle.close();
      await vi.advanceTimersByTimeAsync(SHELL_GRACEFUL_CLOSE_TIMEOUT_MILLISECONDS);
      await closing;

      expect(closeTunnel).toHaveBeenCalledOnce();
      expect(harness.manager.stats()).toEqual({ activeTunnels: 0, queuedFrames: 0, queuedBytes: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let CloseTunnel overtake graceful exit frames before exact remote EOF", async () => {
    const harness = new TunnelHarness(true, undefined, false);
    const closeTunnel = vi.fn(async () => ({}));
    const client = clientWithShellRpc(harness.manager, {
      createTunnel: vi.fn(async () => ({ TunnelID: "close-eof", SessionID: "session-close-eof" })),
      shell: vi.fn(async () => shellResponse("close-eof", "/bin/sh", 505, true)),
      closeTunnel,
    });
    const handle = await client.startShellSession("session-close-eof", {
      path: "/bin/sh",
      pty: true,
      rows: 24,
      cols: 80,
    }, 0);
    harness.outbound.splice(0, harness.outbound.length);

    const closing = handle.close();
    await waitFor(() => harness.outbound.filter((message) => (message.Data?.length ?? 0) > 0).length === 2);
    expect(closeTunnel).not.toHaveBeenCalled();

    harness.incoming.push(tunnelMessage("close-eof", "session-close-eof", Buffer.alloc(0), true));
    await closing;
    expect(closeTunnel).toHaveBeenCalledOnce();
  });

  it("rejects resize for a non-PTY shell without dispatching ShellResize", async () => {
    const harness = new TunnelHarness();
    const shellResize = vi.fn(async () => ({}));
    const client = clientWithShellRpc(harness.manager, {
      createTunnel: vi.fn(async () => ({ TunnelID: "tunnel-pipe", SessionID: "session-pipe" })),
      shell: vi.fn(async () => shellResponse("tunnel-pipe", "/bin/sh", 202, false)),
      shellResize,
      closeTunnel: vi.fn(async () => ({})),
    });
    const handle = await client.startShellSession("session-pipe", {
      path: "/bin/sh",
      pty: false,
      rows: 24,
      cols: 80,
    }, 0);

    await expect(handle.resize(25, 81)).rejects.toThrow("requires a PTY");
    expect(shellResize).not.toHaveBeenCalled();
    await handle.close();
  });

  it("drains final output and rejects later operations after a target-side close", async () => {
    const harness = new TunnelHarness();
    const closeTunnel = vi.fn(async () => ({}));
    const client = clientWithShellRpc(harness.manager, {
      createTunnel: vi.fn(async () => ({ TunnelID: "target-close", SessionID: "session-close" })),
      shell: vi.fn(async () => shellResponse("target-close", "/bin/sh", 303, true)),
      closeTunnel,
    });
    const handle = await client.startShellSession("session-close", {
      path: "/bin/sh",
      pty: true,
      rows: 24,
      cols: 80,
    }, 0);
    const output = handle.output[Symbol.asyncIterator]();

    harness.incoming.push(tunnelMessage("target-close", "session-close", Buffer.from("bye\n"), true));
    await expect(output.next()).resolves.toEqual({
      value: Uint8Array.from(Buffer.from("bye\n")),
      done: false,
    });
    await expect(output.next()).resolves.toEqual({ value: undefined, done: true });
    await expect(handle.resize(30, 100)).rejects.toThrow("Shell session is closed");
    await handle.close();
    expect(closeTunnel).not.toHaveBeenCalled();
  });

  it.each([
    ["mTLS", baseConfig()],
    ["WireGuard", {
      ...baseConfig(),
      wg: {
        server_pub_key: "server-key",
        client_private_key: "client-key",
        client_ip: "10.0.0.2/32",
      },
    } satisfies SliverClientConfig],
  ])("keeps the shell RPC surface transport-neutral for %s configuration", async (_label, config) => {
    const harness = new TunnelHarness();
    const shell = vi.fn(async () => shellResponse("transport-neutral", "/bin/sh", 303, true));
    const client = clientWithShellRpc(harness.manager, {
      createTunnel: vi.fn(async () => ({ TunnelID: "transport-neutral", SessionID: "session-transport" })),
      shell,
      closeTunnel: vi.fn(async () => ({})),
    }, config);

    const handle = await client.startShellSession("session-transport", {
      path: "/bin/sh",
      pty: true,
      rows: 24,
      cols: 80,
    }, 0);
    expect(shell).toHaveBeenCalledOnce();
    await handle.close();
  });
});

describe("bounded fair tunnel manager", () => {
  it("round-robins queued tunnels and rejects frames beyond per-tunnel caps", async () => {
    const harness = new TunnelHarness(false);
    harness.manager.openOutput("tunnel-a", { maxBufferedBytes: 64 });
    harness.manager.openOutput("tunnel-b", { maxBufferedBytes: 64 });

    const a1 = harness.manager.send(tunnelSend("tunnel-a", "a1"));
    const a2 = harness.manager.send(tunnelSend("tunnel-a", "a2"));
    const b1 = harness.manager.send(tunnelSend("tunnel-b", "b1"));
    const first = await harness.pullOutgoing();
    const second = await harness.pullOutgoing();
    const third = await harness.pullOutgoing();
    await Promise.all([a1, a2, b1]);

    expect([first.TunnelID, second.TunnelID, third.TunnelID]).toEqual([
      "tunnel-a",
      "tunnel-b",
      "tunnel-a",
    ]);

    harness.manager.openOutput("tunnel-cap", { maxBufferedBytes: 64 });
    const pending = Array.from({ length: TUNNEL_MANAGER_MAX_QUEUED_FRAMES_PER_TUNNEL }, (_value, index) =>
      harness.manager.send(tunnelSend("tunnel-cap", String(index))).catch(() => undefined));
    await expect(harness.manager.send(tunnelSend("tunnel-cap", "overflow"))).rejects.toThrow(
      "bounded queue",
    );
    harness.manager.cancelTunnel("tunnel-cap");
    await Promise.all(pending);
  });

  it("caps active tunnels and fails a byte-overflowed output without retaining data", async () => {
    const harness = new TunnelHarness();
    const failure = vi.fn();
    const output = harness.manager.openOutput("overflow", {
      maxBufferedBytes: 3,
      onFailure: failure,
    });
    harness.incoming.push(tunnelMessage("overflow", "session", Buffer.from("ab")));
    harness.incoming.push(tunnelMessage("overflow", "session", Buffer.from("cd")));
    await waitFor(() => failure.mock.calls.length === 1);

    await expect(output[Symbol.asyncIterator]().next()).rejects.toThrow("bounded buffer");
    expect(failure).toHaveBeenCalledWith("overflow");
    expect(harness.manager.stats()).toEqual({ activeTunnels: 0, queuedFrames: 0, queuedBytes: 0 });

    for (let index = 0; index < TUNNEL_MANAGER_MAX_ACTIVE_TUNNELS; index += 1) {
      harness.manager.openOutput(`capacity-${index}`, { maxBufferedBytes: 1 });
    }
    expect(() => harness.manager.openOutput("one-too-many", { maxBufferedBytes: 1 })).toThrow(
      "capacity is exhausted",
    );
  });
});

class TunnelHarness {
  readonly manager = new TunnelManager();
  readonly incoming = new PushAsyncIterable<TunnelData>();
  readonly outbound: Array<DeepPartial<TunnelData>> = [];

  private outgoingIterator: AsyncIterator<DeepPartial<TunnelData>> | null = null;
  private stopped = false;

  constructor(
    autoConsume = true,
    private readonly onOutbound?: (message: DeepPartial<TunnelData>) => void,
    private readonly echoRemoteClose = true,
  ) {
    activeHarnesses.add(this);
    this.manager.start({
      tunnelData: (outgoing: AsyncIterable<DeepPartial<TunnelData>>, options: { signal: AbortSignal }) => {
        this.outgoingIterator = outgoing[Symbol.asyncIterator]();
        options.signal.addEventListener("abort", () => this.incoming.close(), { once: true });
        if (autoConsume) void this.consumeOutgoing();
        return this.incoming;
      },
    } as never);
  }

  async pullOutgoing(): Promise<DeepPartial<TunnelData>> {
    if (!this.outgoingIterator) throw new Error("Missing tunnel request iterator");
    const result = await this.outgoingIterator.next();
    if (result.done) throw new Error("Tunnel request iterator ended unexpectedly");
    return result.value;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.incoming.close();
    await this.manager.stop();
    activeHarnesses.delete(this);
  }

  private async consumeOutgoing(): Promise<void> {
    if (!this.outgoingIterator) return;
    for (;;) {
      const result = await this.outgoingIterator.next();
      if (result.done) return;
      const message = result.value.Data
        ? { ...result.value, Data: Buffer.from(result.value.Data) }
        : result.value;
      this.outbound.push(message);
      this.onOutbound?.(message);
      if (this.echoRemoteClose && Buffer.from(message.Data ?? []).toString("utf8") === "logout\n") {
        this.incoming.push(tunnelMessage(
          message.TunnelID ?? "",
          message.SessionID ?? "",
          Buffer.alloc(0),
          true,
        ));
      }
    }
  }
}

class PushAsyncIterable<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value, done: false });
      return;
    }
    this.queue.push(value);
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.queue.shift();
        if (value !== undefined) return { value, done: false };
        if (this.closed) return { value: undefined as never, done: true };
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

function clientWithShellRpc(
  manager: TunnelManager,
  control: Record<string, unknown>,
  config: SliverClientConfig = baseConfig(),
): SliverClient {
  const client = new SliverClient(config);
  const internals = client as unknown as {
    rpcClients: Record<string, unknown>;
    tunnels: TunnelManager;
  };
  internals.rpcClients["control"] = control;
  internals.tunnels = manager;
  return client;
}

function baseConfig(): SliverClientConfig {
  return {
    operator: "test",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "ca",
    certificate: "certificate",
    private_key: "private-key",
    token: "token",
  };
}

function shellResponse(
  tunnelId: string,
  path: string,
  pid: number,
  pty: boolean,
  error = "",
) {
  return {
    Path: path,
    EnablePTY: pty,
    Pid: pid,
    TunnelID: tunnelId,
    Response: error ? { Err: error, Async: false, BeaconID: "", TaskID: "" } : undefined,
  };
}

function tunnelSend(tunnelId: string, data: string): DeepPartial<TunnelData> {
  return { TunnelID: tunnelId, SessionID: "session", Data: Buffer.from(data) };
}

function tunnelMessage(tunnelId: string, sessionId: string, data: Buffer, closed = false): TunnelData {
  return {
    Data: data,
    Closed: closed,
    Sequence: "0",
    Ack: "0",
    Resend: false,
    CreateReverse: false,
    TunnelID: tunnelId,
    SessionID: sessionId,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test condition");
}
