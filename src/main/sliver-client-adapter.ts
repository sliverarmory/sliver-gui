import type { SliverClient, SliverClientConfig } from "sliver-script";

/**
 * The complete, reviewed main-process Sliver surface for M0 and M1.
 *
 * Keeping this as an explicit Pick is a security boundary: target operations
 * cannot obtain the raw RPC client or select a method from renderer data.
 */
export type SliverClientMethod =
  | "connect"
  | "disconnect"
  | "getVersion"
  | "jobs"
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
  | "rmBeacon";

export type SliverClientAdapter = Pick<
  SliverClient,
  Exclude<SliverClientMethod, "connect"> | "event$" | "eventStreamState$"
> & {
  connect(): Promise<unknown>;
};

export type SliverClientFactory = (config: SliverClientConfig) => SliverClientAdapter;
