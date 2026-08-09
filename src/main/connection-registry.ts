import { createHash, randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
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
  type DomainCollection,
  type DomainStatus,
  type GenerateFromProfileInput,
  type GenerateInput,
  type HTTPListenerInput,
  type JobSummary,
  type JobStopPlan,
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
  SLIVER_PROTOCOL_BASELINE_COMMIT,
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
  readCurrentSavedConfig,
  sanitizeSavedConfigMetadata,
  type SavedConfigRecord,
} from "./saved-config-catalog.js";
import { RecentEventDeduplicator } from "./recent-event-deduplicator.js";
import {
  deferredWireGuardResult,
  OperatorConfigStore,
  readConfigForImport,
} from "./operator-config-store.js";
import { readBoundedRegularFile } from "./secure-file.js";

interface CertificatePair {
  cert: Buffer;
  key: Buffer;
  expiresAt: number;
}

interface WindowContext {
  poolKey?: string;
  configName?: string;
  snapshot: SliverSnapshot;
  certificatePairs: Map<string, CertificatePair>;
  certificateTimers: Map<string, NodeJS.Timeout>;
  savedConfigs: Map<string, SavedConfigRecord>;
  connectionAttempt: number;
  stopPlans: Map<string, InternalStopPlan>;
}

const GENERATE_TIMEOUT_SECONDS = 15 * 60;
const MAX_RECENT_EVENTS = 50;
const RECONCILE_INTERVAL_MS = 30_000;
const CERTIFICATE_CAPABILITY_TTL_MS = 5 * 60_000;
const JOB_STOP_PLAN_TTL_MS = 60_000;
const MAX_CERTIFICATE_BYTES = 1024 * 1024;
const MAX_KEY_BYTES = 1024 * 1024;
const MAX_DOMAIN_ITEMS = 500;
const MAX_SUMMARY_TEXT = 256;
const MAX_SUMMARY_LIST_ITEMS = 32;

type CurrentClientMethod =
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
  | "deleteImplantProfile";

export type SliverClientAdapter = Pick<
  SliverClient,
  Exclude<CurrentClientMethod, "connect"> | "event$" | "eventStreamState$"
> & {
  connect(): Promise<unknown>;
};
export type SliverClientFactory = (config: SliverClientConfig) => SliverClientAdapter;

export interface ConnectionRegistryOptions {
  savedConfigDirectory?: string;
  managedConfigDirectory?: string;
  clientFactory?: SliverClientFactory;
  now?: () => number;
}

interface InternalStopPlan {
  token: string;
  expiresAt: number;
  contentsId: number;
  poolKey: string;
  epoch: number;
  jobs: JobSummary[];
  fingerprints: string[];
  stopsAll: boolean;
}

export class ConnectionRegistry {
  private readonly windows = new Map<number, WindowContext>();
  private readonly pools = new Map<string, BackendPool>();

  private readonly configStore: OperatorConfigStore;
  private readonly clientFactory: SliverClientFactory;
  private readonly now: () => number;
  private nextEpoch = 1;

  constructor(options: string | ConnectionRegistryOptions = {}) {
    const normalized = typeof options === "string" ? { savedConfigDirectory: options } : options;
    const externalDirectory = normalized.savedConfigDirectory ?? join(homedir(), ".sliver-client", "configs");
    const managedDirectory = normalized.managedConfigDirectory ?? join(homedir(), ".sliver-gui", "configs");
    this.configStore = new OperatorConfigStore(externalDirectory, managedDirectory);
    this.clientFactory = normalized.clientFactory ?? ((config) => new SliverClient(config));
    this.now = normalized.now ?? Date.now;
  }

  registerWindow(contentsId: number): void {
    this.windows.set(contentsId, {
      snapshot: disconnectedSnapshot(),
      certificatePairs: new Map(),
      certificateTimers: new Map(),
      savedConfigs: new Map(),
      connectionAttempt: 0,
      stopPlans: new Map(),
    });
  }

  async unregisterWindow(contentsId: number): Promise<void> {
    const context = this.windows.get(contentsId);
    this.windows.delete(contentsId);
    if (context) {
      context.connectionAttempt += 1;
      clearCertificateCapabilities(context);
      context.stopPlans.clear();
    }
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
    if (source.configName) target.configName = source.configName;
    else delete target.configName;
    target.snapshot = this.snapshotForWindow(target, pool.snapshot);
    pool.addWindow(targetContentsId);
    this.pushSnapshot(targetContentsId, target.snapshot);
  }

  snapshot(contentsId: number): SliverSnapshot {
    const context = this.requireWindow(contentsId);
    if (!context.poolKey) return context.snapshot;
    const snapshot = this.pools.get(context.poolKey)?.snapshot;
    return snapshot ? this.snapshotForWindow(context, snapshot) : context.snapshot;
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
        data = await readConfigForImport(filePath);
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

  async importConfig(sender: WebContents, displayName: string): Promise<OperationResult<SavedConfigSummary>> {
    try {
      const owner = requireOwnerWindow(sender);
      const result = await dialog.showOpenDialog(owner, {
        title: "Import Sliver Operator Config",
        properties: ["openFile"],
        filters: [
          { name: "Sliver operator configs", extensions: ["cfg", "json"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      const filePath = result.filePaths[0];
      if (result.canceled || !filePath) return { ok: false, error: "Import canceled" };
      const data = await readConfigForImport(filePath);
      try {
        const imported = await this.configStore.import(data, displayName);
        this.requireWindow(sender.id).savedConfigs.set(imported.summary.id, imported);
        return { ok: true, value: imported.summary };
      } finally {
        data.fill(0);
      }
    } catch {
      return { ok: false, error: "Unable to import the selected Sliver configuration" };
    }
  }

  async listSavedConfigs(contentsId: number): Promise<OperationResult<SavedConfigSummary[]>> {
    const context = this.requireWindow(contentsId);
    try {
      const records = await this.configStore.list();
      if (this.windows.get(contentsId) !== context) throw new Error("Application window changed during refresh");
      context.savedConfigs.clear();
      for (const record of records) context.savedConfigs.set(record.summary.id, record);
      return { ok: true, value: records.map((record) => record.summary) };
    } catch {
      context.savedConfigs.clear();
      return { ok: false, error: "Unable to refresh saved Sliver configurations" };
    }
  }

  async removeSavedConfig(contentsId: number, id: string): Promise<OperationResult> {
    const context = this.requireWindow(contentsId);
    const record = context.savedConfigs.get(id);
    if (!record) return { ok: false, error: "Unknown or stale saved configuration selection" };
    try {
      await this.configStore.remove(record);
      context.savedConfigs.delete(id);
      return { ok: true };
    } catch {
      return { ok: false, error: "Unable to remove the selected Sliver configuration" };
    }
  }

  async connectSavedConfig(contentsId: number, id: string): Promise<OperationResult<SliverSnapshot>> {
    const context = this.requireWindow(contentsId);
    const record = typeof id === "string" ? context.savedConfigs.get(id) : undefined;
    if (!record) return { ok: false, error: "Unknown or stale saved configuration selection" };
    const deferredReason = deferredWireGuardResult(record.summary);
    if (deferredReason) return { ok: false, error: deferredReason };

    let data: Buffer;
    try {
      data = await readCurrentSavedConfig(record);
    } catch {
      context.savedConfigs.delete(id);
      return { ok: false, error: "Saved configuration changed or is no longer available; refresh the list" };
    }
    try {
      return await this.connectConfig(contentsId, data, record.summary.displayName);
    } finally {
      data.fill(0);
    }
  }

  async disconnect(contentsId: number): Promise<OperationResult<SliverSnapshot>> {
    const context = this.requireWindow(contentsId);
    context.connectionAttempt += 1;
    const poolKey = context.poolKey;
    delete context.poolKey;
    delete context.configName;
    clearCertificateCapabilities(context);
    context.stopPlans.clear();
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
      return this.snapshot(contentsId);
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

      let certData: Buffer | undefined;
      let keyData: Buffer | undefined;
      try {
        certData = (await readBoundedRegularFile(certificatePath, {
          label: "Selected certificate",
          maxBytes: MAX_CERTIFICATE_BYTES,
        })).data;
        keyData = (await readBoundedRegularFile(keyPath, {
          label: "Selected private key",
          maxBytes: MAX_KEY_BYTES,
          requirePrivateMode: true,
        })).data;
        createSecureContext({ cert: certData, key: keyData });
        const token = randomUUID();
        const context = this.requireWindow(contentsId);
        context.certificatePairs.set(token, {
          cert: certData,
          key: keyData,
          expiresAt: this.now() + CERTIFICATE_CAPABILITY_TTL_MS,
        });
        const expiryTimer = setTimeout(() => {
          const current = this.windows.get(contentsId)?.certificatePairs.get(token);
          if (!current || current.expiresAt > this.now()) return;
          clearCertificatePair(current);
          this.windows.get(contentsId)?.certificatePairs.delete(token);
          this.windows.get(contentsId)?.certificateTimers.delete(token);
        }, CERTIFICATE_CAPABILITY_TTL_MS);
        expiryTimer.unref();
        context.certificateTimers.set(token, expiryTimer);
        return {
          ok: true,
          value: {
            token,
            certificateName: sanitizeSavedConfigMetadata(basename(certificatePath)),
            keyName: sanitizeSavedConfigMetadata(basename(keyPath)),
          },
        };
      } catch (error) {
        certData?.fill(0);
        keyData?.fill(0);
        throw error;
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async startListener(contentsId: number, input: ListenerInput): Promise<OperationResult<JobSummary>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      validateListener(input);
      let jobId: number;

      switch (input.kind) {
        case "mtls": {
          assertBinding();
          const response = await pool.client.startMTLSListener(input.host.trim(), input.port);
          jobId = response.JobID;
          break;
        }
        case "wireguard": {
          assertBinding();
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
          assertBinding();
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
          assertBinding();
          jobId = await this.startHttpListener(contentsId, pool, input);
          break;
        }
        case "stage": {
          assertBinding();
          jobId = await this.startStageListener(pool, input);
          break;
        }
        default: {
          return assertNever(input);
        }
      }

      assertBinding();
      await pool.refreshDomains(["jobs"]);
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

  async prepareStopJob(contentsId: number, jobId: number): Promise<OperationResult<JobStopPlan>> {
    return this.withPool(contentsId, async (pool) => {
      if (!Number.isSafeInteger(jobId) || jobId < 0) throw new Error("Invalid job ID");
      const job = pool.snapshot.jobs.find((candidate) => candidate.id === jobId);
      if (!job) throw new Error(`Job #${jobId} is no longer active`);
      return this.createStopPlan(contentsId, pool, [job], false);
    });
  }

  async prepareStopAllJobs(contentsId: number): Promise<OperationResult<JobStopPlan>> {
    return this.withPool(contentsId, async (pool) => {
      if (pool.snapshot.domains.jobs.page.truncated) {
        throw new Error(
          "Stop all is unavailable while the active job inventory is truncated; stop jobs individually or reduce the active set",
        );
      }
      const jobs = [...pool.snapshot.jobs];
      if (jobs.length === 0) throw new Error("There are no active jobs to stop");
      return this.createStopPlan(contentsId, pool, jobs, true);
    });
  }

  async executeStopPlan(contentsId: number, token: string): Promise<OperationResult> {
    const context = this.requireWindow(contentsId);
    this.pruneStopPlans(context);
    const plan = context.stopPlans.get(token);
    context.stopPlans.delete(token);
    if (!plan || plan.contentsId !== contentsId || plan.expiresAt <= this.now()) {
      return { ok: false, error: "The job-stop confirmation expired; review the current resources again" };
    }
    return this.withPoolWithoutValue(contentsId, async (pool) => {
      const assertPlanBinding = (): void => {
        if (
          this.windows.get(contentsId) !== context ||
          context.poolKey !== plan.poolKey ||
          this.pools.get(plan.poolKey) !== pool ||
          pool.epoch !== plan.epoch
        ) {
          throw new Error("The backend connection changed; review the current resources again");
        }
      };
      assertPlanBinding();
      await pool.refreshDomains(["jobs"]);
      assertPlanBinding();
      if (plan.stopsAll && pool.snapshot.domains.jobs.page.truncated) {
        throw new Error("The active job inventory is truncated; review the current resources again");
      }
      const current = pool.snapshot.jobs;
      const currentFingerprints = current.map(jobFingerprint).sort();
      const plannedFingerprints = [...plan.fingerprints].sort();
      const currentById = new Map(current.map((job) => [job.id, job]));
      const drifted = plan.jobs.some((job, index) => jobFingerprint(currentById.get(job.id)) !== plan.fingerprints[index]);
      if (drifted || (plan.stopsAll && !sameStrings(currentFingerprints, plannedFingerprints))) {
        throw new Error("The active job set changed; review the current resources again");
      }

      const failures: string[] = [];
      for (const job of plan.jobs) {
        assertPlanBinding();
        try {
          const result = await pool.client.killJob(job.id);
          assertPlanBinding();
          if (!result.Success) failures.push(`#${job.id}`);
        } catch {
          failures.push(`#${job.id}`);
        }
      }
      await pool.refreshDomains(["jobs"]);
      assertPlanBinding();
      if (failures.length > 0) throw new Error(`Failed to stop jobs ${failures.join(", ")}`);
    });
  }

  private createStopPlan(
    contentsId: number,
    pool: BackendPool,
    jobs: JobSummary[],
    stopsAll: boolean,
  ): JobStopPlan {
    const context = this.requireWindow(contentsId);
    this.pruneStopPlans(context);
    const token = randomUUID();
    const expiresAt = this.now() + JOB_STOP_PLAN_TTL_MS;
    const safeJobs = jobs.map((job) => ({ ...job, domains: [...job.domains] }));
    context.stopPlans.set(token, {
      token,
      expiresAt,
      contentsId,
      poolKey: pool.key,
      epoch: pool.epoch,
      jobs: safeJobs,
      fingerprints: safeJobs.map(jobFingerprint),
      stopsAll,
    });
    const connection = pool.snapshot.connection;
    return {
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      impact: {
        backend: {
          server: connection.server ?? "Unknown server",
          operator: connection.operator ?? "Unknown operator",
          configName: context.configName ?? connection.configName ?? "Unknown configuration",
          epoch: pool.epoch,
          sharedWindowCount: pool.windowCount,
        },
        jobs: safeJobs,
        stopsAll,
        warning:
          "These server-owned listeners may be shared with other operators; stopping them can remove active callback paths.",
      },
    };
  }

  private pruneStopPlans(context: WindowContext): void {
    const now = this.now();
    for (const [token, plan] of context.stopPlans) if (plan.expiresAt <= now) context.stopPlans.delete(token);
  }

  async generate(sender: WebContents, input: GenerateInput): Promise<OperationResult<SavedArtifact>> {
    const contentsId = sender.id;
    const owner = requireOwnerWindow(sender);
    return this.withPool(contentsId, async (pool, assertBinding) => {
      pool.assertCompilerTarget(input);
      const needsWireGuardIp = /(^|[\n,])\s*wg:\/\//i.test(input.c2) && !input.wgPeerTunIp.trim();
      const uniqueIp = needsWireGuardIp ? (await pool.client.generateUniqueIP()).IP : "";
      const config = buildImplantConfig(input, uniqueIp);
      assertBinding();
      const response = await pool.client.generateImplant(
        config,
        validateImplantName(input.name),
        GENERATE_TIMEOUT_SECONDS,
      );
      assertBinding();
      const saved = await saveArtifact(owner, response);
      assertBinding();
      await pool.refreshDomains(["builds"]);
      return saved;
    });
  }

  async generateFromProfile(
    sender: WebContents,
    input: GenerateFromProfileInput,
  ): Promise<OperationResult<SavedArtifact>> {
    const contentsId = sender.id;
    const owner = requireOwnerWindow(sender);
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const profile = pool.profile(input.profileName);
      if (!profile.Config) throw new Error(`Profile '${input.profileName}' has no implant configuration`);
      assertBinding();
      const response = await pool.client.generateImplant(
        profile.Config,
        validateImplantName(input.name),
        GENERATE_TIMEOUT_SECONDS,
      );
      assertBinding();
      const saved = await saveArtifact(owner, response);
      assertBinding();
      await pool.refreshDomains(["builds"]);
      return saved;
    });
  }

  async downloadBuild(sender: WebContents, buildName: string): Promise<OperationResult<SavedArtifact>> {
    const contentsId = sender.id;
    const owner = requireOwnerWindow(sender);
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const normalized = requireKnownName(buildName, "Build name");
      if (!pool.hasBuild(normalized)) throw new Error(`Unknown build '${normalized}'`);
      assertBinding();
      const response = await pool.client.regenerateImplant(normalized, GENERATE_TIMEOUT_SECONDS);
      assertBinding();
      return saveArtifact(owner, response);
    });
  }

  async deleteBuild(contentsId: number, buildName: string): Promise<OperationResult> {
    return this.withPoolWithoutValue(contentsId, async (pool, assertBinding) => {
      const normalized = requireKnownName(buildName, "Build name");
      if (!pool.hasBuild(normalized)) throw new Error(`Unknown build '${normalized}'`);
      assertBinding();
      await pool.client.deleteImplantBuild(normalized);
      assertBinding();
      await pool.refreshDomains(["builds"]);
    });
  }

  async setStagedBuilds(contentsId: number, buildNames: string[]): Promise<OperationResult> {
    return this.withPoolWithoutValue(contentsId, async (pool, assertBinding) => {
      const inventory = pool.snapshot.domains.builds;
      if ((inventory.status !== "ready" && inventory.status !== "empty") || inventory.page.truncated) {
        throw new Error("The complete build inventory is not authoritative; refresh it before replacing the staging set");
      }
      const unique = [...new Set(buildNames.map((name) => requireKnownName(name, "Build name")))];
      for (const name of unique) if (!pool.hasBuild(name)) throw new Error(`Unknown build '${name}'`);
      assertBinding();
      await pool.client.stageImplantBuild(unique);
      assertBinding();
      await pool.refreshDomains(["builds"]);
    });
  }

  async saveProfile(contentsId: number, input: SaveProfileInput): Promise<OperationResult<ProfileSummary>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const inventory = pool.snapshot.domains.profiles;
      if ((inventory.status !== "ready" && inventory.status !== "empty") || inventory.page.truncated) {
        throw new Error("The complete profile inventory is not authoritative; refresh it before saving a profile");
      }
      const name = normalizeProfileName(input.profileName);
      const exists = pool.hasProfile(name);
      if (exists && !input.overwrite) throw new Error(`Profile '${name}' already exists; confirm replacement first`);
      if (!exists && input.overwrite) throw new Error(`Profile '${name}' no longer exists; review the profile name again`);
      const needsWireGuardIp = /(^|[\n,])\s*wg:\/\//i.test(input.config.c2) && !input.config.wgPeerTunIp.trim();
      const uniqueIp = needsWireGuardIp ? (await pool.client.generateUniqueIP()).IP : "";
      const config = buildImplantConfig(input.config, uniqueIp);
      assertBinding();
      await pool.client.saveImplantProfile(clientpb.ImplantProfile.create({ ID: "", Name: name, Config: config }));
      assertBinding();
      await pool.refreshDomains(["profiles"]);
      const profile = pool.snapshot.profiles.find((item) => item.name === name);
      if (!profile) throw new Error(`Profile '${name}' was saved but could not be reloaded`);
      return profile;
    });
  }

  async deleteProfile(contentsId: number, profileName: string): Promise<OperationResult> {
    return this.withPoolWithoutValue(contentsId, async (pool, assertBinding) => {
      const normalized = requireKnownName(profileName, "Profile name");
      pool.profile(normalized);
      assertBinding();
      await pool.client.deleteImplantProfile(normalized);
      assertBinding();
      await pool.refreshDomains(["profiles"]);
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
      if (input.certificateToken) throw new Error("Certificate capabilities may only be used by HTTPS listeners");
      return (await pool.client.startHTTPListenerWithOptions(base)).JobID;
    }

    const pairs = this.requireWindow(contentsId).certificatePairs;
    const timers = this.requireWindow(contentsId).certificateTimers;
    const certificate = input.certificateToken ? pairs.get(input.certificateToken) : undefined;
    if (input.certificateToken && (!certificate || certificate.expiresAt <= this.now())) {
      if (certificate) clearCertificatePair(certificate);
      pairs.delete(input.certificateToken);
      const timer = timers.get(input.certificateToken);
      if (timer) clearTimeout(timer);
      timers.delete(input.certificateToken);
      throw new Error("The selected certificate pair is no longer available");
    }
    if (input.certificateToken) {
      pairs.delete(input.certificateToken);
      const timer = timers.get(input.certificateToken);
      if (timer) clearTimeout(timer);
      timers.delete(input.certificateToken);
    }
    try {
      return (
        await pool.client.startHTTPSListenerWithOptions({
          ...base,
          acme: input.acme,
          randomizeJARM: input.randomizeJarm,
          ...(certificate ? { cert: certificate.cert, key: certificate.key } : {}),
        })
      ).JobID;
    } finally {
      if (certificate) clearCertificatePair(certificate);
    }
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
    operation: (pool: BackendPool, assertBinding: () => void) => Promise<T>,
  ): Promise<OperationResultWithValue<T>> {
    try {
      const context = this.requireWindow(contentsId);
      const poolKey = context.poolKey;
      const pool = poolKey ? this.pools.get(poolKey) : undefined;
      const usableStatuses = new Set(["connected", "degraded", "reconnecting"]);
      if (!pool || !usableStatuses.has(pool.snapshot.connection.status)) throw new Error("Connect to a Sliver server first");
      const epoch = pool.epoch;
      const attempt = context.connectionAttempt;
      const assertBinding = (): void => {
        if (
          this.windows.get(contentsId) !== context ||
          context.poolKey !== poolKey ||
          context.connectionAttempt !== attempt ||
          this.pools.get(poolKey!) !== pool ||
          pool.epoch !== epoch
        ) {
          throw new Error("The backend connection changed; retry the operation against the current connection");
        }
      };
      assertBinding();
      const value = await operation(pool, assertBinding);
      assertBinding();
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private async withPoolWithoutValue(
    contentsId: number,
    operation: (pool: BackendPool, assertBinding: () => void) => Promise<void>,
  ): Promise<OperationResult> {
    const result = await this.withPool(contentsId, operation);
    return result.ok ? { ok: true } : result;
  }

  private async connectConfig(
    contentsId: number,
    data: Buffer,
    configName: string,
  ): Promise<OperationResult<SliverSnapshot>> {
    let attempt = 0;
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
      if (config.wg !== undefined) {
        throw new Error("WireGuard operator connections are deferred for this milestone");
      }
      const poolKey = createHash("sha256").update(data).digest("hex");
      const context = this.requireWindow(contentsId);
      attempt = ++context.connectionAttempt;
      context.configName = configName;

      if (context.poolKey && context.poolKey !== poolKey) {
        const previousPoolKey = context.poolKey;
        delete context.poolKey;
        await this.releasePool(previousPoolKey, contentsId);
        clearCertificateCapabilities(context);
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
        const epoch = this.nextEpoch++;
        let createdPool!: BackendPool;
        createdPool = new BackendPool(
          poolKey,
          epoch,
          config,
          this.clientFactory(config),
          (snapshot) => {
            if (this.pools.get(poolKey) === createdPool) this.broadcast(poolKey, epoch, snapshot);
          },
        );
        pool = createdPool;
        this.pools.set(poolKey, pool);
      }

      context.poolKey = poolKey;
      pool.addWindow(contentsId);
      await pool.connect();
      if (
        this.windows.get(contentsId) !== context ||
        context.connectionAttempt !== attempt ||
        context.poolKey !== poolKey ||
        this.pools.get(poolKey) !== pool
      ) {
        // A newer attempt may intentionally share this same pool. Do not drop
        // the Set membership owned by that newer attempt.
        if (context.poolKey !== poolKey || this.pools.get(poolKey) !== pool) pool.removeWindow(contentsId);
        throw new Error("Connection attempt was superseded");
      }
      context.snapshot = this.snapshotForWindow(context, pool.snapshot);
      return { ok: true, value: context.snapshot };
    } catch (error) {
      const message = errorMessage(error);
      const context = this.windows.get(contentsId);
      if (!context || attempt === 0 || context.connectionAttempt !== attempt) return { ok: false, error: message };
      const incompatible = context.poolKey ? this.pools.get(context.poolKey)?.snapshot : undefined;
      if (context.poolKey) {
        const failedPoolKey = context.poolKey;
        delete context.poolKey;
        await this.releasePool(failedPoolKey, contentsId).catch(() => undefined);
      }
      delete context.configName;
      clearCertificateCapabilities(context);
      context.snapshot = incompatible?.connection.status === "incompatible"
        ? { ...incompatible, connection: { ...incompatible.connection, error: message } }
        : disconnectedSnapshot(message);
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

  private broadcast(poolKey: string, epoch: number, snapshot: SliverSnapshot): void {
    for (const [contentsId, context] of this.windows) {
      if (context.poolKey !== poolKey) continue;
      const pool = this.pools.get(poolKey);
      if (!pool || pool.epoch !== epoch) continue;
      context.snapshot = this.snapshotForWindow(context, snapshot);
      this.pushSnapshot(contentsId, context.snapshot);
    }
  }

  private snapshotForWindow(context: WindowContext, snapshot: SliverSnapshot): SliverSnapshot {
    if (!context.configName) return snapshot;
    return {
      ...snapshot,
      connection: {
        ...snapshot.connection,
        configName: context.configName,
      },
    };
  }

  private pushSnapshot(contentsId: number, snapshot: SliverSnapshot): void {
    const contents = webContents.fromId(contentsId);
    if (contents && !contents.isDestroyed()) contents.send(IPC.snapshotChanged, snapshot);
  }
}

type DomainName = "jobs" | "builds" | "profiles" | "compiler";

class BackendPool {
  private readonly windowIds = new Set<number>();
  private readonly subscriptions: Subscription[] = [];
  private readonly profilesByName = new Map<string, clientpb.ImplantProfile>();
  private readonly buildsByName = new Map<string, clientpb.ImplantConfig>();
  private connectPromise: Promise<void> | undefined;
  private readonly refreshPromises = new Map<DomainName, Promise<void>>();
  private readonly refreshReruns = new Set<DomainName>();
  private reconcileTimer?: NodeJS.Timeout;
  private invalidationTimer?: NodeJS.Timeout;
  private readonly pendingInvalidations = new Set<DomainName>();
  private previousEventStatus: SliverEventStreamState["status"] = "stopped";
  private recentEvents: RecentEventSummary[] = [];
  private readonly recentEventDeduplicator = new RecentEventDeduplicator();
  private readonly lifetime = new AbortController();
  private closed = false;
  private compatibility: "supported" | "degraded" | "unsupported" = "supported";

  snapshot: SliverSnapshot;

  constructor(
    readonly key: string,
    readonly epoch: number,
    config: SliverClientConfig,
    readonly client: SliverClientAdapter,
    private readonly onSnapshot: (snapshot: SliverSnapshot) => void,
  ) {
    this.snapshot = {
      ...disconnectedSnapshot(),
      connection: {
        status: "connecting",
        operator: sanitizeSavedConfigMetadata(config.operator),
        server: `${sanitizeSavedConfigMetadata(config.lhost)}:${config.lport}`,
        epoch,
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
    if (["connected", "degraded", "reconnecting"].includes(this.snapshot.connection.status)) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async connectInternal(): Promise<void> {
    await abortable(this.client.connect(), this.lifetime.signal);
    const version = await abortable(this.client.getVersion(), this.lifetime.signal);
    this.assertCurrent();
    const negotiated = negotiateServerVersion(version);
    this.compatibility = negotiated.compatibility;
    const versionText = `${version.Major}.${version.Minor}.${version.Patch}${version.Dirty ? " (dirty)" : ""}`;
    const capabilities = {
      compatibility: negotiated.compatibility,
      baselineCommit: SLIVER_PROTOCOL_BASELINE_COMMIT,
      serverVersion: versionText,
      ...(negotiated.reason ? { reason: negotiated.reason } : {}),
      currentSlice: {
        jobs: negotiated.compatibility !== "unsupported",
        listeners: negotiated.compatibility !== "unsupported",
        generation: negotiated.compatibility !== "unsupported",
        builds: negotiated.compatibility !== "unsupported",
        profiles: negotiated.compatibility !== "unsupported",
        events: negotiated.compatibility !== "unsupported",
      },
    } as const;
    this.snapshot = {
      ...this.snapshot,
      connection: {
        ...this.snapshot.connection,
        status:
          negotiated.compatibility === "unsupported"
            ? "incompatible"
            : negotiated.compatibility === "degraded"
              ? "degraded"
              : "connected",
        version: versionText,
        capabilities,
        ...(negotiated.reason ? { error: negotiated.reason } : {}),
      },
    };
    this.onSnapshot(this.snapshot);
    if (negotiated.compatibility === "unsupported") {
      this.markDomainsUnsupported(negotiated.reason ?? "The connected server is unsupported");
      throw new Error(negotiated.reason ?? `Sliver ${versionText} is incompatible`);
    }
    this.subscribe();
    await this.refreshAll().catch(() => undefined);
    this.assertCurrent();
    this.reconcileTimer = setInterval(
      () => this.runBackgroundRefresh(["jobs", "builds", "profiles", "compiler"]),
      RECONCILE_INTERVAL_MS,
    );
    this.reconcileTimer.unref();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort(new Error("Backend connection closed"));
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.invalidationTimer) clearTimeout(this.invalidationTimer);
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions.length = 0;
    await this.client.disconnect();
  }

  async refreshAll(): Promise<void> {
    return this.refreshDomains(["jobs", "builds", "profiles", "compiler"]);
  }

  async refreshDomains(domains: readonly DomainName[]): Promise<void> {
    this.assertCurrent();
    const unique = [...new Set(domains)];
    const results = await Promise.allSettled(unique.map((domain) => this.refreshDomain(domain)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      this.setHealth("degraded", boundedText(errorMessage(failures[0]!.reason), MAX_SUMMARY_TEXT));
      throw new AggregateError(failures.map((failure) => failure.reason), "One or more Sliver state domains failed to refresh");
    }
    if (this.snapshot.eventStream.status === "retrying") {
      this.setHealth("reconnecting", this.snapshot.eventStream.error);
      return;
    }
    const health = this.settledHealth();
    this.setHealth(health.status, health.error);
  }

  private refreshDomain(domain: DomainName): Promise<void> {
    const existing = this.refreshPromises.get(domain);
    if (existing) return existing;
    const refresh = this.refreshDomainUntilClean(domain).finally(() => {
      if (this.refreshPromises.get(domain) === refresh) this.refreshPromises.delete(domain);
    });
    this.refreshPromises.set(domain, refresh);
    return refresh;
  }

  private async refreshDomainUntilClean(domain: DomainName): Promise<void> {
    while (true) {
      this.refreshReruns.delete(domain);
      try {
        await this.refreshDomainInternal(domain);
      } catch (error) {
        if (!this.refreshReruns.delete(domain)) throw error;
        continue;
      }
      if (!this.refreshReruns.delete(domain)) return;
    }
  }

  private async refreshDomainInternal(domain: DomainName): Promise<void> {
    this.markDomainLoading(domain);
    try {
      switch (domain) {
        case "jobs": {
          const jobs = await abortable(this.client.jobs(), this.lifetime.signal);
          this.assertCurrent();
          this.commitJobs(jobs.map(jobSummary).sort((left, right) => left.id - right.id));
          break;
        }
        case "builds": {
          const builds = await abortable(this.client.implantBuilds(), this.lifetime.signal);
          this.assertCurrent();
          this.buildsByName.clear();
          for (const [name, config] of Object.entries(builds.Configs)) this.buildsByName.set(name, config);
          this.commitBuilds(
            Object.entries(builds.Configs)
              .map(([name, config]) => buildSummary(name, config, builds.staged[name] ?? false))
              .sort((left, right) => left.name.localeCompare(right.name)),
          );
          break;
        }
        case "profiles": {
          const profiles = await abortable(this.client.implantProfiles(), this.lifetime.signal);
          this.assertCurrent();
          this.profilesByName.clear();
          for (const profile of profiles.Profiles) this.profilesByName.set(profile.Name, profile);
          this.commitProfiles(
            profiles.Profiles.map(profileSummary).sort((left, right) => left.name.localeCompare(right.name)),
          );
          break;
        }
        case "compiler": {
          const compiler = await abortable(this.client.getCompiler(), this.lifetime.signal);
          this.assertCurrent();
          this.commitCompiler(compilerTargetSummaries(compiler));
          break;
        }
      }
    } catch (error) {
      if (!this.closed) this.markDomainError(domain, errorMessage(error));
      throw error;
    }
  }

  private markDomainLoading(domain: DomainName): void {
    switch (domain) {
      case "jobs":
        this.replaceDomains({ ...this.snapshot.domains, jobs: loadingDomain(this.snapshot.domains.jobs) });
        break;
      case "builds":
        this.replaceDomains({ ...this.snapshot.domains, builds: loadingDomain(this.snapshot.domains.builds) });
        break;
      case "profiles":
        this.replaceDomains({ ...this.snapshot.domains, profiles: loadingDomain(this.snapshot.domains.profiles) });
        break;
      case "compiler":
        this.replaceDomains({ ...this.snapshot.domains, compiler: loadingDomain(this.snapshot.domains.compiler) });
        break;
    }
  }

  private markDomainError(domain: DomainName, error: string): void {
    const safeError = boundedText(error, MAX_SUMMARY_TEXT);
    switch (domain) {
      case "jobs":
        this.replaceDomains({ ...this.snapshot.domains, jobs: domainWithStatus(this.snapshot.domains.jobs, "error", safeError) });
        break;
      case "builds":
        this.replaceDomains({ ...this.snapshot.domains, builds: domainWithStatus(this.snapshot.domains.builds, "error", safeError) });
        break;
      case "profiles":
        this.replaceDomains({ ...this.snapshot.domains, profiles: domainWithStatus(this.snapshot.domains.profiles, "error", safeError) });
        break;
      case "compiler":
        this.replaceDomains({ ...this.snapshot.domains, compiler: domainWithStatus(this.snapshot.domains.compiler, "error", safeError) });
        break;
    }
  }

  private commitJobs(items: JobSummary[]): void {
    this.replaceDomains({ ...this.snapshot.domains, jobs: committedDomain(this.snapshot.domains.jobs, items) });
  }

  private commitBuilds(items: BuildSummary[]): void {
    this.replaceDomains({ ...this.snapshot.domains, builds: committedDomain(this.snapshot.domains.builds, items) });
  }

  private commitProfiles(items: ProfileSummary[]): void {
    this.replaceDomains({ ...this.snapshot.domains, profiles: committedDomain(this.snapshot.domains.profiles, items) });
  }

  private commitCompiler(items: CompilerTargetSummary[]): void {
    this.replaceDomains({ ...this.snapshot.domains, compiler: committedDomain(this.snapshot.domains.compiler, items) });
  }

  private markDomainsUnsupported(error: string): void {
    const safeError = boundedText(error, MAX_SUMMARY_TEXT);
    this.replaceDomains({
      jobs: domainWithStatus(this.snapshot.domains.jobs, "unsupported", safeError),
      builds: domainWithStatus(this.snapshot.domains.builds, "unsupported", safeError),
      profiles: domainWithStatus(this.snapshot.domains.profiles, "unsupported", safeError),
      compiler: domainWithStatus(this.snapshot.domains.compiler, "unsupported", safeError),
    });
  }

  private replaceDomains(domains: SliverSnapshot["domains"]): void {
    this.snapshot = {
      ...this.snapshot,
      domains,
      jobs: domains.jobs.items,
      builds: domains.builds.items,
      profiles: domains.profiles.items,
      compilerTargets: domains.compiler.items,
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

  hasProfile(name: string): boolean {
    return this.profilesByName.has(name);
  }

  hasBuild(name: string): boolean {
    return this.buildsByName.has(name);
  }

  assertCompilerTarget(input: GenerateInput): void {
    if (this.snapshot.domains.compiler.status !== "ready") {
      throw new Error("Compiler targets are not currently authoritative; refresh the compiler inventory before generating");
    }
    const os = input.os.trim().toLowerCase();
    const arch = input.arch.trim().toLowerCase();
    const match = this.snapshot.compilerTargets.find(
      (target) => target.os === os && target.arch === arch && target.format === input.format,
    );
    if (!match?.supported) throw new Error(`The server cannot build ${input.format} for ${os}/${arch}`);
  }

  private subscribe(): void {
    this.subscriptions.push(
      this.client.event$.subscribe({
        next: (event) => {
          if (this.recentEventDeduplicator.shouldRecord(event)) {
            this.recentEvents = [summarizeEvent(event), ...this.recentEvents].slice(0, MAX_RECENT_EVENTS);
            this.snapshot = { ...this.snapshot, recentEvents: this.recentEvents };
            this.onSnapshot(this.snapshot);
          }
          const domains = invalidatedDomainsForEvent(event.EventType);
          if (domains.length > 0) this.scheduleInvalidation(domains);
        },
        error: (error: unknown) => this.markEventStreamFailure(error),
      }),
      this.client.eventStreamState$.subscribe({
        next: (state) => {
          const recovered = this.previousEventStatus === "retrying" && state.status === "connected";
          const wasOnline = ["connected", "degraded", "reconnecting"].includes(this.snapshot.connection.status);
          this.previousEventStatus = state.status;
          const eventStream = {
            status: state.status,
            attempt: state.attempt,
            ...(state.error ? { error: errorMessage(new Error(state.error)) } : {}),
          };
          let connectionStatus = this.snapshot.connection.status;
          if (state.status === "retrying") connectionStatus = "reconnecting";
          else if (state.status === "stopped" && wasOnline) connectionStatus = "degraded";
          this.snapshot = {
            ...this.snapshot,
            eventStream,
            connection: { ...this.snapshot.connection, status: connectionStatus },
          };
          this.onSnapshot(this.snapshot);
          if (recovered) this.scheduleInvalidation(["jobs", "builds", "profiles", "compiler"], 0);
        },
        error: (error: unknown) => this.markEventStreamFailure(error),
      }),
    );
  }

  private scheduleInvalidation(domains: readonly DomainName[], delayMs = 100): void {
    for (const domain of domains) {
      this.pendingInvalidations.add(domain);
      if (this.refreshPromises.has(domain)) this.refreshReruns.add(domain);
    }
    if (this.invalidationTimer) clearTimeout(this.invalidationTimer);
    this.invalidationTimer = setTimeout(() => {
      const pending = [...this.pendingInvalidations];
      this.pendingInvalidations.clear();
      this.runBackgroundRefresh(pending);
    }, delayMs);
    this.invalidationTimer.unref();
  }

  private runBackgroundRefresh(domains: readonly DomainName[]): void {
    void this.refreshDomains(domains).catch(() => undefined);
  }

  private markEventStreamFailure(error: unknown): void {
    const safeError = errorMessage(error);
    this.snapshot = {
      ...this.snapshot,
      eventStream: {
        ...this.snapshot.eventStream,
        status: "stopped",
        error: safeError,
      },
    };
    this.setHealth("degraded", safeError);
  }

  private setHealth(status: "connected" | "degraded" | "reconnecting", error?: string): void {
    if (this.closed || this.snapshot.connection.status === "incompatible") return;
    const connection = { ...this.snapshot.connection, status };
    if (error) connection.error = error;
    else delete connection.error;
    this.snapshot = {
      ...this.snapshot,
      connection,
    };
    this.onSnapshot(this.snapshot);
  }

  private settledHealth(): { status: "connected" | "degraded"; error?: string } {
    if (this.snapshot.eventStream.status === "stopped") {
      return {
        status: "degraded",
        error: this.snapshot.eventStream.error ?? "The server event stream is stopped",
      };
    }
    const failedDomain = Object.values(this.snapshot.domains).find((domain) => Boolean(domain.error));
    if (failedDomain) {
      return {
        status: "degraded",
        error: failedDomain.error ?? "One or more Sliver state domains failed to refresh",
      };
    }
    if (this.compatibility === "degraded") {
      return {
        status: "degraded",
        ...(this.snapshot.connection.capabilities?.reason
          ? { error: this.snapshot.connection.capabilities.reason }
          : {}),
      };
    }
    return { status: "connected" };
  }

  private assertCurrent(): void {
    if (this.closed || this.lifetime.signal.aborted) throw new Error("Stale backend connection epoch");
  }
}

function jobSummary(job: clientpb.Job): JobSummary {
  return {
    id: job.ID,
    name: boundedText(job.Name, MAX_SUMMARY_TEXT),
    description: boundedText(job.Description, MAX_SUMMARY_TEXT),
    protocol: boundedText(job.Protocol, 64),
    port: job.Port,
    domains: boundedList(job.Domains, MAX_SUMMARY_LIST_ITEMS).map((domain) => boundedText(domain, MAX_SUMMARY_TEXT)),
    profileName: boundedText(job.ProfileName, MAX_SUMMARY_TEXT),
  };
}

function buildSummary(name: string, config: clientpb.ImplantConfig, staged: boolean): BuildSummary {
  return {
    name: boundedText(name, MAX_SUMMARY_TEXT),
    configId: boundedText(config.ID, MAX_SUMMARY_TEXT),
    target: `${boundedText(config.GOOS, 64)}/${boundedText(config.GOARCH, 64)}`,
    format: artifactFormatFromProto(config.Format),
    implantType: config.IsBeacon ? "beacon" : "session",
    c2: boundedList(config.C2, MAX_SUMMARY_LIST_ITEMS).map((endpoint) => endpointSummary(endpoint.URL)),
    staged,
  };
}

function profileSummary(profile: clientpb.ImplantProfile): ProfileSummary {
  const config = profile.Config;
  return {
    id: boundedText(profile.ID, MAX_SUMMARY_TEXT),
    name: boundedText(profile.Name, MAX_SUMMARY_TEXT),
    target: config ? `${boundedText(config.GOOS, 64)}/${boundedText(config.GOARCH, 64)}` : "Unknown",
    format: config ? artifactFormatFromProto(config.Format) : "executable",
    implantType: config?.IsBeacon ? "beacon" : "session",
    c2: config
      ? boundedList(config.C2, MAX_SUMMARY_LIST_ITEMS).map((endpoint) => endpointSummary(endpoint.URL))
      : [],
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
        os: boundedText(target.GOOS.toLowerCase(), 64),
        arch: boundedText(target.GOARCH.toLowerCase(), 64),
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

export function negotiateServerVersion(version: clientpb.Version): {
  compatibility: "supported" | "degraded" | "unsupported";
  reason?: string;
} {
  const versionText = `${version.Major}.${version.Minor}.${version.Patch}`;
  if (
    !Number.isSafeInteger(version.Major) ||
    !Number.isSafeInteger(version.Minor) ||
    !Number.isSafeInteger(version.Patch) ||
    version.Major < 0 ||
    version.Minor < 0 ||
    version.Patch < 0
  ) {
    return { compatibility: "unsupported", reason: "The server reported an invalid version" };
  }
  if (typeof version.Commit === "string" && version.Commit.toLowerCase() === SLIVER_PROTOCOL_BASELINE_COMMIT && !version.Dirty) {
    return { compatibility: "supported" };
  }
  if (version.Major !== 1) {
    return {
      compatibility: "unsupported",
      reason: `Sliver ${versionText} is outside the supported protocol major version`,
    };
  }
  if (version.Minor < 6) {
    return {
      compatibility: "unsupported",
      reason: `Sliver ${versionText} predates the minimum compatible protocol surface`,
    };
  }
  return {
    compatibility: "degraded",
    reason: version.Dirty
      ? `Sliver ${versionText} is a modified build and has not been verified against the pinned baseline`
      : `Sliver ${versionText} does not match the pinned baseline; current features remain available in degraded mode`,
  };
}

function invalidatedDomainsForEvent(eventType: string): DomainName[] {
  switch (eventType.toLowerCase()) {
    case "job-started":
    case "job-stopped":
      return ["jobs"];
    case "build":
    case "build-completed":
    case "external-build":
    case "external-build-completed":
    case "external-acknowledge":
      return ["builds"];
    case "profile":
      return ["profiles"];
    default:
      return [];
  }
}

function domainWithStatus<T>(
  current: DomainCollection<T>,
  status: DomainStatus,
  error?: string,
): DomainCollection<T> {
  const next: DomainCollection<T> = { ...current, status };
  if (error) next.error = error;
  else delete next.error;
  return next;
}

function loadingDomain<T>(current: DomainCollection<T>): DomainCollection<T> {
  return domainWithStatus(current, "loading", current.error);
}

function committedDomain<T>(current: DomainCollection<T>, allItems: T[]): DomainCollection<T> {
  const items = allItems.slice(0, MAX_DOMAIN_ITEMS);
  const total = allItems.length;
  return {
    status: total === 0 ? "empty" : "ready",
    revision: current.revision + 1,
    items,
    page: {
      limit: MAX_DOMAIN_ITEMS,
      total,
      truncated: total > items.length,
      ...(total > items.length ? { nextCursor: String(items.length) } : {}),
    },
    updatedAt: new Date().toISOString(),
  };
}

function endpointSummary(value: string): string {
  const candidate = boundedText(value, 2_048);
  try {
    const parsed = new URL(candidate);
    if (!parsed.protocol) return "[invalid endpoint]";
    const scheme = boundedText(parsed.protocol.toLowerCase(), 32);
    const host = boundedText(parsed.host, MAX_SUMMARY_TEXT);
    return host ? boundedText(`${scheme}//${host}`, MAX_SUMMARY_TEXT) : boundedText(`${scheme}//`, 32);
  } catch {
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(candidate)?.[1];
    return scheme ? `${scheme.toLowerCase()}://[redacted]` : "[invalid endpoint]";
  }
}

function boundedText(value: string, limit: number): string {
  const boundedInput = value.slice(0, Math.max(limit * 4, limit));
  const cleaned = boundedInput
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [...cleaned].slice(0, limit).join("");
}

function boundedList<T>(items: readonly T[], limit: number): T[] {
  return items.slice(0, limit);
}

function jobFingerprint(job: JobSummary | undefined): string {
  if (!job) return "missing";
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: job.id,
        name: job.name,
        description: job.description,
        protocol: job.protocol,
        port: job.port,
        domains: [...job.domains].sort(),
        profileName: job.profileName,
      }),
    )
    .digest("hex");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation canceled"));
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason ?? new Error("Operation canceled"));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

export function summarizeEvent(event: clientpb.Event): RecentEventSummary {
  const type = boundedText(event.EventType.toLowerCase(), 80) || "unknown";
  let message: string;
  switch (type) {
    case "job-started":
    case "job-stopped": {
      const action = type === "job-started" ? "started" : "stopped";
      const job = event.Job ? jobSummary(event.Job) : undefined;
      message = job
        ? `Job #${job.id} ${job.protocol || job.name || "listener"}:${job.port} ${action}`
        : `A server job ${action}`;
      break;
    }
    case "client-joined":
    case "client-left": {
      const action = type === "client-joined" ? "joined" : "left";
      const operator = boundedText(event.Client?.Operator?.Name ?? event.Client?.Name ?? "", MAX_SUMMARY_TEXT);
      message = operator ? `Operator ${operator} ${action}` : `An operator ${action}`;
      break;
    }
    case "session-connected":
    case "session-disconnected":
    case "session-updated": {
      const action = type.slice("session-".length);
      const session = boundedText(event.Session?.Name || event.Session?.ID || "", MAX_SUMMARY_TEXT);
      message = session ? `Session ${session} ${action}` : `A session ${action}`;
      break;
    }
    case "build":
    case "build-completed":
    case "external-build":
    case "external-build-completed":
    case "external-acknowledge":
      message = "Implant build inventory changed";
      break;
    case "profile":
      message = "Implant profile inventory changed";
      break;
    case "website":
      message = "Website inventory changed";
      break;
    case "canary":
      message = "A DNS canary event was reported";
      break;
    case "watchtower":
      message = "A threat-monitor event was reported";
      break;
    case "loot-added":
    case "loot-removed":
      message = "Loot inventory changed";
      break;
    case "beacon-registered":
      message = "A beacon registered";
      break;
    case "beacon-taskresult":
      message = "A beacon task completed";
      break;
    case "server-error":
      message = "The server reported an error";
      break;
    default:
      message = "A server event was received";
      break;
  }
  return {
    id: randomUUID(),
    type,
    at: new Date().toISOString(),
    message: boundedText(message, MAX_SUMMARY_TEXT),
    isError: Boolean(event.Err) || type === "server-error",
  };
}

async function saveArtifact(owner: BrowserWindow, response: clientpb.Generate): Promise<SavedArtifact> {
  const file = response.File;
  if (!file) throw new Error("Server returned no generated file");
  const suggestedFileName = safeArtifactFileName(file.Name || response.ImplantName);
  const implantName = boundedText(response.ImplantName, MAX_SUMMARY_TEXT);
  const buildId = boundedText(response.ImplantBuildID, MAX_SUMMARY_TEXT);
  try {
    if (owner.isDestroyed()) throw new Error("The application window was closed before the artifact could be saved");
    const selection = await dialog.showSaveDialog(owner, {
      title: "Save Generated Artifact",
      defaultPath: suggestedFileName,
    });

    if (selection.canceled || !selection.filePath) {
      return {
        fileName: suggestedFileName,
        size: file.Data.length,
        implantName,
        buildId,
        saved: false,
      };
    }

    await writeFile(selection.filePath, file.Data, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(selection.filePath, 0o700);
    return {
      fileName: safeArtifactFileName(basename(selection.filePath)),
      size: file.Data.length,
      implantName,
      buildId,
      saved: true,
    };
  } finally {
    file.Data.fill(0);
  }
}

function validateListener(input: ListenerInput): void {
  if (!isValidPort(input.port)) throw new Error("Listener port must be between 1 and 65535");
  if (input.host.includes("\0")) throw new Error("Listener host is invalid");
  if (input.kind === "wireguard") {
    if (!isValidPort(input.tcpCommsPort) || !isValidPort(input.keyExchangePort)) {
      throw new Error("WireGuard auxiliary ports must be between 1 and 65535");
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
  const localFileError = localFileSystemErrorMessage(error);
  if (localFileError) return localFileError;
  const message = error instanceof Error ? error.message : "An unexpected operation error occurred";
  return boundedText(
    message
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/giu, "[redacted private key]")
      .replace(/\b(bearer\s+)[^\s,;]+/giu, "$1[redacted]")
      .replace(
        /\b(token|password|secret|private[_ -]?key|authorization)(\s*[:=]\s*)[^\s,;]+/giu,
        "$1$2[redacted]",
      )
      .replace(/\/\/[^/@\s]+@/gu, "//[redacted]@"),
    MAX_SUMMARY_TEXT,
  );
}

function localFileSystemErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const candidate = error as NodeJS.ErrnoException & { path?: unknown; dest?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const fileSystemCodes = new Set([
    "EACCES", "EBUSY", "EEXIST", "EFBIG", "EISDIR", "ELOOP", "EMFILE", "ENAMETOOLONG",
    "ENFILE", "ENOENT", "ENOSPC", "ENOTDIR", "ENOTEMPTY", "EPERM", "EROFS", "EXDEV",
  ]);
  // gRPC errors also expose a `path` containing the RPC method name. Only a
  // native filesystem error code is authoritative enough to classify here.
  if (!fileSystemCodes.has(code)) return undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return "A required local file is no longer available";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return "A local file operation was denied by the operating system";
  }
  if (code === "ENOSPC") return "The selected destination does not have enough free space";
  return "A local file operation failed";
}

function safeArtifactFileName(value: string): string {
  const leaf = basename(value.replaceAll("\\", "/"));
  let safe = boundedText(leaf, 180)
    .replace(/[<>:"/\\|?*]/gu, "_")
    .replace(/[. ]+$/gu, "")
    .trim();
  while (Buffer.byteLength(safe, "utf8") > 180) safe = [...safe].slice(0, -1).join("");
  if (!safe || safe === "." || safe === "..") return "sliver-artifact.bin";
  return safe;
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
  for (const pair of pairs.values()) clearCertificatePair(pair);
  pairs.clear();
}

function clearCertificateCapabilities(context: WindowContext): void {
  for (const timer of context.certificateTimers.values()) clearTimeout(timer);
  context.certificateTimers.clear();
  clearCertificatePairs(context.certificatePairs);
}

function clearCertificatePair(pair: CertificatePair): void {
  pair.cert.fill(0);
  pair.key.fill(0);
}
