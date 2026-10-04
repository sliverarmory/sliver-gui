import { createHash, timingSafeEqual } from "node:crypto";

import { Client, type ClientChannel, type ConnectConfig } from "ssh2";

import type { SliverProvisionSshTarget } from "./sliver-provisioner.js";
import {
  renderLocalRedirectorRecipe,
  renderLocalRedirectorRemoval,
  type LocalRedirectorRecipeInput,
  type LocalRedirectorRecipeIdentity,
} from "./local-redirector-recipes.js";

export type LocalRedirectorSshTarget = SliverProvisionSshTarget & { readonly hostKeySha256: string };
export interface LocalRedirectorInstallInput extends LocalRedirectorRecipeInput {
  readonly ssh: LocalRedirectorSshTarget;
}
export type LocalRedirectorVerifyInput = LocalRedirectorInstallInput;
export interface LocalRedirectorRemoveInput extends LocalRedirectorRecipeIdentity {
  readonly ssh: LocalRedirectorSshTarget;
}
export interface LocalRedirectorProbeInput {
  readonly ssh: LocalRedirectorSshTarget;
  readonly kind: "http" | "https";
  readonly port: number;
}
export interface LocalRedirectorFrontendPortsInput {
  readonly ssh: LocalRedirectorSshTarget;
  readonly ports: readonly number[];
}
export interface LocalRedirectorInstallResult {
  readonly publicUrl: string;
  readonly frontendPorts: readonly number[];
}
export interface LocalRedirectorOutputEvent {
  readonly stream: "stdout" | "stderr";
  readonly chunk: Uint8Array;
}
export type LocalRedirectorOutputHandler = (event: LocalRedirectorOutputEvent) => void;
export interface LocalRedirectorDeployerOptions {
  readonly createSshClient?: () => Client;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  readonly outputLimitBytes?: number;
}

export type LocalRedirectorDeploymentErrorCode =
  | "invalid-input" | "host-key-mismatch" | "ssh-connection-failed"
  | "remote-command-failed" | "remote-command-timeout" | "remote-command-output-limit";

export class LocalRedirectorDeploymentError extends Error {
  readonly code: LocalRedirectorDeploymentErrorCode;

  constructor(code: LocalRedirectorDeploymentErrorCode, message: string) {
    super(message);
    this.name = "LocalRedirectorDeploymentError";
    this.code = code;
  }
}

const HOST_KEY = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const USERNAME = /^[A-Za-z_][A-Za-z0-9_.@-]{0,63}$/u;
const SSH_HOST = /^[A-Za-z0-9.:[\]-]{1,253}$/u;
const PORT = /^[0-9]+$/u;
const PROGRESS_CHUNK_BYTES = 16 * 1024;

/**
 * Main-process-only SSH runner for versioned local redirector recipes. A caller
 * chooses only a reviewed recipe and typed inputs; arbitrary renderer scripts
 * or remote commands never cross this boundary.
 */
export class LocalRedirectorDeployer {
  private readonly createSshClient: () => Client;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly installTimeoutMs: number;
  private readonly outputLimitBytes: number;

  constructor(options: LocalRedirectorDeployerOptions = {}) {
    this.createSshClient = options.createSshClient ?? (() => new Client());
    this.connectTimeoutMs = bounded(options.connectTimeoutMs ?? 20_000, 100, 60_000);
    this.commandTimeoutMs = bounded(options.commandTimeoutMs ?? 30_000, 100, 5 * 60_000);
    this.installTimeoutMs = bounded(options.installTimeoutMs ?? 15 * 60_000, 10_000, 30 * 60_000);
    this.outputLimitBytes = bounded(options.outputLimitBytes ?? 64 * 1024, 1024, 1024 * 1024);
  }

  async install(input: LocalRedirectorInstallInput, onOutput?: LocalRedirectorOutputHandler): Promise<LocalRedirectorInstallResult> {
    const recipe = renderLocalRedirectorRecipe(input);
    validateSshTarget(input.ssh);
    const client = await this.connect(input.ssh);
    try {
      if (!(await this.probeLoopbackListenerWithClient(client, input.ssh.username, "http", input.backendPort))) {
        throw new LocalRedirectorDeploymentError("invalid-input", "The selected Sliver HTTP listener is not bound only to 127.0.0.1");
      }
      if (!(await this.checkFrontendPortsWithClient(client, input.ssh.username, recipe.frontendPorts))) {
        throw new LocalRedirectorDeploymentError("invalid-input", "A requested public redirector port is already in use");
      }
      await this.runScript(client, input.ssh.username, recipe.installScript, "installing the local redirector", this.installTimeoutMs, onOutput);
      return { publicUrl: recipe.publicUrl, frontendPorts: recipe.frontendPorts };
    } finally {
      client.end();
    }
  }

  async verify(input: LocalRedirectorVerifyInput, onOutput?: LocalRedirectorOutputHandler): Promise<boolean> {
    const recipe = renderLocalRedirectorRecipe(input);
    validateSshTarget(input.ssh);
    const client = await this.connect(input.ssh);
    try {
      if (!(await this.probeLoopbackListenerWithClient(client, input.ssh.username, "http", input.backendPort))) return false;
      await this.runScript(client, input.ssh.username, recipe.verifyScript, "verifying the local redirector", 150_000, onOutput);
      return true;
    } catch (error) {
      if (error instanceof LocalRedirectorDeploymentError && error.code === "remote-command-failed") return false;
      throw error;
    } finally {
      client.end();
    }
  }

  async remove(input: LocalRedirectorRemoveInput): Promise<void> {
    const script = renderLocalRedirectorRemoval(input);
    validateSshTarget(input.ssh);
    const client = await this.connect(input.ssh);
    try {
      await this.runScript(client, input.ssh.username, script, "removing the local redirector", 120_000);
    } finally {
      client.end();
    }
  }

  async probeLoopbackListener(input: LocalRedirectorProbeInput): Promise<boolean> {
    validateSshTarget(input.ssh);
    validPort(input.port);
    if (input.kind !== "http" && input.kind !== "https") throw new TypeError("Invalid listener kind");
    const client = await this.connect(input.ssh);
    try {
      return await this.probeLoopbackListenerWithClient(client, input.ssh.username, input.kind, input.port);
    } finally {
      client.end();
    }
  }

  async checkFrontendPortsAvailable(input: LocalRedirectorFrontendPortsInput): Promise<boolean> {
    validateSshTarget(input.ssh);
    if (!Array.isArray(input.ports) || input.ports.length < 1 || input.ports.length > 2) throw new TypeError("Invalid frontend ports");
    input.ports.forEach(validPort);
    const client = await this.connect(input.ssh);
    try {
      return await this.checkFrontendPortsWithClient(client, input.ssh.username, input.ports);
    } finally {
      client.end();
    }
  }

  private async checkFrontendPortsWithClient(client: Client, username: string, ports: readonly number[]): Promise<boolean> {
    const sockets = parseListeningSockets(await this.exec(client, privileged(username, ["ss", "-H", "-ltnp"]), "checking public ports", this.commandTimeoutMs));
    return ports.every((port) => sockets.every((socket) => socket.port !== port));
  }

  private async probeLoopbackListenerWithClient(client: Client, username: string, kind: "http" | "https", port: number): Promise<boolean> {
    const sockets = parseListeningSockets(await this.exec(client, privileged(username, ["ss", "-H", "-ltnp"]), "checking the Sliver listener binding", this.commandTimeoutMs));
    const selected = sockets.filter((socket) => socket.port === port);
    if (selected.length !== 1 || selected[0]?.address !== "127.0.0.1" || selected[0].process !== "sliver-server") return false;
    // HTTP response status may be 404 for a bare request to a Sliver C2
    // listener. A nonzero status still proves the local HTTP path is serving.
    if (kind === "https") return false; // No origin CA/SNI has been supplied.
    const probe = command(["curl", "--noproxy", "*", "--silent", "--show-error", "--output", "/dev/null", "--write-out", "%{http_code}", "--max-time", "5", `http://127.0.0.1:${port}/`]);
    const output = await this.exec(client, `${probe} || true`, "probing the Sliver listener", this.commandTimeoutMs);
    return /^[1-5][0-9]{2}$/u.test(output.trim());
  }

  private async runScript(client: Client, username: string, script: string, label: string, timeoutMs: number, onOutput?: LocalRedirectorOutputHandler): Promise<void> {
    // GNU timeout bounds remote work even if the SSH response disappears.
    const seconds = Math.max(1, Math.floor((timeoutMs - 1_000) / 1_000));
    await this.exec(client, privileged(username, ["timeout", "-k", "15s", `${seconds}s`, "bash", "-c", script]), label, timeoutMs, onOutput);
  }

  private async connect(target: LocalRedirectorSshTarget): Promise<Client> {
    const client = this.createSshClient();
    let observedFingerprint: string | undefined;
    let mismatch = false;
    const config: ConnectConfig = {
      host: target.host,
      port: target.port ?? 22,
      username: target.username,
      readyTimeout: this.connectTimeoutMs,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => {
        const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}`;
        observedFingerprint = fingerprint;
        const left = Buffer.from(fingerprint);
        const right = Buffer.from(target.hostKeySha256);
        const same = left.length === right.length && timingSafeEqual(left, right);
        if (!same) mismatch = true;
        return same;
      },
      ...(target.privateKey === undefined ? {} : { privateKey: target.privateKey }),
      ...(target.passphrase === undefined ? {} : { passphrase: target.passphrase }),
      ...(target.password === undefined ? {} : { password: target.password }),
    };
    return new Promise<Client>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new LocalRedirectorDeploymentError("ssh-connection-failed", "SSH connection timed out")), this.connectTimeoutMs);
      const finish = (error?: LocalRedirectorDeploymentError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.removeListener("ready", ready);
        client.removeListener("error", failed);
        client.removeListener("close", closed);
        if (error) {
          client.destroy();
          reject(error);
        } else if (!observedFingerprint) {
          client.destroy();
          reject(new LocalRedirectorDeploymentError("ssh-connection-failed", "SSH server did not present a host key"));
        } else {
          client.on("error", () => undefined);
          resolve(client);
        }
      };
      const ready = (): void => finish();
      const failed = (): void => finish(new LocalRedirectorDeploymentError(
        mismatch ? "host-key-mismatch" : "ssh-connection-failed",
        mismatch ? "SSH host key did not match the saved fingerprint" : "Could not connect to the managed server over SSH",
      ));
      const closed = (): void => finish(new LocalRedirectorDeploymentError(
        mismatch ? "host-key-mismatch" : "ssh-connection-failed",
        "SSH connection closed before authentication completed",
      ));
      client.once("ready", ready);
      client.once("error", failed);
      client.once("close", closed);
      try { client.connect(config); } catch { failed(); }
    });
  }

  private async exec(client: Client, remoteCommand: string, label: string, timeoutMs: number, onOutput?: LocalRedirectorOutputHandler): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let channel: ClientChannel | undefined;
      let code: number | undefined;
      let total = 0;
      const stdout: Buffer[] = [];
      const timer = setTimeout(() => {
        finish(new LocalRedirectorDeploymentError("remote-command-timeout", `Timed out while ${label}`));
        channel?.close();
        client.destroy();
      }, timeoutMs);
      const finish = (error?: LocalRedirectorDeploymentError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(Buffer.concat(stdout).toString("utf8"));
      };
      const receive = (chunk: Buffer | string, stream: "stdout" | "stderr"): void => {
        if (settled) return;
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
        total += value.length;
        if (total > this.outputLimitBytes) {
          finish(new LocalRedirectorDeploymentError("remote-command-output-limit", `Remote output exceeded the limit while ${label}`));
          channel?.close();
          client.destroy();
          return;
        }
        if (stream === "stdout") stdout.push(Buffer.from(value));
        if (onOutput) {
          for (let offset = 0; offset < value.length; offset += PROGRESS_CHUNK_BYTES) {
            try {
              onOutput({ stream, chunk: Uint8Array.from(value.subarray(offset, offset + PROGRESS_CHUNK_BYTES)) });
            } catch {
              // Progress is observational and must not change the remote operation.
            }
          }
        }
      };
      try {
        client.exec(remoteCommand, (error, stream) => {
        if (error) {
          finish(new LocalRedirectorDeploymentError("remote-command-failed", `Could not start the remote command while ${label}`));
          return;
        }
        if (settled) { stream.close(); return; }
        channel = stream;
        stream.on("data", (chunk: Buffer | string) => receive(chunk, "stdout"));
        stream.stderr.on("data", (chunk: Buffer | string) => receive(chunk, "stderr"));
        stream.once("exit", (exitCode: number) => { code = exitCode; });
        stream.once("error", () => finish(new LocalRedirectorDeploymentError("remote-command-failed", `Remote command failed while ${label}`)));
        stream.once("close", () => {
          if (code !== 0) finish(new LocalRedirectorDeploymentError(
            "remote-command-failed",
            remoteFailureMessage(code, label),
          ));
          else finish();
        });
        });
      } catch {
        finish(new LocalRedirectorDeploymentError("remote-command-failed", `Could not start the remote command while ${label}`));
      }
    });
  }
}

export interface ListeningSocket {
  readonly address: string;
  readonly port: number;
  readonly process: string | null;
}

export function parseListeningSockets(output: string): readonly ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/u);
    const local = columns[3];
    if (!local) continue;
    const match = /^(.*):([0-9]+)$/u.exec(local);
    if (!match || !PORT.test(match[2] ?? "")) continue;
    const address = match[1]?.replace(/^\[(.*)\]$/u, "$1") ?? "";
    const process = /users:\(\("([^"]+)"/u.exec(line)?.[1] ?? null;
    sockets.push({ address, port: Number(match[2]), process });
  }
  return sockets;
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError("Invalid SSH timeout or limit");
  return value;
}

function validPort(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new TypeError("Invalid port");
}

function validateSshTarget(target: LocalRedirectorSshTarget): void {
  if (!target || !SSH_HOST.test(target.host) || !USERNAME.test(target.username) ||
      !HOST_KEY.test(target.hostKeySha256) ||
      (target.privateKey === undefined && target.password === undefined)) {
    throw new LocalRedirectorDeploymentError("invalid-input", "A pinned, authenticated SSH target is required");
  }
  validPort(target.port ?? 22);
}

function command(args: readonly string[]): string {
  return args.map((value) => `'${value.replaceAll("'", `'"'"'`)}'`).join(" ");
}

function privileged(username: string, args: readonly string[]): string {
  return command(username === "root" ? args : ["sudo", "-n", ...args]);
}

function remoteFailureMessage(code: number | undefined, label: string): string {
  switch (code) {
    case 70: return "A public frontend port is already in use on the managed server";
    case 71: return "The managed server has an unsupported Caddy architecture";
    case 72: return "The host Nginx service is already active or enabled";
    case 73: return "This Nginx recipe supports Ubuntu and Amazon Linux 2023";
    case 74: return "The redirector did not present a trusted HTTPS certificate and working backend response";
    case 75: return "The managed redirector service or renewal timer is still active";
    case 76: return "The redirector owner marker is missing while a managed unit remains";
    default: return `Remote command failed while ${label}`;
  }
}
