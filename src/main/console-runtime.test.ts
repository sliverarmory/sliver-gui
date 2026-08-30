// @vitest-environment node

import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SliverConsoleRuntime,
  SliverConsoleRuntimeError,
  SliverConsoleStartError,
  scavengeStaleSliverConsoleRoots,
  type NativePty,
  type NativePtyDisposable,
  type NativePtyExitEvent,
  type NativePtyFactory,
  type NativePtySpawnOptions,
  type SliverConsoleRuntimeNotice,
} from "./console-runtime.js";

let fixtureDirectory: string;
let executablePath: string;
const openRuntimes = new Set<SliverConsoleRuntime>();

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "sliver-gui-console-runtime-test-"));
  executablePath = join(fixtureDirectory, process.platform === "win32" ? "sliver-client.exe" : "sliver-client");
  await writeFile(executablePath, "test executable", { mode: 0o700 });
});

afterEach(async () => {
  await Promise.all([...openRuntimes].map((runtime) => runtime.close()));
  openRuntimes.clear();
  await rm(fixtureDirectory, { recursive: true, force: true });
});

describe("SliverConsoleRuntime private staging", () => {
  it("stages exactly the active config, forces the private root env, and launches without a picker", async () => {
    const factory = new FakePtyFactory();
    const config = Buffer.from("verified active config", "utf8");
    const runtime = await startRuntime(factory, config, {
      environment: {
        CUSTOM_CONSOLE_VALUE: "preserved",
        SLIVER_CLIENT_ROOT_DIR: "/attacker/root",
        TERM: "attacker-term",
        term: "case-insensitive-attacker-term",
      },
      columns: 132,
      rows: 41,
    });

    expect([...config]).toEqual(new Array(config.length).fill(0));
    const call = factory.onlySpawn();
    expect(call.file).toBe(executablePath);
    expect(call.args).toEqual(["--disable-wg"]);
    expect(call.options).toMatchObject({
      name: "xterm-256color",
      cols: 132,
      rows: 41,
    });
    expect(call.options.cwd).toBe(call.options.env["SLIVER_CLIENT_ROOT_DIR"]);
    expect(call.options.env).toMatchObject({
      CUSTOM_CONSOLE_VALUE: "preserved",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      SLIVER_CLIENT_ROOT_DIR: call.options.cwd,
    });
    expect(call.options.env["term"]).toBeUndefined();

    const configsDirectory = join(call.options.cwd, "configs");
    expect(await readdir(configsDirectory)).toEqual(["active.cfg"]);
    expect(await readFile(join(configsDirectory, "active.cfg"), "utf8")).toBe("verified active config");
    expect(await readFile(join(call.options.cwd, "tui-settings.yaml"), "utf8")).toBe("console_logs: false\n");
    if (process.platform !== "win32") {
      expect((await stat(call.options.cwd)).mode & 0o777).toBe(0o700);
      expect((await stat(configsDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(configsDirectory, "active.cfg"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(call.options.cwd, "tui-settings.yaml"))).mode & 0o777).toBe(0o600);
    }

    await runtime.close();
    expect(factory.pty.killCalls).toBe(1);
    await expect(access(call.options.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(executablePath)).resolves.toBeUndefined();
  });

  it("zeroizes the config and removes staging when native spawn or listener setup fails", async () => {
    const spawnFailure = new FakePtyFactory();
    spawnFailure.spawnError = new Error("secret native error at /private/config/path");
    const firstConfig = Buffer.from("first secret", "utf8");
    await expect(startUntracked(spawnFailure, firstConfig)).rejects.toEqual(new SliverConsoleStartError());
    expect([...firstConfig]).toEqual(new Array(firstConfig.length).fill(0));
    expect((await readdir(fixtureDirectory)).filter((entry) => entry.startsWith("sliver-gui-console-"))).toEqual([]);

    const listenerFailure = new FakePtyFactory();
    listenerFailure.pty.exitListenerError = new Error("listener setup leaked a private path");
    const secondConfig = Buffer.from("second secret", "utf8");
    await expect(startUntracked(listenerFailure, secondConfig)).rejects.toMatchObject({
      code: "start-failed",
      message: "The Sliver console could not be started.",
    });
    expect([...secondConfig]).toEqual(new Array(secondConfig.length).fill(0));
    expect(listenerFailure.pty.killCalls).toBe(1);
    expect((await readdir(fixtureDirectory)).filter((entry) => entry.startsWith("sliver-gui-console-"))).toEqual([]);
  });

  it("rechecks the synchronous connection lease immediately before native spawn", async () => {
    const factory = new FakePtyFactory();
    const config = Buffer.from("revoked active config", "utf8");
    let leaseChecks = 0;

    await expect(startUntracked(factory, config, {
      assertSpawnLease: () => {
        leaseChecks += 1;
        throw new Error("connection revoked during staging");
      },
    })).rejects.toEqual(new SliverConsoleStartError());

    expect(leaseChecks).toBe(1);
    expect(factory.calls).toHaveLength(0);
    expect([...config]).toEqual(new Array(config.length).fill(0));
    expect((await readdir(fixtureDirectory)).filter((entry) => entry.startsWith("sliver-gui-console-"))).toEqual([]);
  });

  it("never recursively removes the caller-owned temporary parent", async () => {
    const marker = join(fixtureDirectory, "keep.txt");
    await writeFile(marker, "keep");
    const factory = new FakePtyFactory();
    const runtime = await startRuntime(factory, Buffer.from("active config"));
    const ownedRoot = factory.onlySpawn().options.cwd;

    await runtime.close();

    await expect(access(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(marker, "utf8")).resolves.toBe("keep");
  });

  it("scavenges only exact private marked roots and preserves unrelated, prefix-similar, and symlink entries", async () => {
    const factory = new FakePtyFactory();
    const staleRuntime = await startRuntime(factory, Buffer.from("stale active config"));
    const staleRoot = factory.onlySpawn().options.cwd;
    const markerName = ".sliver-gui-console-root";
    const markerBytes = await readFile(join(staleRoot, markerName));

    const unrelated = join(fixtureDirectory, "unrelated-console-root");
    const prefixSimilar = join(fixtureDirectory, "sliver-gui-console-TOOLONG");
    const exactButUnmarked = join(fixtureDirectory, "sliver-gui-console-NOMRK1");
    const symlinkTarget = join(fixtureDirectory, "console-link-target");
    const symlinkEntry = join(fixtureDirectory, "sliver-gui-console-LINK01");
    for (const directory of [unrelated, prefixSimilar, exactButUnmarked, symlinkTarget]) {
      await mkdir(directory, { mode: 0o700 });
    }
    await writeFile(join(unrelated, markerName), markerBytes, { mode: 0o600 });
    await writeFile(join(prefixSimilar, markerName), markerBytes, { mode: 0o600 });
    await writeFile(join(symlinkTarget, markerName), markerBytes, { mode: 0o600 });
    await writeFile(join(symlinkTarget, "keep.txt"), "keep", { mode: 0o600 });
    await symlink(symlinkTarget, symlinkEntry, process.platform === "win32" ? "junction" : "dir");
    markerBytes.fill(0);

    await expect(scavengeStaleSliverConsoleRoots(fixtureDirectory)).resolves.toBe(1);

    await expect(access(staleRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(unrelated)).resolves.toBeUndefined();
    await expect(access(prefixSimilar)).resolves.toBeUndefined();
    await expect(access(exactButUnmarked)).resolves.toBeUndefined();
    expect((await lstat(symlinkEntry)).isSymbolicLink()).toBe(true);
    await expect(readFile(join(symlinkTarget, "keep.txt"), "utf8")).resolves.toBe("keep");

    // The fake runtime can still complete its in-memory teardown after its
    // crash-survivor root has been scavenged.
    await staleRuntime.close();
  });
});

describe("SliverConsoleRuntime bounded terminal transport", () => {
  it("chunks live output and replays only bounded scrollback with subscriber isolation", async () => {
    const factory = new FakePtyFactory();
    const runtime = await startRuntime(factory, Buffer.from("active config"), {
      limits: {
        maxOutputChunkBytes: 1_024,
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

    const output = "a".repeat(2_500);
    factory.pty.emitData(output);
    expect(live.every((chunk) => chunk.byteLength <= 1_024)).toBe(true);
    expect(live.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(output.length);

    const replayed: Uint8Array[] = [];
    runtime.subscribe({
      onOutput: (data) => replayed.push(data),
      onExit: () => undefined,
    });
    expect(Buffer.concat(replayed.map((chunk) => Buffer.from(chunk))).toString("utf8")).toBe(output.slice(-1_536));
    expect(() => runtime.subscribe({ onOutput: () => undefined, onExit: () => undefined })).toThrow(
      SliverConsoleRuntimeError,
    );
  });

  it("consumes and zeroizes bounded input and validates resize dimensions", async () => {
    const factory = new FakePtyFactory();
    const runtime = await startRuntime(factory, Buffer.from("active config"), {
      limits: { maxInputBytes: 8 },
    });
    const input = Uint8Array.from(Buffer.from("help\r", "utf8"));

    runtime.write(input);
    expect(factory.pty.writes).toEqual(["help\r"]);
    expect([...input]).toEqual([0, 0, 0, 0, 0]);

    runtime.resize(160, 48);
    expect(factory.pty.resizes).toEqual([{ columns: 160, rows: 48 }]);
    expect(() => runtime.resize(0, 48)).toThrow(/columns/u);

    const oversized = new Uint8Array(9).fill(0x61);
    expect(() => runtime.write(oversized)).toThrowError(
      expect.objectContaining({ code: "invalid-input" }),
    );
    expect([...oversized]).toEqual(new Array(9).fill(0));
  });

  it("converts native write failures to a fixed notice, zeroizes input, and cleans up", async () => {
    const factory = new FakePtyFactory();
    const runtime = await startRuntime(factory, Buffer.from("active config"));
    const notices: SliverConsoleRuntimeNotice[] = [];
    runtime.subscribe({
      onOutput: () => undefined,
      onExit: () => undefined,
      onError: (notice) => notices.push(notice),
    });
    factory.pty.writeError = new Error("private native failure /secret/path");
    const input = Uint8Array.from([1, 2, 3]);

    expect(() => runtime.write(input)).toThrowError(
      expect.objectContaining({
        code: "terminal-io-failed",
        message: "The Sliver console stopped after a local terminal error.",
      }),
    );
    expect([...input]).toEqual([0, 0, 0]);
    expect(notices).toEqual([{
      code: "terminal-io-failed",
      message: "The Sliver console stopped after a local terminal error.",
    }]);
    expect(JSON.stringify(notices)).not.toContain("secret");

    await runtime.waitForClose();
    expect(runtime.isClosed).toBe(true);
    await expect(access(factory.onlySpawn().options.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a normalized native exit and automatically removes the private root", async () => {
    const factory = new FakePtyFactory();
    const runtime = await startRuntime(factory, Buffer.from("active config"));
    const exits: NativePtyExitEvent[] = [];
    runtime.subscribe({
      onOutput: () => undefined,
      onExit: (exit) => exits.push(exit),
    });
    const root = factory.onlySpawn().options.cwd;

    factory.pty.emitExit({ exitCode: 7, signal: 9 });
    await runtime.waitForClose();

    expect(exits).toEqual([{ exitCode: 7, signal: 9 }]);
    expect(factory.pty.killCalls).toBe(0);
    expect(runtime.isClosed).toBe(true);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });

    const lateExits: NativePtyExitEvent[] = [];
    runtime.subscribe({ onOutput: () => undefined, onExit: (exit) => lateExits.push(exit) });
    expect(lateExits).toEqual([{ exitCode: 7, signal: 9 }]);
  });

  it("keeps the private root until an explicitly killed PTY confirms exit", async () => {
    const factory = new FakePtyFactory();
    factory.pty.emitExitOnKill = false;
    const runtime = await startRuntime(factory, Buffer.from("active config"));
    const root = factory.onlySpawn().options.cwd;
    let closed = false;

    const closing = runtime.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(factory.pty.killCalls).toBe(1);
    expect(closed).toBe(false);
    await expect(access(root)).resolves.toBeUndefined();

    factory.pty.emitExit({ exitCode: 0 });
    await closing;

    expect(closed).toBe(true);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function startRuntime(
  factory: FakePtyFactory,
  configBytes: Uint8Array,
  overrides: Partial<Parameters<typeof SliverConsoleRuntime.start>[0]> = {},
): Promise<SliverConsoleRuntime> {
  const runtime = await startUntracked(factory, configBytes, overrides);
  openRuntimes.add(runtime);
  return runtime;
}

async function startUntracked(
  factory: FakePtyFactory,
  configBytes: Uint8Array,
  overrides: Partial<Parameters<typeof SliverConsoleRuntime.start>[0]> = {},
): Promise<SliverConsoleRuntime> {
  return SliverConsoleRuntime.start({
    clientExecutable: executablePath,
    configBytes,
    ptyFactory: factory,
    tempDirectory: fixtureDirectory,
    ...overrides,
  });
}

interface SpawnCall {
  readonly file: string;
  readonly args: string[];
  readonly options: NativePtySpawnOptions;
}

class FakePtyFactory implements NativePtyFactory {
  readonly pty = new FakePty();
  readonly calls: SpawnCall[] = [];
  spawnError: Error | undefined;

  spawn(file: string, args: string[], options: NativePtySpawnOptions): NativePty {
    if (this.spawnError) throw this.spawnError;
    this.calls.push({ file, args: [...args], options });
    return this.pty;
  }

  onlySpawn(): SpawnCall {
    const call = this.calls[0];
    if (!call || this.calls.length !== 1) throw new Error("Expected exactly one PTY spawn");
    return call;
  }
}

class FakePty implements NativePty {
  readonly writes: string[] = [];
  readonly resizes: Array<{ columns: number; rows: number }> = [];
  readonly dataListeners = new Set<(data: string) => void>();
  readonly exitListeners = new Set<(event: NativePtyExitEvent) => void>();
  killCalls = 0;
  emitExitOnKill = true;
  writeError: Error | undefined;
  exitListenerError: Error | undefined;

  write(data: string | Buffer): void {
    if (this.writeError) throw this.writeError;
    this.writes.push(Buffer.isBuffer(data) ? data.toString("utf8") : data);
  }

  resize(columns: number, rows: number): void {
    this.resizes.push({ columns, rows });
  }

  kill(): void {
    this.killCalls += 1;
    if (this.emitExitOnKill) this.emitExit({ exitCode: 0 });
  }

  onData(listener: (data: string) => void): NativePtyDisposable {
    this.dataListeners.add(listener);
    return disposable(() => this.dataListeners.delete(listener));
  }

  onExit(listener: (event: NativePtyExitEvent) => void): NativePtyDisposable {
    if (this.exitListenerError) throw this.exitListenerError;
    this.exitListeners.add(listener);
    return disposable(() => this.exitListeners.delete(listener));
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: NativePtyExitEvent): void {
    for (const listener of this.exitListeners) listener(event);
  }
}

function disposable(dispose: () => void): NativePtyDisposable {
  return { dispose: () => void dispose() };
}
