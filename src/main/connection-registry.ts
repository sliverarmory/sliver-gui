import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createSecureContext } from "node:tls";

import { BrowserWindow, dialog, webContents, type WebContents } from "electron";
import {
  SliverClient,
  clientpb,
  parseConfig,
  type SliverClientConfig,
  type SliverEventStreamState,
} from "sliver-script";
import type { Subscription } from "rxjs";

import {
  IPC,
  disconnectedSnapshot,
  type BuildSummary,
  type CertificatePairSelection,
  type CompilerTargetSummary,
  type GenerateFromProfileInput,
  type GenerateInput,
  type HTTPListenerInput,
  type JobSummary,
  type ListenerInput,
  type OperationResult,
  type OperationResultWithValue,
  type ProfileSummary,
  type RecentEventSummary,
  type SavedConfigSummary,
  type SavedArtifact,
  type SaveProfileInput,
  type SliverSnapshot,
  type StageListenerInput,
} from "../shared/contracts.js";
import {
  artifactFormatFromProto,
  buildImplantConfig,
  ensureTrailingDot,
  isValidPort,
  normalizeProfileName,
  splitList,
  validateImplantName,
} from "./implant-config.js";
import { buildStagePayload } from "./stage-payload.js";
import {
  discoverSavedConfigs,
  readCurrentSavedConfig,
  sanitizeSavedConfigMetadata,
  type SavedConfigRecord,
} from "./saved-config-catalog.js";
import { RecentEventDeduplicator } from "./recent-event-deduplicator.js";

interface CertificatePair {
  cert: Buffer;
  key: Buffer;
}

interface WindowContext {
  poolKey?: string;
  snapshot: SliverSnapshot;
  certificatePairs: Map<string, CertificatePair>;
  savedConfigs: Map<string, SavedConfigRecord>;
}

const GENERATE_TIMEOUT_SECONDS = 15 * 60;
const MAX_RECENT_EVENTS = 50;
const RECONCILE_INTERVAL_MS = 30_000;

export class ConnectionRegistry {
  private readonly windows = new Map<number, WindowContext>();
  private readonly pools = new Map<string, BackendPool>();

  constructor(private readonly savedConfigDirectory = join(homedir(), ".sliver-client", "configs")) {}

  registerWindow(contentsId: number): void {
    this.windows.set(contentsId, {
      snapshot: disconnectedSnapshot(),
      certificatePairs: new Map(),
      savedConfigs: new Map(),
    });
  }

  async unregisterWindow(contentsId: number): Promise<void> {
    const context = this.windows.get(contentsId);
    this.windows.delete(contentsId);
    if (context) clearCertificatePairs(context.certificatePairs);
    context?.savedConfigs.clear();
    if (context?.poolKey) await this.releasePool(context.poolKey, contentsId).catch(() => undefined);
  }

  inheritConnection(sourceContentsId: number, targetContentsId: number): void {
    const source = this.windows.get(sourceContentsId);
    const target = this.requireWindow(targetContentsId);
    if (!source?.poolKey) return;
    const pool = this.pools.get(source.poolKey);
    if (!pool) return;

    target.poolKey = source.poolKey;
    target.snapshot = pool.snapshot;
    pool.addWindow(targetContentsId);
    this.pushSnapshot(targetContentsId, pool.snapshot);
  }

  snapshot(contentsId: number): SliverSnapshot {
    const context = this.requireWindow(contentsId);
    if (!context.poolKey) return context.snapshot;
    return this.pools.get(context.poolKey)?.snapshot ?? context.snapshot;
  }

  async chooseAndConnect(sender: WebContents): Promise<OperationResult<SliverSnapshot>> {
    const contentsId = sender.id;
    try {
      const owner = requireOwnerWindow(sender);
      const result = await dialog.showOpenDialog(owner, {
        title: "Choose Sliver Operator Config",
        properties: ["openFile"],
        filters: [
          { name: "Sliver operator configs", extensions: ["cfg", "json"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      const filePath = result.filePaths[0];
      if (result.canceled || !filePath) return { ok: false, error: "Connection canceled" };
      let data: Buffer;
      try {
        data = await readFile(filePath);
      } catch {
        return { ok: false, error: "Unable to read the selected configuration file" };
      }
      try {
        return await this.connectConfig(contentsId, data, sanitizeSavedConfigMetadata(basename(filePath)));
      } finally {
        data.fill(0);
      }
    } catch {
      return { ok: false, error: "Unable to read the selected configuration file" };
    }
  }

  async listSavedConfigs(contentsId: number): Promise<OperationResult<SavedConfigSummary[]>> {
    const context = this.requireWindow(contentsId);
    try {
      const records = await discoverSavedConfigs(this.savedConfigDirectory);
      if (this.windows.get(contentsId) !== context) throw new Error("Application window changed during refresh");
      context.savedConfigs.clear();
      for (const record of records) context.savedConfigs.set(record.summary.id, record);
      return { ok: true, value: records.map((record) => record.summary) };
    } catch {
      context.savedConfigs.clear();
      return { ok: false, error: "Unable to refresh saved Sliver configurations" };
    }
  }

  async connectSavedConfig(contentsId: number, id: string): Promise<OperationResult<SliverSnapshot>> {
    const context = this.requireWindow(contentsId);
    const record = typeof id === "string" ? context.savedConfigs.get(id) : undefined;
    if (!record) return { ok: false, error: "Unknown or stale saved configuration selection" };

    let data: Buffer;
    try {
      data = await readCurrentSavedConfig(record);
    } catch {
      context.savedConfigs.delete(id);
      return { ok: false, error: "Saved configuration changed or is no longer available; refresh the list" };
    }
    try {
      return await this.connectConfig(contentsId, data, record.summary.fileName);
    } finally {
      data.fill(0);
    }
  }

  async disconnect(contentsId: number): Promise<OperationResult<SliverSnapshot>> {
    const context = this.requireWindow(contentsId);
    const poolKey = context.poolKey;
    delete context.poolKey;
    clearCertificatePairs(context.certificatePairs);
    context.snapshot = disconnectedSnapshot();
    this.pushSnapshot(contentsId, context.snapshot);
    if (poolKey) {
      try {
        await this.releasePool(poolKey, contentsId);
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
    return { ok: true, value: context.snapshot };
  }

  async refresh(contentsId: number): Promise<OperationResult<SliverSnapshot>> {
    return this.withPool(contentsId, async (pool) => {
      await pool.refreshAll();
      return pool.snapshot;
    });
  }

  async chooseCertificatePair(sender: WebContents): Promise<OperationResult<CertificatePairSelection>> {
    const contentsId = sender.id;
    try {
      const owner = requireOwnerWindow(sender);
      const certificate = await dialog.showOpenDialog(owner, {
        title: "Choose PEM Certificate",
        properties: ["openFile"],
        filters: [{ name: "PEM certificate", extensions: ["pem", "crt", "cer"] }],
      });
      const certificatePath = certificate.filePaths[0];
      if (certificate.canceled || !certificatePath) return { ok: false, error: "Certificate selection canceled" };

      const key = await dialog.showOpenDialog(owner, {
        title: "Choose PEM Private Key",
        properties: ["openFile"],
        filters: [{ name: "PEM private key", extensions: ["pem", "key"] }],
      });
      const keyPath = key.filePaths[0];
      if (key.canceled || !keyPath) return { ok: false, error: "Private key selection canceled" };

      const [certData, keyData] = await Promise.all([readFile(certificatePath), readFile(keyPath)]);
      try {
        createSecureContext({ cert: certData, key: keyData });
        const token = randomUUID();
        this.requireWindow(contentsId).certificatePairs.set(token, { cert: certData, key: keyData });
        return {
          ok: true,
          value: { token, certificateName: basename(certificatePath), keyName: basename(keyPath) },
        };
      } catch (error) {
        certData.fill(0);
        keyData.fill(0);
        throw error;
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async startListener(contentsId: number, input: ListenerInput): Promise<OperationResult<JobSummary>> {
    return this.withPool(contentsId, async (pool) => {
      validateListener(input);
      let jobId: number;

      switch (input.kind) {
        case "mtls": {
          const response = await pool.client.startMTLSListener(input.host.trim(), input.port);
          jobId = response.JobID;
          break;
        }
        case "wireguard": {
          const response = await pool.client.startWGListener(
            input.host.trim(),
            input.port,
            input.tunnelIp.trim(),
            input.tcpCommsPort,
            input.keyExchangePort,
          );
          jobId = response.JobID;
          break;
        }
        case "dns": {
          const domains = splitList(input.domains).map(ensureTrailingDot);
          const response = await pool.client.startDNSListener(
            domains,
            input.canaries,
            input.host.trim(),
            input.port,
            input.enforceOtp,
          );
          jobId = response.JobID;
          break;
        }
        case "http":
        case "https": {
          jobId = await this.startHttpListener(contentsId, pool, input);
          break;
        }
        case "stage": {
          jobId = await this.startStageListener(pool, input);
          break;
        }
        default: {
          return assertNever(input);
        }
      }

      await pool.refreshAll();
      return (
        pool.snapshot.jobs.find((job) => job.id === jobId) ?? {
          id: jobId,
          name: input.kind,
          description: "Listener starting",
          protocol: input.kind,
          port: input.port,
          domains: [],
          profileName: input.kind === "stage" ? input.profileName : "",
        }
      );
    });
  }

  async killJob(contentsId: number, jobId: number): Promise<OperationResult> {
    return this.withPoolWithoutValue(contentsId, async (pool) => {
      if (!Number.isInteger(jobId) || jobId < 0) throw new Error("Invalid job ID");
      const result = await pool.client.killJob(jobId);
      if (!result.Success) throw new Error(`Server did not stop job #${jobId}`);
      await pool.refreshAll();
    });
  }

  async killAllJobs(contentsId: number): Promise<OperationResult> {
    return this.withPoolWithoutValue(contentsId, async (pool) => {
      const jobs = [...pool.snapshot.jobs];
      const failures: string[] = [];
      for (const job of jobs) {
        try {
          const result = await pool.client.killJob(job.id);
          if (!result.Success) failures.push(`#${job.id}`);
        } catch {
          failures.push(`#${job.id}`);
        }
      }
      await pool.refreshAll();
      if (failures.length) throw new Error(`Failed to stop jobs ${failures.join(", ")}`);
    });
  }

  async generate(sender: WebContents, input: GenerateInput): Promise<OperationResult<SavedArtifact>> {
    const contentsId = sender.id;
    const owner = requireOwnerWindow(sender);
    return this.withPool(contentsId, async (pool) => {
      pool.assertCompilerTarget(input);
      const needsWireGuardIp = /(^|[\n,])\s*wg:\/\//i.test(input.c2) && !input.wgPeerTunIp.trim();
      const uniqueIp = needsWireGuardIp ? (await pool.client.generateUniqueIP()).IP : "";
      const config = buildImplantConfig(input, uniqueIp);
      const response = await pool.client.generateImplant(
        config,
        validateImplantName(input.name),
        GENERATE_TIMEOUT_SECONDS,
      );
      const saved = await saveArtifact(owner, response);
      await pool.refreshAll();
      return saved;
    });
  }

  async generateFromProfile(
    sender: WebContents,
    input: GenerateFromProfileInput,
  ): Promise<OperationResult<SavedArtifact>> {
    const contentsId = sender.id;
    const owner = requireOwnerWindow(sender);
    return this.withPool(contentsId, async (pool) => {
      const profile = pool.profile(input.profileName);
      if (!profile.Config) throw new Error(`Profile '${input.profileName}' has no implant configuration`);
      const response = await pool.client.generateImplant(
        profile.Config,
        validateImplantName(input.name),
        GENERATE_TIMEOUT_SECONDS,
      );
      const saved = await saveArtifact(owner, response);
      await pool.refreshAll();
      return saved;
    });
  }

  async downloadBuild(sender: WebContents, buildName: string): Promise<OperationResult<SavedArtifact>> {
    const contentsId = sender.id;
    const owner = requireOwnerWindow(sender);
    return this.withPool(contentsId, async (pool) => {
      const normalized = requireKnownName(buildName, "Build name");
      if (!pool.hasBuild(normalized)) throw new Error(`Unknown build '${normalized}'`);
      const response = await pool.client.regenerateImplant(normalized, GENERATE_TIMEOUT_SECONDS);
      return saveArtifact(owner, response);
    });
  }

  async deleteBuild(contentsId: number, buildName: string): Promise<OperationResult> {
    return this.withPoolWithoutValue(contentsId, async (pool) => {
      const normalized = requireKnownName(buildName, "Build name");
      if (!pool.hasBuild(normalized)) throw new Error(`Unknown build '${normalized}'`);
      await pool.client.deleteImplantBuild(normalized);
      await pool.refreshAll();
    });
  }

  async setStagedBuilds(contentsId: number, buildNames: string[]): Promise<OperationResult> {
    return this.withPoolWithoutValue(contentsId, async (pool) => {
      const unique = [...new Set(buildNames.map((name) => requireKnownName(name, "Build name")))];
      for (const name of unique) if (!pool.hasBuild(name)) throw new Error(`Unknown build '${name}'`);
      await pool.client.stageImplantBuild(unique);
      await pool.refreshAll();
    });
  }

  async saveProfile(contentsId: number, input: SaveProfileInput): Promise<OperationResult<ProfileSummary>> {
    return this.withPool(contentsId, async (pool) => {
      const name = normalizeProfileName(input.profileName);
      const needsWireGuardIp = /(^|[\n,])\s*wg:\/\//i.test(input.config.c2) && !input.config.wgPeerTunIp.trim();
      const uniqueIp = needsWireGuardIp ? (await pool.client.generateUniqueIP()).IP : "";
      const config = buildImplantConfig(input.config, uniqueIp);
      await pool.client.saveImplantProfile(clientpb.ImplantProfile.create({ ID: "", Name: name, Config: config }));
      await pool.refreshAll();
      const profile = pool.snapshot.profiles.find((item) => item.name === name);
      if (!profile) throw new Error(`Profile '${name}' was saved but could not be reloaded`);
      return profile;
    });
  }

  async deleteProfile(contentsId: number, profileName: string): Promise<OperationResult> {
    return this.withPoolWithoutValue(contentsId, async (pool) => {
      const normalized = requireKnownName(profileName, "Profile name");
      pool.profile(normalized);
      await pool.client.deleteImplantProfile(normalized);
      await pool.refreshAll();
    });
  }

  private async startHttpListener(
    contentsId: number,
    pool: BackendPool,
    input: HTTPListenerInput,
  ): Promise<number> {
    const base = {
      domain: input.domain.trim(),
      host: input.host.trim(),
      port: input.port,
      website: input.website.trim(),
      enforceOTP: input.enforceOtp,
      longPollTimeoutNanoseconds: secondsToNanoseconds(input.longPollTimeoutSeconds),
      longPollJitterNanoseconds: secondsToNanoseconds(input.longPollJitterSeconds),
    };

    if (input.kind === "http") {
      return (await pool.client.startHTTPListenerWithOptions(base)).JobID;
    }

    const certificate = input.certificateToken
      ? this.requireWindow(contentsId).certificatePairs.get(input.certificateToken)
      : undefined;
    if (input.certificateToken && !certificate) throw new Error("The selected certificate pair is no longer available");
    return (
      await pool.client.startHTTPSListenerWithOptions({
        ...base,
        acme: input.acme,
        randomizeJARM: input.randomizeJarm,
        ...(certificate ? { cert: certificate.cert, key: certificate.key } : {}),
      })
    ).JobID;
  }

  private async startStageListener(pool: BackendPool, input: StageListenerInput): Promise<number> {
    const profile = pool.profile(input.profileName);
    if (!profile.Config) throw new Error(`Profile '${input.profileName}' has no implant configuration`);
    const generated = await pool.client.generateImplant(profile.Config, "", GENERATE_TIMEOUT_SECONDS);
    if (!generated.File) throw new Error("Server returned no stage payload");
    let payload: Buffer;
    try {
      payload = buildStagePayload(generated.File.Data, input);
    } finally {
      generated.File.Data.fill(0);
    }
    try {
      const response = await pool.client.startTCPStagerListenerWithOptions({
        Protocol: clientpb.StageProtocol.TCP,
        Host: input.host.trim(),
        Port: input.port,
        Data: payload,
        ProfileName: input.profileName,
      });
      return response.JobID;
    } finally {
      payload.fill(0);
    }
  }

  private async withPool<T>(
    contentsId: number,
    operation: (pool: BackendPool) => Promise<T>,
  ): Promise<OperationResultWithValue<T>> {
    try {
      const context = this.requireWindow(contentsId);
      const pool = context.poolKey ? this.pools.get(context.poolKey) : undefined;
      if (!pool || pool.snapshot.connection.status !== "connected") throw new Error("Connect to a Sliver server first");
      const value = await operation(pool);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private async withPoolWithoutValue(
    contentsId: number,
    operation: (pool: BackendPool) => Promise<void>,
  ): Promise<OperationResult> {
    const result = await this.withPool(contentsId, operation);
    return result.ok ? { ok: true } : result;
  }

  private async connectConfig(
    contentsId: number,
    data: Buffer,
    configName: string,
  ): Promise<OperationResult<SliverSnapshot>> {
    let connectionAttemptStarted = false;
    try {
      let config: SliverClientConfig;
      try {
        config = parseConfig(data);
      } catch {
        throw new Error("Invalid Sliver configuration file");
      }
      if (!Number.isSafeInteger(config.lport) || config.lport < 1 || config.lport > 65_535) {
        throw new Error("Invalid Sliver configuration port");
      }
      const poolKey = createHash("sha256").update(data).digest("hex");
      const context = this.requireWindow(contentsId);
      connectionAttemptStarted = true;

      if (context.poolKey && context.poolKey !== poolKey) {
        const previousPoolKey = context.poolKey;
        delete context.poolKey;
        await this.releasePool(previousPoolKey, contentsId);
        clearCertificatePairs(context.certificatePairs);
      }
      context.snapshot = {
        ...disconnectedSnapshot(),
        connection: {
          status: "connecting",
          operator: sanitizeSavedConfigMetadata(config.operator),
          server: `${sanitizeSavedConfigMetadata(config.lhost)}:${config.lport}`,
          configName,
        },
      };
      this.pushSnapshot(contentsId, context.snapshot);

      let pool = this.pools.get(poolKey);
      if (!pool) {
        pool = new BackendPool(poolKey, config, configName, (snapshot) => this.broadcast(poolKey, snapshot));
        this.pools.set(poolKey, pool);
      }

      context.poolKey = poolKey;
      pool.addWindow(contentsId);
      await pool.connect();
      context.snapshot = pool.snapshot;
      return { ok: true, value: pool.snapshot };
    } catch (error) {
      const message = errorMessage(error);
      const context = this.windows.get(contentsId);
      if (!context || !connectionAttemptStarted) return { ok: false, error: message };
      if (context.poolKey) {
        const failedPoolKey = context.poolKey;
        delete context.poolKey;
        await this.releasePool(failedPoolKey, contentsId).catch(() => undefined);
      }
      clearCertificatePairs(context.certificatePairs);
      context.snapshot = disconnectedSnapshot(message);
      this.pushSnapshot(contentsId, context.snapshot);
      return { ok: false, error: message };
    }
  }

  private requireWindow(contentsId: number): WindowContext {
    const context = this.windows.get(contentsId);
    if (!context) throw new Error("Unknown application window");
    return context;
  }

  private async releasePool(poolKey: string, contentsId: number): Promise<void> {
    const pool = this.pools.get(poolKey);
    if (!pool) return;
    pool.removeWindow(contentsId);
    if (pool.windowCount === 0) {
      this.pools.delete(poolKey);
      await pool.close();
    }
  }

  private broadcast(poolKey: string, snapshot: SliverSnapshot): void {
    for (const [contentsId, context] of this.windows) {
      if (context.poolKey !== poolKey) continue;
      context.snapshot = snapshot;
      this.pushSnapshot(contentsId, snapshot);
    }
  }

  private pushSnapshot(contentsId: number, snapshot: SliverSnapshot): void {
    const contents = webContents.fromId(contentsId);
    if (contents && !contents.isDestroyed()) contents.send(IPC.snapshotChanged, snapshot);
  }
}

class BackendPool {
  readonly client: SliverClient;
  private readonly windowIds = new Set<number>();
  private readonly subscriptions: Subscription[] = [];
  private readonly profilesByName = new Map<string, clientpb.ImplantProfile>();
  private readonly buildsByName = new Map<string, clientpb.ImplantConfig>();
  private connectPromise: Promise<void> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private reconcileTimer?: NodeJS.Timeout;
  private invalidationTimer?: NodeJS.Timeout;
  private previousEventStatus: SliverEventStreamState["status"] = "stopped";
  private recentEvents: RecentEventSummary[] = [];
  private readonly recentEventDeduplicator = new RecentEventDeduplicator();

  snapshot: SliverSnapshot;

  constructor(
    readonly key: string,
    config: SliverClientConfig,
    configName: string,
    private readonly onSnapshot: (snapshot: SliverSnapshot) => void,
  ) {
    this.client = new SliverClient(config);
    this.snapshot = {
      ...disconnectedSnapshot(),
      connection: {
        status: "connecting",
        operator: sanitizeSavedConfigMetadata(config.operator),
        server: `${sanitizeSavedConfigMetadata(config.lhost)}:${config.lport}`,
        configName,
      },
    };
  }

  get windowCount(): number {
    return this.windowIds.size;
  }

  addWindow(contentsId: number): void {
    this.windowIds.add(contentsId);
    this.onSnapshot(this.snapshot);
  }

  removeWindow(contentsId: number): void {
    this.windowIds.delete(contentsId);
  }

  connect(): Promise<void> {
    if (this.snapshot.connection.status === "connected") return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async connectInternal(): Promise<void> {
    const version = await this.client.connect().then(() => this.client.getVersion());
    this.subscribe();
    this.snapshot = {
      ...this.snapshot,
      connection: {
        ...this.snapshot.connection,
        status: "connected",
        version: `${version.Major}.${version.Minor}.${version.Patch}${version.Dirty ? " (dirty)" : ""}`,
      },
    };
    this.onSnapshot(this.snapshot);
    await this.refreshAll();
    this.reconcileTimer = setInterval(() => void this.refreshAll(), RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref();
  }

  async close(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.invalidationTimer) clearTimeout(this.invalidationTimer);
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions.length = 0;
    await this.client.disconnect();
  }

  async refreshAll(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshInternal().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async refreshInternal(): Promise<void> {
    const [jobs, builds, profiles, compiler] = await Promise.all([
      this.client.jobs(),
      this.client.implantBuilds(),
      this.client.implantProfiles(),
      this.client.getCompiler(),
    ]);

    this.buildsByName.clear();
    for (const [name, config] of Object.entries(builds.Configs)) this.buildsByName.set(name, config);
    this.profilesByName.clear();
    for (const profile of profiles.Profiles) this.profilesByName.set(profile.Name, profile);

    const buildSummaries = Object.entries(builds.Configs)
      .map(([name, config]) => buildSummary(name, config, builds.staged[name] ?? false))
      .sort((left, right) => left.name.localeCompare(right.name));
    const profileSummaries = profiles.Profiles.map(profileSummary).sort((left, right) => left.name.localeCompare(right.name));

    this.snapshot = {
      ...this.snapshot,
      jobs: jobs.map(jobSummary).sort((left, right) => left.id - right.id),
      builds: buildSummaries,
      profiles: profileSummaries,
      compilerTargets: compilerTargetSummaries(compiler),
      recentEvents: this.recentEvents,
      lastUpdated: new Date().toISOString(),
    };
    this.onSnapshot(this.snapshot);
  }

  profile(name: string): clientpb.ImplantProfile {
    const normalized = requireKnownName(name, "Profile name");
    const profile = this.profilesByName.get(normalized);
    if (!profile) throw new Error(`Unknown profile '${normalized}'`);
    return profile;
  }

  hasBuild(name: string): boolean {
    return this.buildsByName.has(name);
  }

  assertCompilerTarget(input: GenerateInput): void {
    if (this.snapshot.compilerTargets.length === 0) return;
    const os = input.os.trim().toLowerCase();
    const arch = input.arch.trim().toLowerCase();
    const match = this.snapshot.compilerTargets.find(
      (target) => target.os === os && target.arch === arch && target.format === input.format,
    );
    if (!match?.supported) throw new Error(`The server cannot build ${input.format} for ${os}/${arch}`);
  }

  private subscribe(): void {
    this.subscriptions.push(
      this.client.event$.subscribe((event) => {
        if (this.recentEventDeduplicator.shouldRecord(event)) {
          this.recentEvents = [summarizeEvent(event), ...this.recentEvents].slice(0, MAX_RECENT_EVENTS);
          this.snapshot = { ...this.snapshot, recentEvents: this.recentEvents };
          this.onSnapshot(this.snapshot);
        }
        this.scheduleInvalidation();
      }),
      this.client.eventStreamState$.subscribe((state) => {
        const recovered = this.previousEventStatus === "retrying" && state.status === "connected";
        this.previousEventStatus = state.status;
        this.snapshot = {
          ...this.snapshot,
          eventStream: {
            status: state.status,
            attempt: state.attempt,
            ...(state.error ? { error: state.error } : {}),
          },
        };
        this.onSnapshot(this.snapshot);
        if (recovered) this.scheduleInvalidation(0);
      }),
    );
  }

  private scheduleInvalidation(delayMs = 100): void {
    if (this.invalidationTimer) clearTimeout(this.invalidationTimer);
    this.invalidationTimer = setTimeout(() => void this.refreshAll(), delayMs);
    this.invalidationTimer.unref();
  }
}

function jobSummary(job: clientpb.Job): JobSummary {
  return {
    id: job.ID,
    name: job.Name,
    description: job.Description,
    protocol: job.Protocol,
    port: job.Port,
    domains: [...job.Domains],
    profileName: job.ProfileName,
  };
}

function buildSummary(name: string, config: clientpb.ImplantConfig, staged: boolean): BuildSummary {
  return {
    name,
    configId: config.ID,
    target: `${config.GOOS}/${config.GOARCH}`,
    format: artifactFormatFromProto(config.Format),
    implantType: config.IsBeacon ? "beacon" : "session",
    c2: config.C2.map((endpoint) => endpoint.URL),
    staged,
  };
}

function profileSummary(profile: clientpb.ImplantProfile): ProfileSummary {
  const config = profile.Config;
  return {
    id: profile.ID,
    name: profile.Name,
    target: config ? `${config.GOOS}/${config.GOARCH}` : "Unknown",
    format: config ? artifactFormatFromProto(config.Format) : "executable",
    implantType: config?.IsBeacon ? "beacon" : "session",
    c2: config?.C2.map((endpoint) => endpoint.URL) ?? [],
  };
}

function compilerTargetSummaries(compiler: clientpb.Compiler): CompilerTargetSummary[] {
  const summaries = new Map<string, CompilerTargetSummary>();
  for (const [supported, targets] of [
    [true, compiler.Targets],
    [false, compiler.UnsupportedTargets],
  ] as const) {
    for (const target of targets) {
      const summary = {
        os: target.GOOS,
        arch: target.GOARCH,
        format: artifactFormatFromProto(target.Format),
        supported,
      };
      summaries.set(`${summary.os}/${summary.arch}/${summary.format}`, summary);
    }
  }
  return [...summaries.values()].sort((left, right) =>
    `${left.os}/${left.arch}/${left.format}`.localeCompare(`${right.os}/${right.arch}/${right.format}`),
  );
}

function summarizeEvent(event: clientpb.Event): RecentEventSummary {
  const data = event.Data.length ? event.Data.toString("utf8").replace(/[\r\n]+/g, " ").slice(0, 160) : "";
  const job = event.Job ? `job #${event.Job.ID} ${event.Job.Protocol}:${event.Job.Port}` : "";
  const message = [job, data, event.Err].filter(Boolean).join(" — ") || event.EventType;
  return {
    id: randomUUID(),
    type: event.EventType,
    at: new Date().toISOString(),
    message,
    isError: Boolean(event.Err),
  };
}

async function saveArtifact(owner: BrowserWindow, response: clientpb.Generate): Promise<SavedArtifact> {
  const file = response.File;
  if (!file) throw new Error("Server returned no generated file");
  try {
    if (owner.isDestroyed()) throw new Error("The application window was closed before the artifact could be saved");
    const selection = await dialog.showSaveDialog(owner, {
      title: "Save Generated Artifact",
      defaultPath: file.Name || response.ImplantName,
    });

    if (selection.canceled || !selection.filePath) {
      return {
        fileName: file.Name,
        size: file.Data.length,
        implantName: response.ImplantName,
        buildId: response.ImplantBuildID,
        saved: false,
      };
    }

    await writeFile(selection.filePath, file.Data, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(selection.filePath, 0o700);
    return {
      fileName: basename(selection.filePath),
      size: file.Data.length,
      implantName: response.ImplantName,
      buildId: response.ImplantBuildID,
      saved: true,
    };
  } finally {
    file.Data.fill(0);
  }
}

function validateListener(input: ListenerInput): void {
  if (!isValidPort(input.port)) throw new Error("Listener port must be between 1 and 65534");
  if (input.host.includes("\0")) throw new Error("Listener host is invalid");
  if (input.kind === "wireguard") {
    if (!isValidPort(input.tcpCommsPort) || !isValidPort(input.keyExchangePort)) {
      throw new Error("WireGuard auxiliary ports must be between 1 and 65534");
    }
  }
  if (input.kind === "dns" && splitList(input.domains).length === 0) throw new Error("At least one DNS domain is required");
  if (input.kind === "http" || input.kind === "https") {
    secondsToNanoseconds(input.longPollTimeoutSeconds);
    secondsToNanoseconds(input.longPollJitterSeconds);
    if (input.acme && input.certificateToken) throw new Error("Choose ACME or a certificate pair, not both");
  }
  if (input.kind === "stage" && !input.profileName.trim()) throw new Error("A stage profile is required");
}

function secondsToNanoseconds(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("Listener durations must be non-negative whole seconds");
  return (BigInt(seconds) * 1_000_000_000n).toString();
}

function requireKnownName(name: string, label: string): string {
  const normalized = name.trim();
  if (!normalized || normalized.length > 256 || normalized.includes("\0")) throw new Error(`${label} is invalid`);
  return normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected listener input: ${String(value)}`);
}

function requireOwnerWindow(sender: WebContents): BrowserWindow {
  if (sender.isDestroyed()) throw new Error("The application window is no longer available");
  const owner = BrowserWindow.fromWebContents(sender);
  if (!owner || owner.isDestroyed()) throw new Error("The application window is no longer available");
  return owner;
}

function clearCertificatePairs(pairs: Map<string, CertificatePair>): void {
  for (const pair of pairs.values()) {
    pair.cert.fill(0);
    pair.key.fill(0);
  }
  pairs.clear();
}
