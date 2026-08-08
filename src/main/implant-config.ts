import { clientpb } from "sliver-script";

import type { ArtifactFormat, GenerateInput } from "../shared/contracts.js";

const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const DEFAULT_PORTS: Record<string, string> = {
  "mtls:": "8888",
  "wg:": "53",
  "tcppivot:": "9898",
};
const ALLOWED_C2_PROTOCOLS = new Set(["mtls:", "wg:", "http:", "https:", "dns:", "namedpipe:", "tcppivot:"]);

export function validateImplantName(name: string, label = "Implant name"): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === "") return "";
  if (!/^[\p{L}\p{N}._-]+$/u.test(normalized)) {
    throw new Error(`${label} must be alphanumeric or use '.', '-', and '_' only`);
  }
  if (normalized === "." || normalized.startsWith("..")) {
    throw new Error(`${label} cannot be '.', '..', or start with '..'`);
  }
  return normalized;
}

export function normalizeProfileName(name: string): string {
  const normalized = validateImplantName(name, "Profile name");
  if (!normalized) throw new Error("Profile name is required");
  return normalized;
}

export function secondsToNanoseconds(seconds: number, label: string): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error(`${label} must be a non-negative whole number of seconds`);
  }
  return (BigInt(seconds) * NANOSECONDS_PER_SECOND).toString();
}

export function parseC2Endpoints(raw: string, targetOs: string): clientpb.ImplantC2[] {
  const values = raw
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) throw new Error("At least one C2 endpoint is required");

  return values.map((value, priority) => {
    const normalizedInput = normalizeC2Input(value);
    let url: URL;
    try {
      url = new URL(normalizedInput);
    } catch {
      throw new Error(`Invalid C2 endpoint: ${value}`);
    }

    if (!ALLOWED_C2_PROTOCOLS.has(url.protocol)) {
      throw new Error(`Unsupported C2 protocol '${url.protocol.replace(":", "")}'`);
    }
    if (!url.hostname) throw new Error(`C2 endpoint requires a host: ${value}`);
    if (url.port && !isValidPort(Number(url.port))) throw new Error(`Invalid C2 port in '${value}'`);

    if (url.protocol === "namedpipe:") {
      if (targetOs !== "windows") throw new Error("Named pipe C2 is supported only for Windows targets");
      if (!url.pathname.toLowerCase().startsWith("/pipe/")) {
        throw new Error("Named pipe endpoints must include a /pipe/ path");
      }
    }

    const defaultPort = DEFAULT_PORTS[url.protocol];
    if (defaultPort && !url.port) url.port = defaultPort;

    return clientpb.ImplantC2.create({ Priority: priority, URL: url.toString(), Options: "" });
  });
}

function normalizeC2Input(value: string): string {
  let normalized = value.trim();
  if (/^tcp-pivot:\/\//i.test(normalized)) normalized = normalized.replace(/^tcp-pivot:/i, "tcppivot:");
  if (/^namedpipe:\/\//i.test(normalized)) normalized = normalized.replaceAll("\\", "/");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) normalized = `mtls://${normalized}`;
  return normalized;
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
  const os = input.os.trim().toLowerCase();
  const arch = input.arch.trim().toLowerCase();
  if (!os || !arch) throw new Error("Target OS and architecture are required");

  validateImplantName(input.name);
  validateGenerateNumbers(input);
  const c2 = parseC2Endpoints(input.c2, os);
  validateFormatTarget(input.format, os, arch);

  const protocols = new Set(c2.map((endpoint) => new URL(endpoint.URL).protocol));
  const canaryDomains = splitList(input.canaryDomains).map(ensureTrailingDot);
  const exports = splitList(input.exports);
  if ((input.format === "shared" || input.format === "archive") && exports.length === 0) {
    throw new Error("Shared libraries and Go archives require at least one export");
  }

  const format = artifactFormatToProto(input.format);
  return clientpb.ImplantConfig.create({
    ID: "",
    ImplantBuilds: [],
    ImplantProfileID: "",
    IsBeacon: input.implantType === "beacon",
    BeaconInterval: secondsToNanoseconds(input.beaconIntervalSeconds, "Beacon interval"),
    BeaconJitter: secondsToNanoseconds(input.beaconJitterSeconds, "Beacon jitter"),
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

function validateGenerateNumbers(input: GenerateInput): void {
  const ports = [
    [input.wgKeyExchangePort, "WireGuard key exchange port"],
    [input.wgTcpCommsPort, "WireGuard TCP communications port"],
  ] as const;
  for (const [value, label] of ports) {
    if (!isValidPort(value)) throw new Error(`${label} must be between 1 and 65534`);
  }
  if (!Number.isSafeInteger(input.maxConnectionErrors) || input.maxConnectionErrors < 0) {
    throw new Error("Maximum connection errors must be a non-negative whole number");
  }
  if (input.implantType === "beacon" && input.beaconIntervalSeconds < 5) {
    throw new Error("Beacon interval must be at least 5 seconds");
  }
  if (input.beaconJitterSeconds > input.beaconIntervalSeconds) {
    throw new Error("Beacon jitter cannot exceed the beacon interval");
  }
  secondsToNanoseconds(input.reconnectSeconds, "Reconnect interval");
  secondsToNanoseconds(input.pollTimeoutSeconds, "Poll timeout");
}

function validateFormatTarget(format: ArtifactFormat, os: string, arch: string): void {
  if (format !== "shellcode") return;
  const supported =
    (os === "windows" && (arch === "amd64" || arch === "386")) ||
    (os === "darwin" && arch === "arm64") ||
    (os === "linux" && (arch === "amd64" || arch === "arm64"));
  if (!supported) throw new Error(`Shellcode output is not supported for ${os}/${arch}`);
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_534;
}

export function splitList(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function ensureTrailingDot(domain: string): string {
  return domain.endsWith(".") ? domain : `${domain}.`;
}
