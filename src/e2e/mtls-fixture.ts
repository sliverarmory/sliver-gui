import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { credentials, ServerCredentials } from "@grpc/grpc-js";
import {
  createChannel,
  createClient,
  createServer,
  Metadata,
  ServerError,
  Status,
  type Server,
} from "nice-grpc";
import { clientpb, rpcpb } from "sliver-script";

export const PACKAGED_FIXTURE_TOKEN = "PACKAGED_MTLS_TOKEN_M0_DO_NOT_RENDER";
export const PACKAGED_FIXTURE_EVENT_SECRET = "PACKAGED_EVENT_SECRET_M0_DO_NOT_RENDER";
const FIXTURE_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;

interface FixtureCallContext {
  metadata: {
    get(key: string): string | Uint8Array | undefined;
  };
  peer: string;
  signal: AbortSignal;
}

export interface MtlsFixtureState {
  calls: string[];
  authenticatedCalls: number;
  eventStreams: number;
  listenerRequests: Array<{ host: string; port: number }>;
  killedJobs: number[];
  rejectedTokenCalls: number;
}

export interface MtlsFixture {
  readonly port: number;
  readonly state: MtlsFixtureState;
  readonly caCertificate: string;
  readonly clientCertificate: string;
  readonly clientPrivateKey: string;
  close(): Promise<void>;
}

export async function startMtlsFixture(repositoryRoot: string): Promise<MtlsFixture> {
  const fixtureDirectory = join(repositoryRoot, "src/e2e/fixtures");
  const [caCertificate, serverCertificate, serverPrivateKey, clientCertificate, clientPrivateKey] =
    await Promise.all([
      readFile(join(fixtureDirectory, "ca.crt.fixture"), "utf8"),
      readFile(join(fixtureDirectory, "server.crt.fixture"), "utf8"),
      readFile(join(fixtureDirectory, "server-key.fixture"), "utf8"),
      readFile(join(fixtureDirectory, "client.crt.fixture"), "utf8"),
      readFile(join(fixtureDirectory, "client-key.fixture"), "utf8"),
    ]);

  const state: MtlsFixtureState = {
    calls: [],
    authenticatedCalls: 0,
    eventStreams: 0,
    listenerRequests: [],
    killedJobs: [],
    rejectedTokenCalls: 0,
  };
  let jobs: clientpb.Job[] = [
    {
      ID: 80,
      Name: "mtls",
      Description: "Protocol fixture mTLS listener",
      Protocol: "mtls",
      Port: 31337,
      Domains: [],
      ProfileName: "",
    },
  ];
  let nextJobId = 81;
  const eventWaiters = new Set<(event: clientpb.Event | undefined) => void>();

  const record = (method: string, context: FixtureCallContext): void => {
    const authorization = context.metadata.get("authorization");
    if (authorization !== `Bearer ${PACKAGED_FIXTURE_TOKEN}`) {
      state.rejectedTokenCalls += 1;
      throw new ServerError(Status.UNAUTHENTICATED, "Missing or invalid operator token");
    }
    if (!isLoopbackPeer(context.peer)) {
      throw new ServerError(Status.PERMISSION_DENIED, "The M0 fixture accepts loopback clients only");
    }
    state.calls.push(method);
    state.authenticatedCalls += 1;
  };

  const emit = (event: clientpb.Event): void => {
    for (const resolve of eventWaiters) resolve(event);
    eventWaiters.clear();
  };

  const implementation = new Proxy(
    {
      async getVersion(_request: unknown, context: FixtureCallContext) {
        record("getVersion", context);
        return {
          Major: 1,
          Minor: 7,
          Patch: 0,
          Commit: "mtls-e2e-fixture-build",
          Dirty: false,
          CompiledAt: "0",
          OS: process.platform,
          Arch: process.arch,
        };
      },
      async getJobs(_request: unknown, context: FixtureCallContext) {
        record("getJobs", context);
        return { Active: jobs };
      },
      async implantBuilds(_request: unknown, context: FixtureCallContext) {
        record("implantBuilds", context);
        return { Configs: {}, ResourceIDs: {}, staged: {} };
      },
      async implantProfiles(_request: unknown, context: FixtureCallContext) {
        record("implantProfiles", context);
        return { Profiles: [] };
      },
      async getCompiler(_request: unknown, context: FixtureCallContext) {
        record("getCompiler", context);
        return {
          GOOS: process.platform,
          GOARCH: process.arch,
          Targets: [
            { GOOS: "linux", GOARCH: "amd64", Format: clientpb.OutputFormat.EXECUTABLE },
          ],
          CrossCompilers: [],
          UnsupportedTargets: [],
        };
      },
      async startMTLSListener(request: clientpb.MTLSListenerReq, context: FixtureCallContext) {
        record("startMTLSListener", context);
        const job: clientpb.Job = {
          ID: nextJobId++,
          Name: "mtls",
          Description: "Packaged-app mTLS listener",
          Protocol: "mtls",
          Port: request.Port,
          Domains: request.Host ? [request.Host] : [],
          ProfileName: "",
        };
        jobs = [...jobs, job];
        state.listenerRequests.push({ host: request.Host, port: request.Port });
        emit({
          EventType: "job-started",
          Job: job,
          Data: Buffer.from(PACKAGED_FIXTURE_EVENT_SECRET),
          Err: "",
        });
        return {
          ID: String(job.ID),
          Type: "mtls",
          JobID: job.ID,
          MTLSConf: { Host: request.Host, Port: request.Port },
        };
      },
      async killJob(request: clientpb.KillJobReq, context: FixtureCallContext) {
        record("killJob", context);
        const job = jobs.find((candidate) => candidate.ID === request.ID);
        jobs = jobs.filter((candidate) => candidate.ID !== request.ID);
        state.killedJobs.push(request.ID);
        emit({
          EventType: "job-stopped",
          ...(job ? { Job: job } : {}),
          Data: Buffer.from(PACKAGED_FIXTURE_EVENT_SECRET),
          Err: "",
        });
        return { ID: request.ID, Success: job !== undefined };
      },
      async *events(_request: unknown, context: FixtureCallContext): AsyncIterable<clientpb.Event> {
        record("events", context);
        state.eventStreams += 1;
        while (!context.signal.aborted) {
          const event = await waitForEvent(eventWaiters, context.signal);
          if (!event) return;
          yield event;
        }
      },
      async *tunnelData(
        requests: AsyncIterable<unknown>,
        context: FixtureCallContext,
      ): AsyncIterable<Record<string, never>> {
        record("tunnelData", context);
        try {
          for await (const _request of requests) {
            if (context.signal.aborted) return;
          }
        } catch {
          // Client cancellation is expected during clean application shutdown.
        }
      },
    },
    {
      get(target, property, receiver) {
        const handler = Reflect.get(target, property, receiver) as unknown;
        if (typeof handler === "function") return handler;
        return async () => {
          throw new ServerError(Status.UNIMPLEMENTED, `Fixture RPC ${String(property)} is not implemented`);
        };
      },
    },
  ) as unknown as rpcpb.SliverRPCServiceImplementation;

  const server: Server = createServer();
  server.add(rpcpb.SliverRPCDefinition, implementation);
  const credentials = ServerCredentials.createSsl(
    Buffer.from(caCertificate),
    [{ private_key: Buffer.from(serverPrivateKey), cert_chain: Buffer.from(serverCertificate) }],
    true,
  );
  const port = await server.listen("127.0.0.1:0", credentials);

  return {
    port,
    state,
    caCertificate,
    clientCertificate,
    clientPrivateKey,
    async close(): Promise<void> {
      for (const resolve of eventWaiters) resolve(undefined);
      eventWaiters.clear();
      let timeout: NodeJS.Timeout | undefined;
      const graceful = Promise.resolve()
        .then(() => server.shutdown())
        .then(() => true, () => false);
      const completedGracefully = await Promise.race([
        graceful,
        new Promise<boolean>((resolveTimeout) => {
          timeout = setTimeout(() => resolveTimeout(false), FIXTURE_GRACEFUL_SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!completedGracefully) server.forceShutdown();
    },
  };
}

export async function verifyFixtureAuthenticationBoundary(fixture: MtlsFixture): Promise<void> {
  await expectVersionRejected(
    fixture,
    credentials.createSsl(
      Buffer.from(fixture.caCertificate),
      undefined,
      undefined,
      { checkServerIdentity: () => undefined },
    ),
    PACKAGED_FIXTURE_TOKEN,
    "a client without an operator certificate",
  );
  await expectVersionRejected(
    fixture,
    credentials.createSsl(
      Buffer.from(fixture.caCertificate),
      Buffer.from(fixture.clientPrivateKey),
      Buffer.from(fixture.clientCertificate),
      { checkServerIdentity: () => undefined },
    ),
    "WRONG_M0_OPERATOR_TOKEN",
    "a client with an invalid operator token",
  );
}

async function expectVersionRejected(
  fixture: MtlsFixture,
  tlsCredentials: ReturnType<typeof credentials.createSsl>,
  token: string,
  label: string,
): Promise<void> {
  const channel = createChannel(`127.0.0.1:${fixture.port}`, tlsCredentials, {
    // Match the production client's DNS-form authority for IP-literal targets.
    // grpc-js otherwise rejects an IP literal as a TLS SNI value before the
    // fixture can exercise its certificate and token authentication boundary.
    "grpc.default_authority": "sliver",
    "grpc.ssl_target_name_override": "sliver",
  });
  const client = createClient(rpcpb.SliverRPCDefinition, channel);
  let rejected = false;
  try {
    await client.getVersion(
      {},
      {
        metadata: Metadata({ authorization: `Bearer ${token}` }),
        signal: AbortSignal.timeout(3_000),
      },
    );
  } catch {
    rejected = true;
  } finally {
    channel.close();
  }
  if (!rejected) throw new Error(`The mTLS fixture accepted ${label}`);
}

function waitForEvent(
  waiters: Set<(event: clientpb.Event | undefined) => void>,
  signal: AbortSignal,
): Promise<clientpb.Event | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const done = (event: clientpb.Event | undefined): void => {
      signal.removeEventListener("abort", aborted);
      waiters.delete(done);
      resolve(event);
    };
    const aborted = (): void => done(undefined);
    waiters.add(done);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function isLoopbackPeer(peer: string): boolean {
  return peer.includes("127.0.0.1") || peer.includes("[::1]") || peer.startsWith("::1:");
}
