import type { OperationBackendSummary, SafeArtifactHandle } from "./operation-contracts.js";
import type { TargetMode, TargetRef, TargetSummary } from "./target-contracts.js";

export const EXECUTION_OPERATION_IDS = Object.freeze([
  "execution.process",
  "execution.children",
  "execution.assembly",
  "execution.shellcode",
  "execution.sideload",
  "execution.spawn-dll",
  "execution.migrate",
  "execution.msf",
  "execution.msf-inject",
  "execution.psexec",
  "execution.ssh",
  "execution.backdoor",
  "execution.dll-hijack",
  "privilege.get",
  "privilege.run-as",
  "privilege.make-token",
  "privilege.impersonate",
  "privilege.revert",
  "privilege.get-system",
] as const);

export type ExecutionOperationId = (typeof EXECUTION_OPERATION_IDS)[number];

export const EXECUTION_READ_OPERATION_IDS = Object.freeze([
  "execution.children",
  "privilege.get",
] as const);

export type ExecutionReadOperationId = (typeof EXECUTION_READ_OPERATION_IDS)[number];

export const EXECUTION_RISK_CLASSES = Object.freeze([
  "read-only",
  "mutating",
  "destructive",
  "credential-bearing",
  "high-opsec",
] as const);

export type ExecutionRiskClass = (typeof EXECUTION_RISK_CLASSES)[number];

export const EXECUTION_ARTIFACT_ROLES = Object.freeze([
  "assembly",
  "shellcode",
  "shared-library",
  "reflective-dll",
  "service-executable",
  "ssh-private-key",
  "kerberos-keytab",
  "hijack-reference-dll",
  "hijack-target-dll",
] as const);

export type ExecutionArtifactRole = (typeof EXECUTION_ARTIFACT_ROLES)[number];

export interface ExecutionArtifactRequirement {
  role: ExecutionArtifactRole;
  label: string;
  required: boolean;
  maximumBytes: number;
  acceptedExtensions: string[];
}

export interface ExecutionCapabilityReason {
  code:
    | "requires-session"
    | "requires-beacon"
    | "requires-windows"
    | "unsupported-platform"
    | "unsupported-architecture"
    | "target-unavailable"
    | "dependency-unavailable";
  message: string;
}

export interface ExecutionCapability {
  operationId: ExecutionOperationId;
  available: boolean;
  modes: TargetMode[];
  platforms: string[];
  risk: ExecutionRiskClass;
  confirmationRequired: boolean;
  credentialBearing: boolean;
  artifacts: ExecutionArtifactRequirement[];
  reason?: ExecutionCapabilityReason;
}

export interface ExecutionCatalog {
  target: TargetSummary;
  targetRef: TargetRef;
  backend: OperationBackendSummary;
  currentIdentity?: string;
  capabilities: ExecutionCapability[];
}

export interface ExecutionEnvironmentEntry {
  name: string;
  value: string;
}

export interface ExecuteProcessDraft {
  operationId: "execution.process";
  path: string;
  args: string[];
  captureOutput: boolean;
  background: boolean;
  stdoutPath?: string;
  stderrPath?: string;
  inheritEnvironment: boolean;
  environment: ExecutionEnvironmentEntry[];
  useToken: boolean;
  hideWindow: boolean;
  parentPid?: number;
  timeoutSeconds: number;
}

export interface ExecuteAssemblyDraft {
  operationId: "execution.assembly";
  args: string[];
  process: string;
  isDll: boolean;
  architecture: "x86" | "x64" | "x84";
  className?: string;
  method?: string;
  appDomain?: string;
  parentPid?: number;
  processArgs: string[];
  inProcess: boolean;
  runtime?: string;
  amsiBypass: boolean;
  etwBypass: boolean;
  timeoutSeconds: number;
}

export interface ExecuteShellcodeDraft {
  operationId: "execution.shellcode";
  declaredArchitecture: "386" | "amd64" | "arm64";
  pid: number;
  rwxPages: boolean;
  timeoutSeconds: number;
}

export interface SideloadDraft {
  operationId: "execution.sideload";
  process: string;
  args: string[];
  entryPoint: string;
  unicode: boolean;
  keepAlive: boolean;
  parentPid?: number;
  processArgs: string[];
  timeoutSeconds: number;
}

export interface SpawnDllDraft {
  operationId: "execution.spawn-dll";
  process: string;
  args: string[];
  entryPoint: string;
  keepAlive: boolean;
  timeoutSeconds: number;
}

export interface MigrateDraft {
  operationId: "execution.migrate";
  pid?: number;
  processName?: string;
  encoder?: string;
  timeoutSeconds: number;
}

export interface MsfDraft {
  operationId: "execution.msf";
  payload: string;
  lhost: string;
  lport: number;
  encoder?: string;
  iterations: number;
  timeoutSeconds: number;
}

export interface MsfInjectDraft {
  operationId: "execution.msf-inject";
  pid: number;
  payload: string;
  lhost: string;
  lport: number;
  encoder?: string;
  iterations: number;
  timeoutSeconds: number;
}

export type PsexecSource =
  | { kind: "profile"; profileName: string }
  | { kind: "native-file" };

export interface PsexecDraft {
  operationId: "execution.psexec";
  hostname: string;
  serviceName: string;
  serviceDescription: string;
  remotePath: string;
  source: PsexecSource;
  timeoutSeconds: number;
}

export type SshAuthentication =
  | { kind: "password"; password: Uint8Array }
  | { kind: "private-key" }
  | {
      kind: "kerberos";
      realm: string;
      configPath: string;
    };

export interface SshDraft {
  operationId: "execution.ssh";
  hostname: string;
  port: number;
  username: string;
  command: string[];
  authentication: SshAuthentication;
  timeoutSeconds: number;
}

export interface BackdoorDraft {
  operationId: "execution.backdoor";
  remotePath: string;
  profileName: string;
  name: string;
  timeoutSeconds: number;
}

export type DllHijackSource =
  | { kind: "profile"; profileName: string }
  | { kind: "native-file" };

export interface DllHijackDraft {
  operationId: "execution.dll-hijack";
  referenceDllPath: string;
  targetLocation: string;
  source: DllHijackSource;
  includeReferenceDll: boolean;
  name: string;
  timeoutSeconds: number;
}

export interface RunAsDraft {
  operationId: "privilege.run-as";
  username: string;
  domain: string;
  password: Uint8Array;
  process: string;
  args: string;
  showWindow: boolean;
  netOnly: boolean;
  timeoutSeconds: number;
}

export type TokenLogonType =
  | "interactive"
  | "network"
  | "batch"
  | "service"
  | "unlock"
  | "network-cleartext"
  | "new-credentials";

export interface MakeTokenDraft {
  operationId: "privilege.make-token";
  username: string;
  domain: string;
  password: Uint8Array;
  logonType: TokenLogonType;
  timeoutSeconds: number;
}

export interface ImpersonateDraft {
  operationId: "privilege.impersonate";
  username: string;
  timeoutSeconds: number;
}

export interface RevertIdentityDraft {
  operationId: "privilege.revert";
  timeoutSeconds: number;
}

export interface GetSystemDraft {
  operationId: "privilege.get-system";
  hostingProcess: string;
  timeoutSeconds: number;
}

export type ExecutionActionDraft =
  | ExecuteProcessDraft
  | ExecuteAssemblyDraft
  | ExecuteShellcodeDraft
  | SideloadDraft
  | SpawnDllDraft
  | MigrateDraft
  | MsfDraft
  | MsfInjectDraft
  | PsexecDraft
  | SshDraft
  | BackdoorDraft
  | DllHijackDraft
  | RunAsDraft
  | MakeTokenDraft
  | ImpersonateDraft
  | RevertIdentityDraft
  | GetSystemDraft;

export interface RunExecutionReadInput {
  operationId: ExecutionReadOperationId;
  /** Exact main-correlated beacon task to refresh; omitted for a new read. */
  taskId?: string;
  cursor?: string;
  limit?: number;
}

export interface PrepareExecutionActionInput {
  draft: ExecutionActionDraft;
}

export interface ExecutionReviewField {
  label: string;
  value: string;
  sensitive: false;
}

export interface ExecutionReviewArtifact {
  role: ExecutionArtifactRole;
  fileName: string;
  mediaType: string;
  size: number;
  sha256: string;
}

export interface ExecutionReviewTarget {
  backend: OperationBackendSummary;
  target: TargetSummary;
  fingerprint: string;
}

export interface ExecutionActionPlan {
  token: string;
  operationId: ExecutionOperationId;
  expiresAt: string;
  risk: ExecutionRiskClass;
  target: ExecutionReviewTarget;
  warning: string;
  fields: ExecutionReviewField[];
  artifacts: ExecutionReviewArtifact[];
  currentIdentity?: string;
  requestedIdentity?: string;
}

export interface ExecuteExecutionPlanInput {
  token: string;
}

export const EXECUTION_RESULT_STATES = Object.freeze([
  "completed",
  "submitted",
  "partial",
  "failed",
  "canceled",
  "outcome-unknown",
  "target-disappeared",
] as const);

export type ExecutionResultState = (typeof EXECUTION_RESULT_STATES)[number];

export interface ExecutionOutputMetadata extends SafeArtifactHandle {
  stream: "stdout" | "stderr" | "combined";
  truncated: boolean;
}

export interface ExecutionActionResult {
  requestId: string;
  operationId: ExecutionOperationId;
  state: ExecutionResultState;
  message: string;
  taskId?: string;
  pid?: number;
  /** Available only when a process was waited for and its exit status was returned. */
  exitCode?: number;
  output?: ExecutionOutputMetadata[];
}

export interface ExecutionChildSummary {
  pid: number;
  path: string;
  args: string[];
  startedAt?: string;
  exited: boolean;
  exitCode?: number;
  exitedAt?: string;
  stdoutBytes: number;
  stderrBytes: number;
  error?: string;
}

export interface ExecutionChildrenResult {
  operationId: "execution.children";
  state: "completed" | "submitted";
  taskId?: string;
  items: ExecutionChildSummary[];
  total: number;
  nextCursor?: string;
  truncated: boolean;
}

export interface ExecutionPrivilegeSummary {
  name: string;
  description: string;
  enabled: boolean;
  enabledByDefault: boolean;
  removed: boolean;
  usedForAccess: boolean;
}

export interface ExecutionPrivilegesResult {
  operationId: "privilege.get";
  state: "completed" | "submitted";
  taskId?: string;
  processName: string;
  processIntegrity: string;
  currentIdentity?: string;
  privileges: ExecutionPrivilegeSummary[];
  total: number;
  nextCursor?: string;
  truncated: boolean;
}

export type ExecutionReadResult = ExecutionChildrenResult | ExecutionPrivilegesResult;

export interface ExecutionResultRequest {
  requestId: string;
}

export interface SaveExecutionResultInput extends ExecutionResultRequest {
  stream: "stdout" | "stderr" | "combined";
}

export interface ReadExecutionOutputInput extends ExecutionResultRequest {
  stream: "stdout" | "stderr" | "combined";
}

export interface AddExecutionOutputToLootInput extends ReadExecutionOutputInput {
  /** Empty uses a generated name, matching the console's optional --name. */
  name: string;
}

export interface ExecutionOutputReadResult {
  data: Uint8Array;
  truncated: boolean;
}

export interface SaveExecutionResultResult {
  saved: boolean;
  fileName?: string;
}

export const EXECUTION_LIMITS = Object.freeze({
  string: 4_096,
  shortString: 256,
  path: 8_192,
  arguments: 128,
  environment: 128,
  command: 128,
  secretBytes: 64 * 1_024,
  timeoutSeconds: 3_600,
  artifactBytes: 64 * 1_024 * 1_024,
  pageLimit: 100,
  cursor: 256,
  token: 256,
  pid: 2_147_483_647,
  port: 65_535,
  iterations: 100,
} as const);

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function isExecutionOperationId(value: unknown): value is ExecutionOperationId {
  return typeof value === "string" && (EXECUTION_OPERATION_IDS as readonly string[]).includes(value);
}

export function isExecutionReadOperationId(value: unknown): value is ExecutionReadOperationId {
  return typeof value === "string" && (EXECUTION_READ_OPERATION_IDS as readonly string[]).includes(value);
}

export function parseRunExecutionReadInput(value: unknown): RunExecutionReadInput {
  const record = plainRecord(value, "execution read input");
  exactKeys(record, ["operationId"], ["taskId", "cursor", "limit"]);
  if (!isExecutionReadOperationId(record["operationId"])) {
    throw new TypeError("operationId is not an allowed execution read operation");
  }
  const parsed: RunExecutionReadInput = { operationId: record["operationId"] };
  if (record["taskId"] !== undefined) parsed.taskId = opaqueToken(record["taskId"], "taskId");
  if (record["cursor"] !== undefined) parsed.cursor = stringValue(record["cursor"], "cursor", EXECUTION_LIMITS.cursor);
  if (record["limit"] !== undefined) parsed.limit = integer(record["limit"], "limit", 1, EXECUTION_LIMITS.pageLimit);
  return parsed;
}

export function parsePrepareExecutionActionInput(value: unknown): PrepareExecutionActionInput {
  const record = plainRecord(value, "prepare execution action input");
  exactKeys(record, ["draft"]);
  return { draft: parseExecutionActionDraft(record["draft"]) };
}

export function parseExecuteExecutionPlanInput(value: unknown): ExecuteExecutionPlanInput {
  const record = plainRecord(value, "execute execution plan input");
  exactKeys(record, ["token"]);
  return { token: opaqueToken(record["token"], "token") };
}

export function parseExecutionResultRequest(value: unknown): ExecutionResultRequest {
  const record = plainRecord(value, "execution result request");
  exactKeys(record, ["requestId"]);
  return { requestId: opaqueToken(record["requestId"], "requestId") };
}

export function parseSaveExecutionResultInput(value: unknown): SaveExecutionResultInput {
  return parseExecutionOutputStreamInput(value, "save execution result input");
}

export function parseReadExecutionOutputInput(value: unknown): ReadExecutionOutputInput {
  return parseExecutionOutputStreamInput(value, "read execution output input");
}

export function parseAddExecutionOutputToLootInput(value: unknown): AddExecutionOutputToLootInput {
  const record = plainRecord(value, "add execution output to loot input");
  exactKeys(record, ["requestId", "stream", "name"]);
  const output = parseExecutionOutputStreamInput(
    { requestId: record["requestId"], stream: record["stream"] },
    "add execution output to loot input",
  );
  const name = stringValue(record["name"], "name", EXECUTION_LIMITS.shortString, true).trim();
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)) {
    throw new TypeError("name contains unsupported control characters");
  }
  return { ...output, name };
}

function parseExecutionOutputStreamInput(
  value: unknown,
  label: string,
): ReadExecutionOutputInput {
  const record = plainRecord(value, label);
  exactKeys(record, ["requestId", "stream"]);
  const stream = record["stream"];
  if (stream !== "stdout" && stream !== "stderr" && stream !== "combined") {
    throw new TypeError("stream must be stdout, stderr, or combined");
  }
  return { requestId: opaqueToken(record["requestId"], "requestId"), stream };
}

export function parseExecutionActionDraft(value: unknown): ExecutionActionDraft {
  const record = plainRecord(value, "execution action draft");
  const operationId = record["operationId"];
  if (!isExecutionOperationId(operationId) || isExecutionReadOperationId(operationId)) {
    throw new TypeError("operationId is not an allowed execution action");
  }
  switch (operationId) {
    case "execution.process":
      return parseExecuteProcess(record);
    case "execution.assembly":
      return parseAssembly(record);
    case "execution.shellcode":
      return parseShellcode(record);
    case "execution.sideload":
      return parseSideload(record);
    case "execution.spawn-dll":
      return parseSpawnDll(record);
    case "execution.migrate":
      return parseMigrate(record);
    case "execution.msf":
      return parseMsf(record, false);
    case "execution.msf-inject":
      return parseMsf(record, true);
    case "execution.psexec":
      return parsePsexec(record);
    case "execution.ssh":
      return parseSsh(record);
    case "execution.backdoor":
      return parseBackdoor(record);
    case "execution.dll-hijack":
      return parseDllHijack(record);
    case "privilege.run-as":
      return parseRunAs(record);
    case "privilege.make-token":
      return parseMakeToken(record);
    case "privilege.impersonate":
      return parseImpersonate(record);
    case "privilege.revert":
      exactKeys(record, ["operationId", "timeoutSeconds"]);
      return { operationId, timeoutSeconds: timeout(record["timeoutSeconds"]) };
    case "privilege.get-system":
      exactKeys(record, ["operationId", "hostingProcess", "timeoutSeconds"]);
      return {
        operationId,
        hostingProcess: stringValue(record["hostingProcess"], "hostingProcess", EXECUTION_LIMITS.path),
        timeoutSeconds: timeout(record["timeoutSeconds"]),
      };
  }
}

function parseExecuteProcess(record: Record<string, unknown>): ExecuteProcessDraft {
  exactKeys(record, [
    "operationId", "path", "args", "captureOutput", "background", "inheritEnvironment",
    "environment", "useToken", "hideWindow", "timeoutSeconds",
  ], ["stdoutPath", "stderrPath", "parentPid"]);
  const parsed: ExecuteProcessDraft = {
    operationId: "execution.process",
    path: stringValue(record["path"], "path", EXECUTION_LIMITS.path),
    args: stringArray(record["args"], "args", EXECUTION_LIMITS.arguments),
    captureOutput: booleanValue(record["captureOutput"], "captureOutput"),
    background: booleanValue(record["background"], "background"),
    inheritEnvironment: booleanValue(record["inheritEnvironment"], "inheritEnvironment"),
    environment: environmentEntries(record["environment"]),
    useToken: booleanValue(record["useToken"], "useToken"),
    hideWindow: booleanValue(record["hideWindow"], "hideWindow"),
    timeoutSeconds: timeout(record["timeoutSeconds"]),
  };
  if (record["stdoutPath"] !== undefined) parsed.stdoutPath = stringValue(record["stdoutPath"], "stdoutPath", EXECUTION_LIMITS.path);
  if (record["stderrPath"] !== undefined) parsed.stderrPath = stringValue(record["stderrPath"], "stderrPath", EXECUTION_LIMITS.path);
  if (record["parentPid"] !== undefined) parsed.parentPid = pid(record["parentPid"], "parentPid", true);
  if (parsed.background && parsed.captureOutput) throw new TypeError("background execution cannot capture output");
  if ((parsed.useToken || parsed.hideWindow || parsed.parentPid !== undefined) && (parsed.inheritEnvironment || parsed.environment.length > 0)) {
    throw new TypeError("Windows token, hidden, and parent-PID execution cannot include environment overrides");
  }
  return parsed;
}

function parseAssembly(record: Record<string, unknown>): ExecuteAssemblyDraft {
  exactKeys(record, [
    "operationId", "args", "process", "isDll", "architecture", "processArgs", "inProcess",
    "amsiBypass", "etwBypass", "timeoutSeconds",
  ], ["className", "method", "appDomain", "parentPid", "runtime"]);
  const architecture = record["architecture"];
  if (architecture !== "x86" && architecture !== "x64" && architecture !== "x84") {
    throw new TypeError("architecture must be x86, x64, or x84");
  }
  const parsed: ExecuteAssemblyDraft = {
    operationId: "execution.assembly",
    args: stringArray(record["args"], "args", EXECUTION_LIMITS.arguments),
    process: stringValue(record["process"], "process", EXECUTION_LIMITS.path),
    isDll: booleanValue(record["isDll"], "isDll"),
    architecture,
    processArgs: stringArray(record["processArgs"], "processArgs", EXECUTION_LIMITS.arguments),
    inProcess: booleanValue(record["inProcess"], "inProcess"),
    amsiBypass: booleanValue(record["amsiBypass"], "amsiBypass"),
    etwBypass: booleanValue(record["etwBypass"], "etwBypass"),
    timeoutSeconds: timeout(record["timeoutSeconds"]),
  };
  optionalStringFields(record, parsed, ["className", "method", "appDomain", "runtime"]);
  if (record["parentPid"] !== undefined) parsed.parentPid = pid(record["parentPid"], "parentPid", true);
  if (parsed.isDll && (!parsed.className || !parsed.method)) throw new TypeError("DLL assemblies require className and method");
  if (!parsed.inProcess && (parsed.runtime || parsed.amsiBypass || parsed.etwBypass)) {
    throw new TypeError("runtime and bypass options require in-process execution");
  }
  return parsed;
}

function parseShellcode(record: Record<string, unknown>): ExecuteShellcodeDraft {
  exactKeys(record, ["operationId", "declaredArchitecture", "pid", "rwxPages", "timeoutSeconds"]);
  const declaredArchitecture = record["declaredArchitecture"];
  if (declaredArchitecture !== "386" && declaredArchitecture !== "amd64" && declaredArchitecture !== "arm64") {
    throw new TypeError("declaredArchitecture must be 386, amd64, or arm64");
  }
  return {
    operationId: "execution.shellcode",
    declaredArchitecture,
    pid: pid(record["pid"], "pid", true),
    rwxPages: booleanValue(record["rwxPages"], "rwxPages"),
    timeoutSeconds: timeout(record["timeoutSeconds"]),
  };
}

function parseSideload(record: Record<string, unknown>): SideloadDraft {
  exactKeys(record, [
    "operationId", "process", "args", "entryPoint", "unicode", "keepAlive", "processArgs", "timeoutSeconds",
  ], ["parentPid"]);
  const parsed: SideloadDraft = {
    operationId: "execution.sideload",
    process: stringValue(record["process"], "process", EXECUTION_LIMITS.path),
    args: stringArray(record["args"], "args", EXECUTION_LIMITS.arguments),
    entryPoint: stringValue(record["entryPoint"], "entryPoint", EXECUTION_LIMITS.shortString, true),
    unicode: booleanValue(record["unicode"], "unicode"),
    keepAlive: booleanValue(record["keepAlive"], "keepAlive"),
    processArgs: stringArray(record["processArgs"], "processArgs", EXECUTION_LIMITS.arguments),
    timeoutSeconds: timeout(record["timeoutSeconds"]),
  };
  if (record["parentPid"] !== undefined) parsed.parentPid = pid(record["parentPid"], "parentPid", true);
  return parsed;
}

function parseSpawnDll(record: Record<string, unknown>): SpawnDllDraft {
  exactKeys(record, ["operationId", "process", "args", "entryPoint", "keepAlive", "timeoutSeconds"]);
  return {
    operationId: "execution.spawn-dll",
    process: stringValue(record["process"], "process", EXECUTION_LIMITS.path),
    args: stringArray(record["args"], "args", EXECUTION_LIMITS.arguments),
    entryPoint: stringValue(record["entryPoint"], "entryPoint", EXECUTION_LIMITS.shortString),
    keepAlive: booleanValue(record["keepAlive"], "keepAlive"),
    timeoutSeconds: timeout(record["timeoutSeconds"]),
  };
}

function parseMigrate(record: Record<string, unknown>): MigrateDraft {
  exactKeys(record, ["operationId", "timeoutSeconds"], ["pid", "processName", "encoder"]);
  const parsed: MigrateDraft = { operationId: "execution.migrate", timeoutSeconds: timeout(record["timeoutSeconds"]) };
  if (record["pid"] !== undefined) parsed.pid = pid(record["pid"], "pid");
  if (record["processName"] !== undefined) parsed.processName = stringValue(record["processName"], "processName", EXECUTION_LIMITS.path);
  if (record["encoder"] !== undefined) parsed.encoder = stringValue(record["encoder"], "encoder", EXECUTION_LIMITS.shortString, true);
  if ((parsed.pid === undefined) === (parsed.processName === undefined)) throw new TypeError("provide exactly one of pid or processName");
  return parsed;
}

function parseMsf(record: Record<string, unknown>, inject: boolean): MsfDraft | MsfInjectDraft {
  exactKeys(record, [
    "operationId", ...(inject ? ["pid"] : []), "payload", "lhost", "lport", "iterations", "timeoutSeconds",
  ], ["encoder"]);
  const common = {
    payload: stringValue(record["payload"], "payload", EXECUTION_LIMITS.shortString),
    lhost: stringValue(record["lhost"], "lhost", EXECUTION_LIMITS.shortString),
    lport: integer(record["lport"], "lport", 1, EXECUTION_LIMITS.port),
    iterations: integer(record["iterations"], "iterations", 0, EXECUTION_LIMITS.iterations),
    timeoutSeconds: timeout(record["timeoutSeconds"]),
  };
  const encoder = record["encoder"] === undefined ? undefined : stringValue(record["encoder"], "encoder", EXECUTION_LIMITS.shortString, true);
  if (inject) {
    return { operationId: "execution.msf-inject", pid: pid(record["pid"], "pid"), ...common, ...(encoder === undefined ? {} : { encoder }) };
  }
  return { operationId: "execution.msf", ...common, ...(encoder === undefined ? {} : { encoder }) };
}

function parsePsexec(record: Record<string, unknown>): PsexecDraft {
  exactKeys(record, ["operationId", "hostname", "serviceName", "serviceDescription", "remotePath", "source", "timeoutSeconds"]);
  const sourceRecord = plainRecord(record["source"], "source");
  const kind = sourceRecord["kind"];
  let source: PsexecSource;
  if (kind === "profile") {
    exactKeys(sourceRecord, ["kind", "profileName"]);
    source = { kind, profileName: stringValue(sourceRecord["profileName"], "profileName", EXECUTION_LIMITS.shortString) };
  } else if (kind === "native-file") {
    exactKeys(sourceRecord, ["kind"]);
    source = { kind };
  } else throw new TypeError("psexec source kind is invalid");
  return {
    operationId: "execution.psexec",
    hostname: stringValue(record["hostname"], "hostname", EXECUTION_LIMITS.shortString),
    serviceName: stringValue(record["serviceName"], "serviceName", EXECUTION_LIMITS.shortString),
    serviceDescription: stringValue(record["serviceDescription"], "serviceDescription", EXECUTION_LIMITS.string, true),
    remotePath: stringValue(record["remotePath"], "remotePath", EXECUTION_LIMITS.path),
    source,
    timeoutSeconds: timeout(record["timeoutSeconds"]),
  };
}

function parseSsh(record: Record<string, unknown>): SshDraft {
  exactKeys(record, ["operationId", "hostname", "port", "username", "command", "authentication", "timeoutSeconds"]);
  // Parse every non-secret field before allocating the owned credential copy.
  // A later validation failure must never strand a copied password for GC.
  const hostname = stringValue(record["hostname"], "hostname", EXECUTION_LIMITS.shortString);
  const port = integer(record["port"], "port", 1, EXECUTION_LIMITS.port);
  const username = stringValue(record["username"], "username", EXECUTION_LIMITS.shortString);
  const command = stringArray(record["command"], "command", EXECUTION_LIMITS.command);
  const timeoutSeconds = timeout(record["timeoutSeconds"]);
  const auth = plainRecord(record["authentication"], "authentication");
  const kind = auth["kind"];
  let authentication: SshAuthentication;
  if (kind === "password") {
    exactKeys(auth, ["kind", "password"]);
    authentication = { kind, password: secretBytes(auth["password"], "password") };
  } else if (kind === "private-key") {
    exactKeys(auth, ["kind"]);
    authentication = { kind };
  } else if (kind === "kerberos") {
    exactKeys(auth, ["kind", "realm", "configPath"]);
    authentication = {
      kind,
      realm: stringValue(auth["realm"], "realm", EXECUTION_LIMITS.shortString),
      configPath: stringValue(auth["configPath"], "configPath", EXECUTION_LIMITS.path),
    };
  } else throw new TypeError("SSH authentication kind is invalid");
  return {
    operationId: "execution.ssh",
    hostname,
    port,
    username,
    command,
    authentication,
    timeoutSeconds,
  };
}

function parseBackdoor(record: Record<string, unknown>): BackdoorDraft {
  exactKeys(record, ["operationId", "remotePath", "profileName", "name", "timeoutSeconds"]);
  return {
    operationId: "execution.backdoor",
    remotePath: stringValue(record["remotePath"], "remotePath", EXECUTION_LIMITS.path),
    profileName: stringValue(record["profileName"], "profileName", EXECUTION_LIMITS.shortString),
    name: stringValue(record["name"], "name", EXECUTION_LIMITS.shortString),
    timeoutSeconds: timeout(record["timeoutSeconds"]),
  };
}

function parseDllHijack(record: Record<string, unknown>): DllHijackDraft {
  exactKeys(record, ["operationId", "referenceDllPath", "targetLocation", "source", "includeReferenceDll", "name", "timeoutSeconds"]);
  const sourceRecord = plainRecord(record["source"], "source");
  const kind = sourceRecord["kind"];
  let source: DllHijackSource;
  if (kind === "profile") {
    exactKeys(sourceRecord, ["kind", "profileName"]);
    source = { kind, profileName: stringValue(sourceRecord["profileName"], "profileName", EXECUTION_LIMITS.shortString) };
  } else if (kind === "native-file") {
    exactKeys(sourceRecord, ["kind"]);
    source = { kind };
  } else throw new TypeError("DLL hijack source kind is invalid");
  return {
    operationId: "execution.dll-hijack",
    referenceDllPath: stringValue(record["referenceDllPath"], "referenceDllPath", EXECUTION_LIMITS.path),
    targetLocation: stringValue(record["targetLocation"], "targetLocation", EXECUTION_LIMITS.path),
    source,
    includeReferenceDll: booleanValue(record["includeReferenceDll"], "includeReferenceDll"),
    name: stringValue(record["name"], "name", EXECUTION_LIMITS.shortString),
    timeoutSeconds: timeout(record["timeoutSeconds"]),
  };
}

function parseRunAs(record: Record<string, unknown>): RunAsDraft {
  exactKeys(record, ["operationId", "username", "domain", "password", "process", "args", "showWindow", "netOnly", "timeoutSeconds"]);
  // Keep the credential allocation last so every fallible structural/value
  // check completes before the owned byte copy exists.
  const username = stringValue(record["username"], "username", EXECUTION_LIMITS.shortString);
  const domain = stringValue(record["domain"], "domain", EXECUTION_LIMITS.shortString, true);
  const process = stringValue(record["process"], "process", EXECUTION_LIMITS.path);
  const args = stringValue(record["args"], "args", EXECUTION_LIMITS.string, true);
  const showWindow = booleanValue(record["showWindow"], "showWindow");
  const netOnly = booleanValue(record["netOnly"], "netOnly");
  const timeoutSeconds = timeout(record["timeoutSeconds"]);
  const password = secretBytes(record["password"], "password");
  return {
    operationId: "privilege.run-as",
    username,
    domain,
    password,
    process,
    args,
    showWindow,
    netOnly,
    timeoutSeconds,
  };
}

function parseMakeToken(record: Record<string, unknown>): MakeTokenDraft {
  exactKeys(record, ["operationId", "username", "domain", "password", "logonType", "timeoutSeconds"]);
  const logonType = record["logonType"];
  const allowed: readonly unknown[] = ["interactive", "network", "batch", "service", "unlock", "network-cleartext", "new-credentials"];
  if (!allowed.includes(logonType)) throw new TypeError("logonType is invalid");
  const username = stringValue(record["username"], "username", EXECUTION_LIMITS.shortString);
  const domain = stringValue(record["domain"], "domain", EXECUTION_LIMITS.shortString, true);
  const timeoutSeconds = timeout(record["timeoutSeconds"]);
  const password = secretBytes(record["password"], "password");
  return {
    operationId: "privilege.make-token",
    username,
    domain,
    password,
    logonType: logonType as TokenLogonType,
    timeoutSeconds,
  };
}

function parseImpersonate(record: Record<string, unknown>): ImpersonateDraft {
  exactKeys(record, ["operationId", "username", "timeoutSeconds"]);
  return {
    operationId: "privilege.impersonate",
    username: stringValue(record["username"], "username", EXECUTION_LIMITS.shortString),
    timeoutSeconds: timeout(record["timeoutSeconds"]),
  };
}

function environmentEntries(value: unknown): ExecutionEnvironmentEntry[] {
  if (!Array.isArray(value) || value.length > EXECUTION_LIMITS.environment) {
    throw new TypeError(`environment must contain at most ${EXECUTION_LIMITS.environment} entries`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const record = plainRecord(entry, `environment[${index}]`);
    exactKeys(record, ["name", "value"]);
    const name = stringValue(record["name"], `environment[${index}].name`, EXECUTION_LIMITS.shortString);
    if (name.includes("=") || name.includes("\0")) throw new TypeError("environment names must not contain '=' or NUL");
    if (seen.has(name)) throw new TypeError(`duplicate environment name: ${name}`);
    seen.add(name);
    const environmentValue = stringValue(record["value"], `environment[${index}].value`, EXECUTION_LIMITS.string, true);
    if (environmentValue.includes("\0")) throw new TypeError("environment values must not contain NUL");
    return { name, value: environmentValue };
  });
}

function optionalStringFields<Target extends object>(
  source: Record<string, unknown>,
  target: Target,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (source[key] !== undefined) {
      (target as Record<string, unknown>)[key] = stringValue(source[key], key, EXECUTION_LIMITS.string, true);
    }
  }
}

function stringArray(value: unknown, name: string, maximumItems: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new TypeError(`${name} must contain at most ${maximumItems} strings`);
  return value.map((item, index) => stringValue(item, `${name}[${index}]`, EXECUTION_LIMITS.string, true));
}

function secretBytes(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > EXECUTION_LIMITS.secretBytes) {
    throw new TypeError(`${name} must be 1-${EXECUTION_LIMITS.secretBytes} bytes`);
  }
  return new Uint8Array(value);
}

function timeout(value: unknown): number {
  return integer(value, "timeoutSeconds", 1, EXECUTION_LIMITS.timeoutSeconds);
}

function pid(value: unknown, name: string, allowZero = false): number {
  return integer(value, name, allowZero ? 0 : 2, EXECUTION_LIMITS.pid);
}

function opaqueToken(value: unknown, name: string): string {
  const token = stringValue(value, name, EXECUTION_LIMITS.token);
  if (!IDENTIFIER_PATTERN.test(token)) throw new TypeError(`${name} contains unsupported characters`);
  return token;
}

function stringValue(value: unknown, name: string, maximumLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximumLength || (!allowEmpty && value.length === 0) || value.includes("\0")) {
    throw new TypeError(`${name} must be a ${allowEmpty ? "0" : "1"}-${maximumLength} character string without NUL`);
  }
  return value;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${name} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  const unexpected = keys.find((key) => !allowed.has(key));
  if (unexpected) throw new TypeError(`unexpected field: ${unexpected}`);
  const missing = required.find((key) => !(key in record));
  if (missing) throw new TypeError(`missing required field: ${missing}`);
}
