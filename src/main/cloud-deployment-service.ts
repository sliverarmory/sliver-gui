import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { BrowserWindow } from "electron";
import { parseConfig } from "sliver-script";
import ssh2 from "ssh2";

import type {
  CloudCredentialIdInput,
  CloudCredentialTestResult,
  CloudDeploymentChangeScope,
  CloudDeploymentSnapshot,
  CloudProvisioningTranscript,
  CloudProvisioningTranscriptSnapshot,
  CurrentEgressIpv4,
  DestroyCloudDeploymentPlan,
  ExecuteDestroyCloudDeploymentInput,
  PrepareDestroyCloudDeploymentInput,
  SshPrivateKeySelection,
} from "../shared/cloud-deployment-ipc.js";
import {
  isUuidV4,
  parseCloudDeploymentActionInput,
  parseCreateAwsFirewallRuleInput,
  parseCreateCloudCredentialInput,
  parseCreateCloudDeploymentInput,
  parseDeleteAwsFirewallRuleInput,
  parseListAwsFirewallRulesInput,
  parseUpdateAwsFirewallRuleInput,
  parseUpdateCloudFirewallInput,
  type AwsCloudDeploymentRecord,
  type AwsCliProfileSummary,
  type AwsCredentialSecret,
  type AwsFirewallRule,
  type AwsFirewallRuleSpec,
  type AwsFirewallSnapshot,
  type AwsManagedAssetType,
  type CloudCredentialSummary,
  type CloudDeploymentActionInput,
  type CloudDeploymentPhase,
  type CloudDeploymentRecord,
  type CloudDeploymentState,
  type CreateAwsFirewallRuleInput,
  type CreateCloudCredentialInput,
  type CreateCloudDeploymentInput,
  type DeleteAwsFirewallRuleInput,
  type ListAwsFirewallRulesInput,
  type ProxmoxCloudDeploymentRecord,
  type ProxmoxCredentialSecret,
  type UpdateAwsFirewallRuleInput,
  type UpdateCloudFirewallInput,
} from "../shared/cloud-deployment-contracts.js";
import type { OperationResult } from "../shared/contracts.js";
import type { TerminalRuntimeAsset } from "../shared/stream-contracts.js";
import type { CloudPermissionEvaluation } from "../shared/cloud-provider-permissions.js";
import {
  parseDiscoverAwsOptionsInput,
  type AwsDeploymentOptions,
  type DiscoverAwsOptionsInput,
} from "../shared/cloud-provider-inventory.js";
import { CloudCredentialVault, type CloudSafeStorageAdapter } from "./cloud-credential-vault.js";
import { CloudDeploymentStore } from "./cloud-deployment-store.js";
import {
  AwsEc2Provider,
  type AwsEc2CredentialProvider,
  type AwsEc2CreateMutationEvent,
  type AwsEc2DestroyResource,
  type AwsEc2DeploymentResource,
  type AwsEc2DiscoveryResult,
  type AwsEc2ProviderConnection,
} from "./cloud/aws-ec2-provider.js";
import { toAwsDeploymentOptions } from "./cloud/aws-inventory.js";
import { detectCurrentEgressIpv4 } from "./cloud/current-egress-ipv4.js";
import { AwsSharedProfileSource } from "./cloud/aws-shared-profiles.js";
import { AwsEc2PermissionChecker } from "./cloud/aws-permission-checker.js";
import {
  PrivateKeyCapabilities,
  type ResolvedPrivateKey,
} from "./cloud/private-key-capabilities.js";
import { generateEd25519SshKeyPair } from "./cloud/ssh-key-generator.js";
import {
  ProxmoxProvider,
  type ProxmoxApiCredentials,
  type ProxmoxDeploymentResult,
  type ProxmoxPermissionCheckResult,
  type ProxmoxResources,
} from "./cloud/proxmox-provider.js";
import {
  SliverProvisioner,
  type ProvisionSliverServerInput,
  type SliverProvisionOutputEvent,
  type SliverProvisionResult,
} from "./cloud/sliver-provisioner.js";
import { loadTerminalRuntime } from "./terminal-runtime.js";
import { readBoundedRegularFile, writePrivateFileExclusiveAtomic } from "./secure-file.js";

const { utils: sshUtils } = ssh2;

const DESTROY_PLAN_TTL_MS = 5 * 60 * 1000;
const MAX_OPERATOR_CONFIG_BYTES = 4 * 1024 * 1024;
const CLOUD_ERROR_MAX_LENGTH = 1_000;
const MAX_PROVISIONING_TRANSCRIPT_BYTES = 256 * 1024;
const MAX_PROVISIONING_TRANSCRIPT_CHUNK_BYTES = 16 * 1024;
const MAX_PROVISIONING_TRANSCRIPT_CHUNKS = 512;
const MAX_PROVISIONING_TRANSCRIPTS = 8;
const PROVISIONING_TRANSCRIPT_EMIT_DELAY_MS = 100;

export type CloudDeploymentChangedListener = (scope: CloudDeploymentChangeScope) => void;

export interface CloudPrivateKeyCapabilities {
  choose(owner: BrowserWindow): Promise<OperationResult<SshPrivateKeySelection>>;
  consume(token: string, passphrase: string | null): ResolvedPrivateKey;
  dispose(): void;
}

export type CloudSshKeyGenerator = () => Promise<ResolvedPrivateKey>;
export type CloudEgressIpv4Detector = () => Promise<CurrentEgressIpv4>;

export interface CloudSliverProvisioner {
  provision(input: ProvisionSliverServerInput): Promise<SliverProvisionResult>;
}

export interface CloudAwsProvider {
  preflight(): Promise<{ readonly region: string; readonly availabilityZones: readonly unknown[] }>;
  discover(input?: { readonly vpcId?: string }): Promise<AwsEc2DiscoveryResult>;
  create(
    input: Parameters<AwsEc2Provider["create"]>[0],
    onMutation?: Parameters<AwsEc2Provider["create"]>[1],
  ): Promise<AwsEc2DeploymentResource>;
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
  destroy(resource: AwsEc2DestroyResource): Promise<void>;
}

export interface CloudProxmoxProvider {
  preflight(): Promise<{
    readonly version: string;
    readonly nodes: readonly string[];
    readonly permissions: readonly string[];
  }>;
  checkPermissions(): Promise<ProxmoxPermissionCheckResult>;
  create(
    input: Parameters<ProxmoxProvider["create"]>[0],
    onMutation?: Parameters<ProxmoxProvider["create"]>[1],
  ): Promise<ProxmoxDeploymentResult>;
  refresh(resources: ProxmoxResources, deploymentId: string): Promise<ProxmoxDeploymentResult>;
  start(resources: ProxmoxResources, deploymentId: string): Promise<void>;
  stop(resources: ProxmoxResources, deploymentId: string): Promise<void>;
  reboot(resources: ProxmoxResources, deploymentId: string): Promise<void>;
  updateFirewall(
    resources: ProxmoxResources,
    deploymentId: string,
    policy: Parameters<ProxmoxProvider["updateFirewall"]>[2],
  ): Promise<void>;
  destroy(resources: ProxmoxResources, deploymentId: string): Promise<void>;
}

export type CloudAwsProviderFactory = (connection: AwsEc2ProviderConnection) => CloudAwsProvider;
export interface CloudAwsPermissionChecker {
  check(): Promise<CloudPermissionEvaluation>;
}
export type CloudAwsPermissionCheckerFactory = (
  connection: AwsEc2ProviderConnection,
) => CloudAwsPermissionChecker;
export type CloudProxmoxProviderFactory = (credentials: ProxmoxApiCredentials) => CloudProxmoxProvider;

export interface CloudAwsProfileSource {
  list(): Promise<readonly AwsCliProfileSummary[]>;
  credentialProvider(profileName: string, region?: string): Promise<AwsEc2CredentialProvider>;
}

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
  readonly awsProviderFactory?: CloudAwsProviderFactory;
  readonly awsPermissionCheckerFactory?: CloudAwsPermissionCheckerFactory;
  readonly awsProfileSource?: CloudAwsProfileSource;
  readonly proxmoxProviderFactory?: CloudProxmoxProviderFactory;
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
  readonly #awsProviderFactory: CloudAwsProviderFactory;
  readonly #awsPermissionCheckerFactory: CloudAwsPermissionCheckerFactory;
  readonly #awsProfiles: CloudAwsProfileSource;
  readonly #proxmoxProviderFactory: CloudProxmoxProviderFactory;
  readonly #now: () => number;
  readonly #idFactory: () => string;
  readonly #listeners = new Set<CloudDeploymentChangedListener>();
  readonly #destroyPlans = new Map<string, DestroyPlanEntry>();
  readonly #provisioningTranscripts = new Map<string, MutableProvisioningTranscript>();
  #transitionChain: Promise<void> = Promise.resolve();
  #transcriptEmitTimer: NodeJS.Timeout | undefined;
  #disposed = false;

  private constructor(options: CloudDeploymentServiceOptions, store: CloudDeploymentStore) {
    assertBoundedAbsoluteDirectory(options.rootDirectory, "cloud deployment root");
    assertBoundedAbsoluteDirectory(options.operatorConfigDirectory, "operator configuration directory");
    this.#operatorConfigDirectory = options.operatorConfigDirectory;
    this.#store = store;
    this.#vault = options.vault ?? new CloudCredentialVault(options.rootDirectory, options.safeStorage);
    this.#privateKeys = options.privateKeyCapabilities ?? new PrivateKeyCapabilities();
    this.#sshKeyGenerator = options.sshKeyGenerator ?? generateEd25519SshKeyPair;
    this.#egressIpv4Detector = options.egressIpv4Detector ?? detectCurrentEgressIpv4;
    this.#awsProviderFactory = options.awsProviderFactory ?? ((connection) => new AwsEc2Provider(connection));
    this.#awsPermissionCheckerFactory = options.awsPermissionCheckerFactory ?? (
      (connection) => new AwsEc2PermissionChecker(connection)
    );
    this.#awsProfiles = options.awsProfileSource ?? new AwsSharedProfileSource();
    this.#proxmoxProviderFactory = options.proxmoxProviderFactory ?? ((credentials) => new ProxmoxProvider(credentials));
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
    if (options.provisioner) {
      this.#provisioner = options.provisioner;
    } else {
      this.#provisioner = new SliverProvisioner();
    }
  }

  static async create(options: CloudDeploymentServiceOptions): Promise<CloudDeploymentService> {
    const store = options.store ?? await CloudDeploymentStore.load(options.rootDirectory);
    await recoverInterruptedTransitions(store);
    return new CloudDeploymentService(options, store);
  }

  subscribe(listener: CloudDeploymentChangedListener): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onChanged(listener: CloudDeploymentChangedListener): () => void {
    return this.subscribe(listener);
  }

  async getSnapshot(): Promise<OperationResult<CloudDeploymentSnapshot>> {
    try {
      this.#assertActive();
      let awsProfiles: readonly AwsCliProfileSummary[] = [];
      let awsProfileDiscoveryError: string | null = null;
      try {
        awsProfiles = await this.#awsProfiles.list();
      } catch (error) {
        awsProfileDiscoveryError = cloudErrorMessage(error, "AWS CLI profiles could not be discovered");
      }
      return {
        ok: true,
        value: Object.freeze({
          state: this.#store.getState(),
          credentials: await this.#vault.list(),
          secureCredentialStorage: this.#canPersistCredentials(),
          awsProfiles,
          awsProfileDiscoveryError,
          provisioningTranscripts: [...this.#provisioningTranscripts.values()].map(snapshotTranscript),
        }),
      };
    } catch (error) {
      return failure(error, "Cloud deployment state is unavailable");
    }
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

  async createCredential(
    input: CreateCloudCredentialInput,
  ): Promise<OperationResult<CloudCredentialSummary>> {
    try {
      this.#assertActive();
      const parsed = parseCreateCloudCredentialInput(input);
      if (parsed.provider === "aws" && "profileName" in parsed) {
        const profiles = await this.#awsProfiles.list();
        if (!profiles.some(({ name }) => name === parsed.profileName)) {
          throw new Error("The selected AWS CLI profile is no longer available");
        }
      }
      const key = parsed.sshPrivateKeyToken === null
        ? await this.#sshKeyGenerator()
        : this.#privateKeys.consume(parsed.sshPrivateKeyToken, parsed.sshPassphrase);
      const sshPassphrase = parsed.sshPrivateKeyToken === null ? null : parsed.sshPassphrase;
      const summary = parsed.provider === "aws"
        ? await this.#vault.create({
            provider: "aws",
            label: parsed.label,
            defaultRegion: parsed.defaultRegion,
            sshUsername: parsed.sshUsername,
            secret: "profileName" in parsed
              ? {
                  profileName: parsed.profileName,
                  sshPrivateKey: key.privateKey,
                  sshPassphrase,
                }
              : {
                  accessKeyId: parsed.accessKeyId,
                  secretAccessKey: parsed.secretAccessKey,
                  sessionToken: parsed.sessionToken,
                  sshPrivateKey: key.privateKey,
                  sshPassphrase,
                },
          })
        : await this.#vault.create({
            provider: "proxmox",
            label: parsed.label,
            sshUsername: parsed.sshUsername,
            secret: {
              endpoint: parsed.endpoint,
              tokenId: parsed.tokenId,
              tokenSecret: parsed.tokenSecret,
              tlsCaCertificate: parsed.tlsCaCertificate,
              sshPrivateKey: key.privateKey,
              sshPassphrase,
            },
          });
      this.#emitChanged();
      return { ok: true, value: summary };
    } catch (error) {
      return failure(error, "The cloud credential could not be saved");
    }
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
              await this.#awsConnection(summary.defaultRegion, secret),
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
      return await this.#vault.withCredential(summary.id, "proxmox", async (secret) => {
        try {
          const inventory = await this.#proxmoxProviderFactory(proxmoxCredentials(secret)).checkPermissions();
          return {
            ok: true,
            value: {
              provider: "proxmox",
              summary: permissionSummary(
                `Proxmox ${inventory.version}`,
                inventory.permissions,
                "privilege",
                inventory.clusterFirewallEnabled === false ? "cluster firewall is disabled" : undefined,
              ),
              permissions: inventory.permissions,
            },
          };
        } catch (error) {
          return failure(error, "Proxmox rejected the credential", credentialValues(secret));
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
          const provider = this.#awsProviderFactory(await this.#awsConnection(parsed.region, secret));
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
            : await this.#provisionProxmox(created.value.deployment);
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
            : await this.#runProxmoxLifecycle(deployment, parsed.action);
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
            : await this.#updateProxmoxFirewall(deployment, parsed);
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
    input: ListAwsFirewallRulesInput,
  ): Promise<OperationResult<AwsFirewallSnapshot>> {
    try {
      this.#assertActive();
      const parsed = parseListAwsFirewallRulesInput(input);
      const deployment = this.#requireAwsDeployment(parsed.deploymentId);
      if (deployment.status === "provisioning" || deployment.status === "deleting") {
        return { ok: false, error: "The deployment is busy" };
      }
      return await this.#vault.withCredential(deployment.credentialId, "aws", async (secret) => {
        try {
          const provider = this.#awsProviderFactory(
            await this.#awsConnection(deployment.spec.region, secret),
          );
          return {
            ok: true,
            value: await provider.listFirewallRules(awsResourceFromRecord(deployment)),
          };
        } catch (error) {
          return failure(
            error,
            "The AWS firewall rules could not be listed",
            credentialValues(secret),
          );
        }
      });
    } catch (error) {
      return failure(error, "The AWS firewall rule list request was rejected");
    }
  }

  async createFirewallRule(
    input: CreateAwsFirewallRuleInput,
  ): Promise<OperationResult<AwsFirewallSnapshot>> {
    try {
      this.#assertActive();
      const parsed = parseCreateAwsFirewallRuleInput(input);
      return await this.#mutateAwsFirewall(
        parsed.deploymentId,
        parsed.expectedRevision,
        "The AWS firewall rule could not be created",
        async (provider, resource, before) => upsertAwsFirewallRule(
          before,
          await provider.createFirewallRule(resource, parsed.rule),
        ),
      );
    } catch (error) {
      return failure(error, "The AWS firewall rule creation request was rejected");
    }
  }

  async updateFirewallRule(
    input: UpdateAwsFirewallRuleInput,
  ): Promise<OperationResult<AwsFirewallSnapshot>> {
    try {
      this.#assertActive();
      const parsed = parseUpdateAwsFirewallRuleInput(input);
      return await this.#mutateAwsFirewall(
        parsed.deploymentId,
        parsed.expectedRevision,
        "The AWS firewall rule could not be updated",
        async (provider, resource, before) => upsertAwsFirewallRule(
          before,
          await provider.updateFirewallRule(resource, parsed.ruleId, parsed.rule),
        ),
      );
    } catch (error) {
      return failure(error, "The AWS firewall rule update request was rejected");
    }
  }

  async deleteFirewallRule(
    input: DeleteAwsFirewallRuleInput,
  ): Promise<OperationResult<AwsFirewallSnapshot>> {
    try {
      this.#assertActive();
      const parsed = parseDeleteAwsFirewallRuleInput(input);
      return await this.#mutateAwsFirewall(
        parsed.deploymentId,
        parsed.expectedRevision,
        "The AWS firewall rule could not be deleted",
        async (provider, resource, before) => {
          await provider.deleteFirewallRule(resource, parsed.ruleId);
          return removeAwsFirewallRule(before, parsed.ruleId);
        },
      );
    } catch (error) {
      return failure(error, "The AWS firewall rule deletion request was rejected");
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
          const deleted = await this.#store.delete({
            deploymentId: deployment.id,
            expectedRevision: this.#store.getState().revision,
          });
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
    if (this.#transcriptEmitTimer) clearTimeout(this.#transcriptEmitTimer);
    this.#transcriptEmitTimer = undefined;
    for (const token of [...this.#destroyPlans.keys()]) this.#discardDestroyPlan(token);
    this.#listeners.clear();
    for (const deploymentId of [...this.#provisioningTranscripts.keys()]) {
      this.#discardProvisioningTranscript(deploymentId);
    }
    this.#privateKeys.dispose();
    this.#vault.dispose();
  }

  async #provisionAws(deployment: AwsCloudDeploymentRecord): Promise<CloudDeploymentRecord> {
    return await this.#vault.withCredential(deployment.credentialId, "aws", async (secret, summary) => {
      try {
        const provider = this.#awsProviderFactory(await this.#awsConnection(deployment.spec.region, secret));
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

  async #provisionProxmox(deployment: ProxmoxCloudDeploymentRecord): Promise<CloudDeploymentRecord> {
    return await this.#vault.withCredential(deployment.credentialId, "proxmox", async (secret, summary) => {
      try {
        const provider = this.#proxmoxProviderFactory(proxmoxCredentials(secret));
        await provider.preflight();
        const publicKey = publicKeyForCredential(secret);
        let current = await this.#persistPhase(deployment.id, "creating-instance");
        if (current.provider !== "proxmox") throw new Error("Cloud deployment provider changed unexpectedly");
        const result = await provider.create({
          deploymentId: current.id,
          displayName: current.name,
          node: current.spec.node,
          templateVmId: current.spec.templateVmId,
          vmId: current.spec.vmId,
          storage: current.spec.storage,
          bridge: current.spec.bridge,
          cores: current.spec.cores,
          memoryMiB: current.spec.memoryMiB,
          diskGiB: current.spec.diskGiB,
          ipConfig: current.spec.ipConfig,
          gateway: current.spec.gateway,
          sshUsername: summary.sshUsername,
          sshPublicKey: publicKey,
          sshPort: current.spec.sshPort,
          multiplayerPort: current.spec.multiplayerPort,
          sshCidrs: current.spec.sshCidrs,
          operatorCidrs: current.spec.operatorCidrs,
        }, async (event) => {
          const phase: CloudDeploymentPhase = event.phase === "configured"
            ? "configuring-firewall"
            : event.phase === "firewall"
              ? "starting-instance"
              : event.phase === "started"
                ? "installing-sliver"
                : "creating-instance";
          await this.#persistPatch(deployment.id, (latest) => {
            if (latest.provider !== "proxmox") throw new Error("Cloud deployment provider changed unexpectedly");
            return {
              ...latest,
              phase,
              runtime: { ...latest.runtime, vmId: event.resources.vmId },
              managedAssets: [{
                resourceType: "proxmox-vm",
                resourceId: String(event.resources.vmId),
                displayName: event.resources.vmName,
                tagged: event.phase === "configured" || event.phase === "firewall" || event.phase === "started",
              }],
            };
          });
        });
        current = await this.#persistPatch(deployment.id, (latest) => {
          if (latest.provider !== "proxmox") throw new Error("Cloud deployment provider changed unexpectedly");
          return applyProxmoxResource(latest, result, "installing-sliver");
        });
        if (current.provider !== "proxmox") throw new Error("Cloud deployment provider changed unexpectedly");
        const provisioned = await this.#provisioner.provision({
          deploymentId: current.id,
          operatorEndpointHost: result.address,
          multiplayerPort: current.spec.multiplayerPort,
          operatorName: current.spec.operatorName,
          ssh: {
            host: result.address,
            port: current.spec.sshPort,
            username: summary.sshUsername,
            privateKey: secret.sshPrivateKey,
            ...(secret.sshPassphrase === null ? {} : { passphrase: secret.sshPassphrase }),
          },
          onOutput: (event) => this.#captureProvisionerOutput(current.id, event),
        });
        return await this.#completeProvisioning(current.id, provisioned);
      } catch (error) {
        throw new Error(cloudErrorMessage(error, "Proxmox deployment failed", credentialValues(secret)));
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
        const provider = this.#awsProviderFactory(await this.#awsConnection(deployment.spec.region, secret));
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

  async #runProxmoxLifecycle(
    deployment: ProxmoxCloudDeploymentRecord,
    action: CloudDeploymentActionInput["action"],
  ): Promise<CloudDeploymentRecord> {
    return await this.#vault.withCredential(deployment.credentialId, "proxmox", async (secret) => {
      try {
        const provider = this.#proxmoxProviderFactory(proxmoxCredentials(secret));
        const resources = proxmoxResourcesFromRecord(deployment);
        await provider[action](resources, deployment.id);
        const refreshed = await provider.refresh(resources, deployment.id);
        return await this.#persistPatch(deployment.id, (current) => {
          if (current.provider !== "proxmox") throw new Error("Cloud deployment provider changed unexpectedly");
          return applyProxmoxResource(
            current,
            refreshed,
            refreshed.state === "stopped" ? "stopped" : "ready",
          );
        });
      } catch (error) {
        throw new Error(cloudErrorMessage(error, "Proxmox lifecycle action failed", credentialValues(secret)));
      }
    });
  }

  async #updateAwsFirewall(
    deployment: AwsCloudDeploymentRecord,
    input: UpdateCloudFirewallInput,
  ): Promise<CloudDeploymentRecord> {
    return await this.#vault.withCredential(deployment.credentialId, "aws", async (secret) => {
      try {
        const provider = this.#awsProviderFactory(await this.#awsConnection(deployment.spec.region, secret));
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

  async #updateProxmoxFirewall(
    deployment: ProxmoxCloudDeploymentRecord,
    input: UpdateCloudFirewallInput,
  ): Promise<CloudDeploymentRecord> {
    return await this.#vault.withCredential(deployment.credentialId, "proxmox", async (secret) => {
      try {
        const provider = this.#proxmoxProviderFactory(proxmoxCredentials(secret));
        await provider.updateFirewall(proxmoxResourcesFromRecord(deployment), deployment.id, {
          sshPort: deployment.spec.sshPort,
          multiplayerPort: deployment.spec.multiplayerPort,
          sshCidrs: input.sshCidrs,
          operatorCidrs: input.operatorCidrs,
        });
        return await this.#persistPatch(deployment.id, (current) => {
          if (current.provider !== "proxmox") throw new Error("Cloud deployment provider changed unexpectedly");
          return {
            ...current,
            status: current.status === "stopped" ? "stopped" : "running",
            phase: current.status === "stopped" ? "stopped" : "ready",
            lastError: null,
            spec: { ...current.spec, sshCidrs: input.sshCidrs, operatorCidrs: input.operatorCidrs },
          };
        });
      } catch (error) {
        throw new Error(cloudErrorMessage(error, "Proxmox firewall update failed", credentialValues(secret)));
      }
    });
  }

  async #destroyProviderResources(deployment: CloudDeploymentRecord): Promise<void> {
    if (deployment.provider === "aws") {
      if (!hasTrackedAwsResources(deployment)) return;
      await this.#vault.withCredential(deployment.credentialId, "aws", async (secret) => {
        try {
          await this.#awsProviderFactory(await this.#awsConnection(deployment.spec.region, secret))
            .destroy(awsDestroyResourceFromRecord(deployment));
        } catch (error) {
          throw new Error(cloudErrorMessage(error, "AWS resource termination failed", credentialValues(secret)));
        }
      });
      return;
    }
    if (deployment.runtime.vmId === null && !deployment.managedAssets.some(({ resourceType }) => resourceType === "proxmox-vm")) {
      return;
    }
    await this.#vault.withCredential(deployment.credentialId, "proxmox", async (secret) => {
      try {
        await this.#proxmoxProviderFactory(proxmoxCredentials(secret))
          .destroy(proxmoxResourcesFromRecord(deployment), deployment.id);
      } catch (error) {
        throw new Error(cloudErrorMessage(error, "Proxmox resource termination failed", credentialValues(secret)));
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
              await this.#awsConnection(deployment.spec.region, secret),
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

  #requireAwsDeployment(deploymentId: string): AwsCloudDeploymentRecord {
    if (!isUuidV4(deploymentId)) throw new TypeError("Invalid cloud deployment identity");
    const deployment = this.#store.getState().deployments.find(({ id }) => id === deploymentId);
    if (!deployment) throw new Error("The cloud deployment no longer exists");
    if (deployment.provider !== "aws") {
      throw new Error("Firewall rule management is only available for AWS deployments");
    }
    return deployment;
  }

  async #requireMatchingCredential(credentialId: string, provider: "aws" | "proxmox"): Promise<void> {
    await this.#vault.withCredential(credentialId, provider, () => undefined);
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
    this.#assertActive();
    const state = this.#store.getState();
    const current = state.deployments.find(({ id }) => id === deploymentId);
    if (!current) throw new Error("The cloud deployment no longer exists");
    const updated = await this.#store.update({
      expectedRevision: state.revision,
      deployment: mutate(current),
    });
    if (!updated.ok) throw new Error(updated.error);
    this.#emitChanged();
    return updated.value.deployment;
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

  #serializeDeployment<T>(_deploymentId: string, operation: () => Promise<T>): Promise<T> {
    const result = this.#transitionChain.then(operation, operation);
    this.#transitionChain = result.then(
      () => undefined,
      () => undefined,
    );
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
  ): Promise<AwsEc2ProviderConnection> {
    if ("profileName" in secret) {
      return {
        region,
        credentials: await this.#awsProfiles.credentialProvider(secret.profileName, region),
      };
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

function proxmoxCredentials(secret: ProxmoxCredentialSecret): ProxmoxApiCredentials {
  return {
    endpoint: secret.endpoint,
    tokenId: secret.tokenId,
    tokenSecret: secret.tokenSecret,
    tlsCaCertificate: secret.tlsCaCertificate,
  };
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

function publicKeyForCredential(secret: AwsCredentialSecret | ProxmoxCredentialSecret): string {
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

function awsFirewall(deployment: AwsCloudDeploymentRecord) {
  return {
    sshPort: deployment.spec.sshPort,
    sshSourceCidrs: deployment.spec.sshCidrs,
    multiplayerPort: deployment.spec.multiplayerPort,
    multiplayerSourceCidrs: deployment.spec.operatorCidrs,
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

function applyProxmoxResource(
  deployment: ProxmoxCloudDeploymentRecord,
  result: ProxmoxDeploymentResult,
  phase: "installing-sliver" | "ready" | "stopped",
): ProxmoxCloudDeploymentRecord {
  const stopped = result.state === "stopped";
  return {
    ...deployment,
    status: phase === "installing-sliver" ? "provisioning" : stopped ? "stopped" : "running",
    phase: stopped ? "stopped" : phase,
    remoteHost: result.address || deployment.remoteHost,
    lastError: null,
    managedAssets: [{
      resourceType: "proxmox-vm",
      resourceId: String(result.resources.vmId),
      displayName: result.resources.vmName,
      tagged: true,
    }],
    runtime: {
      vmId: result.resources.vmId,
      node: result.resources.node,
      ipAddress: result.address || null,
    },
  };
}

function proxmoxResourcesFromRecord(deployment: ProxmoxCloudDeploymentRecord): ProxmoxResources {
  const vmId = deployment.runtime.vmId;
  if (vmId === null) throw new Error("The Proxmox deployment resource identity is incomplete");
  return {
    node: deployment.runtime.node,
    vmId,
    vmName: deployment.managedAssets.find(({ resourceType }) => resourceType === "proxmox-vm")?.displayName ??
      `sliver-gui-${deployment.id.slice(0, 8)}`,
  };
}

function operatorConfigFileName(deploymentId: string): string {
  if (!isUuidV4(deploymentId)) throw new Error("Invalid cloud deployment identity");
  return `sliver-gui-cloud-${deploymentId}.cfg`;
}

function credentialValues(secret: AwsCredentialSecret | ProxmoxCredentialSecret): readonly string[] {
  if ("profileName" in secret) {
    return [secret.sshPrivateKey, secret.sshPassphrase]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
  }
  return Object.values(secret).filter((value): value is string => typeof value === "string" && value.length > 0);
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
  let message = error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
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
