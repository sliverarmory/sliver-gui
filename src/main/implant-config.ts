import { clientpb } from "sliver-script";

import type { ArtifactFormat, GenerateInput } from "../shared/contracts.js";
import {
  ensureTrailingDot,
  firstGenerateInputError,
  parseGenerateC2Endpoints,
  secondsToNanoseconds,
  splitList,
  validateGenerateInput,
} from "../shared/generate-validation.js";

export {
  ensureTrailingDot,
  isValidPort,
  normalizeProfileName,
  secondsToNanoseconds,
  splitList,
  validateImplantName,
} from "../shared/generate-validation.js";

export function parseC2Endpoints(raw: string, targetOs: string): clientpb.ImplantC2[] {
  return parseGenerateC2Endpoints(raw, targetOs).map(({ priority, url }) =>
    clientpb.ImplantC2.create({ Priority: priority, URL: url, Options: "" }),
  );
}

export function artifactFormatFromProto(format: clientpb.OutputFormat): ArtifactFormat {
  switch (format) {
    case clientpb.OutputFormat.SHARED_LIB:
      return "shared";
    case clientpb.OutputFormat.SHELLCODE:
      return "shellcode";
    case clientpb.OutputFormat.SERVICE:
      return "service";
    case clientpb.OutputFormat.GO_ARCHIVE:
      return "archive";
    case clientpb.OutputFormat.EXECUTABLE:
    default:
      return "executable";
  }
}

export function artifactFormatToProto(format: ArtifactFormat): clientpb.OutputFormat {
  switch (format) {
    case "shared":
      return clientpb.OutputFormat.SHARED_LIB;
    case "shellcode":
      return clientpb.OutputFormat.SHELLCODE;
    case "service":
      return clientpb.OutputFormat.SERVICE;
    case "archive":
      return clientpb.OutputFormat.GO_ARCHIVE;
    case "executable":
      return clientpb.OutputFormat.EXECUTABLE;
  }
}

export function buildImplantConfig(input: GenerateInput, wireGuardPeerIp = ""): clientpb.ImplantConfig {
  const validationError = firstGenerateInputError(validateGenerateInput(input));
  if (validationError) throw new Error(validationError);

  const os = input.os.trim().toLowerCase();
  const arch = input.arch.trim().toLowerCase();
  const c2 = parseC2Endpoints(input.c2, os);

  const protocols = new Set(c2.map((endpoint) => new URL(endpoint.URL).protocol));
  const canaryDomains = splitList(input.canaryDomains).map(ensureTrailingDot);
  const exports = splitList(input.exports);

  const format = artifactFormatToProto(input.format);
  return clientpb.ImplantConfig.create({
    ID: "",
    ImplantBuilds: [],
    ImplantProfileID: "",
    IsBeacon: input.implantType === "beacon",
    BeaconInterval:
      input.implantType === "beacon"
        ? secondsToNanoseconds(input.beaconIntervalSeconds, "Beacon interval")
        : "0",
    BeaconJitter:
      input.implantType === "beacon"
        ? secondsToNanoseconds(input.beaconJitterSeconds, "Beacon jitter")
        : "0",
    GOOS: os,
    GOARCH: arch,
    Debug: input.debug,
    Evasion: input.evasion,
    ObfuscateSymbols: input.obfuscateSymbols && !input.debug,
    TemplateName: input.templateName.trim() || "sliver",
    SGNEnabled: false,
    GoPackage: "",
    IncludeMTLS: protocols.has("mtls:"),
    IncludeHTTP: protocols.has("http:") || protocols.has("https:"),
    IncludeWG: protocols.has("wg:"),
    IncludeDNS: protocols.has("dns:"),
    IncludeNamePipe: protocols.has("namedpipe:"),
    IncludeTCP: protocols.has("tcppivot:"),
    WGPeerTunIP: wireGuardPeerIp || input.wgPeerTunIp.trim(),
    WGKeyExchangePort: input.wgKeyExchangePort,
    WGTcpCommsPort: input.wgTcpCommsPort,
    ReconnectInterval: secondsToNanoseconds(input.reconnectSeconds, "Reconnect interval"),
    MaxConnectionErrors: input.maxConnectionErrors,
    PollTimeout: secondsToNanoseconds(input.pollTimeoutSeconds, "Poll timeout"),
    C2: c2,
    CanaryDomains: canaryDomains,
    ConnectionStrategy: input.connectionStrategy,
    LimitDomainJoined: input.limitDomainJoined,
    LimitDatetime: input.limitDatetime.trim(),
    LimitHostname: input.limitHostname.trim(),
    LimitUsername: input.limitUsername.trim(),
    LimitFileExists: input.limitFileExists.trim(),
    LimitLocale: input.limitLocale.trim(),
    Format: format,
    IsSharedLib: input.format === "shared" || input.format === "archive",
    IsService: input.format === "service",
    IsShellcode: input.format === "shellcode",
    RunAtLoad: input.runAtLoad && input.format === "shared",
    DebugFile: "",
    exports,
    ShellcodeConfig:
      input.format === "shellcode"
        ? clientpb.ShellcodeConfig.create({
            Entropy: input.shellcode.entropy,
            Compress: input.shellcode.compress ? 2 : 1,
            ExitOpt: input.shellcode.exitOption,
            Bypass: input.shellcode.bypass,
            Headers: input.shellcode.headers,
            Thread: input.shellcode.runInThread,
            Unicode: input.shellcode.unicode,
            OEP: input.shellcode.originalEntryPoint,
          })
        : undefined,
    ShellcodeEncoder: clientpb.ShellcodeEncoder.NONE,
    HTTPC2ConfigName: input.httpC2Profile.trim() || "default",
    NetGoEnabled: input.netGo,
    TrafficEncodersEnabled: false,
    TrafficEncoders: [],
    Extension: "",
    Assets: [],
  });
}
