import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";

import {
  IPC,
  IPC_INVOKE,
  type GenerateFromProfileInput,
  type GenerateInput,
  type ImportConfigInput,
  type IpcInvokeArgs,
  type IpcInvokeChannel,
  type IpcInvokeResult,
  type ListenerInput,
  type OpenWindowInput,
  type RemoveSavedConfigInput,
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

export function registerIpcHandlers(
  registry: IpcConnectionRegistry,
  createWindow: (inheritFromContentsId?: number) => void,
  rendererUrl: string,
): void {
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
  handleTrusted(IPC.prepareStopJob, rendererUrl, parseJobIdArguments, ({ contentsId }, jobId) =>
    registry.prepareStopJob(contentsId, jobId),
  );
  handleTrusted(IPC.prepareStopAllJobs, rendererUrl, parseNoArguments, ({ contentsId }) =>
    registry.prepareStopAllJobs(contentsId),
  );
  handleTrusted(IPC.executeStopPlan, rendererUrl, parseOpaqueTokenArguments, ({ contentsId }, token) =>
    registry.executeStopPlan(contentsId, token),
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

function parseOpaqueTokenArguments(args: readonly unknown[]): [token: string] {
  const value = requireSingleArgument(args, "operation capability token");
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw invalidArguments("operation capability token");
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
