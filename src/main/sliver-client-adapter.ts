import {
  SliverClient,
  timeoutSecondsToNanoseconds,
  withTimeoutSignal,
  type SliverClientConfig,
  type sliverpb,
  type clientpb,
} from "sliver-script";

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
  pwdBeacon(beaconId: string, timeoutSeconds: number): Promise<sliverpb.Pwd>;
  lsBeacon(beaconId: string, path: string, timeoutSeconds: number): Promise<sliverpb.Ls>;
  psBeacon(beaconId: string, fullInfo: boolean, timeoutSeconds: number): Promise<sliverpb.Ps>;
  ifconfigBeacon(beaconId: string, timeoutSeconds: number): Promise<sliverpb.Ifconfig>;
};

export type SliverClientFactory = (config: SliverClientConfig) => SliverClientAdapter;

/**
 * Adds only the four reviewed beacon-read wrappers used by the operation
 * registry. `interactBeacon` deliberately remains outside SliverClientAdapter.
 */
export function adaptSliverClient(client: SliverClient): SliverClientAdapter {
  return Object.assign(client, {
    getPivotGraph: () => withTimeoutSignal(10, (signal) => client.rpc.pivotGraph({}, { signal })),
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
  });
}

export function createSliverClientAdapter(config: SliverClientConfig): SliverClientAdapter {
  return adaptSliverClient(new SliverClient(config));
}
