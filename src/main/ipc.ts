import { isIP } from "node:net";

import {
  BrowserWindow,
  clipboard,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MessagePortMain,
  type WebContents,
} from "electron";

import {
  IPC,
  IPC_INVOKE,
  type CopyManagedServerPublicIpInput,
  type CopyManagedServerSshCommandInput,
  type ExecuteJobStopPlanInput,
  type GenerateFromProfileInput,
  type GenerateInput,
  type ImportConfigInput,
  type IpcInvokeArgs,
  type IpcInvokeChannel,
  type IpcInvokeResult,
  type ListenerInput,
  type OpenSessionShellWindowInput,
  type OpenRemoteTextEditorInput,
  type OpenWindowInput,
  type OperationResult,
  type RemoveSavedConfigInput,
  type SaveProfileInput,
  type SliverSnapshot,
  type StartListenerRequest,
  type WindowLaunchContext,
} from "../shared/contracts.js";
import {
  initialApplicationUpdateDisabled,
  type ApplicationUpdateState,
} from "../shared/application-update-contracts.js";
import {
  DEFAULT_APPLICATION_SETTINGS_STATE,
  parseApplicationSettingsUpdateInput,
  type ApplicationSettingsState,
  type ApplicationSettingsUpdateInput,
  type ResolvedApplicationIcon,
} from "../shared/application-settings-contracts.js";
import {
  parseCancelBeaconTaskInput,
  parseCancelTargetOperationInput,
  parseGetBeaconTaskInput,
  parseOperationPageRequest,
  parseTargetOperationInput,
} from "../shared/operation-contracts.js";
import {
  SESSION_DROPPED_UPLOAD_IPC_CHANNEL,
  parseSessionDroppedUploadIpcRequest,
  parseExecuteSessionDestructiveActionPlanInput,
  parsePrepareSessionDestructiveActionInput,
  parseSessionWorkbenchInput,
  SESSION_EDITOR_MAX_BYTES,
} from "../shared/session-contracts.js";
import {
  parseExecuteExecutionPlanInput,
  parseExecutionResultRequest,
  parsePrepareExecutionActionInput,
  parseRunExecutionReadInput,
  parseSaveExecutionResultInput,
} from "../shared/execution-contracts.js";
import {
  parseListSessionShellsInput,
  parsePrepareSessionShellInput,
  parseSessionShellResourceActionInput,
  parseStreamAttachRequest,
  isOpaqueStreamId,
} from "../shared/stream-contracts.js";
import {
  DESTRUCTIVE_TARGET_ACTION_IDS,
  MAX_TARGET_CATALOG_CURSOR_LENGTH,
  MAX_TARGET_CATALOG_PAGE_SIZE,
  MAX_TARGET_CATALOG_QUERY_LENGTH,
  type ExecuteTargetActionPlanInput,
  type PrepareTargetActionInput,
  type TargetCatalogPageRequest,
  type TargetRef,
} from "../shared/target-contracts.js";
import {
  LOOT_DROPPED_ADD_IPC_CHANNEL,
  parseAddCredentialInput,
  parseAddLootInput,
  parseCopyCredentialSecretInput,
  parseDroppedLootIpcRequest,
  parseListCredentialsInput,
  parseListLootInput,
  parseOperatorDataId,
  parseRenameLootInput,
} from "../shared/operator-data-contracts.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { CloudDeploymentNavigationRequest } from "../shared/cloud-deployment-ipc.js";
import {
  parseConsoleAttachRequest,
  parseConsoleTabId,
  type ConsoleAttachRequest,
  type ConsoleTabCloseResult,
  type ConsoleTabLaunchContext,
  type ConsoleWindowLaunchContext,
} from "../shared/console-contracts.js";
import {
  connectionServerIsLocal,
  localNetworkInterfaceInventory,
} from "./network-interfaces.js";
import { isTrustedRendererUrl } from "./security.js";
import {
  parseCreateScriptInput,
  parseDeleteScriptInput,
  parseExportScriptInput,
  parseReadScriptInput,
  parseRenameScriptInput,
  parseSaveScriptInput,
  type ExportScriptInput,
  type ExportScriptResult,
  type ImportScriptResult,
} from "../shared/script-contracts.js";
import { ScriptStoreError, type ScriptStore } from "./script-store.js";
import { loadScriptRuntime } from "./script-runtime.js";

export interface ScriptLibraryController {
  store: ScriptStore;
  setEditorDirty(source: TrustedWindowIdentity, isDirty: boolean): OperationResult;
  exportScript(source: TrustedWindowIdentity, input: ExportScriptInput, authorize: () => void): Promise<OperationResult<ExportScriptResult>>;
  importScript(source: TrustedWindowIdentity, authorize: () => void): Promise<OperationResult<ImportScriptResult>>;
}

export interface RemoteTextEditorController {
  open(source: WebContents, remotePath: string): Promise<void>;
}

interface TrustedSender {
  sender: WebContents;
  contentsId: number;
  rendererProcessId: number;
  rendererFrameToken: string;
}

export interface TrustedWindowIdentity {
  readonly contentsId: number;
  readonly rendererProcessId: number;
  readonly rendererFrameToken: string;
}

export interface SessionShellWindowController {
  open(
    source: TrustedWindowIdentity,
    input: OpenSessionShellWindowInput,
  ): MaybePromise<OperationResult>;
  claim(destination: TrustedWindowIdentity): MaybePromise<OperationResult<WindowLaunchContext>>;
}

export interface InteractionWindowController {
  open(source: TrustedWindowIdentity): MaybePromise<OperationResult>;
  claim(destination: TrustedWindowIdentity): MaybePromise<OperationResult<WindowLaunchContext>>;
  selectTarget(
    destination: TrustedWindowIdentity,
    target: TargetRef,
  ): MaybePromise<OperationResult<SliverSnapshot>>;
}

export interface CloudDeploymentWindowController {
  open(source: TrustedWindowIdentity, request?: CloudDeploymentNavigationRequest): MaybePromise<OperationResult>;
}

export interface ManagedServerSshCommandController {
  commandForDeployment(deploymentId: string): MaybePromise<OperationResult<string>>;
}

export interface ApplicationUpdateController {
  getState(): ApplicationUpdateState;
  checkForUpdates(): Promise<OperationResult<ApplicationUpdateState>>;
  restartToApply(): OperationResult;
}

export interface ApplicationSettingsController {
  getState(): ApplicationSettingsState;
  getIcon(): ResolvedApplicationIcon;
  update(input: ApplicationSettingsUpdateInput): MaybePromise<OperationResult<ApplicationSettingsState>>;
  setKeyboardShortcutRecording?(source: TrustedWindowIdentity, isRecording: boolean): void;
  chooseReportScreenshotDirectory?(source: TrustedWindowIdentity): MaybePromise<OperationResult<{ directory: string }>>;
  reportScreenshot?(): MaybePromise<OperationResult<{ directory: string; files: string[] }>>;
}

export interface ConsoleWindowController {
  open(source: TrustedWindowIdentity): MaybePromise<OperationResult>;
  claim(destination: TrustedWindowIdentity): MaybePromise<OperationResult<ConsoleWindowLaunchContext>>;
  createTab(destination: TrustedWindowIdentity): MaybePromise<OperationResult<ConsoleTabLaunchContext>>;
  closeTab(
    destination: TrustedWindowIdentity,
    tabId: string,
  ): MaybePromise<OperationResult<ConsoleTabCloseResult>>;
  attach(
    destination: TrustedWindowIdentity,
    request: ConsoleAttachRequest,
    port: MessagePortMain,
  ): MaybePromise<void>;
}

type MaybePromise<T> = T | Promise<T>;
type IpcArgumentParser<Channel extends IpcInvokeChannel> = (
  args: readonly unknown[],
) => IpcInvokeArgs<Channel>;
export type IpcConnectionRegistry = Pick<
  ConnectionRegistry,
  | "chooseAndConnect"
  | "importConfig"
  | "listSavedConfigs"
  | "connectSavedConfig"
  | "removeSavedConfig"
  | "disconnect"
  | "snapshot"
  | "refresh"
  | "chooseCertificatePair"
  | "startListener"
  | "prepareStopJob"
  | "prepareStopAllJobs"
  | "executeStopPlan"
  | "generate"
  | "generateFromProfile"
  | "downloadBuild"
  | "deleteBuild"
  | "setStagedBuilds"
  | "saveProfile"
  | "deleteProfile"
  | "listLoot"
  | "addLoot"
  | "addDroppedLoot"
  | "getLootDetail"
  | "downloadLoot"
  | "renameLoot"
  | "deleteLoot"
  | "listCredentials"
  | "revealCredentialSecret"
  | "addCredential"
  | "deleteCredential"
  | "copyCredentialSecret"
  | "clearCredentialClipboard"
  | "listTargets"
  | "selectTarget"
  | "backgroundTarget"
  | "setBeaconWatch"
  | "submitTargetOperation"
  | "listTargetOperations"
  | "getTargetOperation"
  | "cancelTargetOperation"
  | "prepareTargetAction"
  | "executeTargetActionPlan"
  | "listBeaconTasks"
  | "getBeaconTask"
  | "cancelBeaconTask"
  | "runSessionWorkbench"
  | "runDroppedSessionUpload"
  | "prepareSessionDestructiveAction"
  | "executeSessionDestructiveActionPlan"
  | "prepareSessionShell"
  | "listSessionShells"
  | "actOnSessionShell"
  | "getTerminalRuntime"
  | "listExecutionCatalog"
  | "runExecutionRead"
  | "prepareExecutionAction"
  | "executeExecutionPlan"
  | "discardExecutionPlan"
  | "getExecutionResult"
  | "saveExecutionResult"
  | "attachStream"
>;

const IMPLANT_TYPES = ["session", "beacon"] as const;
const ARTIFACT_FORMATS = ["executable", "shared", "shellcode", "service", "archive"] as const;
const CONNECTION_STRATEGIES = ["", "s", "r", "rd"] as const;
const LISTENER_KINDS = ["mtls", "wireguard", "dns", "http", "https", "stage"] as const;
const STAGE_COMPRESSIONS = ["none", "zlib", "gzip", "deflate"] as const;
const SHELLCODE_TRIPLE_OPTIONS = [1, 2, 3] as const;
const SHELLCODE_HEADER_OPTIONS = [1, 2] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_SHORT_STRING_LENGTH = 256;
const MAX_LONG_STRING_LENGTH = 32 * 1024;
const MAX_STRING_ARRAY_ITEMS = 500;
const APPLICATION_UPDATES_UNAVAILABLE_REASON = "Application updates are unavailable.";
const APPLICATION_UPDATES_UNAVAILABLE = initialApplicationUpdateDisabled(
  "0.0.0",
  APPLICATION_UPDATES_UNAVAILABLE_REASON,
);

let registeredStreamAttachListener:
  | ((event: IpcMainEvent, ...args: unknown[]) => void)
  | undefined;
let registeredConsoleAttachListener:
  | ((event: IpcMainEvent, ...args: unknown[]) => void)
  | undefined;

export function registerIpcHandlers(
  registry: IpcConnectionRegistry,
  createWindow: (inheritFromContentsId?: number) => void,
  rendererUrl: string,
  sessionShellWindows?: SessionShellWindowController,
  exitApplication?: () => void,
  interactionWindows?: InteractionWindowController,
  applicationUpdates?: ApplicationUpdateController,
  consoleWindows?: ConsoleWindowController,
  applicationSettings?: ApplicationSettingsController,
  cloudDeploymentWindows?: CloudDeploymentWindowController,
  managedServerSshCommands?: ManagedServerSshCommandController,
  scripts?: ScriptLibraryController,
  remoteTextEditor?: RemoteTextEditorController,
): void {
  const unavailableScripts = { ok: false as const, error: "The script library is unavailable" };
  handleTrusted(IPC.listScripts, rendererUrl, parseNoArguments, () =>
    scripts ? scriptOperation(() => scripts.store.list()) : unavailableScripts);
  handleTrusted(IPC.readScript, rendererUrl, scriptArguments(parseReadScriptInput), (_sender, input) =>
    scripts ? scriptOperation(() => scripts.store.read(input)) : unavailableScripts);
  handleTrusted(IPC.createScript, rendererUrl, scriptArguments(parseCreateScriptInput), (sender, input) =>
    scripts ? scriptOperation(() => scripts.store.create(input, () => requireCurrentTrustedSender(sender, rendererUrl))) : unavailableScripts);
  handleTrusted(IPC.saveScript, rendererUrl, scriptArguments(parseSaveScriptInput), (sender, input) =>
    scripts ? scriptOperation(() => scripts.store.save(input, () => requireCurrentTrustedSender(sender, rendererUrl))) : unavailableScripts);
  handleTrusted(IPC.renameScript, rendererUrl, scriptArguments(parseRenameScriptInput), (sender, input) =>
    scripts ? scriptOperation(() => scripts.store.rename(input, () => requireCurrentTrustedSender(sender, rendererUrl))) : unavailableScripts);
  handleTrusted(IPC.deleteScript, rendererUrl, scriptArguments(parseDeleteScriptInput), (sender, input) =>
    scripts ? scriptOperation(() => scripts.store.remove(input, () => requireCurrentTrustedSender(sender, rendererUrl))) : unavailableScripts);
  handleTrusted(IPC.exportScript, rendererUrl, scriptArguments(parseExportScriptInput), (sender, input) =>
    scripts?.exportScript(sender, input, () => requireCurrentTrustedSender(sender, rendererUrl)) ?? unavailableScripts);
  handleTrusted(IPC.importScript, rendererUrl, parseNoArguments, (sender) =>
    scripts?.importScript(sender, () => requireCurrentTrustedSender(sender, rendererUrl)) ?? unavailableScripts);
  handleTrusted(IPC.getScriptRuntime, rendererUrl, parseNoArguments, () =>
    scripts ? scriptOperation(loadScriptRuntime) : unavailableScripts);
  handleTrusted(IPC.setScriptEditorDirty, rendererUrl, (args) => {
    requireArgumentCount(args, 1, "script editor state");
    if (typeof args[0] !== "boolean") throw new TypeError("Invalid script editor state");
    return [args[0]];
  }, (sender, isDirty) => scripts?.setEditorDirty(sender, isDirty) ?? unavailableScripts);
  handleTrusted(IPC.chooseConfig, rendererUrl, parseNoArguments, ({ sender }) => registry.chooseAndConnect(sender));
  handleTrusted(IPC.importConfig, rendererUrl, parseImportConfigArguments, ({ sender }, input) =>
    registry.importConfig(sender, input.displayName),
  );
  handleTrusted(IPC.listSavedConfigs, rendererUrl, parseNoArguments, ({ contentsId }) =>
    registry.listSavedConfigs(contentsId),
  );
  handleTrusted(IPC.connectSavedConfig, rendererUrl, parseSavedConfigIdArguments, ({ contentsId }, id) =>
    registry.connectSavedConfig(contentsId, id),
  );
  handleTrusted(IPC.removeSavedConfig, rendererUrl, parseRemoveSavedConfigArguments, ({ contentsId }, input) =>
    registry.removeSavedConfig(contentsId, input.id),
  );
  handleTrusted(IPC.disconnect, rendererUrl, parseNoArguments, ({ contentsId }) => registry.disconnect(contentsId));
  handleTrusted(IPC.getSnapshot, rendererUrl, parseNoArguments, ({ contentsId }) => registry.snapshot(contentsId));
  handleTrusted(IPC.refresh, rendererUrl, parseNoArguments, ({ contentsId }) => registry.refresh(contentsId));
  handleTrusted(IPC.listLocalNetworkInterfaces, rendererUrl, parseNoArguments, ({ contentsId }) => {
    try {
      const inventory = localNetworkInterfaceInventory();
      const connectionServer = registry.snapshot(contentsId).connection.server;
      if (!connectionServerIsLocal(connectionServer, inventory)) {
        return {
          ok: false,
          error: "Local interface selection is available only when the Sliver server is running on this machine",
        };
      }
      return { ok: true, value: inventory };
    } catch {
      return { ok: false, error: "Unable to read this machine's network interfaces" };
    }
  });
  handleTrusted(IPC.openWindow, rendererUrl, parseOpenWindowArguments, ({ contentsId }, input) => {
    createWindow(input.inheritConnection ? contentsId : undefined);
    return { ok: true };
  });
  handleTrusted(
    IPC.openCloudDeploymentWindow,
    rendererUrl,
    parseCloudDeploymentWindowArguments,
    ({ contentsId, rendererProcessId, rendererFrameToken }, request) => {
      if (request && request.deploymentId !== registry.snapshot(contentsId).connection.managedServer?.deploymentId) {
        return { ok: false, error: "The requested deployment is not associated with this window's current connection" };
      }
      if (!cloudDeploymentWindows) return { ok: false, error: "Cloud Deployment is unavailable" };
      const source = { contentsId, rendererProcessId, rendererFrameToken };
      return request ? cloudDeploymentWindows.open(source, request) : cloudDeploymentWindows.open(source);
    },
  );
  handleTrusted(
    IPC.copyManagedServerSshCommand,
    rendererUrl,
    parseCopyManagedServerSshCommandArguments,
    async (trusted, input) => {
      try {
        const associatedDeploymentId = (): string | undefined => (
          registry.snapshot(trusted.contentsId).connection.managedServer?.deploymentId
        );
        if (associatedDeploymentId() !== input.deploymentId) {
          return {
            ok: false,
            error: "The requested deployment is not associated with this window's current connection",
          };
        }
        if (!managedServerSshCommands) {
          return { ok: false, error: "Managed SSH commands are unavailable" };
        }
        const result = await managedServerSshCommands.commandForDeployment(input.deploymentId);
        requireCurrentTrustedSender(trusted, rendererUrl);
        if (associatedDeploymentId() !== input.deploymentId) {
          return {
            ok: false,
            error: "The requested deployment is not associated with this window's current connection",
          };
        }
        if (!result.ok) return result;
        clipboard.writeText(result.value);
        return { ok: true as const };
      } catch {
        return { ok: false as const, error: "The managed server's SSH command could not be copied" };
      }
    },
  );
  handleTrusted(
    IPC.copyManagedServerPublicIp,
    rendererUrl,
    parseCopyManagedServerPublicIpArguments,
    ({ contentsId }, input) => {
      try {
        const managed = registry.snapshot(contentsId).connection.managedServer;
        if (!managed || managed.deploymentId !== input.deploymentId) {
          return { ok: false, error: "The requested deployment is not associated with this window's current connection" };
        }
        const address = managed.overview?.publicIpAddress;
        if (typeof address !== "string" || isIP(address) === 0) {
          return { ok: false, error: "The managed server does not have an available public IP address" };
        }
        clipboard.writeText(address);
        return { ok: true };
      } catch {
        return { ok: false, error: "The managed server's public IP address could not be copied" };
      }
    },
  );
  handleTrusted(
    IPC.openInteractionWindow,
    rendererUrl,
    parseNoArguments,
    ({ contentsId, rendererProcessId, rendererFrameToken }) => interactionWindows?.open({
      contentsId,
      rendererProcessId,
      rendererFrameToken,
    }) ?? { ok: false, error: "Dedicated interaction windows are unavailable" },
  );
  handleTrusted(
    IPC.claimInteractionWindow,
    rendererUrl,
    parseNoArguments,
    ({ contentsId, rendererProcessId, rendererFrameToken }) => interactionWindows?.claim({
      contentsId,
      rendererProcessId,
      rendererFrameToken,
    }) ?? { ok: false, error: "This window is not authorized to host an interaction workspace" },
  );
  handleTrusted(IPC.exitApp, rendererUrl, parseNoArguments, () => {
    if (!exitApplication) return { ok: false, error: "Application exit is unavailable" };
    exitApplication();
    return { ok: true };
  });
  handleTrusted(IPC.getApplicationSettings, rendererUrl, parseNoArguments, () =>
    applicationSettings?.getState() ?? DEFAULT_APPLICATION_SETTINGS_STATE,
  );
  handleTrusted(
    IPC.chooseReportScreenshotDirectory,
    rendererUrl,
    parseNoArguments,
    ({ contentsId, rendererProcessId, rendererFrameToken }) =>
      applicationSettings?.chooseReportScreenshotDirectory?.({ contentsId, rendererProcessId, rendererFrameToken }) ??
      { ok: false, error: "Screenshot location selection is unavailable" },
  );
  handleTrusted(IPC.reportScreenshot, rendererUrl, parseNoArguments, () =>
    applicationSettings?.reportScreenshot?.() ?? { ok: false, error: "Screenshot capture is unavailable" },
  );
  handleTrusted(IPC.getApplicationIcon, rendererUrl, parseNoArguments, () =>
    applicationSettings?.getIcon() ?? "dark",
  );
  handleTrusted(
    IPC.updateApplicationSettings,
    rendererUrl,
    parseApplicationSettingsUpdateArguments,
    (_sender, input) => applicationSettings?.update(input) ?? {
      ok: false,
      error: "Application settings are unavailable",
    },
  );
  handleTrusted(
    IPC.setKeyboardShortcutRecording,
    rendererUrl,
    (args) => {
      const value = requireSingleArgument(args, "keyboard shortcut recording");
      if (typeof value !== "boolean") throw invalidArguments("keyboard shortcut recording");
      return [value];
    },
    ({ contentsId, rendererProcessId, rendererFrameToken }, isRecording) => {
      applicationSettings?.setKeyboardShortcutRecording?.({ contentsId, rendererProcessId, rendererFrameToken }, isRecording);
    },
  );
  handleTrusted(IPC.getApplicationUpdateState, rendererUrl, parseNoArguments, () =>
    applicationUpdates?.getState() ?? APPLICATION_UPDATES_UNAVAILABLE,
  );
  handleTrusted(IPC.checkForApplicationUpdates, rendererUrl, parseNoArguments, () =>
    applicationUpdates?.checkForUpdates() ?? {
      ok: false,
      error: APPLICATION_UPDATES_UNAVAILABLE_REASON,
    },
  );
  handleTrusted(IPC.restartToApplyApplicationUpdate, rendererUrl, parseNoArguments, () =>
    applicationUpdates?.restartToApply() ?? {
      ok: false,
      error: APPLICATION_UPDATES_UNAVAILABLE_REASON,
    },
  );
  handleTrusted(
    IPC.openSessionShellWindow,
    rendererUrl,
    parseOpenSessionShellWindowArguments,
    ({ contentsId, rendererProcessId, rendererFrameToken }, input) => sessionShellWindows?.open(
      { contentsId, rendererProcessId, rendererFrameToken },
      input,
    ) ?? { ok: false, error: "Dedicated managed-shell windows are unavailable" },
  );
  handleTrusted(
    IPC.claimSessionShellWindow,
    rendererUrl,
    parseNoArguments,
    ({ contentsId, rendererProcessId, rendererFrameToken }) => sessionShellWindows?.claim({
      contentsId,
      rendererProcessId,
      rendererFrameToken,
    }) ?? { ok: false, error: "This window is not authorized to host managed shells" },
  );
  handleTrusted(
    IPC.openConsoleWindow,
    rendererUrl,
    parseNoArguments,
    ({ contentsId, rendererProcessId, rendererFrameToken }) => consoleWindows?.open({
      contentsId,
      rendererProcessId,
      rendererFrameToken,
    }) ?? { ok: false, error: "Dedicated Sliver consoles are unavailable" },
  );
  handleTrusted(
    IPC.claimConsoleWindow,
    rendererUrl,
    parseNoArguments,
    ({ contentsId, rendererProcessId, rendererFrameToken }) => consoleWindows?.claim({
      contentsId,
      rendererProcessId,
      rendererFrameToken,
    }) ?? { ok: false, error: "This window is not authorized to host a Sliver console" },
  );
  handleTrusted(
    IPC.createConsoleTab,
    rendererUrl,
    parseNoArguments,
    ({ contentsId, rendererProcessId, rendererFrameToken }) => consoleWindows?.createTab({
      contentsId,
      rendererProcessId,
      rendererFrameToken,
    }) ?? { ok: false, error: "This window is not authorized to create a Sliver console tab" },
  );
  handleTrusted(
    IPC.closeConsoleTab,
    rendererUrl,
    parseConsoleTabIdArguments,
    ({ contentsId, rendererProcessId, rendererFrameToken }, tabId) => consoleWindows?.closeTab(
      { contentsId, rendererProcessId, rendererFrameToken },
      tabId,
    ) ?? { ok: false, error: "This window is not authorized to close a Sliver console tab" },
  );
  handleTrusted(IPC.chooseCertificatePair, rendererUrl, parseNoArguments, ({ sender }) =>
    registry.chooseCertificatePair(sender),
  );
  handleTrusted(IPC.startListener, rendererUrl, parseStartListenerArguments, ({ contentsId }, input) =>
    registry.startListener(contentsId, input),
  );
  handleTrusted(IPC.prepareStopJob, rendererUrl, parseJobIdArguments, ({ contentsId }, jobId) =>
    registry.prepareStopJob(contentsId, jobId),
  );
  handleTrusted(IPC.prepareStopAllJobs, rendererUrl, parseNoArguments, ({ contentsId }) =>
    registry.prepareStopAllJobs(contentsId),
  );
  handleTrusted(IPC.executeStopPlan, rendererUrl, parseExecuteJobStopPlanArguments, ({ contentsId }, input) =>
    registry.executeStopPlan(contentsId, input),
  );
  handleTrusted(IPC.generate, rendererUrl, parseGenerateArguments, ({ sender }, input) =>
    registry.generate(sender, input),
  );
  handleTrusted(IPC.generateFromProfile, rendererUrl, parseGenerateFromProfileArguments, ({ sender }, input) =>
    registry.generateFromProfile(sender, input),
  );
  handleTrusted(
    IPC.downloadBuild,
    rendererUrl,
    (args) => parseStringArguments(args, "build name"),
    ({ sender }, name) => registry.downloadBuild(sender, name),
  );
  handleTrusted(
    IPC.deleteBuild,
    rendererUrl,
    (args) => parseStringArguments(args, "build name"),
    ({ contentsId }, name) => registry.deleteBuild(contentsId, name),
  );
  handleTrusted(IPC.setStagedBuilds, rendererUrl, parseStringArrayArguments, ({ contentsId }, names) =>
    registry.setStagedBuilds(contentsId, names),
  );
  handleTrusted(IPC.saveProfile, rendererUrl, parseSaveProfileArguments, ({ contentsId }, input) =>
    registry.saveProfile(contentsId, input),
  );
  handleTrusted(
    IPC.deleteProfile,
    rendererUrl,
    (args) => parseStringArguments(args, "profile name"),
    ({ contentsId }, name) => registry.deleteProfile(contentsId, name),
  );
  handleTrusted(IPC.listLoot, rendererUrl, parseListLootArguments, ({ contentsId }, input) =>
    registry.listLoot(contentsId, input),
  );
  handleTrusted(IPC.addLoot, rendererUrl, parseAddLootArguments, ({ sender }, input) =>
    registry.addLoot(sender, input),
  );
  ipcMain.handle(LOOT_DROPPED_ADD_IPC_CHANNEL, (event, ...rawArguments: unknown[]) => {
    const { sender } = requireTrustedSender(event, rendererUrl);
    const [request] = parseDroppedLootArguments(rawArguments);
    return registry.addDroppedLoot(sender, request.sourcePath);
  });
  handleTrusted(IPC.getLootDetail, rendererUrl, parseLootIdArguments, ({ contentsId }, id) =>
    registry.getLootDetail(contentsId, id),
  );
  handleTrusted(IPC.downloadLoot, rendererUrl, parseLootIdArguments, ({ sender }, id) =>
    registry.downloadLoot(sender, id),
  );
  handleTrusted(IPC.renameLoot, rendererUrl, parseRenameLootArguments, ({ contentsId }, input) =>
    registry.renameLoot(contentsId, input),
  );
  handleTrusted(IPC.deleteLoot, rendererUrl, parseLootIdArguments, ({ contentsId }, id) =>
    registry.deleteLoot(contentsId, id),
  );
  handleTrusted(IPC.listCredentials, rendererUrl, parseListCredentialsArguments, ({ contentsId }, input) =>
    registry.listCredentials(contentsId, input),
  );
  handleTrusted(
    IPC.revealCredentialSecret,
    rendererUrl,
    parseCredentialSecretArguments,
    ({ contentsId }, input) => registry.revealCredentialSecret(contentsId, input),
  );
  handleTrusted(
    IPC.addCredential,
    rendererUrl,
    parseAddCredentialArguments,
    ({ contentsId }, input) => registry.addCredential(contentsId, input),
    clearRawCredentialArguments,
  );
  handleTrusted(IPC.deleteCredential, rendererUrl, parseCredentialIdArguments, ({ contentsId }, id) =>
    registry.deleteCredential(contentsId, id),
  );
  handleTrusted(
    IPC.copyCredentialSecret,
    rendererUrl,
    parseCredentialSecretArguments,
    ({ contentsId }, input) => registry.copyCredentialSecret(contentsId, input),
  );
  handleTrusted(IPC.clearCredentialClipboard, rendererUrl, parseNoArguments, () =>
    registry.clearCredentialClipboard(),
  );
  handleTrusted(IPC.listTargets, rendererUrl, parseTargetCatalogPageArguments, ({ contentsId }, request) =>
    registry.listTargets(contentsId, request),
  );
  handleTrusted(
    IPC.selectTarget,
    rendererUrl,
    parseTargetRefArguments,
    ({ contentsId, rendererProcessId, rendererFrameToken }, target) => interactionWindows?.selectTarget(
      { contentsId, rendererProcessId, rendererFrameToken },
      target,
    ) ?? registry.selectTarget(contentsId, target),
  );
  handleTrusted(IPC.backgroundTarget, rendererUrl, parseNoArguments, ({ contentsId }) =>
    registry.backgroundTarget(contentsId),
  );
  handleTrusted(IPC.setBeaconWatch, rendererUrl, parseBeaconWatchArguments, ({ contentsId }, input) =>
    registry.setBeaconWatch(contentsId, input.enabled),
  );
  handleTrusted(IPC.submitTargetOperation, rendererUrl, parseTargetOperationArguments, ({ contentsId }, input) =>
    registry.submitTargetOperation(contentsId, input),
  );
  handleTrusted(IPC.listTargetOperations, rendererUrl, parseOperationPageArguments, ({ contentsId }, request) =>
    registry.listTargetOperations(contentsId, request),
  );
  handleTrusted(IPC.getTargetOperation, rendererUrl, parseOperationRequestArguments, ({ contentsId }, input) =>
    registry.getTargetOperation(contentsId, input.requestId),
  );
  handleTrusted(IPC.cancelTargetOperation, rendererUrl, parseOperationRequestArguments, ({ contentsId }, input) =>
    registry.cancelTargetOperation(contentsId, input.requestId),
  );
  handleTrusted(IPC.prepareTargetAction, rendererUrl, parsePrepareTargetActionArguments, ({ contentsId }, input) =>
    registry.prepareTargetAction(contentsId, input),
  );
  handleTrusted(IPC.executeTargetActionPlan, rendererUrl, parseExecuteTargetActionPlanArguments, ({ contentsId }, input) =>
    registry.executeTargetActionPlan(contentsId, input.token),
  );
  handleTrusted(IPC.listBeaconTasks, rendererUrl, parseOperationPageArguments, ({ contentsId }, input) =>
    registry.listBeaconTasks(contentsId, input),
  );
  handleTrusted(IPC.getBeaconTask, rendererUrl, parseBeaconTaskArguments, ({ contentsId }, input) =>
    registry.getBeaconTask(contentsId, input.taskId),
  );
  handleTrusted(IPC.cancelBeaconTask, rendererUrl, parseCancelBeaconTaskArguments, ({ contentsId }, input) =>
    registry.cancelBeaconTask(contentsId, input.taskId),
  );
  handleTrusted(IPC.runSessionWorkbench, rendererUrl, parseSessionWorkbenchArguments, ({ sender }, input) =>
    registry.runSessionWorkbench(sender, input),
  );
  handleTrusted(IPC.openRemoteTextEditor, rendererUrl, parseOpenRemoteTextEditorArguments, async ({ sender }, input) => {
    if (!remoteTextEditor) return { ok: false, error: "The text editor is unavailable" };
    try {
      await remoteTextEditor.open(sender, input.remotePath);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The remote file could not be opened" };
    }
  });
  ipcMain.handle(SESSION_DROPPED_UPLOAD_IPC_CHANNEL, (event, ...rawArguments: unknown[]) => {
    const { sender } = requireTrustedSender(event, rendererUrl);
    const [request] = parseDroppedSessionUploadArguments(rawArguments);
    return registry.runDroppedSessionUpload(sender, request.sourcePath, request.input);
  });
  handleTrusted(
    IPC.prepareSessionDestructiveAction,
    rendererUrl,
    parsePrepareSessionDestructiveActionArguments,
    ({ contentsId }, input) => registry.prepareSessionDestructiveAction(contentsId, input),
  );
  handleTrusted(
    IPC.executeSessionDestructiveActionPlan,
    rendererUrl,
    parseExecuteSessionDestructiveActionPlanArguments,
    ({ contentsId }, input) => registry.executeSessionDestructiveActionPlan(contentsId, input.token),
  );
  handleTrusted(
    IPC.prepareSessionShell,
    rendererUrl,
    parsePrepareSessionShellArguments,
    ({ contentsId, rendererProcessId, rendererFrameToken }, input) =>
      registry.prepareSessionShell(contentsId, rendererProcessId, rendererFrameToken, input),
  );
  handleTrusted(
    IPC.listSessionShells,
    rendererUrl,
    parseListSessionShellsArguments,
    ({ contentsId, rendererProcessId, rendererFrameToken }, input) =>
      registry.listSessionShells(contentsId, rendererProcessId, rendererFrameToken, input),
  );
  handleTrusted(
    IPC.actOnSessionShell,
    rendererUrl,
    parseSessionShellResourceActionArguments,
    ({ contentsId, rendererProcessId, rendererFrameToken }, input) =>
      registry.actOnSessionShell(contentsId, rendererProcessId, rendererFrameToken, input),
  );
  handleTrusted(IPC.getTerminalRuntime, rendererUrl, parseNoArguments, ({ contentsId }) =>
    registry.getTerminalRuntime(contentsId),
  );
  handleTrusted(IPC.listExecutionCatalog, rendererUrl, parseNoArguments, ({ contentsId }) =>
    registry.listExecutionCatalog(contentsId),
  );
  handleTrusted(IPC.runExecutionRead, rendererUrl, parseRunExecutionReadArguments, ({ contentsId }, input) =>
    registry.runExecutionRead(contentsId, input),
  );
  handleTrusted(
    IPC.prepareExecutionAction,
    rendererUrl,
    parsePrepareExecutionActionArguments,
    async ({ sender }, input) => {
      let retainedByRegistry = false;
      try {
        const result = await registry.prepareExecutionAction(sender, input);
        retainedByRegistry = result.ok && result.value !== undefined;
        return result;
      } finally {
        if (!retainedByRegistry) clearExecutionCredentialInput(input);
      }
    },
    clearRawExecutionCredentialArguments,
  );
  handleTrusted(IPC.executeExecutionPlan, rendererUrl, parseExecuteExecutionPlanArguments, ({ contentsId }, input) =>
    registry.executeExecutionPlan(contentsId, input),
  );
  handleTrusted(IPC.discardExecutionPlan, rendererUrl, parseExecuteExecutionPlanArguments, ({ contentsId }, input) =>
    registry.discardExecutionPlan(contentsId, input),
  );
  handleTrusted(IPC.getExecutionResult, rendererUrl, parseExecutionResultRequestArguments, ({ contentsId }, input) =>
    registry.getExecutionResult(contentsId, input),
  );
  handleTrusted(IPC.saveExecutionResult, rendererUrl, parseSaveExecutionResultArguments, ({ sender }, input) =>
    registry.saveExecutionResult(sender, input),
  );

  if (registeredStreamAttachListener) {
    ipcMain.removeListener(IPC.attach, registeredStreamAttachListener);
  }
  registeredStreamAttachListener = createStreamAttachListener(registry, rendererUrl);
  ipcMain.on(IPC.attach, registeredStreamAttachListener);
  if (registeredConsoleAttachListener) {
    ipcMain.removeListener(IPC.attachConsole, registeredConsoleAttachListener);
  }
  registeredConsoleAttachListener = createConsoleAttachListener(consoleWindows, rendererUrl);
  ipcMain.on(IPC.attachConsole, registeredConsoleAttachListener);
}

export function unregisterIpcHandlers(): void {
  for (const channel of Object.values(IPC_INVOKE)) ipcMain.removeHandler(channel);
  ipcMain.removeHandler(LOOT_DROPPED_ADD_IPC_CHANNEL);
  ipcMain.removeHandler(SESSION_DROPPED_UPLOAD_IPC_CHANNEL);
  if (registeredStreamAttachListener) {
    ipcMain.removeListener(IPC.attach, registeredStreamAttachListener);
    registeredStreamAttachListener = undefined;
  }
  if (registeredConsoleAttachListener) {
    ipcMain.removeListener(IPC.attachConsole, registeredConsoleAttachListener);
    registeredConsoleAttachListener = undefined;
  }
}

export function isTrustedSender(sender: WebContents, rendererUrl: string): boolean {
  try {
    if (sender.isDestroyed() || !BrowserWindow.fromWebContents(sender)) return false;
    // These surfaces have independent, narrowly scoped capability bridges.
    if (["armory", "script-task-manager"].includes(new URL(sender.getURL()).searchParams.get("surface") ?? "")) return false;
    return isTrustedRendererUrl(sender.getURL(), rendererUrl);
  } catch {
    return false;
  }
}

function requireTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent, rendererUrl: string): TrustedSender {
  const { sender, senderFrame } = event;
  if (!senderFrame || senderFrame.isDestroyed() || !isTrustedSender(sender, rendererUrl)) {
    throw new Error("Rejected IPC invocation from an untrusted renderer");
  }
  const mainFrame = sender.mainFrame;
  if (
    senderFrame.processId !== mainFrame.processId ||
    senderFrame.frameToken !== mainFrame.frameToken ||
    !isTrustedRendererUrl(senderFrame.url, rendererUrl)
  ) {
    throw new Error("Rejected IPC invocation from an untrusted renderer");
  }
  return {
    sender,
    contentsId: sender.id,
    rendererProcessId: senderFrame.processId,
    rendererFrameToken: senderFrame.frameToken,
  };
}

function requireCurrentTrustedSender(sender: TrustedSender, rendererUrl: string): void {
  if (!isTrustedSender(sender.sender, rendererUrl)) {
    throw new Error("Rejected IPC invocation from an untrusted renderer");
  }
  const mainFrame = sender.sender.mainFrame;
  if (
    mainFrame.isDestroyed() ||
    mainFrame.processId !== sender.rendererProcessId ||
    mainFrame.frameToken !== sender.rendererFrameToken ||
    !isTrustedRendererUrl(mainFrame.url, rendererUrl)
  ) {
    throw new Error("Rejected IPC invocation from an untrusted renderer");
  }
}

function createStreamAttachListener(
  registry: IpcConnectionRegistry,
  rendererUrl: string,
): (event: IpcMainEvent, ...args: unknown[]) => void {
  return (event, ...rawArguments): void => {
    const ports = [...event.ports];
    try {
      if (ports.length !== 1) throw new Error("Rejected stream attachment without exactly one transferred port");
      const sender = requireTrustedSender(event, rendererUrl);
      requireArgumentCount(rawArguments, 1, "stream attach request");
      const request = parseStreamAttachRequest(rawArguments[0]);
      const result: unknown = registry.attachStream(
        sender.contentsId,
        sender.rendererProcessId,
        sender.rendererFrameToken,
        request,
        ports[0] as MessagePortMain,
      );
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => closeTransferredPorts(ports));
      }
    } catch {
      closeTransferredPorts(ports);
    }
  };
}

function createConsoleAttachListener(
  controller: ConsoleWindowController | undefined,
  rendererUrl: string,
): (event: IpcMainEvent, ...args: unknown[]) => void {
  return (event, ...rawArguments): void => {
    const ports = [...event.ports];
    try {
      if (!controller || ports.length !== 1) {
        throw new Error("Rejected console attachment without an available single-port controller");
      }
      const sender = requireTrustedSender(event, rendererUrl);
      requireArgumentCount(rawArguments, 1, "console attach request");
      const request = parseConsoleAttachRequest(rawArguments[0]);
      const result: unknown = controller.attach(
        {
          contentsId: sender.contentsId,
          rendererProcessId: sender.rendererProcessId,
          rendererFrameToken: sender.rendererFrameToken,
        },
        request,
        ports[0] as MessagePortMain,
      );
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => closeTransferredPorts(ports));
      }
    } catch {
      closeTransferredPorts(ports);
    }
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && "then" in value && typeof value.then === "function";
}

function closeTransferredPorts(ports: readonly MessagePortMain[]): void {
  for (const port of ports) {
    try {
      port.close();
    } catch {
      // The boundary must attempt every supplied port even if one host object
      // has already been closed or otherwise rejects the close operation.
    }
  }
}

function handleTrusted<Channel extends IpcInvokeChannel>(
  channel: Channel,
  rendererUrl: string,
  parseArguments: IpcArgumentParser<Channel>,
  handler: (
    sender: TrustedSender,
    ...args: IpcInvokeArgs<Channel>
  ) => MaybePromise<IpcInvokeResult<Channel>>,
  cleanupRawArguments?: (args: readonly unknown[]) => void,
): void {
  ipcMain.handle(channel, (event, ...rawArguments: unknown[]) => {
    try {
      const sender = requireTrustedSender(event, rendererUrl);
      const args = parseArguments(rawArguments);
      return handler(sender, ...args);
    } finally {
      cleanupRawArguments?.(rawArguments);
    }
  });
}

function parseNoArguments(args: readonly unknown[]): [] {
  requireArgumentCount(args, 0, "arguments");
  return [];
}

function parseCloudDeploymentWindowArguments(
  args: readonly unknown[],
): [request?: CloudDeploymentNavigationRequest] {
  if (args.length === 0) return [];
  const description = "arguments for Cloud Deployment navigation";
  const value = requireRecord(requireSingleArgument(args, description), description);
  const deploymentId = value["deploymentId"];
  if (typeof deploymentId !== "string" || !UUID_PATTERN.test(deploymentId)) throw invalidArguments(description);
  if (value["view"] === "firewall" || value["view"] === "software") {
    requireExactKeys(value, ["view", "deploymentId"], description);
    return [Object.freeze({ view: value["view"], deploymentId })];
  }
  if (value["view"] === "deployments") {
    requireExactKeys(value, ["view", "deploymentId", "action"], description);
    const action = requireStringLiteralProperty(
      value,
      "action",
      ["start", "stop", "reboot", "terminate", "ssh", "operator", "rename"] as const,
      description,
    );
    return [Object.freeze({ view: "deployments", deploymentId, action })];
  }
  throw invalidArguments(description);
}

function parseCopyManagedServerPublicIpArguments(
  args: readonly unknown[],
): [input: CopyManagedServerPublicIpInput] {
  const description = "arguments for copying a managed server public IP";
  const value = requireRecord(requireSingleArgument(args, description), description);
  requireExactKeys(value, ["deploymentId"], description);
  const deploymentId = value["deploymentId"];
  if (typeof deploymentId !== "string" || !UUID_PATTERN.test(deploymentId)) throw invalidArguments(description);
  return [Object.freeze({ deploymentId })];
}

function parseCopyManagedServerSshCommandArguments(
  args: readonly unknown[],
): [input: CopyManagedServerSshCommandInput] {
  const description = "arguments for copying a managed server SSH command";
  const value = requireRecord(requireSingleArgument(args, description), description);
  requireExactKeys(value, ["deploymentId"], description);
  const deploymentId = value["deploymentId"];
  if (typeof deploymentId !== "string" || !UUID_PATTERN.test(deploymentId)) {
    throw invalidArguments(description);
  }
  return [Object.freeze({ deploymentId })];
}

function parseApplicationSettingsUpdateArguments(
  args: readonly unknown[],
): [input: ApplicationSettingsUpdateInput] {
  const value = requireSingleArgument(args, "application settings update");
  try {
    return [parseApplicationSettingsUpdateInput(value)];
  } catch {
    throw invalidArguments("application settings update");
  }
}

function parseConsoleTabIdArguments(args: readonly unknown[]): [tabId: string] {
  const value = requireSingleArgument(args, "console tab ID");
  try {
    return [parseConsoleTabId(value)];
  } catch {
    throw invalidArguments("console tab ID");
  }
}

function parseSavedConfigIdArguments(args: readonly unknown[]): [id: string] {
  const value = requireSingleArgument(args, "saved configuration ID");
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw invalidArguments("saved configuration ID");
  }
  return [value];
}

function parseImportConfigArguments(args: readonly unknown[]): [input: ImportConfigInput] {
  const value = requireRecord(requireSingleArgument(args, "import-config input"), "import-config input");
  requireExactKeys(value, ["displayName"], "import-config input");
  return [{ displayName: requireStringProperty(value, "displayName", "import-config input", 200) }];
}

function parseRemoveSavedConfigArguments(args: readonly unknown[]): [input: RemoveSavedConfigInput] {
  const value = requireRecord(requireSingleArgument(args, "remove-config input"), "remove-config input");
  requireExactKeys(value, ["id"], "remove-config input");
  const [id] = parseSavedConfigIdArguments([value["id"]]);
  return [{ id }];
}

function parseOpenWindowArguments(args: readonly unknown[]): [input: OpenWindowInput] {
  const value = requireRecord(requireSingleArgument(args, "open-window input"), "open-window input");
  requireExactKeys(value, ["inheritConnection"], "open-window input");
  return [{ inheritConnection: requireBooleanProperty(value, "inheritConnection", "open-window input") }];
}

function parseOpenSessionShellWindowArguments(
  args: readonly unknown[],
): [input: OpenSessionShellWindowInput] {
  const value = requireRecord(
    requireSingleArgument(args, "open managed-shell window input"),
    "open managed-shell window input",
  );
  if (Object.keys(value).some((key) => key !== "preferredResourceId")) {
    throw invalidArguments("open managed-shell window input");
  }
  const preferredResourceId = value["preferredResourceId"];
  if (preferredResourceId === undefined) return [{}];
  if (typeof preferredResourceId !== "string" || !isOpaqueStreamId(preferredResourceId)) {
    throw invalidArguments("open managed-shell window input");
  }
  return [{ preferredResourceId }];
}

function parseTargetRefArguments(args: readonly unknown[]): [target: TargetRef] {
  const value = requireRecord(requireSingleArgument(args, "target reference"), "target reference");
  requireExactKeys(value, ["mode", "id", "backendEpoch", "domainRevision", "fingerprint"], "target reference");
  const mode = requireStringLiteralProperty(value, "mode", ["session", "beacon"] as const, "target reference");
  const id = requireStringProperty(value, "id", "target reference", 128);
  const backendEpoch = requireFiniteNumberProperty(value, "backendEpoch", "target reference");
  const domainRevision = requireFiniteNumberProperty(value, "domainRevision", "target reference");
  const fingerprint = requireStringProperty(value, "fingerprint", "target reference", 64);
  if (
    !id ||
    !Number.isSafeInteger(backendEpoch) || backendEpoch < 1 ||
    !Number.isSafeInteger(domainRevision) || domainRevision < 0 ||
    !/^[a-f0-9]{64}$/u.test(fingerprint)
  ) {
    throw invalidArguments("target reference");
  }
  return [{ mode, id, backendEpoch, domainRevision, fingerprint }];
}

function parseListLootArguments(args: readonly unknown[]): [input: ReturnType<typeof parseListLootInput>] {
  requireArgumentCount(args, 1, "loot list input");
  try {
    return [parseListLootInput(args[0])];
  } catch {
    throw invalidArguments("loot list input");
  }
}

function parseAddLootArguments(args: readonly unknown[]): [input: ReturnType<typeof parseAddLootInput>] {
  requireArgumentCount(args, 1, "add loot input");
  try {
    return [parseAddLootInput(args[0])];
  } catch {
    throw invalidArguments("add loot input");
  }
}

function parseDroppedLootArguments(args: readonly unknown[]): [request: ReturnType<typeof parseDroppedLootIpcRequest>] {
  requireArgumentCount(args, 1, "dropped loot request");
  try {
    return [parseDroppedLootIpcRequest(args[0])];
  } catch {
    throw invalidArguments("dropped loot request");
  }
}

function parseRenameLootArguments(args: readonly unknown[]): [input: ReturnType<typeof parseRenameLootInput>] {
  requireArgumentCount(args, 1, "rename loot input");
  try {
    return [parseRenameLootInput(args[0])];
  } catch {
    throw invalidArguments("rename loot input");
  }
}

function parseLootIdArguments(args: readonly unknown[]): [id: string] {
  const value = requireSingleArgument(args, "loot ID");
  try {
    return [parseOperatorDataId(value, "loot ID")];
  } catch {
    throw invalidArguments("loot ID");
  }
}

function parseListCredentialsArguments(
  args: readonly unknown[],
): [input: ReturnType<typeof parseListCredentialsInput>] {
  requireArgumentCount(args, 1, "credential list input");
  try {
    return [parseListCredentialsInput(args[0])];
  } catch {
    throw invalidArguments("credential list input");
  }
}

function parseCredentialIdArguments(args: readonly unknown[]): [id: string] {
  const value = requireSingleArgument(args, "credential ID");
  try {
    return [parseOperatorDataId(value, "credential ID")];
  } catch {
    throw invalidArguments("credential ID");
  }
}

function parseCredentialSecretArguments(
  args: readonly unknown[],
): [input: ReturnType<typeof parseCopyCredentialSecretInput>] {
  requireArgumentCount(args, 1, "credential secret input");
  try {
    return [parseCopyCredentialSecretInput(args[0])];
  } catch {
    throw invalidArguments("credential secret input");
  }
}

function parseAddCredentialArguments(
  args: readonly unknown[],
): [input: ReturnType<typeof parseAddCredentialInput>] {
  requireArgumentCount(args, 1, "add credential input");
  try {
    return [parseAddCredentialInput(args[0])];
  } catch {
    throw invalidArguments("add credential input");
  }
}

function parseTargetCatalogPageArguments(args: readonly unknown[]): [request: TargetCatalogPageRequest] {
  const value = requireRecord(requireSingleArgument(args, "target catalog page request"), "target catalog page request");
  const keys = Object.keys(value);
  if (
    !keys.includes("mode") ||
    keys.some((key) => key !== "mode" && key !== "cursor" && key !== "limit" && key !== "query")
  ) {
    throw invalidArguments("target catalog page request");
  }
  const request: TargetCatalogPageRequest = {
    mode: requireStringLiteralProperty(value, "mode", ["session", "beacon"] as const, "target catalog page request"),
  };
  if (value["cursor"] !== undefined) {
    const cursor = requireStringProperty(
      value,
      "cursor",
      "target catalog page request",
      MAX_TARGET_CATALOG_CURSOR_LENGTH,
    );
    if (!/^target:v1:[0-9a-f-]+$/iu.test(cursor)) throw invalidArguments("target catalog page request.cursor");
    request.cursor = cursor;
  }
  if (value["limit"] !== undefined) {
    const limit = requireFiniteNumberProperty(value, "limit", "target catalog page request");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TARGET_CATALOG_PAGE_SIZE) {
      throw invalidArguments("target catalog page request.limit");
    }
    request.limit = limit;
  }
  if (value["query"] !== undefined) {
    request.query = requireStringProperty(
      value,
      "query",
      "target catalog page request",
      MAX_TARGET_CATALOG_QUERY_LENGTH,
    );
  }
  return [request];
}

function parseBeaconWatchArguments(args: readonly unknown[]): [input: { enabled: boolean }] {
  const value = requireRecord(requireSingleArgument(args, "beacon watch input"), "beacon watch input");
  requireExactKeys(value, ["enabled"], "beacon watch input");
  return [{ enabled: requireBooleanProperty(value, "enabled", "beacon watch input") }];
}

function parseTargetOperationArguments(args: readonly unknown[]): [input: ReturnType<typeof parseTargetOperationInput>] {
  requireArgumentCount(args, 1, "target operation input");
  return [parseTargetOperationInput(args[0])];
}

function parseOperationPageArguments(args: readonly unknown[]): [input: ReturnType<typeof parseOperationPageRequest>] {
  requireArgumentCount(args, 1, "operation page request");
  return [parseOperationPageRequest(args[0])];
}

function parseOperationRequestArguments(args: readonly unknown[]): [input: ReturnType<typeof parseCancelTargetOperationInput>] {
  requireArgumentCount(args, 1, "operation request");
  return [parseCancelTargetOperationInput(args[0])];
}

function parsePrepareTargetActionArguments(args: readonly unknown[]): [input: PrepareTargetActionInput] {
  const value = requireRecord(requireSingleArgument(args, "target action input"), "target action input");
  requireExactKeys(value, ["actionId"], "target action input");
  return [{
    actionId: requireStringLiteralProperty(value, "actionId", DESTRUCTIVE_TARGET_ACTION_IDS, "target action input"),
  }];
}

function parseExecuteTargetActionPlanArguments(args: readonly unknown[]): [input: ExecuteTargetActionPlanInput] {
  const value = requireRecord(requireSingleArgument(args, "target action plan"), "target action plan");
  requireExactKeys(value, ["token"], "target action plan");
  const [token] = parseOpaqueTokenArguments([value["token"]]);
  return [{ token }];
}

function parseBeaconTaskArguments(args: readonly unknown[]): [input: ReturnType<typeof parseGetBeaconTaskInput>] {
  requireArgumentCount(args, 1, "beacon task request");
  return [parseGetBeaconTaskInput(args[0])];
}

function parseCancelBeaconTaskArguments(args: readonly unknown[]): [input: ReturnType<typeof parseCancelBeaconTaskInput>] {
  requireArgumentCount(args, 1, "beacon task cancellation");
  return [parseCancelBeaconTaskInput(args[0])];
}

function parseSessionWorkbenchArguments(args: readonly unknown[]): [input: ReturnType<typeof parseSessionWorkbenchInput>] {
  requireArgumentCount(args, 1, "session workbench input");
  return [parseSessionWorkbenchInput(args[0])];
}

function parseOpenRemoteTextEditorArguments(args: readonly unknown[]): [input: OpenRemoteTextEditorInput] {
  const value = requireRecord(requireSingleArgument(args, "remote text editor input"), "remote text editor input");
  requireExactKeys(value, ["remotePath"], "remote text editor input");
  try {
    const checked = parseSessionWorkbenchInput({
      operationId: "session.filesystem.cat",
      path: value["remotePath"],
      maxBytes: SESSION_EDITOR_MAX_BYTES,
    });
    if (checked.operationId !== "session.filesystem.cat") throw invalidArguments("remote text editor input");
    return [{ remotePath: checked.path }];
  } catch {
    throw invalidArguments("remote text editor input");
  }
}

function parseDroppedSessionUploadArguments(
  args: readonly unknown[],
): [request: ReturnType<typeof parseSessionDroppedUploadIpcRequest>] {
  requireArgumentCount(args, 1, "dropped session upload request");
  return [parseSessionDroppedUploadIpcRequest(args[0])];
}

function parsePrepareSessionDestructiveActionArguments(
  args: readonly unknown[],
): [input: ReturnType<typeof parsePrepareSessionDestructiveActionInput>] {
  requireArgumentCount(args, 1, "session destructive action input");
  return [parsePrepareSessionDestructiveActionInput(args[0])];
}

function parseExecuteSessionDestructiveActionPlanArguments(
  args: readonly unknown[],
): [input: ReturnType<typeof parseExecuteSessionDestructiveActionPlanInput>] {
  requireArgumentCount(args, 1, "session destructive action execution");
  return [parseExecuteSessionDestructiveActionPlanInput(args[0])];
}

function parsePrepareSessionShellArguments(
  args: readonly unknown[],
): [input: ReturnType<typeof parsePrepareSessionShellInput>] {
  requireArgumentCount(args, 1, "session shell input");
  return [parsePrepareSessionShellInput(args[0])];
}

function parseListSessionShellsArguments(
  args: readonly unknown[],
): [input: ReturnType<typeof parseListSessionShellsInput>] {
  requireArgumentCount(args, 1, "session shell list input");
  return [parseListSessionShellsInput(args[0])];
}

function parseSessionShellResourceActionArguments(
  args: readonly unknown[],
): [input: ReturnType<typeof parseSessionShellResourceActionInput>] {
  requireArgumentCount(args, 1, "session shell resource action");
  return [parseSessionShellResourceActionInput(args[0])];
}

function parseRunExecutionReadArguments(
  args: readonly unknown[],
): [input: ReturnType<typeof parseRunExecutionReadInput>] {
  requireArgumentCount(args, 1, "execution read input");
  return [parseRunExecutionReadInput(args[0])];
}

function parsePrepareExecutionActionArguments(
  args: readonly unknown[],
): [input: ReturnType<typeof parsePrepareExecutionActionInput>] {
  requireArgumentCount(args, 1, "prepare execution action input");
  return [parsePrepareExecutionActionInput(args[0])];
}

function clearRawExecutionCredentialArguments(args: readonly unknown[]): void {
  // Electron has already made these structured-clone copies. The shared parser
  // returns a distinct main-owned credential buffer, so erase every raw view
  // immediately on success, parse rejection, and untrusted-sender rejection.
  for (const argument of args) clearExecutionCredentialInput(argument);
}

function clearRawCredentialArguments(args: readonly unknown[]): void {
  // These are Electron structured-clone copies. The parser gives the registry
  // distinct main-owned buffers, so raw views can be erased immediately even
  // when another field is malformed and parsing rejects the request.
  for (const argument of args) {
    try {
      if (!isPlainRecord(argument)) continue;
      zeroByteView(argument["plaintext"]);
      zeroByteView(argument["hash"]);
    } catch {
      // Cleanup is best effort and must not replace the boundary error.
    }
  }
}

function clearExecutionCredentialInput(value: unknown): void {
  try {
    if (!isPlainRecord(value)) return;
    const draft = value["draft"];
    if (!isPlainRecord(draft)) return;
    // Scrub credential-shaped fields even when operationId or another field is
    // malformed. Parse rejection must not leave the raw structured-clone view
    // alive merely because the discriminator could not be trusted.
    zeroByteView(draft["password"]);
    const authentication = draft["authentication"];
    if (isPlainRecord(authentication)) zeroByteView(authentication["password"]);
  } catch {
    // Cleanup is best effort and must not replace the boundary's parse error.
  }
}

function zeroByteView(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseExecuteExecutionPlanArguments(
  args: readonly unknown[],
): [input: ReturnType<typeof parseExecuteExecutionPlanInput>] {
  requireArgumentCount(args, 1, "execute execution plan input");
  return [parseExecuteExecutionPlanInput(args[0])];
}

function parseExecutionResultRequestArguments(
  args: readonly unknown[],
): [input: ReturnType<typeof parseExecutionResultRequest>] {
  requireArgumentCount(args, 1, "execution result request");
  return [parseExecutionResultRequest(args[0])];
}

function parseSaveExecutionResultArguments(
  args: readonly unknown[],
): [input: ReturnType<typeof parseSaveExecutionResultInput>] {
  requireArgumentCount(args, 1, "save execution result input");
  return [parseSaveExecutionResultInput(args[0])];
}

function parseStartListenerArguments(args: readonly unknown[]): [input: StartListenerRequest] {
  const value = requireRecord(requireSingleArgument(args, "start-listener request"), "start-listener request");
  requireExactKeys(value, ["listener", "addManagedFirewallRule"], "start-listener request");
  return [{
    listener: parseListenerInput(value["listener"]),
    addManagedFirewallRule: requireBooleanProperty(
      value,
      "addManagedFirewallRule",
      "start-listener request",
    ),
  }];
}

function parseJobIdArguments(args: readonly unknown[]): [jobId: number] {
  const value = requireSingleArgument(args, "job ID");
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidArguments("job ID");
  }
  return [value];
}

function parseOpaqueTokenArguments(args: readonly unknown[]): [token: string] {
  const value = requireSingleArgument(args, "operation capability token");
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw invalidArguments("operation capability token");
  return [value];
}

function parseExecuteJobStopPlanArguments(args: readonly unknown[]): [input: ExecuteJobStopPlanInput] {
  const value = requireRecord(requireSingleArgument(args, "job-stop execution input"), "job-stop execution input");
  requireExactKeys(value, ["token", "removeManagedFirewallRule"], "job-stop execution input");
  const [token] = parseOpaqueTokenArguments([value["token"]]);
  return [{
    token,
    removeManagedFirewallRule: requireBooleanProperty(
      value,
      "removeManagedFirewallRule",
      "job-stop execution input",
    ),
  }];
}

function parseGenerateArguments(args: readonly unknown[]): [input: GenerateInput] {
  return [parseGenerateInput(requireSingleArgument(args, "generate input"))];
}

function parseGenerateFromProfileArguments(args: readonly unknown[]): [input: GenerateFromProfileInput] {
  const value = requireRecord(
    requireSingleArgument(args, "generate-from-profile input"),
    "generate-from-profile input",
  );
  requireExactKeys(value, ["profileName", "name"], "generate-from-profile input");
  return [
    {
      profileName: requireStringProperty(value, "profileName", "generate-from-profile input", MAX_SHORT_STRING_LENGTH),
      name: requireStringProperty(value, "name", "generate-from-profile input", MAX_SHORT_STRING_LENGTH),
    },
  ];
}

function parseStringArguments(args: readonly unknown[], label: string): [value: string] {
  const value = requireSingleArgument(args, label);
  if (typeof value !== "string" || value.length > MAX_SHORT_STRING_LENGTH || value.includes("\0")) {
    throw invalidArguments(label);
  }
  return [value];
}

function parseStringArrayArguments(args: readonly unknown[]): [values: string[]] {
  const value = requireSingleArgument(args, "build-name list");
  if (
    !Array.isArray(value) ||
    value.length > MAX_STRING_ARRAY_ITEMS ||
    !value.every(
      (item) => typeof item === "string" && item.length <= MAX_SHORT_STRING_LENGTH && !item.includes("\0"),
    )
  ) {
    throw invalidArguments("build-name list");
  }
  return [[...value]];
}

function parseSaveProfileArguments(args: readonly unknown[]): [input: SaveProfileInput] {
  const value = requireRecord(requireSingleArgument(args, "save-profile input"), "save-profile input");
  requireExactKeys(value, ["profileName", "config", "overwrite"], "save-profile input");
  return [
    {
      profileName: requireStringProperty(value, "profileName", "save-profile input", MAX_SHORT_STRING_LENGTH),
      config: parseGenerateInput(value["config"]),
      overwrite: requireBooleanProperty(value, "overwrite", "save-profile input"),
    },
  ];
}

function parseListenerInput(value: unknown): ListenerInput {
  const input = requireRecord(value, "listener input");
  const kind = requireStringLiteralProperty(input, "kind", LISTENER_KINDS, "listener input");
  const host = requireStringProperty(input, "host", "listener input", MAX_SHORT_STRING_LENGTH);
  const port = requireFiniteNumberProperty(input, "port", "listener input");

  switch (kind) {
    case "mtls":
      requireExactKeys(input, ["kind", "host", "port"], "mTLS listener input");
      return { kind, host, port };
    case "wireguard":
      requireExactKeys(
        input,
        ["kind", "host", "port", "tunnelIp", "tcpCommsPort", "keyExchangePort"],
        "WireGuard listener input",
      );
      return {
        kind,
        host,
        port,
        tunnelIp: requireStringProperty(input, "tunnelIp", "WireGuard listener input", MAX_SHORT_STRING_LENGTH),
        tcpCommsPort: requireFiniteNumberProperty(input, "tcpCommsPort", "WireGuard listener input"),
        keyExchangePort: requireFiniteNumberProperty(input, "keyExchangePort", "WireGuard listener input"),
      };
    case "dns":
      requireExactKeys(input, ["kind", "host", "port", "domains", "canaries", "enforceOtp"], "DNS listener input");
      return {
        kind,
        host,
        port,
        domains: requireStringProperty(input, "domains", "DNS listener input", MAX_LONG_STRING_LENGTH),
        canaries: requireBooleanProperty(input, "canaries", "DNS listener input"),
        enforceOtp: requireBooleanProperty(input, "enforceOtp", "DNS listener input"),
      };
    case "http":
    case "https": {
      requireExactKeys(
        input,
        [
          "kind",
          "host",
          "port",
          "domain",
          "website",
          "enforceOtp",
          "longPollTimeoutSeconds",
          "longPollJitterSeconds",
          "acme",
          "randomizeJarm",
          "certificateToken",
        ],
        "HTTP listener input",
      );
      const certificateToken = requireStringProperty(input, "certificateToken", "HTTP listener input", 36);
      if (certificateToken && !UUID_PATTERN.test(certificateToken)) {
        throw invalidArguments("HTTP listener input.certificateToken");
      }
      return {
        kind,
        host,
        port,
        domain: requireStringProperty(input, "domain", "HTTP listener input", MAX_SHORT_STRING_LENGTH),
        website: requireStringProperty(input, "website", "HTTP listener input", MAX_SHORT_STRING_LENGTH),
        enforceOtp: requireBooleanProperty(input, "enforceOtp", "HTTP listener input"),
        longPollTimeoutSeconds: requireFiniteNumberProperty(
          input,
          "longPollTimeoutSeconds",
          "HTTP listener input",
        ),
        longPollJitterSeconds: requireFiniteNumberProperty(input, "longPollJitterSeconds", "HTTP listener input"),
        acme: requireBooleanProperty(input, "acme", "HTTP listener input"),
        randomizeJarm: requireBooleanProperty(input, "randomizeJarm", "HTTP listener input"),
        certificateToken,
      };
    }
    case "stage":
      requireExactKeys(
        input,
        ["kind", "host", "port", "profileName", "compression", "aesKey", "aesIv", "rc4Key"],
        "stage listener input",
      );
      return {
        kind,
        host,
        port,
        profileName: requireStringProperty(input, "profileName", "stage listener input", MAX_SHORT_STRING_LENGTH),
        compression: requireStringLiteralProperty(
          input,
          "compression",
          STAGE_COMPRESSIONS,
          "stage listener input",
        ),
        aesKey: requireStringProperty(input, "aesKey", "stage listener input", MAX_SHORT_STRING_LENGTH),
        aesIv: requireStringProperty(input, "aesIv", "stage listener input", MAX_SHORT_STRING_LENGTH),
        rc4Key: requireStringProperty(input, "rc4Key", "stage listener input", MAX_SHORT_STRING_LENGTH),
      };
    default:
      return assertNever(kind);
  }
}

function parseGenerateInput(value: unknown): GenerateInput {
  const input = requireRecord(value, "generate input");
  requireExactKeys(
    input,
    [
      "name",
      "implantType",
      "os",
      "arch",
      "format",
      "templateName",
      "c2",
      "connectionStrategy",
      "reconnectSeconds",
      "pollTimeoutSeconds",
      "maxConnectionErrors",
      "beaconIntervalSeconds",
      "beaconJitterSeconds",
      "debug",
      "evasion",
      "obfuscateSymbols",
      "netGo",
      "runAtLoad",
      "exports",
      "canaryDomains",
      "httpC2Profile",
      "wgPeerTunIp",
      "wgKeyExchangePort",
      "wgTcpCommsPort",
      "limitDomainJoined",
      "limitDatetime",
      "limitHostname",
      "limitUsername",
      "limitFileExists",
      "limitLocale",
      "shellcode",
    ],
    "generate input",
  );
  return {
    name: requireStringProperty(input, "name", "generate input", MAX_SHORT_STRING_LENGTH),
    implantType: requireStringLiteralProperty(input, "implantType", IMPLANT_TYPES, "generate input"),
    os: requireStringProperty(input, "os", "generate input", 64),
    arch: requireStringProperty(input, "arch", "generate input", 64),
    format: requireStringLiteralProperty(input, "format", ARTIFACT_FORMATS, "generate input"),
    templateName: requireStringProperty(input, "templateName", "generate input", MAX_SHORT_STRING_LENGTH),
    c2: requireStringProperty(input, "c2", "generate input", MAX_LONG_STRING_LENGTH),
    connectionStrategy: requireStringLiteralProperty(
      input,
      "connectionStrategy",
      CONNECTION_STRATEGIES,
      "generate input",
    ),
    reconnectSeconds: requireFiniteNumberProperty(input, "reconnectSeconds", "generate input"),
    pollTimeoutSeconds: requireFiniteNumberProperty(input, "pollTimeoutSeconds", "generate input"),
    maxConnectionErrors: requireFiniteNumberProperty(input, "maxConnectionErrors", "generate input"),
    beaconIntervalSeconds: requireFiniteNumberProperty(input, "beaconIntervalSeconds", "generate input"),
    beaconJitterSeconds: requireFiniteNumberProperty(input, "beaconJitterSeconds", "generate input"),
    debug: requireBooleanProperty(input, "debug", "generate input"),
    evasion: requireBooleanProperty(input, "evasion", "generate input"),
    obfuscateSymbols: requireBooleanProperty(input, "obfuscateSymbols", "generate input"),
    netGo: requireBooleanProperty(input, "netGo", "generate input"),
    runAtLoad: requireBooleanProperty(input, "runAtLoad", "generate input"),
    exports: requireStringProperty(input, "exports", "generate input", MAX_LONG_STRING_LENGTH),
    canaryDomains: requireStringProperty(input, "canaryDomains", "generate input", MAX_LONG_STRING_LENGTH),
    httpC2Profile: requireStringProperty(input, "httpC2Profile", "generate input", MAX_SHORT_STRING_LENGTH),
    wgPeerTunIp: requireStringProperty(input, "wgPeerTunIp", "generate input", MAX_SHORT_STRING_LENGTH),
    wgKeyExchangePort: requireFiniteNumberProperty(input, "wgKeyExchangePort", "generate input"),
    wgTcpCommsPort: requireFiniteNumberProperty(input, "wgTcpCommsPort", "generate input"),
    limitDomainJoined: requireBooleanProperty(input, "limitDomainJoined", "generate input"),
    limitDatetime: requireStringProperty(input, "limitDatetime", "generate input", MAX_SHORT_STRING_LENGTH),
    limitHostname: requireStringProperty(input, "limitHostname", "generate input", MAX_SHORT_STRING_LENGTH),
    limitUsername: requireStringProperty(input, "limitUsername", "generate input", MAX_SHORT_STRING_LENGTH),
    limitFileExists: requireStringProperty(input, "limitFileExists", "generate input", MAX_LONG_STRING_LENGTH),
    limitLocale: requireStringProperty(input, "limitLocale", "generate input", MAX_SHORT_STRING_LENGTH),
    shellcode: parseShellcodeOptions(input["shellcode"]),
  };
}

function parseShellcodeOptions(value: unknown): GenerateInput["shellcode"] {
  const input = requireRecord(value, "shellcode options");
  requireExactKeys(
    input,
    ["compress", "entropy", "exitOption", "bypass", "headers", "runInThread", "unicode", "originalEntryPoint"],
    "shellcode options",
  );
  return {
    compress: requireBooleanProperty(input, "compress", "shellcode options"),
    entropy: requireNumberLiteralProperty(input, "entropy", SHELLCODE_TRIPLE_OPTIONS, "shellcode options"),
    exitOption: requireNumberLiteralProperty(input, "exitOption", SHELLCODE_TRIPLE_OPTIONS, "shellcode options"),
    bypass: requireNumberLiteralProperty(input, "bypass", SHELLCODE_TRIPLE_OPTIONS, "shellcode options"),
    headers: requireNumberLiteralProperty(input, "headers", SHELLCODE_HEADER_OPTIONS, "shellcode options"),
    runInThread: requireBooleanProperty(input, "runInThread", "shellcode options"),
    unicode: requireBooleanProperty(input, "unicode", "shellcode options"),
    originalEntryPoint: requireFiniteNumberProperty(input, "originalEntryPoint", "shellcode options"),
  };
}

function requireSingleArgument(args: readonly unknown[], label: string): unknown {
  requireArgumentCount(args, 1, label);
  return args[0];
}

function requireArgumentCount(args: readonly unknown[], expected: number, label: string): void {
  if (args.length !== expected) throw invalidArguments(label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidArguments(label);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStringProperty(
  value: Record<string, unknown>,
  key: string,
  label: string,
  maxLength = MAX_LONG_STRING_LENGTH,
): string {
  const property = value[key];
  if (typeof property !== "string" || property.length > maxLength || property.includes("\0")) {
    throw invalidArguments(`${label}.${key}`);
  }
  return property;
}

function requireExactKeys(value: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
  const allowed = new Set(allowedKeys);
  const keys = Object.keys(value);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) throw invalidArguments(label);
}

function requireBooleanProperty(value: Record<string, unknown>, key: string, label: string): boolean {
  const property = value[key];
  if (typeof property !== "boolean") throw invalidArguments(`${label}.${key}`);
  return property;
}

function requireFiniteNumberProperty(value: Record<string, unknown>, key: string, label: string): number {
  const property = value[key];
  if (typeof property !== "number" || !Number.isFinite(property)) throw invalidArguments(`${label}.${key}`);
  return property;
}

function requireStringLiteralProperty<const Literal extends string>(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly Literal[],
  label: string,
): Literal {
  const property = value[key];
  if (!isAllowedString(property, allowed)) throw invalidArguments(`${label}.${key}`);
  return property;
}

function requireNumberLiteralProperty<const Literal extends number>(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly Literal[],
  label: string,
): Literal {
  const property = value[key];
  if (!isAllowedNumber(property, allowed)) throw invalidArguments(`${label}.${key}`);
  return property;
}

function isAllowedString<Literal extends string>(value: unknown, allowed: readonly Literal[]): value is Literal {
  return typeof value === "string" && allowed.some((candidate) => candidate === value);
}

function isAllowedNumber<Literal extends number>(value: unknown, allowed: readonly Literal[]): value is Literal {
  return typeof value === "number" && allowed.some((candidate) => candidate === value);
}

function invalidArguments(label: string): Error {
  return new Error(`Rejected invalid ${label}`);
}

function assertNever(value: never): never {
  throw invalidArguments(`listener kind ${String(value)}`);
}

function scriptArguments<T>(parse: (value: unknown) => T): (args: readonly unknown[]) => [T] {
  return (args) => {
    requireArgumentCount(args, 1, "script input");
    return [parse(args[0])];
  };
}

async function scriptOperation<T>(operation: () => Promise<T>): Promise<OperationResult<T>> {
  try {
    return { ok: true, value: await operation() } as OperationResult<T>;
  } catch (error) {
    return { ok: false, error: error instanceof ScriptStoreError
      ? error.message
      : "The script operation failed. Existing files have been preserved." };
  }
}
