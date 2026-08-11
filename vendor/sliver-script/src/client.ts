import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";
import { promisify } from "node:util";

import { createChannel, createClient, type Channel } from "nice-grpc";
import { BehaviorSubject, Subject, filter, map, type Observable } from "rxjs";

import type { SliverClientConfig } from "./config";
import { createSliverRpcCredentials } from "./internal/credentials";
import { timeoutSecondsToNanoseconds, withTimeoutSignal } from "./internal/timeout";
import { TunnelManager } from "./internal/tunnelManager";
import { hasWireGuardWrapper, startWireGuardProxy, type WireGuardProxySession } from "./internal/wgProxy";
import {
  RPC_MESSAGE_DOMAINS,
  TUNNEL_STREAM_MAX_PAYLOAD_BYTES,
  WORKBENCH_ARTIFACT_MAX_PAYLOAD_BYTES,
  rpcMessageChannelOptions,
  rpcTlsAuthorityOverride,
  type RpcMessageDomain,
} from "./messageBudget";
import { BeaconTask } from "./pb/clientpb/client";
import type {
  BeaconTasks,
  Event,
  Operator,
  Operators,
  Session,
  Sessions,
  Version,
  Beacons,
  Jobs,
  Beacon,
  GenerateSpoofMetadataReq,
  ImplantConfig,
  ImplantProfile,
  Loot,
  WebContent,
  Compiler,
  Generate,
  GenerateStageReq,
  HTTPListenerReq,
  StagerListenerReq,
  UniqueWGIP,
} from "./pb/clientpb/client";
import type { Empty, Request as CommonRequest } from "./pb/commonpb/common";
import { SliverRPCDefinition } from "./pb/rpcpb/services";
import type { SliverRPCClient } from "./pb/rpcpb/services";
import { Ls, RegistryType } from "./pb/sliverpb/sliver";
import type {
  EnvInfo,
  OpenSession,
  Ping,
  Reconfigure,
  SetEnv,
  UnsetEnv,
} from "./pb/sliverpb/sliver";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

const DEFAULT_TIMEOUT_SECONDS = 30;
const EVENT_RETRY_INITIAL_MS = 500;
const EVENT_RETRY_MAX_MS = 10_000;

export interface SliverEventStreamState {
  status: "stopped" | "connecting" | "connected" | "retrying";
  attempt: number;
  error?: string;
}

export interface HTTPListenerOptions {
  domain?: string;
  host: string;
  port: number;
  website?: string;
  enforceOTP?: boolean;
  longPollTimeoutNanoseconds?: string;
  longPollJitterNanoseconds?: string;
}

export interface HTTPSListenerOptions extends HTTPListenerOptions {
  acme?: boolean;
  cert?: Buffer;
  key?: Buffer;
  randomizeJARM?: boolean;
}

export interface BeaconReconfigureOptions {
  reconnectIntervalNanoseconds?: string;
  intervalNanoseconds?: string;
  jitterNanoseconds?: string;
  c2Uri?: string;
}

export interface SessionNetstatOptions {
  tcp: boolean;
  udp: boolean;
  ip4: boolean;
  ip6: boolean;
  listening: boolean;
}

export interface SessionDownloadFileOptions {
  start?: number;
  stop?: number;
  maxBytes?: number;
  maxLines?: number;
  /** Read the bounded byte window from the end of the file. */
  fromEnd?: boolean;
}

export interface SessionUploadOptions {
  isIOC?: boolean;
  fileName?: string;
  isDirectory?: boolean;
  overwrite?: boolean;
}

export interface SessionGrepOptions {
  recursive?: boolean;
  linesBefore?: number;
  linesAfter?: number;
}

export type SessionRegistryWriteValue =
  | { type: "binary"; value: Buffer }
  | { type: "string"; value: string }
  | { type: "dword"; value: number }
  | { type: "qword"; value: string };

export interface Tunnel {
  readonly id: string;
  readonly stdout$: Observable<Buffer>;
  write(data: Buffer | string): Promise<void>;
  close(): Promise<void>;
}

export const SHELL_OUTPUT_BUFFER_DEFAULT_BYTES = 512 * 1024;
export const SHELL_OUTPUT_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
export const SHELL_WRITE_MAX_BYTES = 4 * 1024 * 1024;
export const SHELL_TERMINAL_DIMENSION_MAX = 1_000;
export const SHELL_GRACEFUL_CLOSE_TIMEOUT_MILLISECONDS = 2_000;

export interface ShellSessionOptions {
  readonly path: string;
  readonly pty: boolean;
  readonly rows: number;
  readonly cols: number;
  readonly outputBufferBytes?: number;
}

/** Main-process-only handle for one managed session shell. */
export interface ShellSessionHandle {
  readonly id: string;
  readonly pid: number;
  readonly path: string;
  readonly ptyRequested: boolean;
  readonly output: AsyncIterable<Uint8Array>;
  write(chunk: Uint8Array | string): Promise<void>;
  resize(rows: number, cols: number): Promise<void>;
  close(): Promise<void>;
}

class BaseCommands {
  constructor(
    protected readonly rpc: SliverRPCClient,
    protected readonly artifactRpc: SliverRPCClient = rpc,
  ) {}

  protected request(timeoutSeconds: number): CommonRequest {
    return {
      Async: false,
      Timeout: timeoutSecondsToNanoseconds(timeoutSeconds),
      BeaconID: "",
      SessionID: "",
    };
  }

  protected async unary<T>(timeoutSeconds: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return withTimeoutSignal(timeoutSeconds, fn);
  }

  ping(nonce: number, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.ping({ Nonce: nonce, Request: this.request(timeoutSeconds) }, { signal }),
    );
  }

  ps(fullInfo = false, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.ps({ FullInfo: fullInfo, Request: this.request(timeoutSeconds) }, { signal }),
    );
  }

  ls(path = ".", timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.ls({ Path: path, Request: this.request(timeoutSeconds) }, { signal }),
    );
  }

  download(path: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Buffer> {
    return this.unary(timeoutSeconds, async (signal) => {
      const download = await this.artifactRpc.download(
        { Path: path, Request: this.request(timeoutSeconds) },
        { signal },
      );
      if (download.Encoder === "gzip") {
        return await gunzip(download.Data);
      }
      if (download.Encoder !== "") {
        throw new Error(`Unsupported encoder: ${download.Encoder}`);
      }
      return download.Data;
    });
  }

  upload(path: string, data: Buffer, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, async (signal) => {
      const payload = await gzip(data);
      return this.artifactRpc.upload(
        { Path: path, Encoder: "gzip", Data: payload, Request: this.request(timeoutSeconds) },
        { signal },
      );
    });
  }

  terminate(pid: number, force = false, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.terminate({ Pid: pid, Force: force, Request: this.request(timeoutSeconds) }, { signal }),
    );
  }

  ifconfig(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.ifconfig({ Request: this.request(timeoutSeconds) }, { signal }),
    );
  }

  netstat(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.netstat({ Request: this.request(timeoutSeconds) }, { signal }),
    );
  }

  cd(path: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) => this.rpc.cd({ Path: path, Request: this.request(timeoutSeconds) }, { signal }));
  }

  pwd(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) => this.rpc.pwd({ Request: this.request(timeoutSeconds) }, { signal }));
  }

  rm(path: string, recursive = false, force = false, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.rm({ Path: path, Recursive: recursive, Force: force, Request: this.request(timeoutSeconds) }, { signal }),
    );
  }

  mkdir(path: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.mkdir({ Path: path, Request: this.request(timeoutSeconds) }, { signal }),
    );
  }

  processDump(pid: number, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.artifactRpc.processDump({ Pid: pid, Request: this.request(timeoutSeconds) }, { signal }),
    );
  }

  runAs(userName: string, processName: string, args: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.runAs(
        { Username: userName, ProcessName: processName, Args: args, Request: this.request(timeoutSeconds) },
        { signal },
      ),
    );
  }

  impersonate(userName: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.impersonate({ Username: userName, Request: this.request(timeoutSeconds) }, { signal }),
    );
  }

  revToSelf(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) => this.rpc.revToSelf({ Request: this.request(timeoutSeconds) }, { signal }));
  }

  getSystem(hostingProcess: string, config: ImplantConfig, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.getSystem(
        { HostingProcess: hostingProcess, Config: config, Request: this.request(timeoutSeconds) },
        { signal },
      ),
    );
  }

  /**
   * Execute arbitrary shellcode (aka "task" in Sliver terminology).
   *
   * Note: For beacon interactions this will queue an async task; use the
   * returned Response.TaskID to fetch results.
   */
  task(
    pid: number,
    shellcode: Buffer,
    encoder = "",
    rwxPages = false,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return this.unary(timeoutSeconds, (signal) =>
      this.artifactRpc.task(
        {
          Pid: pid,
          Data: shellcode,
          Encoder: encoder,
          RWXPages: rwxPages,
          Request: this.request(timeoutSeconds),
        },
        { signal },
      ),
    );
  }

  msf(
    payload: string,
    lhost: string,
    lport: number,
    encoder = "",
    iterations = 0,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.msf(
        { Payload: payload, LHost: lhost, LPort: lport, Encoder: encoder, Iterations: iterations, Request: this.request(timeoutSeconds) },
        { signal },
      ),
    );
  }

  msfRemote(
    pid: number,
    payload: string,
    lhost: string,
    lport: number,
    encoder = "",
    iterations = 0,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.msfRemote(
        { PID: pid, Payload: payload, LHost: lhost, LPort: lport, Encoder: encoder, Iterations: iterations, Request: this.request(timeoutSeconds) },
        { signal },
      ),
    );
  }

  executeAssembly(assembly: Buffer, args: string[] = [], process = "", timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.artifactRpc.executeAssembly(
        { Assembly: assembly, Arguments: args, Process: process, Request: this.request(timeoutSeconds) },
        { signal },
      ),
    );
  }

  migrate(pid: number, config: ImplantConfig, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.migrate({ Pid: pid, Config: config, Request: this.request(timeoutSeconds) }, { signal }),
    );
  }

  execute(exe: string, args: string[] = [], output = true, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.rpc.execute({ Path: exe, Args: args, Output: output, Request: this.request(timeoutSeconds) }, { signal }),
    );
  }

  sideload(
    data: Buffer,
    processName: string,
    args: string[] = [],
    entryPoint: string,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return this.unary(timeoutSeconds, (signal) =>
      this.artifactRpc.sideload(
        { Data: data, ProcessName: processName, Args: args, EntryPoint: entryPoint, Request: this.request(timeoutSeconds) },
        { signal },
      ),
    );
  }

  spawnDll(
    data: Buffer,
    entrypoint: string,
    processName: string,
    args: string[] = [],
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return this.unary(timeoutSeconds, (signal) =>
      this.artifactRpc.spawnDll(
        { Data: data, EntryPoint: entrypoint, ProcessName: processName, Args: args, Request: this.request(timeoutSeconds) },
        { signal },
      ),
    );
  }

  screenshot(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.unary(timeoutSeconds, (signal) =>
      this.artifactRpc.screenshot({ Request: this.request(timeoutSeconds) }, { signal }),
    );
  }
}

export class InteractiveBeacon extends BaseCommands {
  constructor(
    rpc: SliverRPCClient,
    artifactRpc: SliverRPCClient,
    private readonly taskResult$: Observable<Event>,
    private readonly beaconId: string,
  ) {
    super(rpc, artifactRpc);
  }

  protected request(timeoutSeconds: number): CommonRequest {
    return {
      Async: true,
      Timeout: timeoutSecondsToNanoseconds(timeoutSeconds),
      BeaconID: this.beaconId,
      SessionID: "",
    };
  }

  async lsTask(path = ".", timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    const lsTask = await super.ls(path, timeoutSeconds);
    if (lsTask.Response?.Err) {
      throw new Error(lsTask.Response.Err);
    }
    const taskId = lsTask.Response?.TaskID;
    if (!taskId) {
      throw new Error("Missing beacon task id");
    }
    return {
      id: taskId,
      wait: async (waitTimeoutSeconds = timeoutSeconds) => {
        const beaconTask = await waitForBeaconTask(this.taskResult$, taskId, waitTimeoutSeconds);
        const taskContent = await this.unary(waitTimeoutSeconds, (signal) =>
          this.artifactRpc.getBeaconTaskContent({ ID: beaconTask.ID }, { signal }),
        );
        return Ls.decode(taskContent.Response);
      },
    };
  }

  async ls(path = ".", timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    const task = await this.lsTask(path, timeoutSeconds);
    return task.wait(timeoutSeconds);
  }
}

export class InteractiveSession extends BaseCommands {
  constructor(
    rpc: SliverRPCClient,
    artifactRpc: SliverRPCClient,
    private readonly tunnels: TunnelManager,
    private readonly sessionId: string,
  ) {
    super(rpc, artifactRpc);
  }

  protected request(timeoutSeconds: number): CommonRequest {
    return {
      Async: false,
      Timeout: timeoutSecondsToNanoseconds(timeoutSeconds),
      BeaconID: "",
      SessionID: this.sessionId,
    };
  }

  async shell(path: string, pty = true, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Tunnel> {
    const tunnel = await this.unary(timeoutSeconds, (signal) =>
      this.rpc.createTunnel({ SessionID: this.sessionId }, { signal }),
    );
    if (!tunnel?.TunnelID) {
      throw new Error("Failed to create tunnel");
    }
    const tunnelId = tunnel.TunnelID;

    // Subscribe first so we don't miss early data.
    const stdout$ = this.tunnels.subscribe(tunnelId).pipe(
      filter((msg) => msg.TunnelID === tunnelId),
      filter((msg) => msg.Data.length > 0),
      map((msg) => msg.Data),
    );

    try {
      // Bind tunnel to the tunnel stream.
      await this.tunnels.send({
        TunnelID: tunnelId,
        SessionID: this.sessionId,
        Data: Buffer.alloc(0),
      });

      // Ask the implant to open a shell on the bound tunnel.
      const shell = await this.unary(timeoutSeconds, (signal) =>
        this.rpc.shell(
          {
            Path: path,
            EnablePTY: pty,
            Pid: 0,
            Rows: 0,
            Cols: 0,
            TunnelID: tunnelId,
            Request: this.request(timeoutSeconds),
          },
          { signal },
        ),
      );
      if (shell.Response?.Err) throw new Error("Shell was rejected by the target");
    } catch {
      this.tunnels.cancelTunnel(tunnelId);
      await this.unary(DEFAULT_TIMEOUT_SECONDS, (signal) =>
        this.rpc.closeTunnel({ TunnelID: tunnelId, SessionID: this.sessionId }, { signal }),
      ).catch(() => undefined);
      throw new Error("Unable to start shell session");
    }

    return {
      id: tunnelId,
      stdout$,
      write: (data: Buffer | string) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        return this.tunnels.send({ TunnelID: tunnelId, SessionID: this.sessionId, Data: buf });
      },
      close: async () => {
        this.tunnels.cancelTunnel(tunnelId);
        await this.unary(DEFAULT_TIMEOUT_SECONDS, (signal) =>
          this.rpc.closeTunnel({ TunnelID: tunnelId, SessionID: this.sessionId }, { signal }),
        );
      },
    };
  }
}

export class SliverClient {
  static readonly EVENT_BEACON_REGISTERED = "beacon-registered";
  static readonly EVENT_BEACON_TASKRESULT = "beacon-taskresult";

  private readonly empty = {};
  private readonly rpcClients: Partial<Record<RpcMessageDomain, SliverRPCClient>> = {};
  private readonly channels: Partial<Record<RpcMessageDomain, Channel>> = {};

  private eventsAbort: AbortController | null = null;
  private tunnels: TunnelManager | null = null;
  private wireGuardProxy: WireGuardProxySession | null = null;

  private readonly eventSubject = new Subject<Event>();
  readonly event$ = this.eventSubject.asObservable();
  private readonly eventStreamStateSubject = new BehaviorSubject<SliverEventStreamState>({
    status: "stopped",
    attempt: 0,
  });
  readonly eventStreamState$ = this.eventStreamStateSubject.asObservable();

  readonly session$ = this.event$.pipe(filter((event): event is Event & { Session: NonNullable<Event["Session"]> } =>
    event.Session !== undefined
  ));
  readonly job$ = this.event$.pipe(filter((event): event is Event & { Job: NonNullable<Event["Job"]> } =>
    event.Job !== undefined
  ));
  readonly client$ = this.event$.pipe(filter((event): event is Event & { Client: NonNullable<Event["Client"]> } =>
    event.Client !== undefined
  ));

  readonly beacon$ = this.event$.pipe(filter((event) => event.EventType === SliverClient.EVENT_BEACON_REGISTERED));
  readonly taskResult$ = this.event$.pipe(filter((event) => event.EventType === SliverClient.EVENT_BEACON_TASKRESULT));

  constructor(readonly config: SliverClientConfig) {}

  rpcHost(): string {
    return `${this.config.lhost}:${this.config.lport}`;
  }

  private clientFor(domain: RpcMessageDomain): SliverRPCClient {
    const client = this.rpcClients[domain];
    if (!client) throw new Error("SliverClient is not connected");
    return client;
  }

  get rpc(): SliverRPCClient {
    return this.clientFor("control");
  }

  private get inventoryRpc(): SliverRPCClient {
    return this.clientFor("inventory");
  }

  private get artifactRpc(): SliverRPCClient {
    return this.clientFor("artifact");
  }

  private get workbenchArtifactRpc(): SliverRPCClient {
    return this.clientFor("workbench-artifact");
  }

  private get taskContentRpc(): SliverRPCClient {
    return this.clientFor("task-content");
  }

  private sessionRequest(sessionId: string, timeoutSeconds: number): CommonRequest {
    return {
      Async: false,
      Timeout: timeoutSecondsToNanoseconds(timeoutSeconds),
      BeaconID: "",
      SessionID: sessionId,
    };
  }

  private beaconRequest(beaconId: string, timeoutSeconds: number): CommonRequest {
    return {
      Async: true,
      Timeout: timeoutSecondsToNanoseconds(timeoutSeconds),
      BeaconID: beaconId,
      SessionID: "",
    };
  }

  get isConnected(): boolean {
    return this.rpcClients.control !== undefined;
  }

  async connect(): Promise<this> {
    if (this.rpcClients.control) return this;

    this.eventsAbort = new AbortController();
    this.tunnels = new TunnelManager();

    try {
      let rpcTarget = this.rpcHost();
      if (hasWireGuardWrapper(this.config)) {
        this.wireGuardProxy = await startWireGuardProxy(this.config);
        rpcTarget = this.wireGuardProxy.rpcHost();
      }

      for (const domain of RPC_MESSAGE_DOMAINS) {
        const authorityOverride = rpcTlsAuthorityOverride(this.config.lhost, this.wireGuardProxy !== null);
        const channel = createChannel(
          rpcTarget,
          createSliverRpcCredentials(this.config),
          rpcMessageChannelOptions(domain, authorityOverride),
        );
        this.channels[domain] = channel;
        this.rpcClients[domain] = createClient(SliverRPCDefinition, channel);
      }

      // Ensure auth and connectivity are working before we start streams.
      await this.getVersion();

      this.tunnels.start(this.clientFor("tunnel-stream"));
      this.startEventsStream();
      return this;
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.eventsAbort?.abort();
    this.eventsAbort = null;

    await this.tunnels?.stop();
    this.tunnels = null;

    for (const domain of RPC_MESSAGE_DOMAINS) {
      delete this.rpcClients[domain];
      this.channels[domain]?.close();
      delete this.channels[domain];
    }

    const wireGuardProxy = this.wireGuardProxy;
    this.wireGuardProxy = null;
    await wireGuardProxy?.stop();

    this.eventStreamStateSubject.next({ status: "stopped", attempt: 0 });
  }

  private startEventsStream(): void {
    const rpc = this.rpcClients.control;
    const abort = this.eventsAbort;
    if (!rpc || !abort) return;

    (async () => {
      let attempt = 0;

      while (!abort.signal.aborted && this.rpcClients.control === rpc) {
        this.eventStreamStateSubject.next({
          status: attempt === 0 ? "connecting" : "retrying",
          attempt,
        });

        try {
          const stream = rpc.events(this.empty, { signal: abort.signal });
          this.eventStreamStateSubject.next({ status: "connected", attempt });
          attempt = 0;

          for await (const event of stream) {
            this.eventSubject.next(event);
          }

          if (!abort.signal.aborted) {
            throw new Error("Sliver event stream ended unexpectedly");
          }
        } catch (err) {
          // Abort is expected on disconnect; don't surface it as a retry.
          if (abort.signal.aborted || this.rpcClients.control !== rpc) {
            return;
          }

          attempt += 1;
          this.eventStreamStateSubject.next({
            status: "retrying",
            attempt,
            error: errorMessage(err),
          });

          const delayMs = Math.min(EVENT_RETRY_INITIAL_MS * (2 ** (attempt - 1)), EVENT_RETRY_MAX_MS);
          await abortableDelay(delayMs, abort.signal);
        }
      }
    })();
  }

  // --- Convenience APIs (typed, promise-based) ---

  getVersion(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Version> {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.rpc.getVersion(this.empty, { signal }));
  }

  getOperators(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Operators> {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.rpc.getOperators(this.empty, { signal }));
  }

  getSessions(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Sessions> {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.inventoryRpc.getSessions(this.empty, { signal }));
  }

  getBeacons(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Beacons> {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.inventoryRpc.getBeacons(this.empty, { signal }));
  }

  renameSession(sessionId: string, name: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Empty> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.rename({ SessionID: sessionId, BeaconID: "", Name: name }, { signal }),
    );
  }

  renameBeacon(beaconId: string, name: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Empty> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.rename({ SessionID: "", BeaconID: beaconId, Name: name }, { signal }),
    );
  }

  pingSession(sessionId: string, nonce: number, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Ping> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.ping(
        { Nonce: nonce, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  pingBeacon(beaconId: string, nonce: number, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Ping> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.ping(
        { Nonce: nonce, Request: this.beaconRequest(beaconId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  getEnvSession(sessionId: string, name = "", timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<EnvInfo> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.getEnv(
        { Name: name, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  getEnvBeacon(beaconId: string, name = "", timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<EnvInfo> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.getEnv(
        { Name: name, Request: this.beaconRequest(beaconId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  setEnvSession(
    sessionId: string,
    key: string,
    value: string,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ): Promise<SetEnv> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.setEnv(
        {
          Variable: { Key: key, Value: value },
          Request: this.sessionRequest(sessionId, timeoutSeconds),
        },
        { signal },
      ),
    );
  }

  setEnvBeacon(
    beaconId: string,
    key: string,
    value: string,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ): Promise<SetEnv> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.setEnv(
        {
          Variable: { Key: key, Value: value },
          Request: this.beaconRequest(beaconId, timeoutSeconds),
        },
        { signal },
      ),
    );
  }

  unsetEnvSession(sessionId: string, name: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<UnsetEnv> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.unsetEnv(
        { Name: name, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  unsetEnvBeacon(beaconId: string, name: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<UnsetEnv> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.unsetEnv(
        { Name: name, Request: this.beaconRequest(beaconId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  // --- Explicit M2 session workbench APIs ---

  currentTokenOwnerSession(sessionId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.currentTokenOwner(
        { Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  listEnvSession(sessionId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<EnvInfo> {
    return this.getEnvSession(sessionId, "", timeoutSeconds);
  }

  revealEnvSession(sessionId: string, exactName: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<EnvInfo> {
    assertNonEmptyString(exactName, "Environment variable name");
    return this.getEnvSession(sessionId, exactName, timeoutSeconds);
  }

  ifconfigSession(sessionId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.ifconfig(
        { Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  netstatSession(
    sessionId: string,
    options: SessionNetstatOptions,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.netstat(
        {
          TCP: options.tcp,
          UDP: options.udp,
          IP4: options.ip4,
          IP6: options.ip6,
          Listening: options.listening,
          Request: this.sessionRequest(sessionId, timeoutSeconds),
        },
        { signal },
      ),
    );
  }

  pwdSession(sessionId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.pwd(
        { Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  cdSession(sessionId: string, path: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.cd(
        { Path: path, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  lsSession(sessionId: string, path = ".", timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.ls(
        { Path: path, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  downloadFileSession(
    sessionId: string,
    path: string,
    options: SessionDownloadFileOptions = {},
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    const maxBytes = boundedArtifactByteCount(options.maxBytes);
    const start = boundedNonNegativeInteger(options.start ?? 0, "Download start");
    const stop = boundedNonNegativeInteger(options.stop ?? 0, "Download stop");
    const maxLines = boundedNonNegativeInteger(options.maxLines ?? 0, "Download max lines");
    const fromEnd = options.fromEnd ?? false;
    if (typeof fromEnd !== "boolean") throw new Error("Download from-end must be a boolean");
    if (fromEnd && (start !== 0 || stop !== 0 || maxLines !== 0)) {
      throw new Error("Download from-end cannot be combined with start, stop, or max lines");
    }
    return withTimeoutSignal(timeoutSeconds, async (signal) => {
      const response = await this.workbenchArtifactRpc.download(
        {
          Path: path,
          Start: String(start),
          Stop: String(stop),
          Recurse: false,
          MaxBytes: String(fromEnd ? -maxBytes : maxBytes),
          MaxLines: String(maxLines),
          RestrictedToFile: true,
          Request: this.sessionRequest(sessionId, timeoutSeconds),
        },
        { signal },
      );
      try {
        assertImplantResponse(response.Response?.Err, "Download");
        if (!response.Exists || response.IsDir) {
          throw new Error("Download is unavailable or is not a single file");
        }
        const data = await decodeBoundedArtifact(response.Data, response.Encoder, maxBytes, "Download");
        return { ...response, Encoder: "", Data: data };
      } catch (error) {
        response.Data.fill(0);
        throw error;
      }
    });
  }

  uploadSession(
    sessionId: string,
    path: string,
    data: Buffer,
    options: SessionUploadOptions = {},
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    assertBoundedArtifact(data, "Upload");
    return withTimeoutSignal(timeoutSeconds, async (signal) => {
      const payload = await gzip(data);
      try {
        const response = await this.workbenchArtifactRpc.upload(
          {
            Path: path,
            Encoder: "gzip",
            Data: payload,
            IsIOC: options.isIOC ?? false,
            FileName: options.fileName ?? "",
            IsDirectory: options.isDirectory ?? false,
            Overwrite: options.overwrite ?? false,
            Request: this.sessionRequest(sessionId, timeoutSeconds),
          },
          { signal },
        );
        return response;
      } finally {
        payload.fill(0);
      }
    });
  }

  grepSession(
    sessionId: string,
    path: string,
    searchPattern: string,
    options: SessionGrepOptions = {},
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.grep(
        {
          SearchPattern: searchPattern,
          Path: path,
          Recursive: options.recursive ?? false,
          LinesBefore: boundedNonNegativeInteger(options.linesBefore ?? 0, "Grep lines before"),
          LinesAfter: boundedNonNegativeInteger(options.linesAfter ?? 0, "Grep lines after"),
          Request: this.sessionRequest(sessionId, timeoutSeconds),
        },
        { signal },
      ),
    );
  }

  cpSession(sessionId: string, source: string, destination: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.cp(
        { Src: source, Dst: destination, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  mvSession(sessionId: string, source: string, destination: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.mv(
        { Src: source, Dst: destination, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  mkdirSession(sessionId: string, path: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.mkdir(
        { Path: path, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  rmSession(
    sessionId: string,
    path: string,
    recursive = false,
    force = false,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.rm(
        { Path: path, Recursive: recursive, Force: force, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  mountsSession(sessionId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.mount(
        { Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  memfilesListSession(sessionId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.memfilesList(
        { Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  memfilesAddSession(sessionId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.memfilesAdd(
        { Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  memfilesRmSession(sessionId: string, fd: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.memfilesRm(
        { Fd: fd, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  chmodSession(
    sessionId: string,
    path: string,
    fileMode: string,
    recursive = false,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.chmod(
        { Path: path, FileMode: fileMode, Recursive: recursive, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  chownSession(
    sessionId: string,
    path: string,
    uid: string,
    gid: string,
    recursive = false,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.chown(
        { Path: path, Uid: uid, Gid: gid, Recursive: recursive, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  chtimesSession(
    sessionId: string,
    path: string,
    accessTime: string,
    modificationTime: string,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.chtimes(
        { Path: path, ATime: accessTime, MTime: modificationTime, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  psSession(sessionId: string, fullInfo = false, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.ps(
        { FullInfo: fullInfo, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  terminateSessionProcess(
    sessionId: string,
    pid: number,
    force = false,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.terminate(
        { Pid: pid, Force: force, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  processDumpSession(
    sessionId: string,
    pid: number,
    dumpTimeoutSeconds = 60,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, async (signal) => {
      const response = await this.workbenchArtifactRpc.processDump(
        {
          Pid: pid,
          Timeout: boundedPositiveInteger(dumpTimeoutSeconds, "Process dump timeout"),
          Request: this.sessionRequest(sessionId, timeoutSeconds),
        },
        { signal },
      );
      try {
        assertImplantResponse(response.Response?.Err, "Process dump");
        assertBoundedArtifact(response.Data, "Process dump");
        return response;
      } catch (error) {
        response.Data.fill(0);
        throw error;
      }
    });
  }

  screenshotSession(sessionId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, async (signal) => {
      const response = await this.workbenchArtifactRpc.screenshot(
        { Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      );
      try {
        assertImplantResponse(response.Response?.Err, "Screenshot");
        assertBoundedArtifact(response.Data, "Screenshot");
        return response;
      } catch (error) {
        response.Data.fill(0);
        throw error;
      }
    });
  }

  servicesSession(sessionId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.services(
        { Hostname: "", Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  serviceDetailSession(sessionId: string, serviceName: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.serviceDetail(
        {
          ServiceInfo: { ServiceName: serviceName, Hostname: "" },
          Request: this.sessionRequest(sessionId, timeoutSeconds),
        },
        { signal },
      ),
    );
  }

  startServiceSession(sessionId: string, serviceName: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.startServiceByName(
        {
          ServiceInfo: { ServiceName: serviceName, Hostname: "" },
          Request: this.sessionRequest(sessionId, timeoutSeconds),
        },
        { signal },
      ),
    );
  }

  stopServiceSession(sessionId: string, serviceName: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.stopService(
        {
          ServiceInfo: { ServiceName: serviceName, Hostname: "" },
          Request: this.sessionRequest(sessionId, timeoutSeconds),
        },
        { signal },
      ),
    );
  }

  registryReadSession(
    sessionId: string,
    hive: string,
    path: string,
    key: string,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.registryRead(
        { Hive: hive, Path: path, Key: key, Hostname: "", Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  registryListSubkeysSession(
    sessionId: string,
    hive: string,
    path: string,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.registryListSubKeys(
        { Hive: hive, Path: path, Hostname: "", Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  registryListValuesSession(
    sessionId: string,
    hive: string,
    path: string,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.registryListValues(
        { Hive: hive, Path: path, Hostname: "", Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  registryReadHiveSession(
    sessionId: string,
    rootHive: string,
    requestedHive: string,
    maxBytes = WORKBENCH_ARTIFACT_MAX_PAYLOAD_BYTES,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    const boundedMaxBytes = boundedArtifactByteCount(maxBytes);
    return withTimeoutSignal(timeoutSeconds, async (signal) => {
      const response = await this.workbenchArtifactRpc.registryReadHive(
        { RootHive: rootHive, RequestedHive: requestedHive, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      );
      try {
        assertImplantResponse(response.Response?.Err, "Registry hive read");
        const data = await decodeBoundedArtifact(response.Data, response.Encoder, boundedMaxBytes, "Registry hive read");
        return { ...response, Encoder: "", Data: data };
      } catch (error) {
        response.Data.fill(0);
        throw error;
      }
    });
  }

  registryWriteSession(
    sessionId: string,
    hive: string,
    path: string,
    key: string,
    value: SessionRegistryWriteValue,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    const fields = registryWriteFields(value);
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.registryWrite(
        {
          Hive: hive,
          Path: path,
          Key: key,
          Hostname: "",
          ...fields,
          Request: this.sessionRequest(sessionId, timeoutSeconds),
        },
        { signal },
      ),
    );
  }

  registryCreateKeySession(
    sessionId: string,
    hive: string,
    path: string,
    key: string,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.registryCreateKey(
        { Hive: hive, Path: path, Key: key, Hostname: "", Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  registryDeleteKeySession(
    sessionId: string,
    hive: string,
    path: string,
    key: string,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.registryDeleteKey(
        { Hive: hive, Path: path, Key: key, Hostname: "", Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  killSession(sessionId: string, force = false, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Empty> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.kill(
        { Force: force, Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  killBeacon(beaconId: string, force = false, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Empty> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.kill(
        { Force: force, Request: this.beaconRequest(beaconId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  reconfigureBeacon(
    beaconId: string,
    options: BeaconReconfigureOptions,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ): Promise<Reconfigure> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.reconfigure(
        {
          ReconnectInterval: options.reconnectIntervalNanoseconds ?? "0",
          BeaconInterval: options.intervalNanoseconds ?? "0",
          BeaconJitter: options.jitterNanoseconds ?? "0",
          C2URI: options.c2Uri ?? "",
          Request: this.beaconRequest(beaconId, timeoutSeconds),
        },
        { signal },
      ),
    );
  }

  openSessionFromBeacon(
    beaconId: string,
    c2s: string[],
    delayNanoseconds = "0",
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ): Promise<OpenSession> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.openSession(
        {
          C2s: c2s,
          Delay: delayNanoseconds,
          Request: this.beaconRequest(beaconId, timeoutSeconds),
        },
        { signal },
      ),
    );
  }

  closeSession(sessionId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Empty> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.closeSession(
        { Request: this.sessionRequest(sessionId, timeoutSeconds) },
        { signal },
      ),
    );
  }

  getBeaconTasks(beaconId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<BeaconTasks> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.inventoryRpc.getBeaconTasks({ ID: beaconId }, { signal }),
    );
  }

  fetchBeaconTask(taskId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<BeaconTask> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.taskContentRpc.getBeaconTaskContent({ ID: taskId }, { signal }),
    );
  }

  cancelBeaconTask(taskId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<BeaconTask> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.cancelBeaconTask({ ID: taskId }, { signal }),
    );
  }

  getJobs(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Jobs> {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.rpc.getJobs(this.empty, { signal }));
  }

  killJob(jobId: number, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.rpc.killJob({ ID: jobId }, { signal }));
  }

  restartJobs(jobIds: number[], timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<void> {
    return withTimeoutSignal(timeoutSeconds, async (signal) => {
      await this.rpc.restartJobs({ JobIDs: jobIds }, { signal });
    });
  }

  startMTLSListener(host: string, port: number, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.rpc.startMTLSListener({ Host: host, Port: port }, { signal }));
  }

  startWGListener(
    host: string,
    port: number,
    tunIP: string,
    nPort: number,
    keyPort: number,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.startWGListener({ Host: host, Port: port, TunIP: tunIP, NPort: nPort, KeyPort: keyPort }, { signal }),
    );
  }

  startDNSListener(
    domains: string[],
    canaries: boolean,
    host: string,
    port: number,
    enforceOTP = false,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.startDNSListener(
        { Domains: domains, Canaries: canaries, Host: host, Port: port, EnforceOTP: enforceOTP },
        { signal },
      ),
    );
  }

  startHTTPListener(
    domain: string,
    host: string,
    port: number,
    website = "",
    enforceOTP = true,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return this.startHTTPListenerWithOptions({ domain, host, port, website, enforceOTP }, timeoutSeconds);
  }

  startHTTPListenerWithOptions(options: HTTPListenerOptions, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    const request: HTTPListenerReq = {
      Domain: options.domain ?? "",
      Host: options.host,
      Port: options.port,
      Secure: false,
      Website: options.website ?? "",
      Cert: Buffer.alloc(0),
      Key: Buffer.alloc(0),
      ACME: false,
      EnforceOTP: options.enforceOTP ?? true,
      LongPollTimeout: options.longPollTimeoutNanoseconds ?? "1000000000",
      LongPollJitter: options.longPollJitterNanoseconds ?? "2000000000",
      RandomizeJARM: false,
    };

    return withTimeoutSignal(timeoutSeconds, (signal) => this.rpc.startHTTPListener(request, { signal }));
  }

  startHTTPSListener(
    domain: string,
    host: string,
    port: number,
    website = "",
    acme = false,
    cert?: Buffer,
    key?: Buffer,
    enforceOTP = true,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ) {
    return this.startHTTPSListenerWithOptions(
      { domain, host, port, website, acme, cert, key, enforceOTP },
      timeoutSeconds,
    );
  }

  startHTTPSListenerWithOptions(options: HTTPSListenerOptions, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    const request: HTTPListenerReq = {
      Domain: options.domain ?? "",
      Host: options.host,
      Port: options.port,
      Secure: true,
      Website: options.website ?? "",
      ACME: options.acme ?? false,
      Cert: options.cert ?? Buffer.alloc(0),
      Key: options.key ?? Buffer.alloc(0),
      EnforceOTP: options.enforceOTP ?? true,
      LongPollTimeout: options.longPollTimeoutNanoseconds ?? "1000000000",
      LongPollJitter: options.longPollJitterNanoseconds ?? "2000000000",
      RandomizeJARM: options.randomizeJARM ?? true,
    };

    return withTimeoutSignal(timeoutSeconds, (signal) => this.rpc.startHTTPSListener(request, { signal }));
  }

  startTCPStagerListener(host: string, port: number, data: Buffer, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return this.startTCPStagerListenerWithOptions({ Protocol: 0, Host: host, Port: port, Data: data, ProfileName: "" }, timeoutSeconds);
  }

  startTCPStagerListenerWithOptions(request: StagerListenerReq, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.artifactRpc.startTCPStagerListener(request, { signal }));
  }

  getCompiler(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Compiler> {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.inventoryRpc.getCompiler(this.empty, { signal }));
  }

  generateUniqueIP(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<UniqueWGIP> {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.rpc.generateUniqueIP(this.empty, { signal }));
  }

  generateImplant(config: ImplantConfig, name = "", timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Generate> {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.artifactRpc.generate({ Config: config, Name: name }, { signal }));
  }

  async generate(config: ImplantConfig, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    const res = await this.generateImplant(config, "", timeoutSeconds);
    return res.File;
  }

  generateSpoofMetadata(req: GenerateSpoofMetadataReq, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<void> {
    return withTimeoutSignal(timeoutSeconds, async (signal) => {
      await this.artifactRpc.generateSpoofMetadata(req, { signal });
    });
  }

  async regenerate(implantName: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    const res = await this.regenerateImplant(implantName, timeoutSeconds);
    return res.File;
  }

  regenerateImplant(implantName: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Generate> {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.artifactRpc.regenerate({ ImplantName: implantName }, { signal }),
    );
  }

  generateStage(request: GenerateStageReq, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Generate> {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.artifactRpc.generateStage(request, { signal }));
  }

  stageImplantBuild(buildNames: string[], timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<void> {
    return withTimeoutSignal(timeoutSeconds, async (signal) => {
      await this.rpc.stageImplantBuild({ Build: buildNames }, { signal });
    });
  }

  implantBuilds(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.inventoryRpc.implantBuilds(this.empty, { signal }));
  }

  deleteImplantBuild(name: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<void> {
    return withTimeoutSignal(timeoutSeconds, async (signal) => {
      await this.rpc.deleteImplantBuild({ Name: name }, { signal });
    });
  }

  canaries(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.rpc.canaries(this.empty, { signal }));
  }

  implantProfiles(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.inventoryRpc.implantProfiles(this.empty, { signal }));
  }

  saveImplantProfile(profile: ImplantProfile, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.rpc.saveImplantProfile(profile, { signal }));
  }

  deleteImplantProfile(name: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<void> {
    return withTimeoutSignal(timeoutSeconds, async (signal) => {
      await this.rpc.deleteImplantProfile({ Name: name }, { signal });
    });
  }

  lootAll(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, async (signal) => {
      const res = await this.inventoryRpc.lootAll(this.empty, { signal });
      return res.Loot;
    });
  }

  lootAdd(loot: Loot, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.artifactRpc.lootAdd(loot, { signal }));
  }

  lootUpdate(loot: Loot, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.artifactRpc.lootUpdate(loot, { signal }));
  }

  lootRemove(lootId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<void> {
    return withTimeoutSignal(timeoutSeconds, async (signal) => {
      await this.rpc.lootRm({ ID: lootId }, { signal });
    });
  }

  lootContent(lootId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.artifactRpc.lootContent({ ID: lootId }, { signal }));
  }

  websites(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, async (signal) => {
      const res = await this.inventoryRpc.websites(this.empty, { signal });
      return res.Websites;
    });
  }

  website(name: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.artifactRpc.website({ Name: name }, { signal }));
  }

  websiteRemove(name: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<void> {
    return withTimeoutSignal(timeoutSeconds, async (signal) => {
      await this.rpc.websiteRemove({ Name: name }, { signal });
    });
  }

  websiteAddContent(name: string, contents: Record<string, WebContent>, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.artifactRpc.websiteAddContent({ Name: name, Contents: contents }, { signal }),
    );
  }

  websiteUpdateContent(name: string, contents: Record<string, WebContent>, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.artifactRpc.websiteUpdateContent({ Name: name, Contents: contents }, { signal }),
    );
  }

  websiteRemoveContent(name: string, paths: string[], timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    return withTimeoutSignal(timeoutSeconds, (signal) =>
      this.rpc.websiteRemoveContent({ Name: name, Paths: paths }, { signal }),
    );
  }

  // --- High-level helpers (ergonomic wrappers) ---

  async operators(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Operator[]> {
    const res = await this.getOperators(timeoutSeconds);
    return res.Operators;
  }

  async sessions(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Session[]> {
    const res = await this.getSessions(timeoutSeconds);
    return res.Sessions;
  }

  async beacons(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Beacon[]> {
    const res = await this.getBeacons(timeoutSeconds);
    return res.Beacons;
  }

  async jobs(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    const res = await this.getJobs(timeoutSeconds);
    return res.Active;
  }

  /**
   * Opens a session shell through the bounded tunnel stream. This handle is
   * intentionally part of the reviewed main-process adapter only; renderers
   * receive a separate MessagePort protocol, never this RPC-capable object.
   */
  async startShellSession(
    sessionId: string,
    options: ShellSessionOptions,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ): Promise<ShellSessionHandle> {
    assertNonEmptyString(sessionId, "Session id");
    if (!options || typeof options !== "object") throw new Error("Shell options are required");
    assertNonEmptyString(options.path, "Shell path");
    if (typeof options.pty !== "boolean") throw new Error("Shell PTY flag must be a boolean");
    const rows = shellTerminalDimension(options.rows, "Shell rows");
    const cols = shellTerminalDimension(options.cols, "Shell columns");
    const outputBufferBytes = shellOutputBufferBytes(options.outputBufferBytes);
    const request = this.sessionRequest(sessionId, timeoutSeconds);

    const tunnels = this.tunnels;
    if (!tunnels) throw new Error("SliverClient is not connected");

    let tunnelId = "";
    let lifecycle: "starting" | "open" | "closing" | "closed" = "starting";
    let closePromise: Promise<void> | null = null;
    let writeTail: Promise<void> = Promise.resolve();
    let resolveRemoteClosed: (() => void) | undefined;
    const remoteClosed = new Promise<void>((resolve) => {
      resolveRemoteClosed = resolve;
    });

    const bestEffortRemoteClose = async (): Promise<void> => {
      if (!tunnelId) return;
      await withTimeoutSignal(timeoutSeconds, (signal) =>
        this.rpc.closeTunnel({ TunnelID: tunnelId, SessionID: sessionId }, { signal }),
      ).catch(() => undefined);
    };

    const sendGracefulExit = async (): Promise<void> => {
      await writeTail.catch(() => undefined);
      for (const command of ["exit\n", "logout\n"] as const) {
        const bytes = Buffer.from(command);
        try {
          await tunnels.send({
            TunnelID: tunnelId,
            SessionID: sessionId,
            Data: bytes,
          });
        } catch {
          return;
        } finally {
          bytes.fill(0);
        }
      }
    };

    const boundedGracefulExit = async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await sendGracefulExit();
            // TunnelManager.send() resolves when the gRPC request stream pulls
            // a frame, not when the implant consumes it. Hold CloseTunnel long
            // enough for the exact remote EOF so it cannot overtake exit/logout.
            await remoteClosed;
          })(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SHELL_GRACEFUL_CLOSE_TIMEOUT_MILLISECONDS);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const closeManagedTunnel = (requestGracefulExit = false): Promise<void> => {
      if (closePromise) return closePromise;
      lifecycle = "closing";
      closePromise = (async () => {
        if (requestGracefulExit && tunnelId) await boundedGracefulExit();
        if (tunnelId) tunnels.cancelTunnel(tunnelId);
        await bestEffortRemoteClose();
      })().finally(() => {
          lifecycle = "closed";
        });
      return closePromise;
    };

    try {
      const created = await withTimeoutSignal(timeoutSeconds, (signal) =>
        this.rpc.createTunnel({ SessionID: sessionId }, { signal }),
      );
      tunnelId = created.TunnelID.trim();
      if (!tunnelId) throw new Error("Missing tunnel id");

      const output = tunnels.openOutput(tunnelId, {
        maxBufferedBytes: outputBufferBytes,
        onClosed: () => {
          lifecycle = "closed";
          resolveRemoteClosed?.();
          closePromise ??= Promise.resolve();
        },
        onFailure: () => {
          void closeManagedTunnel();
        },
      });

      // The zero-data bind must be pulled by TunnelData before Shell can race
      // an early prompt back to this process.
      await tunnels.send({
        TunnelID: tunnelId,
        SessionID: sessionId,
        Data: Buffer.alloc(0),
      });

      const shell = await withTimeoutSignal(timeoutSeconds, (signal) =>
        this.rpc.shell(
          {
            Path: options.path,
            EnablePTY: options.pty,
            Pid: 0,
            Rows: rows,
            Cols: cols,
            TunnelID: tunnelId,
            Request: request,
          },
          { signal },
        ),
      );
      if (shell.Response?.Err) throw new Error("Shell rejected");
      // A force-terminate action is exposed only for this exact child PID.
      // Never mint that authority for process-group/idle/kernel sentinel IDs.
      if (!Number.isSafeInteger(shell.Pid) || shell.Pid <= 1 || shell.Pid > 0x7fff_ffff) {
        throw new Error("Invalid shell pid");
      }
      if (shell.TunnelID && shell.TunnelID !== tunnelId) throw new Error("Mismatched shell tunnel");
      if (lifecycle !== "starting") throw new Error("Shell closed during startup");
      lifecycle = "open";

      const ensureOpen = (): void => {
        if (lifecycle !== "open") throw new Error("Shell session is closed");
      };
      const ensureNotClosed = (): void => {
        if (lifecycle === "closed") throw new Error("Shell session is closed");
      };

      return {
        id: tunnelId,
        pid: shell.Pid,
        path: options.path,
        ptyRequested: options.pty,
        output,
        write: async (chunk) => {
          ensureOpen();
          const bytes = shellWriteBytes(chunk);
          const operation = writeTail.then(async () => {
            ensureNotClosed();
            try {
              for (let offset = 0; offset < bytes.length; offset += TUNNEL_STREAM_MAX_PAYLOAD_BYTES) {
                ensureNotClosed();
                await tunnels.send({
                  TunnelID: tunnelId,
                  SessionID: sessionId,
                  Data: bytes.subarray(offset, offset + TUNNEL_STREAM_MAX_PAYLOAD_BYTES),
                });
              }
            } catch {
              throw new Error("Unable to write to shell session");
            } finally {
              bytes.fill(0);
            }
          });
          writeTail = operation.catch(() => undefined);
          return operation;
        },
        resize: async (nextRows, nextCols) => {
          ensureOpen();
          if (!options.pty) throw new Error("Shell resize requires a PTY");
          const validatedRows = shellTerminalDimension(nextRows, "Shell rows");
          const validatedCols = shellTerminalDimension(nextCols, "Shell columns");
          try {
            await withTimeoutSignal(timeoutSeconds, (signal) =>
              this.rpc.shellResize(
                {
                  Rows: validatedRows,
                  Cols: validatedCols,
                  TunnelID: tunnelId,
                  Request: this.sessionRequest(sessionId, timeoutSeconds),
                },
                { signal },
              ),
            );
          } catch {
            throw new Error("Unable to resize shell session");
          }
        },
        close: () => closeManagedTunnel(true),
      };
    } catch {
      // The Shell RPC can lose its response after the implant has already
      // spawned the child. Once a tunnel exists, mirror the canonical client
      // and attempt a bounded graceful exit before revoking the transport.
      await closeManagedTunnel(Boolean(tunnelId));
      throw new Error("Unable to start shell session");
    }
  }

  interactSession(sessionId: string): InteractiveSession {
    if (!this.tunnels) {
      throw new Error("SliverClient is not connected");
    }
    return new InteractiveSession(this.rpc, this.artifactRpc, this.tunnels, sessionId);
  }

  interactBeacon(beaconId: string): InteractiveBeacon {
    return new InteractiveBeacon(this.rpc, this.artifactRpc, this.taskResult$, beaconId);
  }

  async rmBeacon(beaconId: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<void> {
    await withTimeoutSignal(timeoutSeconds, (signal) => this.rpc.rmBeacon({ ID: beaconId }, { signal }));
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
}

function shellTerminalDimension(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > SHELL_TERMINAL_DIMENSION_MAX) {
    throw new Error(`${label} must be between 1 and ${SHELL_TERMINAL_DIMENSION_MAX}`);
  }
  return value;
}

function shellOutputBufferBytes(value: number | undefined): number {
  if (value === undefined) return SHELL_OUTPUT_BUFFER_DEFAULT_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Shell output buffer must be a positive safe integer");
  }
  return Math.min(value, SHELL_OUTPUT_BUFFER_MAX_BYTES);
}

function shellWriteBytes(value: Uint8Array | string): Buffer {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > SHELL_WRITE_MAX_BYTES) {
      throw new Error(`Shell write must not exceed ${SHELL_WRITE_MAX_BYTES} bytes`);
    }
    return Buffer.from(value);
  }
  if (!(value instanceof Uint8Array)) throw new Error("Shell write must be bytes or text");
  if (value.byteLength > SHELL_WRITE_MAX_BYTES) {
    throw new Error(`Shell write must not exceed ${SHELL_WRITE_MAX_BYTES} bytes`);
  }
  return Buffer.from(value);
}

function boundedNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function boundedArtifactByteCount(value = WORKBENCH_ARTIFACT_MAX_PAYLOAD_BYTES): number {
  const bytes = boundedPositiveInteger(value, "Artifact byte limit");
  if (bytes > WORKBENCH_ARTIFACT_MAX_PAYLOAD_BYTES) {
    throw new Error(`Artifact byte limit exceeds ${WORKBENCH_ARTIFACT_MAX_PAYLOAD_BYTES} bytes`);
  }
  return bytes;
}

function assertBoundedArtifact(data: Buffer, label: string, maxBytes = WORKBENCH_ARTIFACT_MAX_PAYLOAD_BYTES): void {
  const boundedMaxBytes = boundedArtifactByteCount(maxBytes);
  if (data.length > boundedMaxBytes) {
    throw new Error(`${label} exceeds the ${boundedMaxBytes}-byte workbench limit`);
  }
}

function assertImplantResponse(error: string | undefined, label: string): void {
  if (error) throw new Error(`${label} was rejected by the target`);
}

async function decodeBoundedArtifact(
  data: Buffer,
  encoder: string,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const boundedMaxBytes = boundedArtifactByteCount(maxBytes);
  if (encoder === "") {
    assertBoundedArtifact(data, label, boundedMaxBytes);
    return data;
  }
  if (encoder !== "gzip") {
    data.fill(0);
    throw new Error(`${label} uses an unsupported artifact encoding`);
  }

  let decoded: Buffer | undefined;
  try {
    decoded = await gunzipBounded(data, boundedMaxBytes);
    assertBoundedArtifact(decoded, label, boundedMaxBytes);
    return decoded;
  } catch (error) {
    decoded?.fill(0);
    throw new Error(`${label} exceeds the ${boundedMaxBytes}-byte decoded limit or is invalid gzip`, {
      cause: error,
    });
  } finally {
    data.fill(0);
  }
}

function gunzipBounded(data: Buffer, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzipCb(data, { maxOutputLength }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function registryWriteFields(value: SessionRegistryWriteValue): {
  StringValue: string;
  ByteValue: Buffer;
  DWordValue: number;
  QWordValue: string;
  Type: RegistryType;
} {
  switch (value.type) {
    case "binary":
      assertBoundedArtifact(value.value, "Registry binary value");
      return {
        StringValue: "",
        ByteValue: value.value,
        DWordValue: 0,
        QWordValue: "0",
        Type: RegistryType.Binary,
      };
    case "string":
      return {
        StringValue: value.value,
        ByteValue: Buffer.alloc(0),
        DWordValue: 0,
        QWordValue: "0",
        Type: RegistryType.String,
      };
    case "dword":
      if (!Number.isInteger(value.value) || value.value < 0 || value.value > 0xffff_ffff) {
        throw new Error("Registry DWORD value must be an unsigned 32-bit integer");
      }
      return {
        StringValue: "",
        ByteValue: Buffer.alloc(0),
        DWordValue: value.value,
        QWordValue: "0",
        Type: RegistryType.DWORD,
      };
    case "qword":
      if (!/^\d+$/u.test(value.value) || BigInt(value.value) > 0xffff_ffff_ffff_ffffn) {
        throw new Error("Registry QWORD value must be an unsigned 64-bit decimal integer");
      }
      return {
        StringValue: "",
        ByteValue: Buffer.alloc(0),
        DWordValue: 0,
        QWordValue: value.value,
        Type: RegistryType.QWORD,
      };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);

    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }

    signal.addEventListener("abort", done, { once: true });
  });
}

async function waitForBeaconTask(taskResult$: Observable<Event>, taskId: string, timeoutSeconds: number) {
  return new Promise<BeaconTask>((resolve, reject) => {
    const timeoutMs = Math.floor(timeoutSeconds * 1000);
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`Timeout waiting for beacon task result: ${taskId}`));
    }, timeoutMs);

    const sub = taskResult$.subscribe({
      next: (event) => {
        try {
          const task = BeaconTask.decode(event.Data);
          if (task.ID !== taskId) return;
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(task);
        } catch (err) {
          clearTimeout(timer);
          sub.unsubscribe();
          reject(err);
        }
      },
      error: (err) => {
        clearTimeout(timer);
        sub.unsubscribe();
        reject(err);
      },
    });
  });
}
