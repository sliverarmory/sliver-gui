import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";

import {
  IPC,
  IPC_INVOKE,
  type GenerateFromProfileInput,
  type GenerateInput,
  type IpcInvokeArgs,
  type IpcInvokeChannel,
  type IpcInvokeResult,
  type ListenerInput,
  type OpenWindowInput,
  type SaveProfileInput,
} from "../shared/contracts.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import { isTrustedRendererUrl } from "./security.js";

interface TrustedSender {
  sender: WebContents;
  contentsId: number;
}

type MaybePromise<T> = T | Promise<T>;
type IpcArgumentParser<Channel extends IpcInvokeChannel> = (
  args: readonly unknown[],
) => IpcInvokeArgs<Channel>;
export type IpcConnectionRegistry = Pick<
  ConnectionRegistry,
  | "chooseAndConnect"
  | "listSavedConfigs"
  | "connectSavedConfig"
  | "disconnect"
  | "snapshot"
  | "refresh"
  | "chooseCertificatePair"
  | "startListener"
  | "killJob"
  | "killAllJobs"
  | "generate"
  | "generateFromProfile"
  | "downloadBuild"
  | "deleteBuild"
  | "setStagedBuilds"
  | "saveProfile"
  | "deleteProfile"
>;

const IMPLANT_TYPES = ["session", "beacon"] as const;
const ARTIFACT_FORMATS = ["executable", "shared", "shellcode", "service", "archive"] as const;
const CONNECTION_STRATEGIES = ["", "s", "r", "rd"] as const;
const LISTENER_KINDS = ["mtls", "wireguard", "dns", "http", "https", "stage"] as const;
const STAGE_COMPRESSIONS = ["none", "zlib", "gzip", "deflate"] as const;
const SHELLCODE_TRIPLE_OPTIONS = [1, 2, 3] as const;
const SHELLCODE_HEADER_OPTIONS = [1, 2] as const;

export function registerIpcHandlers(
  registry: IpcConnectionRegistry,
  createWindow: (inheritFromContentsId?: number) => void,
  rendererUrl: string,
): void {
  handleTrusted(IPC.chooseConfig, rendererUrl, parseNoArguments, ({ sender }) => registry.chooseAndConnect(sender));
  handleTrusted(IPC.listSavedConfigs, rendererUrl, parseNoArguments, ({ contentsId }) =>
    registry.listSavedConfigs(contentsId),
  );
  handleTrusted(IPC.connectSavedConfig, rendererUrl, parseSavedConfigIdArguments, ({ contentsId }, id) =>
    registry.connectSavedConfig(contentsId, id),
  );
  handleTrusted(IPC.disconnect, rendererUrl, parseNoArguments, ({ contentsId }) => registry.disconnect(contentsId));
  handleTrusted(IPC.getSnapshot, rendererUrl, parseNoArguments, ({ contentsId }) => registry.snapshot(contentsId));
  handleTrusted(IPC.refresh, rendererUrl, parseNoArguments, ({ contentsId }) => registry.refresh(contentsId));
  handleTrusted(IPC.openWindow, rendererUrl, parseOpenWindowArguments, ({ contentsId }, input) => {
    createWindow(input.inheritConnection ? contentsId : undefined);
    return { ok: true };
  });
  handleTrusted(IPC.chooseCertificatePair, rendererUrl, parseNoArguments, ({ sender }) =>
    registry.chooseCertificatePair(sender),
  );
  handleTrusted(IPC.startListener, rendererUrl, parseListenerArguments, ({ contentsId }, input) =>
    registry.startListener(contentsId, input),
  );
  handleTrusted(IPC.killJob, rendererUrl, parseJobIdArguments, ({ contentsId }, jobId) =>
    registry.killJob(contentsId, jobId),
  );
  handleTrusted(IPC.killAllJobs, rendererUrl, parseNoArguments, ({ contentsId }) =>
    registry.killAllJobs(contentsId),
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
}

export function unregisterIpcHandlers(): void {
  for (const channel of Object.values(IPC_INVOKE)) ipcMain.removeHandler(channel);
}

export function isTrustedSender(sender: WebContents, rendererUrl: string): boolean {
  try {
    if (sender.isDestroyed() || !BrowserWindow.fromWebContents(sender)) return false;
    return isTrustedRendererUrl(sender.getURL(), rendererUrl);
  } catch {
    return false;
  }
}

function requireTrustedSender(event: IpcMainInvokeEvent, rendererUrl: string): TrustedSender {
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
  return { sender, contentsId: sender.id };
}

function handleTrusted<Channel extends IpcInvokeChannel>(
  channel: Channel,
  rendererUrl: string,
  parseArguments: IpcArgumentParser<Channel>,
  handler: (
    sender: TrustedSender,
    ...args: IpcInvokeArgs<Channel>
  ) => MaybePromise<IpcInvokeResult<Channel>>,
): void {
  ipcMain.handle(channel, (event, ...rawArguments: unknown[]) => {
    const sender = requireTrustedSender(event, rendererUrl);
    const args = parseArguments(rawArguments);
    return handler(sender, ...args);
  });
}

function parseNoArguments(args: readonly unknown[]): [] {
  requireArgumentCount(args, 0, "arguments");
  return [];
}

function parseSavedConfigIdArguments(args: readonly unknown[]): [id: string] {
  const value = requireSingleArgument(args, "saved configuration ID");
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw invalidArguments("saved configuration ID");
  }
  return [value];
}

function parseOpenWindowArguments(args: readonly unknown[]): [input: OpenWindowInput] {
  const value = requireRecord(requireSingleArgument(args, "open-window input"), "open-window input");
  return [{ inheritConnection: requireBooleanProperty(value, "inheritConnection", "open-window input") }];
}

function parseListenerArguments(args: readonly unknown[]): [input: ListenerInput] {
  return [parseListenerInput(requireSingleArgument(args, "listener input"))];
}

function parseJobIdArguments(args: readonly unknown[]): [jobId: number] {
  const value = requireSingleArgument(args, "job ID");
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidArguments("job ID");
  }
  return [value];
}

function parseGenerateArguments(args: readonly unknown[]): [input: GenerateInput] {
  return [parseGenerateInput(requireSingleArgument(args, "generate input"))];
}

function parseGenerateFromProfileArguments(args: readonly unknown[]): [input: GenerateFromProfileInput] {
  const value = requireRecord(
    requireSingleArgument(args, "generate-from-profile input"),
    "generate-from-profile input",
  );
  return [
    {
      profileName: requireStringProperty(value, "profileName", "generate-from-profile input"),
      name: requireStringProperty(value, "name", "generate-from-profile input"),
    },
  ];
}

function parseStringArguments(args: readonly unknown[], label: string): [value: string] {
  const value = requireSingleArgument(args, label);
  if (typeof value !== "string") throw invalidArguments(label);
  return [value];
}

function parseStringArrayArguments(args: readonly unknown[]): [values: string[]] {
  const value = requireSingleArgument(args, "build-name list");
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw invalidArguments("build-name list");
  }
  return [[...value]];
}

function parseSaveProfileArguments(args: readonly unknown[]): [input: SaveProfileInput] {
  const value = requireRecord(requireSingleArgument(args, "save-profile input"), "save-profile input");
  return [
    {
      profileName: requireStringProperty(value, "profileName", "save-profile input"),
      config: parseGenerateInput(value["config"]),
    },
  ];
}

function parseListenerInput(value: unknown): ListenerInput {
  const input = requireRecord(value, "listener input");
  const kind = requireStringLiteralProperty(input, "kind", LISTENER_KINDS, "listener input");
  const host = requireStringProperty(input, "host", "listener input");
  const port = requireFiniteNumberProperty(input, "port", "listener input");

  switch (kind) {
    case "mtls":
      return { kind, host, port };
    case "wireguard":
      return {
        kind,
        host,
        port,
        tunnelIp: requireStringProperty(input, "tunnelIp", "WireGuard listener input"),
        tcpCommsPort: requireFiniteNumberProperty(input, "tcpCommsPort", "WireGuard listener input"),
        keyExchangePort: requireFiniteNumberProperty(input, "keyExchangePort", "WireGuard listener input"),
      };
    case "dns":
      return {
        kind,
        host,
        port,
        domains: requireStringProperty(input, "domains", "DNS listener input"),
        canaries: requireBooleanProperty(input, "canaries", "DNS listener input"),
        enforceOtp: requireBooleanProperty(input, "enforceOtp", "DNS listener input"),
      };
    case "http":
    case "https":
      return {
        kind,
        host,
        port,
        domain: requireStringProperty(input, "domain", "HTTP listener input"),
        website: requireStringProperty(input, "website", "HTTP listener input"),
        enforceOtp: requireBooleanProperty(input, "enforceOtp", "HTTP listener input"),
        longPollTimeoutSeconds: requireFiniteNumberProperty(
          input,
          "longPollTimeoutSeconds",
          "HTTP listener input",
        ),
        longPollJitterSeconds: requireFiniteNumberProperty(input, "longPollJitterSeconds", "HTTP listener input"),
        acme: requireBooleanProperty(input, "acme", "HTTP listener input"),
        randomizeJarm: requireBooleanProperty(input, "randomizeJarm", "HTTP listener input"),
        certificateToken: requireStringProperty(input, "certificateToken", "HTTP listener input"),
      };
    case "stage":
      return {
        kind,
        host,
        port,
        profileName: requireStringProperty(input, "profileName", "stage listener input"),
        compression: requireStringLiteralProperty(
          input,
          "compression",
          STAGE_COMPRESSIONS,
          "stage listener input",
        ),
        aesKey: requireStringProperty(input, "aesKey", "stage listener input"),
        aesIv: requireStringProperty(input, "aesIv", "stage listener input"),
        rc4Key: requireStringProperty(input, "rc4Key", "stage listener input"),
      };
    default:
      return assertNever(kind);
  }
}

function parseGenerateInput(value: unknown): GenerateInput {
  const input = requireRecord(value, "generate input");
  return {
    name: requireStringProperty(input, "name", "generate input"),
    implantType: requireStringLiteralProperty(input, "implantType", IMPLANT_TYPES, "generate input"),
    os: requireStringProperty(input, "os", "generate input"),
    arch: requireStringProperty(input, "arch", "generate input"),
    format: requireStringLiteralProperty(input, "format", ARTIFACT_FORMATS, "generate input"),
    templateName: requireStringProperty(input, "templateName", "generate input"),
    c2: requireStringProperty(input, "c2", "generate input"),
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
    exports: requireStringProperty(input, "exports", "generate input"),
    canaryDomains: requireStringProperty(input, "canaryDomains", "generate input"),
    httpC2Profile: requireStringProperty(input, "httpC2Profile", "generate input"),
    wgPeerTunIp: requireStringProperty(input, "wgPeerTunIp", "generate input"),
    wgKeyExchangePort: requireFiniteNumberProperty(input, "wgKeyExchangePort", "generate input"),
    wgTcpCommsPort: requireFiniteNumberProperty(input, "wgTcpCommsPort", "generate input"),
    limitDomainJoined: requireBooleanProperty(input, "limitDomainJoined", "generate input"),
    limitDatetime: requireStringProperty(input, "limitDatetime", "generate input"),
    limitHostname: requireStringProperty(input, "limitHostname", "generate input"),
    limitUsername: requireStringProperty(input, "limitUsername", "generate input"),
    limitFileExists: requireStringProperty(input, "limitFileExists", "generate input"),
    limitLocale: requireStringProperty(input, "limitLocale", "generate input"),
    shellcode: parseShellcodeOptions(input["shellcode"]),
  };
}

function parseShellcodeOptions(value: unknown): GenerateInput["shellcode"] {
  const input = requireRecord(value, "shellcode options");
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

function requireStringProperty(value: Record<string, unknown>, key: string, label: string): string {
  const property = value[key];
  if (typeof property !== "string") throw invalidArguments(`${label}.${key}`);
  return property;
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
