import { clientpb } from "sliver-script";

import type {
  ExecutionActionDraft,
  ExecutionArtifactRole,
  ExecutionChildSummary,
  ExecutionChildrenResult,
  ExecutionOperationId,
  ExecutionPrivilegeSummary,
  ExecutionPrivilegesResult,
  ExecutionReadResult,
  RunExecutionReadInput,
  TokenLogonType,
} from "../shared/execution-contracts.js";
import { EXECUTION_LIMITS } from "../shared/execution-contracts.js";
import type { TargetMode, TargetSummary } from "../shared/target-contracts.js";
import {
  assertExecutionOperationSupported,
  executionOperationDescriptor,
} from "./execution-operation-registry.js";
import type { SliverClientAdapter } from "./sliver-client-adapter.js";

const ACTION_CLIENT_METHODS = [
  "executeSession",
  "executeBeacon",
  "executeAssemblySession",
  "executeAssemblyBeacon",
  "executeShellcodeSession",
  "executeShellcodeBeacon",
  "sideloadSession",
  "sideloadBeacon",
  "spawnDllSession",
  "spawnDllBeacon",
  "migrateSession",
  "migrateBeacon",
  "msfSession",
  "msfBeacon",
  "msfRemoteSession",
  "msfRemoteBeacon",
  "runSshSession",
  "runAsSession",
  "runAsBeacon",
  "makeTokenSession",
  "makeTokenBeacon",
  "impersonateSession",
  "impersonateBeacon",
  "revToSelfSession",
  "revToSelfBeacon",
  "getSystemSession",
  "backdoorSession",
  "hijackDllSession",
] as const;

const READ_CLIENT_METHODS = [
  "executeChildrenSession",
  "executeChildrenBeacon",
  "getPrivsSession",
  "getPrivsBeacon",
] as const;

type ActionClientMethod = (typeof ACTION_CLIENT_METHODS)[number];
type ReadClientMethod = (typeof READ_CLIENT_METHODS)[number];

export type ExecutionWorkbenchClient = Pick<SliverClientAdapter, ActionClientMethod | ReadClientMethod>;

export const EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES = 1 * 1_024 * 1_024;
export const EXECUTION_WORKBENCH_MAX_READ_ITEMS = 1_000;
export const EXECUTION_TARGET_REJECTION_MESSAGE = "The selected target cannot run the reviewed operation";
export const EXECUTION_REMOTE_REJECTION_MESSAGE = "The selected target rejected the reviewed operation";

export interface ExecutionWorkbenchTarget {
  readonly id: string;
  readonly mode: TargetMode;
  readonly summary: TargetSummary;
}

export interface ExecutionWorkbenchActionResult {
  readonly taskId?: string;
  readonly pid?: number;
  readonly exitCode?: number;
  /** A composite reached its primary effect but could not confirm cleanup. */
  readonly partial?: boolean;
  /** Caller-owned bounded copies. The caller must clear them after disposition. */
  readonly stdout?: Buffer;
  readonly stderr?: Buffer;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
  /** Fixed main-authored status text; remote Response.Err is never included. */
  readonly summary: string;
}

export type ExecutionWorkbenchReadDispatch = ExecutionReadResult;

export interface PsexecCompositeInput {
  readonly target: ExecutionWorkbenchTarget;
  readonly draft: Extract<ExecutionActionDraft, { operationId: "execution.psexec" }>;
  /** Workbench-owned clone, valid only until the callback settles. */
  readonly serviceExecutable?: Buffer;
  readonly implantConfig?: clientpb.ImplantConfig;
  /** Call immediately before the first remote side effect. It is idempotent. */
  readonly onDispatch: () => void;
}

export type PsexecCompositeDispatcher = (input: PsexecCompositeInput) => Promise<unknown>;

export interface DispatchExecutionActionInput {
  readonly client: ExecutionWorkbenchClient;
  readonly target: ExecutionWorkbenchTarget;
  readonly draft: ExecutionActionDraft;
  readonly artifacts: Map<ExecutionArtifactRole, Buffer>;
  readonly implantConfig?: clientpb.ImplantConfig;
  readonly onDispatch?: () => void;
  readonly psexec?: PsexecCompositeDispatcher;
}

export interface RunExecutionWorkbenchReadInput {
  readonly client: ExecutionWorkbenchClient;
  readonly target: ExecutionWorkbenchTarget;
  readonly input: RunExecutionReadInput;
  readonly onDispatch?: () => void;
}

export class ExecutionTargetRejectedError extends Error {
  constructor() {
    super(EXECUTION_TARGET_REJECTION_MESSAGE);
    this.name = "ExecutionTargetRejectedError";
  }
}

export class ExecutionRemoteRejectedError extends Error {
  constructor() {
    super(EXECUTION_REMOTE_REJECTION_MESSAGE);
    this.name = "ExecutionRemoteRejectedError";
  }
}

export class ExecutionWorkbenchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionWorkbenchInputError";
  }
}

/**
 * Dispatches one already parsed and reviewed M4 action through the closed
 * SliverClientAdapter surface. This function has no renderer or registry state.
 */
export async function dispatchExecutionAction(
  input: DispatchExecutionActionInput,
): Promise<ExecutionWorkbenchActionResult> {
  const artifactCopies = new Map<ExecutionArtifactRole, Buffer>();
  const credentialCopies: Buffer[] = [];
  const markDispatched = dispatchMarker(input.onDispatch);

  try {
    for (const value of credentialByteViews(input.draft)) credentialCopies.push(Buffer.from(value));
    assertSupported(input.draft.operationId, input.target);
    assertArchitectureCompatible(input.draft, input.target.summary, input.implantConfig);
    cloneAndValidateArtifacts(input.draft, input.artifacts, artifactCopies);
    const response = await dispatchAction(input, artifactCopies, credentialCopies, markDispatched);
    return normalizeActionResponse(input.draft, response);
  } finally {
    clearBuffers(artifactCopies.values());
    clearBuffers(credentialCopies);
    clearArtifactInputs(input.artifacts);
    clearDraftCredentials(input.draft);
  }
}

/** Dispatches and page-normalizes the two read-only M4 inventories. */
export async function runExecutionRead(
  request: RunExecutionWorkbenchReadInput,
): Promise<ExecutionWorkbenchReadDispatch> {
  assertSupported(request.input.operationId, request.target);
  const markDispatched = dispatchMarker(request.onDispatch);
  markDispatched();
  const response = request.input.operationId === "execution.children"
    ? request.target.mode === "session"
      ? await request.client.executeChildrenSession(request.target.id)
      : await request.client.executeChildrenBeacon(request.target.id)
    : request.target.mode === "session"
      ? await request.client.getPrivsSession(request.target.id)
      : await request.client.getPrivsBeacon(request.target.id);
  assertRemoteAccepted(response);
  const taskId = responseTaskId(response);
  return request.input.operationId === "execution.children"
    ? normalizeChildren(response, request.input, taskId)
    : normalizePrivileges(response, request.input, taskId);
}

async function dispatchAction(
  input: DispatchExecutionActionInput,
  artifacts: ReadonlyMap<ExecutionArtifactRole, Buffer>,
  credentials: readonly Buffer[],
  markDispatched: () => void,
): Promise<unknown> {
  const { client, draft, target } = input;
  const id = target.id;
  switch (draft.operationId) {
    case "execution.process": {
      const environment = Object.fromEntries(draft.environment.map(({ name, value }) => [name, value]));
      const options = {
        path: draft.path,
        args: [...draft.args],
        output: draft.captureOutput,
        background: draft.background,
        envInheritance: draft.inheritEnvironment,
        env: environment,
        useToken: draft.useToken,
        hideWindow: draft.hideWindow,
        ...(draft.stdoutPath === undefined ? {} : { stdoutPath: draft.stdoutPath }),
        ...(draft.stderrPath === undefined ? {} : { stderrPath: draft.stderrPath }),
        ...(draft.parentPid === undefined ? {} : { parentPid: draft.parentPid }),
      };
      markDispatched();
      return target.mode === "session"
        ? client.executeSession(id, options, draft.timeoutSeconds)
        : client.executeBeacon(id, options, draft.timeoutSeconds);
    }
    case "execution.assembly": {
      const assembly = requireArtifact(artifacts, "assembly");
      const options = {
        arguments: [...draft.args],
        process: draft.process,
        isDll: draft.isDll,
        arch: draft.architecture,
        processArgs: [...draft.processArgs],
        inProcess: draft.inProcess,
        amsiBypass: draft.amsiBypass,
        etwBypass: draft.etwBypass,
        ...(draft.className === undefined ? {} : { className: draft.className }),
        ...(draft.method === undefined ? {} : { method: draft.method }),
        ...(draft.appDomain === undefined ? {} : { appDomain: draft.appDomain }),
        ...(draft.parentPid === undefined ? {} : { parentPid: draft.parentPid }),
        ...(draft.runtime === undefined ? {} : { runtime: draft.runtime }),
      };
      markDispatched();
      return target.mode === "session"
        ? client.executeAssemblySession(id, assembly, options, draft.timeoutSeconds)
        : client.executeAssemblyBeacon(id, assembly, options, draft.timeoutSeconds);
    }
    case "execution.shellcode": {
      const shellcode = requireArtifact(artifacts, "shellcode");
      const options = { pid: draft.pid, rwxPages: draft.rwxPages };
      markDispatched();
      return target.mode === "session"
        ? client.executeShellcodeSession(id, shellcode, options, draft.timeoutSeconds)
        : client.executeShellcodeBeacon(id, shellcode, options, draft.timeoutSeconds);
    }
    case "execution.sideload": {
      const library = requireArtifact(artifacts, "shared-library");
      const options = {
        processName: draft.process,
        args: [...draft.args],
        entryPoint: draft.entryPoint,
        keepAlive: draft.keepAlive,
        isDll: normalizedPlatform(target.summary.os) === "windows",
        isUnicode: draft.unicode,
        processArgs: [...draft.processArgs],
        ...(draft.parentPid === undefined ? {} : { parentPid: draft.parentPid }),
      };
      markDispatched();
      return target.mode === "session"
        ? client.sideloadSession(id, library, options, draft.timeoutSeconds)
        : client.sideloadBeacon(id, library, options, draft.timeoutSeconds);
    }
    case "execution.spawn-dll": {
      const dll = requireArtifact(artifacts, "reflective-dll");
      const options = {
        processName: draft.process,
        args: [...draft.args],
        entryPoint: draft.entryPoint,
        keepAlive: draft.keepAlive,
      };
      markDispatched();
      return target.mode === "session"
        ? client.spawnDllSession(id, dll, options, draft.timeoutSeconds)
        : client.spawnDllBeacon(id, dll, options, draft.timeoutSeconds);
    }
    case "execution.migrate": {
      const config = requireImplantConfig(input.implantConfig);
      const options = {
        config,
        name: "",
        ...(draft.pid === undefined ? {} : { pid: draft.pid }),
        ...(draft.processName === undefined ? {} : { processName: draft.processName }),
        ...(draft.encoder === undefined ? {} : { encoder: shellcodeEncoder(draft.encoder) }),
      };
      markDispatched();
      return target.mode === "session"
        ? client.migrateSession(id, options, draft.timeoutSeconds)
        : client.migrateBeacon(id, options, draft.timeoutSeconds);
    }
    case "execution.msf": {
      const options = {
        payload: draft.payload,
        lhost: draft.lhost,
        lport: draft.lport,
        iterations: draft.iterations,
        ...(draft.encoder === undefined ? {} : { encoder: draft.encoder }),
      };
      markDispatched();
      return target.mode === "session"
        ? client.msfSession(id, options, draft.timeoutSeconds)
        : client.msfBeacon(id, options, draft.timeoutSeconds);
    }
    case "execution.msf-inject": {
      const options = {
        pid: draft.pid,
        payload: draft.payload,
        lhost: draft.lhost,
        lport: draft.lport,
        iterations: draft.iterations,
        ...(draft.encoder === undefined ? {} : { encoder: draft.encoder }),
      };
      markDispatched();
      return target.mode === "session"
        ? client.msfRemoteSession(id, options, draft.timeoutSeconds)
        : client.msfRemoteBeacon(id, options, draft.timeoutSeconds);
    }
    case "execution.psexec": {
      if (!input.psexec) throw new ExecutionWorkbenchInputError("The remote service workflow is unavailable");
      return input.psexec({
        target,
        draft,
        ...(artifacts.get("service-executable") === undefined
          ? {}
          : { serviceExecutable: artifacts.get("service-executable")! }),
        ...(input.implantConfig === undefined ? {} : { implantConfig: input.implantConfig }),
        onDispatch: markDispatched,
      });
    }
    case "execution.ssh": {
      const options: Parameters<ExecutionWorkbenchClient["runSshSession"]>[1] = {
        hostname: draft.hostname,
        port: draft.port,
        username: draft.username,
        command: [...draft.command],
      };
      switch (draft.authentication.kind) {
        case "password":
          options.password = decodeCredential(requireCredential(credentials));
          break;
        case "private-key":
          options.privateKey = requireArtifact(artifacts, "ssh-private-key");
          break;
        case "kerberos":
          options.kerberosRealm = draft.authentication.realm;
          options.kerberosConfigPath = draft.authentication.configPath;
          options.kerberosKeytab = requireArtifact(artifacts, "kerberos-keytab");
          break;
      }
      markDispatched();
      return client.runSshSession(id, options, draft.timeoutSeconds);
    }
    case "execution.backdoor":
      markDispatched();
      return client.backdoorSession(id, {
        filePath: draft.remotePath,
        profileName: draft.profileName,
        name: draft.name,
      }, draft.timeoutSeconds);
    case "execution.dll-hijack": {
      const options: Parameters<ExecutionWorkbenchClient["hijackDllSession"]>[1] = {
        referenceDllPath: draft.referenceDllPath,
        targetLocation: draft.targetLocation,
        name: draft.name,
        ...(draft.includeReferenceDll
          ? { referenceDll: requireArtifact(artifacts, "hijack-reference-dll") }
          : {}),
        ...(draft.source.kind === "native-file"
          ? { targetDll: requireArtifact(artifacts, "hijack-target-dll") }
          : { profileName: draft.source.profileName }),
      };
      markDispatched();
      return client.hijackDllSession(id, options, draft.timeoutSeconds);
    }
    case "privilege.run-as": {
      const password = decodeCredential(requireCredential(credentials));
      const options = {
        username: draft.username,
        processName: draft.process,
        args: draft.args,
        domain: draft.domain,
        password,
        showWindow: draft.showWindow,
        netOnly: draft.netOnly,
      };
      markDispatched();
      return target.mode === "session"
        ? client.runAsSession(id, options, draft.timeoutSeconds)
        : client.runAsBeacon(id, options, draft.timeoutSeconds);
    }
    case "privilege.make-token": {
      const password = decodeCredential(requireCredential(credentials));
      const options = {
        username: draft.username,
        domain: draft.domain,
        password,
        logonType: windowsLogonType(draft.logonType),
      };
      markDispatched();
      return target.mode === "session"
        ? client.makeTokenSession(id, options, draft.timeoutSeconds)
        : client.makeTokenBeacon(id, options, draft.timeoutSeconds);
    }
    case "privilege.impersonate":
      markDispatched();
      return target.mode === "session"
        ? client.impersonateSession(id, draft.username, draft.timeoutSeconds)
        : client.impersonateBeacon(id, draft.username, draft.timeoutSeconds);
    case "privilege.revert":
      markDispatched();
      return target.mode === "session"
        ? client.revToSelfSession(id, draft.timeoutSeconds)
        : client.revToSelfBeacon(id, draft.timeoutSeconds);
    case "privilege.get-system": {
      const config = requireImplantConfig(input.implantConfig);
      markDispatched();
      return client.getSystemSession(id, { config, hostingProcess: draft.hostingProcess }, draft.timeoutSeconds);
    }
  }
}

function cloneAndValidateArtifacts(
  draft: ExecutionActionDraft,
  borrowed: ReadonlyMap<ExecutionArtifactRole, Buffer>,
  copies: Map<ExecutionArtifactRole, Buffer>,
): void {
  if (!(borrowed instanceof Map)) throw new ExecutionWorkbenchInputError("Execution artifacts must be a Map");
  const expected = expectedArtifactRoles(draft);
  const descriptor = executionOperationDescriptor(draft.operationId);
  const requirements = new Map(descriptor.artifacts.map((requirement) => [requirement.role, requirement]));
  for (const [role, data] of borrowed) {
    if (!expected.has(role) || !Buffer.isBuffer(data)) {
      throw new ExecutionWorkbenchInputError("The reviewed operation contains an unexpected artifact");
    }
    const requirement = requirements.get(role);
    if (!requirement || data.length > requirement.maximumBytes || data.length > EXECUTION_LIMITS.artifactBytes) {
      throw new ExecutionWorkbenchInputError("A reviewed execution artifact exceeds its allowed size");
    }
    copies.set(role, Buffer.from(data));
  }
  for (const role of expected) {
    if (!copies.has(role)) throw new ExecutionWorkbenchInputError("The reviewed operation is missing a required artifact");
  }
}

function expectedArtifactRoles(draft: ExecutionActionDraft): ReadonlySet<ExecutionArtifactRole> {
  switch (draft.operationId) {
    case "execution.assembly":
      return new Set(["assembly"]);
    case "execution.shellcode":
      return new Set(["shellcode"]);
    case "execution.sideload":
      return new Set(["shared-library"]);
    case "execution.spawn-dll":
      return new Set(["reflective-dll"]);
    case "execution.psexec":
      return new Set(draft.source.kind === "native-file" ? ["service-executable"] : []);
    case "execution.ssh":
      return new Set(
        draft.authentication.kind === "private-key"
          ? ["ssh-private-key"]
          : draft.authentication.kind === "kerberos"
            ? ["kerberos-keytab"]
            : [],
      );
    case "execution.dll-hijack": {
      const roles: ExecutionArtifactRole[] = [];
      if (draft.includeReferenceDll) roles.push("hijack-reference-dll");
      if (draft.source.kind === "native-file") roles.push("hijack-target-dll");
      return new Set(roles);
    }
    default:
      return new Set();
  }
}

function assertSupported(operationId: ExecutionOperationId, target: ExecutionWorkbenchTarget): void {
  if (target.id !== target.summary.id || target.mode !== target.summary.mode) throw new ExecutionTargetRejectedError();
  try {
    assertExecutionOperationSupported(operationId, target.summary);
  } catch {
    throw new ExecutionTargetRejectedError();
  }
}

function assertArchitectureCompatible(
  draft: ExecutionActionDraft,
  target: TargetSummary,
  implantConfig: clientpb.ImplantConfig | undefined,
): void {
  const targetArchitecture = normalizedArchitecture(target.arch);
  if (
    draft.operationId === "execution.process" &&
    normalizedPlatform(target.os) !== "windows" &&
    (draft.useToken || draft.hideWindow || draft.parentPid !== undefined)
  ) {
    throw new ExecutionTargetRejectedError();
  }
  if (draft.operationId === "execution.assembly") {
    const architectureMatches = draft.architecture === "x84"
      ? targetArchitecture === "386" || targetArchitecture === "amd64"
      : targetArchitecture === (draft.architecture === "x86" ? "386" : "amd64");
    if (!architectureMatches) throw new ExecutionTargetRejectedError();
  }
  if (draft.operationId === "execution.shellcode") {
    if (!targetArchitecture || targetArchitecture !== draft.declaredArchitecture) {
      throw new ExecutionTargetRejectedError();
    }
  }
  if (draft.operationId === "execution.migrate" || draft.operationId === "privilege.get-system") {
    if (!implantConfig ||
      normalizedPlatform(implantConfig.GOOS) !== normalizedPlatform(target.os) ||
      normalizedArchitecture(implantConfig.GOARCH) !== targetArchitecture) {
      throw new ExecutionTargetRejectedError();
    }
  }
}

function normalizeActionResponse(draft: ExecutionActionDraft, value: unknown): ExecutionWorkbenchActionResult {
  const record = unknownRecord(value);
  const responseBuffers = collectResponseBuffers(record);
  const resultBuffers: Buffer[] = [];
  try {
    assertRemoteAccepted(record);
    const descriptor = executionOperationDescriptor(draft.operationId);
    const taskId = responseTaskId(record);
    if (taskId) {
      return Object.freeze({ taskId, summary: descriptor.submittedMessage });
    }
    const pid = safePositiveInteger(record?.["Pid"] ?? record?.["pid"]);
    const exitCode = draft.operationId === "execution.process" && draft.captureOutput && !draft.background
      ? safeExitCode(record?.["Status"] ?? record?.["status"])
      : undefined;
    const partial = record?.["__executionPartial"] === true;
    const streams = actionStreams(draft.operationId, record);
    const stdout = streams.stdout === undefined ? undefined : boundedOutput(streams.stdout);
    const stderr = streams.stderr === undefined ? undefined : boundedOutput(streams.stderr);
    if (stdout) resultBuffers.push(stdout.data);
    if (stderr) resultBuffers.push(stderr.data);
    const result: ExecutionWorkbenchActionResult = Object.freeze({
      ...(taskId ? { taskId } : {}),
      ...(pid === undefined ? {} : { pid }),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(partial ? { partial: true } : {}),
      ...(stdout === undefined ? {} : { stdout: stdout.data, stdoutTruncated: stdout.truncated }),
      ...(stderr === undefined ? {} : { stderr: stderr.data, stderrTruncated: stderr.truncated }),
      summary: descriptor.completedMessage,
    });
    resultBuffers.length = 0;
    return result;
  } catch (error) {
    clearBuffers(resultBuffers);
    throw error;
  } finally {
    clearBuffers(responseBuffers);
  }
}

function actionStreams(
  operationId: ExecutionOperationId,
  record: Record<string, unknown> | undefined,
): { stdout?: unknown; stderr?: unknown } {
  if (!record) return {};
  switch (operationId) {
    case "execution.process":
    case "execution.psexec":
      return optionalStreams(record["Stdout"] ?? record["stdout"], record["Stderr"] ?? record["stderr"]);
    case "execution.assembly":
    case "privilege.run-as":
      return optionalStreams(record["Output"] ?? record["output"], undefined);
    case "execution.sideload":
    case "execution.spawn-dll":
      return optionalStreams(record["Result"] ?? record["result"], undefined);
    case "execution.ssh":
      return optionalStreams(record["StdOut"] ?? record["stdout"], record["StdErr"] ?? record["stderr"]);
    default:
      return {};
  }
}

function optionalStreams(stdout: unknown, stderr: unknown): { stdout?: unknown; stderr?: unknown } {
  return {
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
  };
}

function assertRemoteAccepted(value: unknown): void {
  const response = unknownRecord(unknownRecord(value)?.["Response"]);
  if (typeof response?.["Err"] === "string" && response["Err"].length > 0) {
    throw new ExecutionRemoteRejectedError();
  }
  if (response?.["Async"] === true && responseTaskId(value) === undefined) {
    throw new ExecutionRemoteRejectedError();
  }
}

function responseTaskId(value: unknown): string | undefined {
  const response = unknownRecord(unknownRecord(value)?.["Response"]);
  const candidate = response?.["TaskID"];
  return typeof candidate === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(candidate)
    ? candidate
    : undefined;
}

function boundedOutput(value: unknown): { data: Buffer; truncated: boolean } {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const source = value as Uint8Array;
    return {
      data: Buffer.from(source.subarray(0, EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES)),
      truncated: source.byteLength > EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES,
    };
  }
  if (typeof value === "string") return boundedUtf8(value, EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES);
  throw new ExecutionRemoteRejectedError();
}

function boundedUtf8(value: string, maximumBytes: number): { data: Buffer; truncated: boolean } {
  const byteLength = Buffer.byteLength(value, "utf8");
  const data = Buffer.alloc(Math.min(byteLength, maximumBytes));
  const written = data.write(value, 0, data.length, "utf8");
  return {
    data: written === data.length ? data : Buffer.from(data.subarray(0, written)),
    truncated: byteLength > maximumBytes,
  };
}

function normalizeChildren(
  value: unknown,
  input: RunExecutionReadInput,
  taskId: string | undefined,
): ExecutionChildrenResult {
  if (taskId) return submittedChildren(taskId);
  const record = unknownRecord(value);
  const source = record?.["Children"];
  if (!Array.isArray(source)) return emptyChildren();
  const items: ExecutionChildSummary[] = [];
  for (const item of source.slice(0, EXECUTION_WORKBENCH_MAX_READ_ITEMS)) {
    const normalized = normalizeChild(item);
    if (normalized) items.push(normalized);
  }
  const page = pageItems(items, input, source.length > EXECUTION_WORKBENCH_MAX_READ_ITEMS);
  return Object.freeze({
    operationId: "execution.children",
    state: "completed",
    items: page.items,
    total: items.length,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    truncated: page.truncated,
  });
}

function normalizePrivileges(
  value: unknown,
  input: RunExecutionReadInput,
  taskId: string | undefined,
): ExecutionPrivilegesResult {
  if (taskId) return submittedPrivileges(taskId);
  const record = unknownRecord(value);
  const source = record?.["PrivInfo"];
  if (!Array.isArray(source)) return emptyPrivileges();
  const privileges: ExecutionPrivilegeSummary[] = [];
  for (const item of source.slice(0, EXECUTION_WORKBENCH_MAX_READ_ITEMS)) {
    const normalized = normalizePrivilege(item);
    if (normalized) privileges.push(normalized);
  }
  const page = pageItems(privileges, input, source.length > EXECUTION_WORKBENCH_MAX_READ_ITEMS);
  return Object.freeze({
    operationId: "privilege.get",
    state: "completed",
    processName: boundedText(record?.["ProcessName"], EXECUTION_LIMITS.shortString),
    processIntegrity: boundedText(record?.["ProcessIntegrity"], EXECUTION_LIMITS.shortString),
    privileges: page.items,
    total: privileges.length,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    truncated: page.truncated,
  });
}

function normalizeChild(value: unknown): ExecutionChildSummary | undefined {
  const record = unknownRecord(value);
  if (!record) return undefined;
  const pid = safePositiveInteger(record["Pid"]);
  if (pid === undefined) return undefined;
  const startedAt = safeDate(record["StartTime"]);
  const exitedAt = safeDate(record["ExitTime"]);
  const exited = record["Exited"] === true;
  const exitCode = safeInteger(record["ExitCode"]);
  const error = boundedOptionalText(record["Error"], 512);
  const args = Array.isArray(record["Args"])
    ? record["Args"].slice(0, 32).map((item) => boundedText(item, EXECUTION_LIMITS.shortString))
    : [];
  return Object.freeze({
    pid,
    path: boundedText(record["Path"], EXECUTION_LIMITS.path),
    args,
    ...(startedAt ? { startedAt } : {}),
    exited,
    ...(exited && exitCode !== undefined ? { exitCode } : {}),
    ...(exitedAt ? { exitedAt } : {}),
    stdoutBytes: byteLength(record["Stdout"]),
    stderrBytes: byteLength(record["Stderr"]),
    ...(error ? { error } : {}),
  });
}

function normalizePrivilege(value: unknown): ExecutionPrivilegeSummary | undefined {
  const record = unknownRecord(value);
  if (!record) return undefined;
  const name = boundedText(record["Name"], EXECUTION_LIMITS.shortString);
  if (!name) return undefined;
  return Object.freeze({
    name,
    description: boundedText(record["Description"], 512),
    enabled: record["Enabled"] === true,
    enabledByDefault: record["EnabledByDefault"] === true,
    removed: record["Removed"] === true,
    usedForAccess: record["UsedForAccess"] === true,
  });
}

function pageItems<Item>(
  items: readonly Item[],
  input: RunExecutionReadInput,
  sourceTruncated: boolean,
): { items: Item[]; nextCursor?: string; truncated: boolean } {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EXECUTION_LIMITS.pageLimit) {
    throw new ExecutionWorkbenchInputError("Execution read page limit is invalid");
  }
  const offset = readCursor(input.cursor, input.operationId);
  if (offset > items.length) throw new ExecutionWorkbenchInputError("Execution read cursor is stale");
  const end = Math.min(items.length, offset + limit);
  const nextCursor = end < items.length ? `execution-read:v1:${input.operationId}:${end}` : undefined;
  return {
    items: items.slice(offset, end),
    ...(nextCursor ? { nextCursor } : {}),
    truncated: sourceTruncated || nextCursor !== undefined,
  };
}

function readCursor(value: string | undefined, operationId: RunExecutionReadInput["operationId"]): number {
  if (value === undefined) return 0;
  const match = /^execution-read:v1:([^:]+):([0-9]+)$/u.exec(value);
  if (!match || match[1] !== operationId) throw new ExecutionWorkbenchInputError("Execution read cursor is invalid");
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ExecutionWorkbenchInputError("Execution read cursor is invalid");
  }
  return offset;
}

function emptyChildren(): ExecutionChildrenResult {
  return Object.freeze({
    operationId: "execution.children",
    state: "completed",
    items: [],
    total: 0,
    truncated: false,
  });
}

function emptyPrivileges(): ExecutionPrivilegesResult {
  return Object.freeze({
    operationId: "privilege.get",
    state: "completed",
    processName: "",
    processIntegrity: "",
    privileges: [],
    total: 0,
    truncated: false,
  });
}

function submittedChildren(taskId: string): ExecutionChildrenResult {
  return Object.freeze({
    operationId: "execution.children",
    state: "submitted",
    taskId,
    items: [],
    total: 0,
    truncated: false,
  });
}

function submittedPrivileges(taskId: string): ExecutionPrivilegesResult {
  return Object.freeze({
    operationId: "privilege.get",
    state: "submitted",
    taskId,
    processName: "",
    processIntegrity: "",
    privileges: [],
    total: 0,
    truncated: false,
  });
}

function requireArtifact(
  artifacts: ReadonlyMap<ExecutionArtifactRole, Buffer>,
  role: ExecutionArtifactRole,
): Buffer {
  const artifact = artifacts.get(role);
  if (!artifact) throw new ExecutionWorkbenchInputError("The reviewed operation is missing a required artifact");
  return artifact;
}

function requireCredential(credentials: readonly Buffer[]): Buffer {
  const credential = credentials[0];
  if (!credential) throw new ExecutionWorkbenchInputError("The reviewed operation is missing a credential");
  return credential;
}

function requireImplantConfig(value: clientpb.ImplantConfig | undefined): clientpb.ImplantConfig {
  if (!value) throw new ExecutionWorkbenchInputError("The reviewed operation is missing an implant configuration");
  return value;
}

function credentialByteViews(draft: ExecutionActionDraft): Uint8Array[] {
  switch (draft.operationId) {
    case "execution.ssh":
      return draft.authentication.kind === "password" ? [draft.authentication.password] : [];
    case "privilege.run-as":
    case "privilege.make-token":
      return [draft.password];
    default:
      return [];
  }
}

function clearArtifactInputs(value: unknown): void {
  if (!(value instanceof Map)) return;
  for (const item of value.values()) {
    if (item instanceof Uint8Array) item.fill(0);
  }
}

function clearDraftCredentials(draft: ExecutionActionDraft): void {
  switch (draft.operationId) {
    case "execution.ssh":
      if (draft.authentication.kind === "password") draft.authentication.password.fill(0);
      break;
    case "privilege.run-as":
    case "privilege.make-token":
      draft.password.fill(0);
      break;
    default:
      break;
  }
}

function decodeCredential(value: Buffer): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new ExecutionWorkbenchInputError("The reviewed credential has an invalid encoding");
  }
  if (!decoded || decoded.includes("\0")) {
    throw new ExecutionWorkbenchInputError("The reviewed credential has an invalid encoding");
  }
  return decoded;
}

function shellcodeEncoder(value: string): clientpb.ShellcodeEncoder {
  switch (value.trim().toUpperCase().replaceAll("-", "_")) {
    case "":
    case "NONE":
      return clientpb.ShellcodeEncoder.NONE;
    case "SHIKATA_GA_NAI":
      return clientpb.ShellcodeEncoder.SHIKATA_GA_NAI;
    case "XOR":
      return clientpb.ShellcodeEncoder.XOR;
    case "XOR_DYNAMIC":
      return clientpb.ShellcodeEncoder.XOR_DYNAMIC;
    default:
      throw new ExecutionWorkbenchInputError("The selected shellcode encoder is unavailable");
  }
}

function windowsLogonType(value: TokenLogonType): 2 | 3 | 4 | 5 | 7 | 8 | 9 {
  switch (value) {
    case "interactive": return 2;
    case "network": return 3;
    case "batch": return 4;
    case "service": return 5;
    case "unlock": return 7;
    case "network-cleartext": return 8;
    case "new-credentials": return 9;
  }
}

function dispatchMarker(callback: (() => void) | undefined): () => void {
  let dispatched = false;
  return () => {
    if (dispatched) return;
    dispatched = true;
    callback?.();
  };
}

function collectResponseBuffers(record: Record<string, unknown> | undefined): Buffer[] {
  if (!record) return [];
  const values = [
    record["Stdout"], record["Stderr"], record["StdOut"], record["StdErr"],
    record["Output"], record["output"], record["stdout"], record["stderr"],
  ];
  return values.filter((value): value is Buffer => Buffer.isBuffer(value));
}

function clearBuffers(values: Iterable<Uint8Array>): void {
  for (const value of values) value.fill(0);
}

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedPlatform(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizedArchitecture(value: unknown): "386" | "amd64" | "arm64" | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "386":
    case "x86":
    case "i386":
    case "i686":
      return "386";
    case "amd64":
    case "x64":
    case "x86_64":
      return "amd64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      return undefined;
  }
}

function safePositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= EXECUTION_LIMITS.pid
    ? value as number
    : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? value as number : undefined;
}

function safeExitCode(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff
    ? value as number
    : undefined;
}

function safeDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function boundedText(value: unknown, maximumCharacters: number): string {
  return typeof value === "string"
    ? [...value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")]
      .slice(0, maximumCharacters)
      .join("")
    : "";
}

function boundedOptionalText(value: unknown, maximumCharacters: number): string | undefined {
  const bounded = boundedText(value, maximumCharacters);
  return bounded || undefined;
}

function byteLength(value: unknown): number {
  if (typeof value === "string") return Math.min(Buffer.byteLength(value, "utf8"), Number.MAX_SAFE_INTEGER);
  if (value instanceof Uint8Array) return Math.min(value.byteLength, Number.MAX_SAFE_INTEGER);
  return 0;
}
