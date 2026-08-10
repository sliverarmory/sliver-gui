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
  DEFAULT_TARGET_CATALOG_PAGE_SIZE,
  MAX_TARGET_CATALOG_PAGE_SIZE,
  MAX_TARGET_CATALOG_QUERY_LENGTH,
  TARGET_CAPABILITY_IDS,
  normalizeTargetCatalogQuery,
  targetMatchesCatalogQuery,
  type DestructiveTargetActionId,
  type PrepareTargetActionInput,
  type TargetActionExecutionResult,
  type TargetActionPlan,
  type TargetCatalogEntry,
  type TargetCatalogPage,
  type TargetCatalogPageRequest,
  type TargetMode,
  type TargetRef,
  type TargetSummary,
} from "../shared/target-contracts.js";
import type {
  BeaconTaskDetail,
  BeaconTaskPage,
  BeaconTaskSummary,
  BeaconTasksInvalidationReason,
  OperationPageRequest,
  TargetOperationInput,
  TargetOperationId,
  TargetOperationPage,
  TargetOperationRecord,
  TargetOperationState,
} from "../shared/operation-contracts.js";
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
import type { SliverClientAdapter, SliverClientFactory } from "./sliver-client-adapter.js";
import {
  BeaconTaskCancellationError,
  BeaconTaskStore,
  type TaskOwnershipResolver,
} from "./beacon-task-store.js";
import {
  isAuthoritativeActiveC2Usable,
  OperationEngine,
  TaskCancellationDispatchError,
  type ResolvedOperationTarget,
} from "./operation-engine.js";
import {
  calculateTargetCapabilities,
  createWindowTargetContext,
  targetCapability,
} from "./target-capabilities.js";
import {
  stableTargetFingerprint,
  TargetStore,
  type RevalidatedTarget,
  type TargetDomainName,
} from "./target-store.js";

interface CertificatePair {
  cert: Buffer;
  key: Buffer;
  expiresAt: number;
}

interface WindowContext {
  contentsId: number;
  poolKey?: string;
  configName?: string;
  snapshot: SliverSnapshot;
  certificatePairs: Map<string, CertificatePair>;
  certificateTimers: Map<string, NodeJS.Timeout>;
  savedConfigs: Map<string, SavedConfigRecord>;
  connectionAttempt: number;
  stopPlans: Map<string, InternalStopPlan>;
  activeTarget?: TargetRef;
  beaconWatch: boolean;
  targetPlans: Map<string, InternalTargetActionPlan>;
  targetPlanAdmissions: Set<string>;
  taskListAdmissions: Set<string>;
  taskDetailAdmissions: Set<string>;
  taskCancelAdmissions: Set<string>;
  targetPageCursors: Map<string, InternalTargetPageCursor>;
  manualRefresh?: ManualRefreshState;
  operationEngine?: OperationEngine;
  operationPoolKey?: string;
  operationReconcileTimer?: NodeJS.Timeout;
  operationReconcileInFlight?: Promise<void>;
  operationReconcilePending?: boolean;
  operationReconcileIncludeOutcomeUnknown?: boolean;
  operationReconcilePendingReason?: BeaconTasksInvalidationReason;
}

interface ManualRefreshState {
  promise: Promise<OperationResult<SliverSnapshot>>;
  waiters: number;
  followupRequested: boolean;
  followupStarted: boolean;
}

const GENERATE_TIMEOUT_SECONDS = 15 * 60;
const MAX_RECENT_EVENTS = 50;
const RECONCILE_INTERVAL_MS = 30_000;
const CERTIFICATE_CAPABILITY_TTL_MS = 5 * 60_000;
const JOB_STOP_PLAN_TTL_MS = 60_000;
const TARGET_ACTION_PLAN_TTL_MS = 60_000;
const MAX_OUTSTANDING_TARGET_ACTION_PLANS = 8;
const MAX_TARGETS_PER_ACTION_PLAN = 100;
const MAX_WINDOW_TASK_LIST_REQUESTS = 4;
const MAX_WINDOW_TASK_DETAIL_REQUESTS = 4;
const MAX_WINDOW_TASK_CANCEL_REQUESTS = 4;
const TARGET_PAGE_CURSOR_TTL_MS = 5 * 60_000;
const MAX_WINDOW_TARGET_PAGE_CURSORS = 8;
const MAX_WINDOW_MANUAL_REFRESH_WAITERS = 4;
const MAX_TARGET_CATALOG_SNAPSHOTS = 32;
const MAX_TARGET_CATALOG_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_CERTIFICATE_BYTES = 1024 * 1024;
const MAX_KEY_BYTES = 1024 * 1024;
const MAX_DOMAIN_ITEMS = 500;
const MAX_SUMMARY_TEXT = 256;
const MAX_SUMMARY_LIST_ITEMS = 32;
const OPERATION_RECONCILE_INTERVAL_MS = 2_000;
const MAX_POOL_TASK_CLAIMS = 1_000;
const MAX_POOL_RECOVERABLE_TASK_CLAIMS = 400;
const POOL_TASK_CLAIM_TTL_MS = 24 * 60 * 60_000;

const TERMINAL_OPERATION_STATES: ReadonlySet<TargetOperationState> = new Set([
  "completed",
  "failed",
  "canceled",
  "partial",
  "outcome-unknown",
  "target-disappeared",
]);

type PoolTaskSignalReason = BeaconTasksInvalidationReason | "connection-interrupted";

interface PoolTaskClaim {
  ownerWindowId: number;
  requestId: string;
  operationId: TargetOperationId;
  beaconId: string;
  claimedAt: number;
  expectedPingNonce?: number;
  recoverable: boolean;
}

export type { SliverClientAdapter, SliverClientFactory } from "./sliver-client-adapter.js";

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

interface InternalTargetActionPlan {
  token: string;
  expiresAt: number;
  contentsId: number;
  poolKey: string;
  epoch: number;
  actionId: DestructiveTargetActionId;
  targets: Array<{ summary: TargetSummary; ref: TargetRef }>;
  totalTargets: number;
}

interface InternalTargetPageCursor {
  contentsId: number;
  poolKey: string;
  backendEpoch: number;
  connectionAttempt: number;
  mode: TargetMode;
  query: string;
  snapshotKey: string;
  total: number;
  offset: number;
  expiresAt: number;
}

interface TargetCatalogSnapshot {
  key: string;
  poolKey: string;
  backendEpoch: number;
  mode: TargetMode;
  query: string;
  sourceRevision: number;
  identities: Array<{ id: string; fingerprint: string }>;
  estimatedBytes: number;
  lastAccessed: number;
}

export class ConnectionRegistry {
  private readonly windows = new Map<number, WindowContext>();
  private readonly pools = new Map<string, BackendPool>();
  private readonly targetCatalogSnapshots = new Map<string, TargetCatalogSnapshot>();
  private targetCatalogSnapshotBytes = 0;

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
      contentsId,
      snapshot: disconnectedSnapshot(),
      certificatePairs: new Map(),
      certificateTimers: new Map(),
      savedConfigs: new Map(),
      connectionAttempt: 0,
      stopPlans: new Map(),
      beaconWatch: false,
      targetPlans: new Map(),
      targetPlanAdmissions: new Set(),
      taskListAdmissions: new Set(),
      taskDetailAdmissions: new Set(),
      taskCancelAdmissions: new Set(),
      targetPageCursors: new Map(),
    });
  }

  async unregisterWindow(contentsId: number): Promise<void> {
    const context = this.windows.get(contentsId);
    this.windows.delete(contentsId);
    if (context) {
      context.connectionAttempt += 1;
      delete context.manualRefresh;
      closeWindowOperationEngine(context);
      clearCertificateCapabilities(context);
      context.stopPlans.clear();
      delete context.activeTarget;
      context.beaconWatch = false;
      context.targetPlans.clear();
      context.targetPageCursors.clear();
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
    this.requireOperationEngine(targetContentsId, target, pool);
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
    delete context.manualRefresh;
    const poolKey = context.poolKey;
    closeWindowOperationEngine(context);
    delete context.poolKey;
    delete context.configName;
    clearCertificateCapabilities(context);
    context.stopPlans.clear();
    delete context.activeTarget;
    context.beaconWatch = false;
    context.targetPlans.clear();
    context.targetPageCursors.clear();
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
    let context: WindowContext;
    try {
      context = this.requireWindow(contentsId);
      const existing = context.manualRefresh;
      if (existing) {
        if (existing.waiters >= MAX_WINDOW_MANUAL_REFRESH_WAITERS) {
          throw new Error("Too many manual refresh callers are already waiting in this window");
        }
        existing.waiters += 1;
        if (!existing.followupStarted) existing.followupRequested = true;
        try {
          return await existing.promise;
        } finally {
          existing.waiters -= 1;
        }
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }

    const state: ManualRefreshState = {
      promise: Promise.resolve({ ok: false, error: "Manual refresh has not started" }),
      waiters: 1,
      followupRequested: false,
      followupStarted: false,
    };
    const run = this.withPool(contentsId, async (pool) => {
      await pool.refreshAll();
      if (state.followupRequested) {
        state.followupStarted = true;
        await pool.refreshAll();
      }
      await this.reconcileWindowOperations(contentsId, "explicit-refresh", true);
      return this.snapshot(contentsId);
    });
    state.promise = run.finally(() => {
      if (context.manualRefresh === state) delete context.manualRefresh;
    });
    context.manualRefresh = state;
    try {
      return await state.promise;
    } finally {
      state.waiters -= 1;
    }
  }

  async listTargets(
    contentsId: number,
    request: TargetCatalogPageRequest,
  ): Promise<OperationResult<TargetCatalogPage>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const context = this.requireWindow(contentsId);
      const limit = request.limit ?? DEFAULT_TARGET_CATALOG_PAGE_SIZE;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TARGET_CATALOG_PAGE_SIZE) {
        throw new Error(`Target catalog page size must be between 1 and ${MAX_TARGET_CATALOG_PAGE_SIZE}`);
      }
      const rawQuery = request.query ?? "";
      if (
        typeof rawQuery !== "string" ||
        rawQuery.length > MAX_TARGET_CATALOG_QUERY_LENGTH ||
        rawQuery.includes("\0")
      ) {
        throw new Error(`Target catalog query must be at most ${MAX_TARGET_CATALOG_QUERY_LENGTH} characters`);
      }
      const query = normalizeTargetCatalogQuery(rawQuery);
      if (query.length > MAX_TARGET_CATALOG_QUERY_LENGTH) {
        throw new Error(`Target catalog query must be at most ${MAX_TARGET_CATALOG_QUERY_LENGTH} characters`);
      }
      let catalogSnapshot: TargetCatalogSnapshot;
      let offset: number;
      if (request.cursor) {
        const continuation = this.consumeTargetPageCursor(context, pool, request.mode, query, request.cursor);
        catalogSnapshot = this.requireTargetCatalogSnapshot(continuation.snapshotKey, pool, request.mode, query);
        offset = continuation.offset;
      } else {
        assertTargetDomainAuthoritative(pool, request.mode);
        catalogSnapshot = this.targetCatalogSnapshot(pool, request.mode, query);
        offset = 0;
      }
      assertBinding();
      const entries = this.targetCatalogEntries(pool, catalogSnapshot, offset, limit);
      const total = catalogSnapshot.identities.length;
      const nextOffset = offset + entries.length;
      const truncated = nextOffset < total;
      const nextCursor = truncated
        ? this.issueTargetPageCursor(context, pool, request.mode, catalogSnapshot.key, total, nextOffset, query)
        : undefined;
      return {
        items: entries,
        page: {
          limit,
          total,
          truncated,
          ...(nextCursor ? { nextCursor } : {}),
        },
      };
    });
  }

  async selectTarget(contentsId: number, target: TargetRef): Promise<OperationResult<SliverSnapshot>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      assertBinding();
      assertTargetDomainAuthoritative(pool, target.mode);
      if (!pool.targetStore.isCurrentTargetRef(target, pool.epoch)) {
        throw new Error("The target selection is stale or no longer available; refresh and select it again");
      }
      const current = pool.targetStore.revalidateTargetRef(target, pool.epoch);
      if (!current) throw new Error("The target is no longer available");
      const context = this.requireWindow(contentsId);
      context.activeTarget = current.ref;
      if (current.target.mode !== "beacon") {
        context.beaconWatch = false;
        pool.setWindowWatch(contentsId, false);
      }
      context.snapshot = this.snapshotForWindow(context, pool.snapshot);
      this.pushSnapshot(contentsId, context.snapshot);
      return context.snapshot;
    });
  }

  async backgroundTarget(contentsId: number): Promise<OperationResult<SliverSnapshot>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      assertBinding();
      const context = this.requireWindow(contentsId);
      delete context.activeTarget;
      context.beaconWatch = false;
      pool.setWindowWatch(contentsId, false);
      context.snapshot = this.snapshotForWindow(context, pool.snapshot);
      this.pushSnapshot(contentsId, context.snapshot);
      return context.snapshot;
    });
  }

  async setBeaconWatch(contentsId: number, enabled: boolean): Promise<OperationResult<SliverSnapshot>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      assertBinding();
      const context = this.requireWindow(contentsId);
      if (!context.activeTarget || context.activeTarget.mode !== "beacon") {
        throw new Error("Select a beacon before changing beacon watch");
      }
      assertTargetDomainAuthoritative(pool, "beacon");
      if (!pool.targetStore.revalidateTargetRef(context.activeTarget, pool.epoch)) {
        throw new Error("The selected beacon is no longer available");
      }
      context.beaconWatch = enabled;
      pool.setWindowWatch(contentsId, enabled);
      context.snapshot = this.snapshotForWindow(context, pool.snapshot);
      this.pushSnapshot(contentsId, context.snapshot);
      return context.snapshot;
    });
  }

  async submitTargetOperation(
    contentsId: number,
    input: TargetOperationInput,
  ): Promise<OperationResult<TargetOperationRecord>> {
    try {
      const context = this.requireWindow(contentsId);
      const poolKey = context.poolKey;
      const pool = poolKey ? this.pools.get(poolKey) : undefined;
      const usableStatuses = new Set(["connected", "degraded", "reconnecting"]);
      if (!pool || !usableStatuses.has(pool.snapshot.connection.status)) {
        throw new Error("Connect to a Sliver server first");
      }
      const epoch = pool.epoch;
      const attempt = context.connectionAttempt;
      const bindingCurrent = (): boolean =>
        this.windows.get(contentsId) === context &&
        context.poolKey === poolKey &&
        context.connectionAttempt === attempt &&
        this.pools.get(poolKey!) === pool &&
        pool.epoch === epoch;
      const engine = this.requireOperationEngine(contentsId, context, pool);
      if (!bindingCurrent()) throw new Error("The backend connection changed before operation submission");
      const operation = await engine.submit(input);
      if (bindingCurrent() && operation.taskId) {
        this.pushBeaconTasksInvalidated(contentsId, operation.target);
        this.ensureOperationReconciliation(contentsId);
      }
      return { ok: true, value: operation };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async listTargetOperations(
    contentsId: number,
    request: OperationPageRequest,
  ): Promise<OperationResult<TargetOperationPage>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const context = this.requireWindow(contentsId);
      const engine = this.requireOperationEngine(contentsId, context, pool);
      assertBinding();
      return engine.list(request);
    });
  }

  async getTargetOperation(
    contentsId: number,
    requestId: string,
  ): Promise<OperationResult<TargetOperationRecord>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const context = this.requireWindow(contentsId);
      const operation = this.requireOperationEngine(contentsId, context, pool).get(requestId);
      assertBinding();
      if (!operation) throw new Error("Unknown operation for this application window");
      return operation;
    });
  }

  async cancelTargetOperation(
    contentsId: number,
    requestId: string,
  ): Promise<OperationResult<TargetOperationRecord>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const context = this.requireWindow(contentsId);
      const engine = this.requireOperationEngine(contentsId, context, pool);
      const operation = await engine.cancel(requestId);
      assertBinding();
      if (operation.taskId) {
        this.pushBeaconTasksInvalidated(contentsId, operation.target);
        this.ensureOperationReconciliation(contentsId);
      }
      return operation;
    });
  }

  async listBeaconTasks(
    contentsId: number,
    request: OperationPageRequest,
  ): Promise<OperationResult<BeaconTaskPage>> {
    let admittedContext: WindowContext | undefined;
    const admissionId = randomUUID();
    try {
      if (!request.cursor) {
        const context = this.requireWindow(contentsId);
        if (context.taskListAdmissions.size >= MAX_WINDOW_TASK_LIST_REQUESTS) {
          throw new Error("Too many beacon task inventories are already being loaded in this window");
        }
        context.taskListAdmissions.add(admissionId);
        admittedContext = context;
      }
      return await this.withPool(contentsId, async (pool, assertBinding) => {
        const { context, target } = this.requireSelectedBeacon(contentsId, pool);
        const selectedTarget = target.ref;
        const assertSelectedTarget = (): void => {
          if (!context.activeTarget || !sameTargetRefIdentity(context.activeTarget, selectedTarget)) {
            throw new Error("The selected beacon changed while its task inventory was loading");
          }
        };
        if (!request.cursor) {
          await pool.beaconTasks.refresh(
            target.target.id,
            localTaskIdsForBeacon(context, target.target.id),
            pool.recoverableTaskIdsForBeacon(target.target.id),
          );
          assertBinding();
          assertSelectedTarget();
        }
        assertSelectedTarget();
        const page = pool.beaconTasks.list(
          target.target.id,
          request,
          this.taskOwnershipResolver(context),
          {
            ownerKey: `${pool.epoch}:${contentsId}`,
            accessKey: `${pool.epoch}:${contentsId}:${context.connectionAttempt}`,
          },
        );
        assertSelectedTarget();
        return page;
      });
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      admittedContext?.taskListAdmissions.delete(admissionId);
    }
  }

  async getBeaconTask(
    contentsId: number,
    taskId: string,
  ): Promise<OperationResult<BeaconTaskDetail>> {
    let context: WindowContext;
    try {
      context = this.requireWindow(contentsId);
      if (context.taskDetailAdmissions.size >= MAX_WINDOW_TASK_DETAIL_REQUESTS) {
        throw new Error("Too many beacon task details are already being fetched in this window");
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
    const admissionId = randomUUID();
    context.taskDetailAdmissions.add(admissionId);
    try {
      return await this.withPool(contentsId, async (pool, assertBinding) => {
        const { context, target } = this.requireSelectedBeacon(contentsId, pool);
        const selectedTarget = target.ref;
        const assertSelectedTarget = (): void => {
          if (!context.activeTarget || !sameTargetRefIdentity(context.activeTarget, selectedTarget)) {
            throw new Error("The selected beacon changed while its task detail was loading");
          }
        };
        await pool.beaconTasks.refresh(
          target.target.id,
          [taskId, ...localTaskIdsForBeacon(context, target.target.id)],
          pool.recoverableTaskIdsForBeacon(target.target.id),
        );
        assertBinding();
        assertSelectedTarget();
        const detail = await pool.beaconTasks.detail(
          target.target.id,
          taskId,
          this.taskOwnershipResolver(context),
        );
        assertBinding();
        assertSelectedTarget();
        await this.reconcileOperationFromTask(this.requireOperationEngine(contentsId, context, pool), detail);
        return detail;
      });
    } finally {
      context.taskDetailAdmissions.delete(admissionId);
    }
  }

  async cancelBeaconTask(
    contentsId: number,
    taskId: string,
  ): Promise<OperationResult<BeaconTaskSummary>> {
    let admittedContext: WindowContext | undefined;
    const admissionId = randomUUID();
    try {
      const windowContext = this.requireWindow(contentsId);
      if (windowContext.taskCancelAdmissions.size >= MAX_WINDOW_TASK_CANCEL_REQUESTS) {
        throw new Error("Too many beacon task cancellations are already in flight in this window");
      }
      windowContext.taskCancelAdmissions.add(admissionId);
      admittedContext = windowContext;
      const poolKey = windowContext.poolKey;
      const pool = poolKey ? this.pools.get(poolKey) : undefined;
      const usableStatuses = new Set(["connected", "degraded", "reconnecting"]);
      if (!pool || !usableStatuses.has(pool.snapshot.connection.status)) {
        throw new Error("Connect to a Sliver server first");
      }
      const epoch = pool.epoch;
      const attempt = windowContext.connectionAttempt;
      const bindingCurrent = (): boolean =>
        this.windows.get(contentsId) === windowContext &&
        windowContext.poolKey === poolKey &&
        windowContext.connectionAttempt === attempt &&
        this.pools.get(poolKey!) === pool &&
        pool.epoch === epoch;
      const poolCurrent = (): boolean => this.pools.get(pool.key) === pool && pool.epoch === epoch;
      const { context, target } = this.requireSelectedBeacon(contentsId, pool);
      const selectedTarget = target.ref;
      const selectionCurrent = (): boolean =>
        Boolean(context.activeTarget && sameTargetRefIdentity(context.activeTarget, selectedTarget));
      const engine = this.requireOperationEngine(contentsId, context, pool);
      const resolveOwnership = this.taskOwnershipResolver(context);
      const cancelCapability = targetCapability(
        calculatePoolTargetCapabilities(pool, target.target),
        "beacon.tasks.cancel",
      );
      if (!cancelCapability.available) {
        throw new Error(cancelCapability.reason?.message ?? "Beacon task cancellation is unavailable");
      }
      await pool.beaconTasks.refresh(
        target.target.id,
        [taskId, ...localTaskIdsForBeacon(context, target.target.id)],
        pool.recoverableTaskIdsForBeacon(target.target.id),
      );
      if (!bindingCurrent() || !selectionCurrent()) {
        throw new Error("The backend or selected beacon changed before task cancellation");
      }
      const preflightTask = pool.beaconTasks.task(target.target.id, taskId, resolveOwnership);
      if (preflightTask.state !== "pending") {
        await this.reconcileOperationFromTask(
          engine,
          await this.verifiedTaskForReconciliation(pool, preflightTask, resolveOwnership),
        );
        if (!bindingCurrent() || !selectionCurrent()) {
          return {
            ok: false,
            error: "The task state was confirmed for the previously selected backend target; refresh the current task inventory",
          };
        }
        return { ok: true, value: preflightTask };
      }
      const cancellationState = preflightTask.cancellation;
      if (!cancellationState.available) {
        throw new Error(cancellationState.reason ?? "This beacon task is not safe to cancel");
      }

      let confirmed: BeaconTaskSummary | undefined;
      try {
        confirmed = await pool.beaconTasks.cancel(target.target.id, taskId, resolveOwnership);
      } catch (error) {
        if (error instanceof BeaconTaskCancellationError && !error.dispatchStarted) throw error;
        // Cancellation is one-shot. A lost response must be reconciled from
        // authoritative task state and must never replay the cancel request.
      }

      if (confirmed) {
        await this.reconcileOperationFromTask(
          engine,
          await this.verifiedTaskForReconciliation(pool, confirmed, resolveOwnership),
        );
      }
      if (poolCurrent()) {
        try {
          await pool.beaconTasks.refresh(
            target.target.id,
            [taskId, ...localTaskIdsForBeacon(context, target.target.id)],
            pool.recoverableTaskIdsForBeacon(target.target.id),
          );
          const refreshed = pool.beaconTasks.task(target.target.id, taskId, resolveOwnership);
          if (refreshed.state !== "pending") {
            confirmed = refreshed;
            await this.reconcileOperationFromTask(
              engine,
              await this.verifiedTaskForReconciliation(pool, refreshed, resolveOwnership),
            );
          }
        } catch {
          // An exact cancel response remains authoritative even if the
          // follow-up inventory refresh is temporarily unavailable.
        }
      }
      if (!confirmed) {
        throw new Error("Task cancellation was dispatched, but its outcome could not be confirmed; refresh the task inventory");
      }
      if (!bindingCurrent() || !selectionCurrent()) {
        return {
          ok: false,
          error: "Task cancellation was confirmed for the previously selected backend target; refresh the current task inventory",
        };
      }
      this.pushBeaconTasksInvalidated(contentsId, target.ref);
      return { ok: true, value: confirmed };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      admittedContext?.taskCancelAdmissions.delete(admissionId);
    }
  }

  private requireOperationEngine(
    contentsId: number,
    context: WindowContext,
    pool: BackendPool,
  ): OperationEngine {
    if (context.operationEngine && context.operationPoolKey === pool.key) return context.operationEngine;
    closeWindowOperationEngine(context);
    const connectionAttempt = context.connectionAttempt;
    let engine: OperationEngine | undefined;
    const assertOperationBinding = (): void => {
      if (
        this.windows.get(contentsId) !== context ||
        context.poolKey !== pool.key ||
        context.operationPoolKey !== pool.key ||
        context.connectionAttempt !== connectionAttempt ||
        context.operationEngine !== engine ||
        this.pools.get(pool.key) !== pool
      ) {
        throw new Error("The backend connection changed; the operation no longer belongs to this window");
      }
    };
    const resolveTargetReference = (target: TargetRef): ResolvedOperationTarget | null => {
      assertOperationBinding();
      assertTargetDomainAuthoritative(pool, target.mode);
      const current = pool.targetStore.revalidateTargetRef(target, pool.epoch);
      if (!current) return null;
      const authoritativeActiveC2 = pool.targetStore.authoritativeActiveC2(target.mode, target.id);
      return {
        ref: current.ref,
        summary: current.target,
        backend: operationBackendSummary(context, pool),
        ...(authoritativeActiveC2
          ? { authoritativeActiveC2 }
          : {}),
      };
    };
    const resolveTarget = (requireActiveIdentity?: TargetRef): ResolvedOperationTarget | null => {
      assertOperationBinding();
      const active = context.activeTarget;
      if (!active) return null;
      if (requireActiveIdentity && !sameTargetRefIdentity(active, requireActiveIdentity)) {
        throw new Error("The selected target changed before the operation was dispatched");
      }
      return resolveTargetReference(requireActiveIdentity ?? active);
    };
    context.operationPoolKey = pool.key;
    engine = new OperationEngine({
      client: pool.client,
      ownerWindowId: contentsId,
      resolveActiveTarget: () => resolveTarget(),
      assertTarget: (target) => {
        const resolved = resolveTarget(target);
        if (!resolved) throw new Error("The selected target is no longer available");
        return resolved;
      },
      resolveJournaledTarget: (target) => {
        const resolved = resolveTargetReference(target);
        if (!resolved) throw new Error("The operation target is no longer available");
        return resolved;
      },
      reserveTaskClaim: (requestId) => pool.reserveTaskClaim(contentsId, requestId),
      releaseTaskClaimReservation: (requestId) =>
        pool.releaseTaskClaimReservation(contentsId, requestId),
      claimTask: (taskId, requestId, operationId, beaconId, expectedPingNonce) =>
        pool.claimTask(contentsId, taskId, requestId, operationId, beaconId, expectedPingNonce),
      settleTaskClaim: (taskId, requestId) => pool.settleTaskClaim(contentsId, taskId, requestId),
      capability: (target, capabilityId) => {
        assertOperationBinding();
        return targetCapability(
          calculatePoolTargetCapabilities(pool, target.summary),
          capabilityId,
        );
      },
      refreshTargets: async () => {
        assertOperationBinding();
        await pool.refreshDomains(["sessions", "beacons"]);
        assertOperationBinding();
      },
      cancelTask: async (target, taskId) => {
        let dispatchStarted = false;
        try {
          assertOperationBinding();
          if (target.mode !== "beacon" || !pool.targetStore.revalidateTargetRef(target, pool.epoch)) {
            throw new Error("The beacon is no longer available for task cancellation");
          }
          await pool.beaconTasks.refresh(
            target.id,
            [taskId, ...localTaskIdsForBeacon(context, target.id)],
            pool.recoverableTaskIdsForBeacon(target.id),
          );
          assertOperationBinding();
          const resolveOwnership = this.taskOwnershipResolver(context);
          const beforeDispatch = pool.beaconTasks.task(target.id, taskId, resolveOwnership);
          if (beforeDispatch.state !== "pending") {
            await this.reconcileOperationFromTask(
              engine!,
              await this.verifiedTaskForReconciliation(pool, beforeDispatch, resolveOwnership),
            );
            this.pushBeaconTasksInvalidated(contentsId, target);
            return;
          }
          try {
            const canceled = await pool.beaconTasks.cancel(target.id, taskId, resolveOwnership);
            dispatchStarted = true;
            await engine!.reconcileTask({ taskId, beaconId: target.id, state: canceled.state });
            try {
              assertOperationBinding();
              this.pushBeaconTasksInvalidated(contentsId, target);
            } catch {
              // Preserve the exact old-backend result without notifying a replacement context.
            }
            return;
          } catch (error) {
            if (error instanceof BeaconTaskCancellationError) {
              dispatchStarted = error.dispatchStarted;
              if (!dispatchStarted) throw error;
            } else if (!dispatchStarted) {
              throw error;
            }
            // A response can be lost after the server commits cancellation.
            // Reconcile once from pinned state and never replay the request.
          }
          await pool.beaconTasks.refresh(
            target.id,
            [taskId, ...localTaskIdsForBeacon(context, target.id)],
            pool.recoverableTaskIdsForBeacon(target.id),
          );
          assertOperationBinding();
          const refreshed = pool.beaconTasks.task(target.id, taskId, resolveOwnership);
          if (refreshed.state === "pending") {
            throw new TaskCancellationDispatchError(
              "The task cancellation outcome could not be confirmed",
              true,
            );
          }
          await this.reconcileOperationFromTask(
            engine!,
            await this.verifiedTaskForReconciliation(pool, refreshed, resolveOwnership),
          );
          this.pushBeaconTasksInvalidated(contentsId, target);
        } catch (error) {
          if (error instanceof TaskCancellationDispatchError) throw error;
          const cancellationDispatchStarted = error instanceof BeaconTaskCancellationError
            ? error.dispatchStarted
            : dispatchStarted;
          throw new TaskCancellationDispatchError(
            error instanceof BeaconTaskCancellationError
              ? error.message
              : cancellationDispatchStarted
              ? "The task cancellation outcome could not be confirmed"
              : "The task could not be revalidated before cancellation",
            cancellationDispatchStarted,
          );
        }
      },
      onChanged: (record) => {
        if (
          this.windows.get(contentsId) !== context ||
          context.operationEngine !== engine ||
          context.operationPoolKey !== pool.key ||
          context.poolKey !== pool.key ||
          this.pools.get(pool.key) !== pool
        ) return;
        this.pushOperationChanged(contentsId, record);
        if (requiresActiveTaskPolling(record)) {
          this.ensureOperationReconciliation(contentsId);
        } else if (TERMINAL_OPERATION_STATES.has(record.state)) {
          this.stopOperationReconciliationIfIdle(context);
        }
      },
      now: this.now,
    });
    context.operationEngine = engine;
    return engine;
  }

  private requireSelectedBeacon(
    contentsId: number,
    pool: BackendPool,
  ): { context: WindowContext; target: RevalidatedTarget } {
    const context = this.requireWindow(contentsId);
    if (!context.activeTarget || context.activeTarget.mode !== "beacon") {
      throw new Error("Select an available beacon before viewing tasks");
    }
    assertTargetDomainAuthoritative(pool, "beacon");
    const target = pool.targetStore.revalidateTargetRef(context.activeTarget, pool.epoch);
    if (!target || target.target.mode !== "beacon") throw new Error("The selected beacon is no longer available");
    const capability = targetCapability(
      calculatePoolTargetCapabilities(pool, target.target),
      "beacon.tasks.read",
    );
    if (!capability.available) throw new Error(capability.reason?.message ?? "Beacon tasks are unavailable");
    return { context, target };
  }

  private taskOwnershipResolver(context: WindowContext): TaskOwnershipResolver {
    const engine = context.operationEngine;
    const pool = context.poolKey ? this.pools.get(context.poolKey) : undefined;
    const ownerWindowId = context.contentsId;
    return (taskId, beaconId) => {
      const operation = engine?.findByTask(taskId, beaconId);
      if (operation) {
        const expectedPingNonce = engine?.expectedPingNonceForTask(taskId, beaconId);
        return {
          ownership: operation.ownership,
          localRequestId: operation.requestId,
          operationId: operation.operationId,
          ...(expectedPingNonce === undefined ? {} : { expectedPingNonce }),
        };
      }
      const claim = pool?.taskClaimForWindow(taskId, beaconId, ownerWindowId);
      if (claim) {
        return {
          ownership: {
            origin: "local",
            ownerWindowId,
            actor: { attribution: "unknown" },
          },
          localRequestId: claim.requestId,
          operationId: claim.operationId,
          ...(claim.expectedPingNonce === undefined
            ? {}
            : { expectedPingNonce: claim.expectedPingNonce }),
        };
      }
      return { ownership: { origin: "unknown", actor: { attribution: "unknown" } } };
    };
  }

  private async reconcileOperationFromTask(
    engine: OperationEngine,
    task: BeaconTaskSummary | BeaconTaskDetail,
  ): Promise<void> {
    if (!engine.findByTask(task.taskId, task.beaconId)) return;
    const taskError = "error" in task ? task.error : undefined;
    const errorKind = "errorKind" in task ? task.errorKind : undefined;
    if (errorKind === "decode-uncertain") {
      engine.markTaskOutcomeUnknown(
        task.taskId,
        task.beaconId,
        "The beacon task completed, but its response could not be verified",
      );
      return;
    }
    await engine.reconcileTask({
      taskId: task.taskId,
      beaconId: task.beaconId,
      state: task.state === "completed" && errorKind === "target-reported" ? "failed" : task.state,
      ...(task.state === "completed" && "disposition" in task && task.disposition
        ? { disposition: task.disposition }
        : {}),
      ...(taskError ? { error: taskError } : {}),
    });
  }

  private async verifiedTaskForReconciliation(
    pool: BackendPool,
    task: BeaconTaskSummary,
    resolveOwnership: TaskOwnershipResolver,
  ): Promise<BeaconTaskSummary | BeaconTaskDetail> {
    return task.state === "completed"
      ? pool.beaconTasks.detail(task.beaconId, task.taskId, resolveOwnership)
      : task;
  }

  private ensureOperationReconciliation(contentsId: number): void {
    const context = this.windows.get(contentsId);
    if (!context?.operationEngine || context.operationReconcileTimer) return;
    context.operationReconcileTimer = setInterval(() => {
      void this.reconcileWindowOperations(contentsId, "explicit-refresh");
    }, OPERATION_RECONCILE_INTERVAL_MS);
    context.operationReconcileTimer.unref();
    void this.reconcileWindowOperations(contentsId, "operation-submitted");
  }

  private async reconcileWindowOperations(
    contentsId: number,
    reason: BeaconTasksInvalidationReason,
    includeOutcomeUnknown = false,
  ): Promise<void> {
    const context = this.windows.get(contentsId);
    if (!context?.operationEngine || !context.poolKey) return;
    if (context.operationReconcileInFlight) {
      if (includeOutcomeUnknown || reason === "server-event" || reason === "reconnect") {
        context.operationReconcilePending = true;
        context.operationReconcileIncludeOutcomeUnknown =
          context.operationReconcileIncludeOutcomeUnknown === true || includeOutcomeUnknown;
        context.operationReconcilePendingReason = mergeReconcileReason(
          context.operationReconcilePendingReason,
          reason,
        );
      }
      return context.operationReconcileInFlight;
    }
    const pool = this.pools.get(context.poolKey);
    if (!pool || context.operationPoolKey !== pool.key) return;
    const engine = context.operationEngine;
    const bindingCurrent = (): boolean =>
      this.windows.get(contentsId) === context &&
      context.operationEngine === engine &&
      context.operationPoolKey === pool.key &&
      context.poolKey === pool.key &&
      this.pools.get(pool.key) === pool;
    const reconcileOnce = async (
      currentReason: BeaconTasksInvalidationReason,
      currentIncludeOutcomeUnknown: boolean,
    ): Promise<void> => {
      if (!bindingCurrent()) return;
      engine.expireOverdueTasks();
      const recoverUncertain =
        currentIncludeOutcomeUnknown || currentReason === "server-event" || currentReason === "reconnect";
      const pending = allWindowOperations(engine).filter(
        recoverUncertain
          ? requiresTaskReconciliation
          : requiresActiveTaskPolling,
      );
      const beaconIds = [...new Set([
        ...pending.map((operation) => operation.target.id),
        ...(recoverUncertain && context.activeTarget?.mode === "beacon"
          ? [context.activeTarget.id]
          : []),
      ])];
      for (const beaconId of beaconIds) {
        if (!bindingCurrent()) return;
        try {
          await pool.beaconTasks.refresh(
            beaconId,
            pending.flatMap((operation) => operation.target.id === beaconId && operation.taskId ? [operation.taskId] : []),
            pool.recoverableTaskIdsForBeacon(beaconId),
          );
        } catch {
          continue;
        }
        if (!bindingCurrent()) return;
        for (const operation of pending.filter((candidate) => candidate.target.id === beaconId)) {
          if (!operation.taskId) continue;
          let summary: BeaconTaskSummary;
          try {
            summary = pool.beaconTasks.task(beaconId, operation.taskId, this.taskOwnershipResolver(context));
          } catch {
            continue;
          }
          if (summary.state === "completed") {
            try {
              const detail = await pool.beaconTasks.detail(
                beaconId,
                operation.taskId,
                this.taskOwnershipResolver(context),
              );
              if (!bindingCurrent()) return;
              await this.reconcileOperationFromTask(engine, detail);
            } catch {
              if (!bindingCurrent()) return;
              engine.markTaskOutcomeUnknown(
                operation.taskId,
                operation.target.id,
                "The beacon task completed, but its response could not be fetched and verified",
              );
            }
          } else {
            if (!bindingCurrent()) return;
            await this.reconcileOperationFromTask(engine, summary);
          }
        }
        if (!bindingCurrent()) return;
        const ref = pool.targetStore.createTargetRef("beacon", beaconId, pool.epoch);
        if (ref) this.pushBeaconTasksInvalidated(contentsId, ref);
      }
      this.stopOperationReconciliationIfIdle(context);
    };
    const run = (async () => {
      let currentReason = reason;
      let currentIncludeOutcomeUnknown = includeOutcomeUnknown;
      while (bindingCurrent()) {
        context.operationReconcilePending = false;
        context.operationReconcileIncludeOutcomeUnknown = false;
        delete context.operationReconcilePendingReason;
        await reconcileOnce(currentReason, currentIncludeOutcomeUnknown);
        if (!context.operationReconcilePending || !bindingCurrent()) break;
        currentReason = context.operationReconcilePendingReason ?? "server-event";
        currentIncludeOutcomeUnknown = reconcileIncludesOutcomeUnknown(context);
      }
    })().finally(async () => {
      if (context.operationReconcileInFlight === run) {
        const runFollowup = context.operationReconcilePending === true && bindingCurrent();
        const followupReason = context.operationReconcilePendingReason ?? "server-event";
        const followupIncludeOutcomeUnknown = reconcileIncludesOutcomeUnknown(context);
        delete context.operationReconcileInFlight;
        context.operationReconcilePending = false;
        context.operationReconcileIncludeOutcomeUnknown = false;
        delete context.operationReconcilePendingReason;
        if (runFollowup) {
          await this.reconcileWindowOperations(
            contentsId,
            followupReason,
            followupIncludeOutcomeUnknown,
          );
        }
      }
    });
    context.operationReconcileInFlight = run;
    return run;
  }

  private reconcilePoolOperations(poolKey: string, reason: PoolTaskSignalReason): void {
    for (const [contentsId, context] of this.windows) {
      if (context.poolKey === poolKey && context.operationEngine) {
        if (reason === "connection-interrupted") {
          for (const operation of allWindowOperations(context.operationEngine)) {
            if (requiresTaskReconciliation(operation) && operation.state !== "outcome-unknown") {
              context.operationEngine.markTaskOutcomeUnknown(
                operation.taskId!,
                operation.target.id,
                "The operator connection was interrupted after task submission; awaiting authoritative reconciliation",
              );
            }
          }
        } else {
          void this.reconcileWindowOperations(contentsId, reason);
        }
      }
    }
  }

  private stopOperationReconciliationIfIdle(context: WindowContext): void {
    const engine = context.operationEngine;
    if (!engine || allWindowOperations(engine).some((operation) =>
      requiresActiveTaskPolling(operation)
    )) return;
    if (context.operationReconcileTimer) clearInterval(context.operationReconcileTimer);
    delete context.operationReconcileTimer;
  }

  private pushOperationChanged(contentsId: number, operation: Readonly<TargetOperationRecord>): void {
    const contents = webContents.fromId(contentsId);
    if (contents && !contents.isDestroyed()) contents.send(IPC.operationChanged, structuredClone(operation));
  }

  private pushBeaconTasksInvalidated(contentsId: number, target: TargetRef): void {
    const contents = webContents.fromId(contentsId);
    if (contents && !contents.isDestroyed()) contents.send(IPC.beaconTasksInvalidated, { ...target });
  }

  async prepareTargetAction(
    contentsId: number,
    input: PrepareTargetActionInput,
  ): Promise<OperationResult<TargetActionPlan>> {
    let context: WindowContext;
    try {
      context = this.requireWindow(contentsId);
      this.pruneTargetPlans(context);
      if (context.targetPlans.size + context.targetPlanAdmissions.size >= MAX_OUTSTANDING_TARGET_ACTION_PLANS) {
        throw new Error("Too many target action plans are awaiting review; use or let an existing plan expire");
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
    const admissionId = randomUUID();
    context.targetPlanAdmissions.add(admissionId);
    try {
      return await this.withPool(contentsId, async (pool, assertBinding) => {
      const context = this.requireWindow(contentsId);
      const domains = targetActionDomains(input.actionId, context);
      await pool.refreshDomains(domains);
      assertBinding();
      const candidates = this.targetActionCandidates(context, pool, input.actionId);
      const targets = candidates.targets;
      if (targets.length === 0) throw new Error("No targets currently match this action");
      const token = randomUUID();
      const expiresAt = this.now() + TARGET_ACTION_PLAN_TTL_MS;
      const internal: InternalTargetActionPlan = {
        token,
        expiresAt,
        contentsId,
        poolKey: pool.key,
        epoch: pool.epoch,
        actionId: input.actionId,
        targets,
        totalTargets: candidates.totalTargets,
      };
      this.pruneTargetPlans(context);
      context.targetPlans.set(token, internal);
      return {
        token,
        expiresAt: new Date(expiresAt).toISOString(),
        impact: {
          actionId: input.actionId,
          backend: targetBackendSummary(context, pool),
          targets: targets.map(({ summary }) => ({ ...summary })),
          totalTargets: candidates.totalTargets,
          truncated: candidates.totalTargets > targets.length,
          warning: candidates.totalTargets > targets.length
            ? `${targetActionWarning(input.actionId)} This one-use plan reviews ${targets.length} of ${candidates.totalTargets} matching targets; prepare another plan for the remaining targets.`
            : targetActionWarning(input.actionId),
        },
      };
      });
    } finally {
      context.targetPlanAdmissions.delete(admissionId);
    }
  }

  async executeTargetActionPlan(
    contentsId: number,
    token: string,
  ): Promise<OperationResult<TargetActionExecutionResult>> {
    try {
      const context = this.requireWindow(contentsId);
      const poolKey = context.poolKey;
      const pool = poolKey ? this.pools.get(poolKey) : undefined;
      const usableStatuses = new Set(["connected", "degraded", "reconnecting"]);
      if (!pool || !usableStatuses.has(pool.snapshot.connection.status)) {
        throw new Error("Connect to a Sliver server first");
      }
      const epoch = pool.epoch;
      const attempt = context.connectionAttempt;
      const bindingCurrent = (): boolean =>
        this.windows.get(contentsId) === context &&
        context.poolKey === poolKey &&
        context.connectionAttempt === attempt &&
        this.pools.get(poolKey!) === pool &&
        pool.epoch === epoch;
      const poolCurrent = (): boolean => this.pools.get(pool.key) === pool && pool.epoch === epoch;
      if (!bindingCurrent()) throw new Error("The backend connection changed; review a new action plan");

      this.pruneTargetPlans(context);
      const plan = context.targetPlans.get(token);
      context.targetPlans.delete(token);
      if (!plan) throw new Error("The target action plan expired or was already used");
      if (
        plan.contentsId !== contentsId ||
        plan.poolKey !== pool.key ||
        plan.epoch !== pool.epoch ||
        plan.expiresAt <= this.now()
      ) {
        throw new Error("The target action plan is no longer valid for this backend");
      }

      const domains = targetActionDomains(plan.actionId, context);
      await pool.refreshDomains(domains);
      if (!bindingCurrent()) throw new Error("The backend connection changed; review a new action plan");
      const current = this.targetActionCandidates(context, pool, plan.actionId);
      if (
        plan.totalTargets !== current.totalTargets ||
        !sameTargetPlanResources(plan.targets, current.targets)
      ) {
        throw new Error("The reviewed target set changed; prepare and review a new action plan");
      }

      const outcomes: TargetActionExecutionResult["outcomes"] = [];
      for (const [index, target] of plan.targets.entries()) {
        if (!bindingCurrent()) {
          for (const remaining of plan.targets.slice(index)) {
            outcomes.push({
              requestId: randomUUID(),
              ownerWindowId: contentsId,
              target: { ...remaining.summary },
              status: "skipped",
              error: "The backend connection changed before this action was dispatched",
            });
          }
          break;
        }
        if (isBulkPruneAction(plan.actionId)) {
          try {
            await pool.refreshDomains(domains);
          } catch {
            for (const remaining of plan.targets.slice(index)) {
              outcomes.push({
                requestId: randomUUID(),
                ownerWindowId: contentsId,
                target: { ...remaining.summary },
                status: "skipped",
                error: "The target inventory could not be revalidated immediately before dispatch",
              });
            }
            break;
          }
          if (!bindingCurrent()) {
            for (const remaining of plan.targets.slice(index)) {
              outcomes.push({
                requestId: randomUUID(),
                ownerWindowId: contentsId,
                target: { ...remaining.summary },
                status: "skipped",
                error: "The backend connection changed before this action was dispatched",
              });
            }
            break;
          }
          const revalidated = this.targetActionCandidates(context, pool, plan.actionId).targets
            .find((candidate) => candidate.summary.mode === target.summary.mode && candidate.summary.id === target.summary.id);
          if (!revalidated || !sameTargetPlanResources([target], [revalidated])) {
            outcomes.push({
              requestId: randomUUID(),
              ownerWindowId: contentsId,
              target: { ...target.summary },
              status: "skipped",
              error: "The target changed or is no longer eligible immediately before dispatch",
            });
            continue;
          }
        }
        const requestId = randomUUID();
        try {
          const status = await executeTargetAction(pool.client, plan.actionId, target.summary);
          if (
            status === "succeeded" &&
            target.summary.mode === "beacon" &&
            (plan.actionId === "beacon.remove" || plan.actionId === "beacons.prune-overdue")
          ) {
            pool.beaconTasks.removeBeacon(target.summary.id);
          }
          outcomes.push({ requestId, ownerWindowId: contentsId, target: { ...target.summary }, status });
        } catch {
          outcomes.push({
            requestId,
            ownerWindowId: contentsId,
            target: { ...target.summary },
            status: "outcome-unknown",
            error: "The action was dispatched, but its outcome could not be confirmed",
          });
        }
      }
      const reconciled = poolCurrent()
        ? await pool.refreshDomains(domains).then(() => poolCurrent(), () => false)
        : false;
      if (reconciled) {
        for (const outcome of outcomes) {
          if (outcome.status !== "outcome-unknown" || !targetActionRemovesResource(plan.actionId, outcome.target)) {
            continue;
          }
          const mode = outcome.target.mode;
          if (targetDomainAbsenceAuthoritative(pool, mode) && !pool.targetStore.target(mode, outcome.target.id)) {
            outcome.status = "succeeded";
            delete outcome.error;
            if (mode === "beacon") pool.beaconTasks.removeBeacon(outcome.target.id);
          }
        }
      }
      return { ok: true, value: {
        actionId: plan.actionId,
        outcomes,
        partial: outcomes.some((outcome) => outcome.status !== "succeeded") &&
          outcomes.some((outcome) => outcome.status === "succeeded"),
      } };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private targetActionCandidates(
    context: WindowContext,
    pool: BackendPool,
    actionId: DestructiveTargetActionId,
  ): { targets: Array<{ summary: TargetSummary; ref: TargetRef }>; totalTargets: number } {
    if (actionId === "sessions.prune-dead" || actionId === "beacons.prune-overdue") {
      const mode = actionId === "sessions.prune-dead" ? "session" : "beacon";
      const domain = mode === "session" ? pool.snapshot.domains.sessions : pool.snapshot.domains.beacons;
      if (domain.status !== "ready" && domain.status !== "empty") {
        throw new Error("The complete target inventory is not authoritative; refresh it before pruning");
      }
      const candidates = pool.targetStore.catalogPage(mode, 0, Number.MAX_SAFE_INTEGER).items.filter((target) =>
        target.mode === "session" ? target.liveness === "dead" : target.checkinStatus === "overdue",
      );
      const targets = candidates.slice(0, MAX_TARGETS_PER_ACTION_PLAN).map((summary) => {
        const ref = pool.targetStore.createTargetRef(summary.mode, summary.id, pool.epoch);
        if (!ref) throw new Error("A target changed while preparing the action plan");
        return { summary: { ...summary }, ref };
      });
      return { targets, totalTargets: candidates.length };
    }

    if (!context.activeTarget) throw new Error("Select a target before preparing this action");
    assertTargetDomainAuthoritative(pool, context.activeTarget.mode);
    const current = pool.targetStore.revalidateTargetRef(context.activeTarget, pool.epoch);
    if (!current) throw new Error("The selected target is no longer available");
    if (actionId === "session.close" && current.target.mode !== "session") {
      throw new Error("Close is available only for sessions");
    }
    if (actionId === "beacon.remove" && current.target.mode !== "beacon") {
      throw new Error("Remove is available only for beacons");
    }
    const capabilityId = actionId === "target.kill"
      ? "target.terminate"
      : actionId === "session.close"
        ? "session.close"
        : "beacon.remove";
    const capability = targetCapability(
      calculatePoolTargetCapabilities(pool, current.target),
      capabilityId,
    );
    if (!capability.available) {
      throw new Error(capability.reason?.message ?? "The selected target action is unavailable");
    }
    return { targets: [{ summary: current.target, ref: current.ref }], totalTargets: 1 };
  }

  private pruneTargetPlans(context: WindowContext): void {
    const now = this.now();
    for (const [token, plan] of context.targetPlans) {
      if (plan.expiresAt <= now) context.targetPlans.delete(token);
    }
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
      delete context.manualRefresh;
      context.configName = configName;
      context.targetPageCursors.clear();
      if (context.poolKey) this.pools.get(context.poolKey)?.retireWindowTaskClaims(contentsId);
      closeWindowOperationEngine(context);
      delete context.activeTarget;
      context.beaconWatch = false;
      context.targetPlans.clear();

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
          (reason) => {
            if (this.pools.get(poolKey) === createdPool) this.reconcilePoolOperations(poolKey, reason);
          },
          this.now,
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
      this.requireOperationEngine(contentsId, context, pool);
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

  private issueTargetPageCursor(
    context: WindowContext,
    pool: BackendPool,
    mode: TargetMode,
    snapshotKey: string,
    total: number,
    offset: number,
    query = "",
  ): string {
    const now = this.now();
    for (const [cursor, state] of context.targetPageCursors) {
      if (
        state.expiresAt <= now ||
        state.poolKey !== context.poolKey ||
        state.backendEpoch !== pool.epoch ||
        state.connectionAttempt !== context.connectionAttempt
      ) {
        context.targetPageCursors.delete(cursor);
        continue;
      }
      if (
        state.mode === mode &&
        state.query === query &&
        state.snapshotKey === snapshotKey &&
        state.offset === offset &&
        state.total === total
      ) return cursor;
    }
    while (context.targetPageCursors.size >= MAX_WINDOW_TARGET_PAGE_CURSORS) {
      const oldest = [...context.targetPageCursors]
        .sort((left, right) => left[1].expiresAt - right[1].expiresAt)[0]?.[0];
      if (!oldest) break;
      context.targetPageCursors.delete(oldest);
    }
    const cursor = `target:v1:${randomUUID()}`;
    context.targetPageCursors.set(cursor, {
      contentsId: context.contentsId,
      poolKey: context.poolKey ?? "",
      backendEpoch: pool.epoch,
      connectionAttempt: context.connectionAttempt,
      mode,
      query,
      snapshotKey,
      total,
      offset,
      expiresAt: now + TARGET_PAGE_CURSOR_TTL_MS,
    });
    return cursor;
  }

  private targetCatalogSnapshot(pool: BackendPool, mode: TargetMode, query = ""): TargetCatalogSnapshot {
    const sourceRevision = mode === "session"
      ? pool.snapshot.domains.sessions.revision
      : pool.snapshot.domains.beacons.revision;
    const key = `${pool.key}\0${pool.epoch}\0${mode}\0${sourceRevision}\0${query}`;
    const existing = this.targetCatalogSnapshots.get(key);
    if (existing) {
      existing.lastAccessed = this.now();
      return existing;
    }
    const slice = pool.targetStore.catalogPage(mode, 0, Number.MAX_SAFE_INTEGER, query);
    const identities = slice.items.map((target) => ({
      id: target.id,
      fingerprint: stableTargetFingerprint(target),
    }));
    const estimatedBytes = identities.reduce(
      (total, identity) => total + ((identity.id.length + identity.fingerprint.length) * 2) + 32,
      (query.length * 2) + 64,
    );
    if (estimatedBytes > MAX_TARGET_CATALOG_SNAPSHOT_BYTES) {
      throw new Error("The target inventory is too large for the bounded paging snapshot budget");
    }
    const snapshot: TargetCatalogSnapshot = {
      key,
      poolKey: pool.key,
      backendEpoch: pool.epoch,
      mode,
      query,
      sourceRevision,
      identities,
      estimatedBytes,
      lastAccessed: this.now(),
    };
    this.targetCatalogSnapshots.set(key, snapshot);
    this.targetCatalogSnapshotBytes += estimatedBytes;
    this.pruneTargetCatalogSnapshots(key);
    if (!this.targetCatalogSnapshots.has(key)) {
      throw new Error("The bounded target paging snapshot capacity is busy; finish or let an existing page expire");
    }
    return snapshot;
  }

  private requireTargetCatalogSnapshot(
    key: string,
    pool: BackendPool,
    mode: TargetMode,
    query: string,
  ): TargetCatalogSnapshot {
    const snapshot = this.targetCatalogSnapshots.get(key);
    if (
      !snapshot ||
      snapshot.poolKey !== pool.key ||
      snapshot.backendEpoch !== pool.epoch ||
      snapshot.mode !== mode ||
      snapshot.query !== query
    ) {
      throw new Error("Target catalog page cursor is stale; refresh the inventory");
    }
    snapshot.lastAccessed = this.now();
    return snapshot;
  }

  private targetCatalogEntries(
    pool: BackendPool,
    snapshot: TargetCatalogSnapshot,
    offset: number,
    limit: number,
  ): TargetCatalogEntry[] {
    return snapshot.identities.slice(offset, offset + limit).map((identity) => {
      const target = pool.targetStore.target(snapshot.mode, identity.id);
      if (!target || stableTargetFingerprint(target) !== identity.fingerprint) {
        throw new Error("The target catalog changed identity while this page was being prepared; refresh the inventory");
      }
      if (!targetMatchesCatalogQuery(target, snapshot.query)) {
        throw new Error("The target catalog search changed while this page was being prepared; refresh the inventory");
      }
      const ref = pool.targetStore.createTargetRef(target.mode, target.id, pool.epoch);
      if (!ref) throw new Error("The target catalog changed while this page was being prepared");
      return { target, ref };
    });
  }

  private pruneTargetCatalogSnapshots(protectedKey?: string): void {
    const now = this.now();
    for (const context of this.windows.values()) {
      for (const [cursor, state] of context.targetPageCursors) {
        if (state.expiresAt <= now) context.targetPageCursors.delete(cursor);
      }
    }
    while (
      this.targetCatalogSnapshots.size > MAX_TARGET_CATALOG_SNAPSHOTS ||
      this.targetCatalogSnapshotBytes > MAX_TARGET_CATALOG_SNAPSHOT_BYTES
    ) {
      const referenced = new Set(
        [...this.windows.values()].flatMap((context) =>
          [...context.targetPageCursors.values()].map((state) => state.snapshotKey),
        ),
      );
      let candidate = [...this.targetCatalogSnapshots.values()]
        .filter((snapshot) => snapshot.key !== protectedKey && !referenced.has(snapshot.key))
        .sort((left, right) => left.lastAccessed - right.lastAccessed)[0];
      if (!candidate) {
        candidate = [...this.targetCatalogSnapshots.values()]
          .filter((snapshot) => snapshot.key !== protectedKey)
          .sort((left, right) => left.lastAccessed - right.lastAccessed)[0];
        if (!candidate) break;
        for (const context of this.windows.values()) {
          for (const [cursor, state] of context.targetPageCursors) {
            if (state.snapshotKey === candidate.key) context.targetPageCursors.delete(cursor);
          }
        }
      }
      this.targetCatalogSnapshots.delete(candidate.key);
      this.targetCatalogSnapshotBytes -= candidate.estimatedBytes;
    }
  }

  private consumeTargetPageCursor(
    context: WindowContext,
    pool: BackendPool,
    mode: TargetMode,
    query: string,
    cursor: string,
  ): InternalTargetPageCursor {
    if (!/^target:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(cursor)) {
      throw new Error("Invalid target catalog page cursor");
    }
    const state = context.targetPageCursors.get(cursor);
    context.targetPageCursors.delete(cursor);
    if (
      !state ||
      state.expiresAt <= this.now() ||
      state.contentsId !== context.contentsId ||
      state.poolKey !== context.poolKey ||
      state.backendEpoch !== pool.epoch ||
      state.connectionAttempt !== context.connectionAttempt ||
      state.mode !== mode ||
      state.query !== query
    ) {
      throw new Error("Target catalog page cursor is stale or belongs to another window; refresh the inventory");
    }
    return state;
  }

  private async releasePool(poolKey: string, contentsId: number): Promise<void> {
    const pool = this.pools.get(poolKey);
    if (!pool) return;
    pool.removeWindow(contentsId);
    if (pool.windowCount === 0) {
      this.pools.delete(poolKey);
      for (const [key, snapshot] of this.targetCatalogSnapshots) {
        if (snapshot.poolKey !== poolKey) continue;
        this.targetCatalogSnapshots.delete(key);
        this.targetCatalogSnapshotBytes -= snapshot.estimatedBytes;
      }
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
    const pool = context.poolKey ? this.pools.get(context.poolKey) : undefined;
    if (pool && context.operationEngine) {
      for (const operation of allWindowOperations(context.operationEngine)) {
        if (
          !TERMINAL_OPERATION_STATES.has(operation.state) &&
          targetDomainAbsenceAuthoritative(pool, operation.target.mode) &&
          !pool.targetStore.target(operation.target.mode, operation.target.id)
        ) {
          context.operationEngine.markTargetUnavailable(
            operation.target,
            "The operation target is absent from the complete authoritative inventory",
          );
        }
      }
    }
    const revalidated = context.activeTarget && pool
      ? pool.targetStore.revalidateTargetRef(context.activeTarget, pool.epoch)
      : undefined;
    const activeDomainAuthoritative = context.activeTarget && pool
      ? targetDomainAuthoritative(pool, context.activeTarget.mode)
      : true;
    const activeAbsenceAuthoritative = context.activeTarget && pool
      ? targetDomainAbsenceAuthoritative(pool, context.activeTarget.mode)
      : true;
    const previousSummary = context.activeTarget && context.snapshot.targetContext.activeTargetSummary?.mode === context.activeTarget.mode &&
      context.snapshot.targetContext.activeTargetSummary.id === context.activeTarget.id
      ? context.snapshot.targetContext.activeTargetSummary
      : undefined;
    if (revalidated) context.activeTarget = revalidated.ref;
    else if (context.activeTarget && activeAbsenceAuthoritative) {
      context.operationEngine?.markTargetUnavailable(context.activeTarget);
      context.beaconWatch = false;
      pool?.setWindowWatch(context.contentsId, false);
      delete context.activeTarget;
    }
    const supported = snapshot.connection.capabilities?.currentSlice.targets
      ? TARGET_CAPABILITY_IDS.filter((capability) =>
          snapshot.connection.capabilities?.currentSlice.tasks === true || !capability.startsWith("beacon.tasks."),
        )
      : [];
    const targetContext = createWindowTargetContext({
      activeTarget: context.activeTarget ?? null,
      activeTargetSummary: revalidated?.target ?? (!activeAbsenceAuthoritative ? (previousSummary ?? null) : null),
      authoritative: activeDomainAuthoritative && Boolean(revalidated),
      selectableTargets: pool
        ? [...snapshot.sessions, ...snapshot.beacons]
          .filter((target) => targetDomainAuthoritative(pool, target.mode))
          .flatMap((target) => {
            const ref = pool.targetStore.createTargetRef(target.mode, target.id, pool.epoch);
            return ref ? [ref] : [];
          })
        : [],
      serverSupport: { supported },
      openSessionEndpointAvailable: Boolean(
        pool && revalidated && isPoolOpenSessionEndpointAvailable(pool, revalidated.target),
      ),
      beaconWatch: context.beaconWatch,
      ...(!activeDomainAuthoritative
        ? { unavailableReason: "The selected target inventory is refreshing or unavailable; actions are temporarily disabled." }
        : (!revalidated && !activeAbsenceAuthoritative
            ? { unavailableReason: "The selected target is outside the bounded inventory; its absence is not authoritative." }
            : {})),
    });
    const sessionsPage = { ...snapshot.domains.sessions.page };
    const beaconsPage = { ...snapshot.domains.beacons.page };
    delete sessionsPage.nextCursor;
    delete beaconsPage.nextCursor;
    if (pool && snapshot.domains.sessions.status === "ready" && sessionsPage.truncated) {
      const catalog = this.targetCatalogSnapshot(pool, "session");
      sessionsPage.nextCursor = this.issueTargetPageCursor(
        context,
        pool,
        "session",
        catalog.key,
        catalog.identities.length,
        snapshot.domains.sessions.items.length,
      );
    }
    if (pool && snapshot.domains.beacons.status === "ready" && beaconsPage.truncated) {
      const catalog = this.targetCatalogSnapshot(pool, "beacon");
      beaconsPage.nextCursor = this.issueTargetPageCursor(
        context,
        pool,
        "beacon",
        catalog.key,
        catalog.identities.length,
        snapshot.domains.beacons.items.length,
      );
    }
    return {
      ...snapshot,
      domains: {
        ...snapshot.domains,
        sessions: { ...snapshot.domains.sessions, page: sessionsPage },
        beacons: { ...snapshot.domains.beacons, page: beaconsPage },
      },
      targetContext,
      connection: {
        ...snapshot.connection,
        incarnation: context.connectionAttempt,
        ...(context.configName ? { configName: context.configName } : {}),
      },
    };
  }

  private pushSnapshot(contentsId: number, snapshot: SliverSnapshot): void {
    const contents = webContents.fromId(contentsId);
    if (contents && !contents.isDestroyed()) contents.send(IPC.snapshotChanged, snapshot);
  }
}

type DomainName = "jobs" | "builds" | "profiles" | "compiler" | TargetDomainName;

class BackendPool {
  private readonly windowIds = new Set<number>();
  private readonly watchWindowIds = new Set<number>();
  private readonly subscriptions: Subscription[] = [];
  private readonly profilesByName = new Map<string, clientpb.ImplantProfile>();
  private readonly buildsByName = new Map<string, clientpb.ImplantConfig>();
  private readonly taskClaims = new Map<string, PoolTaskClaim>();
  private readonly taskClaimReservations = new Set<string>();
  private connectPromise: Promise<void> | undefined;
  private readonly refreshPromises = new Map<DomainName, Promise<void>>();
  private readonly refreshReruns = new Set<DomainName>();
  private reconcileTimer?: NodeJS.Timeout;
  private watchTimer?: NodeJS.Timeout;
  private invalidationTimer?: NodeJS.Timeout;
  private readonly pendingInvalidations = new Set<DomainName>();
  private previousEventStatus: SliverEventStreamState["status"] = "stopped";
  private recentEvents: RecentEventSummary[] = [];
  private readonly recentEventDeduplicator = new RecentEventDeduplicator();
  private readonly lifetime = new AbortController();
  private closed = false;
  private compatibility: "supported" | "degraded" | "unsupported" = "supported";
  readonly targetStore: TargetStore;
  readonly beaconTasks: BeaconTaskStore;

  snapshot: SliverSnapshot;

  constructor(
    readonly key: string,
    readonly epoch: number,
    config: SliverClientConfig,
    readonly client: SliverClientAdapter,
    private readonly onSnapshot: (snapshot: SliverSnapshot) => void,
    private readonly onTaskSignal: (reason: PoolTaskSignalReason) => void,
    private readonly now: () => number,
  ) {
    this.targetStore = new TargetStore({ now: this.now });
    this.beaconTasks = new BeaconTaskStore(client);
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
    this.retireWindowTaskClaims(contentsId);
    this.setWindowWatch(contentsId, false);
  }

  retireWindowTaskClaims(contentsId: number): void {
    const reservationPrefix = `${contentsId}:`;
    for (const reservation of this.taskClaimReservations) {
      if (reservation.startsWith(reservationPrefix)) this.taskClaimReservations.delete(reservation);
    }
    for (const claim of this.taskClaims.values()) {
      if (claim.ownerWindowId !== contentsId) continue;
      claim.ownerWindowId = 0;
      claim.recoverable = false;
    }
  }

  setWindowWatch(contentsId: number, enabled: boolean): void {
    if (enabled && this.windowIds.has(contentsId)) this.watchWindowIds.add(contentsId);
    else this.watchWindowIds.delete(contentsId);
    if (this.watchWindowIds.size > 0 && !this.watchTimer) {
      this.watchTimer = setInterval(() => this.runBackgroundRefresh(["beacons"]), 5_000);
      this.watchTimer.unref();
    } else if (this.watchWindowIds.size === 0 && this.watchTimer) {
      clearInterval(this.watchTimer);
      delete this.watchTimer;
    }
  }

  reserveTaskClaim(ownerWindowId: number, requestId: string): boolean {
    if (!this.windowIds.has(ownerWindowId)) return false;
    this.pruneTaskClaims(this.now());
    this.pruneSettledInvisibleTaskClaims();
    const reservation = taskClaimReservationKey(ownerWindowId, requestId);
    if (this.taskClaimReservations.has(reservation)) return true;
    const recoverableClaimCount = [...this.taskClaims.values()].filter(({ recoverable }) => recoverable).length;
    if (
      recoverableClaimCount + this.taskClaimReservations.size >= MAX_POOL_RECOVERABLE_TASK_CLAIMS ||
      this.taskClaims.size + this.taskClaimReservations.size >= MAX_POOL_TASK_CLAIMS
    ) {
      return false;
    }
    this.taskClaimReservations.add(reservation);
    return true;
  }

  releaseTaskClaimReservation(ownerWindowId: number, requestId: string): void {
    this.taskClaimReservations.delete(taskClaimReservationKey(ownerWindowId, requestId));
  }

  claimTask(
    ownerWindowId: number,
    taskId: string,
    requestId: string,
    operationId: TargetOperationId,
    beaconId: string,
    expectedPingNonce?: number,
  ): boolean {
    const now = this.now();
    this.pruneTaskClaims(now);
    const reservation = taskClaimReservationKey(ownerWindowId, requestId);
    if (!this.taskClaimReservations.delete(reservation)) return false;
    const existing = this.taskClaims.get(taskId);
    if (existing) {
      return existing.ownerWindowId === ownerWindowId &&
        existing.requestId === requestId &&
        existing.operationId === operationId &&
        existing.beaconId === beaconId &&
        existing.expectedPingNonce === expectedPingNonce;
    }
    this.pruneSettledInvisibleTaskClaims();
    if (!this.windowIds.has(ownerWindowId) || this.taskClaims.size >= MAX_POOL_TASK_CLAIMS) return false;
    this.taskClaims.set(taskId, {
      ownerWindowId,
      requestId,
      operationId,
      beaconId,
      claimedAt: now,
      ...(expectedPingNonce === undefined ? {} : { expectedPingNonce }),
      recoverable: true,
    });
    return true;
  }

  settleTaskClaim(ownerWindowId: number, taskId: string, requestId: string): void {
    const claim = this.taskClaims.get(taskId);
    if (claim?.ownerWindowId === ownerWindowId && claim.requestId === requestId) claim.recoverable = false;
  }

  taskClaimForWindow(taskId: string, beaconId: string, ownerWindowId: number): PoolTaskClaim | undefined {
    this.pruneTaskClaims(this.now());
    const claim = this.taskClaims.get(taskId);
    return claim?.ownerWindowId === ownerWindowId && claim.beaconId === beaconId
      ? { ...claim }
      : undefined;
  }

  recoverableTaskIdsForBeacon(beaconId: string): string[] {
    this.pruneTaskClaims(this.now());
    return [...this.taskClaims.entries()].flatMap(([taskId, claim]) =>
      claim.recoverable && claim.beaconId === beaconId ? [taskId] : []
    );
  }

  private pruneTaskClaims(now: number): void {
    for (const [claimedTaskId, claim] of this.taskClaims) {
      if (claim.claimedAt + POOL_TASK_CLAIM_TTL_MS <= now) this.taskClaims.delete(claimedTaskId);
    }
  }

  private pruneSettledInvisibleTaskClaims(): void {
    if (this.taskClaims.size + this.taskClaimReservations.size < MAX_POOL_TASK_CLAIMS) return;
    for (const [taskId, claim] of this.taskClaims) {
      if (!claim.recoverable && !this.beaconTasks.containsTask(claim.beaconId, taskId)) {
        this.taskClaims.delete(taskId);
      }
      if (this.taskClaims.size + this.taskClaimReservations.size < MAX_POOL_TASK_CLAIMS) return;
    }
    // A visible, terminal task may outlive this bounded attribution journal.
    // Prefer an honest unknown-origin label for that old history over rejecting
    // a new operation before it can be dispatched. Recoverable claims are
    // never evicted here.
    for (const [taskId, claim] of this.taskClaims) {
      if (!claim.recoverable) this.taskClaims.delete(taskId);
      if (this.taskClaims.size + this.taskClaimReservations.size < MAX_POOL_TASK_CLAIMS) return;
    }
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
        targets: negotiated.compatibility !== "unsupported",
        tasks: negotiated.compatibility !== "unsupported",
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
      () => this.runBackgroundRefresh(["jobs", "builds", "profiles", "compiler", "sessions", "beacons", "operators"]),
      RECONCILE_INTERVAL_MS,
    );
    this.reconcileTimer.unref();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort(new Error("Backend connection closed"));
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.invalidationTimer) clearTimeout(this.invalidationTimer);
    this.taskClaims.clear();
    this.taskClaimReservations.clear();
    this.beaconTasks.clear();
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions.length = 0;
    await this.client.disconnect();
  }

  async refreshAll(): Promise<void> {
    return this.refreshDomains(["jobs", "builds", "profiles", "compiler", "sessions", "beacons", "operators"]);
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
    if (existing) {
      // This caller's authoritative read intent occurred after the in-flight
      // request began, so require one serialized rerun before resolving it.
      this.refreshReruns.add(domain);
      return existing;
    }
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
        case "sessions": {
          const sessions = await abortable(this.client.getSessions(), this.lifetime.signal);
          this.assertCurrent();
          const committed = this.targetStore.replaceSessions(sessions.Sessions);
          this.replaceTargetDomains();
          if (committed.status === "error") throw new Error(committed.error ?? "Unable to normalize sessions inventory");
          break;
        }
        case "beacons": {
          const beacons = await abortable(this.client.getBeacons(), this.lifetime.signal);
          this.assertCurrent();
          const committed = this.targetStore.replaceBeacons(beacons.Beacons);
          this.replaceTargetDomains();
          if (committed.status === "error") throw new Error(committed.error ?? "Unable to normalize beacons inventory");
          this.beaconTasks.pruneAbsentBeacons(this.targetStore.catalogIds("beacon"));
          break;
        }
        case "operators": {
          const operators = await abortable(this.client.getOperators(), this.lifetime.signal);
          this.assertCurrent();
          const committed = this.targetStore.replaceOperators(operators.Operators);
          this.replaceTargetDomains();
          if (committed.status === "error") throw new Error(committed.error ?? "Unable to normalize operator inventory");
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
      case "sessions":
      case "beacons":
      case "operators":
        this.targetStore.markLoading(domain);
        this.replaceTargetDomains();
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
      case "sessions":
      case "beacons":
      case "operators":
        this.targetStore.markError(domain, safeError);
        this.replaceTargetDomains();
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
    const targetDomains = this.targetStore.markUnsupported(safeError);
    this.replaceDomains({
      jobs: domainWithStatus(this.snapshot.domains.jobs, "unsupported", safeError),
      builds: domainWithStatus(this.snapshot.domains.builds, "unsupported", safeError),
      profiles: domainWithStatus(this.snapshot.domains.profiles, "unsupported", safeError),
      compiler: domainWithStatus(this.snapshot.domains.compiler, "unsupported", safeError),
      ...targetDomains,
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
      sessions: domains.sessions.items,
      beacons: domains.beacons.items,
      operators: domains.operators.items,
      recentEvents: this.recentEvents,
      lastUpdated: new Date().toISOString(),
    };
    this.onSnapshot(this.snapshot);
  }

  private replaceTargetDomains(): void {
    this.replaceDomains({ ...this.snapshot.domains, ...this.targetStore.snapshot() });
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
          if (event.EventType.toLowerCase() === "beacon-taskresult") this.onTaskSignal("server-event");
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
          if (state.status === "retrying") this.onTaskSignal("connection-interrupted");
          if (recovered) {
            this.scheduleInvalidation(["jobs", "builds", "profiles", "compiler", "sessions", "beacons", "operators"], 0);
            this.onTaskSignal("reconnect");
          }
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

function closeWindowOperationEngine(context: WindowContext): void {
  if (context.operationReconcileTimer) clearInterval(context.operationReconcileTimer);
  context.operationEngine?.close();
  delete context.operationEngine;
  delete context.operationPoolKey;
  delete context.operationReconcileTimer;
  delete context.operationReconcileInFlight;
  delete context.operationReconcilePending;
  delete context.operationReconcileIncludeOutcomeUnknown;
  delete context.operationReconcilePendingReason;
}

function sameTargetRefIdentity(left: TargetRef, right: TargetRef): boolean {
  return left.mode === right.mode &&
    left.id === right.id &&
    left.backendEpoch === right.backendEpoch &&
    left.fingerprint === right.fingerprint;
}

function supportedTargetCapabilities(pool: BackendPool) {
  if (pool.snapshot.connection.capabilities?.currentSlice.targets !== true) return [];
  return TARGET_CAPABILITY_IDS.filter((capability) =>
    pool.snapshot.connection.capabilities?.currentSlice.tasks === true || !capability.startsWith("beacon.tasks."),
  );
}

function calculatePoolTargetCapabilities(pool: BackendPool, target: TargetSummary) {
  return calculateTargetCapabilities(
    target,
    { supported: supportedTargetCapabilities(pool) },
    { openSessionEndpointAvailable: isPoolOpenSessionEndpointAvailable(pool, target) },
  );
}

function isPoolOpenSessionEndpointAvailable(pool: BackendPool, target: TargetSummary): boolean {
  const authoritativeActiveC2 = pool.targetStore.authoritativeActiveC2(target.mode, target.id);
  return isAuthoritativeActiveC2Usable({
    summary: target,
    ...(authoritativeActiveC2 ? { authoritativeActiveC2 } : {}),
  });
}

function targetDomainAuthoritative(pool: BackendPool, mode: TargetRef["mode"]): boolean {
  const domain = mode === "session" ? pool.snapshot.domains.sessions : pool.snapshot.domains.beacons;
  return domain.status === "ready" || domain.status === "empty";
}

function targetDomainAbsenceAuthoritative(pool: BackendPool, mode: TargetRef["mode"]): boolean {
  // The bounded snapshot is only a projection. TargetStore retains the full
  // normalized domain committed by the authoritative server response, so a
  // target absent from that catalog is absent even when the projection pages.
  return targetDomainAuthoritative(pool, mode);
}

function assertTargetDomainAuthoritative(pool: BackendPool, mode: TargetRef["mode"]): void {
  if (!targetDomainAuthoritative(pool, mode)) {
    throw new Error(`The ${mode} inventory is not authoritative; refresh before acting`);
  }
}

function operationBackendSummary(context: WindowContext, pool: BackendPool) {
  return {
    configId: pool.key,
    configName: context.configName ?? "Current configuration",
    server: pool.snapshot.connection.server ?? "Unknown server",
    operator: pool.snapshot.connection.operator ?? "Unknown operator",
    epoch: pool.epoch,
  };
}

function allWindowOperations(engine: OperationEngine): TargetOperationRecord[] {
  const operations: TargetOperationRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = engine.list({ ...(cursor ? { cursor } : {}), limit: 100 });
    operations.push(...page.items);
    cursor = page.page.nextCursor;
  } while (cursor);
  return operations;
}

function localTaskIdsForBeacon(context: WindowContext, beaconId: string): string[] {
  if (!context.operationEngine) return [];
  return allWindowOperations(context.operationEngine).flatMap((operation) =>
    operation.target.mode === "beacon" && operation.target.id === beaconId && operation.taskId
      ? [operation.taskId]
      : [],
  );
}

function taskClaimReservationKey(ownerWindowId: number, requestId: string): string {
  return `${ownerWindowId}:${requestId}`;
}

function requiresTaskReconciliation(operation: TargetOperationRecord): boolean {
  return Boolean(operation.taskId) && (
    !TERMINAL_OPERATION_STATES.has(operation.state) || operation.state === "outcome-unknown"
  );
}

function requiresActiveTaskPolling(operation: TargetOperationRecord): boolean {
  return Boolean(operation.taskId) && !TERMINAL_OPERATION_STATES.has(operation.state);
}

function mergeReconcileReason(
  current: BeaconTasksInvalidationReason | undefined,
  incoming: BeaconTasksInvalidationReason,
): BeaconTasksInvalidationReason {
  if (current === "reconnect" || incoming === "reconnect") return "reconnect";
  if (current === "server-event" || incoming === "server-event") return "server-event";
  return incoming;
}

function reconcileIncludesOutcomeUnknown(context: WindowContext): boolean {
  return context.operationReconcileIncludeOutcomeUnknown === true;
}

function targetActionDomains(
  actionId: DestructiveTargetActionId,
  context: WindowContext,
): Array<"sessions" | "beacons"> {
  switch (actionId) {
    case "target.kill":
      if (!context.activeTarget) throw new Error("Select a target before preparing this action");
      return [context.activeTarget.mode === "session" ? "sessions" : "beacons"];
    case "session.close":
    case "sessions.prune-dead":
      return ["sessions"];
    case "beacon.remove":
    case "beacons.prune-overdue":
      return ["beacons"];
  }
}

function targetBackendSummary(context: WindowContext, pool: BackendPool) {
  return {
    server: pool.snapshot.connection.server ?? "Unknown server",
    operator: pool.snapshot.connection.operator ?? "Unknown operator",
    configName: context.configName ?? "Current configuration",
    epoch: pool.epoch,
    sharedWindowCount: pool.windowCount,
  };
}

function targetActionWarning(actionId: DestructiveTargetActionId): string {
  switch (actionId) {
    case "target.kill":
      return "For sessions, the server removes the session and submits a kill request but cannot prove the remote process exited. For beacons, Sliver does not return a task ID, so delivery remains outcome unknown.";
    case "session.close":
      return "This closes the interactive connection without killing the remote process.";
    case "beacon.remove":
      return "This deletes the server beacon record and its stored tasks. It does not kill the implant, which may register again.";
    case "sessions.prune-dead":
      return "Only the exact dead sessions listed here will be removed. No server-wide clean command is used.";
    case "beacons.prune-overdue":
      return "Only the exact overdue beacons listed here and their stored tasks will be removed. A still-running implant may register again.";
  }
}

async function executeTargetAction(
  client: SliverClientAdapter,
  actionId: DestructiveTargetActionId,
  target: TargetSummary,
): Promise<"succeeded" | "outcome-unknown"> {
  switch (actionId) {
    case "target.kill":
      if (target.mode === "session") {
        await client.killSession(target.id, false);
        return "succeeded";
      }
      await client.killBeacon(target.id, false);
      return "outcome-unknown";
    case "session.close":
      if (target.mode !== "session") throw new Error("The reviewed target is not a session");
      await client.closeSession(target.id);
      return "succeeded";
    case "beacon.remove":
    case "beacons.prune-overdue":
      if (target.mode !== "beacon") throw new Error("The reviewed target is not a beacon");
      await client.rmBeacon(target.id);
      return "succeeded";
    case "sessions.prune-dead":
      if (target.mode !== "session") throw new Error("The reviewed target is not a session");
      await client.killSession(target.id, false);
      return "succeeded";
  }
}

function targetActionRemovesResource(actionId: DestructiveTargetActionId, target: TargetSummary): boolean {
  switch (actionId) {
    case "target.kill":
      return target.mode === "session";
    case "session.close":
    case "sessions.prune-dead":
      return target.mode === "session";
    case "beacon.remove":
    case "beacons.prune-overdue":
      return target.mode === "beacon";
  }
}

function isBulkPruneAction(actionId: DestructiveTargetActionId): boolean {
  return actionId === "sessions.prune-dead" || actionId === "beacons.prune-overdue";
}

function sameTargetPlanResources(
  expected: readonly { summary: TargetSummary; ref: TargetRef }[],
  current: readonly { summary: TargetSummary; ref: TargetRef }[],
): boolean {
  const identity = (entry: { summary: TargetSummary; ref: TargetRef }) =>
    `${entry.summary.mode}:${entry.summary.id}:${entry.ref.fingerprint}`;
  const left = expected.map(identity).sort();
  const right = current.map(identity).sort();
  return sameStrings(left, right);
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
    case "session-connected":
    case "session-disconnected":
    case "session-updated":
      return ["sessions"];
    case "beacon-registered":
    case "beacon-taskresult":
      return ["beacons"];
    case "client-joined":
    case "client-left":
      return ["operators"];
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
