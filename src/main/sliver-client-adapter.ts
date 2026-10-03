import {
  SliverClient,
  timeoutSecondsToNanoseconds,
  withTimeoutSignal,
  type SliverClientConfig,
  type SessionRegistryWriteValue,
  sliverpb,
  type clientpb,
} from "sliver-script";
import { createHash } from "node:crypto";
import type { SessionRegistryHive } from "../shared/session-contracts.js";

/**
 * The complete, reviewed main-process Sliver surface.
 *
 * Keeping this as an explicit Pick is a security boundary: target operations
 * cannot obtain the raw RPC client or select a method from renderer data.
 */
export type SliverClientMethod =
  | "connect"
  | "disconnect"
  | "getVersion"
  | "jobs"
  | "startPortForward"
  | "listPortForwards"
  | "stopPortForward"
  | "startSocks5Proxy"
  | "listSocks5Proxies"
  | "stopSocks5Proxy"
  | "startReversePortForward"
  | "listReversePortForwards"
  | "stopReversePortForward"
  | "implantBuilds"
  | "implantProfiles"
  | "getCompiler"
  | "startMTLSListener"
  | "startWGListener"
  | "startDNSListener"
  | "startHTTPListenerWithOptions"
  | "startHTTPSListenerWithOptions"
  | "startTCPStagerListenerWithOptions"
  | "killJob"
  | "generateUniqueIP"
  | "generateImplant"
  | "regenerateImplant"
  | "deleteImplantBuild"
  | "stageImplantBuild"
  | "saveImplantProfile"
  | "deleteImplantProfile"
  | "lootAll"
  | "lootAdd"
  | "lootUpdate"
  | "lootRemove"
  | "lootContent"
  | "credentialsAll"
  | "credentialById"
  | "credentialAdd"
  | "credentialRemove"
  | "credentialSniffHashType"
  | "getOperators"
  | "getSessions"
  | "getBeacons"
  | "renameSession"
  | "renameBeacon"
  | "pingSession"
  | "pingBeacon"
  | "getEnvSession"
  | "getEnvBeacon"
  | "setEnvSession"
  | "setEnvBeacon"
  | "unsetEnvSession"
  | "unsetEnvBeacon"
  | "killSession"
  | "killBeacon"
  | "reconfigureBeacon"
  | "openSessionFromBeacon"
  | "closeSession"
  | "getBeaconTasks"
  | "fetchBeaconTask"
  | "cancelBeaconTask"
  | "rmBeacon"
  | "currentTokenOwnerSession"
  | "listEnvSession"
  | "revealEnvSession"
  | "ifconfigSession"
  | "netstatSession"
  | "pwdSession"
  | "cdSession"
  | "lsSession"
  | "downloadFileSession"
  | "uploadSession"
  | "grepSession"
  | "cpSession"
  | "mvSession"
  | "mkdirSession"
  | "rmSession"
  | "mountsSession"
  | "memfilesListSession"
  | "memfilesAddSession"
  | "memfilesRmSession"
  | "chmodSession"
  | "chownSession"
  | "chtimesSession"
  | "psSession"
  | "terminateSessionProcess"
  | "processDumpSession"
  | "screenshotSession"
  | "servicesSession"
  | "serviceDetailSession"
  | "startServiceSession"
  | "stopServiceSession"
  | "registryReadSession"
  | "registryListSubkeysSession"
  | "registryListValuesSession"
  | "registryReadHiveSession"
  | "registryWriteSession"
  | "registryCreateKeySession"
  | "registryDeleteKeySession"
  | "startShellSession"
  | "executeSession"
  | "executeBeacon"
  | "executeChildrenSession"
  | "executeChildrenBeacon"
  | "executeAssemblySession"
  | "executeAssemblyBeacon"
  | "executeShellcodeSession"
  | "executeShellcodeBeacon"
  | "sideloadSession"
  | "sideloadBeacon"
  | "spawnDllSession"
  | "spawnDllBeacon"
  | "getShellcodeEncoderMap"
  | "migrateSession"
  | "migrateBeacon"
  | "msfSession"
  | "msfBeacon"
  | "msfRemoteSession"
  | "msfRemoteBeacon"
  | "runSshSession"
  | "runAsSession"
  | "runAsBeacon"
  | "makeTokenSession"
  | "makeTokenBeacon"
  | "impersonateSession"
  | "impersonateBeacon"
  | "revToSelfSession"
  | "revToSelfBeacon"
  | "getSystemSession"
  | "getPrivsSession"
  | "getPrivsBeacon"
  | "currentTokenOwnerBeacon"
  | "backdoorSession"
  | "hijackDllSession"
  | "startRemoteServiceSession"
  | "removeRemoteServiceSession";

export type SliverClientAdapter = Pick<
  SliverClient,
  Exclude<SliverClientMethod, "connect"> | "event$" | "eventStreamState$"
> & {
  connect(): Promise<unknown>;
  /** Server inventory only; does not query or operate an individual target. */
  getPivotGraph?(): Promise<clientpb.PivotGraph>;
  getExternalBuilders?(): Promise<clientpb.Builders>;
  getCrackstations?(): Promise<clientpb.Crackstations>;
  pwdBeacon(beaconId: string, timeoutSeconds: number): Promise<sliverpb.Pwd>;
  lsBeacon(beaconId: string, path: string, timeoutSeconds: number): Promise<sliverpb.Ls>;
  psBeacon(beaconId: string, fullInfo: boolean, timeoutSeconds: number): Promise<sliverpb.Ps>;
  ifconfigBeacon(beaconId: string, timeoutSeconds: number): Promise<sliverpb.Ifconfig>;
  envBeacon(beaconId: string, name: string, timeoutSeconds: number): Promise<sliverpb.EnvInfo>;
  whoamiBeacon(beaconId: string, timeoutSeconds: number): Promise<sliverpb.CurrentTokenOwner>;
  netstatBeacon(beaconId: string, options: BeaconNetstatOptions, timeoutSeconds: number): Promise<sliverpb.Netstat>;
  mountBeacon(beaconId: string, timeoutSeconds: number): Promise<sliverpb.Mount>;
  memfilesBeacon(beaconId: string, timeoutSeconds: number): Promise<sliverpb.Ls>;
  catBeacon(beaconId: string, path: string, timeoutSeconds: number): Promise<sliverpb.Download>;
  headBeacon(beaconId: string, path: string, options: BeaconTextSliceOptions, timeoutSeconds: number): Promise<sliverpb.Download>;
  tailBeacon(beaconId: string, path: string, options: BeaconTextSliceOptions, timeoutSeconds: number): Promise<sliverpb.Download>;
  grepBeacon(beaconId: string, options: BeaconGrepOptions, timeoutSeconds: number): Promise<sliverpb.Grep>;
  registryReadBeacon(beaconId: string, options: BeaconRegistryKeyOptions, timeoutSeconds: number): Promise<sliverpb.RegistryRead>;
  registryListSubkeysBeacon(beaconId: string, options: BeaconRegistryLocationOptions, timeoutSeconds: number): Promise<sliverpb.RegistrySubKeyList>;
  registryListValuesBeacon(beaconId: string, options: BeaconRegistryLocationOptions, timeoutSeconds: number): Promise<sliverpb.RegistryValuesList>;
  registryWriteBeacon(beaconId: string, options: BeaconRegistryWriteOptions, timeoutSeconds: number): Promise<sliverpb.RegistryWrite>;
  registryCreateBeacon(beaconId: string, options: BeaconRegistryKeyOptions, timeoutSeconds: number): Promise<sliverpb.RegistryCreateKey>;
  registryDeleteBeacon(beaconId: string, options: BeaconRegistryKeyOptions, timeoutSeconds: number): Promise<sliverpb.RegistryDeleteKey>;
  servicesBeacon(beaconId: string, options: BeaconServicesOptions, timeoutSeconds: number): Promise<sliverpb.Services>;
  serviceDetailBeacon(beaconId: string, options: BeaconServiceNameOptions, timeoutSeconds: number): Promise<sliverpb.ServiceDetail>;
  serviceStartBeacon(beaconId: string, options: BeaconServiceNameOptions, timeoutSeconds: number): Promise<sliverpb.ServiceInfo>;
  serviceStopBeacon(beaconId: string, options: BeaconServiceNameOptions, timeoutSeconds: number): Promise<sliverpb.ServiceInfo>;
  /** Executes one main-selected Armory object through the fixed BOF RPC. */
  callBofSession(sessionId: string, object: Buffer, argumentsBuffer: Buffer, entrypoint: string, timeoutSeconds: number): Promise<sliverpb.CallExtension>;
  callBofBeacon(beaconId: string, object: Buffer, argumentsBuffer: Buffer, entrypoint: string, timeoutSeconds: number): Promise<sliverpb.CallExtension>;
  /** Fetches one exact, bounded server-saved beacon task on the control channel. */
  fetchBeaconTaskContent(beaconId: string, taskId: string, description: string, timeoutSeconds?: number): Promise<clientpb.BeaconTask>;
  /** Fetches only a correlated BOF task on the SDK's 16 MiB control channel. */
  fetchBofBeaconTask(beaconId: string, taskId: string, description: BofTaskDescription, timeoutSeconds?: number): Promise<clientpb.BeaconTask>;
  /** Registers a main-selected installed COFF loader for a legacy BOF. */
  registerBofLoaderSession(sessionId: string, loader: Buffer, init: string, os: string, timeoutSeconds: number): Promise<sliverpb.RegisterExtension>;
  registerBofLoaderBeacon(beaconId: string, loader: Buffer, init: string, os: string, timeoutSeconds: number): Promise<sliverpb.RegisterExtension>;
  /** Calls only that registered loader with a main-packed BOF envelope. */
  callLegacyBofSession(sessionId: string, loader: Buffer, argumentsBuffer: Buffer, exportName: string, timeoutSeconds: number): Promise<sliverpb.CallExtension>;
  callLegacyBofBeacon(beaconId: string, loader: Buffer, argumentsBuffer: Buffer, exportName: string, timeoutSeconds: number): Promise<sliverpb.CallExtension>;
};

export type SliverClientFactory = (config: SliverClientConfig) => SliverClientAdapter;

export interface BeaconNetstatOptions {
  tcp: boolean;
  udp: boolean;
  ip4: boolean;
  ip6: boolean;
  listen: boolean;
}

export interface BeaconTextSliceOptions {
  bytes?: number;
  lines?: number;
}

export interface BeaconGrepOptions {
  path: string;
  pattern: string;
  recursive: boolean;
  before: number;
  after: number;
}

export interface BeaconRegistryLocationOptions {
  hive: SessionRegistryHive;
  path: string;
  hostname?: string;
}

export interface BeaconRegistryKeyOptions extends BeaconRegistryLocationOptions {
  key: string;
}

/** Binary values are main-owned bytes; never send them through renderer IPC. */
export interface BeaconRegistryWriteOptions extends BeaconRegistryKeyOptions {
  value: SessionRegistryWriteValue;
}

export interface BeaconServicesOptions {
  hostname?: string;
}

export interface BeaconServiceNameOptions extends BeaconServicesOptions {
  name: string;
}

/** One byte past the maximum accepted complete text result detects truncation. */
export const BEACON_TEXT_READ_PROBE_BYTES = 64 * 1024 + 1;
export const BEACON_TEXT_READ_MAX_BYTES = BEACON_TEXT_READ_PROBE_BYTES - 1;
export const BEACON_TEXT_READ_MAX_LINES = 4_096;

export type BofTaskDescription = "CallExtensionReq" | "RegisterExtensionReq";
export const BEACON_TASK_CONTENT_REQUEST_MAX_BYTES = 14 * 1024 * 1024;
export const BEACON_TASK_CONTENT_MAX_BYTES = 15 * 1024 * 1024;
export const BEACON_TASK_CONTENT_RESPONSE_MAX_BYTES = BEACON_TASK_CONTENT_MAX_BYTES;
export const BOF_TASK_REQUEST_MAX_BYTES = BEACON_TASK_CONTENT_REQUEST_MAX_BYTES;
export const BOF_TASK_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const BOF_TASK_CONTENT_MAX_BYTES = BEACON_TASK_CONTENT_MAX_BYTES;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TASK_DESCRIPTION = /^[A-Za-z][A-Za-z0-9_]{0,255}$/u;
const REGISTRY_VALUE_MAX_BYTES = 4 * 1024 * 1024;
const REGISTRY_HIVES = new Set<SessionRegistryHive>(["HKCU", "HKLM", "HKCR", "HKU", "HKCC"]);

function beaconTaskRequest(beaconId: string, timeoutSeconds: number) {
  return {
    Async: true,
    Timeout: timeoutSecondsToNanoseconds(timeoutSeconds),
    BeaconID: beaconId,
    SessionID: "",
  };
}

function checkedPath(path: string): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 4_096 || path.includes("\0")) {
    throw new Error("Invalid beacon file path");
  }
  return path;
}

function checkedRegistryLocation(options: BeaconRegistryLocationOptions): {
  Hive: string; Path: string; Hostname: string;
} {
  if (!REGISTRY_HIVES.has(options.hive)) throw new Error("Unsupported beacon registry hive");
  if (typeof options.path !== "string" || options.path.length > 4_096 || options.path.includes("\0")) {
    throw new Error("Invalid beacon registry path");
  }
  return { Hive: options.hive, Path: options.path, Hostname: checkedHostname(options.hostname) };
}

function checkedRegistryKey(key: string, allowEmpty: boolean): string {
  if (typeof key !== "string" || (!allowEmpty && key.length === 0) || key.length > 512 || key.includes("\0")) {
    throw new Error("Invalid beacon registry key or value name");
  }
  return key;
}

function checkedHostname(hostname: string | undefined): string {
  if (hostname === undefined) return "";
  if (typeof hostname !== "string" || hostname.length > 255 || hostname.includes("\0")) {
    throw new Error("Invalid remote hostname");
  }
  return hostname;
}

function checkedServiceName(name: string): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 512 || name.includes("\0")) {
    throw new Error("Invalid Windows service name");
  }
  return name;
}

function beaconRegistryWriteFields(value: SessionRegistryWriteValue): {
  StringValue: string; ByteValue: Buffer; DWordValue: number; QWordValue: string; Type: sliverpb.RegistryType;
} {
  switch (value?.type) {
    case "string":
      if (typeof value.value !== "string" || Buffer.byteLength(value.value) > REGISTRY_VALUE_MAX_BYTES) {
        throw new Error("Invalid beacon registry string value");
      }
      return { StringValue: value.value, ByteValue: Buffer.alloc(0), DWordValue: 0,
        QWordValue: "0", Type: sliverpb.RegistryType.String };
    case "binary":
      if (!Buffer.isBuffer(value.value) || value.value.length > REGISTRY_VALUE_MAX_BYTES) {
        throw new Error("Invalid beacon registry binary value");
      }
      return { StringValue: "", ByteValue: Buffer.from(value.value), DWordValue: 0,
        QWordValue: "0", Type: sliverpb.RegistryType.Binary };
    case "dword":
      if (!Number.isInteger(value.value) || value.value < 0 || value.value > 0xffff_ffff) {
        throw new Error("Invalid beacon registry DWORD value");
      }
      return { StringValue: "", ByteValue: Buffer.alloc(0), DWordValue: value.value,
        QWordValue: "0", Type: sliverpb.RegistryType.DWORD };
    case "qword":
      if (typeof value.value !== "string" || !/^\d+$/u.test(value.value) ||
        value.value.length > 20 || BigInt(value.value) > 0xffff_ffff_ffff_ffffn) {
        throw new Error("Invalid beacon registry QWORD value");
      }
      return { StringValue: "", ByteValue: Buffer.alloc(0), DWordValue: 0,
        QWordValue: value.value, Type: sliverpb.RegistryType.QWORD };
    default:
      throw new Error("Unsupported beacon registry value type");
  }
}

function checkedSliceCount(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return value;
}

function beaconTextSlice(options: BeaconTextSliceOptions, tail: boolean): { MaxBytes: string; MaxLines: string } {
  const hasBytes = options.bytes !== undefined;
  const hasLines = options.lines !== undefined;
  if (hasBytes === hasLines) throw new Error("Choose either bytes or lines");
  if (tail && !hasBytes) {
    // The pinned implant reads the whole file before applying a negative
    // MaxLines value, so line-mode tail cannot have a reliable memory bound.
    throw new Error("Beacon tail currently supports bounded bytes only");
  }
  if (hasBytes) {
    const count = checkedSliceCount(options.bytes!, BEACON_TEXT_READ_MAX_BYTES, "Byte count");
    return { MaxBytes: String(tail ? -count : count), MaxLines: "0" };
  }
  const count = checkedSliceCount(options.lines!, BEACON_TEXT_READ_MAX_LINES, "Line count");
  return { MaxBytes: String(BEACON_TEXT_READ_PROBE_BYTES), MaxLines: String(count) };
}

function isByteArray(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && (value as Uint8Array).BYTES_PER_ELEMENT === 1 &&
    typeof (value as Uint8Array).fill === "function";
}

function verifyBofTaskContent(
  task: clientpb.BeaconTask,
  beaconId: string,
  taskId: string,
  description: BofTaskDescription,
): clientpb.BeaconTask {
  if (task.ID === taskId && task.BeaconID === beaconId && task.Description === description &&
    isByteArray(task.Request) && isByteArray(task.Response) &&
    task.Request.length <= BOF_TASK_REQUEST_MAX_BYTES &&
    task.Response.length <= BOF_TASK_RESPONSE_MAX_BYTES &&
    task.Request.length + task.Response.length <= BOF_TASK_CONTENT_MAX_BYTES) return task;
  if (isByteArray(task.Request)) task.Request.fill(0);
  if (isByteArray(task.Response)) task.Response.fill(0);
  throw new Error("The BOF task content did not match the bounded request");
}

function verifyBeaconTaskContent(
  task: clientpb.BeaconTask,
  beaconId: string,
  taskId: string,
  description: string,
): clientpb.BeaconTask {
  if (task?.ID === taskId && task.BeaconID === beaconId && task.Description === description &&
    isByteArray(task.Request) && isByteArray(task.Response) &&
    task.Request.length <= BEACON_TASK_CONTENT_REQUEST_MAX_BYTES &&
    task.Response.length <= BEACON_TASK_CONTENT_RESPONSE_MAX_BYTES &&
    task.Request.length + task.Response.length <= BEACON_TASK_CONTENT_MAX_BYTES) return task;
  if (isByteArray(task?.Request)) task.Request.fill(0);
  if (isByteArray(task?.Response)) task.Response.fill(0);
  throw new Error("The beacon task content did not match the bounded request");
}

/**
 * Adds narrow passive inventory reads and reviewed beacon task wrappers.
 * `interactBeacon` deliberately remains outside SliverClientAdapter.
 */
export function adaptSliverClient(client: SliverClient): SliverClientAdapter {
  return Object.assign(client, {
    getPivotGraph: () => withTimeoutSignal(10, (signal) => client.rpc.pivotGraph({}, { signal })),
    getExternalBuilders: () => withTimeoutSignal(10, (signal) => client.rpc.builders({}, { signal })),
    getCrackstations: () => withTimeoutSignal(10, (signal) => client.rpc.crackstations({}, { signal })),
    pwdBeacon: (beaconId: string, timeoutSeconds: number) =>
      client.interactBeacon(beaconId).pwd(timeoutSeconds),
    // InteractiveBeacon.lsTask intentionally exposes only {id, wait}; it
    // discards the server acknowledgement fields that OperationEngine must
    // verify. Queue this one reviewed RPC directly so the actual Async,
    // BeaconID, TaskID, and Err envelope is preserved for correlation.
    lsBeacon: (beaconId: string, path: string, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.ls({
        Path: path,
        Request: {
          Async: true,
          Timeout: timeoutSecondsToNanoseconds(timeoutSeconds),
          BeaconID: beaconId,
          SessionID: "",
        },
      }, { signal })),
    psBeacon: (beaconId: string, fullInfo: boolean, timeoutSeconds: number) =>
      client.interactBeacon(beaconId).ps(fullInfo, timeoutSeconds),
    ifconfigBeacon: (beaconId: string, timeoutSeconds: number) =>
      client.interactBeacon(beaconId).ifconfig(timeoutSeconds),
    envBeacon: (beaconId: string, name: string, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.getEnv({
        Name: name,
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    whoamiBeacon: (beaconId: string, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.currentTokenOwner({
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    netstatBeacon: (beaconId: string, options: BeaconNetstatOptions, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.netstat({
        TCP: options.tcp,
        UDP: options.udp,
        IP4: options.ip4,
        IP6: options.ip6,
        Listening: options.listen,
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    mountBeacon: (beaconId: string, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.mount({
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    memfilesBeacon: (beaconId: string, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.memfilesList({
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    catBeacon: (beaconId: string, path: string, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.download({
        Path: checkedPath(path),
        RestrictedToFile: true,
        Recurse: false,
        MaxBytes: String(BEACON_TEXT_READ_PROBE_BYTES),
        MaxLines: "0",
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    headBeacon: (beaconId: string, path: string, options: BeaconTextSliceOptions, timeoutSeconds: number) => {
      const slice = beaconTextSlice(options, false);
      return withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.download({
        Path: checkedPath(path),
        RestrictedToFile: true,
        Recurse: false,
        ...slice,
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal }));
    },
    tailBeacon: (beaconId: string, path: string, options: BeaconTextSliceOptions, timeoutSeconds: number) => {
      const slice = beaconTextSlice(options, true);
      return withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.download({
        Path: checkedPath(path),
        RestrictedToFile: true,
        Recurse: false,
        ...slice,
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal }));
    },
    grepBeacon: (beaconId: string, options: BeaconGrepOptions, timeoutSeconds: number) => {
      if (typeof options.pattern !== "string" || options.pattern.length === 0 || options.pattern.length > 1_024 ||
        !Number.isSafeInteger(options.before) || options.before < 0 || options.before > 64 ||
        !Number.isSafeInteger(options.after) || options.after < 0 || options.after > 64) {
        throw new Error("Invalid beacon grep options");
      }
      return withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.grep({
        SearchPattern: options.pattern,
        Path: checkedPath(options.path),
        Recursive: options.recursive,
        LinesBefore: options.before,
        LinesAfter: options.after,
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal }));
    },
    registryReadBeacon: (beaconId: string, options: BeaconRegistryKeyOptions, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.registryRead({
        ...checkedRegistryLocation(options),
        Key: checkedRegistryKey(options.key, true),
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    registryListSubkeysBeacon: (beaconId: string, options: BeaconRegistryLocationOptions, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.registryListSubKeys({
        ...checkedRegistryLocation(options),
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    registryListValuesBeacon: (beaconId: string, options: BeaconRegistryLocationOptions, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.registryListValues({
        ...checkedRegistryLocation(options),
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    registryWriteBeacon: (beaconId: string, options: BeaconRegistryWriteOptions, timeoutSeconds: number) => {
      const location = checkedRegistryLocation(options);
      const key = checkedRegistryKey(options.key, true);
      const fields = beaconRegistryWriteFields(options.value);
      const dispose = (): void => { fields.ByteValue.fill(0); };
      return withTimeoutSignal(timeoutSeconds, async (signal) => {
        try {
          return await client.rpc.registryWrite({
            ...location, Key: key, ...fields,
            Request: beaconTaskRequest(beaconId, timeoutSeconds),
          }, { signal });
        } finally {
          dispose();
        }
      }).finally(dispose);
    },
    registryCreateBeacon: (beaconId: string, options: BeaconRegistryKeyOptions, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.registryCreateKey({
        ...checkedRegistryLocation(options),
        Key: checkedRegistryKey(options.key, false),
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    registryDeleteBeacon: (beaconId: string, options: BeaconRegistryKeyOptions, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.registryDeleteKey({
        ...checkedRegistryLocation(options),
        Key: checkedRegistryKey(options.key, false),
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    servicesBeacon: (beaconId: string, options: BeaconServicesOptions, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.services({
        Hostname: checkedHostname(options.hostname),
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    serviceDetailBeacon: (beaconId: string, options: BeaconServiceNameOptions, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.serviceDetail({
        ServiceInfo: { Hostname: checkedHostname(options.hostname), ServiceName: checkedServiceName(options.name) },
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    serviceStartBeacon: (beaconId: string, options: BeaconServiceNameOptions, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.startServiceByName({
        ServiceInfo: { Hostname: checkedHostname(options.hostname), ServiceName: checkedServiceName(options.name) },
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    serviceStopBeacon: (beaconId: string, options: BeaconServiceNameOptions, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.stopService({
        ServiceInfo: { Hostname: checkedHostname(options.hostname), ServiceName: checkedServiceName(options.name) },
        Request: beaconTaskRequest(beaconId, timeoutSeconds),
      }, { signal })),
    callBofSession: (sessionId: string, object: Buffer, argumentsBuffer: Buffer, entrypoint: string, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.callExtension({
        Name: createHash("sha256").update(object).digest("hex"),
        BOFData: object,
        Args: argumentsBuffer,
        Export: entrypoint,
        IsBOF: true,
        WantBOFOutputs: true,
        ServerStore: false,
        Request: { Async: false, Timeout: timeoutSecondsToNanoseconds(timeoutSeconds), SessionID: sessionId, BeaconID: "" },
      }, { signal })),
    callBofBeacon: (beaconId: string, object: Buffer, argumentsBuffer: Buffer, entrypoint: string, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.callExtension({
        Name: createHash("sha256").update(object).digest("hex"),
        BOFData: object,
        Args: argumentsBuffer,
        Export: entrypoint,
        IsBOF: true,
        WantBOFOutputs: true,
        ServerStore: false,
        Request: { Async: true, Timeout: timeoutSecondsToNanoseconds(timeoutSeconds), SessionID: "", BeaconID: beaconId },
      }, { signal })),
    // The SDK task-content channel is capped at 80 KiB, while server-saved
    // requests can contain large artifacts. Fetch the one exact task through
    // the 16 MiB control channel and reject oversized content before use.
    fetchBeaconTaskContent: async (beaconId: string, taskId: string, description: string, timeoutSeconds = 30) => {
      if (!TASK_ID.test(beaconId) || !TASK_ID.test(taskId) || !TASK_DESCRIPTION.test(description)) {
        throw new Error("Invalid beacon task identity");
      }
      const task = await withTimeoutSignal(timeoutSeconds, (signal) =>
        client.rpc.getBeaconTaskContent({ ID: taskId }, { signal }));
      return verifyBeaconTaskContent(task, beaconId, taskId, description);
    },
    // GetBeaconTaskContent includes the original request, which embeds the BOF
    // object. The SDK's task-content channel permits only 80 KiB total, even
    // when the BOF response is small. This BOF-only exception uses the control
    // channel's 16 MiB receive bound, then checks exact identity and byte caps.
    fetchBofBeaconTask: async (beaconId: string, taskId: string, description: BofTaskDescription, timeoutSeconds = 30) => {
      if (!TASK_ID.test(beaconId) || !TASK_ID.test(taskId) ||
        (description !== "CallExtensionReq" && description !== "RegisterExtensionReq")) {
        throw new Error("Invalid BOF task identity");
      }
      const task = await withTimeoutSignal(timeoutSeconds, (signal) =>
        client.rpc.getBeaconTaskContent({ ID: taskId }, { signal }));
      return verifyBofTaskContent(task, beaconId, taskId, description);
    },
    registerBofLoaderSession: (sessionId: string, loader: Buffer, init: string, os: string, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.registerExtension({
        Name: createHash("sha256").update(loader).digest("hex"),
        Data: loader,
        Init: init,
        OS: os,
        Request: { Async: false, Timeout: timeoutSecondsToNanoseconds(timeoutSeconds), SessionID: sessionId, BeaconID: "" },
      }, { signal })),
    registerBofLoaderBeacon: (beaconId: string, loader: Buffer, init: string, os: string, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.registerExtension({
        Name: createHash("sha256").update(loader).digest("hex"),
        Data: loader,
        Init: init,
        OS: os,
        Request: { Async: true, Timeout: timeoutSecondsToNanoseconds(timeoutSeconds), SessionID: "", BeaconID: beaconId },
      }, { signal })),
    callLegacyBofSession: (sessionId: string, loader: Buffer, argumentsBuffer: Buffer, exportName: string, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.callExtension({
        Name: createHash("sha256").update(loader).digest("hex"),
        BOFData: Buffer.alloc(0),
        Args: argumentsBuffer,
        Export: exportName,
        IsBOF: false,
        WantBOFOutputs: false,
        ServerStore: false,
        Request: { Async: false, Timeout: timeoutSecondsToNanoseconds(timeoutSeconds), SessionID: sessionId, BeaconID: "" },
      }, { signal })),
    callLegacyBofBeacon: (beaconId: string, loader: Buffer, argumentsBuffer: Buffer, exportName: string, timeoutSeconds: number) =>
      withTimeoutSignal(timeoutSeconds, (signal) => client.rpc.callExtension({
        Name: createHash("sha256").update(loader).digest("hex"),
        BOFData: Buffer.alloc(0),
        Args: argumentsBuffer,
        Export: exportName,
        IsBOF: false,
        WantBOFOutputs: false,
        ServerStore: false,
        Request: { Async: true, Timeout: timeoutSecondsToNanoseconds(timeoutSeconds), SessionID: "", BeaconID: beaconId },
      }, { signal })),
  });
}

export function createSliverClientAdapter(config: SliverClientConfig): SliverClientAdapter {
  return adaptSliverClient(new SliverClient(config));
}
