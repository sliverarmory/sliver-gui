import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";

import type { SliverProvisionSshTarget } from "./sliver-provisioner.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const MAX_OUTPUT_BYTES = 64 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 15 * 60_000;
const COMMAND_TIMEOUT_MS = 3 * 60_000;

export interface CrackstationInstallInput {
  readonly deploymentId: string;
  readonly ssh: SliverProvisionSshTarget;
  readonly binaryPath: string;
  readonly binarySha256: string;
  readonly operatorConfig: Buffer;
  readonly onHostKey?: (fingerprint: string) => Promise<void>;
}

export interface CrackstationInstallResult {
  readonly hostKeySha256: string;
  readonly stationName: string;
  readonly serviceName: string;
}

export interface CrackstationDeployerOptions {
  readonly createSshClient?: () => Client;
  readonly connectTimeoutMs?: number;
  readonly transferTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
}

/** A fixed, main-process recipe. Renderer input never contains shell commands or file paths. */
export class CrackstationDeployer {
  readonly #createSshClient: () => Client;
  readonly #connectTimeoutMs: number;
  readonly #transferTimeoutMs: number;
  readonly #commandTimeoutMs: number;

  constructor(options: CrackstationDeployerOptions = {}) {
    this.#createSshClient = options.createSshClient ?? (() => new Client());
    this.#connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.#transferTimeoutMs = options.transferTimeoutMs ?? TRANSFER_TIMEOUT_MS;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  }

  async install(input: CrackstationInstallInput): Promise<CrackstationInstallResult> {
    if (!UUID.test(input.deploymentId) || !SHA256.test(input.binarySha256) ||
      !Buffer.isBuffer(input.operatorConfig) || input.operatorConfig.length < 1 ||
      input.operatorConfig.length > 4 * 1024 * 1024 ||
      typeof input.binaryPath !== "string" || !input.binaryPath.startsWith("/")) {
      throw new TypeError("Invalid Crackstation installation input");
    }
    const stationName = `crackstation-${input.deploymentId.slice(0, 8)}`;
    const serviceName = `sliver-gui-crackstation-${input.deploymentId}.service`;
    const remoteSuffix = randomUUID();
    const remoteBinary = `/tmp/.sliver-gui-${input.deploymentId}-${remoteSuffix}.bin`;
    const remoteConfig = `/tmp/.sliver-gui-${input.deploymentId}-${remoteSuffix}.cfg`;
    const remoteUnit = `/tmp/.sliver-gui-${input.deploymentId}-${remoteSuffix}.service`;
    const client = this.#createSshClient();
    let connected = false;
    try {
      const hostKeySha256 = await connect(client, input.ssh, this.#connectTimeoutMs);
      connected = true;
      await input.onHostKey?.(hostKeySha256);
      const sftp = await withTimeout(openSftp(client), this.#transferTimeoutMs, client, "Opening Crackstation SSH transfer timed out");
      try {
        await withTimeout(fastPut(sftp, input.binaryPath, remoteBinary), this.#transferTimeoutMs, client, "Crackstation binary transfer timed out");
        await withTimeout(writeRemote(sftp, remoteConfig, input.operatorConfig), this.#transferTimeoutMs, client, "Crackstation profile transfer timed out");
        await withTimeout(writeRemote(sftp, remoteUnit, Buffer.from(systemdUnit(input.deploymentId, stationName), "utf8")),
          this.#transferTimeoutMs, client, "Crackstation service transfer timed out");
      } finally {
        sftp.end();
      }
      await runRemote(client, installScript(input.deploymentId, input.binarySha256, remoteBinary, remoteConfig, remoteUnit),
        this.#commandTimeoutMs);
      return { hostKeySha256, stationName, serviceName };
    } finally {
      if (connected) {
        await runRemote(client, cleanupScript(remoteBinary, remoteConfig, remoteUnit), 15_000).catch(() => undefined);
        client.end();
      } else {
        client.destroy();
      }
    }
  }
}

export function crackstationStationName(deploymentId: string): string {
  if (!UUID.test(deploymentId)) throw new TypeError("Invalid Crackstation deployment ID");
  return `crackstation-${deploymentId.slice(0, 8)}`;
}

function systemdUnit(deploymentId: string, stationName: string): string {
  const root = `/var/lib/sliver-gui-crackstation/${deploymentId}`;
  const binary = `/opt/sliver-gui-crackstation/${deploymentId}/sliver-crackstation`;
  const config = `/etc/sliver-gui-crackstation/${deploymentId}.cfg`;
  return [
    "[Unit]",
    "Description=Sliver GUI Crackstation worker",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "User=slivercs",
    "Group=slivercs",
    `Environment=SLIVER_CRACKSTATION_ROOT_DIR=${root}`,
    `ExecStart=${binary} connect --config ${config} --disable-tui --name ${stationName}`,
    "Restart=on-failure",
    "RestartSec=5",
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    `ReadWritePaths=${root}`,
    "PrivateTmp=true",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function installScript(deploymentId: string, digest: string, binary: string, config: string, unit: string): string {
  const root = `/var/lib/sliver-gui-crackstation/${deploymentId}`;
  const binaryDir = `/opt/sliver-gui-crackstation/${deploymentId}`;
  const configDir = "/etc/sliver-gui-crackstation";
  const serviceName = `sliver-gui-crackstation-${deploymentId}.service`;
  return [
    "set -euo pipefail",
    `printf '%s  %s\\n' '${digest}' '${binary}' | sha256sum --check --status`,
    "test -n \"$(nvidia-smi -L)\"",
    "id -u slivercs >/dev/null 2>&1 || sudo -n useradd --system --home-dir /var/lib/sliver-gui-crackstation --shell /usr/sbin/nologin slivercs",
    `sudo -n install -d -m 0755 '${binaryDir}'`,
    `sudo -n install -d -m 0755 '${configDir}'`,
    `sudo -n install -d -m 0700 -o slivercs -g slivercs '${root}'`,
    `sudo -n install -m 0755 -o root -g root '${binary}' '${binaryDir}/sliver-crackstation'`,
    `sudo -n install -m 0600 -o slivercs -g slivercs '${config}' '${configDir}/${deploymentId}.cfg'`,
    `sudo -n install -m 0644 -o root -g root '${unit}' '/etc/systemd/system/${serviceName}'`,
    "sudo -n systemctl daemon-reload",
    `sudo -n systemctl enable --now '${serviceName}'`,
    "sleep 5",
    `sudo -n systemctl is-active --quiet '${serviceName}'`,
  ].join("\n");
}

function cleanupScript(binary: string, config: string, unit: string): string {
  return `rm -f -- '${binary}' '${config}' '${unit}'`;
}

async function connect(client: Client, target: SliverProvisionSshTarget, timeoutMs: number): Promise<string> {
  if (!target.host || !target.username || !target.privateKey ||
    (target.hostKeySha256 !== undefined && !FINGERPRINT.test(target.hostKeySha256))) {
    throw new TypeError("Invalid Crackstation SSH target");
  }
  let observed: string | undefined;
  let mismatch = false;
  const config: ConnectConfig = {
    host: target.host, port: target.port ?? 22, username: target.username,
    privateKey: target.privateKey, readyTimeout: timeoutMs,
    keepaliveInterval: 10_000, keepaliveCountMax: 3,
    ...(target.passphrase === undefined ? {} : { passphrase: target.passphrase }),
    hostVerifier: (key: Buffer) => {
      const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}`;
      if (observed && !same(observed, fingerprint)) { mismatch = true; return false; }
      observed = fingerprint;
      if (target.hostKeySha256 === undefined) return true;
      const accepted = same(target.hostKeySha256, fingerprint);
      if (!accepted) mismatch = true;
      return accepted;
    },
  };
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Crackstation SSH connection timed out")), timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener("ready", ready);
      client.removeListener("error", failed);
      client.removeListener("close", closed);
      if (error || !observed) { client.destroy(); reject(error ?? new Error("Crackstation SSH host key was unavailable")); }
      else { client.on("error", () => undefined); resolve(observed); }
    };
    const ready = () => finish();
    const failed = () => finish(new Error(mismatch ? "Crackstation SSH host key changed" : "Crackstation SSH authentication failed"));
    const closed = () => finish(new Error("Crackstation SSH connection closed before authentication"));
    client.once("ready", ready);
    client.once("error", failed);
    client.once("close", closed);
    try { client.connect(config); } catch { finish(new Error("Could not start Crackstation SSH connection")); }
  });
}

function same(left: string, right: string): boolean {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)));
}

function fastPut(sftp: SFTPWrapper, local: string, remote: string): Promise<void> {
  return new Promise((resolve, reject) => sftp.fastPut(local, remote, { mode: 0o600 }, (error) => error ? reject(error) : resolve()));
}

function writeRemote(sftp: SFTPWrapper, path: string, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => sftp.writeFile(path, bytes, { mode: 0o600, flag: "wx" }, (error) => error ? reject(error) : resolve()));
}

function runRemote(client: Client, script: string, timeoutMs: number): Promise<void> {
  return withTimeout(new Promise<void>((resolve, reject) => {
    client.exec(`bash -lc '${script.replace(/'/gu, "'\\''")}'`, (error, channel: ClientChannel) => {
      if (error) { reject(new Error("Crackstation remote command could not start")); return; }
      let outputBytes = 0;
      const observe = (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          channel.close();
          reject(new Error("Crackstation remote command output exceeded the limit"));
        }
      };
      channel.on("data", observe);
      channel.stderr.on("data", observe);
      channel.once("close", (code: number) => code === 0 ? resolve() : reject(new Error("Crackstation remote setup failed")));
      channel.once("error", () => reject(new Error("Crackstation remote setup failed")));
    });
  }), timeoutMs, client, "Crackstation remote setup timed out");
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, client: Client, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { client.destroy(); reject(new Error(message)); }, milliseconds);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
