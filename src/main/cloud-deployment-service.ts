import { createHash, randomBytes, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { BrowserWindow } from "electron";
import type { TokenCredential } from "@azure/identity";
import { SliverClient, parseConfig, type SliverClientConfig } from "sliver-script";
import ssh2 from "ssh2";

import type {
  CloudCredentialIdInput,
  CloudCredentialTestResult,
  CloudDeploymentChangeScope,
  CloudDeploymentSnapshot,
  CloudDeploymentRefreshResult,
  CloudDeploymentRefreshError,
  CloudProvisioningTranscript,
  CloudProvisioningTranscriptSnapshot,
  CreateCloudOperatorConfigInput,
  CurrentEgressIpv4,
  DestroyCloudDeploymentPlan,
  ExecuteDestroyCloudDeploymentInput,
  PrepareDestroyCloudDeploymentInput,
  SshPrivateKeySelection,
} from "../shared/cloud-deployment-ipc.js";
import { parseCreateCloudOperatorConfigInput } from "../shared/cloud-deployment-ipc.js";
import {
  isUuidV4,
  parseCloudDeploymentActionInput,
  parseCreateCloudFirewallRuleInput,
  parseCreateCloudCredentialInput,
  parseAwsConsoleLoginSession,
  parseAzureBrowserLoginSession,
  parseAzureCliAccountSummary,
  parseBeginAzureLoginInput,
  type AzureBrowserLoginSession,
  type BeginAzureLoginInput,
  type AzureLoginSelection,
  type AwsConsoleLoginSession,
  parseCreateCloudDeploymentInput,
  parseDeleteCloudFirewallRuleInput,
  parseListCloudFirewallRulesInput,
  parseRenameCloudDeploymentInput,
  parseUpdateCloudFirewallRuleInput,
  parseUpdateCloudFirewallInput,
  type AwsCloudDeploymentRecord,
  type AwsCliProfileSummary,
  type AwsCredentialSecret,
  type AwsFirewallRule,
  type AwsFirewallRuleSpec,
  type AwsFirewallSnapshot,
  type AwsManagedAssetType,
  type AzureCliAccountSummary,
  type AzureCliCredentialSecret,
  type AzureCloudDeploymentRecord,
  type AzureFirewallRule,
  type AzureFirewallRuleSpec,
  type AzureFirewallSnapshot,
  type AzureManagedAssetType,
  type CloudCredentialSummary,
  type CloudDeploymentActionInput,
  type CloudDeploymentPhase,
  type CloudDeploymentRecord,
  type CloudDeploymentState,
  type CloudFirewallSnapshot,
  type CreateCloudFirewallRuleInput,
  type CreateCloudCredentialInput,
  type CreateCloudDeploymentInput,
  type DeleteCloudFirewallRuleInput,
  type ListCloudFirewallRulesInput,
  type RenameCloudDeploymentInput,
  type UpdateCloudFirewallRuleInput,
  type UpdateCloudFirewallInput,
} from "../shared/cloud-deployment-contracts.js";
import type {
  ManagedListenerFirewallOutcome,
  ManagedServerReference,
  OperationResult,
} from "../shared/contracts.js";
import type { ManagedSshTarget, SshHostKeyReview } from "../shared/ssh-contracts.js";
import type { TerminalRuntimeAsset } from "../shared/stream-contracts.js";
import type { CloudPermissionEvaluation } from "../shared/cloud-provider-permissions.js";
import {
  parseDiscoverAwsOptionsInput,
  type AwsDeploymentOptions,
  type AzureDeploymentOptions,
  type DiscoverAwsOptionsInput,
  parseDiscoverAzureOptionsInput,
  type DiscoverAzureOptionsInput,
} from "../shared/cloud-provider-inventory.js";
import { CloudCredentialVault, type CloudSafeStorageAdapter } from "./cloud-credential-vault.js";
import { CloudDeploymentStore } from "./cloud-deployment-store.js";
import type { ManagedListenerFirewallInput } from "./connection-registry.js";
import { resolveManagedServerFromDeployments } from "./managed-server-resolver.js";
import {
  AwsEc2Provider,
  type AwsEc2CredentialProvider,
  type AwsEc2Credentials,
  type AwsEc2CreateMutationEvent,
  type AwsEc2DestroyResource,
  type AwsEc2DeploymentResource,
  type AwsEc2DiscoveryResult,
  type AwsEc2ProviderConnection,
} from "./cloud/aws-ec2-provider.js";
import { toAwsDeploymentOptions } from "./cloud/aws-inventory.js";
import { detectCurrentEgressIpv4 } from "./cloud/current-egress-ipv4.js";
import { AwsSharedProfileSource } from "./cloud/aws-shared-profiles.js";
import { AwsConsoleLogin, AwsConsoleLoginError } from "./cloud/aws-console-login.js";
import { AzureBrowserLogin, AzureBrowserLoginError } from "./cloud/azure-browser-login.js";
import { AwsEc2PermissionChecker } from "./cloud/aws-permission-checker.js";
import {
  AzureCliAccountSource,
  createAzureCliCredential,
} from "./cloud/azure-cli-accounts.js";
import {
  PrivateKeyCapabilities,
  type ResolvedPrivateKey,
} from "./cloud/private-key-capabilities.js";
import { generateEd25519SshKeyPair } from "./cloud/ssh-key-generator.js";
import {
  AzureVmProvider,
  type AzureVmCreateMutationEvent,
  type AzureVmDeploymentResource,
  type AzureVmDestroyResource,
  type AzureVmDiscoveryResult,
  type AzureVmProviderConnection,
} from "./cloud/azure-vm-provider.js";
import {
  SliverOperatorCreationError,
  SliverProvisionError,
  SliverProvisioner,
  type CreateSliverOperatorInput,
  type ProvisionSliverServerInput,
  type SliverOperatorConfigResult,
  type SliverProvisionOutputEvent,
  type SliverProvisionResult,
} from "./cloud/sliver-provisioner.js";
import type {
  CloudOperatorMutationState,
  GenerateCloudOperatorConfigResult,
} from "./cloud-deployment-ipc.js";
import { loadTerminalRuntime } from "./terminal-runtime.js";
import { readBoundedRegularFile, writePrivateFileExclusiveAtomic } from "./secure-file.js";
import { SshHostKeyStore } from "./ssh-host-key-store.js";
import {
  canonicalSshIdentityBaseName,
  SshIdentityStore,
  type MaterializedSshIdentity,
  type SshIdentityMaterializer,
} from "./ssh-identity-store.js";
import type { StartedManagedSshSession } from "./ssh-session-registry.js";
import {
  SshTerminalRuntime,
  SshTerminalStartError,
  type StartSshTerminalRuntimeOptions,
} from "./ssh-terminal-runtime.js";

const { utils: sshUtils } = ssh2;

const DESTROY_PLAN_TTL_MS = 5 * 60 * 1000;
const MAX_OPERATOR_CONFIG_BYTES = 4 * 1024 * 1024;
const CLOUD_ERROR_MAX_LENGTH = 1_000;
const MAX_PROVISIONING_TRANSCRIPT_BYTES = 256 * 1024;
const MAX_PROVISIONING_TRANSCRIPT_CHUNK_BYTES = 16 * 1024;
const MAX_PROVISIONING_TRANSCRIPT_CHUNKS = 512;
const MAX_PROVISIONING_TRANSCRIPTS = 8;
const PROVISIONING_TRANSCRIPT_EMIT_DELAY_MS = 100;
const SSH_HOST_KEY_REVIEW_TTL_MS = 5 * 60 * 1000;
const DEPLOYMENT_REFRESH_TIMEOUT_MS = 30_000;
const DEPLOYMENT_REFRESH_CONCURRENCY = 4;
const AZURE_PUBLIC_IP_REFRESH_ATTEMPTS = 7;
const AZURE_PUBLIC_IP_REFRESH_DELAY_MS = 5_000;
const SSH_HOST_KEY_STORE_FILE_NAME = "ssh-host-keys.json";
const OPAQUE_SSH_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SSH_HOST_KEY_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const MANAGED_LISTENER_FIREWALL_SOURCE = "0.0.0.0/0";
const MANAGED_LISTENER_AZURE_PRIORITY_MIN = 1_200;
const MANAGED_LISTENER_AZURE_PRIORITY_MAX = 4_096;

export type CloudDeploymentChangedListener = (scope: CloudDeploymentChangeScope) => void;

export interface CloudPrivateKeyCapabilities {
  choose(owner: BrowserWindow): Promise<OperationResult<SshPrivateKeySelection>>;
  consume(token: string, passphrase: string | null): ResolvedPrivateKey;
  dispose(): void;
}

export type CloudSshKeyGenerator = () => Promise<ResolvedPrivateKey>;
export type CloudEgressIpv4Detector = () => Promise<CurrentEgressIpv4>;
export type CloudSshTerminalStarter = (
  options: StartSshTerminalRuntimeOptions,
) => Promise<StartedManagedSshSession["runtime"]>;

export interface CloudSliverProvisioner {
  provision(input: ProvisionSliverServerInput): Promise<SliverProvisionResult>;
  createOperator(input: CreateSliverOperatorInput): Promise<SliverOperatorConfigResult>;
}

export interface CloudAwsProvider {
  preflight(): Promise<{ readonly region: string; readonly availabilityZones: readonly unknown[] }>;
  discover(input?: { readonly vpcId?: string }): Promise<AwsEc2DiscoveryResult>;
  create(
    input: Parameters<AwsEc2Provider["create"]>[0],
    onMutation?: Parameters<AwsEc2Provider["create"]>[1],
  ): Promise<AwsEc2DeploymentResource>;
  refresh(resource: AwsEc2DeploymentResource, signal?: AbortSignal): Promise<AwsEc2DeploymentResource>;
  rename(resource: AwsEc2DeploymentResource, name: string): Promise<void>;
  start(resource: AwsEc2DeploymentResource): Promise<AwsEc2DeploymentResource>;
  stop(resource: AwsEc2DeploymentResource): Promise<AwsEc2DeploymentResource>;
  reboot(resource: AwsEc2DeploymentResource): Promise<AwsEc2DeploymentResource>;
  replaceFirewall(
    resource: AwsEc2DeploymentResource,
    firewall: Parameters<AwsEc2Provider["replaceFirewall"]>[1],
  ): Promise<AwsEc2DeploymentResource>;
  listFirewallRules(resource: AwsEc2DeploymentResource): Promise<AwsFirewallSnapshot>;
  createFirewallRule(
    resource: AwsEc2DeploymentResource,
    rule: AwsFirewallRuleSpec,
  ): Promise<AwsFirewallRule>;
  updateFirewallRule(
    resource: AwsEc2DeploymentResource,
    ruleId: string,
    rule: AwsFirewallRuleSpec,
  ): Promise<AwsFirewallRule>;
  deleteFirewallRule(resource: AwsEc2DeploymentResource, ruleId: string): Promise<void>;
  deleteFirewallRuleIfMatches(
    resource: AwsEc2DeploymentResource,
    ruleId: string,
    expected: AwsFirewallRuleSpec,
  ): Promise<boolean>;
  destroy(resource: AwsEc2DestroyResource): Promise<void>;
}

export interface CloudAzureProvider {
  discover(): Promise<AzureVmDiscoveryResult>;
  checkPermissions(): Promise<CloudPermissionEvaluation>;
  create(
    input: Parameters<AzureVmProvider["create"]>[0],
    onMutation?: Parameters<AzureVmProvider["create"]>[1],
  ): Promise<AzureVmDeploymentResource>;
  refresh(resource: AzureVmDeploymentResource, signal?: AbortSignal): Promise<AzureVmDeploymentResource>;
  rename(resource: AzureVmDeploymentResource, name: string): Promise<void>;
  start(resource: AzureVmDeploymentResource): Promise<AzureVmDeploymentResource>;
  stop(resource: AzureVmDeploymentResource): Promise<AzureVmDeploymentResource>;
  reboot(resource: AzureVmDeploymentResource): Promise<AzureVmDeploymentResource>;
  replaceFirewall(
    resource: AzureVmDeploymentResource,
    firewall: Parameters<AzureVmProvider["replaceFirewall"]>[1],
  ): Promise<AzureVmDeploymentResource>;
  listFirewallRules(resource: AzureVmDeploymentResource): Promise<AzureFirewallSnapshot>;
  createFirewallRule(resource: AzureVmDeploymentResource, rule: AzureFirewallRuleSpec): Promise<AzureFirewallRule>;
  updateFirewallRule(resource: AzureVmDeploymentResource, ruleId: string, rule: AzureFirewallRuleSpec): Promise<AzureFirewallRule>;
  deleteFirewallRule(resource: AzureVmDeploymentResource, ruleId: string): Promise<void>;
  deleteFirewallRuleIfMatches(
    resource: AzureVmDeploymentResource,
    ruleId: string,
    expected: AzureFirewallRuleSpec,
  ): Promise<boolean>;
  destroy(resource: AzureVmDestroyResource): Promise<void>;
}

export type CloudAwsProviderFactory = (connection: AwsEc2ProviderConnection) => CloudAwsProvider;
export interface CloudAwsPermissionChecker {
  check(): Promise<CloudPermissionEvaluation>;
}
export type CloudAwsPermissionCheckerFactory = (
  connection: AwsEc2ProviderConnection,
) => CloudAwsPermissionChecker;
export type CloudAzureProviderFactory = (connection: AzureVmProviderConnection) => CloudAzureProvider;

export interface CloudAwsProfileSource {
  list(): Promise<readonly AwsCliProfileSummary[]>;
  credentialProvider(profileName: string, region?: string): Promise<AwsEc2CredentialProvider>;
  loginSessionArn?(profileName: string): Promise<string | null>;
}

export interface CloudAwsConsoleLogin {
  login(region: string, signal?: AbortSignal, onPendingAuthorization?: (url: string | null) => void): Promise<AwsConsoleLoginSession>;
  refresh(session: AwsConsoleLoginSession, signal?: AbortSignal): Promise<AwsConsoleLoginSession>;
}

export interface CloudAzureBrowserLogin {
  login(tenantId: string | null, clientId: string | null, signal?: AbortSignal): Promise<{
    readonly session: AzureBrowserLoginSession;
    readonly subscriptions: readonly AzureCliAccountSummary[];
  }>;
  getToken(session: AzureBrowserLoginSession, signal?: AbortSignal): Promise<{
    readonly session: AzureBrowserLoginSession;
    readonly token: string;
    readonly expiresOnTimestamp: number;
  }>;
}

type AzureAccessToken = NonNullable<Awaited<ReturnType<TokenCredential["getToken"]>>>;

interface DeploymentRefreshRead {
  readonly credentialId: string;
  readonly generation: number;
  readonly controller: AbortController;
  readonly promise: Promise<CloudDeploymentRecord | null>;
}

interface StagedAzureLogin {
  readonly ownerId: number;
  readonly session: Buffer;
  readonly subscriptions: readonly AzureCliAccountSummary[];
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
}

export interface CloudAzureAccountSource {
  list(): Promise<readonly AzureCliAccountSummary[]>;
}

export interface CloudOperatorDirectoryClient {
  connect(): Promise<unknown>;
  getOperators(): Promise<{
    readonly Operators: readonly { readonly Name: string }[];
  }>;
  disconnect(): Promise<void>;
}

export type CloudOperatorDirectoryClientFactory = (
  config: SliverClientConfig,
) => CloudOperatorDirectoryClient;

export interface CloudDeploymentServiceOptions {
  /** Expected production value: ~/.sliver-client/gui/cloud-deployment/v1. */
  readonly rootDirectory: string;
  /** Existing console-compatible operator profile directory: ~/.sliver-client/configs. */
  readonly operatorConfigDirectory: string;
  readonly safeStorage: CloudSafeStorageAdapter;
  readonly store?: CloudDeploymentStore;
  readonly vault?: CloudCredentialVault;
  readonly privateKeyCapabilities?: CloudPrivateKeyCapabilities;
  readonly sshKeyGenerator?: CloudSshKeyGenerator;
  readonly egressIpv4Detector?: CloudEgressIpv4Detector;
  readonly provisioner?: CloudSliverProvisioner;
  /** Main-process-only authoritative operator-name lookup. */
  readonly operatorDirectoryClientFactory?: CloudOperatorDirectoryClientFactory;
  readonly awsProviderFactory?: CloudAwsProviderFactory;
  readonly awsPermissionCheckerFactory?: CloudAwsPermissionCheckerFactory;
  readonly awsProfileSource?: CloudAwsProfileSource;
  readonly awsConsoleLogin?: CloudAwsConsoleLogin;
  readonly openExternal?: (url: string) => Promise<unknown>;
  readonly azureProviderFactory?: CloudAzureProviderFactory;
  readonly azureAccountSource?: CloudAzureAccountSource;
  readonly azureBrowserLogin?: CloudAzureBrowserLogin;
  readonly azureCliCredentialFactory?: (secret: AzureCliCredentialSecret) => TokenCredential;
  /** Deadline for each read-only provider status refresh. */
  readonly deploymentRefreshTimeoutMs?: number;
  /** Test seam for the bounded Azure public-IP propagation wait. */
  readonly azurePublicIpRefreshDelay?: (milliseconds: number) => Promise<void>;
  readonly sshHostKeyStore?: SshHostKeyStore;
  readonly sshIdentityMaterializer?: SshIdentityMaterializer;
  readonly startSshTerminalRuntime?: CloudSshTerminalStarter;
  /** Generates 32-byte base64url capabilities for explicit host-key reviews. */
  readonly opaqueIdFactory?: () => string;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

interface DestroyPlanEntry {
  readonly token: string;
  readonly deploymentId: string;
  readonly expectedRevision: number;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
}

interface SshHostKeyReviewEntry {
  readonly token: string;
  readonly deploymentId: string;
  readonly credentialId: string;
  readonly target: ManagedSshTarget;
  readonly fingerprint: string;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
}

interface MutableProvisioningTranscript {
  readonly deploymentId: string;
  status: CloudProvisioningTranscript["status"];
  truncated: boolean;
  byteLength: number;
  nextSequence: number;
  headIndex: number;
  chunks: Array<{ readonly sequence: number; readonly bytes: Uint8Array }>;
}

/**
 * Main-process orchestration for cloud credentials, provider-owned resources,
 * SSH provisioning, and local operator configuration import.
 */
export class CloudDeploymentService {
  readonly #operatorConfigDirectory: string;
  readonly #store: CloudDeploymentStore;
  readonly #vault: CloudCredentialVault;
  readonly #privateKeys: CloudPrivateKeyCapabilities;
  readonly #sshKeyGenerator: CloudSshKeyGenerator;
  readonly #egressIpv4Detector: CloudEgressIpv4Detector;
  readonly #provisioner: CloudSliverProvisioner;
  readonly #operatorDirectoryClientFactory: CloudOperatorDirectoryClientFactory;
  readonly #awsProviderFactory: CloudAwsProviderFactory;
  readonly #awsPermissionCheckerFactory: CloudAwsPermissionCheckerFactory;
  readonly #awsProfiles: CloudAwsProfileSource;
  readonly #awsConsoleLogin: CloudAwsConsoleLogin;
  readonly #awsRefreshes = new Map<string, Promise<void>>();
  readonly #authLifetime = new AbortController();
  readonly #azureProviderFactory: CloudAzureProviderFactory;
  readonly #azureAccounts: CloudAzureAccountSource;
  readonly #azureBrowserLogin: CloudAzureBrowserLogin;
  readonly #azureCliCredentialFactory: (secret: AzureCliCredentialSecret) => TokenCredential;
  readonly #azureRefreshes = new Map<string, Promise<AzureAccessToken>>();
  readonly #stagedAzureLogins = new Map<string, StagedAzureLogin>();
  readonly #azureLoginGenerations = new Map<number, number>();
  readonly #azurePublicIpRefreshDelay: (milliseconds: number) => Promise<void>;
  readonly #sshHostKeys: SshHostKeyStore;
  readonly #sshIdentities: SshIdentityMaterializer;
  readonly #startSshTerminalRuntime: CloudSshTerminalStarter;
  readonly #opaqueIdFactory: () => string;
  readonly #now: () => number;
  readonly #idFactory: () => string;
  readonly #listeners = new Set<CloudDeploymentChangedListener>();
  readonly #destroyPlans = new Map<string, DestroyPlanEntry>();
  readonly #sshHostKeyReviews = new Map<string, SshHostKeyReviewEntry>();
  readonly #issuedSshHostKeyReviewTokens = new Set<string>();
  readonly #provisioningTranscripts = new Map<string, MutableProvisioningTranscript>();
  readonly #deploymentRefreshTimeoutMs: number;
  readonly #refreshErrors = new Map<string, string>();
  readonly #refreshReads = new Map<string, DeploymentRefreshRead>();
  readonly #credentialRefreshGenerations = new Map<string, number>();
  readonly #deploymentRefreshGenerations = new Map<string, number>();
  readonly #busyDeployments = new Map<string, number>();
  readonly #pendingRefreshCredentials = new Set<string>();
  #pendingRefreshAll = false;
  #refreshingAll = false;
  #refreshLoop: Promise<void> | undefined;
  #stateMutationChain: Promise<void> = Promise.resolve();
  #transitionChain: Promise<void> = Promise.resolve();
  #transcriptEmitTimer: NodeJS.Timeout | undefined;
  #disposed = false;

  private constructor(
    options: CloudDeploymentServiceOptions,
    store: CloudDeploymentStore,
    sshHostKeys: SshHostKeyStore,
  ) {
    assertBoundedAbsoluteDirectory(options.rootDirectory, "cloud deployment root");
    assertBoundedAbsoluteDirectory(options.operatorConfigDirectory, "operator configuration directory");
    this.#operatorConfigDirectory = options.operatorConfigDirectory;
    this.#store = store;
    this.#vault = options.vault ?? new CloudCredentialVault(options.rootDirectory, options.safeStorage);
    this.#privateKeys = options.privateKeyCapabilities ?? new PrivateKeyCapabilities();
    this.#sshKeyGenerator = options.sshKeyGenerator ?? generateEd25519SshKeyPair;
    this.#egressIpv4Detector = options.egressIpv4Detector ?? detectCurrentEgressIpv4;
    this.#operatorDirectoryClientFactory = options.operatorDirectoryClientFactory ?? (
      (config) => new SliverClient(config)
    );
    this.#awsProviderFactory = options.awsProviderFactory ?? ((connection) => new AwsEc2Provider(connection));
    this.#awsPermissionCheckerFactory = options.awsPermissionCheckerFactory ?? (
      (connection) => new AwsEc2PermissionChecker(connection)
    );
    this.#awsProfiles = options.awsProfileSource ?? new AwsSharedProfileSource();
    this.#awsConsoleLogin = options.awsConsoleLogin ?? new AwsConsoleLogin({
      openExternal: async (url) => {
        if (!options.openExternal) throw new Error("AWS browser login is unavailable");
        await options.openExternal(url);
      },
    });
    this.#azureProviderFactory = options.azureProviderFactory ?? ((connection) => new AzureVmProvider(connection));
    this.#azureAccounts = options.azureAccountSource ?? new AzureCliAccountSource();
    this.#azureCliCredentialFactory = options.azureCliCredentialFactory ?? createAzureCliCredential;
    this.#azureBrowserLogin = options.azureBrowserLogin ?? new AzureBrowserLogin({
      openExternal: async (url) => {
        if (!options.openExternal) throw new Error("Azure browser login is unavailable");
        await options.openExternal(url);
      },
    });
    this.#azurePublicIpRefreshDelay = options.azurePublicIpRefreshDelay ?? delay;
    this.#sshHostKeys = sshHostKeys;
    this.#sshIdentities = options.sshIdentityMaterializer ?? new SshIdentityStore(
      join(homedir(), ".ssh", "sliver-gui"),
    );
    this.#startSshTerminalRuntime = options.startSshTerminalRuntime ?? (
      (runtimeOptions) => SshTerminalRuntime.start(runtimeOptions)
    );
    this.#opaqueIdFactory = options.opaqueIdFactory ?? (() => randomBytes(32).toString("base64url"));
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#deploymentRefreshTimeoutMs = options.deploymentRefreshTimeoutMs ?? DEPLOYMENT_REFRESH_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#deploymentRefreshTimeoutMs) || this.#deploymentRefreshTimeoutMs < 1 || this.#deploymentRefreshTimeoutMs > 120_000) throw new TypeError("Invalid cloud refresh timeout");
    if (options.provisioner) {
      this.#provisioner = options.provisioner;
    } else {
      this.#provisioner = new SliverProvisioner();
    }
  }

  static async create(options: CloudDeploymentServiceOptions): Promise<CloudDeploymentService> {
    const store = options.store ?? await CloudDeploymentStore.load(options.rootDirectory);
    const sshHostKeys = options.sshHostKeyStore ?? await SshHostKeyStore.load(
      join(options.rootDirectory, SSH_HOST_KEY_STORE_FILE_NAME),
    );
    await recoverInterruptedTransitions(store);
    return new CloudDeploymentService(options, store, sshHostKeys);
  }

  subscribe(listener: CloudDeploymentChangedListener): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onChanged(listener: CloudDeploymentChangedListener): () => void {
    return this.subscribe(listener);
  }

  resolveManagedServer(configDigest: string): ManagedServerReference | null {
    if (this.#disposed) return null;
    return resolveManagedServerFromDeployments(configDigest, this.#store.getState().deployments);
  }

  async ensureIngress(
    input: ManagedListenerFirewallInput,
  ): Promise<OperationResult<ManagedListenerFirewallOutcome>> {
    try {
      this.#assertActive();
      const parsed = validateManagedListenerFirewallInput(input);
      return await this.#serializeDeployment(parsed.server.deploymentId, async () => {
        try {
          this.#assertActive();
          const deployment = this.#managedListenerDeployment(parsed);
          if (deployment.status === "provisioning" || deployment.status === "deleting") {
            return { ok: false, error: "The deployment is busy" };
          }
          if (deployment.provider === "aws") {
            return await this.#ensureAwsManagedListenerIngress(deployment, parsed);
          }
          return await this.#ensureAzureManagedListenerIngress(deployment, parsed);
        } catch (error) {
          return failure(error, "The managed listener firewall rule could not be applied");
        }
      });
    } catch (error) {
      return failure(error, "The managed listener firewall request was rejected");
    }
  }

  async removeIngress(
    input: ManagedListenerFirewallInput,
  ): Promise<OperationResult<ManagedListenerFirewallOutcome>> {
    try {
      this.#assertActive();
      const parsed = validateManagedListenerFirewallInput(input);
      return await this.#serializeDeployment(parsed.server.deploymentId, async () => {
        try {
          this.#assertActive();
          const deployment = this.#managedListenerDeployment(parsed);
          if (deployment.status === "provisioning" || deployment.status === "deleting") {
            return { ok: false, error: "The deployment is busy" };
          }
          if (deployment.provider === "aws") {
            return await this.#removeAwsManagedListenerIngress(deployment, parsed);
          }
          return await this.#removeAzureManagedListenerIngress(deployment, parsed);
        } catch (error) {
          return failure(error, "The managed listener firewall rule could not be removed");
        }
      });
    } catch (error) {
      return failure(error, "The managed listener firewall request was rejected");
    }
  }

  async getSnapshot(): Promise<OperationResult<CloudDeploymentSnapshot>> {
    try {
      this.#assertActive();
      let awsProfiles: readonly AwsCliProfileSummary[] = [];
      let awsProfileDiscoveryError: string | null = null;
      let azureAccounts: readonly AzureCliAccountSummary[] = [];
      let azureAccountDiscoveryError: string | null = null;
      try {
        awsProfiles = await this.#awsProfiles.list();
      } catch (error) {
        awsProfileDiscoveryError = cloudErrorMessage(error, "AWS CLI profiles could not be discovered");
      }
      try {
        azureAccounts = await this.#azureAccounts.list();
      } catch (error) {
        azureAccountDiscoveryError = cloudErrorMessage(error, "Azure CLI accounts could not be discovered");
      }
      return {
        ok: true,
        value: Object.freeze({
          state: this.#store.getState(),
          refreshErrors: this.#refreshErrorSnapshot(),
          credentials: await this.#vault.list(),
          secureCredentialStorage: this.#canPersistCredentials(),
          awsProfiles,
          awsProfileDiscoveryError,
          azureAccounts,
          azureAccountDiscoveryError,
          provisioningTranscripts: [...this.#provisioningTranscripts.values()].map(snapshotTranscript),
        }),
      };
    } catch (error) {
      return failure(error, "Cloud deployment state is unavailable");
    }
  }

  async refreshDeployments(): Promise<OperationResult<CloudDeploymentRefreshResult>> {
    try {
      this.#assertActive();
      await this.#enqueueDeploymentRefresh();
      this.#assertActive();
      return {
        ok: true,
        value: {
          state: this.#store.getState(),
          refreshErrors: this.#refreshErrorSnapshot(),
        },
      };
    } catch (error) {
      return failure(error, "Cloud deployment status could not be refreshed");
    }
  }

  #refreshErrorSnapshot(): readonly CloudDeploymentRefreshError[] {
    const existing = new Set(this.#store.getState().deployments.map(({ id }) => id));
    return Object.freeze([...this.#refreshErrors]
      .filter(([id]) => existing.has(id))
      .map(([deploymentId, message]) => Object.freeze({ deploymentId, message }))
      .sort((left, right) => left.deploymentId.localeCompare(right.deploymentId)));
  }

  async #refreshAfterCredentialLogin(credentialId: string): Promise<void> {
    const generation = this.#credentialRefreshGenerations.get(credentialId) ?? 0;
    this.#credentialRefreshGenerations.set(credentialId, generation + 1);
    // A new login must not join token work started with the previous session.
    // The vault's snapshot guard still prevents those old requests from saving.
    this.#awsRefreshes.delete(credentialId);
    this.#azureRefreshes.delete(credentialId);
    for (const read of this.#refreshReads.values()) {
      if (read.credentialId === credentialId) read.controller.abort();
    }
    try {
      await this.#enqueueDeploymentRefresh(credentialId);
    } catch {
      // Login remains successful when status reads fail.
    }
  }

  #enqueueDeploymentRefresh(credentialId?: string): Promise<void> {
    if (credentialId !== undefined) this.#pendingRefreshCredentials.add(credentialId);
    else if (!this.#refreshLoop || !this.#refreshingAll) this.#pendingRefreshAll = true;
    if (!this.#refreshLoop) {
      const loop = this.#drainDeploymentRefreshes();
      this.#refreshLoop = loop;
      void loop.finally(() => {
        if (this.#refreshLoop === loop) this.#refreshLoop = undefined;
      }).catch(() => undefined);
    }
    return this.#refreshLoop;
  }

  async #drainDeploymentRefreshes(): Promise<void> {
    while (!this.#disposed && (this.#pendingRefreshAll || this.#pendingRefreshCredentials.size > 0)) {
      const all = this.#pendingRefreshAll;
      const credentials = new Set(this.#pendingRefreshCredentials);
      this.#pendingRefreshAll = false;
      this.#pendingRefreshCredentials.clear();
      this.#refreshingAll = all;
      const candidates = this.#store.getState().deployments.filter((record) =>
        (all || credentials.has(record.credentialId)) &&
        isRefreshableDeployment(record) &&
        !this.#busyDeployments.has(record.id));
      const workerCount = Math.min(DEPLOYMENT_REFRESH_CONCURRENCY, candidates.length);
      let next = 0;
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (!this.#disposed) {
          const record = candidates[next++];
          if (!record) return;
          await this.#refreshDeployment(record);
        }
      }));
      this.#refreshingAll = false;
      const existing = new Set(this.#store.getState().deployments.map(({ id }) => id));
      for (const id of this.#refreshErrors.keys()) {
        if (!existing.has(id)) this.#refreshErrors.delete(id);
      }
    }
  }

  async #refreshDeployment(record: CloudDeploymentRecord): Promise<void> {
    const generation = this.#credentialRefreshGenerations.get(record.credentialId) ?? 0;
    const deploymentGeneration = this.#deploymentRefreshGenerations.get(record.id) ?? 0;
    const fingerprint = JSON.stringify(record);
    const canApply = () => {
      const current = this.#store.getState().deployments.find(({ id }) => id === record.id);
      return !this.#disposed &&
        !this.#busyDeployments.has(record.id) &&
        (this.#credentialRefreshGenerations.get(record.credentialId) ?? 0) === generation &&
        (this.#deploymentRefreshGenerations.get(record.id) ?? 0) === deploymentGeneration &&
        JSON.stringify(current) === fingerprint;
    };
    try {
      let read = this.#refreshReads.get(record.id);
      if (read && read.generation !== generation) {
        read.controller.abort();
        // Aborted SDK requests settle promptly; retain the gate if an adapter does not.
        try {
          await this.#awaitRefreshRead(read);
        } catch {
          // Superseded credentials are never reused.
        }
        read = this.#refreshReads.get(record.id);
        if (read) {
          throw new Error("The previous cloud status request is still ending. Try refreshing again.");
        }
      }
      if (!read) {
        if (this.#refreshReads.size >= DEPLOYMENT_REFRESH_CONCURRENCY) {
          throw new Error("Cloud status refresh is busy. Try refreshing again.");
        }
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, this.#authLifetime.signal]);
        const promise = this.#readDeploymentStatus(record, signal);
        read = { credentialId: record.credentialId, generation, controller, promise };
        this.#refreshReads.set(record.id, read);
        const observed = read;
        void promise.finally(() => {
          if (this.#refreshReads.get(record.id) === observed) this.#refreshReads.delete(record.id);
        }).catch(() => undefined);
      }
      const refreshed = await this.#awaitRefreshRead(read);
      if (!refreshed || !canApply()) return;
      await this.#serializeStateMutation(async () => {
        if (!canApply()) return;
        if (JSON.stringify(refreshed) !== fingerprint) {
          const updated = await this.#store.update({
            expectedRevision: this.#store.getState().revision,
            deployment: refreshed,
          }, () => {
            if (!canApply()) throw new Error("Cloud deployment changed during status refresh");
          });
          if (!updated.ok) {
            if (canApply()) throw new Error(updated.error);
            return;
          }
          this.#refreshErrors.delete(record.id);
          if (!this.#disposed) this.#emitChanged();
        } else if (this.#refreshErrors.delete(record.id) && !this.#disposed) {
          this.#emitChanged();
        }
      });
    } catch (error) {
      if (!canApply()) return;
      const message = cloudErrorMessage(error, "Cloud deployment status could not be read");
      if (this.#refreshErrors.get(record.id) !== message) {
        this.#refreshErrors.set(record.id, message);
        this.#emitChanged();
      }
    }
  }

  async #awaitRefreshRead(read: DeploymentRefreshRead): Promise<CloudDeploymentRecord | null> {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const bounded = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Cloud deployment status refresh was cancelled"));
      this.#authLifetime.signal.addEventListener("abort", onAbort, { once: true });
      if (this.#authLifetime.signal.aborted) onAbort();
      timer = setTimeout(() => {
        read.controller.abort();
        reject(new Error("Cloud deployment status refresh timed out. Try again."));
      }, this.#deploymentRefreshTimeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([read.promise, bounded]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) this.#authLifetime.signal.removeEventListener("abort", onAbort);
    }
  }

  async #readDeploymentStatus(
    record: CloudDeploymentRecord,
    signal: AbortSignal,
  ): Promise<CloudDeploymentRecord | null> {
    signal.throwIfAborted();
    if (record.provider === "aws") {
      return this.#vault.withCredential(record.credentialId, "aws", async (secret) => {
        signal.throwIfAborted();
        let resource: AwsEc2DeploymentResource;
        try {
          resource = awsResourceFromRecord(record);
        } catch {
          return null;
        }
        try {
          const connection = await this.#awsConnection(record.spec.region, secret, record.credentialId);
          signal.throwIfAborted();
          const provider = this.#awsProviderFactory(connection);
          const observed = await provider.refresh(resource, signal);
          signal.throwIfAborted();
          if (
            observed.guid !== record.id ||
            observed.instanceId !== resource.instanceId ||
            observed.region !== resource.region
          ) throw new Error("AWS returned a different deployment identity");
          return applyAwsStatusObservation(record, observed);
        } catch (error) {
          throw new Error(cloudErrorMessage(
            error, "AWS deployment status could not be read", credentialValues(secret),
          ));
        }
      });
    }
    return this.#vault.withCredential(record.credentialId, "azure", async (secret) => {
      signal.throwIfAborted();
      let resource: AzureVmDeploymentResource;
      try {
        resource = azureResourceFromRecord(record, secret);
      } catch {
        return null;
      }
      try {
        const provider = this.#azureProviderFactory(
          this.#azureConnection(record.spec.location, secret, record.credentialId),
        );
        const observed = await provider.refresh(resource, signal);
        signal.throwIfAborted();
        if (
          observed.guid !== record.id ||
          observed.virtualMachineId !== resource.virtualMachineId ||
          !sameAzureGuid(observed.tenantId, secret.tenantId) ||
          !sameAzureGuid(observed.subscriptionId, secret.subscriptionId)
        ) throw new Error("Azure returned a different deployment identity");
        return applyAzureStatusObservation(record, observed);
      } catch (error) {
        throw new Error(cloudErrorMessage(
          error, "Azure deployment status could not be read", credentialValues(secret),
        ));
      }
    });
  }

  getProvisioningTranscripts(): OperationResult<CloudProvisioningTranscriptSnapshot> {
    try {
      this.#assertActive();
      return {
        ok: true,
        value: Object.freeze({
          provisioningTranscripts: Object.freeze(
            [...this.#provisioningTranscripts.values()].map(snapshotTranscript),
          ),
        }),
      };
    } catch (error) {
      return failure(error, "Cloud provisioning output is unavailable");
    }
  }

  async getTerminalRuntime(): Promise<OperationResult<TerminalRuntimeAsset>> {
    try {
      this.#assertActive();
      return { ok: true, value: await loadTerminalRuntime() };
    } catch (error) {
      return failure(error, "The terminal runtime is unavailable");
    }
  }

  async listSshTargets(): Promise<OperationResult<readonly ManagedSshTarget[]>> {
    try {
      this.#assertActive();
      const credentials = await this.#vault.list();
      this.#assertActive();
      const summaries = new Map(credentials.map((summary) => [summary.id, summary]));
      const targets = this.#store.getState().deployments.flatMap((deployment) => {
        const summary = summaries.get(deployment.credentialId);
        if (!summary || summary.provider !== deployment.provider) return [];
        return [managedSshTarget(deployment, summary)];
      });
      return { ok: true, value: Object.freeze(targets) };
    } catch (error) {
      return failure(error, "Managed SSH servers are unavailable");
    }
  }

  async materializeSshIdentity(
    expectedTarget: ManagedSshTarget,
  ): Promise<OperationResult<MaterializedSshIdentity>> {
    try {
      this.#assertActive();
      const deployment = this.#store.getState().deployments.find(
        ({ id }) => id === expectedTarget.deploymentId,
      );
      if (!deployment) throw new Error("The managed SSH server no longer exists");
      const credentialId = deployment.credentialId;
      const value = deployment.provider === "aws"
        ? await this.#vault.withCredential(credentialId, "aws", async (secret, summary) => {
            const target = this.#requireCurrentSshTarget(
              deployment.id,
              credentialId,
              summary,
              expectedTarget,
            );
            try {
              const collision = this.#hasSshIdentityNameCollision(target);
              const identity = await this.#sshIdentities.materialize({
                managedName: target.name,
                deploymentId: target.deploymentId,
                privateKey: secret.sshPrivateKey,
                collision,
              });
              const currentTarget = this.#requireCurrentSshTarget(
                deployment.id,
                credentialId,
                summary,
                expectedTarget,
              );
              if (this.#hasSshIdentityNameCollision(currentTarget) !== collision) {
                throw sshReviewStateChanged();
              }
              return identity;
            } catch (error) {
              throw new Error(cloudErrorMessage(
                error,
                "The SSH identity file could not be prepared",
                credentialValues(secret),
              ));
            }
          })
        : await this.#vault.withCredential(credentialId, "azure", async (secret, summary) => {
            const target = this.#requireCurrentSshTarget(
              deployment.id,
              credentialId,
              summary,
              expectedTarget,
            );
            try {
              const collision = this.#hasSshIdentityNameCollision(target);
              const identity = await this.#sshIdentities.materialize({
                managedName: target.name,
                deploymentId: target.deploymentId,
                privateKey: secret.sshPrivateKey,
                collision,
              });
              const currentTarget = this.#requireCurrentSshTarget(
                deployment.id,
                credentialId,
                summary,
                expectedTarget,
              );
              if (this.#hasSshIdentityNameCollision(currentTarget) !== collision) {
                throw sshReviewStateChanged();
              }
              return identity;
            } catch (error) {
              throw new Error(cloudErrorMessage(
                error,
                "The SSH identity file could not be prepared",
                credentialValues(secret),
              ));
            }
          });
      return { ok: true, value };
    } catch (error) {
      return failure(error, "The SSH identity file could not be prepared");
    }
  }

  async startSshSession(
    deploymentId: string,
  ): Promise<OperationResult<StartedManagedSshSession | SshHostKeyReview>> {
    try {
      this.#assertActive();
      if (!isUuidV4(deploymentId)) throw new TypeError("Invalid SSH deployment identity");
      const state = this.#store.getState();
      const deployment = state.deployments.find(({ id }) => id === deploymentId);
      if (!deployment) throw new Error("The managed SSH server no longer exists");
      const credentialId = deployment.credentialId;
      const value = deployment.provider === "aws"
        ? await this.#vault.withCredential(credentialId, "aws", async (secret, summary) => {
            const expectedTarget = managedSshTarget(deployment, summary);
            const target = this.#requireCurrentSshTarget(
              deploymentId,
              credentialId,
              summary,
              expectedTarget,
            );
            return await this.#startManagedSshSession(target, credentialId, secret);
          })
        : await this.#vault.withCredential(credentialId, "azure", async (secret, summary) => {
            const expectedTarget = managedSshTarget(deployment, summary);
            const target = this.#requireCurrentSshTarget(
              deploymentId,
              credentialId,
              summary,
              expectedTarget,
            );
            return await this.#startManagedSshSession(target, credentialId, secret);
          });
      return { ok: true, value };
    } catch (error) {
      return failure(error, "The SSH session could not be started");
    }
  }

  async approveSshHostKey(
    token: string,
  ): Promise<OperationResult<StartedManagedSshSession>> {
    try {
      this.#assertActive();
      if (!OPAQUE_SSH_ID_PATTERN.test(token)) {
        return { ok: false, error: "The SSH host-key review is invalid or expired" };
      }
      const review = this.#sshHostKeyReviews.get(token);
      if (!review) return { ok: false, error: "The SSH host-key review is invalid or expired" };
      this.#discardSshHostKeyReview(token);
      if (review.expiresAt <= this.#now()) {
        return { ok: false, error: "The SSH host-key review is invalid or expired" };
      }

      const deployment = this.#store.getState().deployments.find(({ id }) => id === review.deploymentId);
      if (
        !deployment ||
        deployment.provider !== review.target.provider ||
        deployment.credentialId !== review.credentialId
      ) throw sshReviewStateChanged();
      const value = deployment.provider === "aws"
        ? await this.#vault.withCredential(review.credentialId, "aws", async (secret, summary) => {
            const target = this.#requireCurrentSshTarget(
              review.deploymentId,
              review.credentialId,
              summary,
              review.target,
            );
            await this.#sshHostKeys.remember(review.deploymentId, review.fingerprint);
            return await this.#startPinnedSshSession(target, review.credentialId, secret, review.fingerprint);
          })
        : await this.#vault.withCredential(review.credentialId, "azure", async (secret, summary) => {
            const target = this.#requireCurrentSshTarget(
              review.deploymentId,
              review.credentialId,
              summary,
              review.target,
            );
            await this.#sshHostKeys.remember(review.deploymentId, review.fingerprint);
            return await this.#startPinnedSshSession(target, review.credentialId, secret, review.fingerprint);
          });
      return { ok: true, value };
    } catch (error) {
      return failure(error, "The SSH host key could not be approved");
    }
  }

  chooseSshPrivateKey(owner: BrowserWindow): Promise<OperationResult<SshPrivateKeySelection>> {
    try {
      this.#assertActive();
      return this.#privateKeys.choose(owner);
    } catch (error) {
      return Promise.resolve(failure(error, "SSH private key selection is unavailable"));
    }
  }

  async detectCurrentEgressIpv4(): Promise<OperationResult<CurrentEgressIpv4>> {
    try {
      this.#assertActive();
      return { ok: true, value: Object.freeze(await this.#egressIpv4Detector()) };
    } catch (error) {
      return failure(error, "The current egress IPv4 address could not be detected");
    }
  }

  async discoverAzureAccounts(): Promise<OperationResult<readonly AzureCliAccountSummary[]>> {
    try {
      this.#assertActive();
      return { ok: true, value: await this.#azureAccounts.list() };
    } catch (error) {
      return failure(error, "Azure CLI accounts could not be discovered");
    }
  }

  async createCredential(
    input: CreateCloudCredentialInput,
    signal?: AbortSignal,
    ownerId = 0,
    onPendingAuthorization?: (url: string | null) => void,
  ): Promise<OperationResult<CloudCredentialSummary>> {
    try {
      this.#assertActive();
      const authSignal = signal ? AbortSignal.any([signal, this.#authLifetime.signal]) : this.#authLifetime.signal;
      authSignal.throwIfAborted();
      const parsed = parseCreateCloudCredentialInput(input);
      const azureLoginSession = parsed.provider === "azure" && "authentication" in parsed
        ? this.#consumeAzureLogin(parsed.loginToken, ownerId, parsed.subscriptionId, parsed.tenantId)
        : undefined;
      const loginSession = parsed.provider === "aws" && "authentication" in parsed
        ? parseAwsConsoleLoginSession(await this.#awsConsoleLogin.login(parsed.defaultRegion, authSignal, onPendingAuthorization))
        : undefined;
      this.#assertActive();
      authSignal.throwIfAborted();
      if (loginSession && parsed.provider === "aws" && loginSession.region !== parsed.defaultRegion) throw new Error("AWS Login returned a different region");
      if (parsed.provider === "aws" && "profileName" in parsed) {
        const profiles = await this.#awsProfiles.list();
        if (!profiles.some(({ name }) => name === parsed.profileName)) {
          throw new Error("The selected AWS CLI profile is no longer available");
        }
      }
      if (parsed.provider === "azure" && !azureLoginSession) {
        const accounts = await this.#azureAccounts.list();
        const account = accounts.find(({ subscriptionId }) => subscriptionId === parsed.subscriptionId);
        if (!account || account.tenantId !== parsed.tenantId) {
          throw new Error("The selected Azure CLI subscription is no longer available");
        }
        if (account.cloudName !== "AzureCloud") {
          throw new Error("Only AzureCloud subscriptions are currently supported");
        }
      }
      const key = parsed.sshPrivateKeyToken === null
        ? await this.#sshKeyGenerator()
        : this.#privateKeys.consume(parsed.sshPrivateKeyToken, parsed.sshPassphrase);
      this.#assertActive();
      authSignal.throwIfAborted();
      const sshPassphrase = parsed.sshPrivateKeyToken === null ? null : parsed.sshPassphrase;
      const summary = parsed.provider === "aws"
        ? await this.#vault.create({
            provider: "aws",
            label: parsed.label,
            defaultRegion: parsed.defaultRegion,
            sshUsername: parsed.sshUsername,
            secret: loginSession
              ? { loginSession, sshPrivateKey: key.privateKey, sshPassphrase }
              : "profileName" in parsed
              ? {
                  profileName: parsed.profileName,
                  sshPrivateKey: key.privateKey,
                  sshPassphrase,
                }
              : "accessKeyId" in parsed ? {
                  accessKeyId: parsed.accessKeyId,
                  secretAccessKey: parsed.secretAccessKey,
                  sessionToken: parsed.sessionToken,
                  sshPrivateKey: key.privateKey,
                  sshPassphrase,
                } : (() => { throw new Error("AWS login did not return a session"); })(),
          }, authSignal)
        : await this.#vault.create({
            provider: "azure",
            label: parsed.label,
            defaultLocation: parsed.defaultLocation,
            sshUsername: parsed.sshUsername,
            secret: {
              subscriptionId: parsed.subscriptionId,
              tenantId: parsed.tenantId,
              ...(azureLoginSession ? { authentication: "login" as const, loginSession: azureLoginSession } : {}),
              sshPrivateKey: key.privateKey,
              sshPassphrase,
            },
          }, authSignal);
      this.#emitChanged();
      return { ok: true, value: summary };
    } catch (error) {
      if (input && typeof input === "object" && "authentication" in input) {
        if (input.provider === "aws") return awsLoginFailure(error);
        if (input.provider === "azure") return azureLoginFailure(error);
      }
      return failure(error, "The cloud credential could not be saved");
    }
  }

  async loginAwsCredential(
    input: CloudCredentialIdInput,
    signal?: AbortSignal,
    onPendingAuthorization?: (url: string | null) => void,
  ): Promise<OperationResult<CloudCredentialSummary>> {
    try {
      this.#assertActive();
      if (!isUuidV4(input.credentialId)) throw new TypeError("Invalid cloud credential identity");
      const authSignal = signal ? AbortSignal.any([signal, this.#authLifetime.signal]) : this.#authLifetime.signal;
      return await this.#vault.withCredential(input.credentialId, "aws", async (secret, summary) => {
        if ("accessKeyId" in secret) return { ok: false, error: "Access-key credentials cannot use AWS Login. Add a new AWS Login credential instead." };
        authSignal.throwIfAborted();
        const configuredArn = "profileName" in secret
          ? await this.#awsProfiles.loginSessionArn?.(secret.profileName)
          : undefined;
        const expectedArn = secret.loginSession?.loginSessionArn ?? configuredArn;
        if (!expectedArn) return { ok: false, error: "This profile does not contain an AWS console login identity. Add a new AWS Login credential, or refresh this profile with its existing sign-in method." };
        if (configuredArn && configuredArn !== expectedArn) return { ok: false, error: "The AWS profile login identity changed. Restore the original profile or add a new credential." };
        this.#assertActive();
        authSignal.throwIfAborted();
        const loginSession = parseAwsConsoleLoginSession(await this.#awsConsoleLogin.login(summary.defaultRegion, authSignal, onPendingAuthorization));
        this.#assertActive();
        authSignal.throwIfAborted();
        if (loginSession.region !== summary.defaultRegion) throw new Error("AWS Login returned a different region");
        if (loginSession.loginSessionArn !== expectedArn) return { ok: false, error: "AWS Login used a different identity. Sign in with the original AWS identity and try again." };
        const updated = await this.#vault.updateAwsLoginSession(summary.id, secret, loginSession, authSignal);
        this.#emitChanged();
        await this.#refreshAfterCredentialLogin(summary.id);
        return { ok: true, value: updated };
      });
    } catch (error) {
      return awsLoginFailure(error);
    }
  }

  async beginAzureLogin(
    input: BeginAzureLoginInput,
    signal?: AbortSignal,
    ownerId = 0,
  ): Promise<OperationResult<AzureLoginSelection>> {
    try {
      this.#assertActive();
      assertAzureLoginOwner(ownerId);
      const parsed = parseBeginAzureLoginInput(input);
      this.cancelAzureLogin(ownerId);
      const generation = this.#azureLoginGenerations.get(ownerId);
      const authSignal = signal ? AbortSignal.any([signal, this.#authLifetime.signal]) : this.#authLifetime.signal;
      authSignal.throwIfAborted();
      const result = await this.#azureBrowserLogin.login(parsed.tenantId, parsed.clientId, authSignal);
      this.#assertActive();
      authSignal.throwIfAborted();
      if (this.#azureLoginGenerations.get(ownerId) !== generation) throw new Error("Azure Login was cancelled");
      const session = parseAzureBrowserLoginSession(result.session);
      if (parsed.tenantId && !sameAzureGuid(parsed.tenantId, session.tenantId)) throw new Error("Azure Login used a different tenant");
      if (parsed.clientId && !sameAzureGuid(parsed.clientId, session.clientId)) throw new Error("Azure Login used a different application");
      const subscriptions = validateAzureLoginSubscriptions(result.subscriptions, session);
      if (this.#stagedAzureLogins.size >= 32) throw new Error("Too many pending Azure logins");
      const token = randomUUID();
      const expiresAt = this.#now() + 10 * 60_000;
      const timer = setTimeout(() => this.#discardAzureLogin(token), 10 * 60_000);
      timer.unref();
      this.#stagedAzureLogins.set(token, { ownerId, session: Buffer.from(JSON.stringify(session), "utf8"), subscriptions, expiresAt, timer });
      return { ok: true, value: { token, expiresAt: new Date(expiresAt).toISOString(), subscriptions } };
    } catch (error) {
      return azureLoginFailure(error);
    }
  }

  cancelAzureLogin(ownerId = 0): void {
    assertAzureLoginOwner(ownerId);
    this.#azureLoginGenerations.set(ownerId, (this.#azureLoginGenerations.get(ownerId) ?? 0) + 1);
    for (const [token, staged] of this.#stagedAzureLogins) {
      if (staged.ownerId === ownerId) this.#discardAzureLogin(token);
    }
  }

  async loginAzureCredential(
    input: CloudCredentialIdInput,
    signal?: AbortSignal,
  ): Promise<OperationResult<CloudCredentialSummary>> {
    try {
      this.#assertActive();
      if (!isUuidV4(input.credentialId)) throw new TypeError("Invalid cloud credential identity");
      const authSignal = signal ? AbortSignal.any([signal, this.#authLifetime.signal]) : this.#authLifetime.signal;
      return await this.#vault.withCredential(input.credentialId, "azure", async (secret, summary) => {
        authSignal.throwIfAborted();
        const result = await this.#azureBrowserLogin.login(secret.tenantId, secret.loginSession?.clientId ?? null, authSignal);
        this.#assertActive();
        authSignal.throwIfAborted();
        const session = parseAzureBrowserLoginSession(result.session);
        const subscriptions = validateAzureLoginSubscriptions(result.subscriptions, session);
        if (!sameAzureGuid(session.tenantId, secret.tenantId) || !subscriptions.some((account) => sameAzureGuid(account.subscriptionId, secret.subscriptionId))) {
          return { ok: false, error: "Azure Login does not include this credential's tenant and subscription. Sign in with the original Azure account." };
        }
        if (secret.loginSession && !sameAzureLoginIdentity(secret.loginSession, session)) {
          return { ok: false, error: "Azure Login used a different account. Sign in with the original Azure account and try again." };
        }
        const updated = await this.#vault.updateAzureLoginSession(summary.id, secret, session, authSignal);
        this.#emitChanged();
        await this.#refreshAfterCredentialLogin(summary.id);
        return { ok: true, value: updated };
      });
    } catch (error) {
      return azureLoginFailure(error);
    }
  }

  #consumeAzureLogin(token: string, ownerId: number, subscriptionId: string, tenantId: string): AzureBrowserLoginSession {
    assertAzureLoginOwner(ownerId);
    const staged = this.#stagedAzureLogins.get(token);
    if (!staged || staged.ownerId !== ownerId) throw new AzureBrowserLoginError("login-required", "Your Azure login selection expired or is invalid. Sign in again.");
    try {
      if (staged.expiresAt <= this.#now() || !staged.subscriptions.some((account) => sameAzureGuid(account.subscriptionId, subscriptionId) && sameAzureGuid(account.tenantId, tenantId))) {
        throw new AzureBrowserLoginError("login-required", "Your Azure login selection expired or is invalid. Sign in again.");
      }
      return parseAzureBrowserLoginSession(JSON.parse(staged.session.toString("utf8")) as unknown);
    } finally {
      this.#discardAzureLogin(token);
    }
  }

  #discardAzureLogin(token: string): void {
    const staged = this.#stagedAzureLogins.get(token);
    if (!staged) return;
    this.#stagedAzureLogins.delete(token);
    clearTimeout(staged.timer);
    staged.session.fill(0);
  }

  async deleteCredential(input: CloudCredentialIdInput): Promise<OperationResult> {
    try {
      this.#assertActive();
      if (!isUuidV4(input.credentialId)) throw new TypeError("Invalid cloud credential identity");
      if (this.#store.getState().deployments.some(({ credentialId }) => credentialId === input.credentialId)) {
        return { ok: false, error: "Delete the deployments that use this credential first" };
      }
      if (!(await this.#vault.delete(input.credentialId))) {
        return { ok: false, error: "The cloud credential no longer exists" };
      }
      this.#emitChanged();
      return { ok: true };
    } catch (error) {
      return failure(error, "The cloud credential could not be deleted");
    }
  }

  async testCredential(
    input: CloudCredentialIdInput,
  ): Promise<OperationResult<CloudCredentialTestResult>> {
    try {
      this.#assertActive();
      if (!isUuidV4(input.credentialId)) throw new TypeError("Invalid cloud credential identity");
      const summary = (await this.#vault.list()).find(({ id }) => id === input.credentialId);
      if (!summary) return { ok: false, error: "The cloud credential no longer exists" };
      if (summary.provider === "aws") {
        return await this.#vault.withCredential(summary.id, "aws", async (secret) => {
          try {
            const permissions = await this.#awsPermissionCheckerFactory(
              await this.#awsConnection(summary.defaultRegion, secret, summary.id),
            ).check();
            return {
              ok: true,
              value: {
                provider: "aws",
                summary: permissionSummary(`AWS ${summary.defaultRegion}`, permissions, "IAM permission"),
                permissions,
              },
            };
          } catch (error) {
            return failure(error, "AWS rejected the credential", credentialValues(secret));
          }
        });
      }
      return await this.#vault.withCredential(summary.id, "azure", async (secret) => {
        try {
          const provider = this.#azureProviderFactory(
            this.#azureConnection(summary.defaultLocation, secret, summary.id),
          );
          const permissions = await provider.checkPermissions();
          return {
            ok: true,
            value: {
              provider: "azure",
              summary: permissionSummary(
                `Azure ${summary.defaultLocation}`,
                permissions,
                "RBAC action",
              ),
              permissions,
            },
          };
        } catch (error) {
          return failure(error, "Azure rejected the CLI credential", credentialValues(secret));
        }
      });
    } catch (error) {
      return failure(error, "The cloud credential could not be tested");
    }
  }

  async discoverAwsOptions(
    input: DiscoverAwsOptionsInput,
  ): Promise<OperationResult<AwsDeploymentOptions>> {
    try {
      this.#assertActive();
      const parsed = parseDiscoverAwsOptionsInput(input);
      return await this.#vault.withCredential(parsed.credentialId, "aws", async (secret) => {
        try {
          const provider = this.#awsProviderFactory(await this.#awsConnection(parsed.region, secret, parsed.credentialId));
          const inventory = await provider.discover();
          if (inventory.region !== parsed.region) {
            throw new Error("AWS returned inventory for a different region");
          }
          return {
            ok: true,
            value: toAwsDeploymentOptions(parsed.region, inventory, publicKeyForCredential(secret)),
          };
        } catch (error) {
          return failure(error, "AWS infrastructure options could not be discovered", credentialValues(secret));
        }
      });
    } catch (error) {
      return failure(error, "The AWS option discovery request was rejected");
    }
  }

  async discoverAzureOptions(
    input: DiscoverAzureOptionsInput,
  ): Promise<OperationResult<AzureDeploymentOptions>> {
    try {
      this.#assertActive();
      const parsed = parseDiscoverAzureOptionsInput(input);
      return await this.#vault.withCredential(parsed.credentialId, "azure", async (secret) => {
        try {
          const inventory = await this.#azureProviderFactory(
            this.#azureConnection(parsed.location, secret, parsed.credentialId),
          ).discover();
          if (
            inventory.subscriptionId !== secret.subscriptionId ||
            inventory.tenantId !== secret.tenantId ||
            inventory.location !== parsed.location
          ) throw new Error("Azure returned inventory for a different subscription, tenant, or location");
          return { ok: true, value: toAzureDeploymentOptions(inventory) };
        } catch (error) {
          return failure(error, "Azure infrastructure options could not be discovered", credentialValues(secret));
        }
      });
    } catch (error) {
      return failure(error, "The Azure option discovery request was rejected");
    }
  }

  async createDeployment(
    input: CreateCloudDeploymentInput,
  ): Promise<OperationResult<CloudDeploymentRecord>> {
    try {
      this.#assertActive();
      const parsed = parseCreateCloudDeploymentInput(input);
      await this.#requireMatchingCredential(parsed.credentialId, parsed.provider);
      const created = await this.#store.create(parsed);
      if (!created.ok) return created;
      this.#beginProvisioningTranscript(created.value.deployment.id);
      this.#emitChanged();
      return await this.#serializeDeployment(created.value.deployment.id, async () => {
        try {
          const deployment = created.value.deployment.provider === "aws"
            ? await this.#provisionAws(created.value.deployment)
            : await this.#provisionAzure(created.value.deployment);
          this.#finishProvisioningTranscript(created.value.deployment.id, "complete");
          return { ok: true, value: deployment };
        } catch (error) {
          const message = cloudErrorMessage(error, "The cloud deployment failed");
          this.#finishProvisioningTranscript(created.value.deployment.id, "failed");
          await this.#markFailed(created.value.deployment.id, message);
          return { ok: false, error: message };
        }
      });
    } catch (error) {
      return failure(error, "The cloud deployment could not be created");
    }
  }

  async renameDeployment(input: RenameCloudDeploymentInput): Promise<OperationResult<CloudDeploymentRecord>> {
    try {
      this.#assertActive();
      const parsed = parseRenameCloudDeploymentInput(input);
      if (this.#busyDeployments.has(parsed.deploymentId)) return { ok: false, error: "The deployment is busy" };
      return await this.#serializeDeployment(parsed.deploymentId, async () => {
        let providerUpdated = false;
        try {
          const deployment = this.#requireDeploymentAtRevision(parsed.deploymentId, parsed.expectedRevision);
          if (deployment.status === "provisioning" || deployment.status === "deleting") {
            return { ok: false, error: "The deployment is busy" };
          }
          if (deployment.provider === "aws") {
            await this.#vault.withCredential(deployment.credentialId, "aws", async (secret) => {
              try {
                const provider = this.#awsProviderFactory(await this.#awsConnection(deployment.spec.region, secret, deployment.credentialId));
                await provider.rename(awsResourceFromRecord(deployment), parsed.name);
              } catch (error) {
                throw new Error(cloudErrorMessage(error, "The AWS instance could not be renamed", credentialValues(secret)));
              }
            });
          } else {
            await this.#vault.withCredential(deployment.credentialId, "azure", async (secret) => {
              try {
                const provider = this.#azureProviderFactory(this.#azureConnection(deployment.spec.location, secret, deployment.credentialId));
                await provider.rename(azureResourceFromRecord(deployment, secret), parsed.name);
              } catch (error) {
                throw new Error(cloudErrorMessage(error, "The Azure instance could not be renamed", credentialValues(secret)));
              }
            });
          }
          providerUpdated = true;
          const renamed = await this.#persistPatch(deployment.id, (current) => ({ ...current, name: parsed.name }));
          return { ok: true, value: renamed };
        } catch (error) {
          if (providerUpdated) {
            return { ok: false, error: "The cloud name was updated, but local state could not be saved. Refresh the deployment before retrying." };
          }
          return failure(error, "The cloud instance could not be renamed");
        }
      });
    } catch (error) {
      return failure(error, "The cloud instance rename was rejected");
    }
  }

  async runLifecycleAction(
    input: CloudDeploymentActionInput,
  ): Promise<OperationResult<CloudDeploymentRecord>> {
    try {
      this.#assertActive();
      const parsed = parseCloudDeploymentActionInput(input);
      return await this.#serializeDeployment(parsed.deploymentId, async () => {
        let operationStarted = false;
        try {
          let deployment = this.#requireDeploymentAtRevision(parsed.deploymentId, parsed.expectedRevision);
          if (deployment.status === "provisioning" || deployment.status === "deleting") {
            return { ok: false, error: "The deployment is busy" };
          }
          operationStarted = true;
          deployment = deployment.provider === "aws"
            ? await this.#runAwsLifecycle(deployment, parsed.action)
            : await this.#runAzureLifecycle(deployment, parsed.action);
          return { ok: true, value: deployment };
        } catch (error) {
          const message = cloudErrorMessage(error, "The lifecycle action failed");
          if (operationStarted) await this.#markFailed(parsed.deploymentId, message);
          return { ok: false, error: message };
        }
      });
    } catch (error) {
      return failure(error, "The lifecycle action was rejected");
    }
  }

  async generateOperatorConfig(
    input: CreateCloudOperatorConfigInput,
  ): Promise<GenerateCloudOperatorConfigResult> {
    try {
      this.#assertActive();
      const parsed = parseCreateCloudOperatorConfigInput(input);
      return await this.#serializeDeployment(parsed.deploymentId, async () => {
        try {
          const deployment = this.#requireDeploymentAtRevision(
            parsed.deploymentId,
            parsed.expectedRevision,
          );
          if (!hasStableRunningRuntime(deployment)) {
            return operatorGenerationFailure("The managed server must be running before adding an operator");
          }
          if (deployment.operatorConfigFileName === null || deployment.operatorConfigDigest === null) {
            return operatorGenerationFailure("The managed server operator endpoint is not ready");
          }
          if (parsed.operatorName === deployment.spec.operatorName) {
            return operatorGenerationFailure("That operator already exists on this managed server");
          }
          const hostKeySha256 = this.#sshHostKeys.get(deployment.id);
          if (!hostKeySha256) {
            return operatorGenerationFailure("The managed server SSH host key is unavailable");
          }
          const credentialId = deployment.credentialId;
          const assertOperatorNameAvailable = async (): Promise<void> => {
            await this.#assertOperatorNameAvailable(deployment, parsed.operatorName);
          };
          const generated = deployment.provider === "aws"
            ? await this.#vault.withCredential(credentialId, "aws", async (secret, summary) => {
                try {
                  const target = this.#requireCurrentSshTarget(
                    deployment.id,
                    credentialId,
                    summary,
                    managedSshTarget(deployment, summary),
                  );
                  return await this.#provisioner.createOperator({
                    deploymentId: deployment.id,
                    operatorEndpointHost: parsed.publicIp,
                    multiplayerPort: parsed.port,
                    operatorName: parsed.operatorName,
                    permissions: parsed.permissions,
                    assertOperatorNameAvailable,
                    ssh: {
                      ...sshTerminalTarget(target, secret, hostKeySha256),
                      hostKeySha256,
                    },
                  });
                } catch (error) {
                  if (error instanceof SliverOperatorCreationError) throw error;
                  throw new Error(cloudErrorMessage(
                    error,
                    "The managed server operator could not be created",
                    credentialValues(secret),
                  ));
                }
              })
            : await this.#vault.withCredential(credentialId, "azure", async (secret, summary) => {
                try {
                  const target = this.#requireCurrentSshTarget(
                    deployment.id,
                    credentialId,
                    summary,
                    managedSshTarget(deployment, summary),
                  );
                  return await this.#provisioner.createOperator({
                    deploymentId: deployment.id,
                    operatorEndpointHost: parsed.publicIp,
                    multiplayerPort: parsed.port,
                    operatorName: parsed.operatorName,
                    permissions: parsed.permissions,
                    assertOperatorNameAvailable,
                    ssh: {
                      ...sshTerminalTarget(target, secret, hostKeySha256),
                      hostKeySha256,
                    },
                  });
                } catch (error) {
                  if (error instanceof SliverOperatorCreationError) throw error;
                  throw new Error(cloudErrorMessage(
                    error,
                    "The managed server operator could not be created",
                    credentialValues(secret),
                  ));
                }
              });
          const validRecoveryPath = isManagedOperatorRecoveryPath(
            deployment.id,
            generated.remoteRecoveryPath,
          );
          if (
            !validRecoveryPath ||
            generated.deploymentId !== deployment.id ||
            generated.operatorName !== parsed.operatorName ||
            generated.operatorEndpointHost !== parsed.publicIp ||
            generated.multiplayerPort !== parsed.port ||
            generated.permissions !== parsed.permissions ||
            generated.hostKeySha256 !== hostKeySha256 ||
            createHash("sha256").update(generated.operatorConfig).digest("hex") !==
              generated.operatorConfigSha256
          ) {
            generated.operatorConfig.fill(0);
            return operatorGenerationFailure(
              "The generated operator configuration failed verification",
              "created",
              validRecoveryPath ? generated.remoteRecoveryPath : undefined,
            );
          }
          return {
            ok: true,
            value: Object.freeze({
              operatorName: parsed.operatorName,
              publicIp: parsed.publicIp,
              port: parsed.port,
              permissions: parsed.permissions,
              data: generated.operatorConfig,
              remoteRecoveryPath: generated.remoteRecoveryPath,
            }),
          };
        } catch (error) {
          if (error instanceof SliverOperatorCreationError) {
            const remoteRecoveryPath = error.mutationState === "created" &&
                isManagedOperatorRecoveryPath(parsed.deploymentId, error.remoteRecoveryPath)
              ? error.remoteRecoveryPath
              : undefined;
            const remoteRecoveryCandidatePath = error.mutationState === "unknown" &&
                isManagedOperatorRecoveryPath(parsed.deploymentId, error.remoteRecoveryCandidatePath)
              ? error.remoteRecoveryCandidatePath
              : undefined;
            const remoteHandoffCandidatePath = isManagedOperatorHandoffPath(
              parsed.deploymentId,
              error.remoteHandoffCandidatePath,
            )
              ? error.remoteHandoffCandidatePath
              : undefined;
            return operatorGenerationFailure(
              error,
              error.mutationState,
              remoteRecoveryPath,
              remoteRecoveryCandidatePath,
              undefined,
              remoteHandoffCandidatePath,
            );
          }
          return operatorGenerationFailure(error, "not-started");
        }
      });
    } catch (error) {
      return operatorGenerationFailure(
        error,
        "not-started",
        undefined,
        undefined,
        "The managed server operator request was rejected",
      );
    }
  }

  async updateFirewall(
    input: UpdateCloudFirewallInput,
  ): Promise<OperationResult<CloudDeploymentRecord>> {
    try {
      this.#assertActive();
      const parsed = parseUpdateCloudFirewallInput(input);
      const requestedDeployment = this.#store.getState().deployments.find(
        ({ id }) => id === parsed.deploymentId,
      );
      if (
        requestedDeployment?.status === "provisioning" ||
        requestedDeployment?.status === "deleting"
      ) {
        return { ok: false, error: "The deployment is busy" };
      }
      return await this.#serializeDeployment(parsed.deploymentId, async () => {
        let operationStarted = false;
        try {
          let deployment = this.#requireDeploymentAtRevision(parsed.deploymentId, parsed.expectedRevision);
          if (deployment.status === "provisioning" || deployment.status === "deleting") {
            return { ok: false, error: "The deployment is busy" };
          }
          deployment = await this.#persistPatch(deployment.id, (current) => ({
            ...current,
            phase: "configuring-firewall",
            lastError: null,
          }));
          operationStarted = true;
          deployment = deployment.provider === "aws"
            ? await this.#updateAwsFirewall(deployment, parsed)
            : await this.#updateAzureFirewall(deployment, parsed);
          return { ok: true, value: deployment };
        } catch (error) {
          const message = cloudErrorMessage(error, "The firewall update failed");
          if (operationStarted) await this.#markFailed(parsed.deploymentId, message);
          return { ok: false, error: message };
        }
      });
    } catch (error) {
      return failure(error, "The firewall update was rejected");
    }
  }

  async listFirewallRules(
    input: ListCloudFirewallRulesInput,
  ): Promise<OperationResult<CloudFirewallSnapshot>> {
    try {
      this.#assertActive();
      const parsed = parseListCloudFirewallRulesInput(input);
      const deployment = this.#requireDeployment(parsed.deploymentId);
      if (deployment.status === "provisioning" || deployment.status === "deleting") {
        return { ok: false, error: "The deployment is busy" };
      }
      if (deployment.provider === "aws") {
        return await this.#vault.withCredential(deployment.credentialId, "aws", async (secret) => {
          try {
            const provider = this.#awsProviderFactory(
              await this.#awsConnection(deployment.spec.region, secret, deployment.credentialId),
            );
            return { ok: true, value: await provider.listFirewallRules(awsResourceFromRecord(deployment)) };
          } catch (error) {
            return failure(error, "The AWS firewall rules could not be listed", credentialValues(secret));
          }
        });
      }
      return await this.#vault.withCredential(deployment.credentialId, "azure", async (secret) => {
        try {
          const provider = this.#azureProviderFactory(this.#azureConnection(deployment.spec.location, secret, deployment.credentialId));
          return { ok: true, value: await provider.listFirewallRules(azureResourceFromRecord(deployment, secret)) };
        } catch (error) {
          return failure(error, "The Azure firewall rules could not be listed", credentialValues(secret));
        }
      });
    } catch (error) {
      return failure(error, "The firewall rule list request was rejected");
    }
  }

  async createFirewallRule(
    input: CreateCloudFirewallRuleInput,
  ): Promise<OperationResult<CloudFirewallSnapshot>> {
    try {
      this.#assertActive();
      const parsed = parseCreateCloudFirewallRuleInput(input);
      const deployment = this.#requireDeployment(parsed.deploymentId);
      if (deployment.provider === "aws") {
        if (!("peerType" in parsed.rule)) throw new TypeError("Invalid AWS firewall rule");
        return await this.#mutateAwsFirewall(
          parsed.deploymentId, parsed.expectedRevision, "The AWS firewall rule could not be created",
          async (provider, resource, before) => upsertAwsFirewallRule(
            before, await provider.createFirewallRule(resource, parsed.rule as AwsFirewallRuleSpec),
          ),
        );
      }
      if (!("name" in parsed.rule)) throw new TypeError("Invalid Azure firewall rule");
      return await this.#mutateAzureFirewall(
        parsed.deploymentId, parsed.expectedRevision, "The Azure firewall rule could not be created",
        async (provider, resource, before) => upsertAzureFirewallRule(
          before, await provider.createFirewallRule(resource, parsed.rule as AzureFirewallRuleSpec),
        ),
      );
    } catch (error) {
      return failure(error, "The firewall rule creation request was rejected");
    }
  }

  async updateFirewallRule(
    input: UpdateCloudFirewallRuleInput,
  ): Promise<OperationResult<CloudFirewallSnapshot>> {
    try {
      this.#assertActive();
      const parsed = parseUpdateCloudFirewallRuleInput(input);
      const deployment = this.#requireDeployment(parsed.deploymentId);
      if (deployment.provider === "aws") {
        if (!("peerType" in parsed.rule)) throw new TypeError("Invalid AWS firewall rule");
        return await this.#mutateAwsFirewall(
          parsed.deploymentId, parsed.expectedRevision, "The AWS firewall rule could not be updated",
          async (provider, resource, before) => upsertAwsFirewallRule(
            before,
            await provider.updateFirewallRule(resource, parsed.ruleId, parsed.rule as AwsFirewallRuleSpec),
          ),
        );
      }
      if (!("name" in parsed.rule)) throw new TypeError("Invalid Azure firewall rule");
      return await this.#mutateAzureFirewall(
        parsed.deploymentId, parsed.expectedRevision, "The Azure firewall rule could not be updated",
        async (provider, resource, before) => upsertAzureFirewallRule(
          before,
          await provider.updateFirewallRule(
            resource,
            azureFirewallRuleName(parsed.ruleId),
            parsed.rule as AzureFirewallRuleSpec,
          ),
        ),
      );
    } catch (error) {
      return failure(error, "The firewall rule update request was rejected");
    }
  }

  async deleteFirewallRule(
    input: DeleteCloudFirewallRuleInput,
  ): Promise<OperationResult<CloudFirewallSnapshot>> {
    try {
      this.#assertActive();
      const parsed = parseDeleteCloudFirewallRuleInput(input);
      const deployment = this.#requireDeployment(parsed.deploymentId);
      if (deployment.provider === "aws") {
        return await this.#mutateAwsFirewall(
          parsed.deploymentId, parsed.expectedRevision, "The AWS firewall rule could not be deleted",
          async (provider, resource, before) => {
            await provider.deleteFirewallRule(resource, parsed.ruleId);
            return removeAwsFirewallRule(before, parsed.ruleId);
          },
        );
      }
      return await this.#mutateAzureFirewall(
        parsed.deploymentId, parsed.expectedRevision, "The Azure firewall rule could not be deleted",
        async (provider, resource, before) => {
          await provider.deleteFirewallRule(resource, azureFirewallRuleName(parsed.ruleId));
          return removeAzureFirewallRule(before, parsed.ruleId);
        },
      );
    } catch (error) {
      return failure(error, "The firewall rule deletion request was rejected");
    }
  }

  prepareDestroyDeployment(
    input: PrepareDestroyCloudDeploymentInput,
  ): OperationResult<DestroyCloudDeploymentPlan> {
    try {
      this.#assertActive();
      const deployment = this.#requireDeploymentAtRevision(input.deploymentId, input.expectedRevision);
      const token = this.#idFactory();
      if (!isUuidV4(token) || this.#destroyPlans.has(token)) {
        throw new Error("A deployment termination plan could not be created");
      }
      const expiresAt = this.#now() + DESTROY_PLAN_TTL_MS;
      const timer = setTimeout(() => this.#discardDestroyPlan(token), DESTROY_PLAN_TTL_MS);
      timer.unref?.();
      this.#destroyPlans.set(token, {
        token,
        deploymentId: deployment.id,
        expectedRevision: input.expectedRevision,
        expiresAt,
        timer,
      });
      return {
        ok: true,
        value: Object.freeze({
          token,
          deploymentId: deployment.id,
          deploymentName: deployment.name,
          provider: deployment.provider,
          expiresAt: new Date(expiresAt).toISOString(),
        }),
      };
    } catch (error) {
      return failure(error, "The deployment termination plan was rejected");
    }
  }

  async executeDestroyDeployment(
    input: ExecuteDestroyCloudDeploymentInput,
  ): Promise<OperationResult<CloudDeploymentState>> {
    try {
      this.#assertActive();
      if (!isUuidV4(input.token)) throw new TypeError("Invalid deployment termination plan");
      const plan = this.#destroyPlans.get(input.token);
      if (!plan) return { ok: false, error: "The deployment termination plan is invalid or expired" };
      this.#discardDestroyPlan(input.token);
      if (plan.expiresAt <= this.#now()) {
        return { ok: false, error: "The deployment termination plan is invalid or expired" };
      }
      return await this.#serializeDeployment(plan.deploymentId, async () => {
        let operationStarted = false;
        try {
          let deployment = this.#requireDeploymentAtRevision(plan.deploymentId, plan.expectedRevision);
          deployment = await this.#persistPatch(deployment.id, (current) => ({
            ...current,
            status: "deleting",
            phase: "deleting",
            lastError: null,
          }));
          operationStarted = true;
          await this.#destroyProviderResources(deployment);
          await this.#removeOperatorConfig(deployment);
          const deleted = await this.#serializeStateMutation(() => this.#store.delete({
            deploymentId: deployment.id,
            expectedRevision: this.#store.getState().revision,
          }));
          if (!deleted.ok) return deleted;
          this.#discardProvisioningTranscript(deployment.id);
          this.#emitChanged();
          return { ok: true, value: deleted.value };
        } catch (error) {
          const message = cloudErrorMessage(error, "The cloud instance could not be terminated");
          if (operationStarted) await this.#markFailed(plan.deploymentId, message);
          return { ok: false, error: message };
        }
      });
    } catch (error) {
      return failure(error, "The deployment termination was rejected");
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#authLifetime.abort();
    for (const read of this.#refreshReads.values()) read.controller.abort();
    this.#pendingRefreshCredentials.clear();
    this.#pendingRefreshAll = false;
    for (const token of this.#stagedAzureLogins.keys()) this.#discardAzureLogin(token);
    this.#azureLoginGenerations.clear();
    if (this.#transcriptEmitTimer) clearTimeout(this.#transcriptEmitTimer);
    this.#transcriptEmitTimer = undefined;
    for (const token of [...this.#destroyPlans.keys()]) this.#discardDestroyPlan(token);
    for (const token of [...this.#sshHostKeyReviews.keys()]) this.#discardSshHostKeyReview(token);
    this.#issuedSshHostKeyReviewTokens.clear();
    this.#listeners.clear();
    for (const deploymentId of [...this.#provisioningTranscripts.keys()]) {
      this.#discardProvisioningTranscript(deploymentId);
    }
    this.#privateKeys.dispose();
    this.#vault.dispose();
  }

  async #startManagedSshSession(
    target: ManagedSshTarget,
    credentialId: string,
    secret: AwsCredentialSecret | AzureCliCredentialSecret,
  ): Promise<StartedManagedSshSession | SshHostKeyReview> {
    const pinnedFingerprint = this.#sshHostKeys.get(target.deploymentId);
    if (pinnedFingerprint !== undefined) {
      return await this.#startPinnedSshSession(target, credentialId, secret, pinnedFingerprint);
    }

    try {
      const runtime = await this.#startSshTerminalRuntime({
        ssh: sshTerminalTarget(target, secret),
      });
      // The production runtime cannot authenticate an unpinned target. Treat a
      // contrary implementation as unsafe instead of silently bypassing TOFU.
      await runtime.close().catch(() => undefined);
      throw new Error("The SSH server host key could not be verified");
    } catch (error) {
      if (
        error instanceof SshTerminalStartError &&
        error.code === "host-key-approval-required" &&
        error.hostKeySha256 !== undefined &&
        SSH_HOST_KEY_PATTERN.test(error.hostKeySha256)
      ) {
        this.#requireCurrentSshTarget(target.deploymentId, credentialId, undefined, target);
        return this.#issueSshHostKeyReview(target, credentialId, error.hostKeySha256);
      }
      throw new Error(cloudErrorMessage(
        error,
        "The SSH server could not be reached or authenticated",
        credentialValues(secret),
      ));
    }
  }

  async #startPinnedSshSession(
    target: ManagedSshTarget,
    credentialId: string,
    secret: AwsCredentialSecret | AzureCliCredentialSecret,
    fingerprint: string,
  ): Promise<StartedManagedSshSession> {
    let runtime: StartedManagedSshSession["runtime"] | undefined;
    try {
      runtime = await this.#startSshTerminalRuntime({
        ssh: sshTerminalTarget(target, secret, fingerprint),
      });
      this.#assertActive();
      this.#requireCurrentSshTarget(target.deploymentId, credentialId, undefined, target);
      return Object.freeze({ target, runtime });
    } catch (error) {
      await runtime?.close().catch(() => undefined);
      throw new Error(cloudErrorMessage(
        error,
        "The SSH server could not be reached or authenticated",
        credentialValues(secret),
      ));
    }
  }

  #requireCurrentSshTarget(
    deploymentId: string,
    credentialId: string,
    summary?: CloudCredentialSummary,
    expectedTarget?: ManagedSshTarget,
  ): ManagedSshTarget {
    this.#assertActive();
    const state = this.#store.getState();
    const deployment = state.deployments.find(({ id }) => id === deploymentId);
    if (!deployment || deployment.credentialId !== credentialId) throw sshReviewStateChanged();
    let target: ManagedSshTarget;
    if (summary !== undefined) {
      if (summary.id !== credentialId || summary.provider !== deployment.provider) {
        throw sshReviewStateChanged();
      }
      target = managedSshTarget(deployment, summary);
    } else {
      // The exact credential identity is bound separately from the target.
      // Reconstructing with the already-resolved non-secret login avoids
      // keeping a decrypted credential summary outside the vault callback.
      if (expectedTarget === undefined || expectedTarget.provider !== deployment.provider) {
        throw sshReviewStateChanged();
      }
      target = managedSshTargetWithUsername(deployment, expectedTarget.username);
    }
    if (!target.connectable) throw new Error(target.unavailableReason ?? "The managed SSH server is unavailable");
    if (expectedTarget !== undefined && !sameManagedSshTarget(target, expectedTarget)) throw sshReviewStateChanged();
    return target;
  }

  #hasSshIdentityNameCollision(target: ManagedSshTarget): boolean {
    const baseName = canonicalSshIdentityBaseName(target.name);
    return this.#store.getState().deployments.some((deployment) => (
      deployment.id !== target.deploymentId &&
      canonicalSshIdentityBaseName(deployment.name) === baseName
    ));
  }

  #issueSshHostKeyReview(
    target: ManagedSshTarget,
    credentialId: string,
    fingerprint: string,
  ): SshHostKeyReview {
    for (const [token, review] of this.#sshHostKeyReviews) {
      if (review.deploymentId === target.deploymentId) this.#discardSshHostKeyReview(token);
    }
    const token = this.#uniqueSshOpaqueId();
    const expiresAt = this.#now() + SSH_HOST_KEY_REVIEW_TTL_MS;
    if (!Number.isFinite(expiresAt)) throw new Error("The SSH host-key review could not be created");
    const timer = setTimeout(
      () => this.#discardSshHostKeyReview(token),
      Math.max(0, expiresAt - this.#now()),
    );
    timer.unref?.();
    this.#sshHostKeyReviews.set(token, {
      token,
      deploymentId: target.deploymentId,
      credentialId,
      target,
      fingerprint,
      expiresAt,
      timer,
    });
    return Object.freeze({
      token,
      deploymentId: target.deploymentId,
      name: target.name,
      host: target.host,
      port: target.port,
      fingerprint,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  #uniqueSshOpaqueId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.#opaqueIdFactory();
      if (OPAQUE_SSH_ID_PATTERN.test(token) && !this.#issuedSshHostKeyReviewTokens.has(token)) {
        this.#issuedSshHostKeyReviewTokens.add(token);
        return token;
      }
    }
    throw new Error("SSH host-key review identity generation failed");
  }

  #discardSshHostKeyReview(token: string): void {
    const review = this.#sshHostKeyReviews.get(token);
    if (!review) return;
    this.#sshHostKeyReviews.delete(token);
    clearTimeout(review.timer);
  }

  async #provisionAws(deployment: AwsCloudDeploymentRecord): Promise<CloudDeploymentRecord> {
    return await this.#vault.withCredential(deployment.credentialId, "aws", async (secret, summary) => {
      try {
        const provider = this.#awsProviderFactory(await this.#awsConnection(deployment.spec.region, secret, deployment.credentialId));
        await provider.preflight();
        const publicKey = publicKeyForCredential(secret);
        let current = await this.#persistPhase(deployment.id, "creating-instance");
        if (current.provider !== "aws") throw new Error("Cloud deployment provider changed unexpectedly");
        const existingNetwork = current.spec.networkMode === "existing"
          ? await resolveAwsNetwork(provider, current)
          : undefined;
        const resource = await provider.create({
          guid: current.id,
          name: current.name,
          imageId: current.spec.imageId,
          instanceType: current.spec.instanceType,
          ...(existingNetwork ? {
            network: { mode: "existing" as const, ...existingNetwork },
          } : {
            network: {
              mode: "managed" as const,
              vpcCidrBlock: current.spec.managedVpcCidr!,
              subnetCidrBlock: current.spec.managedSubnetCidr!,
            },
          }),
          sshPublicKey: publicKey,
          sshKeyPair: current.spec.sshKeyMode === "existing"
            ? { mode: "existing" as const, name: current.spec.existingKeyPairName! }
            : { mode: "managed" as const },
          ...(current.spec.volumeSizeGiB === null ? {} : { rootVolumeSizeGiB: current.spec.volumeSizeGiB }),
          firewall: awsFirewall(current),
          allocateElasticIp: current.spec.useElasticIp,
        }, async (event) => {
          await this.#persistPatch(deployment.id, (latest) => {
            if (latest.provider !== "aws") throw new Error("Cloud deployment provider changed unexpectedly");
            return applyAwsCreateMutation(latest, event);
          });
        });
        assertAwsReadyForSsh(resource);
        current = await this.#persistPatch(current.id, (latest) => {
          if (latest.provider !== "aws") throw new Error("Cloud deployment provider changed unexpectedly");
          return applyAwsResource(latest, resource, "installing-sliver");
        }) as AwsCloudDeploymentRecord;
        const sshHost = resource.publicIpAddress ?? resource.privateIpAddress;
        if (!sshHost) throw new Error("AWS EC2 did not report an address for SSH provisioning");
        // EC2 public IPv4 addresses can change across stop/start unless an
        // Elastic IP is attached. A primary private address is stable for the
        // instance lifetime, so use it in the operator profile when the user
        // deliberately opts out of an Elastic IP.
        const operatorHost = current.spec.useElasticIp
          ? resource.publicIpAddress ?? resource.privateIpAddress
          : resource.privateIpAddress ?? resource.publicIpAddress;
        if (!operatorHost) throw new Error("AWS EC2 did not report a stable operator address");
        const provisioned = await this.#provisioner.provision({
          deploymentId: current.id,
          operatorEndpointHost: operatorHost,
          multiplayerPort: current.spec.multiplayerPort,
          operatorName: current.spec.operatorName,
          ssh: {
            host: sshHost,
            port: current.spec.sshPort,
            username: current.spec.sshUsername ?? summary.sshUsername,
            privateKey: secret.sshPrivateKey,
            ...(secret.sshPassphrase === null ? {} : { passphrase: secret.sshPassphrase }),
          },
          onOutput: (event) => this.#captureProvisionerOutput(current.id, event),
        });
        return await this.#completeProvisioning(current.id, provisioned);
      } catch (error) {
        throw new Error(cloudErrorMessage(error, "AWS deployment failed", credentialValues(secret)));
      }
    });
  }

  async #provisionAzure(deployment: AzureCloudDeploymentRecord): Promise<CloudDeploymentRecord> {
    return await this.#vault.withCredential(deployment.credentialId, "azure", async (secret) => {
      try {
        const provider = this.#azureProviderFactory(this.#azureConnection(deployment.spec.location, secret, deployment.credentialId));
        const publicKey = publicKeyForCredential(secret);
        let current = await this.#persistPhase(deployment.id, "creating-instance");
        if (current.provider !== "azure") throw new Error("Cloud deployment provider changed unexpectedly");
        let resource = await provider.create({
          guid: current.id,
          name: current.name,
          imageReference: current.spec.imageReference,
          vmSize: current.spec.vmSize,
          network: current.spec.networkMode === "existing"
            ? {
                mode: "existing" as const,
                virtualNetworkId: current.spec.vnetId!,
                subnetId: current.spec.subnetId!,
              }
            : {
                mode: "managed" as const,
                virtualNetworkCidr: current.spec.managedVnetCidr!,
                subnetCidr: current.spec.managedSubnetCidr!,
              },
          sshUsername: current.spec.sshUsername,
          sshPublicKey: publicKey,
          ...(current.spec.osDiskSizeGiB === null ? {} : { osDiskSizeGiB: current.spec.osDiskSizeGiB }),
          firewall: azureFirewall(current),
          allocatePublicIp: current.spec.usePublicIp,
        }, async (event) => {
          const phase: CloudDeploymentPhase = event.phase === "network-security-group"
            ? "configuring-firewall"
            : event.phase === "firewall" || event.phase === "public-ip-address" || event.phase === "network-interface"
              ? "starting-instance"
              : event.phase === "virtual-machine" || event.phase === "os-disk"
                ? "installing-sliver"
                : "creating-instance";
          await this.#persistPatch(deployment.id, (latest) => {
            if (latest.provider !== "azure") throw new Error("Cloud deployment provider changed unexpectedly");
            return applyAzureCreateMutation(latest, event, phase);
          });
        });
        if (current.spec.usePublicIp) {
          resource = await requireAzurePublicIp(
            provider,
            resource,
            this.#azurePublicIpRefreshDelay,
          );
        }
        assertAzureReadyForSsh(resource);
        current = await this.#persistPatch(deployment.id, (latest) => {
          if (latest.provider !== "azure") throw new Error("Cloud deployment provider changed unexpectedly");
          return applyAzureResource(latest, resource, "installing-sliver");
        });
        if (current.provider !== "azure") throw new Error("Cloud deployment provider changed unexpectedly");
        const sshHost = azureConnectionAddress(current.spec.usePublicIp, resource);
        if (!sshHost) {
          throw new Error(current.spec.usePublicIp
            ? "Azure did not report the requested public IP address for SSH provisioning"
            : "Azure did not report a private IP address for SSH provisioning");
        }
        const operatorHost = sshHost;
        const provisioned = await this.#provisioner.provision({
          deploymentId: current.id,
          operatorEndpointHost: operatorHost,
          multiplayerPort: current.spec.multiplayerPort,
          operatorName: current.spec.operatorName,
          ssh: {
            host: sshHost,
            port: current.spec.sshPort,
            username: current.spec.sshUsername,
            privateKey: secret.sshPrivateKey,
            ...(secret.sshPassphrase === null ? {} : { passphrase: secret.sshPassphrase }),
          },
          onOutput: (event) => this.#captureProvisionerOutput(current.id, event),
        });
        return await this.#completeProvisioning(current.id, provisioned);
      } catch (error) {
        throw new Error(cloudErrorMessage(error, "Azure deployment failed", credentialValues(secret)));
      }
    });
  }

  async #completeProvisioning(
    deploymentId: string,
    result: SliverProvisionResult,
  ): Promise<CloudDeploymentRecord> {
    if (result.deploymentId !== deploymentId) throw new Error("Sliver provisioning returned the wrong deployment identity");
    const calculatedDigest = createHash("sha256").update(result.operatorConfig).digest("hex");
    if (calculatedDigest !== result.operatorConfigSha256) {
      result.operatorConfig.fill(0);
      throw new Error("The retrieved Sliver operator configuration failed verification");
    }
    let filePath: string | undefined;
    let createdConfigFile = false;
    try {
      // Provisioning has already authenticated this exact host key. Persist it
      // before exposing the deployment as ready so the first interactive shell
      // never falls back to TOFU for a newly managed server.
      await this.#sshHostKeys.remember(deploymentId, result.hostKeySha256);
      const parsed = parseConfig(result.operatorConfig);
      if (!Number.isSafeInteger(parsed.lport) || parsed.lport < 1 || parsed.lport > 65_535) {
        throw new Error("Sliver returned an invalid operator configuration");
      }
      const fileName = operatorConfigFileName(deploymentId);
      filePath = join(this.#operatorConfigDirectory, fileName);
      await writePrivateFileExclusiveAtomic(filePath, result.operatorConfig);
      createdConfigFile = true;
      const deployment = await this.#persistPatch(deploymentId, (current) => ({
        ...current,
        status: "running",
        phase: "ready",
        operatorConfigFileName: fileName,
        operatorConfigDigest: calculatedDigest,
        lastError: null,
      }));
      filePath = undefined;
      return deployment;
    } finally {
      result.operatorConfig.fill(0);
      if (filePath && createdConfigFile) await unlink(filePath).catch(() => undefined);
    }
  }

  async #runAwsLifecycle(
    deployment: AwsCloudDeploymentRecord,
    action: CloudDeploymentActionInput["action"],
  ): Promise<CloudDeploymentRecord> {
    return await this.#vault.withCredential(deployment.credentialId, "aws", async (secret) => {
      try {
        const provider = this.#awsProviderFactory(await this.#awsConnection(deployment.spec.region, secret, deployment.credentialId));
        const resource = awsResourceFromRecord(deployment);
        const updated = action === "start"
          ? await provider.start(resource)
          : action === "stop"
            ? await provider.stop(resource)
            : await provider.reboot(resource);
        return await this.#persistPatch(deployment.id, (current) => {
          if (current.provider !== "aws") throw new Error("Cloud deployment provider changed unexpectedly");
          return applyAwsResource(
            current,
            updated,
            updated.state === "stopped" ? "stopped" : "ready",
          );
        });
      } catch (error) {
        throw new Error(cloudErrorMessage(error, "AWS lifecycle action failed", credentialValues(secret)));
      }
    });
  }

  async #runAzureLifecycle(
    deployment: AzureCloudDeploymentRecord,
    action: CloudDeploymentActionInput["action"],
  ): Promise<CloudDeploymentRecord> {
    return await this.#vault.withCredential(deployment.credentialId, "azure", async (secret) => {
      try {
        const provider = this.#azureProviderFactory(this.#azureConnection(deployment.spec.location, secret, deployment.credentialId));
        const resource = azureResourceFromRecord(deployment, secret);
        const refreshed = action === "start"
          ? await provider.start(resource)
          : action === "stop"
            ? await provider.stop(resource)
            : await provider.reboot(resource);
        return await this.#persistPatch(deployment.id, (current) => {
          if (current.provider !== "azure") throw new Error("Cloud deployment provider changed unexpectedly");
          return applyAzureResource(
            current,
            refreshed,
            refreshed.instanceState === "deallocated" || refreshed.instanceState === "stopped"
              ? "stopped"
              : "ready",
          );
        });
      } catch (error) {
        throw new Error(cloudErrorMessage(error, "Azure lifecycle action failed", credentialValues(secret)));
      }
    });
  }

  async #updateAwsFirewall(
    deployment: AwsCloudDeploymentRecord,
    input: UpdateCloudFirewallInput,
  ): Promise<CloudDeploymentRecord> {
    return await this.#vault.withCredential(deployment.credentialId, "aws", async (secret) => {
      try {
        const provider = this.#awsProviderFactory(await this.#awsConnection(deployment.spec.region, secret, deployment.credentialId));
        const updated = await provider.replaceFirewall(awsResourceFromRecord(deployment), {
          sshPort: deployment.spec.sshPort,
          sshSourceCidrs: input.sshCidrs,
          multiplayerPort: deployment.spec.multiplayerPort,
          multiplayerSourceCidrs: input.operatorCidrs,
        });
        return await this.#persistPatch(deployment.id, (current) => {
          if (current.provider !== "aws") throw new Error("Cloud deployment provider changed unexpectedly");
          const withResource = applyAwsResource(current, updated, updated.state === "stopped" ? "stopped" : "ready");
          return {
            ...withResource,
            spec: { ...withResource.spec, sshCidrs: input.sshCidrs, operatorCidrs: input.operatorCidrs },
          };
        });
      } catch (error) {
        throw new Error(cloudErrorMessage(error, "AWS firewall update failed", credentialValues(secret)));
      }
    });
  }

  async #updateAzureFirewall(
    deployment: AzureCloudDeploymentRecord,
    input: UpdateCloudFirewallInput,
  ): Promise<CloudDeploymentRecord> {
    return await this.#vault.withCredential(deployment.credentialId, "azure", async (secret) => {
      try {
        const provider = this.#azureProviderFactory(this.#azureConnection(deployment.spec.location, secret, deployment.credentialId));
        const resource = azureResourceFromRecord(deployment, secret);
        const updated = await provider.replaceFirewall(resource, {
          sshPort: deployment.spec.sshPort,
          operatorPort: deployment.spec.multiplayerPort,
          sshSourceCidrs: input.sshCidrs,
          operatorSourceCidrs: input.operatorCidrs,
        });
        return await this.#persistPatch(deployment.id, (current) => {
          if (current.provider !== "azure") throw new Error("Cloud deployment provider changed unexpectedly");
          const withResource = applyAzureResource(
            current,
            updated,
            updated.instanceState === "deallocated" || updated.instanceState === "stopped"
              ? "stopped"
              : "ready",
          );
          return {
            ...withResource,
            lastError: null,
            spec: { ...withResource.spec, sshCidrs: input.sshCidrs, operatorCidrs: input.operatorCidrs },
          };
        });
      } catch (error) {
        throw new Error(cloudErrorMessage(error, "Azure firewall update failed", credentialValues(secret)));
      }
    });
  }

  async #destroyProviderResources(deployment: CloudDeploymentRecord): Promise<void> {
    if (deployment.provider === "aws") {
      if (!hasTrackedAwsResources(deployment)) return;
      await this.#vault.withCredential(deployment.credentialId, "aws", async (secret) => {
        try {
          await this.#awsProviderFactory(await this.#awsConnection(deployment.spec.region, secret, deployment.credentialId))
            .destroy(awsDestroyResourceFromRecord(deployment));
        } catch (error) {
          throw new Error(cloudErrorMessage(error, "AWS resource termination failed", credentialValues(secret)));
        }
      });
      return;
    }
    if (!hasTrackedAzureResources(deployment)) return;
    await this.#vault.withCredential(deployment.credentialId, "azure", async (secret) => {
      try {
        await this.#azureProviderFactory(this.#azureConnection(deployment.spec.location, secret, deployment.credentialId))
          .destroy(azureDestroyResourceFromRecord(deployment, secret));
      } catch (error) {
        throw new Error(cloudErrorMessage(error, "Azure resource termination failed", credentialValues(secret)));
      }
    });
  }

  async #removeOperatorConfig(deployment: CloudDeploymentRecord): Promise<void> {
    if (deployment.operatorConfigFileName === null) return;
    const expected = operatorConfigFileName(deployment.id);
    if (deployment.operatorConfigFileName !== expected) {
      throw new Error("Refusing to remove an operator configuration without the expected deployment identity");
    }
    const path = join(this.#operatorConfigDirectory, expected);
    try {
      const loaded = await readBoundedRegularFile(path, {
        label: "Cloud operator configuration",
        maxBytes: MAX_OPERATOR_CONFIG_BYTES,
        requirePrivateMode: true,
      });
      try {
        const actualDigest = createHash("sha256").update(loaded.data).digest("hex");
        if (actualDigest !== deployment.operatorConfigDigest) {
          throw new Error("Refusing to remove a cloud operator configuration that changed after Cloud Deployment created it");
        }
      } finally {
        loaded.data.fill(0);
      }
      await unlink(path);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  async #assertOperatorNameAvailable(
    deployment: CloudDeploymentRecord,
    operatorName: string,
  ): Promise<void> {
    const expectedFileName = operatorConfigFileName(deployment.id);
    let client: CloudOperatorDirectoryClient | undefined;
    let configBytes: Buffer | undefined;
    try {
      if (
        deployment.operatorConfigFileName !== expectedFileName ||
        deployment.operatorConfigDigest === null
      ) {
        throw operatorDirectoryUnavailable();
      }
      const loaded = await readBoundedRegularFile(
        join(this.#operatorConfigDirectory, expectedFileName),
        {
          label: "Cloud operator configuration",
          maxBytes: MAX_OPERATOR_CONFIG_BYTES,
          requirePrivateMode: true,
        },
      );
      configBytes = loaded.data;
      const actualDigest = createHash("sha256").update(configBytes).digest("hex");
      if (actualDigest !== deployment.operatorConfigDigest) {
        throw operatorDirectoryUnavailable();
      }
      const config = parseConfig(configBytes);
      if (config.operator !== deployment.spec.operatorName) {
        throw operatorDirectoryUnavailable();
      }
      client = this.#operatorDirectoryClientFactory({
        ...config,
        // The saved profile can outlive an instance's original address. The
        // directory lookup must use current managed state, never the editable
        // endpoint supplied by the renderer for the new profile.
        lhost: managedOperatorDirectoryHost(deployment),
        lport: deployment.spec.multiplayerPort,
      });
      await client.connect();
      const operators = await client.getOperators();
      if (operators.Operators.some((operator) => operator.Name === operatorName)) {
        throw new SliverProvisionError(
          "provisioning-failed",
          "That operator already exists on this managed server",
        );
      }
    } catch (error) {
      if (error instanceof SliverProvisionError) throw error;
      throw operatorDirectoryUnavailable();
    } finally {
      try {
        await client?.disconnect();
      } catch {
        throw operatorDirectoryUnavailable();
      } finally {
        configBytes?.fill(0);
      }
    }
  }

  #managedListenerDeployment(input: ManagedListenerFirewallInput): CloudDeploymentRecord {
    const deployment = this.#requireDeployment(input.server.deploymentId);
    if (deployment.provider !== input.server.provider) {
      throw new Error("The managed server provider no longer matches the cloud deployment");
    }
    return deployment;
  }

  async #ensureAwsManagedListenerIngress(
    deployment: AwsCloudDeploymentRecord,
    input: ManagedListenerFirewallInput,
  ): Promise<OperationResult<ManagedListenerFirewallOutcome>> {
    return await this.#vault.withCredential(deployment.credentialId, "aws", async (secret) => {
      try {
        const provider = this.#awsProviderFactory(
          await this.#awsConnection(deployment.spec.region, secret, deployment.credentialId),
        );
        const resource = awsResourceFromRecord(deployment);
        const snapshot = await provider.listFirewallRules(resource);
        const spec = awsManagedListenerFirewallSpec(input);
        const owned = snapshot.rules.filter((rule) => isOwnedAwsManagedListenerRule(rule, spec));
        if (owned.length > 0) {
          return { ok: true, value: managedListenerFirewallOutcome("already-covered", owned.length) };
        }
        const covering = snapshot.rules.filter((rule) => awsFirewallAccessMatches(rule, spec));
        if (covering.length > 0) {
          return { ok: true, value: managedListenerFirewallOutcome("already-covered", covering.length) };
        }

        let created: AwsFirewallRule;
        try {
          created = await provider.createFirewallRule(resource, spec);
        } catch (error) {
          const outcomeError = managedListenerFirewallCreateOutcomeError(
            "AWS",
            error,
            credentialValues(secret),
          );
          try {
            const reconciled = await provider.listFirewallRules(resource);
            const reconciledOwned = reconciled.rules.filter((rule) =>
              isOwnedAwsManagedListenerRule(rule, spec)
            );
            if (reconciledOwned.length > 0) {
              await this.#recordManagedListenerFirewallMutation(deployment.id);
              return {
                ok: true,
                value: managedListenerFirewallOutcome("applied", reconciledOwned.length),
              };
            }
            const reconciledCovering = reconciled.rules.filter((rule) =>
              awsFirewallAccessMatches(rule, spec)
            );
            if (reconciledCovering.length > 0) {
              return {
                ok: true,
                value: managedListenerFirewallOutcome("already-covered", reconciledCovering.length),
              };
            }
          } catch {
            // The create call may have reached AWS even if its response and the
            // reconciliation read both failed. Report an ambiguous outcome so
            // callers do not retry a mutation that may already exist.
          }
          return {
            ok: true,
            value: managedListenerFirewallOutcome("outcome-unknown", 0, outcomeError),
          };
        }
        await this.#recordManagedListenerFirewallMutation(deployment.id);
        if (!isOwnedAwsManagedListenerRule(created, spec)) {
          return {
            ok: true,
            value: managedListenerFirewallOutcome(
              "outcome-unknown",
              1,
              "AWS accepted the firewall mutation but did not return the expected managed rule identity",
            ),
          };
        }
        return { ok: true, value: managedListenerFirewallOutcome("applied", 1) };
      } catch (error) {
        return failure(
          error,
          "The AWS managed listener firewall rule could not be applied",
          credentialValues(secret),
        );
      }
    });
  }

  async #removeAwsManagedListenerIngress(
    deployment: AwsCloudDeploymentRecord,
    input: ManagedListenerFirewallInput,
  ): Promise<OperationResult<ManagedListenerFirewallOutcome>> {
    return await this.#vault.withCredential(deployment.credentialId, "aws", async (secret) => {
      try {
        const provider = this.#awsProviderFactory(
          await this.#awsConnection(deployment.spec.region, secret, deployment.credentialId),
        );
        const resource = awsResourceFromRecord(deployment);
        const snapshot = await provider.listFirewallRules(resource);
        const spec = awsManagedListenerFirewallSpec(input);
        const owned = snapshot.rules.filter((rule) => isOwnedAwsManagedListenerRule(rule, spec));
        if (owned.length === 0) {
          const retained = snapshot.rules.filter((rule) =>
            rule.description === spec.description || awsFirewallAccessMatches(rule, spec)
          );
          return {
            ok: true,
            value: managedListenerFirewallOutcome(
              retained.length > 0 ? "retained" : "not-found",
              retained.length,
            ),
          };
        }

        let removed = 0;
        for (const rule of owned) {
          if (await provider.deleteFirewallRuleIfMatches(resource, rule.id, spec)) removed += 1;
        }
        if (removed === 0) {
          return { ok: true, value: managedListenerFirewallOutcome("retained", owned.length) };
        }
        await this.#recordManagedListenerFirewallMutation(deployment.id);
        if (removed !== owned.length) {
          return {
            ok: true,
            value: managedListenerFirewallOutcome(
              "outcome-unknown",
              removed,
              "Some AWS listener firewall rules changed while they were being removed",
            ),
          };
        }
        return { ok: true, value: managedListenerFirewallOutcome("removed", removed) };
      } catch (error) {
        return failure(
          error,
          "The AWS managed listener firewall rule could not be removed",
          credentialValues(secret),
        );
      }
    });
  }

  async #ensureAzureManagedListenerIngress(
    deployment: AzureCloudDeploymentRecord,
    input: ManagedListenerFirewallInput,
  ): Promise<OperationResult<ManagedListenerFirewallOutcome>> {
    return await this.#vault.withCredential(deployment.credentialId, "azure", async (secret) => {
      try {
        const provider = this.#azureProviderFactory(
          this.#azureConnection(deployment.spec.location, secret, deployment.credentialId),
        );
        const resource = azureResourceFromRecord(deployment, secret);
        const snapshot = await provider.listFirewallRules(resource);
        const identity = azureManagedListenerFirewallIdentity(input);
        const owned = snapshot.rules.filter((rule) => isOwnedAzureManagedListenerRule(rule, identity));
        if (owned.length > 0) {
          return { ok: true, value: managedListenerFirewallOutcome("already-covered", owned.length) };
        }
        const covering = snapshot.rules.filter((rule) => azureFirewallAccessMatches(rule, identity));
        if (covering.length > 0) {
          return { ok: true, value: managedListenerFirewallOutcome("already-covered", covering.length) };
        }
        if (snapshot.rules.some((rule) => rule.name.toLowerCase() === identity.name.toLowerCase())) {
          return {
            ok: false,
            error: "The reserved Azure firewall rule name is already used by a different rule",
          };
        }
        const priority = firstAvailableAzureManagedListenerPriority(snapshot);
        if (priority === null) {
          return { ok: false, error: "No Azure firewall rule priority is available for this listener" };
        }

        const spec: AzureFirewallRuleSpec = { ...identity, priority };
        let created: AzureFirewallRule;
        try {
          created = await provider.createFirewallRule(resource, spec);
        } catch (error) {
          const outcomeError = managedListenerFirewallCreateOutcomeError(
            "Azure",
            error,
            credentialValues(secret),
          );
          try {
            const reconciled = await provider.listFirewallRules(resource);
            const reconciledOwned = reconciled.rules.filter((rule) =>
              isOwnedAzureManagedListenerRule(rule, identity)
            );
            if (reconciledOwned.length > 0) {
              await this.#recordManagedListenerFirewallMutation(deployment.id);
              return {
                ok: true,
                value: managedListenerFirewallOutcome("applied", reconciledOwned.length),
              };
            }
            const reconciledCovering = reconciled.rules.filter((rule) =>
              azureFirewallAccessMatches(rule, identity)
            );
            if (reconciledCovering.length > 0) {
              return {
                ok: true,
                value: managedListenerFirewallOutcome("already-covered", reconciledCovering.length),
              };
            }
          } catch {
            // The create call may have reached Azure even if its response and
            // the reconciliation read both failed. Preserve that uncertainty.
          }
          return {
            ok: true,
            value: managedListenerFirewallOutcome("outcome-unknown", 0, outcomeError),
          };
        }
        await this.#recordManagedListenerFirewallMutation(deployment.id);
        if (!isOwnedAzureManagedListenerRule(created, identity)) {
          return {
            ok: true,
            value: managedListenerFirewallOutcome(
              "outcome-unknown",
              1,
              "Azure accepted the firewall mutation but did not return the expected managed rule identity",
            ),
          };
        }
        return { ok: true, value: managedListenerFirewallOutcome("applied", 1) };
      } catch (error) {
        return failure(
          error,
          "The Azure managed listener firewall rule could not be applied",
          credentialValues(secret),
        );
      }
    });
  }

  async #removeAzureManagedListenerIngress(
    deployment: AzureCloudDeploymentRecord,
    input: ManagedListenerFirewallInput,
  ): Promise<OperationResult<ManagedListenerFirewallOutcome>> {
    return await this.#vault.withCredential(deployment.credentialId, "azure", async (secret) => {
      try {
        const provider = this.#azureProviderFactory(
          this.#azureConnection(deployment.spec.location, secret, deployment.credentialId),
        );
        const resource = azureResourceFromRecord(deployment, secret);
        const snapshot = await provider.listFirewallRules(resource);
        const identity = azureManagedListenerFirewallIdentity(input);
        const owned = snapshot.rules.filter((rule) => isOwnedAzureManagedListenerRule(rule, identity));
        if (owned.length === 0) {
          const retainedIds = new Set(
            snapshot.rules
              .filter((rule) =>
                rule.name.toLowerCase() === identity.name.toLowerCase() ||
                rule.description === identity.description ||
                azureFirewallAccessMatches(rule, identity)
              )
              .map(({ id }) => id),
          );
          return {
            ok: true,
            value: managedListenerFirewallOutcome(
              retainedIds.size > 0 ? "retained" : "not-found",
              retainedIds.size,
            ),
          };
        }

        const deleted = await provider.deleteFirewallRuleIfMatches(
          resource,
          owned[0]!.name,
          azureFirewallSpecFromRule(owned[0]!),
        );
        if (!deleted) {
          return { ok: true, value: managedListenerFirewallOutcome("retained", owned.length) };
        }
        await this.#recordManagedListenerFirewallMutation(deployment.id);
        return { ok: true, value: managedListenerFirewallOutcome("removed", 1) };
      } catch (error) {
        return failure(
          error,
          "The Azure managed listener firewall rule could not be removed",
          credentialValues(secret),
        );
      }
    });
  }

  async #recordManagedListenerFirewallMutation(deploymentId: string): Promise<void> {
    try {
      await this.#persistPatch(deploymentId, (current) => current);
    } catch {
      // The provider mutation is already complete. A local revision-journal
      // failure cannot safely turn it into a retryable remote mutation.
    }
  }

  async #mutateAwsFirewall(
    deploymentId: string,
    expectedRevision: number,
    fallback: string,
    mutate: (
      provider: CloudAwsProvider,
      resource: AwsEc2DeploymentResource,
      before: AwsFirewallSnapshot,
    ) => Promise<AwsFirewallSnapshot>,
  ): Promise<OperationResult<AwsFirewallSnapshot>> {
    return await this.#serializeDeployment(deploymentId, async () => {
      try {
        const deployment = this.#requireDeploymentAtRevision(deploymentId, expectedRevision);
        if (deployment.provider !== "aws") {
          throw new Error("Firewall rule management is only available for AWS deployments");
        }
        if (deployment.status === "provisioning" || deployment.status === "deleting") {
          return { ok: false, error: "The deployment is busy" };
        }
        return await this.#vault.withCredential(deployment.credentialId, "aws", async (secret) => {
          try {
            const provider = this.#awsProviderFactory(
              await this.#awsConnection(deployment.spec.region, secret, deployment.credentialId),
            );
            const resource = awsResourceFromRecord(deployment);
            const before = await provider.listFirewallRules(resource);
            const fallbackSnapshot = await mutate(provider, resource, before);

            let refreshedResource = resource;
            try {
              const updated = await this.#persistPatch(deployment.id, (current) => current);
              if (updated.provider === "aws") {
                refreshedResource = awsResourceFromRecord(updated);
              }
            } catch {
              // The AWS mutation is already complete and no deployment fields
              // changed. A local revision-journal failure must not turn that
              // confirmed remote success into a retryable mutation failure.
            }
            try {
              return { ok: true, value: await provider.listFirewallRules(refreshedResource) };
            } catch {
              // Preserve a truthful result when the post-mutation inventory
              // refresh is transiently unavailable.
              return { ok: true, value: fallbackSnapshot };
            }
          } catch (error) {
            return failure(error, fallback, credentialValues(secret));
          }
        });
      } catch (error) {
        return failure(error, fallback);
      }
    });
  }

  async #mutateAzureFirewall(
    deploymentId: string,
    expectedRevision: number,
    fallback: string,
    mutate: (
      provider: CloudAzureProvider,
      resource: AzureVmDeploymentResource,
      before: AzureFirewallSnapshot,
    ) => Promise<AzureFirewallSnapshot>,
  ): Promise<OperationResult<AzureFirewallSnapshot>> {
    return await this.#serializeDeployment(deploymentId, async () => {
      try {
        const deployment = this.#requireDeploymentAtRevision(deploymentId, expectedRevision);
        if (deployment.provider !== "azure") throw new Error("Expected an Azure deployment");
        if (deployment.status === "provisioning" || deployment.status === "deleting") {
          return { ok: false, error: "The deployment is busy" };
        }
        return await this.#vault.withCredential(deployment.credentialId, "azure", async (secret) => {
          try {
            const provider = this.#azureProviderFactory(this.#azureConnection(deployment.spec.location, secret, deployment.credentialId));
            const resource = azureResourceFromRecord(deployment, secret);
            const before = await provider.listFirewallRules(resource);
            const fallbackSnapshot = await mutate(provider, resource, before);
            let refreshedResource = resource;
            try {
              const updated = await this.#persistPatch(deployment.id, (current) => current);
              if (updated.provider === "azure") refreshedResource = azureResourceFromRecord(updated, secret);
            } catch {
              // The provider mutation is already complete. Preserve the
              // confirmed result if only the local revision journal failed.
            }
            try {
              return { ok: true, value: await provider.listFirewallRules(refreshedResource) };
            } catch {
              return { ok: true, value: fallbackSnapshot };
            }
          } catch (error) {
            return failure(error, fallback, credentialValues(secret));
          }
        });
      } catch (error) {
        return failure(error, fallback);
      }
    });
  }

  #requireDeployment(deploymentId: string): CloudDeploymentRecord {
    if (!isUuidV4(deploymentId)) throw new TypeError("Invalid cloud deployment identity");
    const deployment = this.#store.getState().deployments.find(({ id }) => id === deploymentId);
    if (!deployment) throw new Error("The cloud deployment no longer exists");
    return deployment;
  }

  async #requireMatchingCredential(credentialId: string, provider: "aws" | "azure"): Promise<void> {
    if (provider === "aws") {
      await this.#vault.withCredential(credentialId, "aws", () => undefined);
    } else {
      await this.#vault.withCredential(credentialId, "azure", () => undefined);
    }
  }

  #requireDeploymentAtRevision(deploymentId: string, expectedRevision: number): CloudDeploymentRecord {
    if (!isUuidV4(deploymentId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("Invalid cloud deployment identity or revision");
    }
    const state = this.#store.getState();
    if (state.revision !== expectedRevision) {
      throw new Error("Cloud deployment state changed in another window. Review the latest state and try again.");
    }
    const deployment = state.deployments.find(({ id }) => id === deploymentId);
    if (!deployment) throw new Error("The cloud deployment no longer exists");
    return deployment;
  }

  async #persistPhase(deploymentId: string, phase: CloudDeploymentPhase): Promise<CloudDeploymentRecord> {
    return this.#persistPatch(deploymentId, (current) => ({ ...current, phase, lastError: null }));
  }

  async #persistPatch(
    deploymentId: string,
    mutate: (current: CloudDeploymentRecord) => CloudDeploymentRecord,
  ): Promise<CloudDeploymentRecord> {
    return this.#serializeStateMutation(async () => {
      this.#assertActive();
      const state = this.#store.getState();
      const current = state.deployments.find(({ id }) => id === deploymentId);
      if (!current) throw new Error("The cloud deployment no longer exists");
      const updated = await this.#store.update({ expectedRevision: state.revision, deployment: mutate(current) });
      if (!updated.ok) throw new Error(updated.error);
      this.#emitChanged();
      return updated.value.deployment;
    });
  }

  async #markFailed(deploymentId: string, message: string): Promise<void> {
    if (!this.#store.getState().deployments.some(({ id }) => id === deploymentId)) return;
    await this.#persistPatch(deploymentId, (current) => ({
      ...current,
      status: "failed",
      phase: "failed",
      lastError: message,
    })).catch(() => undefined);
  }

  #serializeDeployment<T>(deploymentId: string, operation: () => Promise<T>): Promise<T> {
    this.#busyDeployments.set(deploymentId, (this.#busyDeployments.get(deploymentId) ?? 0) + 1);
    this.#deploymentRefreshGenerations.set(deploymentId, (this.#deploymentRefreshGenerations.get(deploymentId) ?? 0) + 1);
    this.#refreshReads.get(deploymentId)?.controller.abort();
    const run = async () => {
      try { return await operation(); }
      finally {
        const remaining = (this.#busyDeployments.get(deploymentId) ?? 1) - 1;
        if (remaining > 0) this.#busyDeployments.set(deploymentId, remaining);
        else this.#busyDeployments.delete(deploymentId);
      }
    };
    const result = this.#transitionChain.then(run, run);
    this.#transitionChain = result.then(() => undefined, () => undefined);
    return result;
  }

  #serializeStateMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#stateMutationChain.then(operation);
    this.#stateMutationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  #canPersistCredentials(): boolean {
    try {
      return this.#vault.supportsSecurePersistence();
    } catch {
      return false;
    }
  }

  #beginProvisioningTranscript(deploymentId: string): void {
    for (const [id, transcript] of this.#provisioningTranscripts) {
      if (transcript.status === "complete") this.#discardProvisioningTranscript(id);
    }
    while (this.#provisioningTranscripts.size >= MAX_PROVISIONING_TRANSCRIPTS) {
      const oldest = this.#provisioningTranscripts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#discardProvisioningTranscript(oldest);
    }
    this.#provisioningTranscripts.set(deploymentId, {
      deploymentId,
      status: "streaming",
      truncated: false,
      byteLength: 0,
      nextSequence: 0,
      headIndex: 0,
      chunks: [],
    });
  }

  #captureProvisionerOutput(deploymentId: string, event: SliverProvisionOutputEvent): void {
    const bytes = event.type === "stage"
      ? Buffer.from(`\r\n==> ${event.label}\r\n`, "utf8")
      : event.chunk;
    this.#appendProvisioningTranscript(deploymentId, bytes);
  }

  #appendProvisioningTranscript(deploymentId: string, bytes: Uint8Array): void {
    const transcript = this.#provisioningTranscripts.get(deploymentId);
    if (!transcript || transcript.status !== "streaming" || bytes.byteLength === 0) return;
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_PROVISIONING_TRANSCRIPT_CHUNK_BYTES) {
      const chunk = Uint8Array.from(bytes.subarray(
        offset,
        Math.min(offset + MAX_PROVISIONING_TRANSCRIPT_CHUNK_BYTES, bytes.byteLength),
      ));
      transcript.chunks.push({ sequence: transcript.nextSequence, bytes: chunk });
      transcript.nextSequence += 1;
      transcript.byteLength += chunk.byteLength;
    }
    while (
      transcript.chunks.length - transcript.headIndex > MAX_PROVISIONING_TRANSCRIPT_CHUNKS ||
      transcript.byteLength > MAX_PROVISIONING_TRANSCRIPT_BYTES
    ) {
      const removed = transcript.chunks[transcript.headIndex];
      if (!removed) break;
      transcript.headIndex += 1;
      transcript.byteLength -= removed.bytes.byteLength;
      removed.bytes.fill(0);
      transcript.truncated = true;
    }
    if (
      transcript.headIndex >= MAX_PROVISIONING_TRANSCRIPT_CHUNKS &&
      transcript.headIndex * 2 >= transcript.chunks.length
    ) {
      transcript.chunks.splice(0, transcript.headIndex);
      transcript.headIndex = 0;
    }
    this.#scheduleTranscriptChanged();
  }

  #finishProvisioningTranscript(
    deploymentId: string,
    status: "complete" | "failed",
  ): void {
    const transcript = this.#provisioningTranscripts.get(deploymentId);
    if (!transcript) return;
    transcript.status = status;
    this.#emitChanged("transcripts");
  }

  #scheduleTranscriptChanged(): void {
    if (this.#transcriptEmitTimer || this.#disposed) return;
    this.#transcriptEmitTimer = setTimeout(() => {
      this.#transcriptEmitTimer = undefined;
      if (!this.#disposed) this.#emitChanged("transcripts");
    }, PROVISIONING_TRANSCRIPT_EMIT_DELAY_MS);
    this.#transcriptEmitTimer.unref?.();
  }

  #discardProvisioningTranscript(deploymentId: string): void {
    const transcript = this.#provisioningTranscripts.get(deploymentId);
    if (!transcript) return;
    this.#provisioningTranscripts.delete(deploymentId);
    for (const { bytes } of transcript.chunks) bytes.fill(0);
    transcript.chunks = [];
    transcript.headIndex = 0;
    transcript.byteLength = 0;
  }

  #emitChanged(scope: CloudDeploymentChangeScope = "snapshot"): void {
    for (const listener of this.#listeners) {
      try {
        listener(scope);
      } catch {
        // A UI subscriber must not interrupt durable state transitions.
      }
    }
  }

  #discardDestroyPlan(token: string): void {
    const plan = this.#destroyPlans.get(token);
    if (!plan) return;
    this.#destroyPlans.delete(token);
    clearTimeout(plan.timer);
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Cloud deployment service is disposed");
  }

  async #awsConnection(
    region: string,
    secret: AwsCredentialSecret,
    credentialId: string,
  ): Promise<AwsEc2ProviderConnection> {
    if ("profileName" in secret && !secret.loginSession) {
      return { region, credentials: await this.#awsProfiles.credentialProvider(secret.profileName, region) };
    }
    if (!("accessKeyId" in secret)) {
      return { region, credentials: () => this.#resolveAwsCredentials(credentialId, region) };
    }
    return {
      region,
      credentials: {
        accessKeyId: secret.accessKeyId,
        secretAccessKey: secret.secretAccessKey,
        ...(secret.sessionToken === null ? {} : { sessionToken: secret.sessionToken }),
      },
    };
  }

  async #resolveAwsCredentials(credentialId: string, region: string): Promise<AwsEc2Credentials> {
    this.#assertActive();
    return this.#vault.withCredential(credentialId, "aws", async (secret) => {
      if ("accessKeyId" in secret) throw new Error("The AWS credential source changed. Try again.");
      if ("profileName" in secret) {
        try {
          const credentials = await (await this.#awsProfiles.credentialProvider(secret.profileName, region))();
          if (credentials.expiration && credentials.expiration.getTime() <= this.#now()) {
            throw new Error("The AWS shared profile credentials expired");
          }
          return credentials;
        } catch (error) {
          if (!secret.loginSession) throw error;
        }
      }
      if (!secret.loginSession) throw new Error("Use AWS Login to sign in again.");
      if (Date.parse(secret.loginSession.expiresAt) > this.#now() + 60_000) return awsSessionCredentials(secret.loginSession);
      let refreshing = this.#awsRefreshes.get(credentialId);
      if (!refreshing) {
        refreshing = (async () => {
          try {
            const refreshed = parseAwsConsoleLoginSession(await this.#awsConsoleLogin.refresh(secret.loginSession!, this.#authLifetime.signal));
            this.#assertActive();
            this.#authLifetime.signal.throwIfAborted();
            if (refreshed.loginSessionArn !== secret.loginSession!.loginSessionArn || refreshed.region !== secret.loginSession!.region) {
              throw new Error("AWS login refresh returned a different identity");
            }
            await this.#vault.updateAwsLoginSession(credentialId, secret, refreshed, this.#authLifetime.signal);
          } catch {
            throw new AwsConsoleLoginError("login-required", "AWS login could not be refreshed. Use AWS Login to sign in again.");
          }
        })();
        this.#awsRefreshes.set(credentialId, refreshing);
        void refreshing.finally(() => {
          if (this.#awsRefreshes.get(credentialId) === refreshing) this.#awsRefreshes.delete(credentialId);
        }).catch(() => undefined);
      }
      await refreshing;
      return this.#vault.withCredential(credentialId, "aws", (current) => {
        if (!("loginSession" in current) || !current.loginSession) throw new Error("Use AWS Login to sign in again.");
        return awsSessionCredentials(current.loginSession);
      });
    });
  }

  #azureConnection(
    location: string,
    secret: AzureCliCredentialSecret,
    credentialId: string,
  ): AzureVmProviderConnection {
    return {
      subscriptionId: secret.subscriptionId,
      tenantId: secret.tenantId,
      location,
      credential: secret.loginSession ? {
        getToken: (scopes, options) => this.#resolveAzureToken(credentialId, scopes, options),
      } : this.#azureCliCredentialFactory(secret),
    };
  }

  async #resolveAzureToken(
    credentialId: string,
    scopes: Parameters<TokenCredential["getToken"]>[0],
    options: Parameters<TokenCredential["getToken"]>[1],
  ): Promise<AzureAccessToken> {
    this.#assertActive();
    const requested = typeof scopes === "string" ? [scopes] : scopes;
    if (requested.length !== 1 || requested[0] !== "https://management.azure.com/.default") {
      throw new AzureBrowserLoginError("invalid-input", "Azure Login supports Azure Resource Manager access only.");
    }
    return this.#vault.withCredential(credentialId, "azure", async (secret) => {
      if (options?.tenantId && !sameAzureGuid(options.tenantId, secret.tenantId)) {
        throw new AzureBrowserLoginError("invalid-input", "Azure Login cannot access a different tenant.");
      }
      if (options?.abortSignal?.aborted) throw new AzureBrowserLoginError("cancelled", "Azure token request was cancelled.");
      if (secret.authentication !== "login") {
        try {
          const token = await this.#azureCliCredentialFactory(secret).getToken(scopes, options);
          if (!token || !Number.isFinite(token.expiresOnTimestamp) || token.expiresOnTimestamp <= this.#now()) throw new Error("Azure CLI token expired");
          return token;
        } catch (error) {
          if (!secret.loginSession) throw error;
        }
      }
      if (options?.claims) {
        throw new AzureBrowserLoginError("login-required", "Azure requires interactive authentication. Use Azure Login to sign in again.");
      }
      const session = secret.loginSession;
      if (!session) throw new AzureBrowserLoginError("login-required", "Use Azure Login to sign in again.");
      let refreshing = this.#azureRefreshes.get(credentialId);
      if (!refreshing) {
        refreshing = (async () => {
          try {
            const result = await this.#azureBrowserLogin.getToken(session, this.#authLifetime.signal);
            const refreshed = parseAzureBrowserLoginSession(result.session);
            this.#assertActive();
            this.#authLifetime.signal.throwIfAborted();
            if (!sameAzureLoginIdentity(session, refreshed) || typeof result.token !== "string" || result.token.length < 1 || result.token.length > 64 * 1024 || !Number.isFinite(result.expiresOnTimestamp) || result.expiresOnTimestamp <= this.#now()) {
              throw new Error("Azure Login returned an invalid token or account");
            }
            if (JSON.stringify(refreshed) !== JSON.stringify(session)) {
              await this.#vault.updateAzureLoginSession(credentialId, secret, refreshed, this.#authLifetime.signal);
            }
            return await this.#vault.withCredential(credentialId, "azure", (current) => {
              if (!current.loginSession || JSON.stringify(current.loginSession) !== JSON.stringify(refreshed)) throw new Error("Azure Login changed during token refresh");
              return { token: result.token, expiresOnTimestamp: result.expiresOnTimestamp };
            });
          } catch {
            throw new AzureBrowserLoginError("login-required", "Azure login could not be refreshed. Use Azure Login to sign in again.");
          }
        })();
        this.#azureRefreshes.set(credentialId, refreshing);
        void refreshing.finally(() => {
          if (this.#azureRefreshes.get(credentialId) === refreshing) this.#azureRefreshes.delete(credentialId);
        }).catch(() => undefined);
      }
      const token = await refreshing;
      if (options?.abortSignal?.aborted) throw new AzureBrowserLoginError("cancelled", "Azure token request was cancelled.");
      return token;
    });
  }

}

function isRefreshableDeployment(record: CloudDeploymentRecord): boolean {
  return record.status !== "provisioning" &&
    record.status !== "deleting" &&
    record.operatorConfigFileName !== null &&
    record.operatorConfigDigest !== null;
}

function canRecoverLegacyReadFailure(record: CloudDeploymentRecord): boolean {
  if (record.status !== "failed" || !record.lastError || !isRefreshableDeployment(record)) return false;
  // Legacy records did not preserve the failed operation's origin. Only these
  // known read messages are safe to recover after a successful full provider read.
  return /^(?:AWS EC2 could not (?:read the managed (?:instance|security group|Elastic IP)|read instance health)|Azure could not read the managed (?:virtual machine|network security group|network interface|public IP address|OS disk))(?: \([A-Za-z0-9_. ,:-]+\))?\.(?: (?:Refresh the selected AWS CLI profile with `aws login` and try again\.|Use (?:AWS|Azure) Login to renew this credential, or refresh its (?:AWS|Azure) CLI sign-in, and try again\.))?$/u.test(record.lastError);
}

function observedDeploymentState(
  record: CloudDeploymentRecord,
  state: "running" | "stopped" | undefined,
): Pick<CloudDeploymentRecord, "status" | "phase" | "lastError"> {
  if (!state || (record.status === "failed" && !canRecoverLegacyReadFailure(record))) {
    return { status: record.status, phase: record.phase, lastError: record.lastError };
  }
  return { status: state, phase: state === "stopped" ? "stopped" : "ready", lastError: null };
}

function applyAwsStatusObservation(
  record: AwsCloudDeploymentRecord,
  resource: AwsEc2DeploymentResource,
): AwsCloudDeploymentRecord {
  const state = resource.state === "running"
    ? "running"
    : resource.state === "stopped" ? "stopped" : undefined;
  return {
    ...record,
    ...observedDeploymentState(record, state),
    name: resource.name,
    remoteHost: resource.publicIpAddress ?? resource.privateIpAddress ?? null,
    runtime: {
      ...record.runtime,
      instanceState: resource.state,
      instanceHealth: resource.instanceHealth,
      systemHealth: resource.systemHealth,
      availabilityZone: resource.availabilityZone ?? null,
      publicIpAddress: resource.publicIpAddress ?? null,
      privateIpAddress: resource.privateIpAddress ?? null,
    },
  };
}

function applyAzureStatusObservation(
  record: AzureCloudDeploymentRecord,
  resource: AzureVmDeploymentResource,
): AzureCloudDeploymentRecord {
  const state = resource.instanceState === "running"
    ? "running"
    : resource.instanceState === "stopped" || resource.instanceState === "deallocated" ? "stopped" : undefined;
  return {
    ...record,
    ...observedDeploymentState(record, state),
    name: resource.name,
    remoteHost: azureConnectionAddress(record.spec.usePublicIp, resource) ?? null,
    runtime: {
      ...record.runtime,
      instanceState: resource.instanceState,
      provisioningState: resource.provisioningState ?? null,
      publicIpAddress: resource.publicIpAddress ?? null,
      privateIpAddress: resource.privateIpAddress ?? null,
    },
  };
}

function managedSshTarget(
  deployment: CloudDeploymentRecord,
  credential: CloudCredentialSummary,
): ManagedSshTarget {
  if (credential.id !== deployment.credentialId || credential.provider !== deployment.provider) {
    throw new Error("The managed SSH credential no longer matches this server");
  }
  const username = deployment.provider === "aws"
    ? deployment.spec.sshUsername ?? credential.sshUsername
    : deployment.spec.sshUsername;
  return managedSshTargetWithUsername(deployment, username);
}

function hasStableRunningRuntime(deployment: CloudDeploymentRecord): boolean {
  return deployment.status === "running" && deployment.runtime.instanceState === "running";
}

function managedOperatorDirectoryHost(deployment: CloudDeploymentRecord): string {
  const host = deployment.provider === "azure"
    ? azureConnectionAddress(deployment.spec.usePublicIp, deployment.runtime)
    : deployment.runtime.publicIpAddress ??
      deployment.runtime.privateIpAddress ??
      deployment.remoteHost;
  if (!host) throw operatorDirectoryUnavailable();
  return host;
}

function isManagedOperatorRecoveryPath(deploymentId: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const prefix = `/var/lib/sliver-gui/${deploymentId}/operator-export/operator-`;
  return value.startsWith(prefix) && /^[0-9a-f]{16,64}\.cfg$/u.test(value.slice(prefix.length));
}

function isManagedOperatorHandoffPath(deploymentId: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const prefix = `/tmp/.sliver-gui-${deploymentId}-`;
  return value.startsWith(prefix) && /^[0-9a-f]{16,64}\.operator\.cfg$/u.test(value.slice(prefix.length));
}

function managedSshTargetWithUsername(
  deployment: CloudDeploymentRecord,
  username: string,
): ManagedSshTarget {
  const host = deployment.provider === "azure"
    ? azureConnectionAddress(deployment.spec.usePublicIp, deployment.runtime) ?? ""
    : deployment.runtime.publicIpAddress ??
      deployment.runtime.privateIpAddress ??
      deployment.remoteHost ??
      "";
  const port = deployment.spec.sshPort;
  const unavailableReason = sshUnavailableReason(deployment.status, host);
  return Object.freeze({
    deploymentId: deployment.id,
    name: deployment.name,
    provider: deployment.provider,
    host,
    port,
    username,
    status: deployment.status,
    connectable: unavailableReason === undefined,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  });
}

function sshUnavailableReason(
  status: CloudDeploymentRecord["status"],
  host: string,
): string | undefined {
  if (status === "running" && host !== "") return undefined;
  if (status === "running") return "This server does not have an SSH address yet";
  if (status === "stopped") return "Start this server before opening SSH";
  if (status === "provisioning") return "This server is still being provisioned";
  if (status === "deleting") return "This server is being terminated";
  return "Resolve this server's deployment error before opening SSH";
}

function sshTerminalTarget(
  target: ManagedSshTarget,
  secret: AwsCredentialSecret | AzureCliCredentialSecret,
  fingerprint?: string,
): StartSshTerminalRuntimeOptions["ssh"] {
  return {
    host: target.host,
    port: target.port,
    username: target.username,
    privateKey: secret.sshPrivateKey,
    ...(secret.sshPassphrase === null ? {} : { passphrase: secret.sshPassphrase }),
    ...(fingerprint === undefined ? {} : { hostKeySha256: fingerprint }),
  };
}

function sameManagedSshTarget(left: ManagedSshTarget, right: ManagedSshTarget): boolean {
  return left.deploymentId === right.deploymentId &&
    left.name === right.name &&
    left.provider === right.provider &&
    left.host === right.host &&
    left.port === right.port &&
    left.username === right.username &&
    left.status === right.status &&
    left.connectable === right.connectable &&
    left.unavailableReason === right.unavailableReason;
}

function sshReviewStateChanged(): Error {
  return new Error("The managed SSH server changed. Review the latest server details and try again.");
}

function snapshotTranscript(transcript: MutableProvisioningTranscript): CloudProvisioningTranscript {
  return Object.freeze({
    deploymentId: transcript.deploymentId,
    status: transcript.status,
    truncated: transcript.truncated,
    chunks: Object.freeze(transcript.chunks.slice(transcript.headIndex).map(({ sequence, bytes }) => Object.freeze({
      sequence,
      bytes: Uint8Array.from(bytes),
    }))),
  });
}

function permissionSummary(
  provider: string,
  permissions: CloudPermissionEvaluation,
  noun: string,
  prerequisite?: string,
): string {
  const verified = `${permissions.verified.length}/${permissions.required.length} required ${noun}${permissions.required.length === 1 ? "" : "s"} verified`;
  const qualifiers = [
    permissions.missing.length > 0
      ? `${permissions.missing.length} missing`
      : undefined,
    permissions.unverifiable.length > 0
      ? `${permissions.unverifiable.length} require resource-specific validation`
      : undefined,
    prerequisite,
  ].filter((value): value is string => value !== undefined);
  return `${provider}: ${verified}${qualifiers.length > 0 ? `; ${qualifiers.join("; ")}` : ""}`;
}

function validateManagedListenerFirewallInput(
  input: ManagedListenerFirewallInput,
): ManagedListenerFirewallInput {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.server !== "object" ||
    input.server === null ||
    !isUuidV4(input.server.deploymentId) ||
    (input.server.provider !== "aws" && input.server.provider !== "azure") ||
    typeof input.server.name !== "string" ||
    input.server.name.length < 1 ||
    input.server.name.length > 255 ||
    input.server.name.trim() !== input.server.name ||
    (input.protocol !== "tcp" && input.protocol !== "udp") ||
    !Number.isSafeInteger(input.port) ||
    input.port < 1 ||
    input.port > 65_535
  ) {
    throw new TypeError("Invalid managed listener firewall input");
  }
  return Object.freeze({
    server: Object.freeze({ ...input.server }),
    protocol: input.protocol,
    port: input.port,
  });
}

function managedListenerFirewallDescription(input: ManagedListenerFirewallInput): string {
  return `sliver-gui:${input.server.deploymentId}:listener:${input.protocol}:${input.port}`;
}

function managedListenerFirewallOutcome(
  status: ManagedListenerFirewallOutcome["status"],
  ruleCount: number,
  error?: string,
): ManagedListenerFirewallOutcome {
  return Object.freeze({ status, ruleCount, ...(error === undefined ? {} : { error }) });
}

function managedListenerFirewallCreateOutcomeError(
  provider: "AWS" | "Azure",
  error: unknown,
  secrets: readonly string[],
): string {
  const fallback = `${provider} did not confirm whether the listener firewall rule was created`;
  const detail = cloudErrorMessage(error, fallback, secrets);
  return detail === fallback
    ? fallback
    : cloudErrorMessage(new Error(`${fallback}: ${detail}`), fallback, secrets);
}

function awsManagedListenerFirewallSpec(
  input: ManagedListenerFirewallInput,
): AwsFirewallRuleSpec {
  return Object.freeze({
    direction: "ingress",
    protocol: input.protocol,
    fromPort: input.port,
    toPort: input.port,
    peerType: "ipv4",
    peer: MANAGED_LISTENER_FIREWALL_SOURCE,
    description: managedListenerFirewallDescription(input),
  });
}

function awsFirewallAccessMatches(
  rule: AwsFirewallRule,
  expected: AwsFirewallRuleSpec,
): boolean {
  return rule.direction === expected.direction &&
    rule.protocol === expected.protocol &&
    rule.fromPort === expected.fromPort &&
    rule.toPort === expected.toPort &&
    rule.peerType === expected.peerType &&
    rule.peer === expected.peer;
}

function isOwnedAwsManagedListenerRule(
  rule: AwsFirewallRule,
  expected: AwsFirewallRuleSpec,
): boolean {
  return rule.managed &&
    rule.description === expected.description &&
    awsFirewallAccessMatches(rule, expected);
}

type AzureManagedListenerFirewallIdentity = Omit<AzureFirewallRuleSpec, "priority">;

function azureManagedListenerFirewallIdentity(
  input: ManagedListenerFirewallInput,
): AzureManagedListenerFirewallIdentity {
  return Object.freeze({
    name: `sliver-gui-listener-${input.protocol}-${input.port}`,
    direction: "ingress",
    access: "allow",
    protocol: input.protocol,
    sourceAddressPrefixes: Object.freeze([MANAGED_LISTENER_FIREWALL_SOURCE]),
    sourcePortRanges: Object.freeze(["*"]),
    destinationAddressPrefixes: Object.freeze(["*"]),
    destinationPortRanges: Object.freeze([String(input.port)]),
    description: managedListenerFirewallDescription(input),
  });
}

function azureFirewallAccessMatches(
  rule: AzureFirewallRule,
  expected: AzureManagedListenerFirewallIdentity,
): boolean {
  return rule.direction === expected.direction &&
    rule.access === expected.access &&
    rule.protocol === expected.protocol &&
    sameStringSequence(rule.sourceAddressPrefixes, expected.sourceAddressPrefixes) &&
    sameStringSequence(rule.sourcePortRanges, expected.sourcePortRanges) &&
    sameStringSequence(rule.destinationAddressPrefixes, expected.destinationAddressPrefixes) &&
    sameStringSequence(rule.destinationPortRanges, expected.destinationPortRanges) &&
    rule.sourceApplicationSecurityGroupIds.length === 0 &&
    rule.destinationApplicationSecurityGroupIds.length === 0;
}

function isOwnedAzureManagedListenerRule(
  rule: AzureFirewallRule,
  expected: AzureManagedListenerFirewallIdentity,
): boolean {
  return rule.managed &&
    !rule.isDefault &&
    rule.editUnsupportedReason === null &&
    rule.name === expected.name &&
    rule.description === expected.description &&
    azureFirewallAccessMatches(rule, expected);
}

function azureFirewallSpecFromRule(rule: AzureFirewallRule): AzureFirewallRuleSpec {
  return {
    name: rule.name,
    priority: rule.priority,
    direction: rule.direction,
    access: rule.access,
    protocol: rule.protocol,
    sourceAddressPrefixes: rule.sourceAddressPrefixes,
    sourcePortRanges: rule.sourcePortRanges,
    destinationAddressPrefixes: rule.destinationAddressPrefixes,
    destinationPortRanges: rule.destinationPortRanges,
    description: rule.description,
  };
}

function firstAvailableAzureManagedListenerPriority(snapshot: AzureFirewallSnapshot): number | null {
  const occupied = new Set(snapshot.rules.map(({ priority }) => priority));
  for (
    let priority = MANAGED_LISTENER_AZURE_PRIORITY_MIN;
    priority <= MANAGED_LISTENER_AZURE_PRIORITY_MAX;
    priority += 1
  ) {
    if (!occupied.has(priority)) return priority;
  }
  return null;
}

function sameStringSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function upsertAwsFirewallRule(
  snapshot: AwsFirewallSnapshot,
  rule: AwsFirewallRule,
): AwsFirewallSnapshot {
  return {
    ...snapshot,
    rules: [...snapshot.rules.filter(({ id }) => id !== rule.id), rule]
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function removeAwsFirewallRule(snapshot: AwsFirewallSnapshot, ruleId: string): AwsFirewallSnapshot {
  return { ...snapshot, rules: snapshot.rules.filter(({ id }) => id !== ruleId) };
}

function upsertAzureFirewallRule(
  snapshot: AzureFirewallSnapshot,
  rule: AzureFirewallRule,
): AzureFirewallSnapshot {
  return {
    ...snapshot,
    rules: [...snapshot.rules.filter(({ id }) => id !== rule.id), rule]
      .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name)),
  };
}

function removeAzureFirewallRule(
  snapshot: AzureFirewallSnapshot,
  ruleId: string,
): AzureFirewallSnapshot {
  const ruleName = azureFirewallRuleName(ruleId);
  return {
    ...snapshot,
    rules: snapshot.rules.filter(({ id, name }) => id !== ruleId && name !== ruleName),
  };
}

function azureFirewallRuleName(ruleId: string): string {
  const name = ruleId.includes("/") ? ruleId.slice(ruleId.lastIndexOf("/") + 1) : ruleId;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/u.test(name) || name.length > 80) {
    throw new TypeError("Invalid Azure firewall rule identity");
  }
  return name;
}

function publicKeyForCredential(secret: AwsCredentialSecret | AzureCliCredentialSecret): string {
  const key = sshUtils.parseKey(secret.sshPrivateKey, secret.sshPassphrase ?? undefined);
  if (key instanceof Error || !key.isPrivateKey()) throw new Error("The stored SSH private key is unavailable");
  return `${key.type} ${key.getPublicSSH().toString("base64")} sliver-gui`;
}

async function resolveAwsNetwork(
  provider: CloudAwsProvider,
  deployment: AwsCloudDeploymentRecord,
): Promise<{ readonly vpcId: string; readonly subnetId: string }> {
  if (deployment.spec.vpcId && deployment.spec.subnetId) {
    return { vpcId: deployment.spec.vpcId, subnetId: deployment.spec.subnetId };
  }
  const inventory = await provider.discover(deployment.spec.vpcId ? { vpcId: deployment.spec.vpcId } : {});
  if (deployment.spec.subnetId) {
    const subnet = inventory.subnets.find(({ id }) => id === deployment.spec.subnetId);
    if (!subnet) throw new Error("The selected AWS subnet is no longer available");
    if (deployment.spec.vpcId && subnet.vpcId !== deployment.spec.vpcId) {
      throw new Error("The selected AWS subnet does not belong to the selected VPC");
    }
    return { vpcId: subnet.vpcId, subnetId: subnet.id };
  }
  const vpcId = deployment.spec.vpcId ?? [...inventory.vpcs]
    .filter(({ isDefault }) => isDefault)
    .sort((left, right) => left.id.localeCompare(right.id))[0]?.id;
  if (!vpcId) throw new Error("Select a VPC because this AWS region has no default VPC");
  const subnet = inventory.subnets
    .filter((candidate) => candidate.vpcId === vpcId)
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!subnet) throw new Error("No usable AWS subnet is available for this deployment");
  return { vpcId, subnetId: subnet.id };
}

function toAzureDeploymentOptions(inventory: AzureVmDiscoveryResult): AzureDeploymentOptions {
  return Object.freeze({
    location: inventory.location,
    vmSizes: Object.freeze(inventory.vmSizes.map((size) => Object.freeze({
      name: size.name,
      vCpuCount: size.vCpuCount,
      memoryMiB: size.memoryMiB,
    }))),
    images: Object.freeze(inventory.images.map((image) => Object.freeze({
      reference: image.id,
      label: image.label,
      architecture: image.architecture,
      sshUsername: image.sshUsername,
    }))),
    virtualNetworks: Object.freeze(inventory.virtualNetworks.map((network) => Object.freeze({
      id: network.id,
      name: network.name,
      resourceGroupName: network.resourceGroupName,
      location: network.location,
      addressPrefixes: Object.freeze([...network.addressPrefixes]),
    }))),
    subnets: Object.freeze(inventory.subnets.map((subnet) => Object.freeze({
      id: subnet.id,
      name: subnet.name,
      vnetId: azureVirtualNetworkIdForSubnet(subnet.id),
      resourceGroupName: subnet.resourceGroupName,
      addressPrefixes: Object.freeze([...subnet.addressPrefixes]),
    }))),
  });
}

function azureVirtualNetworkIdForSubnet(subnetId: string): string {
  const marker = "/subnets/";
  const index = subnetId.toLocaleLowerCase("en-US").lastIndexOf(marker);
  if (index <= 0) throw new Error("Azure returned an invalid subnet resource identity");
  return subnetId.slice(0, index);
}

function awsFirewall(deployment: AwsCloudDeploymentRecord) {
  return {
    sshPort: deployment.spec.sshPort,
    sshSourceCidrs: deployment.spec.sshCidrs,
    multiplayerPort: deployment.spec.multiplayerPort,
    multiplayerSourceCidrs: deployment.spec.operatorCidrs,
  };
}

function azureFirewall(deployment: AzureCloudDeploymentRecord) {
  return {
    sshPort: deployment.spec.sshPort,
    sshSourceCidrs: deployment.spec.sshCidrs,
    operatorPort: deployment.spec.multiplayerPort,
    operatorSourceCidrs: deployment.spec.operatorCidrs,
  };
}

function assertAwsReadyForSsh(resource: AwsEc2DeploymentResource): void {
  if (
    resource.state === "running" &&
    resource.instanceHealth === "ok" &&
    resource.systemHealth === "ok"
  ) return;
  throw new Error(
    `AWS EC2 status checks did not pass; refusing SSH provisioning ` +
    `(state=${resource.state}, instance=${resource.instanceHealth}, system=${resource.systemHealth})`,
  );
}

function assertAzureReadyForSsh(resource: AzureVmDeploymentResource): void {
  if (resource.instanceState === "running") return;
  throw new Error(
    `Azure virtual machine did not reach the running state; refusing SSH provisioning ` +
    `(state=${resource.instanceState}, provisioning=${resource.provisioningState ?? "unknown"})`,
  );
}

async function requireAzurePublicIp(
  provider: CloudAzureProvider,
  resource: AzureVmDeploymentResource,
  refreshDelay: (milliseconds: number) => Promise<void>,
): Promise<AzureVmDeploymentResource> {
  if (!resource.publicIpAddressId) {
    throw new Error("Azure did not retain the requested public IP resource identity");
  }
  if (resource.publicIpAddress) return resource;
  let latest = resource;
  for (let attempt = 0; attempt < AZURE_PUBLIC_IP_REFRESH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await refreshDelay(AZURE_PUBLIC_IP_REFRESH_DELAY_MS);
    latest = await provider.refresh(latest);
    if (latest.publicIpAddress) return latest;
  }
  throw new Error(
    `Azure did not report the requested public IP address after ` +
    `${AZURE_PUBLIC_IP_REFRESH_ATTEMPTS} refresh attempts; refusing private-address fallback`,
  );
}

function azureConnectionAddress(
  usePublicIp: boolean,
  resource: Pick<AzureVmDeploymentResource, "publicIpAddress" | "privateIpAddress"> | {
    readonly publicIpAddress: string | null;
    readonly privateIpAddress: string | null;
  },
): string | undefined {
  return (usePublicIp ? resource.publicIpAddress : resource.privateIpAddress) ?? undefined;
}

function applyAwsCreateMutation(
  deployment: AwsCloudDeploymentRecord,
  event: AwsEc2CreateMutationEvent,
): AwsCloudDeploymentRecord {
  const { resources } = event;
  let managedAssets: AwsCloudDeploymentRecord["managedAssets"] = deployment.managedAssets;
  if (resources.keyPair && resources.keyPair.managed !== false) {
    managedAssets = upsertAwsManagedAsset(
      managedAssets,
      "ec2-key-pair",
      resources.keyPair.id,
      resources.keyPair.name,
    );
  }
  if (resources.vpcId) {
    managedAssets = upsertAwsManagedAsset(managedAssets, "ec2-vpc", resources.vpcId, deployment.name);
  }
  if (resources.subnetId) {
    managedAssets = upsertAwsManagedAsset(managedAssets, "ec2-subnet", resources.subnetId, null);
  }
  if (resources.internetGatewayId) {
    managedAssets = upsertAwsManagedAsset(
      managedAssets,
      "ec2-internet-gateway",
      resources.internetGatewayId,
      null,
    );
  }
  if (resources.routeTableId) {
    managedAssets = upsertAwsManagedAsset(managedAssets, "ec2-route-table", resources.routeTableId, null);
  }
  if (resources.routeTableAssociationId) {
    managedAssets = upsertAwsManagedAsset(
      managedAssets,
      "ec2-route-table-association",
      resources.routeTableAssociationId,
      null,
      false,
    );
  }
  if (resources.securityGroupId) {
    managedAssets = upsertAwsManagedAsset(
      managedAssets,
      "ec2-security-group",
      resources.securityGroupId,
      null,
    );
  }
  if (resources.instanceId) {
    managedAssets = upsertAwsManagedAsset(
      managedAssets,
      "ec2-instance",
      resources.instanceId,
      deployment.name,
    );
  }
  if (resources.elasticIpAllocationId) {
    managedAssets = upsertAwsManagedAsset(
      managedAssets,
      "ec2-elastic-ip",
      resources.elasticIpAllocationId,
      resources.elasticIpPublicAddress ?? null,
    );
  }
  const instanceState = event.phase === "instance"
    ? "pending"
    : event.phase === "instance-running" ||
        event.phase === "instance-status-ok" ||
        event.phase === "system-status-ok" ||
        event.phase === "elastic-ip"
      ? "running"
      : deployment.runtime.instanceState;
  const instanceHealth = event.phase === "instance"
    ? "initializing"
    : event.phase === "instance-status-ok" || event.phase === "system-status-ok"
      ? "ok"
      : deployment.runtime.instanceHealth;
  const systemHealth = event.phase === "instance"
    ? "initializing"
    : event.phase === "system-status-ok"
      ? "ok"
      : deployment.runtime.systemHealth;
  return {
    ...deployment,
    phase: event.phase === "key-pair" ||
        event.phase === "vpc" ||
        event.phase === "internet-gateway" ||
        event.phase === "subnet" ||
        event.phase === "route-table"
      ? "creating-instance"
      : event.phase === "security-group"
        ? "configuring-firewall"
        : event.phase === "instance"
          ? "starting-instance"
          : event.phase === "instance-running"
            ? "waiting-instance-status"
            : event.phase === "instance-status-ok"
              ? "waiting-system-status"
              : "finalizing-network",
    managedAssets,
    runtime: {
      ...deployment.runtime,
      instanceId: resources.instanceId ?? deployment.runtime.instanceId,
      instanceState,
      instanceHealth,
      systemHealth,
      securityGroupIds: resources.securityGroupId
        ? [resources.securityGroupId]
        : deployment.runtime.securityGroupIds,
      publicIpAddress: resources.elasticIpPublicAddress ?? deployment.runtime.publicIpAddress,
      elasticIpAllocationId: resources.elasticIpAllocationId ?? deployment.runtime.elasticIpAllocationId,
      vpcId: resources.vpcId ?? deployment.runtime.vpcId,
      subnetId: resources.subnetId ?? deployment.runtime.subnetId,
      internetGatewayId: resources.internetGatewayId ?? deployment.runtime.internetGatewayId,
      routeTableId: resources.routeTableId ?? deployment.runtime.routeTableId,
      routeTableAssociationId: resources.routeTableAssociationId ??
        deployment.runtime.routeTableAssociationId,
    },
  };
}

function upsertAwsManagedAsset(
  assets: AwsCloudDeploymentRecord["managedAssets"],
  resourceType: AwsManagedAssetType,
  resourceId: string,
  displayName: string | null,
  tagged = true,
): AwsCloudDeploymentRecord["managedAssets"] {
  return [
    ...assets.filter((asset) => asset.resourceType !== resourceType),
    { resourceType, resourceId, displayName, tagged },
  ];
}

function applyAwsResource(
  deployment: AwsCloudDeploymentRecord,
  resource: AwsEc2DeploymentResource,
  phase: "installing-sliver" | "ready" | "stopped",
): AwsCloudDeploymentRecord {
  const status = phase === "installing-sliver"
    ? "provisioning"
    : resource.state === "stopped"
      ? "stopped"
      : "running";
  const managedAssets: AwsCloudDeploymentRecord["managedAssets"] = [
    { resourceType: "ec2-instance", resourceId: resource.instanceId, displayName: resource.name, tagged: true },
    ...resource.volumeIds.map((resourceId) => ({
      resourceType: "ec2-volume" as const,
      resourceId,
      displayName: null,
      tagged: true,
    })),
    ...resource.networkInterfaceIds.map((resourceId) => ({
      resourceType: "ec2-network-interface" as const,
      resourceId,
      displayName: null,
      tagged: true,
    })),
    { resourceType: "ec2-security-group", resourceId: resource.securityGroupId, displayName: null, tagged: true },
    ...(resource.keyPair && resource.keyPair.managed !== false ? [{
      resourceType: "ec2-key-pair" as const,
      resourceId: resource.keyPair.id,
      displayName: resource.keyPair.name,
      tagged: true as const,
    }] : []),
    ...(resource.elasticIp ? [{
      resourceType: "ec2-elastic-ip" as const,
      resourceId: resource.elasticIp.allocationId,
      displayName: resource.elasticIp.publicIp,
      tagged: true,
    }] : []),
    ...(resource.managedNetwork ? [
      {
        resourceType: "ec2-vpc" as const,
        resourceId: resource.managedNetwork.vpcId,
        displayName: resource.name,
        tagged: true,
      },
      {
        resourceType: "ec2-subnet" as const,
        resourceId: resource.managedNetwork.subnetId,
        displayName: null,
        tagged: true,
      },
      {
        resourceType: "ec2-internet-gateway" as const,
        resourceId: resource.managedNetwork.internetGatewayId,
        displayName: null,
        tagged: true,
      },
      {
        resourceType: "ec2-route-table" as const,
        resourceId: resource.managedNetwork.routeTableId,
        displayName: null,
        tagged: true,
      },
      {
        resourceType: "ec2-route-table-association" as const,
        resourceId: resource.managedNetwork.routeTableAssociationId,
        displayName: null,
        tagged: false,
      },
    ] : []),
  ];
  return {
    ...deployment,
    status,
    name: resource.name,
    phase,
    remoteHost: resource.publicIpAddress ?? resource.privateIpAddress ?? deployment.remoteHost,
    lastError: null,
    managedAssets,
    runtime: {
      instanceId: resource.instanceId,
      instanceState: resource.state,
      instanceHealth: resource.instanceHealth,
      systemHealth: resource.systemHealth,
      securityGroupIds: [resource.securityGroupId],
      volumeIds: resource.volumeIds,
      networkInterfaceIds: resource.networkInterfaceIds,
      publicIpAddress: resource.publicIpAddress ?? null,
      privateIpAddress: resource.privateIpAddress ?? null,
      availabilityZone: resource.availabilityZone ?? null,
      elasticIpAllocationId: resource.elasticIp?.allocationId ?? null,
      vpcId: resource.managedNetwork?.vpcId ?? null,
      subnetId: resource.managedNetwork?.subnetId ?? null,
      internetGatewayId: resource.managedNetwork?.internetGatewayId ?? null,
      routeTableId: resource.managedNetwork?.routeTableId ?? null,
      routeTableAssociationId: resource.managedNetwork?.routeTableAssociationId ?? null,
    },
  };
}

function awsResourceFromRecord(deployment: AwsCloudDeploymentRecord): AwsEc2DeploymentResource {
  const instanceId = deployment.runtime.instanceId;
  const securityGroupId = deployment.runtime.securityGroupIds[0];
  const keyPairAsset = deployment.managedAssets.find(({ resourceType }) => resourceType === "ec2-key-pair");
  if (!instanceId || !securityGroupId || (keyPairAsset && !keyPairAsset.displayName)) {
    throw new Error("The AWS deployment resource identity is incomplete");
  }
  const publicIp = deployment.runtime.publicIpAddress ?? undefined;
  const allocationId = deployment.runtime.elasticIpAllocationId ?? undefined;
  return {
    guid: deployment.id,
    name: deployment.name,
    region: deployment.spec.region,
    ...(keyPairAsset?.displayName ? {
      keyPair: { id: keyPairAsset.resourceId, name: keyPairAsset.displayName, managed: true },
    } : {}),
    ...(completeAwsManagedNetworkFromRecord(deployment) ?? {}),
    instanceId,
    securityGroupId,
    volumeIds: deployment.runtime.volumeIds,
    networkInterfaceIds: deployment.runtime.networkInterfaceIds,
    state: deployment.status === "stopped" ? "stopped" : deployment.runtime.instanceState,
    instanceHealth: deployment.runtime.instanceHealth,
    systemHealth: deployment.runtime.systemHealth,
    ...(deployment.runtime.availabilityZone ? { availabilityZone: deployment.runtime.availabilityZone } : {}),
    ...(deployment.runtime.privateIpAddress ? { privateIpAddress: deployment.runtime.privateIpAddress } : {}),
    ...(publicIp ? { publicIpAddress: publicIp } : {}),
    ...(allocationId && publicIp ? { elasticIp: { allocationId, publicIp } } : {}),
  };
}

function awsDestroyResourceFromRecord(deployment: AwsCloudDeploymentRecord): AwsEc2DestroyResource {
  if (deployment.runtime.securityGroupIds.length > 1) {
    throw new Error("The AWS deployment has an unsupported number of tracked security groups");
  }
  const keyPairAsset = singleAwsManagedAsset(deployment, "ec2-key-pair");
  const instanceId = consistentAwsResourceId(
    deployment.runtime.instanceId,
    singleAwsManagedAsset(deployment, "ec2-instance")?.resourceId,
    "instance",
  );
  const securityGroupId = consistentAwsResourceId(
    deployment.runtime.securityGroupIds[0],
    singleAwsManagedAsset(deployment, "ec2-security-group")?.resourceId,
    "security group",
  );
  const elasticIpAllocationId = consistentAwsResourceId(
    deployment.runtime.elasticIpAllocationId,
    singleAwsManagedAsset(deployment, "ec2-elastic-ip")?.resourceId,
    "Elastic IP",
  );
  const volumeIds = consistentAwsResourceIds(
    deployment.runtime.volumeIds,
    awsManagedAssetIds(deployment, "ec2-volume"),
    "EBS volume",
  );
  const networkInterfaceIds = consistentAwsResourceIds(
    deployment.runtime.networkInterfaceIds,
    awsManagedAssetIds(deployment, "ec2-network-interface"),
    "network interface",
  );
  const managedNetwork = partialAwsManagedNetworkFromRecord(deployment);
  if (keyPairAsset && !keyPairAsset.displayName) {
    throw new Error("The AWS deployment key-pair identity is incomplete");
  }
  if (
    !keyPairAsset &&
    !instanceId &&
    !securityGroupId &&
    !elasticIpAllocationId &&
    volumeIds.length === 0 &&
    networkInterfaceIds.length === 0 &&
    managedNetwork === undefined
  ) {
    throw new Error("The AWS deployment has tracked resources that cannot be safely deleted");
  }
  return {
    guid: deployment.id,
    name: deployment.name,
    region: deployment.spec.region,
    ...(keyPairAsset?.displayName ? {
      keyPair: { id: keyPairAsset.resourceId, name: keyPairAsset.displayName },
    } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(securityGroupId ? { securityGroupId } : {}),
    ...(volumeIds.length > 0 ? { volumeIds } : {}),
    ...(networkInterfaceIds.length > 0 ? { networkInterfaceIds } : {}),
    ...(elasticIpAllocationId ? { elasticIp: { allocationId: elasticIpAllocationId } } : {}),
    ...(managedNetwork ? { managedNetwork } : {}),
  };
}

function singleAwsManagedAsset(
  deployment: AwsCloudDeploymentRecord,
  resourceType: AwsManagedAssetType,
) {
  const matches = deployment.managedAssets.filter((asset) => asset.resourceType === resourceType);
  if (matches.length > 1) throw new Error(`The AWS deployment has duplicate tracked ${resourceType} identities`);
  return matches[0];
}

function partialAwsManagedNetworkFromRecord(
  deployment: AwsCloudDeploymentRecord,
): NonNullable<AwsEc2DestroyResource["managedNetwork"]> | undefined {
  const vpcId = consistentAwsResourceId(
    deployment.runtime.vpcId,
    singleAwsManagedAsset(deployment, "ec2-vpc")?.resourceId,
    "VPC",
  );
  const subnetId = consistentAwsResourceId(
    deployment.runtime.subnetId,
    singleAwsManagedAsset(deployment, "ec2-subnet")?.resourceId,
    "subnet",
  );
  const internetGatewayId = consistentAwsResourceId(
    deployment.runtime.internetGatewayId,
    singleAwsManagedAsset(deployment, "ec2-internet-gateway")?.resourceId,
    "internet gateway",
  );
  const routeTableId = consistentAwsResourceId(
    deployment.runtime.routeTableId,
    singleAwsManagedAsset(deployment, "ec2-route-table")?.resourceId,
    "route table",
  );
  const routeTableAssociationId = consistentAwsResourceId(
    deployment.runtime.routeTableAssociationId,
    singleAwsManagedAsset(deployment, "ec2-route-table-association")?.resourceId,
    "route table association",
  );
  if (!vpcId && !subnetId && !internetGatewayId && !routeTableId && !routeTableAssociationId) {
    return undefined;
  }
  if (!vpcId) throw new Error("The tracked AWS managed network is missing its VPC identity");
  return {
    vpcId,
    ...(subnetId ? { subnetId } : {}),
    ...(internetGatewayId ? { internetGatewayId } : {}),
    ...(routeTableId ? { routeTableId } : {}),
    ...(routeTableAssociationId ? { routeTableAssociationId } : {}),
  };
}

function completeAwsManagedNetworkFromRecord(
  deployment: AwsCloudDeploymentRecord,
): Pick<AwsEc2DeploymentResource, "managedNetwork"> | undefined {
  const network = partialAwsManagedNetworkFromRecord(deployment);
  if (!network) return undefined;
  if (
    !network.vpcId ||
    !network.subnetId ||
    !network.internetGatewayId ||
    !network.routeTableId ||
    !network.routeTableAssociationId
  ) {
    throw new Error("The AWS deployment managed-network identity is incomplete");
  }
  return {
    managedNetwork: {
      vpcId: network.vpcId,
      subnetId: network.subnetId,
      internetGatewayId: network.internetGatewayId,
      routeTableId: network.routeTableId,
      routeTableAssociationId: network.routeTableAssociationId,
    },
  };
}

function consistentAwsResourceId(
  runtimeId: string | null | undefined,
  assetId: string | undefined,
  label: string,
): string | undefined {
  if (runtimeId && assetId && runtimeId !== assetId) {
    throw new Error(`The tracked AWS ${label} identities do not match`);
  }
  return runtimeId ?? assetId;
}

function awsManagedAssetIds(
  deployment: AwsCloudDeploymentRecord,
  resourceType: "ec2-volume" | "ec2-network-interface",
): readonly string[] {
  return deployment.managedAssets
    .filter((asset) => asset.resourceType === resourceType)
    .map(({ resourceId }) => resourceId);
}

function consistentAwsResourceIds(
  runtimeIds: readonly string[],
  assetIds: readonly string[],
  label: string,
): readonly string[] {
  if (new Set(runtimeIds).size !== runtimeIds.length || new Set(assetIds).size !== assetIds.length) {
    throw new Error(`The tracked AWS ${label} identities contain duplicates`);
  }
  if (runtimeIds.length > 0 && assetIds.length > 0) {
    const runtimeSet = new Set(runtimeIds);
    if (runtimeSet.size !== assetIds.length || assetIds.some((resourceId) => !runtimeSet.has(resourceId))) {
      throw new Error(`The tracked AWS ${label} identities do not match`);
    }
  }
  return runtimeIds.length > 0 ? runtimeIds : assetIds;
}

async function recoverInterruptedTransitions(store: CloudDeploymentStore): Promise<void> {
  const interrupted = store.getState().deployments.filter(
    ({ status }) => status === "provisioning" || status === "deleting",
  );
  for (const deployment of interrupted) {
    const action = deployment.status === "deleting" ? "termination" : "provisioning";
    const result = await store.update({
      expectedRevision: store.getState().revision,
      deployment: {
        ...deployment,
        status: "failed",
        phase: "failed",
        lastError: `The ${action} operation was interrupted when the application closed. Review the managed assets before retrying termination.`,
      },
    });
    if (!result.ok) throw new Error(result.error);
  }
}

function hasTrackedAwsResources(deployment: AwsCloudDeploymentRecord): boolean {
  return deployment.runtime.instanceId !== null ||
    deployment.runtime.securityGroupIds.length > 0 ||
    deployment.runtime.volumeIds.length > 0 ||
    deployment.runtime.networkInterfaceIds.length > 0 ||
    deployment.runtime.elasticIpAllocationId !== null ||
    deployment.managedAssets.some(({ resourceType }) => resourceType.startsWith("ec2-"));
}

function hasTrackedAzureResources(deployment: AzureCloudDeploymentRecord): boolean {
  return deployment.runtime.vmId !== null ||
    deployment.runtime.networkSecurityGroupId !== null ||
    deployment.runtime.networkInterfaceId !== null ||
    deployment.runtime.osDiskId !== null ||
    deployment.runtime.publicIpAddressId !== null ||
    deployment.managedAssets.some(({ resourceType }) => resourceType.startsWith("azure-"));
}

function applyAzureCreateMutation(
  deployment: AzureCloudDeploymentRecord,
  event: AzureVmCreateMutationEvent,
  phase: CloudDeploymentPhase,
): AzureCloudDeploymentRecord {
  const { resources } = event;
  let managedAssets = deployment.managedAssets;
  if (resources.resourceGroupId) {
    managedAssets = upsertAzureManagedAsset(
      managedAssets,
      "azure-resource-group",
      resources.resourceGroupId,
      azureResourceGroupName(resources.resourceGroupId),
    );
  }
  if (resources.managedNetwork) {
    managedAssets = upsertAzureManagedAsset(
      managedAssets,
      "azure-virtual-network",
      resources.managedNetwork.virtualNetworkId,
      azureResourceName(resources.managedNetwork.virtualNetworkId),
    );
    managedAssets = upsertAzureManagedAsset(
      managedAssets,
      "azure-subnet",
      resources.managedNetwork.subnetId,
      azureResourceName(resources.managedNetwork.subnetId),
      false,
    );
  }
  const taggedAssets: ReadonlyArray<readonly [AzureManagedAssetType, string | undefined]> = [
    ["azure-network-security-group", resources.networkSecurityGroupId],
    ["azure-public-ip", resources.publicIpAddressId],
    ["azure-network-interface", resources.networkInterfaceId],
    ["azure-virtual-machine", resources.virtualMachineId],
    ["azure-os-disk", resources.osDiskId],
  ];
  for (const [resourceType, resourceId] of taggedAssets) {
    if (resourceId) {
      managedAssets = upsertAzureManagedAsset(
        managedAssets,
        resourceType,
        resourceId,
        azureResourceName(resourceId),
      );
    }
  }
  return {
    ...deployment,
    phase,
    managedAssets,
    runtime: {
      ...deployment.runtime,
      resourceGroupName: resources.resourceGroupId
        ? azureResourceGroupName(resources.resourceGroupId)
        : deployment.runtime.resourceGroupName,
      vmName: resources.virtualMachineId
        ? azureResourceName(resources.virtualMachineId)
        : deployment.runtime.vmName,
      vmId: resources.virtualMachineId ?? deployment.runtime.vmId,
      instanceState: resources.virtualMachineId ? "creating" : deployment.runtime.instanceState,
      networkSecurityGroupId: resources.networkSecurityGroupId ?? deployment.runtime.networkSecurityGroupId,
      networkInterfaceId: resources.networkInterfaceId ?? deployment.runtime.networkInterfaceId,
      osDiskId: resources.osDiskId ?? deployment.runtime.osDiskId,
      publicIpAddressId: resources.publicIpAddressId ?? deployment.runtime.publicIpAddressId,
      vnetId: resources.managedNetwork?.virtualNetworkId ?? deployment.runtime.vnetId,
      subnetId: resources.managedNetwork?.subnetId ?? deployment.runtime.subnetId,
    },
  };
}

function applyAzureResource(
  deployment: AzureCloudDeploymentRecord,
  resource: AzureVmDeploymentResource,
  phase: "installing-sliver" | "ready" | "stopped",
): AzureCloudDeploymentRecord {
  const stopped = resource.instanceState === "deallocated" || resource.instanceState === "stopped";
  const managedAssets: AzureCloudDeploymentRecord["managedAssets"] = [
    {
      resourceType: "azure-resource-group",
      resourceId: resource.resourceGroupId,
      displayName: azureResourceGroupName(resource.resourceGroupId),
      tagged: true,
    },
    ...(resource.managedNetwork ? [
      {
        resourceType: "azure-virtual-network" as const,
        resourceId: resource.managedNetwork.virtualNetworkId,
        displayName: azureResourceName(resource.managedNetwork.virtualNetworkId),
        tagged: true,
      },
      {
        resourceType: "azure-subnet" as const,
        resourceId: resource.managedNetwork.subnetId,
        displayName: azureResourceName(resource.managedNetwork.subnetId),
        tagged: false,
      },
    ] : []),
    {
      resourceType: "azure-network-security-group",
      resourceId: resource.networkSecurityGroupId,
      displayName: azureResourceName(resource.networkSecurityGroupId),
      tagged: true,
    },
    ...(resource.publicIpAddressId ? [{
      resourceType: "azure-public-ip" as const,
      resourceId: resource.publicIpAddressId,
      displayName: azureResourceName(resource.publicIpAddressId),
      tagged: true,
    }] : []),
    {
      resourceType: "azure-network-interface",
      resourceId: resource.networkInterfaceId,
      displayName: azureResourceName(resource.networkInterfaceId),
      tagged: true,
    },
    {
      resourceType: "azure-os-disk",
      resourceId: resource.osDiskId,
      displayName: azureResourceName(resource.osDiskId),
      tagged: true,
    },
    {
      resourceType: "azure-virtual-machine",
      resourceId: resource.virtualMachineId,
      displayName: azureResourceName(resource.virtualMachineId),
      tagged: true,
    },
  ];
  return {
    ...deployment,
    status: phase === "installing-sliver" ? "provisioning" : stopped ? "stopped" : "running",
    name: resource.name,
    phase: stopped ? "stopped" : phase,
    remoteHost: azureConnectionAddress(deployment.spec.usePublicIp, resource) ?? null,
    lastError: null,
    managedAssets,
    runtime: {
      resourceGroupName: azureResourceGroupName(resource.resourceGroupId),
      vmName: azureResourceName(resource.virtualMachineId),
      vmId: resource.virtualMachineId,
      instanceState: resource.instanceState,
      provisioningState: resource.provisioningState ?? null,
      networkSecurityGroupId: resource.networkSecurityGroupId,
      networkInterfaceId: resource.networkInterfaceId,
      osDiskId: resource.osDiskId,
      publicIpAddressId: resource.publicIpAddressId ?? null,
      publicIpAddress: resource.publicIpAddress ?? null,
      privateIpAddress: resource.privateIpAddress ?? null,
      vnetId: resource.virtualNetworkId,
      subnetId: resource.subnetId,
    },
  };
}

function upsertAzureManagedAsset(
  assets: AzureCloudDeploymentRecord["managedAssets"],
  resourceType: AzureManagedAssetType,
  resourceId: string,
  displayName: string | null,
  tagged = true,
): AzureCloudDeploymentRecord["managedAssets"] {
  return [
    ...assets.filter((asset) => asset.resourceType !== resourceType),
    { resourceType, resourceId, displayName, tagged },
  ];
}

function azureResourceFromRecord(
  deployment: AzureCloudDeploymentRecord,
  secret: AzureCliCredentialSecret,
): AzureVmDeploymentResource {
  const resourceGroupId = requiredAzureAssetId(deployment, "azure-resource-group");
  const virtualMachineId = consistentAzureResourceId(
    deployment.runtime.vmId,
    azureAssetId(deployment, "azure-virtual-machine"),
    "virtual machine",
  );
  const networkSecurityGroupId = consistentAzureResourceId(
    deployment.runtime.networkSecurityGroupId,
    azureAssetId(deployment, "azure-network-security-group"),
    "network security group",
  );
  const networkInterfaceId = consistentAzureResourceId(
    deployment.runtime.networkInterfaceId,
    azureAssetId(deployment, "azure-network-interface"),
    "network interface",
  );
  const osDiskId = consistentAzureResourceId(
    deployment.runtime.osDiskId,
    azureAssetId(deployment, "azure-os-disk"),
    "OS disk",
  );
  const publicIpAddressId = consistentAzureResourceId(
    deployment.runtime.publicIpAddressId,
    azureAssetId(deployment, "azure-public-ip"),
    "public IP address",
  );
  if (!virtualMachineId || !networkSecurityGroupId || !networkInterfaceId || !osDiskId || !deployment.runtime.vnetId || !deployment.runtime.subnetId) {
    throw new Error("The Azure deployment resource identity is incomplete");
  }
  const managedVnetId = azureAssetId(deployment, "azure-virtual-network");
  const managedSubnetId = azureAssetId(deployment, "azure-subnet");
  if ((managedVnetId === undefined) !== (managedSubnetId === undefined)) {
    throw new Error("The Azure managed-network identity is incomplete");
  }
  if (managedVnetId && (managedVnetId !== deployment.runtime.vnetId || managedSubnetId !== deployment.runtime.subnetId)) {
    throw new Error("The tracked Azure managed-network identities do not match");
  }
  return {
    subscriptionId: secret.subscriptionId,
    tenantId: secret.tenantId,
    location: deployment.spec.location,
    guid: deployment.id,
    name: deployment.name,
    resourceGroupId,
    virtualNetworkId: deployment.runtime.vnetId,
    subnetId: deployment.runtime.subnetId,
    ...(managedVnetId && managedSubnetId ? {
      managedNetwork: { virtualNetworkId: managedVnetId, subnetId: managedSubnetId },
    } : {}),
    networkSecurityGroupId,
    ...(publicIpAddressId ? { publicIpAddressId } : {}),
    networkInterfaceId,
    virtualMachineId,
    osDiskId,
    instanceState: deployment.runtime.instanceState,
    ...(deployment.runtime.provisioningState ? { provisioningState: deployment.runtime.provisioningState } : {}),
    ...(deployment.runtime.privateIpAddress ? { privateIpAddress: deployment.runtime.privateIpAddress } : {}),
    ...(deployment.runtime.publicIpAddress ? { publicIpAddress: deployment.runtime.publicIpAddress } : {}),
  };
}

function azureDestroyResourceFromRecord(
  deployment: AzureCloudDeploymentRecord,
  secret: AzureCliCredentialSecret,
): AzureVmDestroyResource {
  const virtualMachineId = consistentAzureResourceId(
    deployment.runtime.vmId,
    azureAssetId(deployment, "azure-virtual-machine"),
    "virtual machine",
  );
  const networkSecurityGroupId = consistentAzureResourceId(
    deployment.runtime.networkSecurityGroupId,
    azureAssetId(deployment, "azure-network-security-group"),
    "network security group",
  );
  const networkInterfaceId = consistentAzureResourceId(
    deployment.runtime.networkInterfaceId,
    azureAssetId(deployment, "azure-network-interface"),
    "network interface",
  );
  const osDiskId = consistentAzureResourceId(
    deployment.runtime.osDiskId,
    azureAssetId(deployment, "azure-os-disk"),
    "OS disk",
  );
  const publicIpAddressId = consistentAzureResourceId(
    deployment.runtime.publicIpAddressId,
    azureAssetId(deployment, "azure-public-ip"),
    "public IP address",
  );
  const resourceGroupId = azureAssetId(deployment, "azure-resource-group") ??
    azureResourceGroupIdFromResourceId(virtualMachineId ?? networkSecurityGroupId ?? networkInterfaceId);
  const managedVnetId = azureAssetId(deployment, "azure-virtual-network");
  const managedSubnetId = azureAssetId(deployment, "azure-subnet");
  if ((managedVnetId === undefined) !== (managedSubnetId === undefined)) {
    throw new Error("The Azure managed-network identity is incomplete");
  }
  return {
    subscriptionId: secret.subscriptionId,
    tenantId: secret.tenantId,
    location: deployment.spec.location,
    guid: deployment.id,
    name: deployment.name,
    ...(resourceGroupId ? { resourceGroupId } : {}),
    ...(managedVnetId && managedSubnetId ? {
      managedNetwork: { virtualNetworkId: managedVnetId, subnetId: managedSubnetId },
    } : {}),
    ...(networkSecurityGroupId ? { networkSecurityGroupId } : {}),
    ...(publicIpAddressId ? { publicIpAddressId } : {}),
    ...(networkInterfaceId ? { networkInterfaceId } : {}),
    ...(virtualMachineId ? { virtualMachineId } : {}),
    ...(osDiskId ? { osDiskId } : {}),
  };
}

function requiredAzureAssetId(
  deployment: AzureCloudDeploymentRecord,
  resourceType: AzureManagedAssetType,
): string {
  const resourceId = azureAssetId(deployment, resourceType);
  if (!resourceId) throw new Error(`The Azure deployment is missing its ${resourceType} identity`);
  return resourceId;
}

function azureAssetId(
  deployment: AzureCloudDeploymentRecord,
  resourceType: AzureManagedAssetType,
): string | undefined {
  const matches = deployment.managedAssets.filter((asset) => asset.resourceType === resourceType);
  if (matches.length > 1) throw new Error(`The Azure deployment has duplicate tracked ${resourceType} identities`);
  return matches[0]?.resourceId;
}

function consistentAzureResourceId(
  runtimeId: string | null | undefined,
  assetId: string | undefined,
  label: string,
): string | undefined {
  if (runtimeId && assetId && runtimeId.toLocaleLowerCase("en-US") !== assetId.toLocaleLowerCase("en-US")) {
    throw new Error(`The tracked Azure ${label} identities do not match`);
  }
  return runtimeId ?? assetId;
}

function azureResourceGroupIdFromResourceId(resourceId: string | undefined): string | undefined {
  if (!resourceId) return undefined;
  const match = /^(\/subscriptions\/[^/]+\/resourceGroups\/[^/]+)\/providers\//iu.exec(resourceId);
  return match?.[1];
}

function azureResourceGroupName(resourceGroupId: string): string {
  const match = /^\/subscriptions\/[^/]+\/resourceGroups\/([^/]+)$/iu.exec(resourceGroupId);
  if (!match?.[1]) throw new Error("Azure returned an invalid resource-group identity");
  return match[1];
}

function azureResourceName(resourceId: string): string {
  const name = resourceId.slice(resourceId.lastIndexOf("/") + 1);
  if (!name) throw new Error("Azure returned an invalid resource identity");
  return name;
}

function operatorConfigFileName(deploymentId: string): string {
  if (!isUuidV4(deploymentId)) throw new Error("Invalid cloud deployment identity");
  return `sliver-gui-cloud-${deploymentId}.cfg`;
}

function credentialValues(secret: AwsCredentialSecret | AzureCliCredentialSecret): readonly string[] {
  const values = Object.entries(secret).filter(([key]) => key !== "authentication").map(([, value]) => value).filter((value): value is string => typeof value === "string" && value.length > 0);
  if ("loginSession" in secret && secret.loginSession) values.push(...Object.values(secret.loginSession));
  return values;
}

function awsSessionCredentials(session: AwsConsoleLoginSession): AwsEc2Credentials {
  return {
    accessKeyId: session.accessKeyId, secretAccessKey: session.secretAccessKey,
    sessionToken: session.sessionToken, expiration: new Date(session.expiresAt),
  };
}

function awsLoginFailure(error: unknown): { readonly ok: false; readonly error: string } {
  if (error instanceof AwsConsoleLoginError) return { ok: false, error: error.message };
  if (error instanceof Error && error.name === "AbortError") return { ok: false, error: "AWS Login was cancelled." };
  return { ok: false, error: "AWS Login could not be completed. Try again." };
}

function azureLoginFailure(error: unknown): { readonly ok: false; readonly error: string } {
  if (error instanceof AzureBrowserLoginError) return { ok: false, error: error.message };
  if (error instanceof Error && error.name === "AbortError") return { ok: false, error: "Azure Login was cancelled." };
  return { ok: false, error: "Azure Login could not be completed. Try again." };
}

function assertAzureLoginOwner(ownerId: number): void {
  if (!Number.isSafeInteger(ownerId) || ownerId < 0) throw new TypeError("Invalid Azure login owner");
}

function sameAzureGuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameAzureLoginIdentity(left: AzureBrowserLoginSession, right: AzureBrowserLoginSession): boolean {
  return sameAzureGuid(left.clientId, right.clientId) && sameAzureGuid(left.tenantId, right.tenantId) &&
    left.homeAccountId === right.homeAccountId && left.localAccountId === right.localAccountId;
}

function validateAzureLoginSubscriptions(
  value: readonly AzureCliAccountSummary[],
  session: AzureBrowserLoginSession,
): readonly AzureCliAccountSummary[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 512) throw new Error("Azure Login returned an invalid subscription list");
  const subscriptions = value.map(parseAzureCliAccountSummary);
  if (subscriptions.some((account) => !sameAzureGuid(account.tenantId, session.tenantId) || account.cloudName !== "AzureCloud") ||
    new Set(subscriptions.map(({ subscriptionId }) => subscriptionId.toLowerCase())).size !== subscriptions.length) {
    throw new Error("Azure Login returned an invalid subscription list");
  }
  return Object.freeze(subscriptions);
}

function operatorGenerationFailure(
  error: unknown,
  mutationState: CloudOperatorMutationState = "not-started",
  remoteRecoveryPath?: string,
  remoteRecoveryCandidatePath?: string,
  fallback = "The managed server operator could not be created",
  remoteHandoffCandidatePath?: string,
): Extract<GenerateCloudOperatorConfigResult, { readonly ok: false }> {
  const message = typeof error === "string" ? error : cloudErrorMessage(error, fallback);
  return Object.freeze({
    ok: false,
    error: message,
    mutationState,
    ...(remoteRecoveryPath === undefined ? {} : { remoteRecoveryPath }),
    ...(remoteRecoveryCandidatePath === undefined ? {} : { remoteRecoveryCandidatePath }),
    ...(remoteHandoffCandidatePath === undefined ? {} : { remoteHandoffCandidatePath }),
  });
}

function operatorDirectoryUnavailable(): SliverProvisionError {
  return new SliverProvisionError(
    "provisioning-failed",
    "The managed server operator list could not be verified",
  );
}

function failure<T = never>(
  error: unknown,
  fallback: string,
  secrets: readonly string[] = [],
): OperationResult<T> {
  return { ok: false, error: cloudErrorMessage(error, fallback, secrets) };
}

function cloudErrorMessage(
  error: unknown,
  fallback: string,
  secrets: readonly string[] = [],
): string {
  let message = error instanceof Error && error.message.trim() ? error.message : fallback;
  for (const secret of secrets) {
    if (secret.length > 0) message = message.replaceAll(secret, "[redacted]");
  }
  message = message
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[redacted]")
    .replace(/PVEAPIToken=[^\s]+/gu, "PVEAPIToken=[redacted]")
    .replace(/[\0\r\n\t]+/gu, " ")
    .trim();
  return (message || fallback).slice(0, CLOUD_ERROR_MAX_LENGTH);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function assertBoundedAbsoluteDirectory(path: string, label: string): void {
  if (
    typeof path !== "string" ||
    path.trim() === "" ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    dirname(path) === path ||
    basename(path) === "." ||
    basename(path) === ".."
  ) throw new TypeError(`An absolute bounded ${label} is required`);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
