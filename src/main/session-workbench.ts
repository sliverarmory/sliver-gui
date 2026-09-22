import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { clientpb, commonpb, sliverpb } from "sliver-script";

import type { SliverClientAdapter } from "./sliver-client-adapter.js";
import {
  SESSION_EDITOR_MAX_BYTES,
  SESSION_WORKBENCH_DEFAULT_PAGE_LIMIT,
  SESSION_WORKBENCH_MAX_ARTIFACT_BYTES,
  SESSION_WORKBENCH_MAX_COMPLETE_FILE_BYTES,
  SESSION_WORKBENCH_MAX_PAGE_LIMIT,
  SESSION_WORKBENCH_MAX_PATH_LENGTH,
  SESSION_WORKBENCH_MAX_TEXT_LENGTH,
  isSensitiveSessionEnvironmentName,
  parseSessionWorkbenchInput,
  sessionOperationSupportsPlatform,
  type SessionArtifactPreview,
  type SessionBoundedPage,
  type SessionCapturedArtifactResult,
  type SessionDirectoryListing,
  type SessionEnvironmentEntry,
  type SessionEnvironmentRevealResult,
  type SessionFileEntry,
  type SessionGrepMatch,
  type SessionHexFileView,
  type SessionLootAddResult,
  type SessionMemoryFile,
  type SessionMount,
  type SessionMutationResult,
  type SessionNativeOpenUploadResult,
  type SessionNativeSaveResult,
  type SessionNetworkConnection,
  type SessionNetworkInterface,
  type SessionPageRequest,
  type SessionProcess,
  type SessionRegistryReadResult,
  type SessionService,
  type SessionStoredArtifact,
  type SessionStagedEditorArtifactResult,
  type SessionTargetPlatform,
  type SessionTextFileView,
  type SessionWorkbenchInput,
  type SessionWorkbenchOperationId,
  type SessionWorkbenchResult,
} from "../shared/session-contracts.js";
import { parseSessionProcessQuery, sessionProcessMatchesQuery } from "../shared/session-process-query.js";

const MAX_NESTED_ITEMS = 64;
const MAX_SHORT_TEXT_LENGTH = 4_096;
const MAX_REMOTE_ERROR_LENGTH = 1_024;
const ENVIRONMENT_REVEAL_TTL_MILLISECONDS = 30_000;
const SCREENSHOT_PREVIEW_MAX_BYTES = 8 * 1_024 * 1_024;
const PORTABLE_BASENAME_MAX_BYTES = 180;
const ARTIFACT_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UNSAFE_FILENAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff<>:"/\\|?*]/gu;
const WINDOWS_DEVICE_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/iu;

type SessionWorkbenchClientMethod =
  | "currentTokenOwnerSession"
  | "listEnvSession"
  | "revealEnvSession"
  | "ifconfigSession"
  | "netstatSession"
  | "pwdSession"
  | "cdSession"
  | "lsSession"
  | "downloadFileSession"
  | "lootAdd"
  | "uploadSession"
  | "grepSession"
  | "mkdirSession"
  | "mountsSession"
  | "memfilesListSession"
  | "memfilesAddSession"
  | "chmodSession"
  | "chownSession"
  | "chtimesSession"
  | "psSession"
  | "processDumpSession"
  | "screenshotSession"
  | "servicesSession"
  | "serviceDetailSession"
  | "startServiceSession"
  | "registryReadSession"
  | "registryListSubkeysSession"
  | "registryListValuesSession"
  | "registryReadHiveSession";

export type SessionWorkbenchClient = Pick<SliverClientAdapter, SessionWorkbenchClientMethod>;

export interface SessionWorkbenchTarget {
  readonly sessionId: string;
  readonly hostId: string;
  readonly platform: SessionTargetPlatform;
  readonly username: string;
  readonly uid?: string;
  readonly gid?: string;
  readonly pid?: number;
  readonly executable: string;
  readonly hostname: string;
  readonly os: string;
  readonly arch: string;
}

export interface SessionPreparedNativeSave {
  /** Opaque main-owned capability. The workbench only returns it to the gateway that minted it. */
  readonly capability: object;
}

export interface SessionPreparedStoredArtifactSave extends SessionPreparedNativeSave {
  readonly suggestedBasename: string;
  readonly size: number;
  readonly sha256: string;
}

export interface SessionOpenedUpload {
  /** Main-owned bytes. The workbench always clears this Buffer after the upload attempt. */
  readonly data: Buffer;
  readonly suggestedBasename: string;
}

export interface SessionWorkbenchArtifactGateway {
  /** Opens the native save dialog. `null` means the operator canceled before any remote RPC. */
  prepareNativeSave(input: {
    readonly operationId:
      | "session.filesystem.download"
      | "session.process.dump"
      | "session.registry.read-hive";
    readonly suggestedBasename: string;
    readonly mediaType: string;
  }): Promise<SessionPreparedNativeSave | null> | SessionPreparedNativeSave | null;
  /** Writes borrowed bytes, and must not retain the Buffer after the promise settles. */
  writeNativeSave(
    prepared: SessionPreparedNativeSave,
    input: {
      readonly data: Buffer;
      readonly suggestedBasename: string;
      readonly mediaType: string;
      readonly sha256: string;
    },
  ): Promise<void> | void;
  /** Opens and reads a local selection before upload. It must never return a local path. */
  prepareUploadOpen(input: {
    readonly operationId: "session.filesystem.upload-open";
    readonly maximumBytes: number;
  }): Promise<SessionOpenedUpload | null> | SessionOpenedUpload | null;
  /** Takes ownership of screenshot bytes on success and publishes a bounded preview. */
  captureScreenshot(input: {
    readonly data: Buffer;
    readonly suggestedBasename: string;
    readonly mediaType: "image/jpeg" | "image/png" | "image/webp";
    readonly sha256: string;
  }): Promise<SessionCapturedArtifactResult> | SessionCapturedArtifactResult;
  /**
   * Stages borrowed editor bytes as a main-owned artifact. The gateway must clone or
   * take ownership before settling and must never retain the source Buffer.
   */
  stageEditorArtifact(input: {
    readonly data: Buffer;
    readonly suggestedBasename: string;
    readonly mediaType: "text/plain" | "application/octet-stream";
    readonly sha256: string;
  }): Promise<SessionStoredArtifact> | SessionStoredArtifact;
  /** Opens the native save dialog for an existing main-owned artifact. */
  prepareStoredArtifactSave(
    handle: string,
  ): Promise<SessionPreparedStoredArtifactSave | null> | SessionPreparedStoredArtifactSave | null;
  writeStoredArtifact(prepared: SessionPreparedStoredArtifactSave): Promise<void> | void;
}

export interface SessionWorkbenchOptions {
  readonly now?: () => number;
  /** Main-process journal hook invoked immediately before each target RPC. */
  readonly onDispatch?: (operationId: SessionWorkbenchOperationId) => void;
  /** Main-process journal hook invoked immediately before a direct mutation RPC. */
  readonly onMutationDispatch?: (operationId: SessionWorkbenchOperationId) => void;
}

export class SessionWorkbenchPlatformError extends Error {
  constructor(operationId: SessionWorkbenchOperationId, platform: string) {
    super(`${operationId} is not supported on ${platform}`);
    this.name = "SessionWorkbenchPlatformError";
  }
}

export class SessionWorkbenchRemoteError extends Error {
  constructor(label: string) {
    super(`${label} was rejected by the target`);
    this.name = "SessionWorkbenchRemoteError";
  }
}

/**
 * Pure main-process execution and normalization boundary for direct M2 session operations.
 * It never returns protobuf objects, local paths, or raw artifact Buffers.
 */
export class SessionWorkbench {
  private readonly now: () => number;
  private readonly onDispatch: ((operationId: SessionWorkbenchOperationId) => void) | undefined;
  private readonly onMutationDispatch: ((operationId: SessionWorkbenchOperationId) => void) | undefined;

  constructor(
    private readonly client: SessionWorkbenchClient,
    private readonly artifacts: SessionWorkbenchArtifactGateway,
    options: SessionWorkbenchOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.onDispatch = options.onDispatch;
    this.onMutationDispatch = options.onMutationDispatch;
  }

  async run(targetInput: SessionWorkbenchTarget, inputValue: SessionWorkbenchInput): Promise<SessionWorkbenchResult> {
    const target = normalizeTarget(targetInput);
    const input = parseSessionWorkbenchInput(inputValue);
    if (!sessionOperationSupportsPlatform(input.operationId, target.platform)) {
      throw new SessionWorkbenchPlatformError(input.operationId, target.platform);
    }

    switch (input.operationId) {
      case "session.identity.current-token-owner": {
        const response = await this.remote(input.operationId, () =>
          this.client.currentTokenOwnerSession(target.sessionId));
        assertImplantResponse(response, "Current token owner");
        return {
          operationId: input.operationId,
          value: {
            tokenOwner: boundedText(response.Output),
            username: target.username,
            ...(target.uid === undefined ? {} : { uid: target.uid }),
            ...(target.gid === undefined ? {} : { gid: target.gid }),
            ...(target.pid === undefined ? {} : { pid: target.pid }),
            executable: target.executable,
            hostname: target.hostname,
            os: target.os,
            arch: target.arch,
          },
        };
      }
      case "session.environment.list": {
        const response = await this.remote(input.operationId, () => this.client.listEnvSession(target.sessionId));
        assertImplantResponse(response, "Environment listing");
        const value = boundedPage(response.Variables, input, (variable): SessionEnvironmentEntry => {
          const name = boundedText(variable.Key, 512);
          if (isSensitiveSessionEnvironmentName(name)) {
            return { name, sensitive: true, redacted: true };
          }
          return {
            name,
            value: boundedText(variable.Value),
            sensitive: false,
            redacted: false,
          };
        });
        return { operationId: input.operationId, value };
      }
      case "session.environment.reveal": {
        const response = await this.remote(input.operationId, () =>
          this.client.revealEnvSession(target.sessionId, input.name));
        assertImplantResponse(response, "Environment reveal");
        const variable = response.Variables.find(({ Key }) => Key === input.name);
        if (!variable) throw new SessionWorkbenchRemoteError("Environment variable");
        const revealedAtMilliseconds = this.currentTime();
        const value: SessionEnvironmentRevealResult = {
          name: boundedText(variable.Key, 512),
          value: boundedText(variable.Value),
          sensitive: isSensitiveSessionEnvironmentName(variable.Key),
          revealedAt: new Date(revealedAtMilliseconds).toISOString(),
          expiresAt: new Date(revealedAtMilliseconds + ENVIRONMENT_REVEAL_TTL_MILLISECONDS).toISOString(),
        };
        return { operationId: input.operationId, value };
      }
      case "session.network.interfaces": {
        const response = await this.remote(input.operationId, () => this.client.ifconfigSession(target.sessionId));
        assertImplantResponse(response, "Network interface listing");
        const value = boundedPage(response.NetInterfaces, input, normalizeNetworkInterface);
        return { operationId: input.operationId, value };
      }
      case "session.network.connections": {
        const response = await this.remote(input.operationId, () =>
          this.client.netstatSession(target.sessionId, {
            tcp: input.tcp,
            udp: input.udp,
            ip4: input.ip4,
            ip6: input.ip6,
            listening: input.listening,
          }));
        assertImplantResponse(response, "Network connection listing");
        const value = boundedPage(response.Entries, input, normalizeNetworkConnection);
        return { operationId: input.operationId, value };
      }
      case "session.filesystem.pwd": {
        const response = await this.remote(input.operationId, () => this.client.pwdSession(target.sessionId));
        assertImplantResponse(response, "Working directory");
        return { operationId: input.operationId, value: { path: boundedPath(response.Path) } };
      }
      case "session.filesystem.ls": {
        const response = await this.remote(input.operationId, () => this.client.lsSession(target.sessionId, input.path));
        assertImplantResponse(response, "Directory listing");
        const path = boundedPath(response.Path || input.path);
        const page = boundedPage(
          response.Files.filter((file) => file.Name !== "."),
          input,
          (file) => normalizeFileEntry(file, path),
        );
        const value: SessionDirectoryListing = {
          path,
          exists: response.Exists,
          items: page.items,
          page: page.page,
          ...optionalBoundedText("timezone", response.timezone, 128),
          ...optionalTimezoneOffset(response.timezoneOffset),
        };
        return { operationId: input.operationId, value };
      }
      case "session.filesystem.cat":
      case "session.filesystem.head":
      case "session.filesystem.tail":
        return {
          operationId: input.operationId,
          value: await this.readTextFile(
            target,
            input.path,
            input.maxBytes,
            input.operationId.slice("session.filesystem.".length) as SessionTextFileView["mode"],
            input.operationId,
          ),
        };
      case "session.filesystem.read-hex":
        return {
          operationId: input.operationId,
          value: await this.readHexFile(target, input.path, input.maxBytes),
        };
      case "session.filesystem.grep": {
        const response = await this.remote(input.operationId, () =>
          this.client.grepSession(target.sessionId, input.path, input.pattern, {
            recursive: input.recursive,
            linesBefore: input.linesBefore,
            linesAfter: input.linesAfter,
          }));
        assertImplantResponse(response, "File search");
        const value = boundedPage(grepMatches(response.Results), input, normalizeGrepMatch);
        return { operationId: input.operationId, value };
      }
      case "session.filesystem.mounts": {
        const response = await this.remote(input.operationId, () => this.client.mountsSession(target.sessionId));
        assertImplantResponse(response, "Mount listing");
        const value = boundedPage(response.Info, input, normalizeMount);
        return { operationId: input.operationId, value };
      }
      case "session.filesystem.memfiles.list": {
        const response = await this.remote(input.operationId, () => this.client.memfilesListSession(target.sessionId));
        assertImplantResponse(response, "Memory file listing");
        const value = boundedPage(
          response.Files,
          input,
          (file): SessionMemoryFile => ({
            fd: boundedText(file.Name, 128),
            name: boundedText(file.Link || file.Name, MAX_SHORT_TEXT_LENGTH),
            sizeBytes: unsignedDecimal(file.Size),
          }),
          (file) => file.fd !== ".",
        );
        return { operationId: input.operationId, value };
      }
      case "session.process.list": {
        const response = await this.remote(input.operationId, () =>
          this.client.psSession(target.sessionId, input.fullInfo));
        assertImplantResponse(response, "Process listing");
        const query = parseSessionProcessQuery(input.query);
        const value = boundedPage(response.Processes, input, normalizeProcess, (process) =>
          sessionProcessMatchesQuery(process, query),
        );
        return { operationId: input.operationId, value };
      }
      case "session.service.list": {
        const response = await this.remote(input.operationId, () => this.client.servicesSession(target.sessionId));
        assertImplantResponse(response, "Service listing");
        if (response.Error && response.Details.length === 0) {
          throw new SessionWorkbenchRemoteError("Service listing");
        }
        const query = input.query?.trim().toLocaleLowerCase();
        const partial = Boolean(response.Error);
        const value = boundedPage(
          response.Details,
          input,
          (detail) => normalizeService(detail, partial ? "Inventory may be incomplete" : undefined),
          (service) => !query || serviceMatchesQuery(service, query),
        );
        return { operationId: input.operationId, value };
      }
      case "session.service.detail": {
        const response = await this.remote(input.operationId, () =>
          this.client.serviceDetailSession(target.sessionId, input.name));
        assertImplantResponse(response, "Service detail");
        if (!response.Detail) throw new SessionWorkbenchRemoteError("Service detail");
        return {
          operationId: input.operationId,
          value: normalizeService(
            response.Detail,
            response.Message ? "The target reported partial service details" : undefined,
          ),
        };
      }
      case "session.registry.read": {
        const response = await this.remote(input.operationId, () =>
          this.client.registryReadSession(
            target.sessionId,
            input.hive,
            input.path,
            input.key,
          ));
        try {
          assertImplantResponse(response, "Registry read");
          const read = normalizeRegistryRead(response);
          const value: SessionRegistryReadResult = {
            hive: input.hive,
            path: boundedPath(input.path),
            key: boundedText(input.key, 512),
            ...read,
          };
          return { operationId: input.operationId, value };
        } finally {
          // Raw registry bytes stay in main and are cleared whether the agent
          // returned a usable value, an error, or an unsupported future type.
          if (Buffer.isBuffer(response.Binary)) response.Binary.fill(0);
        }
      }
      case "session.registry.list-subkeys": {
        const response = await this.remote(input.operationId, () =>
          this.client.registryListSubkeysSession(target.sessionId, input.hive, input.path));
        assertImplantResponse(response, "Registry subkey listing");
        const value = boundedPage(response.Subkeys, input, (item) => boundedText(item, MAX_SHORT_TEXT_LENGTH));
        return { operationId: input.operationId, value };
      }
      case "session.registry.list-values": {
        const response = await this.remote(input.operationId, () =>
          this.client.registryListValuesSession(target.sessionId, input.hive, input.path));
        assertImplantResponse(response, "Registry value listing");
        const value = boundedPage(response.ValueNames, input, (item) => boundedText(item, 512));
        return { operationId: input.operationId, value };
      }
      case "session.filesystem.cd": {
        this.mutationDispatch(input.operationId);
        const response = await this.remote(input.operationId, () => this.client.cdSession(target.sessionId, input.path));
        assertImplantResponse(response, "Change directory");
        return { operationId: input.operationId, value: { path: boundedPath(response.Path || input.path) } };
      }
      case "session.filesystem.mkdir": {
        this.mutationDispatch(input.operationId);
        const response = await this.remote(input.operationId, () =>
          this.client.mkdirSession(target.sessionId, input.path));
        assertImplantResponse(response, "Create directory");
        const value: SessionMutationResult = {
          changed: true,
          message: "Directory created",
          path: boundedPath(response.Path || input.path),
        };
        return { operationId: input.operationId, value };
      }
      case "session.filesystem.memfiles.add": {
        this.mutationDispatch(input.operationId);
        const response = await this.remote(input.operationId, () => this.client.memfilesAddSession(target.sessionId));
        assertImplantResponse(response, "Create memory file");
        const value: SessionMutationResult = {
          changed: true,
          message: "Memory file created",
          fd: unsignedDecimal(response.Fd),
        };
        return { operationId: input.operationId, value };
      }
      case "session.filesystem.chmod": {
        this.mutationDispatch(input.operationId);
        const response = await this.remote(input.operationId, () =>
          this.client.chmodSession(
            target.sessionId,
            input.path,
            input.fileMode,
            false,
          ));
        assertImplantResponse(response, "Change file mode");
        return {
          operationId: input.operationId,
          value: mutation("File mode changed", response.Path || input.path),
        };
      }
      case "session.filesystem.chown": {
        this.mutationDispatch(input.operationId);
        const response = await this.remote(input.operationId, () =>
          this.client.chownSession(
            target.sessionId,
            input.path,
            input.uid,
            input.gid,
            false,
          ));
        assertImplantResponse(response, "Change file ownership");
        return {
          operationId: input.operationId,
          value: mutation("File ownership changed", response.Path || input.path),
        };
      }
      case "session.filesystem.chtimes": {
        this.mutationDispatch(input.operationId);
        const response = await this.remote(input.operationId, () =>
          this.client.chtimesSession(
            target.sessionId,
            input.path,
            input.accessTime,
            input.modificationTime,
          ));
        assertImplantResponse(response, "Change file timestamps");
        return {
          operationId: input.operationId,
          value: mutation("File timestamps changed", response.Path || input.path),
        };
      }
      case "session.service.start": {
        this.mutationDispatch(input.operationId);
        const started = await this.remote(input.operationId, () =>
          this.client.startServiceSession(target.sessionId, input.name));
        assertImplantResponse(started, "Start service");
        try {
          const response = await this.remote(input.operationId, () =>
            this.client.serviceDetailSession(target.sessionId, input.name));
          assertImplantResponse(response, "Service detail");
          if (!response.Detail) throw new SessionWorkbenchRemoteError("Service detail");
          return {
            operationId: input.operationId,
            value: normalizeService(
              response.Detail,
              response.Message ? "The target reported partial service details" : undefined,
            ),
          };
        } catch {
          // The start response is authoritative. A best-effort follow-up detail
          // read must not turn a confirmed mutation into outcome-unknown.
          return {
            operationId: input.operationId,
            value: {
              name: boundedText(input.name, MAX_SHORT_TEXT_LENGTH),
              displayName: boundedText(input.name, MAX_SHORT_TEXT_LENGTH),
              description: "",
              status: 0,
              startupType: 0,
              binaryPath: "",
              account: "",
              message: "Service start was accepted; refreshed service details are unavailable",
            },
          };
        }
      }
      case "session.screenshot.capture":
        return {
          operationId: input.operationId,
          value: await this.captureScreenshot(target),
        };
      case "session.artifact.save":
        return {
          operationId: input.operationId,
          value: await this.saveStoredArtifact(input.handle),
        };
      case "session.filesystem.download":
        return {
          operationId: input.operationId,
          value: await this.downloadFile(target, input.path, input.maxBytes),
        };
      case "session.filesystem.add-to-loot":
        return {
          operationId: input.operationId,
          value: await this.addFileToLoot(target, input.path, input.maxBytes),
        };
      case "session.filesystem.upload-open":
        return {
          operationId: input.operationId,
          value: await this.uploadOpenedFile(target, input),
        };
      case "session.filesystem.stage-text":
        return {
          operationId: input.operationId,
          value: await this.stageEditorText(input.content),
        };
      case "session.filesystem.stage-hex":
        return {
          operationId: input.operationId,
          value: await this.stageEditorHex(input.hex),
        };
      case "session.process.dump":
        return {
          operationId: input.operationId,
          value: await this.dumpProcess(target, input.pid, input.dumpTimeoutSeconds),
        };
      case "session.registry.read-hive":
        return {
          operationId: input.operationId,
          value: await this.readRegistryHive(
            target,
            input.rootHive,
            input.requestedHive,
            input.maxBytes,
          ),
        };
    }
  }

  private async readTextFile(
    target: NormalizedTarget,
    remotePath: string,
    maximumBytes: number,
    mode: SessionTextFileView["mode"],
    operationId: "session.filesystem.cat" | "session.filesystem.head" | "session.filesystem.tail",
  ): Promise<SessionTextFileView> {
    const requestBytes = editorRequestByteCount(maximumBytes);
    const response = await this.remote(operationId, () =>
      this.client.downloadFileSession(target.sessionId, remotePath, {
        maxBytes: requestBytes,
        fromEnd: mode === "tail",
      }));
    assertImplantResponse(response, "File view");
    if (!response.Exists || response.IsDir) throw new SessionWorkbenchRemoteError("File view");
    const data = artifactBuffer(response.Data, requestBytes, "File view");
    try {
      const truncated = data.length > maximumBytes;
      const visible = truncated && mode === "tail"
        ? data.subarray(data.length - maximumBytes)
        : data.subarray(0, Math.min(data.length, maximumBytes));
      const decoded = strictEditorText(visible, truncated, mode);
      return {
        path: boundedPath(response.Path || remotePath),
        mode,
        encoding: "utf-8",
        content: decoded.content,
        bytesRead: decoded.bytesRead,
        truncated,
        ...(truncated ? {} : { sha256: sha256Hex(data) }),
      };
    } finally {
      data.fill(0);
    }
  }

  private async readHexFile(
    target: NormalizedTarget,
    remotePath: string,
    maximumBytes: number,
  ): Promise<SessionHexFileView> {
    const requestBytes = editorRequestByteCount(maximumBytes);
    const response = await this.remote("session.filesystem.read-hex", () =>
      this.client.downloadFileSession(target.sessionId, remotePath, {
        maxBytes: requestBytes,
        fromEnd: false,
      }));
    assertImplantResponse(response, "Hex file view");
    if (!response.Exists || response.IsDir) throw new SessionWorkbenchRemoteError("Hex file view");
    const data = artifactBuffer(response.Data, requestBytes, "Hex file view");
    try {
      const truncated = data.length > maximumBytes;
      const visible = data.subarray(0, Math.min(data.length, maximumBytes));
      return {
        path: boundedPath(response.Path || remotePath),
        hex: visible.toString("hex"),
        bytesRead: visible.length,
        truncated,
        ...(truncated ? {} : { sha256: sha256Hex(data) }),
      };
    } finally {
      data.fill(0);
    }
  }

  private async stageEditorText(content: string): Promise<SessionStagedEditorArtifactResult> {
    return await this.stageEditorBytes(Buffer.from(content, "utf8"), "edited-text.txt", "text/plain");
  }

  private async stageEditorHex(hex: string): Promise<SessionStagedEditorArtifactResult> {
    return await this.stageEditorBytes(Buffer.from(hex, "hex"), "edited-bytes.bin", "application/octet-stream");
  }

  private async stageEditorBytes(
    data: Buffer,
    suggestedBasename: string,
    mediaType: "text/plain" | "application/octet-stream",
  ): Promise<SessionStagedEditorArtifactResult> {
    if (data.length > SESSION_EDITOR_MAX_BYTES) {
      data.fill(0);
      throw new Error("Editor content exceeds the session workbench limit");
    }
    const size = data.length;
    const sha256 = sha256Hex(data);
    try {
      const artifact = normalizeStoredArtifact(await this.artifacts.stageEditorArtifact({
        data,
        suggestedBasename,
        mediaType,
        sha256,
      }));
      if (artifact.size !== size || artifact.sha256 !== sha256 || artifact.mediaType !== mediaType) {
        throw new Error("Editor artifact gateway returned mismatched metadata");
      }
      return { status: "staged", artifact };
    } finally {
      data.fill(0);
    }
  }

  private async captureScreenshot(target: NormalizedTarget): Promise<SessionCapturedArtifactResult> {
    const response = await this.remote("session.screenshot.capture", () =>
      this.client.screenshotSession(target.sessionId));
    assertImplantResponse(response, "Screenshot");
    const data = artifactBuffer(response.Data, SCREENSHOT_PREVIEW_MAX_BYTES, "Screenshot");
    const mediaType = imageMediaType(data);
    const sha256 = sha256Hex(data);
    let transferred = false;
    try {
      const result = await this.artifacts.captureScreenshot({
        data,
        suggestedBasename: `screenshot-${safeBasename(target.sessionId, "session")}.${imageExtension(mediaType)}`,
        mediaType,
        sha256,
      });
      transferred = true;
      return normalizeCapturedArtifact(result, data.length, sha256, mediaType);
    } finally {
      if (!transferred) data.fill(0);
    }
  }

  private async saveStoredArtifact(handle: string): Promise<SessionNativeSaveResult> {
    if (!ARTIFACT_HANDLE_PATTERN.test(handle)) throw new Error("Invalid session artifact handle");
    const prepared = await this.artifacts.prepareStoredArtifactSave(handle);
    if (!prepared) return { status: "canceled" };
    const result = normalizeNativeSaveResult({
      status: "saved",
      suggestedBasename: prepared.suggestedBasename,
      size: prepared.size,
      sha256: prepared.sha256,
    });
    await this.artifacts.writeStoredArtifact(prepared);
    return result;
  }

  private async downloadFile(
    target: NormalizedTarget,
    remotePath: string,
    maximumBytes: number,
  ): Promise<SessionNativeSaveResult> {
    const suggestedBasename = safeBasename(remotePath, "download.bin");
    const prepared = await this.artifacts.prepareNativeSave({
      operationId: "session.filesystem.download",
      suggestedBasename,
      mediaType: "application/octet-stream",
    });
    if (!prepared) return { status: "canceled" };
    const response = await this.remote("session.filesystem.download", () =>
      this.client.downloadFileSession(target.sessionId, remotePath, {
        maxBytes: completeArtifactRequestByteCount(maximumBytes),
      }));
    assertImplantResponse(response, "Download");
    if (!response.Exists || response.IsDir) throw new SessionWorkbenchRemoteError("Download");
    const data = completeArtifactBuffer(response.Data, maximumBytes, "Download");
    return await this.writeNativeArtifact(prepared, data, suggestedBasename, "application/octet-stream");
  }

  private async addFileToLoot(
    target: NormalizedTarget,
    remotePath: string,
    maximumBytes: number,
  ): Promise<SessionLootAddResult> {
    // Download is a read-only preflight, not submission of the outcome-unknown
    // LootAdd mutation. The mutation dispatch hook below revalidates the exact
    // target and backend before the first journaled remote-state write.
    const response = await this.client.downloadFileSession(
      target.sessionId,
      remotePath,
      { maxBytes: completeArtifactRequestByteCount(maximumBytes) },
    );
    try {
      assertImplantResponse(response, "Download for loot");
      if (!response.Exists || response.IsDir) throw new SessionWorkbenchRemoteError("Download for loot");
      const data = completeArtifactBuffer(response.Data, maximumBytes, "Download for loot");
      const fileName = safeBasename(response.Path || remotePath, "loot.bin");
      const fileType = isProbablyTextLoot(data) ? "text" : "binary";
      const size = data.length;
      const sha256 = sha256Hex(data);
      const loot = clientpb.Loot.create({
        Name: fileName,
        OriginHostUUID: target.hostId,
        FileType: fileType === "text" ? clientpb.FileType.TEXT : clientpb.FileType.BINARY,
        File: commonpb.File.create({ Name: fileName, Data: data }),
      });
      let added: clientpb.Loot | undefined;
      try {
        this.mutationDispatch("session.filesystem.add-to-loot");
        added = await this.remote("session.filesystem.add-to-loot", () =>
          this.client.lootAdd(loot));
        return { status: "added", fileName, fileType, size, sha256 };
      } finally {
        added?.File?.Data.fill(0);
      }
    } finally {
      if (Buffer.isBuffer(response.Data)) response.Data.fill(0);
    }
  }

  private async uploadOpenedFile(
    target: NormalizedTarget,
    input: Extract<SessionWorkbenchInput, { operationId: "session.filesystem.upload-open" }>,
  ): Promise<SessionNativeOpenUploadResult> {
    const opened = await this.artifacts.prepareUploadOpen({
      operationId: input.operationId,
      maximumBytes: SESSION_WORKBENCH_MAX_ARTIFACT_BYTES,
    });
    if (!opened) return { status: "canceled" };
    if (!Buffer.isBuffer(opened.data) || opened.data.length > SESSION_WORKBENCH_MAX_ARTIFACT_BYTES) {
      if (Buffer.isBuffer(opened.data)) opened.data.fill(0);
      throw new Error("Selected upload exceeds the session workbench limit");
    }
    const suggestedBasename = safeBasename(opened.suggestedBasename, "upload.bin");
    const size = opened.data.length;
    const sha256 = sha256Hex(opened.data);
    try {
      this.mutationDispatch(input.operationId);
      const response = await this.remote(input.operationId, () =>
        this.client.uploadSession(target.sessionId, input.remotePath, opened.data, {
          isIOC: input.isIOC,
          fileName: suggestedBasename,
          isDirectory: input.isDirectory,
          overwrite: false,
        }));
      assertImplantResponse(response, "Upload");
      return {
        status: "uploaded",
        remotePath: boundedPath(response.Path || input.remotePath),
        suggestedBasename,
        size,
        sha256,
        message: "Upload completed",
      };
    } finally {
      opened.data.fill(0);
    }
  }

  private async dumpProcess(
    target: NormalizedTarget,
    pid: number,
    timeoutSeconds: number,
  ): Promise<SessionNativeSaveResult> {
    const suggestedBasename = `process-${pid}.dmp`;
    const prepared = await this.artifacts.prepareNativeSave({
      operationId: "session.process.dump",
      suggestedBasename,
      mediaType: "application/octet-stream",
    });
    if (!prepared) return { status: "canceled" };
    const response = await this.remote("session.process.dump", () =>
      this.client.processDumpSession(
        target.sessionId,
        pid,
        timeoutSeconds,
        timeoutSeconds + 30,
      ));
    assertImplantResponse(response, "Process dump");
    const data = artifactBuffer(response.Data, SESSION_WORKBENCH_MAX_ARTIFACT_BYTES, "Process dump");
    return await this.writeNativeArtifact(prepared, data, suggestedBasename, "application/octet-stream");
  }

  private async readRegistryHive(
    target: NormalizedTarget,
    rootHive: string,
    requestedHive: string,
    maximumBytes: number,
  ): Promise<SessionNativeSaveResult> {
    const suggestedBasename = `${safeBasename(requestedHive, rootHive)}.hive`;
    const prepared = await this.artifacts.prepareNativeSave({
      operationId: "session.registry.read-hive",
      suggestedBasename,
      mediaType: "application/octet-stream",
    });
    if (!prepared) return { status: "canceled" };
    const response = await this.remote("session.registry.read-hive", () =>
      this.client.registryReadHiveSession(
        target.sessionId,
        rootHive,
        requestedHive,
        maximumBytes,
      ));
    assertImplantResponse(response, "Registry hive read");
    const data = artifactBuffer(response.Data, maximumBytes, "Registry hive read");
    return await this.writeNativeArtifact(prepared, data, suggestedBasename, "application/octet-stream");
  }

  private async writeNativeArtifact(
    prepared: SessionPreparedNativeSave,
    data: Buffer,
    suggestedBasename: string,
    mediaType: string,
  ): Promise<SessionNativeSaveResult> {
    const size = data.length;
    const sha256 = sha256Hex(data);
    try {
      await this.artifacts.writeNativeSave(prepared, { data, suggestedBasename, mediaType, sha256 });
      return { status: "saved", suggestedBasename, size, sha256 };
    } finally {
      data.fill(0);
    }
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_639_999_999_970_000) {
      throw new TypeError("Session workbench clock returned an invalid timestamp");
    }
    return value;
  }

  private async remote<TResult>(
    operationId: SessionWorkbenchOperationId,
    invoke: () => Promise<TResult>,
  ): Promise<TResult> {
    this.onDispatch?.(operationId);
    return await invoke();
  }

  private mutationDispatch(operationId: SessionWorkbenchOperationId): void {
    this.onMutationDispatch?.(operationId);
  }
}

interface NormalizedTarget extends SessionWorkbenchTarget {}

function normalizeTarget(target: SessionWorkbenchTarget): NormalizedTarget {
  if (!target || typeof target !== "object") throw new TypeError("Session workbench target is required");
  if (!/^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,128}$/u.test(target.sessionId)) {
    throw new TypeError("Session ID is invalid");
  }
  if (!(["windows", "linux", "darwin"] as const).includes(target.platform)) {
    throw new TypeError("Session platform is invalid");
  }
  const pid = optionalPositiveInteger(target.pid);
  return Object.freeze({
    sessionId: target.sessionId,
    hostId: boundedText(target.hostId, 128),
    platform: target.platform,
    username: boundedText(target.username, MAX_SHORT_TEXT_LENGTH),
    ...optionalTargetText("uid", target.uid, 128),
    ...optionalTargetText("gid", target.gid, 128),
    ...(pid === undefined ? {} : { pid }),
    executable: boundedText(target.executable, SESSION_WORKBENCH_MAX_PATH_LENGTH),
    hostname: boundedText(target.hostname, MAX_SHORT_TEXT_LENGTH),
    os: boundedText(target.os, 128),
    arch: boundedText(target.arch, 128),
  });
}

function boundedPage<TSource, TResult>(
  source: Iterable<TSource>,
  request: SessionPageRequest,
  normalize: (item: TSource) => TResult,
  include: (item: TResult) => boolean = () => true,
): SessionBoundedPage<TResult> {
  const limit = request.limit ?? SESSION_WORKBENCH_DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_WORKBENCH_MAX_PAGE_LIMIT) {
    throw new TypeError("Session page limit is invalid");
  }
  const offset = decodeCursor(request.cursor);
  const items: TResult[] = [];
  let total = 0;
  for (const candidate of source) {
    const item = normalize(candidate);
    if (!include(item)) continue;
    if (total >= offset && items.length < limit) items.push(item);
    total += 1;
  }
  const nextOffset = offset + items.length;
  return {
    items,
    page: {
      limit,
      total,
      truncated: offset > 0 || nextOffset < total,
      ...(nextOffset < total ? { nextCursor: String(nextOffset) } : {}),
    },
  };
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(?:0|[1-9]\d{0,15})$/u.test(cursor)) throw new Error("Session page cursor is invalid");
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Session page cursor is invalid");
  return value;
}

function normalizeNetworkInterface(value: {
  Index: number;
  Name: string;
  MAC: string;
  IPAddresses: string[];
}): SessionNetworkInterface {
  return {
    index: nonNegativeInteger(value.Index),
    name: boundedText(value.Name, 512),
    macAddress: boundedText(value.MAC, 128),
    addresses: value.IPAddresses.slice(0, MAX_NESTED_ITEMS).map((address) => boundedText(address, 512)),
  };
}

function normalizeNetworkConnection(value: {
  LocalAddr?: { Ip: string; Port: number } | undefined;
  RemoteAddr?: { Ip: string; Port: number } | undefined;
  SkState: string;
  UID: number;
  Process?: Parameters<typeof normalizeProcess>[0] | undefined;
  Protocol: string;
}): SessionNetworkConnection {
  const uid = optionalNonNegativeInteger(value.UID);
  return {
    protocol: boundedText(value.Protocol, 64),
    state: boundedText(value.SkState, 128),
    ...(uid === undefined ? {} : { uid }),
    ...optionalSocketAddress("local", value.LocalAddr),
    ...optionalSocketAddress("remote", value.RemoteAddr),
    ...(value.Process === undefined ? {} : { process: normalizeProcess(value.Process) }),
  };
}

function normalizeFileEntry(
  value: {
    Name: string;
    IsDir: boolean;
    Size: string;
    ModTime: string;
    Mode: string;
    Link: string;
    Uid: string;
    Gid: string;
  },
  parentPath: string,
): SessionFileEntry {
  const name = strictRemoteChildName(value.Name);
  const modifiedAt = unixSecondsToIso(value.ModTime);
  return {
    name,
    path: joinRemotePath(parentPath, name),
    isDirectory: value.IsDir,
    sizeBytes: unsignedDecimal(value.Size),
    ...(modifiedAt === undefined ? {} : { modifiedAt }),
    mode: boundedText(value.Mode, 128),
    ...optionalBoundedText("linkTarget", value.Link, SESSION_WORKBENCH_MAX_PATH_LENGTH),
    ...optionalBoundedText("uid", value.Uid, 128),
    ...optionalBoundedText("gid", value.Gid, 128),
  };
}

interface RawGrepMatch {
  path: string;
  result: {
    LineNumber: string;
    Positions: Array<{ Start: number; End: number }>;
    Line: string;
    LinesBefore: string[];
    LinesAfter: string[];
  };
  binary: boolean;
}

function* grepMatches(
  results: Record<string, { FileResults: RawGrepMatch["result"][]; IsBinary: boolean }>,
): Generator<RawGrepMatch> {
  for (const path of Object.keys(results).sort()) {
    const file = results[path];
    if (!file) continue;
    for (const result of file.FileResults) yield { path, result, binary: file.IsBinary };
  }
}

function normalizeGrepMatch(value: RawGrepMatch): SessionGrepMatch {
  return {
    path: boundedPath(value.path),
    lineNumber: unsignedDecimal(value.result.LineNumber),
    line: boundedText(value.result.Line),
    positions: value.result.Positions.slice(0, MAX_NESTED_ITEMS).map((position) => ({
      start: nonNegativeInteger(position.Start),
      end: nonNegativeInteger(position.End),
    })),
    linesBefore: boundedTextArray(value.result.LinesBefore),
    linesAfter: boundedTextArray(value.result.LinesAfter),
    binary: value.binary,
  };
}

function normalizeMount(value: {
  VolumeName: string;
  VolumeType: string;
  MountPoint: string;
  Label: string;
  FileSystem: string;
  UsedSpace: string;
  FreeSpace: string;
  TotalSpace: string;
  MountOptions: string;
}): SessionMount {
  return {
    volumeName: boundedText(value.VolumeName, MAX_SHORT_TEXT_LENGTH),
    volumeType: boundedText(value.VolumeType, 128),
    mountPoint: boundedPath(value.MountPoint),
    label: boundedText(value.Label, MAX_SHORT_TEXT_LENGTH),
    filesystem: boundedText(value.FileSystem, 128),
    usedBytes: unsignedDecimal(value.UsedSpace),
    freeBytes: unsignedDecimal(value.FreeSpace),
    totalBytes: unsignedDecimal(value.TotalSpace),
    options: boundedText(value.MountOptions, MAX_SHORT_TEXT_LENGTH),
  };
}

function normalizeProcess(value: {
  Pid: number;
  Ppid: number;
  Executable: string;
  Owner: string;
  Architecture: string;
  SessionID: number;
  CmdLine: string[];
}): SessionProcess {
  const sessionId = optionalNonNegativeInteger(value.SessionID);
  return {
    pid: nonNegativeInteger(value.Pid),
    parentPid: nonNegativeInteger(value.Ppid),
    executable: boundedText(value.Executable, SESSION_WORKBENCH_MAX_PATH_LENGTH),
    owner: boundedText(value.Owner, MAX_SHORT_TEXT_LENGTH),
    architecture: boundedText(value.Architecture, 128),
    ...(sessionId === undefined ? {} : { sessionId }),
    commandLine: boundedTextArray(value.CmdLine, MAX_NESTED_ITEMS, MAX_SHORT_TEXT_LENGTH),
  };
}

function normalizeService(
  value: {
    Name: string;
    DisplayName: string;
    Description: string;
    Status: number;
    StartupType: number;
    BinPath: string;
    Account: string;
  },
  message?: string,
): SessionService {
  return {
    name: boundedText(value.Name, 512),
    displayName: boundedText(value.DisplayName, MAX_SHORT_TEXT_LENGTH),
    description: boundedText(value.Description),
    status: nonNegativeInteger(value.Status),
    startupType: nonNegativeInteger(value.StartupType),
    binaryPath: boundedPath(value.BinPath),
    account: boundedText(value.Account, MAX_SHORT_TEXT_LENGTH),
    ...(message === undefined ? {} : { message }),
  };
}

function serviceMatchesQuery(service: SessionService, query: string): boolean {
  return [service.name, service.displayName, service.description, service.binaryPath, service.account]
    .some((value) => value.toLocaleLowerCase().includes(query));
}

function assertImplantResponse(
  value: { Response?: { Err?: string | undefined } | undefined },
  label: string,
): void {
  const error = optionalText(value.Response?.Err, MAX_REMOTE_ERROR_LENGTH);
  if (error) throw new SessionWorkbenchRemoteError(label);
}

function mutation(message: string, path: string): SessionMutationResult {
  return { changed: true, message, path: boundedPath(path) };
}

function artifactBuffer(value: Buffer, maximumBytes: number, label: string): Buffer {
  if (!Buffer.isBuffer(value)) throw new TypeError(`${label} did not return a Buffer`);
  if (value.length > maximumBytes || value.length > SESSION_WORKBENCH_MAX_ARTIFACT_BYTES) {
    value.fill(0);
    throw new Error(`${label} exceeds the session workbench limit`);
  }
  return value;
}

function completeArtifactBuffer(value: Buffer, maximumBytes: number, label: string): Buffer {
  const data = artifactBuffer(value, completeArtifactRequestByteCount(maximumBytes), label);
  // Sliver has no EOF/truncation marker for single-file downloads. Requesting
  // one sentinel byte lets an exact-cap file succeed while any returned byte
  // beyond the public limit proves that the source is too large.
  if (data.length > maximumBytes) {
    data.fill(0);
    throw new Error(`${label} exceeds the session workbench limit`);
  }
  return data;
}

function completeArtifactRequestByteCount(maximumBytes: number): number {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > SESSION_WORKBENCH_MAX_COMPLETE_FILE_BYTES
  ) {
    throw new Error("Complete-file byte limit is invalid");
  }
  return maximumBytes + 1;
}

function editorRequestByteCount(maximumBytes: number): number {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > SESSION_EDITOR_MAX_BYTES) {
    throw new Error("Editor byte limit is invalid");
  }
  return maximumBytes + 1;
}

function strictEditorText(
  data: Buffer,
  truncated: boolean,
  mode: SessionTextFileView["mode"],
): { content: string; bytesRead: number } {
  let view = data;
  if (truncated && mode === "tail") {
    let offset = 0;
    while (offset < view.length && (view[offset]! & 0xc0) === 0x80) offset += 1;
    view = view.subarray(offset);
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const content = truncated && mode !== "tail"
      ? decoder.decode(view, { stream: true })
      : decoder.decode(view);
    return { content, bytesRead: Buffer.byteLength(content, "utf8") };
  } catch {
    throw new Error("The selected remote file is not valid UTF-8 text");
  }
}

function imageMediaType(data: Buffer): "image/jpeg" | "image/png" | "image/webp" {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  data.fill(0);
  throw new Error("Screenshot did not return a supported image");
}

function imageExtension(mediaType: "image/jpeg" | "image/png" | "image/webp"): string {
  return mediaType === "image/jpeg" ? "jpg" : mediaType.slice("image/".length);
}

function normalizeCapturedArtifact(
  value: SessionCapturedArtifactResult,
  expectedSize: number,
  expectedSha256: string,
  expectedMediaType: "image/jpeg" | "image/png" | "image/webp",
): SessionCapturedArtifactResult {
  if (value.status !== "captured") throw new Error("Screenshot gateway returned an invalid result");
  const artifact = normalizeStoredArtifact(value.artifact);
  const preview = normalizePreview(value.preview);
  if (
    artifact.size !== expectedSize ||
    artifact.sha256 !== expectedSha256 ||
    artifact.mediaType !== expectedMediaType ||
    preview.size !== expectedSize ||
    preview.mediaType !== expectedMediaType
  ) {
    throw new Error("Screenshot gateway returned mismatched artifact metadata");
  }
  return { status: "captured", artifact, preview };
}

function normalizeStoredArtifact(value: SessionStoredArtifact): SessionStoredArtifact {
  if (!ARTIFACT_HANDLE_PATTERN.test(value.handle)) throw new Error("Artifact gateway returned an invalid handle");
  if (!SHA256_PATTERN.test(value.sha256)) throw new Error("Artifact gateway returned an invalid digest");
  const size = boundedArtifactSize(value.size);
  const createdAt = validIsoTimestamp(value.createdAt, "artifact creation time");
  const expiresAt = validIsoTimestamp(value.expiresAt, "artifact expiration");
  return {
    handle: value.handle,
    suggestedBasename: safeBasename(value.suggestedBasename, "session-artifact.bin"),
    mediaType: boundedMediaType(value.mediaType),
    size,
    sha256: value.sha256,
    createdAt,
    expiresAt,
  };
}

function normalizePreview(value: SessionArtifactPreview): SessionArtifactPreview {
  if (!(new Set<string>(["image/jpeg", "image/png", "image/webp"])).has(value.mediaType)) {
    throw new Error("Artifact gateway returned an invalid preview media type");
  }
  const size = boundedArtifactSize(value.size, SCREENSHOT_PREVIEW_MAX_BYTES);
  const prefix = `data:${value.mediaType};base64,`;
  const maximumLength = prefix.length + Math.ceil(size / 3) * 4;
  if (typeof value.dataUrl !== "string" || !value.dataUrl.startsWith(prefix) || value.dataUrl.length > maximumLength) {
    throw new Error("Artifact gateway returned an invalid preview");
  }
  const width = optionalPositiveInteger(value.width);
  const height = optionalPositiveInteger(value.height);
  return {
    mediaType: value.mediaType,
    dataUrl: value.dataUrl,
    size,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

function normalizeNativeSaveResult(value: SessionNativeSaveResult): SessionNativeSaveResult {
  if (value.status === "canceled") return { status: "canceled" };
  if (value.status !== "saved") throw new Error("Artifact gateway returned an invalid save result");
  if (!SHA256_PATTERN.test(value.sha256)) throw new Error("Artifact gateway returned an invalid digest");
  return {
    status: "saved",
    suggestedBasename: safeBasename(value.suggestedBasename, "session-artifact.bin"),
    size: boundedArtifactSize(value.size),
    sha256: value.sha256,
  };
}

function boundedArtifactSize(value: number, maximum: number = SESSION_WORKBENCH_MAX_ARTIFACT_BYTES): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error("Artifact gateway returned an invalid size");
  }
  return value;
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function boundedMediaType(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u.test(normalized)) {
    throw new Error("Artifact gateway returned an invalid media type");
  }
  return normalized;
}

function safeBasename(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const tail = value
    .slice(0, SESSION_WORKBENCH_MAX_PATH_LENGTH)
    .normalize("NFKC")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1) ?? "";
  let sanitized = [...tail]
    .slice(0, 200)
    .join("")
    .replace(UNSAFE_FILENAME_CHARACTERS, "_")
    .replace(/[. ]+$/gu, "")
    .trim();
  while (Buffer.byteLength(sanitized, "utf8") > PORTABLE_BASENAME_MAX_BYTES) {
    sanitized = [...sanitized].slice(0, -1).join("");
  }
  if (!sanitized || sanitized === "." || sanitized === "..") return fallback;
  const deviceStem = (sanitized.split(".", 1)[0] ?? "").replace(/[ ]+$/gu, "");
  if (WINDOWS_DEVICE_STEM.test(deviceStem)) sanitized = `_${sanitized}`;
  while (Buffer.byteLength(sanitized, "utf8") > PORTABLE_BASENAME_MAX_BYTES) {
    sanitized = [...sanitized].slice(0, -1).join("");
  }
  return sanitized || fallback;
}

function isProbablyTextLoot(data: Uint8Array): boolean {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (decoded.includes("\0")) return false;
    let controls = 0;
    for (const character of decoded) {
      const code = character.codePointAt(0) ?? 0;
      if ((code < 32 && character !== "\n" && character !== "\r" && character !== "\t") || code === 127) {
        controls += 1;
      }
    }
    return controls <= Math.max(1, Math.floor(decoded.length / 100));
  } catch {
    return false;
  }
}

function boundedText(value: unknown, maximum: number = SESSION_WORKBENCH_MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") return "";
  return value
    .slice(0, maximum * 2)
    .normalize("NFC")
    .slice(0, maximum)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "�");
}

function normalizeRegistryRead(response: {
  readonly Value?: unknown;
  readonly Binary?: unknown;
  readonly Type?: unknown;
}): Pick<SessionRegistryReadResult, "type" | "value"> {
  switch (response.Type) {
    case sliverpb.RegistryType.Binary:
      return {
        type: "binary",
        value: consumeRegistryReadBytes(response.Binary, "Binary", undefined, (bytes) => bytes.toString("hex")),
      };
    case sliverpb.RegistryType.String:
      return { type: "string", value: boundedText(response.Value) };
    case sliverpb.RegistryType.DWORD:
      return {
        type: "dword",
        value: consumeRegistryReadBytes(response.Binary, "DWORD", 4, (bytes) => bytes.readUInt32LE(0).toString(10)),
      };
    case sliverpb.RegistryType.QWORD:
      return {
        type: "qword",
        value: consumeRegistryReadBytes(response.Binary, "QWORD", 8, (bytes) => bytes.readBigUInt64LE(0).toString(10)),
      };
    default:
      // Value-only responses from older implants decode with Type=Unknown and
      // an empty Binary field. Preserve that representation without guessing.
      return { type: "unknown", value: boundedText(response.Value) };
  }
}

function consumeRegistryReadBytes(
  value: unknown,
  label: string,
  exactLength: number | undefined,
  consume: (bytes: Buffer) => string,
): string {
  if (!Buffer.isBuffer(value)) throw new TypeError(`Registry ${label} value did not return a Buffer`);
  if (value.length > SESSION_WORKBENCH_MAX_TEXT_LENGTH / 2) {
    throw new Error(`Registry ${label} value exceeds the session workbench limit`);
  }
  if (exactLength !== undefined && value.length !== exactLength) {
    throw new Error(`Registry ${label} value must contain exactly ${exactLength} bytes`);
  }
  return consume(value);
}

function boundedPath(value: unknown): string {
  return boundedText(value, SESSION_WORKBENCH_MAX_PATH_LENGTH);
}

function strictRemoteChildName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_SHORT_TEXT_LENGTH ||
    value === "." ||
    value === ".." ||
    /[\/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw new Error("Directory listing returned an unsafe child name");
  }
  return value;
}

function optionalText(value: unknown, maximum: number): string | undefined {
  const text = boundedText(value, maximum).trim();
  return text || undefined;
}

function optionalBoundedText<K extends string>(
  key: K,
  value: unknown,
  maximum: number,
): Partial<Record<K, string>> {
  const text = optionalText(value, maximum);
  return text === undefined ? {} : { [key]: text } as Record<K, string>;
}

function optionalTargetText<K extends "uid" | "gid">(
  key: K,
  value: unknown,
  maximum: number,
): Partial<Record<K, string>> {
  return optionalBoundedText(key, value, maximum);
}

function boundedTextArray(values: string[], maximumItems = MAX_NESTED_ITEMS, maximumText = MAX_SHORT_TEXT_LENGTH): string[] {
  return values.slice(0, maximumItems).map((value) => boundedText(value, maximumText));
}

function unsignedDecimal(value: unknown): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : String(value ?? "");
  if (!/^\d+$/u.test(text)) return "0";
  return text.replace(/^0+(?=\d)/u, "");
}

function nonNegativeInteger(value: unknown): number {
  return optionalNonNegativeInteger(value) ?? 0;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function optionalSocketAddress<K extends "local" | "remote">(
  key: K,
  value: { Ip: string; Port: number } | undefined,
): Partial<Record<K, { address: string; port: number }>> {
  if (!value || !Number.isInteger(value.Port) || value.Port < 0 || value.Port > 65_535) return {};
  return { [key]: { address: boundedText(value.Ip, 512), port: value.Port } } as Record<
    K,
    { address: string; port: number }
  >;
}

function optionalTimezoneOffset(value: unknown): { timezoneOffsetMinutes?: number } {
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > 24 * 60 * 60) return {};
  return { timezoneOffsetMinutes: Math.trunc((value as number) / 60) };
}

function unixSecondsToIso(value: unknown): string | undefined {
  const text = String(value ?? "");
  if (!/^\d{1,12}$/u.test(text)) return undefined;
  const seconds = Number(text);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 253_402_300_799) return undefined;
  return new Date(seconds * 1_000).toISOString();
}

function joinRemotePath(parent: string, name: string): string {
  if (!parent) return boundedPath(name);
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  const joined = parent.endsWith("/") || parent.endsWith("\\") ? `${parent}${name}` : `${parent}${separator}${name}`;
  return boundedPath(joined);
}

function validIsoTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || value.length > 64) throw new Error(`Invalid ${label}`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
