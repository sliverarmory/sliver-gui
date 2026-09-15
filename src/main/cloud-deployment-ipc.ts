import {
  BrowserWindow,
  clipboard,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";

import {
  CLOUD_DEPLOYMENT_IPC_INVOKE,
  type CloudCredentialIdInput,
  type CloudCredentialTestResult,
  type CloudDeploymentSnapshot,
  type CloudDeploymentRefreshResult,
  type CloudProvisioningTranscriptSnapshot,
  type CurrentEgressIpv4,
  type DestroyCloudDeploymentPlan,
  type ExecuteDestroyCloudDeploymentInput,
  type PrepareDestroyCloudDeploymentInput,
  type SshPrivateKeySelection,
} from "../shared/cloud-deployment-ipc.js";
import {
  isUuidV4,
  parseCreateCloudFirewallRuleInput,
  parseCloudDeploymentActionInput,
  parseCreateCloudCredentialInput,
  parseBeginAzureLoginInput,
  parseCreateCloudDeploymentInput,
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
import type { OperationResult } from "../shared/contracts.js";
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
import type { TrustedWindowIdentity } from "./ipc.js";

type MaybePromise<T> = T | Promise<T>;

export interface CloudDeploymentController {
  getSnapshot(): MaybePromise<OperationResult<CloudDeploymentSnapshot>>;
  refreshDeployments(): MaybePromise<OperationResult<CloudDeploymentRefreshResult>>;
  getProvisioningTranscripts(): MaybePromise<OperationResult<CloudProvisioningTranscriptSnapshot>>;
  getTerminalRuntime(): MaybePromise<OperationResult<TerminalRuntimeAsset>>;
  detectCurrentEgressIpv4(): MaybePromise<OperationResult<CurrentEgressIpv4>>;
  chooseSshPrivateKey(owner: BrowserWindow): MaybePromise<OperationResult<SshPrivateKeySelection>>;
  createCredential(input: CreateCloudCredentialInput, signal?: AbortSignal, ownerId?: number, onPendingAuthorization?: (url: string | null) => void): MaybePromise<OperationResult<CloudCredentialSummary>>;
  loginAwsCredential(input: CloudCredentialIdInput, signal?: AbortSignal, onPendingAuthorization?: (url: string | null) => void): MaybePromise<OperationResult<CloudCredentialSummary>>;
  beginAzureLogin(input: BeginAzureLoginInput, signal?: AbortSignal, ownerId?: number): MaybePromise<OperationResult<AzureLoginSelection>>;
  loginAzureCredential(input: CloudCredentialIdInput, signal?: AbortSignal): MaybePromise<OperationResult<CloudCredentialSummary>>;
  cancelAzureLogin(ownerId?: number): void;
  deleteCredential(input: CloudCredentialIdInput): MaybePromise<OperationResult>;
  testCredential(input: CloudCredentialIdInput): MaybePromise<OperationResult<CloudCredentialTestResult>>;
  discoverAwsOptions(input: DiscoverAwsOptionsInput): MaybePromise<OperationResult<AwsDeploymentOptions>>;
  discoverAzureAccounts(): MaybePromise<OperationResult<readonly AzureCliAccountSummary[]>>;
  discoverAzureOptions(input: DiscoverAzureOptionsInput): MaybePromise<OperationResult<AzureDeploymentOptions>>;
  createDeployment(input: CreateCloudDeploymentInput): MaybePromise<OperationResult<CloudDeploymentRecord>>;
  runLifecycleAction(input: CloudDeploymentActionInput): MaybePromise<OperationResult<CloudDeploymentRecord>>;
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
      return withCloudLogin(sender, input.provider, async (signal, onPendingAuthorization) => {
        if (input.provider === "aws") return controller.createCredential(input, signal, undefined, onPendingAuthorization);
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
    CLOUD_DEPLOYMENT_IPC_INVOKE.loginAwsCredential,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseCredentialIdInput(requireSingleArgument(args))),
    ({ sender }, input) => withCloudLogin(sender, "aws", (signal, onPendingAuthorization) => controller.loginAwsCredential(input, signal, onPendingAuthorization)),
  );
  handleCloud(
    CLOUD_DEPLOYMENT_IPC_INVOKE.copyAwsLoginLink,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    ({ sender }): OperationResult => {
      const pending = pendingCloudLogins.get(sender);
      if (pending?.provider !== "aws" || pending.controller.signal.aborted || !pending.authorizationUrl) {
        return { ok: false, error: "No AWS sign-in link is available. Start AWS Login and try again." };
      }
      clipboard.writeText(pending.authorizationUrl);
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
  operation: (signal: AbortSignal, onPendingAuthorization: (url: string | null) => void) => MaybePromise<OperationResult<T>>,
): Promise<OperationResult<T>> {
  if (pendingCloudLogins.has(sender) || pendingCloudLogins.size >= 4) {
    return { ok: false, error: "A cloud login is already in progress. Complete or cancel it first." };
  }
  const controller = new AbortController();
  const pending = { provider, controller, authorizationUrl: null as string | null };
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
    return await operation(controller.signal, onPendingAuthorization);
  } finally {
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
