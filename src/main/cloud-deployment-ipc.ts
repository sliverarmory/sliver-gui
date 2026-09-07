import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";

import {
  CLOUD_DEPLOYMENT_IPC_INVOKE,
  type CloudCredentialIdInput,
  type CloudCredentialTestResult,
  type CloudDeploymentSnapshot,
  type CloudProvisioningTranscriptSnapshot,
  type CurrentEgressIpv4,
  type DestroyCloudDeploymentPlan,
  type ExecuteDestroyCloudDeploymentInput,
  type PrepareDestroyCloudDeploymentInput,
  type SshPrivateKeySelection,
} from "../shared/cloud-deployment-ipc.js";
import {
  isUuidV4,
  parseCloudDeploymentActionInput,
  parseCreateCloudCredentialInput,
  parseCreateCloudDeploymentInput,
  parseUpdateCloudFirewallInput,
  type CloudCredentialSummary,
  type CloudDeploymentActionInput,
  type CloudDeploymentRecord,
  type CloudDeploymentState,
  type CreateCloudCredentialInput,
  type CreateCloudDeploymentInput,
  type UpdateCloudFirewallInput,
} from "../shared/cloud-deployment-contracts.js";
import type { OperationResult } from "../shared/contracts.js";
import type { TerminalRuntimeAsset } from "../shared/stream-contracts.js";
import {
  parseDiscoverAwsOptionsInput,
  type AwsDeploymentOptions,
  type DiscoverAwsOptionsInput,
} from "../shared/cloud-provider-inventory.js";
import { isSameRendererDocument } from "./security.js";
import type { TrustedWindowIdentity } from "./ipc.js";

type MaybePromise<T> = T | Promise<T>;

export interface CloudDeploymentController {
  getSnapshot(): MaybePromise<OperationResult<CloudDeploymentSnapshot>>;
  getProvisioningTranscripts(): MaybePromise<OperationResult<CloudProvisioningTranscriptSnapshot>>;
  getTerminalRuntime(): MaybePromise<OperationResult<TerminalRuntimeAsset>>;
  detectCurrentEgressIpv4(): MaybePromise<OperationResult<CurrentEgressIpv4>>;
  chooseSshPrivateKey(owner: BrowserWindow): MaybePromise<OperationResult<SshPrivateKeySelection>>;
  createCredential(input: CreateCloudCredentialInput): MaybePromise<OperationResult<CloudCredentialSummary>>;
  deleteCredential(input: CloudCredentialIdInput): MaybePromise<OperationResult>;
  testCredential(input: CloudCredentialIdInput): MaybePromise<OperationResult<CloudCredentialTestResult>>;
  discoverAwsOptions(input: DiscoverAwsOptionsInput): MaybePromise<OperationResult<AwsDeploymentOptions>>;
  createDeployment(input: CreateCloudDeploymentInput): MaybePromise<OperationResult<CloudDeploymentRecord>>;
  runLifecycleAction(input: CloudDeploymentActionInput): MaybePromise<OperationResult<CloudDeploymentRecord>>;
  updateFirewall(input: UpdateCloudFirewallInput): MaybePromise<OperationResult<CloudDeploymentRecord>>;
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

export function registerCloudDeploymentIpcHandlers(
  controller: CloudDeploymentController,
  exactRendererUrl: string,
  authorizeWindow: CloudWindowAuthorizer,
): void {
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.getSnapshot,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    () => controller.getSnapshot(),
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
    (_sender, input) => controller.createCredential(input),
    scrubCredentialArguments,
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
    CLOUD_DEPLOYMENT_IPC_INVOKE.createDeployment,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseCreateCloudDeploymentInput(requireSingleArgument(args))),
    (_sender, input) => controller.createDeployment(input),
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
}

export function unregisterCloudDeploymentIpcHandlers(): void {
  for (const channel of Object.values(CLOUD_DEPLOYMENT_IPC_INVOKE)) ipcMain.removeHandler(channel);
}

interface CloudSender {
  readonly identity: TrustedWindowIdentity;
  readonly sender: WebContents;
  readonly window: BrowserWindow;
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
  for (const key of ["accessKeyId", "secretAccessKey", "sessionToken", "tokenId", "tokenSecret", "tlsCaCertificate", "sshPassphrase"]) {
    if (Object.hasOwn(record, key)) {
      try {
        record[key] = "";
      } catch {
        // Structured-clone inputs are normally mutable, but cleanup is best effort.
      }
    }
  }
}
