import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper, type Stats } from "ssh2";

const DEFAULT_MULTIPLAYER_PORT = 31_337;
const DEFAULT_CONNECT_ATTEMPTS = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_CLOUD_INIT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_INSTALLER_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_UNPACK_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_CONFIG_LIMIT_BYTES = 4 * 1024 * 1024;
const DEFAULT_SFTP_CLEANUP_TIMEOUT_MS = 1_000;
const TRANSFER_CHUNK_BYTES = 64 * 1024;
const INSTALLER_MEMORY_TARGET_BYTES = 3 * 1024 * 1024 * 1024;
const INSTALLER_DISK_RESERVE_BYTES = 4 * 1024 * 1024 * 1024;
const SWAP_ALLOCATION_INCREMENT_BYTES = 64 * 1024 * 1024;
const MAX_LINUX_PAGE_SIZE_BYTES = 64 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const REGULAR_FILE_MODE = 0o100000;
const FILE_TYPE_MASK = 0o170000;
const HOST_KEY_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPERATOR_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SSH_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.@-]{0,63}$/u;
const VERSION_PATTERN = /^v?[0-9][0-9A-Za-z.+-]{0,63}$/u;
const OFFICIAL_INSTALLER_URL = "https://sliver.sh/install";
// BishopFox/sliver commit a943995040243bec0f6215d3f0c43d613aeb9ec4
// published these 6,043 bytes. Updating the installer is deliberately a code
// review event: fetch the endpoint again and replace this digest explicitly.
const OFFICIAL_INSTALLER_SHA256 = "19e7ebfdff1b06177d65587b78aba16db4043f1f780a510d4cba4646d2444096";
const OFFICIAL_SERVER_PATH = "/root/sliver-server";
const OFFICIAL_SERVICE_NAME = "sliver.service";
const SERVER_TIMEOUT_KILL_AFTER_SECONDS = 15;
const SERVER_TIMEOUT_MINIMUM_MS = (SERVER_TIMEOUT_KILL_AFTER_SECONDS + 1) * 1_000 + 1;
const MINISIGN_ARCHIVE_URL = "https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-linux.tar.gz";
// The release archive's .minisig was independently verified against the
// jedisct1/minisign README release key (RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3).
// Runtime provisioning enforces this reviewed archive digest and the
// architecture-specific binary digest below.
const MINISIGN_ARCHIVE_SHA256 = "9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73";
const MINISIGN_BINARY_PATH = "/usr/local/bin/minisign";
const MINISIGN_RELEASE = {
  amd64: {
    member: "minisign-linux/x86_64/minisign",
    sha256: "2c74dffcc1c9a5ee55957c60971998ace2b89f22585631594ec2152c588af8db",
  },
  arm64: {
    member: "minisign-linux/aarch64/minisign",
    sha256: "cec9f88be8c975af76854a53b4d49c3d257feae38d916edb0d16fb55aacd3000",
  },
} as const satisfies Record<SliverLinuxArchitecture, { readonly member: string; readonly sha256: string }>;

export type SliverLinuxArchitecture = "amd64" | "arm64";

export interface SliverProvisionSshTarget {
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly privateKey?: Buffer | string;
  readonly passphrase?: Buffer | string;
  readonly password?: string;
  /** OpenSSH SHA-256 host-key fingerprint, for example `SHA256:...`. */
  readonly hostKeySha256?: string;
}

export interface ProvisionSliverServerInput {
  readonly deploymentId: string;
  /** Stable address written into the generated operator configuration. */
  readonly operatorEndpointHost: string;
  readonly multiplayerPort?: number;
  readonly operatorName?: string;
  readonly ssh: SliverProvisionSshTarget;
  /**
   * Observes safe, ephemeral provisioning output for a read-only terminal.
   * Stage labels are curated locally and never contain the remote command or
   * its arguments. Stdout is copied before delivery; stderr and output from
   * the operator-generation command are never exposed.
   */
  readonly onOutput?: SliverProvisionOutputHandler;
}

export interface CreateSliverOperatorInput {
  readonly deploymentId: string;
  /** Stable address written into the generated operator configuration. */
  readonly operatorEndpointHost: string;
  readonly multiplayerPort?: number;
  readonly operatorName: string;
  readonly permissions: SliverOperatorPermission;
  /** Main-process duplicate-name check that must complete before mutation. */
  readonly assertOperatorNameAvailable: () => Promise<void>;
  /** Operator creation is allowed only through an already-pinned SSH target. */
  readonly ssh: SliverProvisionSshTarget & { readonly hostKeySha256: string };
}

export type SliverOperatorPermission = "all" | "builder" | "crackstation";

export type SliverProvisionOutputEvent =
  | { readonly type: "stage"; readonly label: string }
  | { readonly type: "stdout"; readonly chunk: Uint8Array };

export type SliverProvisionOutputHandler = (event: SliverProvisionOutputEvent) => void;

export interface SliverProvisionerOptions {
  readonly createSshClient?: () => Client;
  readonly createNonce?: () => string;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly connectAttempts?: number;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly cloudInitTimeoutMs?: number;
  readonly installerTimeoutMs?: number;
  readonly unpackTimeoutMs?: number;
  readonly transferTimeoutMs?: number;
  readonly outputLimitBytes?: number;
  readonly operatorConfigLimitBytes?: number;
}

export interface SliverProvisionResult {
  readonly deploymentId: string;
  readonly hostKeySha256: string;
  readonly architecture: SliverLinuxArchitecture;
  readonly version: string;
  readonly serverSha256: string;
  readonly serviceName: string;
  readonly remoteBinaryPath: string;
  readonly operatorConfig: Buffer;
  readonly operatorConfigSha256: string;
}

export interface SliverOperatorConfigResult {
  readonly deploymentId: string;
  readonly operatorName: string;
  readonly operatorEndpointHost: string;
  readonly multiplayerPort: number;
  readonly permissions: SliverOperatorPermission;
  readonly hostKeySha256: string;
  readonly operatorConfig: Buffer;
  readonly operatorConfigSha256: string;
  /** Root-owned 0600 recovery copy retained on the managed server. */
  readonly remoteRecoveryPath: string;
}

export type SliverProvisionErrorCode =
  | "invalid-input"
  | "host-key-mismatch"
  | "ssh-connection-failed"
  | "remote-command-failed"
  | "remote-command-timeout"
  | "remote-command-output-limit"
  | "remote-transfer-failed"
  | "remote-transfer-timeout"
  | "release-invalid"
  | "official-installer-failed"
  | "provisioning-failed"
  | "operator-outcome-unknown"
  | "operator-config-invalid"
  | "service-not-active";

export class SliverProvisionError extends Error {
  readonly code: SliverProvisionErrorCode;
  readonly hostKeySha256?: string;

  constructor(code: SliverProvisionErrorCode, message: string, hostKeySha256?: string) {
    super(message);
    this.name = "SliverProvisionError";
    this.code = code;
    if (hostKeySha256 !== undefined) this.hostKeySha256 = hostKeySha256;
  }
}

export type SliverOperatorMutationState = "not-started" | "unknown" | "created";

export class SliverOperatorCreationError extends SliverProvisionError {
  readonly mutationState: SliverOperatorMutationState;
  readonly remoteRecoveryPath?: string;
  readonly remoteRecoveryCandidatePath?: string;
  readonly remoteHandoffCandidatePath?: string;

  constructor(
    code: SliverProvisionErrorCode,
    message: string,
    mutationState: SliverOperatorMutationState,
    hostKeySha256?: string,
    remoteRecoveryPath?: string,
    remoteHandoffCandidatePath?: string,
  ) {
    super(code, message, hostKeySha256);
    this.name = "SliverOperatorCreationError";
    this.mutationState = mutationState;
    if (remoteRecoveryPath !== undefined) {
      if (mutationState === "created") this.remoteRecoveryPath = remoteRecoveryPath;
      else if (mutationState === "unknown") this.remoteRecoveryCandidatePath = remoteRecoveryPath;
    }
    if (remoteHandoffCandidatePath !== undefined) {
      this.remoteHandoffCandidatePath = remoteHandoffCandidatePath;
    }
  }
}

interface ProvisioningPaths {
  readonly deploymentRoot: string;
  readonly serverRoot: string;
  readonly clientRoot: string;
  readonly exportRoot: string;
  readonly binaryDirectory: string;
  readonly binaryPath: string;
  readonly operatorConfigPath: string;
  readonly swapPath: string;
  readonly serviceName: string;
  readonly servicePath: string;
}

interface ConnectedSsh {
  readonly client: Client;
  readonly hostKeySha256: string;
}

interface CommandResult {
  readonly stdout: Buffer;
}

interface NumericIdentity {
  readonly uid: number;
  readonly gid: number;
}

interface ManagedSwapMetadata {
  readonly sizeBytes: number;
}

interface OperatorCreationLockMetadata {
  readonly exists: boolean;
  readonly recoveryPath?: string;
  readonly requestSha256?: string;
  readonly state?: "reserved" | "created";
}

export class SliverProvisioner {
  private readonly createSshClient: () => Client;
  private readonly createNonce: () => string;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly connectAttempts: number;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly cloudInitTimeoutMs: number;
  private readonly installerTimeoutMs: number;
  private readonly unpackTimeoutMs: number;
  private readonly transferTimeoutMs: number;
  private readonly outputLimitBytes: number;
  private readonly operatorConfigLimitBytes: number;

  constructor(options: SliverProvisionerOptions = {}) {
    this.createSshClient = options.createSshClient ?? (() => new Client());
    this.createNonce = options.createNonce ?? randomUUID;
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.connectAttempts = boundedInteger(options.connectAttempts ?? DEFAULT_CONNECT_ATTEMPTS, 1, 5, "connect attempts");
    this.connectTimeoutMs = boundedInteger(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, 10, 60_000, "connect timeout");
    this.commandTimeoutMs = boundedInteger(options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, 10, 15 * 60_000, "command timeout");
    this.cloudInitTimeoutMs = boundedInteger(
      options.cloudInitTimeoutMs ?? DEFAULT_CLOUD_INIT_TIMEOUT_MS,
      SERVER_TIMEOUT_MINIMUM_MS,
      30 * 60_000,
      "cloud-init timeout",
    );
    this.installerTimeoutMs = boundedInteger(
      options.installerTimeoutMs ?? DEFAULT_INSTALLER_TIMEOUT_MS,
      SERVER_TIMEOUT_MINIMUM_MS,
      60 * 60_000,
      "installer timeout",
    );
    this.unpackTimeoutMs = boundedInteger(options.unpackTimeoutMs ?? DEFAULT_UNPACK_TIMEOUT_MS, 10, 30 * 60_000, "unpack timeout");
    this.transferTimeoutMs = boundedInteger(options.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS, 10, 60 * 60_000, "transfer timeout");
    this.outputLimitBytes = boundedInteger(options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES, 64, 1024 * 1024, "output limit");
    this.operatorConfigLimitBytes = boundedInteger(options.operatorConfigLimitBytes ?? DEFAULT_CONFIG_LIMIT_BYTES, 64, 16 * 1024 * 1024, "operator config limit");
  }

  async createOperator(input: CreateSliverOperatorInput): Promise<SliverOperatorConfigResult> {
    if (typeof input.operatorName !== "string") invalidInput("An operator name is required");
    if (input.ssh.hostKeySha256 === undefined) {
      invalidInput("A pinned SSH host-key fingerprint is required");
    }
    const normalized = normalizeOperatorInput(input);
    const paths = deploymentPaths(normalized.deploymentId);
    let remoteRecoveryPath = `${paths.exportRoot}/operator-${safeNonce(this.createNonce())}.cfg`;
    const remoteCreationLockPath = `${paths.exportRoot}/operator-lock-${createHash("sha256")
      .update(normalized.operatorName, "utf8")
      .digest("hex")}`;
    const creationRequestSha256 = operatorCreationRequestSha256(normalized);
    let connected: ConnectedSsh | undefined;
    let sftp: SFTPWrapper | undefined;
    let operatorConfig: Buffer | undefined;
    let mutationState: SliverOperatorMutationState = "not-started";
    let remoteRecoveryCandidatePath: string | undefined;
    let remoteHandoffCandidatePath: string | undefined;
    let pendingFailure: SliverProvisionError | undefined;
    let pendingFailureHostKeySha256: string | undefined;
    let transferTerminated = false;
    const remoteTemporaryPaths = new Set<string>();
    const privilegedTemporaryPaths = new Set<string>();
    const markTemporaryPathRemoved = (path: string): void => {
      remoteTemporaryPaths.delete(path);
      privilegedTemporaryPaths.delete(path);
      if (remoteHandoffCandidatePath === path) remoteHandoffCandidatePath = undefined;
    };
    const terminateTransfer = (): void => {
      if (transferTerminated) return;
      transferTerminated = true;
      endSftpSafely(sftp);
      try {
        connected?.client.destroy();
      } catch {
        // The transfer timeout remains the authoritative failure.
      }
    };

    try {
      connected = await this.connect(normalized.ssh);
      sftp = await withTimeout(
        openSftp(connected.client),
        this.transferTimeoutMs,
        "remote-transfer-timeout",
        "Opening the SSH file-transfer channel timed out",
        {
          onTimeout: terminateTransfer,
          disposeLateValue: endSftpSafely,
        },
      );

      let metadata = await this.readOperatorCreationLockMetadata(
        connected.client,
        normalized.ssh.username,
        remoteCreationLockPath,
        normalized.deploymentId,
      );
      let createOperator = false;
      if (!metadata.exists) {
        if (await this.privateRootFileExists(
          connected.client,
          normalized.ssh.username,
          remoteRecoveryPath,
        )) {
          throw new SliverProvisionError(
            "provisioning-failed",
            "Could not reserve a unique Sliver operator recovery path",
          );
        }

        // This main-process check is deliberately the final read-only step.
        // A resumable marker bypasses it, while a fresh creation must prove the
        // requested name is absent immediately before reserving the mutation.
        await normalized.assertOperatorNameAvailable();
        // The reservation command itself can complete remotely even when the
        // SSH response is lost, so every outcome from this point requires
        // explicit reconciliation before another creation attempt.
        mutationState = "unknown";
        remoteRecoveryCandidatePath = remoteRecoveryPath;
        const creationLockState = await this.reserveOperatorCreationLock(
          connected.client,
          normalized.ssh.username,
          remoteCreationLockPath,
          remoteRecoveryPath,
          creationRequestSha256,
        );
        if (creationLockState === "created") {
          createOperator = true;
        } else {
          // Another process won the reservation race after the preflight. Do
          // not run the mutating CLI; reconcile the marker it created instead.
          remoteRecoveryCandidatePath = undefined;
          metadata = await this.readOperatorCreationLockMetadata(
            connected.client,
            normalized.ssh.username,
            remoteCreationLockPath,
            normalized.deploymentId,
          ).catch(() => ({ exists: true }));
        }
      } else {
        mutationState = "unknown";
      }
      if (!createOperator) {
        remoteRecoveryCandidatePath = metadata?.recoveryPath;
        const requestMatches = metadata?.requestSha256 !== undefined &&
          constantTimeEqual(metadata.requestSha256, creationRequestSha256);
        const recoveryExists = metadata?.recoveryPath !== undefined &&
          requestMatches &&
          metadata.state !== undefined &&
          await this.privateRootFileExists(
            connected.client,
            normalized.ssh.username,
            metadata.recoveryPath,
          ).catch(() => false);
        if (!recoveryExists || metadata?.recoveryPath === undefined) {
          throw new SliverProvisionError(
            "operator-outcome-unknown",
            `An operator creation with this name was already attempted. Reconcile the managed server before retrying; remove the recovery marker at ${remoteCreationLockPath} only after confirming no operator exists.`,
          );
        }
        // The request identity (including permissions) matches, and the
        // canonical recovery config exists. Resume the non-mutating handoff
        // instead of invoking Sliver's operator command a second time.
        remoteRecoveryPath = metadata.recoveryPath;
        mutationState = "created";
      }
      remoteRecoveryCandidatePath = remoteRecoveryPath;

      if (createOperator) {
        // Sliver may persist the operator before it writes the configuration or
        // reports a failure. From this point onward the mutation is not safely
        // retryable until the server-side operator list is reconciled.
        try {
          await this.execQuiet(
            connected.client,
            "generating the Sliver operator configuration",
            privileged(normalized.ssh.username, [
              "env",
              `SLIVER_ROOT_DIR=${paths.serverRoot}`,
              `SLIVER_CLIENT_ROOT_DIR=${paths.clientRoot}`,
              paths.binaryPath,
              "operator",
              "--name", normalized.operatorName,
              "--lhost", normalized.operatorEndpointHost,
              "--lport", String(normalized.multiplayerPort),
              "--permissions", normalized.permissions,
              "--save", remoteRecoveryPath,
            ]),
            this.commandTimeoutMs,
            undefined,
            false,
          );
        } catch {
          // Sliver persists an operator before saving its profile, and some CLI
          // failures still exit zero. Never retry after invocation unless a
          // human first reconciles the server-side operator record.
          if (!(await this.privateRootFileExists(
            connected.client,
            normalized.ssh.username,
            remoteRecoveryPath,
          ).catch(() => false))) {
            throw new SliverProvisionError(
              "operator-outcome-unknown",
              "The operator command outcome is unknown; refusing an automatic retry",
            );
          }
        }
        if (!(await this.privateRootFileExists(
          connected.client,
          normalized.ssh.username,
          remoteRecoveryPath,
        ).catch(() => false))) {
          throw new SliverProvisionError(
            "operator-outcome-unknown",
            "Sliver did not produce an operator configuration; refusing an automatic retry",
          );
        }
        mutationState = "created";
      }
      await this.markOperatorCreationLockCreated(
        connected.client,
        normalized.ssh.username,
        remoteCreationLockPath,
      );

      await this.execQuiet(
        connected.client,
        "securing the Sliver operator recovery configuration",
        privileged(normalized.ssh.username, [
          "chown", "--no-dereference", "--", "root:root", remoteRecoveryPath,
        ]),
      );
      await this.execQuiet(
        connected.client,
        "setting private Sliver operator recovery permissions",
        privileged(normalized.ssh.username, ["chmod", "0600", "--", remoteRecoveryPath]),
      );

      const handoffIdentity = await this.resolveNumericIdentity(
        connected.client,
        normalized.ssh.username,
      );
      const canonicalOperatorConfigSha256 = await this.readRemoteSha256(
        connected.client,
        remoteRecoveryPath,
        normalized.ssh.username,
        "hashing the canonical Sliver operator configuration",
      );
      const operatorHandoffPath = `/tmp/.sliver-gui-${normalized.deploymentId}-${safeNonce(this.createNonce())}.operator.cfg`;
      remoteHandoffCandidatePath = operatorHandoffPath;
      remoteTemporaryPaths.add(operatorHandoffPath);
      privilegedTemporaryPaths.add(operatorHandoffPath);
      await this.execQuiet(
        connected.client,
        "preparing the private operator configuration handoff",
        privileged(normalized.ssh.username, [
          "install", "-m", "0600", "-o", String(handoffIdentity.uid), "-g", String(handoffIdentity.gid),
          remoteRecoveryPath, operatorHandoffPath,
        ]),
      );

      const readController = new AbortController();
      operatorConfig = await withTimeout(
        readRemotePrivateFile(
          sftp,
          operatorHandoffPath,
          this.operatorConfigLimitBytes,
          handoffIdentity,
          readController.signal,
        ),
        this.transferTimeoutMs,
        "remote-transfer-timeout",
        "Retrieving the Sliver operator configuration timed out",
        {
          onTimeout: () => {
            readController.abort();
            terminateTransfer();
          },
          disposeLateValue: (lateConfig) => lateConfig.fill(0),
        },
      );
      await withTimeout(
        unlinkRemote(sftp, operatorHandoffPath),
        this.transferTimeoutMs,
        "remote-transfer-timeout",
        "Removing the operator configuration handoff timed out",
        { onTimeout: terminateTransfer },
      );
      remoteTemporaryPaths.delete(operatorHandoffPath);
      privilegedTemporaryPaths.delete(operatorHandoffPath);
      remoteHandoffCandidatePath = undefined;

      const operatorConfigSha256 = createHash("sha256").update(operatorConfig).digest("hex");
      if (!constantTimeEqual(operatorConfigSha256, canonicalOperatorConfigSha256)) {
        throw new SliverProvisionError(
          "operator-config-invalid",
          "The retrieved Sliver operator configuration did not match the canonical remote configuration",
        );
      }
      validateOperatorConfig(operatorConfig, {
        operator: normalized.operatorName,
        lhost: normalized.operatorEndpointHost,
        lport: normalized.multiplayerPort,
      });

      const result: SliverOperatorConfigResult = {
        deploymentId: normalized.deploymentId,
        operatorName: normalized.operatorName,
        operatorEndpointHost: normalized.operatorEndpointHost,
        multiplayerPort: normalized.multiplayerPort,
        permissions: normalized.permissions,
        hostKeySha256: connected.hostKeySha256,
        operatorConfig,
        operatorConfigSha256,
        remoteRecoveryPath,
      };
      operatorConfig = undefined;
      return result;
    } catch (error) {
      pendingFailure = error instanceof SliverProvisionError
        ? error
        : new SliverProvisionError(
            "provisioning-failed",
            "An unexpected error interrupted Sliver operator creation",
          );
      pendingFailureHostKeySha256 = pendingFailure.hostKeySha256 ?? connected?.hostKeySha256;
    } finally {
      operatorConfig?.fill(0);
      if (connected && !transferTerminated) {
        await Promise.all([...privilegedTemporaryPaths].map(async (path) => {
          try {
            await this.removePrivilegedTemporaryPath(
              connected!.client,
              normalized.ssh.username,
              path,
              undefined,
            );
            markTemporaryPathRemoved(path);
          } catch {
            // The SFTP cleanup below may still remove the handoff.
          }
        }));
      }
      if (transferTerminated && privilegedTemporaryPaths.size > 0) {
        let cleanupConnection: ConnectedSsh | undefined;
        try {
          // A timed-out SFTP channel forces the original transport closed. Use
          // a fresh connection with the same pinned host key so a 0600 handoff
          // containing full operator credentials is not abandoned in /tmp.
          cleanupConnection = await this.connect(normalized.ssh);
          await Promise.all([...privilegedTemporaryPaths].map(async (path) => {
            try {
              await this.removePrivilegedTemporaryPath(
                cleanupConnection!.client,
                normalized.ssh.username,
                path,
                undefined,
              );
              markTemporaryPathRemoved(path);
            } catch {
              // Keep the path in the structured recovery error.
            }
          }));
        } catch {
          // Preserve the primary mutation/recovery error. The randomized path
          // is still tracked in the error state for explicit reconciliation.
        } finally {
          cleanupConnection?.client.end();
        }
      }
      if (sftp && !transferTerminated) {
        await withTimeout(
          Promise.all([...remoteTemporaryPaths].map(async (path) => {
            try {
              await unlinkRemote(sftp!, path);
              markTemporaryPathRemoved(path);
            } catch {
              // Keep the path in the structured recovery error.
            }
          })),
          Math.min(this.transferTimeoutMs, DEFAULT_SFTP_CLEANUP_TIMEOUT_MS),
          "remote-transfer-timeout",
          "Cleaning up the temporary operator handoff timed out",
          { onTimeout: terminateTransfer },
        ).catch(() => undefined);
        endSftpSafely(sftp);
      }
      connected?.client.end();
    }

    const failure = pendingFailure ?? new SliverProvisionError(
      "provisioning-failed",
      "An unexpected error interrupted Sliver operator creation",
    );
    if (mutationState !== "not-started") {
      throw new SliverOperatorCreationError(
        failure.code,
        failure.message,
        mutationState,
        pendingFailureHostKeySha256,
        mutationState === "created" ? remoteRecoveryPath : remoteRecoveryCandidatePath,
        remoteHandoffCandidatePath,
      );
    }
    if (failure.hostKeySha256 !== undefined || pendingFailureHostKeySha256 === undefined) throw failure;
    throw new SliverProvisionError(failure.code, failure.message, pendingFailureHostKeySha256);
  }

  async provision(input: ProvisionSliverServerInput): Promise<SliverProvisionResult> {
    const normalized = normalizeInput(input);
    const paths = deploymentPaths(normalized.deploymentId);
    let connected: ConnectedSsh | undefined;
    let sftp: SFTPWrapper | undefined;
    let operatorConfig: Buffer | undefined;
    let officialInstallerStarted = false;
    let stockServiceStopped = false;
    let transferTerminated = false;
    const remoteTemporaryPaths = new Set<string>();
    const privilegedTemporaryPaths = new Set<string>();
    const privilegedTemporaryDirectories = new Set<string>();
    const terminateTransfer = (): void => {
      if (transferTerminated) return;
      transferTerminated = true;
      endSftpSafely(sftp);
      try {
        connected?.client.destroy();
      } catch {
        // The transfer timeout remains the authoritative failure.
      }
    };

    try {
      emitProvisionOutput(normalized.onOutput, { type: "stage", label: "Connecting to the deployment host" });
      connected = await this.connect(normalized.ssh);
      const architecture = await this.preflight(
        connected.client,
        normalized.ssh.username,
        normalized.onOutput,
      );
      await this.waitForCloudInit(
        connected.client,
        normalized.ssh.username,
        normalized.onOutput,
      );

      emitProvisionOutput(normalized.onOutput, { type: "stage", label: "Opening secure file transfer" });
      sftp = await withTimeout(
        openSftp(connected.client),
        this.transferTimeoutMs,
        "remote-transfer-timeout",
        "Opening the SSH file-transfer channel timed out",
        {
          onTimeout: terminateTransfer,
          disposeLateValue: endSftpSafely,
        },
      );

      await this.prepareRemoteDirectories(
        connected.client,
        normalized.ssh.username,
        paths,
        normalized.onOutput,
      );

      await this.ensureInstallerMemory(
        connected.client,
        normalized.ssh.username,
        paths,
        privilegedTemporaryPaths,
        normalized.onOutput,
      );

      await this.ensureMinisign(
        connected.client,
        normalized.ssh.username,
        architecture,
        paths,
        privilegedTemporaryPaths,
        privilegedTemporaryDirectories,
        normalized.onOutput,
      );

      const installerPath = `${paths.deploymentRoot}/.official-installer-${safeNonce(this.createNonce())}.sh`;
      privilegedTemporaryPaths.add(installerPath);
      await this.execQuiet(
        connected.client,
        "creating a private installer file",
        privileged(normalized.ssh.username, [
          "install", "-m", "0600", "-o", "root", "-g", "root", "/dev/null", installerPath,
        ]),
        this.commandTimeoutMs,
        normalized.onOutput,
      );
      try {
        await this.execQuiet(
          connected.client,
          "downloading the official Sliver installer",
          privileged(normalized.ssh.username, [
            "curl",
            "--fail",
            "--show-error",
            "--silent",
            "--location",
            "--proto", "=https",
            "--proto-redir", "=https",
            "--tlsv1.2",
            "--output", installerPath,
            OFFICIAL_INSTALLER_URL,
          ]),
          this.transferTimeoutMs,
          normalized.onOutput,
        );
      } catch {
        throw new SliverProvisionError(
          "official-installer-failed",
          "Downloading the official Sliver installer over HTTPS failed",
        );
      }
      try {
        await this.assertRemoteSha256(
          connected.client,
          installerPath,
          OFFICIAL_INSTALLER_SHA256,
          normalized.ssh.username,
          "installer",
          normalized.onOutput,
        );
      } catch (error) {
        if (error instanceof SliverProvisionError && error.code === "official-installer-failed") throw error;
        throw new SliverProvisionError(
          "official-installer-failed",
          "Verifying the official Sliver installer failed",
        );
      }

      officialInstallerStarted = true;
      try {
        await this.execQuiet(
          connected.client,
          "running the official Sliver installer",
          privileged(normalized.ssh.username, withServerSideTimeout(
            this.installerTimeoutMs,
            ["bash", installerPath],
          )),
          this.installerTimeoutMs,
          normalized.onOutput,
        );
      } catch {
        throw new SliverProvisionError(
          "official-installer-failed",
          "Running the official Sliver installer failed",
        );
      }

      await this.stopStockService(
        connected.client,
        normalized.ssh.username,
        normalized.onOutput,
      );
      stockServiceStopped = true;

      await this.execQuiet(
        connected.client,
        "checking the installed Sliver server",
        privileged(normalized.ssh.username, ["test", "-f", OFFICIAL_SERVER_PATH]),
        this.commandTimeoutMs,
        normalized.onOutput,
      );
      await this.execQuiet(
        connected.client,
        "checking the installed Sliver server type",
        privileged(normalized.ssh.username, ["test", "!", "-L", OFFICIAL_SERVER_PATH]),
        this.commandTimeoutMs,
        normalized.onOutput,
      );
      await this.execQuiet(
        connected.client,
        "checking the installed Sliver server permissions",
        privileged(normalized.ssh.username, ["test", "-x", OFFICIAL_SERVER_PATH]),
        this.commandTimeoutMs,
        normalized.onOutput,
      );

      const versionResult = await this.execChecked(
        connected.client,
        "checking the installed Sliver version",
        privileged(normalized.ssh.username, [OFFICIAL_SERVER_PATH, "version"]),
        this.commandTimeoutMs,
        normalized.onOutput,
      );
      const installedVersion = parseSliverVersion(versionResult.stdout);
      const serverSha256 = await this.readRemoteSha256(
        connected.client,
        OFFICIAL_SERVER_PATH,
        normalized.ssh.username,
        "hashing the installed Sliver server",
        normalized.onOutput,
      );
      await this.execQuiet(
        connected.client,
        "copying the Sliver server into managed storage",
        privileged(normalized.ssh.username, [
          "install", "-m", "0755", "-o", "root", "-g", "root", OFFICIAL_SERVER_PATH, paths.binaryPath,
        ]),
        this.commandTimeoutMs,
        normalized.onOutput,
      );
      await this.assertRemoteSha256(
        connected.client,
        paths.binaryPath,
        serverSha256,
        normalized.ssh.username,
        "server",
        normalized.onOutput,
      );
      await this.removePrivilegedTemporaryPath(
        connected.client,
        normalized.ssh.username,
        installerPath,
        normalized.onOutput,
      );
      privilegedTemporaryPaths.delete(installerPath);

      await this.execQuiet(
        connected.client,
        "unpacking Sliver assets",
        privileged(normalized.ssh.username, [
          "env",
          `SLIVER_ROOT_DIR=${paths.serverRoot}`,
          `SLIVER_CLIENT_ROOT_DIR=${paths.clientRoot}`,
          paths.binaryPath,
          "unpack",
          "--force",
        ]),
        this.unpackTimeoutMs,
        normalized.onOutput,
      );

      const existingOperatorConfig = await this.privateRootFileExists(
        connected.client,
        normalized.ssh.username,
        paths.operatorConfigPath,
        normalized.onOutput,
      );
      if (!existingOperatorConfig) {
        try {
          await this.execQuiet(
            connected.client,
            "generating the Sliver operator configuration",
            privileged(normalized.ssh.username, [
              "env",
              `SLIVER_ROOT_DIR=${paths.serverRoot}`,
              `SLIVER_CLIENT_ROOT_DIR=${paths.clientRoot}`,
              paths.binaryPath,
              "operator",
              "--name", normalized.operatorName,
              "--lhost", normalized.operatorEndpointHost,
              "--lport", String(normalized.multiplayerPort),
              "--permissions", "all",
              "--save", paths.operatorConfigPath,
            ]),
            this.commandTimeoutMs,
            normalized.onOutput,
            false,
          );
        } catch {
          // Sliver persists the operator record before it writes the config and
          // some CLI errors still exit successfully. Once invoked, a missing
          // profile is therefore an ambiguous mutation and must not be retried
          // automatically with the same operator name.
          if (!(await this.privateRootFileExists(
            connected.client,
            normalized.ssh.username,
            paths.operatorConfigPath,
            normalized.onOutput,
          ).catch(() => false))) {
            throw new SliverProvisionError(
              "operator-outcome-unknown",
              "The operator command outcome is unknown; refusing an automatic retry",
            );
          }
        }
        if (!(await this.privateRootFileExists(
          connected.client,
          normalized.ssh.username,
          paths.operatorConfigPath,
          normalized.onOutput,
        ))) {
          throw new SliverProvisionError(
            "operator-outcome-unknown",
            "Sliver did not produce an operator configuration; refusing an automatic retry",
          );
        }
      }
      await this.execQuiet(
        connected.client,
        "securing the Sliver operator configuration",
        privileged(normalized.ssh.username, [
          "chown", "--no-dereference", "--", "root:root", paths.operatorConfigPath,
        ]),
        this.commandTimeoutMs,
        normalized.onOutput,
      );
      await this.execQuiet(
        connected.client,
        "setting private Sliver operator configuration permissions",
        privileged(normalized.ssh.username, ["chmod", "0600", "--", paths.operatorConfigPath]),
        this.commandTimeoutMs,
        normalized.onOutput,
      );

      const handoffIdentity = await this.resolveNumericIdentity(
        connected.client,
        normalized.ssh.username,
        normalized.onOutput,
      );
      const canonicalOperatorConfigSha256 = await this.readRemoteSha256(
        connected.client,
        paths.operatorConfigPath,
        normalized.ssh.username,
        "hashing the canonical Sliver operator configuration",
        normalized.onOutput,
      );

      const operatorHandoffPath = `/tmp/.sliver-gui-${normalized.deploymentId}-${safeNonce(this.createNonce())}.operator.cfg`;
      remoteTemporaryPaths.add(operatorHandoffPath);
      privilegedTemporaryPaths.add(operatorHandoffPath);
      await this.execQuiet(
        connected.client,
        "preparing the private operator configuration handoff",
        privileged(normalized.ssh.username, [
          "install", "-m", "0600", "-o", String(handoffIdentity.uid), "-g", String(handoffIdentity.gid),
          paths.operatorConfigPath, operatorHandoffPath,
        ]),
        this.commandTimeoutMs,
        normalized.onOutput,
      );

      emitProvisionOutput(normalized.onOutput, { type: "stage", label: "Retrieving the operator configuration" });
      const readController = new AbortController();
      operatorConfig = await withTimeout(
        readRemotePrivateFile(
          sftp,
          operatorHandoffPath,
          this.operatorConfigLimitBytes,
          handoffIdentity,
          readController.signal,
        ),
        this.transferTimeoutMs,
        "remote-transfer-timeout",
        "Retrieving the Sliver operator configuration timed out",
        {
          onTimeout: () => {
            readController.abort();
            terminateTransfer();
          },
          disposeLateValue: (lateConfig) => lateConfig.fill(0),
        },
      );
      await withTimeout(
        unlinkRemote(sftp, operatorHandoffPath),
        this.transferTimeoutMs,
        "remote-transfer-timeout",
        "Removing the operator configuration handoff timed out",
        { onTimeout: terminateTransfer },
      );
      remoteTemporaryPaths.delete(operatorHandoffPath);
      privilegedTemporaryPaths.delete(operatorHandoffPath);
      const operatorConfigSha256 = createHash("sha256").update(operatorConfig).digest("hex");
      if (!constantTimeEqual(operatorConfigSha256, canonicalOperatorConfigSha256)) {
        throw new SliverProvisionError(
          "operator-config-invalid",
          "The retrieved Sliver operator configuration did not match the canonical remote configuration",
        );
      }
      validateOperatorConfig(operatorConfig, {
        operator: normalized.operatorName,
        lhost: normalized.operatorEndpointHost,
        lport: normalized.multiplayerPort,
      });
      const unitTemporaryPath = `/tmp/.sliver-gui-${normalized.deploymentId}-${safeNonce(this.createNonce())}.service`;
      remoteTemporaryPaths.add(unitTemporaryPath);
      const unit = Buffer.from(systemdUnit(paths, normalized.multiplayerPort), "utf8");
      const unitSha256 = createHash("sha256").update(unit).digest("hex");
      try {
        emitProvisionOutput(normalized.onOutput, { type: "stage", label: "Uploading the systemd service" });
        const uploadController = new AbortController();
        await withTimeout(
          writeRemoteFileExclusive(sftp, unitTemporaryPath, unit, PRIVATE_FILE_MODE, uploadController.signal),
          this.transferTimeoutMs,
          "remote-transfer-timeout",
          "Uploading the systemd unit timed out",
          {
            onTimeout: () => {
              uploadController.abort();
              terminateTransfer();
            },
          },
        );
      } finally {
        unit.fill(0);
      }
      await this.assertRemoteSha256(
        connected.client,
        unitTemporaryPath,
        unitSha256,
        undefined,
        "unit",
        normalized.onOutput,
      );
      await this.execQuiet(
        connected.client,
        "installing the systemd unit",
        privileged(normalized.ssh.username, [
          "install", "-m", "0600", "-o", "root", "-g", "root", unitTemporaryPath, paths.servicePath,
        ]),
        this.commandTimeoutMs,
        normalized.onOutput,
      );
      try {
        await withTimeout(
          unlinkRemote(sftp, unitTemporaryPath),
          this.transferTimeoutMs,
          "remote-transfer-timeout",
          "Removing the temporary systemd unit timed out",
          { onTimeout: terminateTransfer },
        );
      } catch (error) {
        if (error instanceof SliverProvisionError && error.code === "remote-transfer-timeout") throw error;
      }
      remoteTemporaryPaths.delete(unitTemporaryPath);
      await this.assertRemoteSha256(
        connected.client,
        paths.servicePath,
        unitSha256,
        normalized.ssh.username,
        "unit",
        normalized.onOutput,
      );
      await this.execQuiet(
        connected.client,
        "reloading systemd",
        privileged(normalized.ssh.username, ["systemctl", "daemon-reload"]),
        this.commandTimeoutMs,
        normalized.onOutput,
      );
      await this.execQuiet(
        connected.client,
        "enabling the Sliver service",
        privileged(normalized.ssh.username, ["systemctl", "enable", paths.serviceName]),
        this.commandTimeoutMs,
        normalized.onOutput,
      );
      await this.execQuiet(
        connected.client,
        "starting the Sliver service",
        privileged(normalized.ssh.username, ["systemctl", "restart", paths.serviceName]),
        this.commandTimeoutMs,
        normalized.onOutput,
      );
      const serviceState = await this.execChecked(
        connected.client,
        "checking the Sliver service",
        privileged(normalized.ssh.username, ["systemctl", "is-active", paths.serviceName]),
        this.commandTimeoutMs,
        normalized.onOutput,
      );
      try {
        if (serviceState.stdout.toString("utf8").trim() !== "active") {
          throw new SliverProvisionError("service-not-active", "The Sliver systemd service is not active");
        }
      } finally {
        serviceState.stdout.fill(0);
      }

      // Keep the private 0600 export on the managed host as a recovery copy.
      // The caller still has to durably write and journal its local copy after
      // this method returns; deleting the remote file here would make a local
      // disk/state failure permanently lose the newly-created operator key.

      const result: SliverProvisionResult = {
        deploymentId: normalized.deploymentId,
        hostKeySha256: connected.hostKeySha256,
        architecture,
        version: installedVersion,
        serverSha256,
        serviceName: paths.serviceName,
        remoteBinaryPath: paths.binaryPath,
        operatorConfig,
        operatorConfigSha256,
      };
      emitProvisionOutput(normalized.onOutput, { type: "stage", label: "Sliver server provisioning complete" });
      operatorConfig = undefined;
      return result;
    } catch (error) {
      if (error instanceof SliverProvisionError) {
        if (error.hostKeySha256 !== undefined || connected === undefined) throw error;
        throw new SliverProvisionError(error.code, error.message, connected.hostKeySha256);
      }
      throw new SliverProvisionError(
        "provisioning-failed",
        "An unexpected error interrupted Sliver server provisioning",
        connected?.hostKeySha256,
      );
    } finally {
      operatorConfig?.fill(0);
      if (connected && officialInstallerStarted && !stockServiceStopped) {
        await this.stopStockService(
          connected.client,
          normalized.ssh.username,
          undefined,
        ).catch(() => undefined);
      }
      if (connected && !transferTerminated) {
        await Promise.all([...privilegedTemporaryPaths].map((path) =>
          this.removePrivilegedTemporaryPath(
            connected!.client,
            normalized.ssh.username,
            path,
            undefined,
          ).catch(() => undefined)
        ));
        await Promise.all([...privilegedTemporaryDirectories].map((path) =>
          this.removePrivilegedTemporaryDirectory(
            connected!.client,
            normalized.ssh.username,
            path,
            undefined,
          ).catch(() => undefined)
        ));
      }
      if (sftp && !transferTerminated) {
        await withTimeout(
          Promise.all([...remoteTemporaryPaths].map((path) => unlinkRemote(sftp!, path).catch(() => undefined))),
          Math.min(this.transferTimeoutMs, DEFAULT_SFTP_CLEANUP_TIMEOUT_MS),
          "remote-transfer-timeout",
          "Cleaning up temporary remote deployment files timed out",
          { onTimeout: terminateTransfer },
        ).catch(() => undefined);
        endSftpSafely(sftp);
      }
      connected?.client.end();
    }
  }

  private async connect(target: RequiredNormalizedInput["ssh"]): Promise<ConnectedSsh> {
    let lastError: SliverProvisionError | undefined;
    let retryTarget = target;
    for (let attempt = 1; attempt <= this.connectAttempts; attempt += 1) {
      try {
        return await connectOnce(this.createSshClient(), retryTarget, this.connectTimeoutMs);
      } catch (error) {
        const normalized = error instanceof SliverProvisionError
          ? error
          : new SliverProvisionError("ssh-connection-failed", "Could not connect to the deployment host over SSH");
        if (normalized.code === "host-key-mismatch") throw normalized;
        lastError = normalized;
        if (retryTarget.hostKeySha256 === undefined && normalized.hostKeySha256 !== undefined) {
          retryTarget = { ...retryTarget, hostKeySha256: normalized.hostKeySha256 };
        }
        if (attempt < this.connectAttempts) await this.wait(Math.min(250 * 2 ** (attempt - 1), 2_000));
      }
    }
    throw lastError ?? new SliverProvisionError("ssh-connection-failed", "Could not connect to the deployment host over SSH");
  }

  private async preflight(
    client: Client,
    username: string,
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<SliverLinuxArchitecture> {
    const linux = await this.execChecked(
      client,
      "checking the remote operating system",
      command(["uname", "-s"]),
      this.commandTimeoutMs,
      onOutput,
    );
    const linuxText = consumeText(linux.stdout);
    if (linuxText !== "Linux") {
      throw new SliverProvisionError("remote-command-failed", "Sliver cloud deployments require a Linux host");
    }

    for (const executable of ["systemctl", "install", "sha256sum", "chown", "chmod", "curl", "bash", "sh", "timeout", "id"] as const) {
      await this.execQuiet(
        client,
        `checking for ${executable}`,
        `command -v ${executable} >/dev/null 2>&1`,
        this.commandTimeoutMs,
        onOutput,
      );
    }
    if (username !== "root") {
      await this.execQuiet(
        client,
        "checking noninteractive sudo",
        command(["sudo", "-n", "true"]),
        this.commandTimeoutMs,
        onOutput,
      );
    }

    const architecture = await this.execChecked(
      client,
      "checking the remote architecture",
      command(["uname", "-m"]),
      this.commandTimeoutMs,
      onOutput,
    );
    const architectureText = consumeText(architecture.stdout);
    switch (architectureText) {
      case "x86_64":
      case "amd64":
        return "amd64";
      case "aarch64":
      case "arm64":
        return "arm64";
      default:
        throw new SliverProvisionError("remote-command-failed", "The remote Linux architecture is not supported");
    }
  }

  private async ensureMinisign(
    client: Client,
    username: string,
    architecture: SliverLinuxArchitecture,
    paths: ProvisioningPaths,
    privilegedTemporaryPaths: Set<string>,
    privilegedTemporaryDirectories: Set<string>,
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<void> {
    const probe = await this.execChecked(
      client,
      "checking for minisign",
      privileged(username, [
        "sh",
        "-c",
        "if command -v minisign >/dev/null 2>&1; then printf present; else printf absent; fi",
      ]),
      this.commandTimeoutMs,
      onOutput,
      false,
    );
    const availability = consumeText(probe.stdout);
    if (availability === "present") return;
    if (availability !== "absent") {
      throw new SliverProvisionError("remote-command-failed", "Could not determine minisign availability");
    }

    await this.execQuiet(
      client,
      "checking for tar",
      "command -v tar >/dev/null 2>&1",
      this.commandTimeoutMs,
      onOutput,
    );

    const release = MINISIGN_RELEASE[architecture];
    const bootstrapRoot = `${paths.deploymentRoot}/.minisign-bootstrap-${safeNonce(this.createNonce())}`;
    const archivePath = `${bootstrapRoot}.tar.gz`;
    const extractedBinaryPath = `${bootstrapRoot}/minisign`;
    privilegedTemporaryPaths.add(archivePath);
    privilegedTemporaryDirectories.add(bootstrapRoot);

    await this.execQuiet(
      client,
      "creating a private minisign archive",
      privileged(username, [
        "install", "-m", "0600", "-o", "root", "-g", "root", "/dev/null", archivePath,
      ]),
      this.commandTimeoutMs,
      onOutput,
    );
    await this.execQuiet(
      client,
      "creating a private minisign extraction directory",
      privileged(username, [
        "install", "-d", "-m", "0700", "-o", "root", "-g", "root", bootstrapRoot,
      ]),
      this.commandTimeoutMs,
      onOutput,
    );
    try {
      await this.execQuiet(
        client,
        "downloading the pinned minisign release",
        privileged(username, [
          "curl",
          "--fail",
          "--show-error",
          "--silent",
          "--location",
          "--proto", "=https",
          "--proto-redir", "=https",
          "--tlsv1.2",
          "--output", archivePath,
          MINISIGN_ARCHIVE_URL,
        ]),
        this.transferTimeoutMs,
        onOutput,
      );
    } catch {
      throw new SliverProvisionError(
        "official-installer-failed",
        "Downloading the pinned minisign prerequisite over HTTPS failed",
      );
    }
    await this.assertPinnedMinisignSha256(
      client,
      archivePath,
      MINISIGN_ARCHIVE_SHA256,
      username,
      "archive",
      onOutput,
    );

    try {
      await this.execQuiet(
        client,
        "extracting the pinned minisign binary",
        privileged(username, [
          "tar",
          "--extract",
          "--gzip",
          "--file", archivePath,
          "--directory", bootstrapRoot,
          "--no-same-owner",
          "--no-same-permissions",
          "--strip-components=2",
          "--",
          release.member,
        ]),
        this.commandTimeoutMs,
        onOutput,
      );
      await this.execQuiet(
        client,
        "checking the pinned minisign binary type",
        privileged(username, ["test", "-f", extractedBinaryPath]),
        this.commandTimeoutMs,
        onOutput,
      );
      await this.execQuiet(
        client,
        "rejecting a linked minisign binary",
        privileged(username, ["test", "!", "-L", extractedBinaryPath]),
        this.commandTimeoutMs,
        onOutput,
      );
    } catch {
      throw new SliverProvisionError(
        "official-installer-failed",
        "The pinned minisign prerequisite did not contain the expected regular binary",
      );
    }
    await this.assertPinnedMinisignSha256(
      client,
      extractedBinaryPath,
      release.sha256,
      username,
      "binary",
      onOutput,
    );

    try {
      await this.execQuiet(
        client,
        "installing the pinned minisign binary",
        privileged(username, [
          "install", "-m", "0755", "-o", "root", "-g", "root", extractedBinaryPath, MINISIGN_BINARY_PATH,
        ]),
        this.commandTimeoutMs,
        onOutput,
      );
      for (const check of [["-f"], ["!", "-L"], ["-x"]] as const) {
        await this.execQuiet(
          client,
          "checking the installed minisign binary",
          privileged(username, ["test", ...check, MINISIGN_BINARY_PATH]),
          this.commandTimeoutMs,
          onOutput,
        );
      }
    } catch {
      throw new SliverProvisionError(
        "official-installer-failed",
        "Installing the pinned minisign prerequisite failed",
      );
    }
    await this.assertPinnedMinisignSha256(
      client,
      MINISIGN_BINARY_PATH,
      release.sha256,
      username,
      "installed binary",
      onOutput,
    );

    await this.removePrivilegedTemporaryPath(client, username, archivePath, onOutput);
    privilegedTemporaryPaths.delete(archivePath);
    await this.removePrivilegedTemporaryDirectory(client, username, bootstrapRoot, onOutput);
    privilegedTemporaryDirectories.delete(bootstrapRoot);
  }

  private async ensureInstallerMemory(
    client: Client,
    username: string,
    paths: ProvisioningPaths,
    privilegedTemporaryPaths: Set<string>,
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<void> {
    const memory = await this.execChecked(
      client,
      "checking available installer memory",
      command(["cat", "/proc/meminfo"]),
      this.commandTimeoutMs,
      onOutput,
      false,
    );
    const {
      physicalBytes,
      activeSwapBytes,
      availableMemoryBytes,
      freeSwapBytes,
    } = parseLinuxMemoryInfo(consumeText(memory.stdout));
    const swaps = await this.execChecked(
      client,
      "checking active swap devices",
      command(["cat", "/proc/swaps"]),
      this.commandTimeoutMs,
      onOutput,
      false,
    );
    const activeSwaps = parseLinuxActiveSwaps(consumeText(swaps.stdout));
    const managedSwapReportedBytes = activeSwaps.get(paths.swapPath);
    const managedSwapActive = managedSwapReportedBytes !== undefined;

    if (managedSwapReportedBytes !== undefined) {
      const pageSizeBytes = await this.readLinuxPageSize(client, username, onOutput);
      const metadata = await this.readManagedSwapMetadata(client, username, paths.swapPath, onOutput);
      validateActiveManagedSwapMetadata(metadata, managedSwapReportedBytes, pageSizeBytes);
    }

    const capacityDeficitBytes = Math.max(
      0,
      INSTALLER_MEMORY_TARGET_BYTES - physicalBytes - activeSwapBytes,
    );
    const pressureDeficitBytes = Math.max(
      0,
      INSTALLER_MEMORY_TARGET_BYTES - availableMemoryBytes - freeSwapBytes,
    );
    const deficitBytes = Math.max(capacityDeficitBytes, pressureDeficitBytes);

    if (deficitBytes === 0) {
      if (managedSwapActive) {
        await this.persistManagedSwap(client, username, paths.swapPath, onOutput);
      }
      return;
    }

    if (managedSwapActive) {
      throw new SliverProvisionError(
        "remote-command-failed",
        "The active managed swap file is too small, or the host is under too much memory pressure, for Sliver installation",
      );
    }

    for (const executable of ["dd", "mkswap", "swapon", "mv", "df", "stat", "getconf"] as const) {
      await this.execQuiet(
        client,
        `checking for ${executable}`,
        privileged(username, ["sh", "-c", `command -v ${executable} >/dev/null 2>&1`]),
        this.commandTimeoutMs,
        onOutput,
      );
    }

    const allocationBytes = Math.ceil(
      (deficitBytes + MAX_LINUX_PAGE_SIZE_BYTES) / SWAP_ALLOCATION_INCREMENT_BYTES,
    ) * SWAP_ALLOCATION_INCREMENT_BYTES;
    await this.execQuiet(
      client,
      "removing inactive managed swap residue",
      privileged(username, ["rm", "-f", "--", paths.swapPath]),
      this.commandTimeoutMs,
      onOutput,
    );
    const disk = await this.execChecked(
      client,
      "checking free disk space for Sliver installation",
      privileged(username, ["env", "LC_ALL=C", "df", "-B1", "--output=avail", "--", paths.deploymentRoot]),
      this.commandTimeoutMs,
      onOutput,
      false,
    );
    const availableDiskBytes = parseAvailableDiskBytes(consumeText(disk.stdout));
    if (availableDiskBytes < allocationBytes + INSTALLER_DISK_RESERVE_BYTES) {
      throw new SliverProvisionError(
        "remote-command-failed",
        "The deployment host does not have enough free disk space for managed swap and Sliver installation",
      );
    }
    const temporarySwapPath = `${paths.deploymentRoot}/.managed-swap-${safeNonce(this.createNonce())}.tmp`;
    privilegedTemporaryPaths.add(temporarySwapPath);

    await this.execQuiet(
      client,
      "creating a private managed swap file",
      privileged(username, [
        "install", "-m", "0600", "-o", "root", "-g", "root", "/dev/null", temporarySwapPath,
      ]),
      this.commandTimeoutMs,
      onOutput,
    );
    await this.execQuiet(
      client,
      "allocating managed swap space",
      privileged(username, withAdaptiveServerSideTimeout(this.transferTimeoutMs, [
        "dd",
        "if=/dev/zero",
        `of=${temporarySwapPath}`,
        "bs=1M",
        `count=${String(allocationBytes / (1024 * 1024))}`,
        "status=none",
        "conv=fsync",
      ])),
      this.transferTimeoutMs,
      onOutput,
    );
    await this.execQuiet(
      client,
      "formatting managed swap space",
      privileged(username, ["mkswap", "--", temporarySwapPath]),
      this.commandTimeoutMs,
      onOutput,
      false,
    );
    await this.execQuiet(
      client,
      "installing managed swap space",
      privileged(username, ["mv", "-T", "--", temporarySwapPath, paths.swapPath]),
      this.commandTimeoutMs,
      onOutput,
    );
    privilegedTemporaryPaths.delete(temporarySwapPath);
    privilegedTemporaryPaths.add(paths.swapPath);
    for (const check of [["-f"], ["!", "-L"]] as const) {
      await this.execQuiet(
        client,
        "checking the managed swap file",
        privileged(username, ["test", ...check, paths.swapPath]),
        this.commandTimeoutMs,
        onOutput,
      );
    }
    await this.execQuiet(
      client,
      "securing managed swap space",
      privileged(username, ["chown", "--no-dereference", "--", "root:root", paths.swapPath]),
      this.commandTimeoutMs,
      onOutput,
    );
    await this.execQuiet(
      client,
      "setting private managed swap permissions",
      privileged(username, ["chmod", "0600", "--", paths.swapPath]),
      this.commandTimeoutMs,
      onOutput,
    );
    const metadata = await this.readManagedSwapMetadata(client, username, paths.swapPath, onOutput);
    validateNewManagedSwapMetadata(metadata, allocationBytes);
    try {
      await this.execQuiet(
        client,
        "activating managed swap space",
        privileged(username, ["swapon", "--", paths.swapPath]),
        this.commandTimeoutMs,
        onOutput,
      );
      privilegedTemporaryPaths.delete(paths.swapPath);
    } catch (activationError) {
      // swapon can activate the file before its SSH exit status reaches us.
      // Preserve the path if it is active or if the follow-up observation is
      // ambiguous. Only the conclusively-inactive case remains cleanup-eligible.
      try {
        const failedActivationCheck = await this.execChecked(
          client,
          "checking managed swap after an activation failure",
          command(["cat", "/proc/swaps"]),
          this.commandTimeoutMs,
          onOutput,
          false,
        );
        if (parseLinuxActiveSwaps(consumeText(failedActivationCheck.stdout)).has(paths.swapPath)) {
          privilegedTemporaryPaths.delete(paths.swapPath);
        }
      } catch {
        privilegedTemporaryPaths.delete(paths.swapPath);
      }
      throw activationError;
    }

    const verification = await this.execChecked(
      client,
      "verifying managed swap activation",
      command(["cat", "/proc/swaps"]),
      this.commandTimeoutMs,
      onOutput,
      false,
    );
    const verifiedActiveSwaps = parseLinuxActiveSwaps(consumeText(verification.stdout));
    const verifiedSwapBytes = verifiedActiveSwaps.get(paths.swapPath);
    if (verifiedSwapBytes === undefined) {
      privilegedTemporaryPaths.add(paths.swapPath);
      throw new SliverProvisionError("remote-command-failed", "The managed swap file did not become active");
    }
    const pageSizeBytes = await this.readLinuxPageSize(client, username, onOutput);
    validateActiveManagedSwapMetadata(metadata, verifiedSwapBytes, pageSizeBytes);
    await this.persistManagedSwap(client, username, paths.swapPath, onOutput);
  }

  private async readLinuxPageSize(
    client: Client,
    username: string,
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<number> {
    const result = await this.execChecked(
      client,
      "checking the remote Linux page size",
      privileged(username, ["getconf", "PAGE_SIZE"]),
      this.commandTimeoutMs,
      onOutput,
      false,
    );
    return parseLinuxPageSize(consumeText(result.stdout));
  }

  private async readManagedSwapMetadata(
    client: Client,
    username: string,
    swapPath: string,
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<ManagedSwapMetadata> {
    const metadata = await this.execChecked(
      client,
      "verifying managed swap ownership and permissions",
      privileged(username, ["stat", "--format=%f:%u:%g:%a:%s", "--", swapPath]),
      this.commandTimeoutMs,
      onOutput,
      false,
    );
    return parseManagedSwapMetadata(consumeText(metadata.stdout));
  }

  private async persistManagedSwap(
    client: Client,
    username: string,
    swapPath: string,
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<void> {
    await this.execQuiet(
      client,
      "persisting managed swap across reboots",
      privileged(username, [
        "sh",
        "-c",
        [
          "set -eu;",
          "found=0;",
          "while read -r source target fstype options dump pass extra; do",
          "  case \"$source\" in ''|'#'*) continue ;; esac;",
          "  if [ \"$source\" = \"$1\" ]; then",
          "    if [ \"$found\" -ne 0 ] || [ \"$target\" != none ] || [ \"$fstype\" != swap ] || [ \"$options\" != sw,nofail ] || [ \"$dump\" != 0 ] || [ \"$pass\" != 0 ] || [ -n \"${extra:-}\" ]; then exit 65; fi;",
          "    found=1;",
          "  fi;",
          "done < \"$2\";",
          "if [ \"$found\" -eq 0 ]; then",
          "  printf '\\n%s none swap sw,nofail 0 0\\n' \"$1\" >> \"$2\";",
          "fi",
        ].join(" "),
        "sliver-gui-managed-swap",
        swapPath,
        "/etc/fstab",
      ]),
      this.commandTimeoutMs,
      onOutput,
      false,
    );
  }

  private async assertPinnedMinisignSha256(
    client: Client,
    path: string,
    expectedSha256: string,
    username: string,
    artifact: "archive" | "binary" | "installed binary",
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<void> {
    const actualSha256 = await this.readRemoteSha256(
      client,
      path,
      username,
      `verifying the pinned minisign ${artifact}`,
      onOutput,
    );
    if (!constantTimeEqual(actualSha256, expectedSha256)) {
      throw new SliverProvisionError(
        "official-installer-failed",
        `The pinned minisign ${artifact} failed its SHA-256 check`,
      );
    }
  }

  private async waitForCloudInit(
    client: Client,
    username: string,
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<void> {
    const probe = await this.execChecked(
      client,
      "checking for cloud-init",
      command([
        "sh",
        "-c",
        "if command -v cloud-init >/dev/null 2>&1; then printf present; else printf absent; fi",
      ]),
      this.commandTimeoutMs,
      onOutput,
      false,
    );
    const availability = consumeText(probe.stdout);
    if (availability === "absent") return;
    if (availability !== "present") {
      throw new SliverProvisionError("remote-command-failed", "Could not determine cloud-init availability");
    }
    await this.execQuiet(
      client,
      "waiting for cloud-init to complete",
      privileged(username, withServerSideTimeout(
        this.cloudInitTimeoutMs,
        ["cloud-init", "status", "--wait"],
      )),
      this.cloudInitTimeoutMs,
      onOutput,
    );
  }

  private async resolveNumericIdentity(
    client: Client,
    username: string,
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<NumericIdentity> {
    const uid = await this.execChecked(
      client,
      "resolving the SSH user ID",
      command(["id", "-u", username]),
      this.commandTimeoutMs,
      onOutput,
      false,
    );
    const gid = await this.execChecked(
      client,
      "resolving the SSH group ID",
      command(["id", "-g", username]),
      this.commandTimeoutMs,
      onOutput,
      false,
    );
    return {
      uid: parseNumericIdentity(consumeText(uid.stdout), "user"),
      gid: parseNumericIdentity(consumeText(gid.stdout), "group"),
    };
  }

  private async prepareRemoteDirectories(
    client: Client,
    username: string,
    paths: ProvisioningPaths,
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<void> {
    await this.execQuiet(client, "creating the Sliver binary directory", privileged(username, [
      "install", "-d", "-m", "0755", "-o", "root", "-g", "root", paths.binaryDirectory,
    ]), this.commandTimeoutMs, onOutput);
    for (const path of [paths.deploymentRoot, paths.serverRoot, paths.clientRoot] as const) {
      await this.execQuiet(client, "creating private Sliver state", privileged(username, [
        "install", "-d", "-m", "0700", "-o", "root", "-g", "root", path,
      ]), this.commandTimeoutMs, onOutput);
    }
    await this.execQuiet(client, "creating the operator export directory", privileged(username, [
      "install", "-d", "-m", "0700", "-o", "root", "-g", "root", paths.exportRoot,
    ]), this.commandTimeoutMs, onOutput);
  }

  private async privateRootFileExists(
    client: Client,
    username: string,
    path: string,
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<boolean> {
    const result = await this.execChecked(
      client,
      "checking for an existing private operator configuration",
      privileged(username, [
        "sh",
        "-c",
        "if test -f \"$1\" && test ! -L \"$1\"; then printf present; else printf absent; fi",
        "sliver-gui-file-check",
        path,
      ]),
      this.commandTimeoutMs,
      onOutput,
      false,
    );
    const availability = consumeText(result.stdout);
    if (availability === "present") return true;
    if (availability === "absent") return false;
    throw new SliverProvisionError("remote-command-failed", "Could not inspect the private operator configuration");
  }

  private async reserveOperatorCreationLock(
    client: Client,
    username: string,
    path: string,
    remoteRecoveryPath: string,
    requestSha256: string,
  ): Promise<"created" | "exists"> {
    const result = await this.execChecked(
      client,
      "reserving the Sliver operator name",
      privileged(username, [
        "sh",
        "-c",
        "umask 077; if mkdir -- \"$1\"; then printf '%s\\n' \"$2\" > \"$1/recovery-path\" && printf '%s\\n' \"$3\" > \"$1/request-sha256\" && printf 'reserved\\n' > \"$1/state\" && chmod 0700 -- \"$1\" && chmod 0600 -- \"$1/recovery-path\" \"$1/request-sha256\" \"$1/state\" && printf created; elif test -d \"$1\" && test ! -L \"$1\"; then printf exists; else exit 1; fi",
        "sliver-gui-operator-lock",
        path,
        remoteRecoveryPath,
        requestSha256,
      ]),
      this.commandTimeoutMs,
      undefined,
      false,
    );
    const state = consumeText(result.stdout);
    if (state === "created" || state === "exists") return state;
    throw new SliverProvisionError(
      "remote-command-failed",
      "Could not reserve the managed operator name",
    );
  }

  private async readOperatorCreationLockMetadata(
    client: Client,
    username: string,
    path: string,
    deploymentId: string,
  ): Promise<OperatorCreationLockMetadata> {
    const result = await this.execChecked(
      client,
      "reading the Sliver operator recovery marker",
      privileged(username, [
        "sh",
        "-c",
        "if test -d \"$1\" && test ! -L \"$1\"; then printf 'exists\\n'; else printf 'missing\\n'; fi; for name in recovery-path request-sha256 state; do if test -f \"$1/$name\" && test ! -L \"$1/$name\"; then cat -- \"$1/$name\"; else printf 'absent\\n'; fi; done",
        "sliver-gui-operator-lock-read",
        path,
      ]),
      this.commandTimeoutMs,
      undefined,
      false,
    );
    const [availability, recoveryPath, requestSha256, state, ...extra] = consumeText(result.stdout).split("\n");
    if (extra.length > 0 || (availability !== "exists" && availability !== "missing")) {
      return { exists: true };
    }
    return {
      exists: availability === "exists",
      ...(recoveryPath !== undefined && isManagedOperatorRecoveryPath(deploymentId, recoveryPath)
        ? { recoveryPath }
        : {}),
      ...(requestSha256 !== undefined && /^[0-9a-f]{64}$/u.test(requestSha256)
        ? { requestSha256 }
        : {}),
      ...(state === "reserved" || state === "created" ? { state } : {}),
    };
  }

  private async markOperatorCreationLockCreated(
    client: Client,
    username: string,
    path: string,
  ): Promise<void> {
    await this.execQuiet(
      client,
      "recording the completed Sliver operator creation",
      privileged(username, [
        "sh",
        "-c",
        "umask 077; temporary=\"$1/.state.$$\"; trap 'rm -f -- \"$temporary\"' EXIT HUP INT TERM; printf 'created\\n' > \"$temporary\" && chmod 0600 -- \"$temporary\" && mv -f -- \"$temporary\" \"$1/state\"; status=$?; rm -f -- \"$temporary\"; trap - EXIT HUP INT TERM; exit \"$status\"",
        "sliver-gui-operator-lock-created",
        path,
      ]),
      this.commandTimeoutMs,
      undefined,
      false,
    );
  }

  private async assertRemoteSha256(
    client: Client,
    path: string,
    expectedSha256: string,
    privilegedUsername?: string,
    artifact: "installer" | "server" | "unit" = "server",
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<void> {
    const label = artifact === "installer"
      ? "verifying the official Sliver installer"
      : artifact === "unit"
        ? "verifying the uploaded systemd service"
        : "verifying the installed Sliver server";
    const actual = await this.readRemoteSha256(
      client,
      path,
      privilegedUsername,
      label,
      onOutput,
    );
    if (!constantTimeEqual(actual, expectedSha256)) {
      if (artifact === "installer") {
        throw new SliverProvisionError("official-installer-failed", "The official Sliver installer failed its pinned SHA-256 check");
      }
      if (artifact === "server") {
        throw new SliverProvisionError("release-invalid", "The installed Sliver server failed its SHA-256 check");
      }
      throw new SliverProvisionError("remote-transfer-failed", "The uploaded systemd unit failed its SHA-256 check");
    }
  }

  private async readRemoteSha256(
    client: Client,
    path: string,
    privilegedUsername: string | undefined,
    label: string,
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<string> {
    const argv = ["sha256sum", "--", path];
    const check = await this.execChecked(
      client,
      label,
      privilegedUsername === undefined ? command(argv) : privileged(privilegedUsername, argv),
      this.commandTimeoutMs,
      onOutput,
    );
    const actual = consumeText(check.stdout).split(/\s+/u)[0]?.toLowerCase();
    if (actual === undefined || !SHA256_PATTERN.test(actual)) {
      throw new SliverProvisionError("release-invalid", "The remote SHA-256 result was invalid");
    }
    return actual;
  }

  private async stopStockService(
    client: Client,
    username: string,
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<void> {
    let failure: unknown;
    try {
      await this.execQuiet(
        client,
        "stopping the stock Sliver service",
        privileged(username, ["systemctl", "stop", OFFICIAL_SERVICE_NAME]),
        this.commandTimeoutMs,
        onOutput,
      );
    } catch (error) {
      failure = error;
    }
    try {
      await this.execQuiet(
        client,
        "disabling the stock Sliver service",
        privileged(username, ["systemctl", "disable", OFFICIAL_SERVICE_NAME]),
        this.commandTimeoutMs,
        onOutput,
      );
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  private async removePrivilegedTemporaryPath(
    client: Client,
    username: string,
    path: string,
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<void> {
    await this.execQuiet(
      client,
      "removing a private temporary file",
      privileged(username, ["rm", "-f", "--", path]),
      this.commandTimeoutMs,
      onOutput,
    );
  }

  private async removePrivilegedTemporaryDirectory(
    client: Client,
    username: string,
    path: string,
    onOutput?: SliverProvisionOutputHandler,
  ): Promise<void> {
    await this.execQuiet(
      client,
      "removing a private temporary directory",
      privileged(username, ["rm", "-rf", "--", path]),
      this.commandTimeoutMs,
      onOutput,
    );
  }

  private execChecked(
    client: Client,
    label: string,
    remoteCommand: string,
    timeoutMs = this.commandTimeoutMs,
    onOutput?: SliverProvisionOutputHandler,
    streamStdout = true,
  ): Promise<CommandResult> {
    return executeRemoteCommand(client, remoteCommand, {
      label,
      timeoutMs,
      outputLimitBytes: this.outputLimitBytes,
      ...(onOutput === undefined ? {} : { onOutput }),
      streamStdout,
    });
  }

  private async execQuiet(
    client: Client,
    label: string,
    remoteCommand: string,
    timeoutMs = this.commandTimeoutMs,
    onOutput?: SliverProvisionOutputHandler,
    streamStdout = true,
  ): Promise<void> {
    const result = await this.execChecked(client, label, remoteCommand, timeoutMs, onOutput, streamStdout);
    result.stdout.fill(0);
  }
}

interface NormalizedInput {
  readonly deploymentId: string;
  readonly operatorEndpointHost: string;
  readonly multiplayerPort: number;
  readonly operatorName: string;
  readonly ssh: RequiredNormalizedSshTarget;
  readonly onOutput?: SliverProvisionOutputHandler;
}

interface NormalizedOperatorInput extends NormalizedInput {
  readonly permissions: SliverOperatorPermission;
  readonly assertOperatorNameAvailable: () => Promise<void>;
}

interface RequiredNormalizedSshTarget {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly privateKey?: Buffer | string;
  readonly passphrase?: Buffer | string;
  readonly password?: string;
  readonly hostKeySha256?: string;
}

type RequiredNormalizedInput = NormalizedInput;

function normalizeOperatorInput(input: CreateSliverOperatorInput): NormalizedOperatorInput {
  const normalized = normalizeInput(input);
  if (typeof input.assertOperatorNameAvailable !== "function") {
    invalidInput("An operator availability check is required");
  }
  if (
    input.permissions !== "all" &&
    input.permissions !== "builder" &&
    input.permissions !== "crackstation"
  ) invalidInput("The operator permissions are invalid");
  return {
    ...normalized,
    permissions: input.permissions,
    assertOperatorNameAvailable: input.assertOperatorNameAvailable,
  };
}

function operatorCreationRequestSha256(input: NormalizedOperatorInput): string {
  return createHash("sha256").update(JSON.stringify([
    input.operatorName,
    input.operatorEndpointHost,
    input.multiplayerPort,
    input.permissions,
  ])).digest("hex");
}

function normalizeInput(input: ProvisionSliverServerInput): NormalizedInput {
  const deploymentId = input.deploymentId.toLowerCase();
  if (!UUID_PATTERN.test(deploymentId)) invalidInput("A canonical deployment GUID is required");
  const operatorEndpointHost = normalizeEndpointHost(input.operatorEndpointHost);
  const multiplayerPort = boundedInteger(input.multiplayerPort ?? DEFAULT_MULTIPLAYER_PORT, 1, 65_535, "multiplayer port");
  const operatorName = input.operatorName ?? `slivergui${deploymentId.replaceAll("-", "")}`;
  if (!OPERATOR_PATTERN.test(operatorName)) invalidInput("The operator name is invalid");

  const sshHost = normalizeSshHost(input.ssh.host);
  const sshPort = boundedInteger(input.ssh.port ?? 22, 1, 65_535, "SSH port");
  if (!SSH_USERNAME_PATTERN.test(input.ssh.username)) invalidInput("The SSH username is invalid");
  if (input.ssh.privateKey === undefined && input.ssh.password === undefined) {
    invalidInput("SSH private-key or password credentials are required");
  }
  if (input.ssh.hostKeySha256 !== undefined && !HOST_KEY_PATTERN.test(input.ssh.hostKeySha256)) {
    invalidInput("The SSH host-key fingerprint is invalid");
  }

  return {
    deploymentId,
    operatorEndpointHost,
    multiplayerPort,
    operatorName,
    ...(input.onOutput === undefined ? {} : { onOutput: input.onOutput }),
    ssh: {
      host: sshHost,
      port: sshPort,
      username: input.ssh.username,
      ...(input.ssh.privateKey === undefined ? {} : { privateKey: input.ssh.privateKey }),
      ...(input.ssh.passphrase === undefined ? {} : { passphrase: input.ssh.passphrase }),
      ...(input.ssh.password === undefined ? {} : { password: input.ssh.password }),
      ...(input.ssh.hostKeySha256 === undefined ? {} : { hostKeySha256: input.ssh.hostKeySha256 }),
    },
  };
}

function deploymentPaths(deploymentId: string): ProvisioningPaths {
  const deploymentRoot = `/var/lib/sliver-gui/${deploymentId}`;
  const binaryDirectory = `/opt/sliver-gui/${deploymentId}`;
  const serviceName = `sliver-gui-${deploymentId}.service`;
  return {
    deploymentRoot,
    serverRoot: `${deploymentRoot}/server`,
    clientRoot: `${deploymentRoot}/client-runtime`,
    exportRoot: `${deploymentRoot}/operator-export`,
    binaryDirectory,
    binaryPath: `${binaryDirectory}/sliver-server`,
    operatorConfigPath: `${deploymentRoot}/operator-export/operator.cfg`,
    swapPath: `${deploymentRoot}/managed.swap`,
    serviceName,
    servicePath: `/etc/systemd/system/${serviceName}`,
  };
}

function isManagedOperatorRecoveryPath(deploymentId: string, value: string): boolean {
  const prefix = `/var/lib/sliver-gui/${deploymentId}/operator-export/operator-`;
  return value.startsWith(prefix) && /^[0-9a-f]{16,64}\.cfg$/u.test(value.slice(prefix.length));
}

function systemdUnit(paths: ProvisioningPaths, multiplayerPort: number): string {
  return `[Unit]\nDescription=Sliver server managed by Sliver GUI (${paths.serviceName})\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nUser=root\nWorkingDirectory=${paths.deploymentRoot}\nEnvironment=SLIVER_ROOT_DIR=${paths.serverRoot}\nEnvironment=SLIVER_CLIENT_ROOT_DIR=${paths.clientRoot}\nExecStart=${paths.binaryPath} daemon --lhost 0.0.0.0 --lport ${multiplayerPort}\nRestart=on-failure\nRestartSec=3\nUMask=0077\nKillSignal=SIGTERM\nTimeoutStopSec=30\n\n[Install]\nWantedBy=multi-user.target\n`;
}

async function connectOnce(client: Client, target: RequiredNormalizedSshTarget, timeoutMs: number): Promise<ConnectedSsh> {
  let observedFingerprint: string | undefined;
  let hostKeyMismatch = false;
  const config: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout: timeoutMs,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
    hostVerifier: (key: Buffer) => {
      const fingerprint = sshHostKeySha256(key);
      if (observedFingerprint !== undefined && !constantTimeEqual(observedFingerprint, fingerprint)) {
        hostKeyMismatch = true;
        return false;
      }
      observedFingerprint = fingerprint;
      if (target.hostKeySha256 === undefined) return true;
      const matches = constantTimeEqual(target.hostKeySha256, fingerprint);
      if (!matches) hostKeyMismatch = true;
      return matches;
    },
    ...(target.privateKey === undefined ? {} : { privateKey: target.privateKey }),
    ...(target.passphrase === undefined ? {} : { passphrase: target.passphrase }),
    ...(target.password === undefined ? {} : { password: target.password }),
  };

  return new Promise<ConnectedSsh>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (error?: SliverProvisionError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener("ready", onReady);
      client.removeListener("error", onError);
      client.removeListener("close", onClose);
      if (error) {
        client.destroy();
        reject(error);
        return;
      }
      if (observedFingerprint === undefined) {
        client.destroy();
        reject(new SliverProvisionError("ssh-connection-failed", "The SSH server did not present a host key"));
        return;
      }
      resolve({ client, hostKeySha256: observedFingerprint });
    };
    const onReady = (): void => {
      // Keep a post-authentication error listener installed for the lifetime of
      // the connection. Otherwise a later transport error would be an
      // unhandled EventEmitter error; individual operations still fail through
      // their callbacks, close events, or bounded timeouts.
      client.on("error", () => undefined);
      finish();
    };
    const onError = (): void => finish(new SliverProvisionError(
      hostKeyMismatch ? "host-key-mismatch" : "ssh-connection-failed",
      hostKeyMismatch ? "The SSH host key did not match the saved fingerprint" : "Could not authenticate to the deployment host over SSH",
      observedFingerprint,
    ));
    const onClose = (): void => finish(new SliverProvisionError(
      hostKeyMismatch ? "host-key-mismatch" : "ssh-connection-failed",
      hostKeyMismatch ? "The SSH host key did not match the saved fingerprint" : "The SSH connection closed before authentication completed",
      observedFingerprint,
    ));

    timer = setTimeout(() => finish(new SliverProvisionError(
      "ssh-connection-failed",
      "The SSH connection timed out",
      observedFingerprint,
    )), timeoutMs);

    client.once("ready", onReady);
    client.once("error", onError);
    client.once("close", onClose);
    try {
      client.connect(config);
    } catch {
      finish(new SliverProvisionError(
        hostKeyMismatch ? "host-key-mismatch" : "ssh-connection-failed",
        hostKeyMismatch ? "The SSH host key did not match the saved fingerprint" : "Could not start the SSH connection",
        observedFingerprint,
      ));
    }
  });
}

function executeRemoteCommand(
  client: Client,
  remoteCommand: string,
  options: {
    readonly label: string;
    readonly timeoutMs: number;
    readonly outputLimitBytes: number;
    readonly onOutput?: SliverProvisionOutputHandler;
    readonly streamStdout: boolean;
  },
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    let channel: ClientChannel | undefined;
    let settled = false;
    let exitCode: number | undefined;
    let totalBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      finish(new SliverProvisionError("remote-command-timeout", `Timed out while ${options.label}`));
      channel?.close();
    }, options.timeoutMs);

    const finish = (error?: SliverProvisionError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        zeroBuffers(stdout);
        zeroBuffers(stderr);
        reject(error);
        return;
      }
      const result = Buffer.concat(stdout);
      zeroBuffers(stdout);
      zeroBuffers(stderr);
      resolve({ stdout: result });
    };
    const collect = (destination: Buffer[], chunk: Buffer | string, expose: boolean): void => {
      if (settled) return;
      const copy = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8");
      totalBytes += copy.length;
      if (totalBytes > options.outputLimitBytes) {
        copy.fill(0);
        finish(new SliverProvisionError("remote-command-output-limit", `Remote output exceeded the limit while ${options.label}`));
        channel?.close();
        return;
      }
      destination.push(copy);
      if (expose) {
        emitProvisionOutput(options.onOutput, {
          type: "stdout",
          chunk: Uint8Array.from(copy),
        });
      }
    };

    emitProvisionOutput(options.onOutput, { type: "stage", label: options.label });
    client.exec(remoteCommand, (error, stream) => {
      if (error) {
        finish(new SliverProvisionError("remote-command-failed", `Could not start the remote command while ${options.label}`));
        return;
      }
      if (settled) {
        stream.close();
        return;
      }
      channel = stream;
      stream.on("data", (chunk: Buffer | string) => collect(stdout, chunk, options.streamStdout));
      stream.stderr.on("data", (chunk: Buffer | string) => collect(stderr, chunk, false));
      stream.once("exit", (code: number) => {
        exitCode = code;
      });
      stream.once("error", () => finish(new SliverProvisionError("remote-command-failed", `The remote command failed while ${options.label}`)));
      stream.once("close", () => {
        if (settled) return;
        if (exitCode !== 0) {
          finish(new SliverProvisionError("remote-command-failed", `The remote command failed while ${options.label}`));
          return;
        }
        finish();
      });
    });
  });
}

function emitProvisionOutput(
  onOutput: SliverProvisionOutputHandler | undefined,
  event: SliverProvisionOutputEvent,
): void {
  try {
    onOutput?.(event);
  } catch {
    // Rendering progress is observational and must never change the remote
    // provisioning result, including when a window closes mid-deployment.
  }
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) reject(new SliverProvisionError("remote-transfer-failed", "Could not open the SSH file-transfer channel"));
      else resolve(sftp);
    });
  });
}

async function writeRemoteFileExclusive(
  sftp: SFTPWrapper,
  path: string,
  data: Buffer,
  mode: number,
  signal: AbortSignal,
): Promise<void> {
  const handle = await abortableTransfer(
    sftpOpen(sftp, path, "wx", mode),
    signal,
    (lateHandle) => void sftpClose(sftp, lateHandle).catch(() => undefined),
  );
  try {
    let position = 0;
    while (position < data.length) {
      const length = Math.min(TRANSFER_CHUNK_BYTES, data.length - position);
      await abortableTransfer(
        sftpWrite(sftp, handle, data.subarray(position, position + length), length, position),
        signal,
      );
      position += length;
    }
    const stats = await abortableTransfer(sftpFstat(sftp, handle), signal);
    assertPrivateRegularFile(stats, data.length, "The uploaded systemd unit");
  } catch (error) {
    if (!signal.aborted) {
      await abortableTransfer(unlinkRemote(sftp, path), signal).catch(() => undefined);
    }
    throw error;
  } finally {
    if (!signal.aborted) {
      await abortableTransfer(sftpClose(sftp, handle), signal).catch(() => undefined);
    }
  }
}

async function readRemotePrivateFile(
  sftp: SFTPWrapper,
  path: string,
  maximumBytes: number,
  expectedIdentity: NumericIdentity,
  signal: AbortSignal,
): Promise<Buffer> {
  const handle = await abortableTransfer(
    sftpOpen(sftp, path, "r"),
    signal,
    (lateHandle) => void sftpClose(sftp, lateHandle).catch(() => undefined),
  );
  let result: Buffer | undefined;
  let readComplete = false;
  const wipeResult = (): void => {
    result?.fill(0);
  };
  signal.addEventListener("abort", wipeResult, { once: true });
  try {
    const before = await abortableTransfer(sftpFstat(sftp, handle), signal);
    assertPrivateRegularFile(before, undefined, "The Sliver operator configuration");
    assertExactPrivateIdentity(before, expectedIdentity, "The Sliver operator configuration");
    if (before.size < 1 || before.size > maximumBytes) {
      throw new SliverProvisionError("operator-config-invalid", "The Sliver operator configuration exceeded its size limit");
    }
    result = Buffer.alloc(before.size);
    let position = 0;
    while (position < result.length) {
      const bytesRead = await abortableTransfer(
        sftpRead(sftp, handle, result, position, result.length - position, position),
        signal,
        wipeResult,
      );
      if (bytesRead < 1) throw new SliverProvisionError("operator-config-invalid", "The Sliver operator configuration ended unexpectedly");
      position += bytesRead;
    }
    const after = await abortableTransfer(sftpFstat(sftp, handle), signal);
    if (
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.gid !== after.gid ||
      before.mtime !== after.mtime
    ) {
      throw new SliverProvisionError("operator-config-invalid", "The Sliver operator configuration changed while it was read");
    }
    readComplete = true;
  } finally {
    if (!readComplete) wipeResult();
    if (!signal.aborted) {
      await abortableTransfer(sftpClose(sftp, handle), signal).catch(() => undefined);
    }
    signal.removeEventListener("abort", wipeResult);
  }
  throwIfTransferAborted(signal);
  if (result === undefined) {
    throw new SliverProvisionError("remote-transfer-failed", "The Sliver operator configuration was not retrieved");
  }
  const complete = result;
  result = undefined;
  return complete;
}

function assertExactPrivateIdentity(stats: Stats, expected: NumericIdentity, label: string): void {
  if ((stats.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new SliverProvisionError("remote-transfer-failed", `${label} permissions were not exactly 0600`);
  }
  if (stats.uid !== expected.uid || stats.gid !== expected.gid) {
    throw new SliverProvisionError("remote-transfer-failed", `${label} ownership did not match the SSH user`);
  }
}

function validateOperatorConfig(
  data: Buffer,
  expected: { readonly operator: string; readonly lhost: string; readonly lport: number },
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8"));
  } catch {
    throw new SliverProvisionError("operator-config-invalid", "Sliver generated an invalid operator configuration");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SliverProvisionError("operator-config-invalid", "Sliver generated an invalid operator configuration");
  }
  const record = parsed as Record<string, unknown>;
  for (const field of ["operator", "lhost", "ca_certificate", "certificate", "private_key", "token"] as const) {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      throw new SliverProvisionError("operator-config-invalid", "Sliver generated an incomplete operator configuration");
    }
  }
  if (record["operator"] !== expected.operator || record["lhost"] !== expected.lhost || record["lport"] !== expected.lport) {
    throw new SliverProvisionError("operator-config-invalid", "Sliver generated an operator configuration for an unexpected endpoint");
  }
  if (Object.prototype.hasOwnProperty.call(record, "wg")) {
    throw new SliverProvisionError("operator-config-invalid", "The generated operator configuration is not direct mTLS");
  }
}

function normalizeEndpointHost(value: string): string {
  const trimmed = value.trim();
  const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const ipVersion = isIP(unbracketed);
  if (ipVersion === 4) return unbracketed;
  if (ipVersion === 6) return `[${unbracketed}]`;
  if (unbracketed.length < 1 || unbracketed.length > 253 || !validDnsName(unbracketed)) {
    invalidInput("A valid reachable operator endpoint is required");
  }
  return unbracketed.toLowerCase();
}

function normalizeSshHost(value: string): string {
  const trimmed = value.trim();
  const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (isIP(unbracketed) !== 0) return unbracketed;
  if (unbracketed.length < 1 || unbracketed.length > 253 || !validDnsName(unbracketed)) invalidInput("The SSH host is invalid");
  return unbracketed.toLowerCase();
}

function validDnsName(value: string): boolean {
  return value.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)
  );
}

function sshHostKeySha256(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}`;
}

function privileged(username: string, argv: readonly string[]): string {
  return command(username === "root" ? argv : ["sudo", "-n", ...argv]);
}

function command(argv: readonly string[]): string {
  if (argv.length === 0) throw new SliverProvisionError("invalid-input", "A remote command is required");
  return argv.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (value.includes("\u0000") || /[\r\n]/u.test(value)) invalidInput("A remote command argument is invalid");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try {
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function consumeText(buffer: Buffer): string {
  try {
    return buffer.toString("utf8").trim();
  } finally {
    buffer.fill(0);
  }
}

function parseLinuxMemoryInfo(value: string): {
  readonly physicalBytes: number;
  readonly activeSwapBytes: number;
  readonly availableMemoryBytes: number;
  readonly freeSwapBytes: number;
} {
  const fields = new Map<string, number>();
  for (const line of value.split("\n")) {
    const match = /^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+([0-9]+)\s+kB\s*$/u.exec(line);
    if (match === null) continue;
    const label = match[1];
    const kibibytesText = match[2];
    if (label === undefined || kibibytesText === undefined || fields.has(label)) {
      throw new SliverProvisionError("remote-command-failed", "The remote Linux memory report was invalid");
    }
    const kibibytes = Number(kibibytesText);
    const bytes = kibibytes * 1024;
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new SliverProvisionError("remote-command-failed", "The remote Linux memory report was invalid");
    }
    fields.set(label, bytes);
  }
  const physicalBytes = fields.get("MemTotal");
  const activeSwapBytes = fields.get("SwapTotal");
  const availableMemoryBytes = fields.get("MemAvailable");
  const freeSwapBytes = fields.get("SwapFree");
  if (
    physicalBytes === undefined || physicalBytes <= 0 ||
    activeSwapBytes === undefined || availableMemoryBytes === undefined || freeSwapBytes === undefined ||
    availableMemoryBytes > physicalBytes || freeSwapBytes > activeSwapBytes ||
    !Number.isSafeInteger(physicalBytes + activeSwapBytes) ||
    !Number.isSafeInteger(availableMemoryBytes + freeSwapBytes)
  ) {
    throw new SliverProvisionError("remote-command-failed", "The remote Linux memory report was invalid");
  }
  return { physicalBytes, activeSwapBytes, availableMemoryBytes, freeSwapBytes };
}

function parseLinuxActiveSwaps(value: string): ReadonlyMap<string, number> {
  const lines = value.split("\n").filter((line) => line.trim().length > 0);
  const header = lines.shift()?.trim().split(/\s+/u);
  if (header?.join(":") !== "Filename:Type:Size:Used:Priority") {
    throw new SliverProvisionError("remote-command-failed", "The remote Linux swap report was invalid");
  }
  const swaps = new Map<string, number>();
  for (const line of lines) {
    const fields = line.trim().split(/\s+/u);
    const [path, type, sizeText, usedText, priorityText] = fields;
    if (
      fields.length !== 5 || path === undefined || !path.startsWith("/") || swaps.has(path) ||
      (type !== "file" && type !== "partition") ||
      sizeText === undefined || !/^[0-9]+$/u.test(sizeText) ||
      usedText === undefined || !/^[0-9]+$/u.test(usedText) ||
      priorityText === undefined || !/^-?[0-9]+$/u.test(priorityText)
    ) {
      throw new SliverProvisionError("remote-command-failed", "The remote Linux swap report was invalid");
    }
    const sizeKibibytes = Number(sizeText);
    const usedKibibytes = Number(usedText);
    const priority = Number(priorityText);
    const sizeBytes = sizeKibibytes * 1024;
    if (
      !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 ||
      !Number.isSafeInteger(usedKibibytes) || usedKibibytes < 0 || usedKibibytes > sizeKibibytes ||
      !Number.isSafeInteger(priority)
    ) {
      throw new SliverProvisionError("remote-command-failed", "The remote Linux swap report was invalid");
    }
    swaps.set(path, sizeBytes);
  }
  return swaps;
}

function parseAvailableDiskBytes(value: string): number {
  const lines = value.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const bytesText = lines.at(-1);
  if (lines.length !== 2 || lines[0] !== "Avail" || bytesText === undefined || !/^[0-9]+$/u.test(bytesText)) {
    throw new SliverProvisionError("remote-command-failed", "The remote free disk-space report was invalid");
  }
  const bytes = Number(bytesText);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new SliverProvisionError("remote-command-failed", "The remote free disk-space report was invalid");
  }
  return bytes;
}

function parseManagedSwapMetadata(value: string): ManagedSwapMetadata {
  const match = /^([0-9a-f]+):([0-9]+):([0-9]+):([0-7]+):([0-9]+)$/iu.exec(value);
  if (match === null) {
    throw new SliverProvisionError("remote-command-failed", "The managed swap file metadata was invalid");
  }
  const mode = Number.parseInt(match[1] ?? "", 16);
  const uid = Number(match[2]);
  const gid = Number(match[3]);
  const permissions = match[4];
  const sizeBytes = Number(match[5]);
  if (
    !Number.isSafeInteger(mode) || (mode & FILE_TYPE_MASK) !== REGULAR_FILE_MODE ||
    uid !== 0 || gid !== 0 || permissions !== "600" ||
    !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0
  ) {
    throw new SliverProvisionError("remote-command-failed", "The managed swap file was not a private root-owned regular file");
  }
  return { sizeBytes };
}

function validateNewManagedSwapMetadata(metadata: ManagedSwapMetadata, allocationBytes: number): void {
  if (metadata.sizeBytes !== allocationBytes) {
    throw new SliverProvisionError("remote-command-failed", "The managed swap file size did not match its allocation");
  }
}

function validateActiveManagedSwapMetadata(
  metadata: ManagedSwapMetadata,
  reportedSwapBytes: number,
  pageSizeBytes: number,
): void {
  if (metadata.sizeBytes - pageSizeBytes !== reportedSwapBytes) {
    throw new SliverProvisionError("remote-command-failed", "The active managed swap file size did not match the kernel report");
  }
}

function parseLinuxPageSize(value: string): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new SliverProvisionError("remote-command-failed", "The remote Linux page size was invalid");
  }
  const pageSizeBytes = Number(value);
  if (
    !Number.isSafeInteger(pageSizeBytes) || pageSizeBytes < 1024 ||
    pageSizeBytes > MAX_LINUX_PAGE_SIZE_BYTES || (pageSizeBytes & (pageSizeBytes - 1)) !== 0
  ) {
    throw new SliverProvisionError("remote-command-failed", "The remote Linux page size was invalid");
  }
  return pageSizeBytes;
}

function parseSliverVersion(buffer: Buffer): string {
  const output = consumeText(buffer);
  const version = output.split(/\s+/u).find((token) => VERSION_PATTERN.test(token));
  if (version === undefined) {
    throw new SliverProvisionError("release-invalid", "The installed Sliver server returned an invalid version");
  }
  return version;
}

function zeroBuffers(buffers: Buffer[]): void {
  for (const buffer of buffers) buffer.fill(0);
}

function safeNonce(value: string): string {
  const compact = value.toLowerCase().replaceAll("-", "");
  if (!/^[0-9a-f]{16,64}$/u.test(compact)) invalidInput("The generated transfer nonce is invalid");
  return compact;
}

function withServerSideTimeout(localTimeoutMs: number, argv: readonly string[]): string[] {
  const headroomMs = Math.min(
    localTimeoutMs - 1,
    Math.max(
      (SERVER_TIMEOUT_KILL_AFTER_SECONDS + 1) * 1_000,
      Math.min(30_000, Math.floor(localTimeoutMs / 10)),
    ),
  );
  const remoteDeadlineMs = localTimeoutMs - headroomMs;
  const seconds = (remoteDeadlineMs / 1_000).toFixed(3).replace(/\.?0+$/u, "");
  return [
    "timeout",
    "--signal=TERM",
    `--kill-after=${SERVER_TIMEOUT_KILL_AFTER_SECONDS}s`,
    `${seconds}s`,
    ...argv,
  ];
}

function withAdaptiveServerSideTimeout(localTimeoutMs: number, argv: readonly string[]): string[] {
  // Keep both timeout's TERM grace and an additional scheduling margin inside
  // the local SSH watchdog. The proportional values keep this invariant true
  // for the deliberately tiny timeouts used by fake-host tests as well as the
  // multi-minute production transfer timeout.
  const safetyMarginMs = Math.min(15_000, Math.max(1, Math.floor(localTimeoutMs / 10)));
  const remainingMs = localTimeoutMs - safetyMarginMs;
  const killAfterMs = Math.min(15_000, Math.max(1, Math.floor(remainingMs / 4)));
  const remoteDeadlineMs = remainingMs - killAfterMs;
  if (remoteDeadlineMs < 1 || remoteDeadlineMs + killAfterMs >= localTimeoutMs) {
    invalidInput("The remote command timeout is invalid");
  }
  return [
    "timeout",
    "--signal=TERM",
    `--kill-after=${formatServerTimeoutDuration(killAfterMs)}`,
    formatServerTimeoutDuration(remoteDeadlineMs),
    ...argv,
  ];
}

function formatServerTimeoutDuration(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(3).replace(/\.?0+$/u, "")}s`;
}

function parseNumericIdentity(value: string, label: "user" | "group"): number {
  if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) {
    throw new SliverProvisionError("remote-command-failed", `The remote ${label} ID was invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new SliverProvisionError("remote-command-failed", `The remote ${label} ID was invalid`);
  }
  return parsed;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalidInput(`The ${label} is invalid`);
  return value;
}

function invalidInput(message: string): never {
  throw new SliverProvisionError("invalid-input", message);
}

function assertPrivateRegularFile(stats: Stats, exactSize: number | undefined, label: string): void {
  if ((stats.mode & FILE_TYPE_MASK) !== REGULAR_FILE_MODE || !stats.isFile() || stats.isSymbolicLink()) {
    throw new SliverProvisionError("remote-transfer-failed", `${label} is not a regular file`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new SliverProvisionError("remote-transfer-failed", `${label} permissions are not private`);
  }
  if (exactSize !== undefined && stats.size !== exactSize) {
    throw new SliverProvisionError("remote-transfer-failed", `${label} size did not match`);
  }
}

function sftpOpen(sftp: SFTPWrapper, path: string, flags: "r" | "wx", mode?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | undefined, handle: Buffer): void => {
      if (error) reject(new SliverProvisionError("remote-transfer-failed", "Could not open a remote deployment file"));
      else resolve(handle);
    };
    if (mode === undefined) sftp.open(path, flags, callback);
    else sftp.open(path, flags, mode, callback);
  });
}

function sftpClose(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (error) => error
      ? reject(new SliverProvisionError("remote-transfer-failed", "Could not close a remote deployment file"))
      : resolve());
  });
}

function sftpFstat(sftp: SFTPWrapper, handle: Buffer): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.fstat(handle, (error, stats) => error
      ? reject(new SliverProvisionError("remote-transfer-failed", "Could not inspect a remote deployment file"))
      : resolve(stats));
  });
}

function sftpWrite(
  sftp: SFTPWrapper,
  handle: Buffer,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.write(handle, buffer, 0, length, position, (error) => error
      ? reject(new SliverProvisionError("remote-transfer-failed", "Could not write a remote deployment file"))
      : resolve());
  });
}

function sftpRead(
  sftp: SFTPWrapper,
  handle: Buffer,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    sftp.read(handle, buffer, offset, length, position, (error, bytesRead) => error
      ? reject(new SliverProvisionError("remote-transfer-failed", "Could not read a remote deployment file"))
      : resolve(bytesRead));
  });
}

function unlinkRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (error) => error
      ? reject(new SliverProvisionError("remote-transfer-failed", "Could not remove a temporary remote deployment file"))
      : resolve());
  });
}

interface TimeoutLifecycle<T> {
  readonly onTimeout?: () => void;
  readonly disposeLateValue?: (value: T) => void;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: SliverProvisionErrorCode,
  message: string,
  lifecycle: TimeoutLifecycle<T> = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        lifecycle.onTimeout?.();
      } catch {
        // Timeout teardown is best-effort and must not replace the bounded error.
      }
      reject(new SliverProvisionError(code, message));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) {
          try {
            lifecycle.disposeLateValue?.(value);
          } catch {
            // A late value is already outside the caller's ownership.
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class TransferAbortedError extends Error {
  constructor() {
    super("The remote file transfer was aborted");
    this.name = "TransferAbortedError";
  }
}

function abortableTransfer<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  disposeLateValue?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(new TransferAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) {
          try {
            disposeLateValue?.(value);
          } catch {
            // The aborted operation no longer has a caller to own this value.
          }
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function throwIfTransferAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new TransferAbortedError();
}

function endSftpSafely(sftp: SFTPWrapper | undefined): void {
  if (sftp === undefined) return;
  try {
    sftp.end();
  } catch {
    // The channel is already unusable; SSH teardown follows on timeouts.
  }
}
