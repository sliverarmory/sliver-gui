import {
  SliverClient,
  timeoutSecondsToNanoseconds,
  withTimeoutSignal,
  type SliverClientConfig,
  type sliverpb,
  type clientpb,
} from "sliver-script";
import { createHash } from "node:crypto";

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
  /** Executes one main-selected Armory object through the fixed BOF RPC. */
  callBofSession(sessionId: string, object: Buffer, argumentsBuffer: Buffer, entrypoint: string, timeoutSeconds: number): Promise<sliverpb.CallExtension>;
  callBofBeacon(beaconId: string, object: Buffer, argumentsBuffer: Buffer, entrypoint: string, timeoutSeconds: number): Promise<sliverpb.CallExtension>;
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

export type BofTaskDescription = "CallExtensionReq" | "RegisterExtensionReq";
export const BOF_TASK_REQUEST_MAX_BYTES = 14 * 1024 * 1024;
export const BOF_TASK_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const BOF_TASK_CONTENT_MAX_BYTES = 15 * 1024 * 1024;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/u;

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

/**
 * Adds narrow passive inventory reads and the reviewed beacon-read wrappers.
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
