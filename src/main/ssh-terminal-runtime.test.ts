// @vitest-environment node

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import type { Client, ClientChannel, ConnectConfig, PseudoTtyOptions } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";

import {
  SshTerminalRuntime,
  SshTerminalRuntimeError,
  SshTerminalStartError,
  type SshTerminalRuntimeNotice,
} from "./ssh-terminal-runtime.js";

const hostKey = Buffer.from("test ssh host key", "utf8");
const hostKeySha256 = `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/u, "")}`;
const openRuntimes = new Set<SshTerminalRuntime>();

afterEach(async () => {
  await Promise.all([...openRuntimes].map((runtime) => runtime.close()));
  openRuntimes.clear();
});

describe("SshTerminalRuntime secure startup", () => {
  it("probes an unpinned host key without authenticating or opening a shell", async () => {
    const ssh = new FakeSshClient();

    const failure = await captureStartFailure(startUntracked(ssh, { hostKeySha256: undefined }));

    expect(failure).toEqual(new SshTerminalStartError("host-key-approval-required", hostKeySha256));
    expect(ssh.shellCalls).toHaveLength(0);
    expect(ssh.destroyCalls).toBe(1);
    expect(ssh.hostKeyAccepted).toBe(false);
    expect(ssh.connectConfig).not.toHaveProperty("privateKey");
    expect(ssh.connectConfig).not.toHaveProperty("passphrase");
    expect(ssh.connectConfig?.authHandler).toEqual(["none"]);
  });

  it("pins the raw server key, authenticates only by private key, and opens an xterm PTY", async () => {
    const ssh = new FakeSshClient();
    const privateKey = Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----\n");
    const passphrase = Buffer.from("private passphrase", "utf8");
    const runtime = await startRuntime(ssh, {
      privateKey,
      passphrase,
      columns: 132,
      rows: 41,
    });

    expect(runtime.hostKeySha256).toBe(hostKeySha256);
    expect(ssh.connectConfig).toMatchObject({
      host: "example.test",
      port: 2222,
      username: "ubuntu",
      authHandler: ["publickey"],
      readyTimeout: 30_000,
      timeout: 30_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
    });
    expect(ssh.hostKeyAccepted).toBe(true);
    expect(ssh.shellCalls).toEqual([{
      term: "xterm-256color",
      cols: 132,
      rows: 41,
      width: 0,
      height: 0,
    }]);
    // The caller retains ownership while the runtime's temporary Buffer copies
    // are cleared after ssh2 has parsed/authenticated the key.
    expect(privateKey.toString("utf8")).toContain("OPENSSH PRIVATE KEY");
    expect(passphrase.toString("utf8")).toBe("private passphrase");
    expect([...(ssh.capturedPrivateKey ?? [])]).toEqual(new Array(privateKey.length).fill(0));
    expect([...(ssh.capturedPassphrase ?? [])]).toEqual(new Array(passphrase.length).fill(0));
  });

  it("fails closed on a changed host key and exposes no raw ssh2 error", async () => {
    const ssh = new FakeSshClient();
    ssh.rawConnectionError = new Error("leaked private key and /secret/path");
    const wrongPin = `SHA256:${"A".repeat(43)}`;

    const failure = await captureStartFailure(startUntracked(ssh, { hostKeySha256: wrongPin }));

    expect(failure).toMatchObject({
      code: "host-key-mismatch",
      hostKeySha256,
      message: "The SSH server host key did not match the trusted fingerprint.",
    });
    expect(failure.message).not.toContain("secret");
    expect(ssh.shellCalls).toHaveLength(0);
  });

  it("bounds connection and shell startup and reports fixed errors", async () => {
    const connection = new FakeSshClient();
    connection.deferConnection = true;
    const connectionFailure = await captureStartFailure(startUntracked(connection, {
      limits: { connectTimeoutMilliseconds: 5 },
    }));
    expect(connectionFailure).toMatchObject({
      code: "connection-failed",
      message: "The SSH server could not be reached or authenticated.",
    });

    const shell = new FakeSshClient();
    shell.deferShell = true;
    const shellFailure = await captureStartFailure(startUntracked(shell, {
      limits: { shellTimeoutMilliseconds: 5 },
    }));
    expect(shellFailure).toMatchObject({
      code: "shell-failed",
      message: "The SSH terminal shell could not be started.",
    });
  });
});

describe("SshTerminalRuntime bounded terminal transport", () => {
  it("chunks live output and replays only bounded scrollback with subscriber isolation", async () => {
    const ssh = new FakeSshClient();
    const runtime = await startRuntime(ssh, {
      limits: {
        maxOutputChunkBytes: 1_024,
        maxPendingOutputBytes: 4_096,
        maxScrollbackBytes: 1_536,
        maxSubscribers: 3,
      },
    });
    const live: Uint8Array[] = [];
    runtime.subscribe({
      onOutput: (data) => {
        live.push(data);
        data.fill(0x7a);
      },
      onExit: () => undefined,
    });
    runtime.subscribe({
      onOutput: () => {
        throw new Error("subscriber failure");
      },
      onExit: () => undefined,
    });

    const output = Buffer.from("a".repeat(2_500), "utf8");
    ssh.channel.emitData(output);
    expect(live.every((chunk) => chunk.byteLength <= 1_024)).toBe(true);
    expect(live.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(output.length);

    const replayed: Uint8Array[] = [];
    runtime.subscribe({
      onOutput: (data) => replayed.push(data),
      onExit: () => undefined,
    }, 512);
    expect(Buffer.concat(replayed.map((chunk) => Buffer.from(chunk))).toString("utf8")).toBe("a".repeat(512));
    expect(() => runtime.subscribe({ onOutput: () => undefined, onExit: () => undefined })).toThrow(
      SshTerminalRuntimeError,
    );
  });

  it("pauses the SSH channel, drains an already-read tail, and then resumes", async () => {
    const ssh = new FakeSshClient();
    const runtime = await startRuntime(ssh, {
      limits: {
        maxOutputChunkBytes: 1_024,
        maxPendingOutputBytes: 4_096,
        maxScrollbackBytes: 4_096,
      },
    });
    const received: Uint8Array[] = [];
    runtime.subscribe({
      onOutput: (data) => {
        received.push(data);
        if (received.length === 1) runtime.pauseOutput();
      },
      onExit: () => undefined,
    });

    ssh.channel.emitData(Buffer.from("x".repeat(2_500), "utf8"));
    expect(received.map(({ byteLength }) => byteLength)).toEqual([1_024]);
    expect(ssh.channel.pauseCalls).toBe(1);

    runtime.resumeOutput();
    expect(received.map(({ byteLength }) => byteLength)).toEqual([1_024, 1_024, 452]);
    expect(ssh.channel.resumeCalls).toBe(1);
  });

  it("zeroizes admitted input and maps terminal resize dimensions for SSH", async () => {
    const ssh = new FakeSshClient();
    const runtime = await startRuntime(ssh);
    const input = Uint8Array.from(Buffer.from("whoami\r", "utf8"));

    runtime.write(input);
    runtime.resize(160, 48);

    expect([...input]).toEqual(new Array(input.length).fill(0));
    expect(ssh.channel.writes.map((value) => value.toString("utf8"))).toEqual(["whoami\r"]);
    expect(ssh.channel.windows).toEqual([{ rows: 48, columns: 160, height: 0, width: 0 }]);
  });

  it("turns raw transport failures into safe notices and a bounded terminal exit", async () => {
    const ssh = new FakeSshClient();
    const runtime = await startRuntime(ssh);
    const notices: SshTerminalRuntimeNotice[] = [];
    const exits: number[] = [];
    runtime.subscribe({
      onOutput: () => undefined,
      onError: (notice) => notices.push(notice),
      onExit: ({ exitCode }) => exits.push(exitCode),
    });

    ssh.channel.emit("error", new Error("raw server message containing a secret"));
    await runtime.waitForClose();

    expect(notices).toEqual([{
      code: "terminal-io-failed",
      message: "The SSH terminal stopped after a secure transport error.",
    }]);
    expect(JSON.stringify(notices)).not.toContain("raw server");
    expect(exits).toEqual([255]);
    expect(runtime.isClosed).toBe(true);
  });

  it("closes idempotently and force-destroys a transport that misses the close deadline", async () => {
    const ssh = new FakeSshClient();
    ssh.deferClose = true;
    ssh.channel.deferClose = true;
    const runtime = await startRuntime(ssh, {
      limits: { closeTimeoutMilliseconds: 5 },
    });

    const first = runtime.close();
    const second = runtime.close();
    expect(second).toBe(first);
    await first;

    expect(ssh.channel.closeCalls).toBe(1);
    expect(ssh.endCalls).toBe(1);
    expect(ssh.destroyCalls).toBe(1);
    expect(runtime.isClosed).toBe(true);
  });
});

interface StartOverrides {
  readonly hostKeySha256?: string | undefined;
  readonly privateKey?: Buffer | string;
  readonly passphrase?: Buffer | string;
  readonly columns?: number;
  readonly rows?: number;
  readonly limits?: Parameters<typeof SshTerminalRuntime.start>[0]["limits"];
}

async function startRuntime(ssh: FakeSshClient, overrides: StartOverrides = {}): Promise<SshTerminalRuntime> {
  const runtime = await startUntracked(ssh, overrides);
  openRuntimes.add(runtime);
  return runtime;
}

function startUntracked(ssh: FakeSshClient, overrides: StartOverrides = {}): Promise<SshTerminalRuntime> {
  return SshTerminalRuntime.start({
    ssh: {
      host: "EXAMPLE.test",
      port: 2222,
      username: "ubuntu",
      privateKey: overrides.privateKey ?? "test private key",
      ...(overrides.passphrase === undefined ? {} : { passphrase: overrides.passphrase }),
      ...(overrides.hostKeySha256 === undefined && "hostKeySha256" in overrides
        ? {}
        : { hostKeySha256: overrides.hostKeySha256 ?? hostKeySha256 }),
    },
    createSshClient: () => ssh.asClient(),
    ...(overrides.columns === undefined ? {} : { columns: overrides.columns }),
    ...(overrides.rows === undefined ? {} : { rows: overrides.rows }),
    ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
  });
}

async function captureStartFailure(promise: Promise<SshTerminalRuntime>): Promise<SshTerminalStartError> {
  try {
    await promise;
    throw new Error("Expected SSH startup to fail");
  } catch (error) {
    if (!(error instanceof SshTerminalStartError)) throw error;
    return error;
  }
}

class FakeSshClient extends EventEmitter {
  readonly channel = new FakeSshChannel();
  readonly shellCalls: PseudoTtyOptions[] = [];
  connectConfig: ConnectConfig | undefined;
  capturedPrivateKey: Buffer | undefined;
  capturedPassphrase: Buffer | undefined;
  hostKeyAccepted: boolean | undefined;
  rawConnectionError = new Error("synthetic connection failure");
  deferConnection = false;
  deferShell = false;
  deferClose = false;
  endCalls = 0;
  destroyCalls = 0;

  asClient(): Client {
    return this as unknown as Client;
  }

  connect(config: ConnectConfig): this {
    this.connectConfig = config;
    const verifier = config.hostVerifier as ((key: Buffer) => boolean) | undefined;
    if (!verifier) throw new Error("Missing host verifier");
    this.hostKeyAccepted = verifier(hostKey);
    if (Buffer.isBuffer(config.privateKey)) this.capturedPrivateKey = config.privateKey;
    if (Buffer.isBuffer(config.passphrase)) this.capturedPassphrase = config.passphrase;
    if (this.deferConnection) return this;
    if (!this.hostKeyAccepted) this.emit("error", this.rawConnectionError);
    else this.emit("ready");
    return this;
  }

  shell(window: PseudoTtyOptions, callback: (error: Error | undefined, channel: ClientChannel) => void): this {
    this.shellCalls.push({ ...window });
    if (!this.deferShell) callback(undefined, this.channel.asChannel());
    return this;
  }

  end(): this {
    this.endCalls += 1;
    if (!this.deferClose) this.emit("close");
    return this;
  }

  destroy(): this {
    this.destroyCalls += 1;
    if (!this.deferClose) this.emit("close");
    return this;
  }
}

class FakeSshChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly writes: Buffer[] = [];
  readonly windows: Array<{ rows: number; columns: number; height: number; width: number }> = [];
  pauseCalls = 0;
  resumeCalls = 0;
  closeCalls = 0;
  deferClose = false;

  asChannel(): ClientChannel {
    return this as unknown as ClientChannel;
  }

  write(data: Uint8Array, callback: (error?: Error | null) => void): boolean {
    this.writes.push(Buffer.from(data));
    callback();
    return true;
  }

  setWindow(rows: number, columns: number, height: number, width: number): void {
    this.windows.push({ rows, columns, height, width });
  }

  pause(): this {
    this.pauseCalls += 1;
    return this;
  }

  resume(): this {
    this.resumeCalls += 1;
    return this;
  }

  close(): void {
    this.closeCalls += 1;
    if (!this.deferClose) this.emit("close");
  }

  emitData(data: Buffer): void {
    this.emit("data", data);
  }
}
