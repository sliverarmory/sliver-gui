import { basename } from "node:path";

import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";

import {
  parseListCloudDnsZonesInput,
  parseListCloudDnsRecordsInput,
  parseCreateCloudDnsRecordInput,
  parseUpdateCloudDnsRecordInput,
  parseDeleteCloudDnsRecordInput,
  type CloudDnsZone,
  type CloudDnsRecord,
  type ListCloudDnsZonesInput,
  type ListCloudDnsRecordsInput,
  type CreateCloudDnsRecordInput,
  type UpdateCloudDnsRecordInput,
  type DeleteCloudDnsRecordInput,
} from "../shared/cloud-dns-contracts.js";

import {
  CLOUD_DEPLOYMENT_IPC_INVOKE,
  CLOUD_DEPLOYMENT_IPC_EVENTS,
  type AwsLoginProgress,
  type OpenAwsConsoleInput,
  type CloudCredentialIdInput,
  type CloudCredentialTestResult,
  type CloudOperatorPermission,
  type CreateCloudOperatorConfigInput,
  type CloudDeploymentSnapshot,
  type CloudDeploymentRefreshResult,
  type CopyCloudInstanceIdInput,
  type CopyCloudIpAddressInput,
  type CloudProvisioningTranscriptSnapshot,
  type CurrentEgressIpv4,
  type DestroyCloudDeploymentPlan,
  type ExecuteDestroyCloudDeploymentInput,
  type PrepareDestroyCloudDeploymentInput,
  type SshPrivateKeySelection,
  type SaveCloudOperatorConfigResult,
  parseCreateCloudOperatorConfigInput,
} from "../shared/cloud-deployment-ipc.js";
import {
  isAwsRegion,
  isUuidV4,
  parseCreateCloudFirewallRuleInput,
  parseCloudDeploymentActionInput,
  parseCreateCloudCredentialInput,
  parseBeginAzureLoginInput,
  parseCreateCloudDeploymentInput,
  parseRenameCloudDeploymentInput,
  parseDeleteCloudFirewallRuleInput,
  parseListCloudFirewallRulesInput,
  parseUpdateCloudFirewallRuleInput,
  parseUpdateCloudFirewallInput,
  type AzureCliAccountSummary,
  type BeginAzureLoginInput,
  type AzureLoginSelection,
  type CloudFirewallSnapshot,
  type CloudCredentialSummary,
  type CloudDeploymentActionInput,
  type RenameCloudDeploymentInput,
  type CloudDeploymentRecord,
  type CloudDeploymentState,
  type CreateCloudFirewallRuleInput,
  type CreateCloudCredentialInput,
  type CreateCloudDeploymentInput,
  type DeleteCloudFirewallRuleInput,
  type ListCloudFirewallRulesInput,
  type UpdateCloudFirewallRuleInput,
  type UpdateCloudFirewallInput,
} from "../shared/cloud-deployment-contracts.js";
import type { ManagedServerReference, OperationResult } from "../shared/contracts.js";
import {
  parseInstallLocalRedirectorInput,
  parseListLocalRedirectorListenersInput,
  parseRemoveLocalRedirectorInput,
  type InstallLocalRedirectorInput,
  type ListLocalRedirectorListenersInput,
  type LocalRedirectorListenerOption,
  type LocalRedirectorRecord,
  type RemoveLocalRedirectorInput,
  type SoftwareDeploymentState,
  type SoftwareInstallProgress,
  type SoftwareInstallProgressSnapshot,
} from "../shared/software-deployment-contracts.js";
import type { TerminalRuntimeAsset } from "../shared/stream-contracts.js";
import {
  parseSshDeploymentInput,
  parseSshHostKeyReviewInput,
  type SshOpenTabResult,
} from "../shared/ssh-contracts.js";
import {
  parseDiscoverAwsOptionsInput,
  parseDiscoverAzureOptionsInput,
  type AwsDeploymentOptions,
  type AzureDeploymentOptions,
  type DiscoverAwsOptionsInput,
  type DiscoverAzureOptionsInput,
} from "../shared/cloud-provider-inventory.js";
import { isSameRendererDocument } from "./security.js";
import { awsRequiredPermissionsTerraform } from "../shared/cloud-permission-terraform.js";
import { writePrivateArtifactFileAtomic } from "./secure-file.js";
import { awsConsoleEntryUrl } from "./cloud/aws-console-entry.js";
import type { TrustedWindowIdentity } from "./ipc.js";

type MaybePromise<T> = T | Promise<T>;

const MAX_OPERATOR_CONFIG_BYTES = 4 * 1024 * 1024;

export interface GeneratedCloudOperatorConfig {
  readonly operatorName: string;
  readonly publicIp: string;
  readonly port: number;
  readonly permissions: CloudOperatorPermission;
  readonly data: Buffer;
  readonly remoteRecoveryPath: string;
}

export type CloudOperatorMutationState = "not-started" | "unknown" | "created";

export type GenerateCloudOperatorConfigResult =
  | { readonly ok: true; readonly value: GeneratedCloudOperatorConfig; readonly error?: never }
  | {
      readonly ok: false;
      readonly error: string;
      readonly mutationState: CloudOperatorMutationState;
      readonly remoteRecoveryPath?: string;
      readonly remoteRecoveryCandidatePath?: string;
      readonly remoteHandoffCandidatePath?: string;
      readonly value?: never;
    };

export interface CloudDeploymentController {
  /** Main-only lookup of an active config's local deployment provenance. */
  resolveManagedServer?(configDigest: string): ManagedServerReference | null;
  getSnapshot(): MaybePromise<OperationResult<CloudDeploymentSnapshot>>;
  refreshDeployments(): MaybePromise<OperationResult<CloudDeploymentRefreshResult>>;
  getProvisioningTranscripts(): MaybePromise<OperationResult<CloudProvisioningTranscriptSnapshot>>;
  getTerminalRuntime(): MaybePromise<OperationResult<TerminalRuntimeAsset>>;
  detectCurrentEgressIpv4(): MaybePromise<OperationResult<CurrentEgressIpv4>>;
  chooseSshPrivateKey(owner: BrowserWindow): MaybePromise<OperationResult<SshPrivateKeySelection>>;
  createCredential(input: CreateCloudCredentialInput, signal?: AbortSignal, ownerId?: number, onPendingAuthorization?: (url: string | null) => void, onProgress?: (phase: AwsLoginProgress["phase"]) => void): MaybePromise<OperationResult<CloudCredentialSummary>>;
  loginAwsCredential(input: CloudCredentialIdInput, signal?: AbortSignal, onPendingAuthorization?: (url: string | null) => void, onProgress?: (phase: AwsLoginProgress["phase"]) => void): MaybePromise<OperationResult<CloudCredentialSummary>>;
  beginAzureLogin(input: BeginAzureLoginInput, signal?: AbortSignal, ownerId?: number): MaybePromise<OperationResult<AzureLoginSelection>>;
  loginAzureCredential(input: CloudCredentialIdInput, signal?: AbortSignal): MaybePromise<OperationResult<CloudCredentialSummary>>;
  cancelAzureLogin(ownerId?: number): void;
  deleteCredential(input: CloudCredentialIdInput): MaybePromise<OperationResult>;
  testCredential(input: CloudCredentialIdInput): MaybePromise<OperationResult<CloudCredentialTestResult>>;
  discoverAwsOptions(input: DiscoverAwsOptionsInput): MaybePromise<OperationResult<AwsDeploymentOptions>>;
  discoverAzureAccounts(): MaybePromise<OperationResult<readonly AzureCliAccountSummary[]>>;
  discoverAzureOptions(input: DiscoverAzureOptionsInput): MaybePromise<OperationResult<AzureDeploymentOptions>>;
  listDnsZones(input: ListCloudDnsZonesInput): MaybePromise<OperationResult<readonly CloudDnsZone[]>>;
  listDnsRecords(input: ListCloudDnsRecordsInput): MaybePromise<OperationResult<readonly CloudDnsRecord[]>>;
  createDnsRecord(input: CreateCloudDnsRecordInput): MaybePromise<OperationResult>;
  updateDnsRecord(input: UpdateCloudDnsRecordInput): MaybePromise<OperationResult>;
  deleteDnsRecord(input: DeleteCloudDnsRecordInput): MaybePromise<OperationResult>;
  createDeployment(input: CreateCloudDeploymentInput): MaybePromise<OperationResult<CloudDeploymentRecord>>;
  getSoftwareState(): MaybePromise<OperationResult<SoftwareDeploymentState>>;
  getSoftwareInstallProgress(deploymentId: string): MaybePromise<OperationResult<SoftwareInstallProgressSnapshot | null>>;
  listSoftwareListeners(input: ListLocalRedirectorListenersInput): MaybePromise<OperationResult<readonly LocalRedirectorListenerOption[]>>;
  installLocalRedirector(input: InstallLocalRedirectorInput, onProgress?: (progress: SoftwareInstallProgress) => void): MaybePromise<OperationResult<LocalRedirectorRecord>>;
  removeLocalRedirector(input: RemoveLocalRedirectorInput): MaybePromise<OperationResult<SoftwareDeploymentState>>;
  generateOperatorConfig(
    input: CreateCloudOperatorConfigInput,
  ): MaybePromise<GenerateCloudOperatorConfigResult>;
  runLifecycleAction(input: CloudDeploymentActionInput): MaybePromise<OperationResult<CloudDeploymentRecord>>;
  renameDeployment(input: RenameCloudDeploymentInput): MaybePromise<OperationResult<CloudDeploymentRecord>>;
  updateFirewall(input: UpdateCloudFirewallInput): MaybePromise<OperationResult<CloudDeploymentRecord>>;
  listFirewallRules(input: ListCloudFirewallRulesInput): MaybePromise<OperationResult<CloudFirewallSnapshot>>;
  createFirewallRule(input: CreateCloudFirewallRuleInput): MaybePromise<OperationResult<CloudFirewallSnapshot>>;
  updateFirewallRule(input: UpdateCloudFirewallRuleInput): MaybePromise<OperationResult<CloudFirewallSnapshot>>;
  deleteFirewallRule(input: DeleteCloudFirewallRuleInput): MaybePromise<OperationResult<CloudFirewallSnapshot>>;
  prepareDestroyDeployment(
    input: PrepareDestroyCloudDeploymentInput,
  ): MaybePromise<OperationResult<DestroyCloudDeploymentPlan>>;
  executeDestroyDeployment(
    input: ExecuteDestroyCloudDeploymentInput,
  ): MaybePromise<OperationResult<CloudDeploymentState>>;
}

export type CloudWindowAuthorizer = (
  identity: TrustedWindowIdentity,
  window: BrowserWindow,
) => boolean;

export interface CloudSshWindowController {
  open(deploymentId: string): MaybePromise<OperationResult<SshOpenTabResult>>;
  approveHostKey(token: string): MaybePromise<OperationResult<SshOpenTabResult>>;
}

export function registerCloudDeploymentIpcHandlers(
  controller: CloudDeploymentController,
  exactRendererUrl: string,
  authorizeWindow: CloudWindowAuthorizer,
  sshWindows?: CloudSshWindowController,
): void {
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.getSnapshot,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    () => controller.getSnapshot(),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.refreshDeployments,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    () => controller.refreshDeployments(),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.copyInstanceId,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseCopyInstanceIdInput(requireSingleArgument(args))),
    async (cloudSender, input): Promise<OperationResult> => {
      const result = await controller.getSnapshot();
      if (!result.ok) return { ok: false, error: "The instance ID could not be loaded." };
      const deployment = result.value.state.deployments.find(({ id }) => id === input.deploymentId);
      if (deployment?.provider !== "aws" || !deployment.runtime.instanceId) {
        return { ok: false, error: "No instance ID is available for this deployment." };
      }
      requireCurrentCloudSender(cloudSender, exactRendererUrl, authorizeWindow);
      await clipboard.writeText(deployment.runtime.instanceId);
      return { ok: true };
    },
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.copyIpAddress,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseCopyIpAddressInput(requireSingleArgument(args))),
    async (cloudSender, input): Promise<OperationResult> => {
      const result = await controller.getSnapshot();
      if (!result.ok) return { ok: false, error: "The IP address could not be loaded." };
      const deployment = result.value.state.deployments.find(({ id }) => id === input.deploymentId);
      const address = input.kind === "public"
        ? deployment?.runtime.publicIpAddress
        : deployment?.runtime.privateIpAddress;
      if (!address) return { ok: false, error: `No ${input.kind} IP address is available for this deployment.` };
      requireCurrentCloudSender(cloudSender, exactRendererUrl, authorizeWindow);
      await clipboard.writeText(address);
      return { ok: true };
    },
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsPermissionsTerraform,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    async (): Promise<OperationResult> => {
      await clipboard.writeText(awsRequiredPermissionsTerraform());
      return { ok: true };
    },
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.getProvisioningTranscripts,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    () => controller.getProvisioningTranscripts(),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.getTerminalRuntime,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    () => controller.getTerminalRuntime(),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.detectCurrentEgressIpv4,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    () => controller.detectCurrentEgressIpv4(),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.chooseSshPrivateKey,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    ({ window }) => controller.chooseSshPrivateKey(window),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.createCredential,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseCreateCloudCredentialInput(requireSingleArgument(args))),
    ({ sender }, input) => {
      if (!("authentication" in input) || input.authentication !== "login") return controller.createCredential(input);
      return withCloudLogin(sender, input.provider, async (signal, onPendingAuthorization, onProgress) => {
        if (input.provider === "aws") return controller.createCredential(input, signal, undefined, onPendingAuthorization, onProgress);
        try {
          return await controller.createCredential(input, signal, sender.id);
        } finally {
          stagedAzureLogins.get(sender)?.();
        }
      });
    },
    scrubCredentialArguments,
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.openAwsConsole,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseOpenAwsConsoleInput(requireSingleArgument(args))),
    async ({ sender }, input): Promise<OperationResult> => {
      // Cancellation alone is insufficient: the old operation must settle and
      // release its ownership before browser-session preparation can restart.
      if (pendingCloudLogins.get(sender)?.provider === "aws") {
        return { ok: false, error: "Complete or cancel the current AWS sign-in and wait for it to finish before opening AWS Console." };
      }
      const url = awsConsoleEntryUrl(input.region);
      try {
        await shell.openExternal(url);
        return { ok: true };
      } catch {
        return { ok: false, error: "Could not open AWS Console in your browser. Please try again." };
      }
    },
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.loginAwsCredential,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseCredentialIdInput(requireSingleArgument(args))),
    ({ sender }, input) => withCloudLogin(sender, "aws", (signal, onPendingAuthorization, onProgress) => controller.loginAwsCredential(input, signal, onPendingAuthorization, onProgress)),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    async ({ sender }): Promise<OperationResult> => {
      const pending = pendingCloudLogins.get(sender);
      if (pending?.provider !== "aws" || pending.controller.signal.aborted || !pending.authorizationUrl) {
        return { ok: false, error: "No AWS sign-in link is available. Start AWS Login and try again." };
      }
      await clipboard.writeText(pending.authorizationUrl);
      return { ok: true };
    },
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.cancelAwsLogin,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    ({ sender }) => {
      const pending = pendingCloudLogins.get(sender);
      if (pending?.provider === "aws") pending.controller.abort();
      return { ok: true };
    },
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.beginAzureLogin,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseBeginAzureLoginInput(requireSingleArgument(args))),
    ({ sender }, input) => withCloudLogin(sender, "azure", async (signal) => {
      stagedAzureLogins.get(sender)?.();
      const discard = trackAzureLoginSelection(sender, () => controller.cancelAzureLogin(sender.id));
      try {
        const result = await controller.beginAzureLogin(input, signal, sender.id);
        if (!result.ok || signal.aborted) discard();
        return result;
      } catch (error) {
        discard();
        throw error;
      }
    }),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.loginAzureCredential,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseCredentialIdInput(requireSingleArgument(args))),
    ({ sender }, input) => withCloudLogin(sender, "azure", (signal) => controller.loginAzureCredential(input, signal)),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.cancelAzureLogin,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    ({ sender }) => {
      const pending = pendingCloudLogins.get(sender);
      if (pending?.provider === "azure") pending.controller.abort();
      const discard = stagedAzureLogins.get(sender);
      if (discard) discard();
      else controller.cancelAzureLogin(sender.id);
      return { ok: true };
    },
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.deleteCredential,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseCredentialIdInput(requireSingleArgument(args))),
    (_sender, input) => controller.deleteCredential(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.testCredential,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseCredentialIdInput(requireSingleArgument(args))),
    (_sender, input) => controller.testCredential(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.discoverAwsOptions,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseDiscoverAwsOptionsInput(requireSingleArgument(args))),
    (_sender, input) => controller.discoverAwsOptions(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.discoverAzureAccounts,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    () => controller.discoverAzureAccounts(),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.discoverAzureOptions,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseDiscoverAzureOptionsInput(requireSingleArgument(args))),
    (_sender, input) => controller.discoverAzureOptions(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.createDeployment,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseCreateCloudDeploymentInput(requireSingleArgument(args))),
    (_sender, input) => controller.createDeployment(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.getSoftwareState,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    () => controller.getSoftwareState(),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.getSoftwareInstallProgress,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseListLocalRedirectorListenersInput(requireSingleArgument(args))),
    (_sender, input) => controller.getSoftwareInstallProgress(input.deploymentId),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.listSoftwareListeners,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseListLocalRedirectorListenersInput(requireSingleArgument(args))),
    (_sender, input) => controller.listSoftwareListeners(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.installLocalRedirector,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseInstallLocalRedirectorInput(requireSingleArgument(args))),
    async (cloudSender, input) => {
      let active = true;
      const revoke = (): void => { active = false; };
      const navigation = (event: { readonly isMainFrame: boolean }): void => {
        if (event.isMainFrame) revoke();
      };
      cloudSender.sender.once("destroyed", revoke);
      cloudSender.sender.once("render-process-gone", revoke);
      cloudSender.sender.on("did-start-navigation", navigation);
      const onProgress = (progress: SoftwareInstallProgress): void => {
        if (!active || progress.deploymentId !== input.deploymentId) return;
        try {
          requireCurrentCloudSender(cloudSender, exactRendererUrl, authorizeWindow);
          cloudSender.sender.send(CLOUD_DEPLOYMENT_IPC_EVENTS.softwareInstallProgress, progress);
        } catch { /* The initiating document may close or navigate during installation. */ }
      };
      try {
        return await controller.installLocalRedirector(input, onProgress);
      } finally {
        active = false;
        cloudSender.sender.removeListener("destroyed", revoke);
        cloudSender.sender.removeListener("render-process-gone", revoke);
        cloudSender.sender.removeListener("did-start-navigation", navigation);
      }
    },
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.removeLocalRedirector,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseRemoveLocalRedirectorInput(requireSingleArgument(args))),
    (_sender, input) => controller.removeLocalRedirector(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.createOperatorConfig,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseCreateCloudOperatorConfigInput(requireSingleArgument(args))),
    async (cloudSender, input): Promise<OperationResult<SaveCloudOperatorConfigResult>> => {
      const defaultFileName = `${input.operatorName}.cfg`;
      let selection;
      try {
        selection = await dialog.showSaveDialog(cloudSender.window, {
          title: `Save ${input.operatorName} operator config`,
          defaultPath: defaultFileName,
          filters: [{ name: "Sliver operator config", extensions: ["cfg"] }],
        });
      } catch {
        return {
          ok: true,
          value: {
            saved: false,
            fileName: defaultFileName,
            mutationState: "not-started",
            error: "The operator configuration save dialog could not be opened",
          },
        };
      }
      requireCurrentCloudSender(cloudSender, exactRendererUrl, authorizeWindow);
      if (selection.canceled || !selection.filePath) {
        return {
          ok: true,
          value: { saved: false, fileName: defaultFileName, mutationState: "not-started" },
        };
      }

      let generated: GenerateCloudOperatorConfigResult;
      try {
        generated = await controller.generateOperatorConfig(input);
      } catch {
        requireCurrentCloudSender(cloudSender, exactRendererUrl, authorizeWindow);
        return {
          ok: true,
          value: postMutationSaveFailure(
            defaultFileName,
            "unknown",
            "The operator request ended without a confirmed server outcome.",
          ),
        };
      }
      if (!generated.ok) {
        requireCurrentCloudSender(cloudSender, exactRendererUrl, authorizeWindow);
        if (generated.mutationState === "not-started") {
          return {
            ok: true,
            value: {
              saved: false,
              fileName: defaultFileName,
              mutationState: "not-started",
              error: generated.error,
            },
          };
        }
        const remoteRecoveryPath = generated.mutationState === "created" &&
            isManagedOperatorRecoveryPath(input.deploymentId, generated.remoteRecoveryPath)
          ? generated.remoteRecoveryPath
          : undefined;
        const remoteRecoveryCandidatePath = generated.mutationState === "unknown" &&
            isManagedOperatorRecoveryPath(input.deploymentId, generated.remoteRecoveryCandidatePath)
          ? generated.remoteRecoveryCandidatePath
          : undefined;
        const remoteHandoffCandidatePath = isManagedOperatorHandoffPath(
          input.deploymentId,
          generated.remoteHandoffCandidatePath,
        )
          ? generated.remoteHandoffCandidatePath
          : undefined;
        return {
          ok: true,
          value: postMutationSaveFailure(
            defaultFileName,
            generated.mutationState,
            generated.error,
            remoteRecoveryPath,
            remoteRecoveryCandidatePath,
            remoteHandoffCandidatePath,
          ),
        };
      }
      const { data, remoteRecoveryPath } = generated.value;
      const validRecoveryPath = isManagedOperatorRecoveryPath(input.deploymentId, remoteRecoveryPath);
      try {
        requireCurrentCloudSender(cloudSender, exactRendererUrl, authorizeWindow);
        if (
          generated.value.operatorName !== input.operatorName ||
          generated.value.publicIp !== input.publicIp ||
          generated.value.port !== input.port ||
          generated.value.permissions !== input.permissions ||
          !Buffer.isBuffer(data) ||
          data.length < 1 ||
          data.length > MAX_OPERATOR_CONFIG_BYTES ||
          !validRecoveryPath
        ) {
          return {
            ok: true,
            value: postMutationSaveFailure(
              defaultFileName,
              "created",
              "The generated operator configuration failed local verification.",
              validRecoveryPath ? remoteRecoveryPath : undefined,
            ),
          };
        }
        await writePrivateArtifactFileAtomic(selection.filePath, data, () => {
          requireCurrentCloudSender(cloudSender, exactRendererUrl, authorizeWindow);
        });
        return {
          ok: true,
          value: {
            saved: true,
            fileName: safeSavedFileName(selection.filePath, defaultFileName),
            mutationState: "created",
          },
        };
      } catch (error) {
        if (error instanceof CloudSenderRevokedError) throw error;
        return {
          ok: true,
          value: postMutationSaveFailure(
            defaultFileName,
            "created",
            "The operator was created, but its configuration could not be saved at the selected location.",
            validRecoveryPath ? remoteRecoveryPath : undefined,
          ),
        };
      } finally {
        if (Buffer.isBuffer(data)) data.fill(0);
      }
    },
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.listDnsZones,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseListCloudDnsZonesInput(requireSingleArgument(args))),
    (_sender, input) => controller.listDnsZones(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.listDnsRecords,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseListCloudDnsRecordsInput(requireSingleArgument(args))),
    (_sender, input) => controller.listDnsRecords(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.createDnsRecord,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseCreateCloudDnsRecordInput(requireSingleArgument(args))),
    (_sender, input) => controller.createDnsRecord(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.updateDnsRecord,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseUpdateCloudDnsRecordInput(requireSingleArgument(args))),
    (_sender, input) => controller.updateDnsRecord(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.deleteDnsRecord,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseDeleteCloudDnsRecordInput(requireSingleArgument(args))),
    (_sender, input) => controller.deleteDnsRecord(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.renameDeployment,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseRenameCloudDeploymentInput(requireSingleArgument(args))),
    (_sender, input) => controller.renameDeployment(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.runLifecycleAction,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseCloudDeploymentActionInput(requireSingleArgument(args))),
    (_sender, input) => controller.runLifecycleAction(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.updateFirewall,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseUpdateCloudFirewallInput(requireSingleArgument(args))),
    (_sender, input) => controller.updateFirewall(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.listFirewallRules,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseListCloudFirewallRulesInput(requireSingleArgument(args))),
    (_sender, input) => controller.listFirewallRules(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.createFirewallRule,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseCreateCloudFirewallRuleInput(requireSingleArgument(args))),
    (_sender, input) => controller.createFirewallRule(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.updateFirewallRule,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseUpdateCloudFirewallRuleInput(requireSingleArgument(args))),
    (_sender, input) => controller.updateFirewallRule(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.deleteFirewallRule,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseDeleteCloudFirewallRuleInput(requireSingleArgument(args))),
    (_sender, input) => controller.deleteFirewallRule(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.prepareDestroyDeployment,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parsePrepareDestroyInput(requireSingleArgument(args))),
    (_sender, input) => controller.prepareDestroyDeployment(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.executeDestroyDeployment,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseExecuteDestroyInput(requireSingleArgument(args))),
    (_sender, input) => controller.executeDestroyDeployment(input),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.openSshWindow,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseSshDeploymentInput(requireSingleArgument(args))),
    (_sender, input) => sshWindows?.open(input.deploymentId) ?? {
      ok: false,
      error: "SSH sessions are unavailable",
    },
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.approveSshHostKey,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseSshHostKeyReviewInput(requireSingleArgument(args))),
    (_sender, input) => sshWindows?.approveHostKey(input.token) ?? {
      ok: false,
      error: "SSH sessions are unavailable",
    },
  );
}

export function unregisterCloudDeploymentIpcHandlers(): void {
  for (const { controller } of pendingCloudLogins.values()) controller.abort();
  for (const discard of stagedAzureLogins.values()) discard();
  for (const channel of Object.values(CLOUD_DEPLOYMENT_IPC_INVOKE)) ipcMain.removeHandler(channel);
}

// Only the initiating renderer may cancel its flow. Closing or replacing that
// document also revokes authorization before the service can save a session.
const pendingCloudLogins = new Map<WebContents, {
  provider: "aws" | "azure";
  controller: AbortController;
  authorizationUrl: string | null;
}>();
const stagedAzureLogins = new Map<WebContents, () => void>();

async function withCloudLogin<T>(
  sender: WebContents,
  provider: "aws" | "azure",
  operation: (signal: AbortSignal, onPendingAuthorization: (url: string | null) => void, onProgress: (phase: AwsLoginProgress["phase"]) => void) => MaybePromise<OperationResult<T>>,
): Promise<OperationResult<T>> {
  if (pendingCloudLogins.has(sender) || pendingCloudLogins.size >= 4) {
    return { ok: false, error: "A cloud login is already in progress. Complete or cancel it first." };
  }
  const controller = new AbortController();
  const pending = { provider, controller, authorizationUrl: null as string | null };
  const ownerFrame = sender.mainFrame;
  const publishProgress = (progress: AwsLoginProgress | null): void => {
    if (provider !== "aws" || pendingCloudLogins.get(sender) !== pending || sender.isDestroyed() || sender.mainFrame !== ownerFrame) return;
    try { sender.send(CLOUD_DEPLOYMENT_IPC_EVENTS.awsLoginProgress, progress); } catch { /* The owner may close during notification. */ }
  };
  const onProgress = (phase: AwsLoginProgress["phase"]): void => {
    if (controller.signal.aborted) return;
    if (phase !== "opening-browser" && phase !== "waiting-for-authorization" && phase !== "exchanging-authorization") return;
    publishProgress(Object.freeze({ phase }));
  };
  let authorizationFinished = false;
  const clearAuthorization = (): void => {
    pending.authorizationUrl = null;
    authorizationFinished = true;
  };
  const onPendingAuthorization = (url: string | null): void => {
    if (provider !== "aws" || pendingCloudLogins.get(sender) !== pending || controller.signal.aborted || sender.isDestroyed()) return;
    if (url === null) clearAuthorization();
    else if (!authorizationFinished) pending.authorizationUrl = url;
  };
  const abort = (): void => controller.abort();
  const navigation = (event: { readonly isMainFrame: boolean }): void => {
    if (event.isMainFrame) abort();
  };
  pendingCloudLogins.set(sender, pending);
  controller.signal.addEventListener("abort", clearAuthorization, { once: true });
  sender.once("destroyed", abort);
  sender.once("render-process-gone", abort);
  sender.on("did-start-navigation", navigation);
  try {
    return await operation(controller.signal, onPendingAuthorization, onProgress);
  } finally {
    publishProgress(null);
    clearAuthorization();
    controller.signal.removeEventListener("abort", clearAuthorization);
    sender.removeListener("destroyed", abort);
    sender.removeListener("render-process-gone", abort);
    sender.removeListener("did-start-navigation", navigation);
    if (pendingCloudLogins.get(sender) === pending) pendingCloudLogins.delete(sender);
  }
}

/** Retains revocation until the signed-in subscription is saved or discarded. */
function trackAzureLoginSelection(sender: WebContents, discardSession: () => void): () => void {
  const navigation = (event: { readonly isMainFrame: boolean }): void => {
    if (event.isMainFrame) discard();
  };
  const discard = (): void => {
    if (stagedAzureLogins.get(sender) !== discard) return;
    stagedAzureLogins.delete(sender);
    clearTimeout(timer);
    sender.removeListener("destroyed", discard);
    sender.removeListener("render-process-gone", discard);
    sender.removeListener("did-start-navigation", navigation);
    discardSession();
  };
  // Bound these listeners across the browser deadline plus the selection's
  // own ten-minute lifetime; the service enforces the exact token expiry.
  const timer = setTimeout(discard, 20 * 60_000);
  timer.unref();
  stagedAzureLogins.set(sender, discard);
  sender.once("destroyed", discard);
  sender.once("render-process-gone", discard);
  sender.on("did-start-navigation", navigation);
  return discard;
}

interface CloudSender {
  readonly identity: TrustedWindowIdentity;
  readonly sender: WebContents;
  readonly window: BrowserWindow;
}

class CloudSenderRevokedError extends Error {}

function requireCurrentCloudSender(
  { identity, sender, window }: CloudSender,
  exactRendererUrl: string,
  authorizeWindow: CloudWindowAuthorizer,
): void {
  if (sender.isDestroyed()) throw new CloudSenderRevokedError("Untrusted cloud renderer");
  const frame = sender.mainFrame;
  if (
    frame.isDestroyed() ||
    frame.processId !== identity.rendererProcessId ||
    frame.frameToken !== identity.rendererFrameToken ||
    !isSameRendererDocument(sender.getURL(), exactRendererUrl) ||
    !isSameRendererDocument(frame.url, exactRendererUrl) ||
    !authorizeWindow(identity, window)
  ) throw new CloudSenderRevokedError("Untrusted cloud renderer");
}

function handleCloud<Args extends readonly unknown[], Result>(
  channel: string,
  exactRendererUrl: string,
  authorizeWindow: CloudWindowAuthorizer,
  parseArguments: (args: readonly unknown[]) => Args,
  handler: (sender: CloudSender, ...args: Args) => MaybePromise<Result>,
  cleanup?: (args: readonly unknown[]) => void,
): void {
  ipcMain.handle(channel, async (event, ...rawArguments: unknown[]) => {
    try {
      const sender = requireCloudSender(event, exactRendererUrl, authorizeWindow);
      const args = parseArguments(rawArguments);
      return await handler(sender, ...args);
    } catch {
      return { ok: false, error: "The Cloud Deployment request was rejected" };
    } finally {
      cleanup?.(rawArguments);
    }
  });
}

function requireCloudSender(
  event: IpcMainInvokeEvent,
  exactRendererUrl: string,
  authorizeWindow: CloudWindowAuthorizer,
): CloudSender {
  const { sender, senderFrame } = event;
  const window = BrowserWindow.fromWebContents(sender);
  if (!window || sender.isDestroyed() || !senderFrame || senderFrame.isDestroyed()) {
    throw new Error("Untrusted cloud renderer");
  }
  const mainFrame = sender.mainFrame;
  const identity: TrustedWindowIdentity = {
    contentsId: sender.id,
    rendererProcessId: senderFrame.processId,
    rendererFrameToken: senderFrame.frameToken,
  };
  if (
    senderFrame.processId !== mainFrame.processId ||
    senderFrame.frameToken !== mainFrame.frameToken ||
    !isSameRendererDocument(sender.getURL(), exactRendererUrl) ||
    !isSameRendererDocument(senderFrame.url, exactRendererUrl) ||
    !authorizeWindow(identity, window)
  ) throw new Error("Untrusted cloud renderer");
  return { identity, sender, window };
}

function parseNoArguments(args: readonly unknown[]): [] {
  if (args.length !== 0) throw new TypeError("Unexpected Cloud Deployment arguments");
  return [];
}

function requireSingleArgument(args: readonly unknown[]): unknown {
  if (args.length !== 1) throw new TypeError("A single Cloud Deployment argument is required");
  return args[0];
}

function singleArgument<T>(value: T): [T] {
  return [value];
}

function parseCredentialIdInput(value: unknown): CloudCredentialIdInput {
  if (!hasExactKeys(value, ["credentialId"]) || !isUuidV4(value["credentialId"])) {
    throw new TypeError("Invalid cloud credential ID");
  }
  return Object.freeze({ credentialId: value["credentialId"] });
}

function parseOpenAwsConsoleInput(value: unknown): OpenAwsConsoleInput {
  if (!hasExactKeys(value, ["region"]) || !isAwsRegion(value["region"])) {
    throw new TypeError("Invalid AWS Console request");
  }
  return Object.freeze({ region: value["region"] });
}

function parseCopyInstanceIdInput(value: unknown): CopyCloudInstanceIdInput {
  if (!hasExactKeys(value, ["deploymentId"]) || !isUuidV4(value["deploymentId"])) {
    throw new TypeError("Invalid cloud deployment ID");
  }
  return Object.freeze({ deploymentId: value["deploymentId"] });
}

function parseCopyIpAddressInput(value: unknown): CopyCloudIpAddressInput {
  if (
    !hasExactKeys(value, ["deploymentId", "kind"]) ||
    !isUuidV4(value["deploymentId"]) ||
    (value["kind"] !== "public" && value["kind"] !== "private")
  ) throw new TypeError("Invalid cloud IP address request");
  return Object.freeze({ deploymentId: value["deploymentId"], kind: value["kind"] });
}

function parsePrepareDestroyInput(value: unknown): PrepareDestroyCloudDeploymentInput {
  if (
    !hasExactKeys(value, ["deploymentId", "expectedRevision"]) ||
    !isUuidV4(value["deploymentId"]) ||
    !isRevision(value["expectedRevision"])
  ) throw new TypeError("Invalid cloud deployment deletion preparation");
  return Object.freeze({
    deploymentId: value["deploymentId"],
    expectedRevision: value["expectedRevision"],
  });
}

function parseExecuteDestroyInput(value: unknown): ExecuteDestroyCloudDeploymentInput {
  if (!hasExactKeys(value, ["token"]) || !isUuidV4(value["token"])) {
    throw new TypeError("Invalid cloud deployment deletion plan");
  }
  return Object.freeze({ token: value["token"] });
}

function safeSavedFileName(path: string, fallback: string): string {
  const fileName = basename(path).normalize("NFC");
  return fileName.length >= 1 && fileName.length <= 255 &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(fileName)
    ? fileName
    : fallback;
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

function postMutationSaveFailure(
  fileName: string,
  mutationState: "unknown" | "created",
  error: string,
  remoteRecoveryPath?: string,
  remoteRecoveryCandidatePath?: string,
  remoteHandoffCandidatePath?: string,
): Extract<SaveCloudOperatorConfigResult, { readonly saved: false; readonly mutationState: "unknown" | "created" }> {
  const guidance = mutationState === "unknown"
    ? remoteRecoveryCandidatePath
      ? `Do not retry until you reconcile the operator list on the managed server. Inspect ${remoteRecoveryCandidatePath} over SSH; it is only a candidate path and the file may not exist.`
      : "Do not retry until you reconcile the operator list on the managed server."
    : remoteRecoveryPath
      ? `Do not retry creation. Recover the root-only configuration over SSH from ${remoteRecoveryPath}.`
      : "Do not retry creation until you reconcile the operator on the managed server.";
  const handoffGuidance = remoteHandoffCandidatePath
    ? ` A private temporary handoff may remain at ${remoteHandoffCandidatePath}; remove it over SSH if it still exists.`
    : "";
  return Object.freeze({
    saved: false,
    fileName,
    mutationState,
    error: `${error} ${guidance}${handoffGuidance}`,
    ...(remoteRecoveryPath === undefined ? {} : { remoteRecoveryPath }),
    ...(remoteRecoveryCandidatePath === undefined ? {} : { remoteRecoveryCandidatePath }),
    ...(remoteHandoffCandidatePath === undefined ? {} : { remoteHandoffCandidatePath }),
  });
}

function hasExactKeys<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
): value is Record<Key, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function scrubCredentialArguments(args: readonly unknown[]): void {
  const value = args[0];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const key of ["accessKeyId", "secretAccessKey", "sessionToken", "tokenId", "tokenSecret", "tlsCaCertificate", "sshPassphrase", "loginToken"]) {
    if (Object.hasOwn(record, key)) {
      try {
        record[key] = "";
      } catch {
        // Structured-clone inputs are normally mutable, but cleanup is best effort.
      }
    }
  }
}
