import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import type { SliverClientConfig, SliverClientWireGuardConfig } from "../config";

const HELPER_BINARY_ENV = "SLIVER_SCRIPT_WG_PROXY_BINARY";
const SLIVER_DIR_ENV = "SLIVER_SCRIPT_SLIVER_DIR";
// `sliver-script` is CommonJS when consumed directly, but Electron bundles it
// into an ESM main-process artifact. `typeof` keeps the bundled form safe while
// retaining package-relative discovery for the regular CommonJS build.
const packageRoot = typeof __dirname === "string" ? path.resolve(__dirname, "../..") : process.cwd();
const helperSourcePath = path.join(packageRoot, "wireguard-proxy/main.go");
const defaultSliverDir = path.join(packageRoot, "sliver");
const helperBinaryPath = path.join(
  os.tmpdir(),
  "sliver-script",
  "wgproxy",
  `${process.platform}-${process.arch}`,
  process.platform === "win32" ? "sliver-script-wgproxy.exe" : "sliver-script-wgproxy",
);

interface ProxyReadyMessage {
  listen_host: string;
  listen_port: number;
}

export interface WireGuardProxySession {
  rpcHost(): string;
  stop(): Promise<void>;
}

let helperBinaryPromise: Promise<string> | null = null;

export function hasWireGuardWrapper(config: SliverClientConfig): boolean {
  return config.wg !== undefined;
}

export async function startWireGuardProxy(config: SliverClientConfig): Promise<WireGuardProxySession> {
  if (!config.wg) {
    throw new Error("WireGuard proxy requested without a wg config block");
  }

  validateWireGuardConfig(config.wg);

  const binaryPath = await resolveHelperBinary();
  const child = spawn(binaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });

  const stderr = collectText(child.stderr);
  const ready = waitForReady(child, stderr);
  child.stdin.end(JSON.stringify(config));

  const message = await ready;
  return {
    rpcHost: () => `${message.listen_host}:${message.listen_port}`,
    stop: async () => {
      await stopChild(child);
    },
  };
}

function validateWireGuardConfig(config: SliverClientWireGuardConfig): void {
  const missing: string[] = [];

  if (!hasText(config.server_pub_key)) {
    missing.push("server_pub_key");
  }
  if (!hasText(config.client_private_key)) {
    missing.push("client_private_key");
  }
  if (!hasText(config.client_ip)) {
    missing.push("client_ip");
  }

  if (missing.length !== 0) {
    throw new Error(`Invalid sliver config: incomplete wg block (missing ${missing.join(", ")})`);
  }
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

async function resolveHelperBinary(): Promise<string> {
  const configuredBinary = process.env[HELPER_BINARY_ENV];
  if (configuredBinary) {
    if (!fs.existsSync(configuredBinary)) {
      throw new Error(`Configured WireGuard helper does not exist: ${configuredBinary}`);
    }
    return configuredBinary;
  }

  if (!helperBinaryPromise) {
    helperBinaryPromise = buildHelperBinary();
  }

  try {
    return await helperBinaryPromise;
  } catch (error) {
    helperBinaryPromise = null;
    throw error;
  }
}

async function buildHelperBinary(): Promise<string> {
  if (!fs.existsSync(helperSourcePath)) {
    throw new Error(`WireGuard helper source is missing: ${helperSourcePath}`);
  }

  if (await isHelperBinaryFresh()) {
    return helperBinaryPath;
  }

  const sliverDir = resolveSliverDir();
  await mkdir(path.dirname(helperBinaryPath), { recursive: true });

  const stagedDir = await mkdtemp(path.join(sliverDir, "sliver-script-wgproxy-"));
  const stagedSourcePath = path.join(stagedDir, "main.go");

  try {
    await copyFile(helperSourcePath, stagedSourcePath);
    await runCommand("go", ["build", "-mod=vendor", "-o", helperBinaryPath, `./${path.basename(stagedDir)}`], sliverDir);
    return helperBinaryPath;
  } finally {
    await rm(stagedDir, { recursive: true, force: true });
  }
}

async function isHelperBinaryFresh(): Promise<boolean> {
  try {
    const [binaryStats, sourceStats] = await Promise.all([stat(helperBinaryPath), stat(helperSourcePath)]);
    return binaryStats.mtimeMs >= sourceStats.mtimeMs;
  } catch {
    return false;
  }
}

function resolveSliverDir(): string {
  const configuredDir = process.env[SLIVER_DIR_ENV];
  const sliverDir = configuredDir ? path.resolve(configuredDir) : defaultSliverDir;

  if (!fs.existsSync(path.join(sliverDir, "go.mod"))) {
    throw new Error(
      `WireGuard support requires a Sliver checkout. Set ${SLIVER_DIR_ENV} or place sliver at ${defaultSliverDir}`,
    );
  }

  return sliverDir;
}

function collectText(stream: NodeJS.ReadableStream): () => string {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
  });
  return () => buffer.trim();
}

function waitForReady(
  child: ChildProcessWithoutNullStreams,
  stderr: () => string,
): Promise<ProxyReadyMessage> {
  return new Promise<ProxyReadyMessage>((resolve, reject) => {
    let settled = false;
    const lines = readline.createInterface({ input: child.stdout });

    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
      lines.close();
    };

    const rejectWith = (message: string) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    const onError = (error: Error) => {
      rejectWith(`Failed to start WireGuard helper: ${error.message}`);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const stderrText = stderr();
      const reason = stderrText
        ? `WireGuard helper exited before startup: ${stderrText}`
        : `WireGuard helper exited before startup (code=${String(code)}, signal=${String(signal)})`;
      rejectWith(reason);
    };

    lines.once("line", (line) => {
      try {
        const message = JSON.parse(line) as Partial<ProxyReadyMessage>;
        if (typeof message.listen_host !== "string" || typeof message.listen_port !== "number") {
          throw new Error(`Invalid WireGuard helper startup payload: ${line}`);
        }

        settled = true;
        cleanup();
        resolve({ listen_host: message.listen_host, listen_port: message.listen_port });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rejectWith(message);
      }
    });

    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = waitForExit(child);
  child.kill();

  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, 2_000);
  });

  await Promise.race([exited, timeout]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GOCACHE: process.env.GOCACHE ?? path.join(os.tmpdir(), "sliver-script-gocache"),
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      reject(new Error(`Failed to run '${command}': ${error.message}`));
    });

    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      const reason = output || `code=${String(code)} signal=${String(signal)}`;
      reject(new Error(`'${command} ${args.join(" ")}' failed: ${reason}`));
    });
  });
}
