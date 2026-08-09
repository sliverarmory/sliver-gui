import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";
import { promisify } from "node:util";

import { createChannel, createClient, type Channel } from "nice-grpc";
import { BehaviorSubject, Subject, filter, map, type Observable } from "rxjs";

import type { SliverClientConfig } from "./config";
import { createSliverRpcCredentials } from "./internal/credentials";
import { withTimeoutSignal } from "./internal/timeout";
import { TunnelManager } from "./internal/tunnelManager";
import { hasWireGuardWrapper, startWireGuardProxy, type WireGuardProxySession } from "./internal/wgProxy";
import {
  RPC_MESSAGE_DOMAINS,
  rpcMessageChannelOptions,
  rpcTlsAuthorityOverride,
  type RpcMessageDomain,
} from "./messageBudget";
import { BeaconTask } from "./pb/clientpb/client";
import type {
  Event,
  Operators,
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
import type { Request as CommonRequest } from "./pb/commonpb/common";
import { SliverRPCDefinition } from "./pb/rpcpb/services";
import type { SliverRPCClient } from "./pb/rpcpb/services";
import { Ls } from "./pb/sliverpb/sliver";

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

export interface Tunnel {
  readonly id: string;
  readonly stdout$: Observable<Buffer>;
  write(data: Buffer | string): void;
  close(): Promise<void>;
}

class BaseCommands {
  constructor(
    protected readonly rpc: SliverRPCClient,
    protected readonly artifactRpc: SliverRPCClient = rpc,
  ) {}

  protected request(timeoutSeconds: number): CommonRequest {
    return { Async: false, Timeout: `${timeoutSeconds}`, BeaconID: "", SessionID: "" };
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
      Timeout: `${timeoutSeconds}`,
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
      Timeout: `${timeoutSeconds}`,
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

    // Bind tunnel to the tunnel stream.
    this.tunnels.send({ TunnelID: tunnelId, SessionID: this.sessionId });

    // Ask the implant to open a shell on the bound tunnel.
    await this.unary(timeoutSeconds, (signal) =>
      this.rpc.shell(
        {
          Path: path,
          EnablePTY: pty,
          TunnelID: tunnelId,
          Request: this.request(timeoutSeconds),
        },
        { signal },
      ),
    );

    return {
      id: tunnelId,
      stdout$,
      write: (data: Buffer | string) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.tunnels.send({ TunnelID: tunnelId, SessionID: this.sessionId, Data: buf });
      },
      close: async () => {
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

      this.tunnels.start(this.rpc);
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
    return withTimeoutSignal(timeoutSeconds, (signal) => this.rpc.getSessions(this.empty, { signal }));
  }

  getBeacons(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<Beacons> {
    return withTimeoutSignal(timeoutSeconds, (signal) => this.rpc.getBeacons(this.empty, { signal }));
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

  async operators(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    const res = await this.getOperators(timeoutSeconds);
    return res.Operators;
  }

  async sessions(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    const res = await this.getSessions(timeoutSeconds);
    return res.Sessions;
  }

  async beacons(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    const res = await this.getBeacons(timeoutSeconds);
    return res.Beacons;
  }

  async jobs(timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    const res = await this.getJobs(timeoutSeconds);
    return res.Active;
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
    await withTimeoutSignal(timeoutSeconds, (signal) => this.rpc.rmBeacon({ ID: beaconId } as Beacon, { signal }));
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
