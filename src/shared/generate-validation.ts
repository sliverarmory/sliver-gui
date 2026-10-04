import { DEFAULT_C2_SCHEME, type ArtifactFormat, type GenerateInput } from "./contracts.js";

const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const DEFAULT_PORTS: Readonly<Record<string, string>> = Object.freeze({
  "mtls:": "8888",
  "wg:": "53",
  "tcppivot:": "9898",
});
const ALLOWED_C2_PROTOCOLS = new Set([
  "mtls:",
  "wg:",
  "http:",
  "https:",
  "dns:",
  "namedpipe:",
  "tcppivot:",
]);

export type GenerateInputErrorField = keyof GenerateInput | "target";
export type GenerateInputErrors = Partial<Record<GenerateInputErrorField, string>>;

export interface ParsedGenerateC2Endpoint {
  priority: number;
  url: string;
}

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

export function parseGenerateC2Endpoints(raw: string, targetOs: string): ParsedGenerateC2Endpoint[] {
  const values = splitList(raw);
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

    return { priority, url: url.toString() };
  });
}

export function validateGenerateInput(input: GenerateInput): GenerateInputErrors {
  const errors: GenerateInputErrors = {};
  const os = input.os.trim().toLowerCase();
  const arch = input.arch.trim().toLowerCase();

  if (!os || !arch) {
    errors.target = "Target OS and architecture are required";
  }

  captureError(errors, "name", () => validateImplantName(input.name));

  if (!isValidPort(input.wgKeyExchangePort)) {
    errors.wgKeyExchangePort = "WireGuard key exchange port must be between 1 and 65535";
  }
  if (!isValidPort(input.wgTcpCommsPort)) {
    errors.wgTcpCommsPort = "WireGuard TCP communications port must be between 1 and 65535";
  }
  if (!Number.isSafeInteger(input.maxConnectionErrors) || input.maxConnectionErrors < 0) {
    errors.maxConnectionErrors = "Maximum connection errors must be a non-negative whole number";
  }

  if (input.implantType === "beacon") {
    if (input.beaconIntervalSeconds < 5) {
      errors.beaconIntervalSeconds = "Beacon interval must be at least 5 seconds";
    }
    if (input.beaconJitterSeconds > input.beaconIntervalSeconds) {
      errors.beaconJitterSeconds = "Beacon jitter cannot exceed the beacon interval";
    }
  }

  captureError(errors, "reconnectSeconds", () =>
    secondsToNanoseconds(input.reconnectSeconds, "Reconnect interval"));
  captureError(errors, "pollTimeoutSeconds", () =>
    secondsToNanoseconds(input.pollTimeoutSeconds, "Poll timeout"));
  captureError(errors, "c2", () => parseGenerateC2Endpoints(input.c2, os));

  if (!errors.target) {
    captureError(errors, "target", () => validateFormatTarget(input.format, os, arch));
  }

  if ((input.format === "shared" || input.format === "archive") && splitList(input.exports).length === 0) {
    errors.exports = "Shared libraries and Go archives require at least one export";
  }

  if (input.implantType === "beacon") {
    captureError(errors, "beaconIntervalSeconds", () =>
      secondsToNanoseconds(input.beaconIntervalSeconds, "Beacon interval"));
    captureError(errors, "beaconJitterSeconds", () =>
      secondsToNanoseconds(input.beaconJitterSeconds, "Beacon jitter"));
  }

  if (
    input.format === "shellcode" &&
    (!Number.isSafeInteger(input.shellcode.originalEntryPoint) || input.shellcode.originalEntryPoint < 0)
  ) {
    errors.shellcode = "Original entry point must be a non-negative whole number";
  }

  return errors;
}

/**
 * Validation records errors in the same order that implant configuration
 * construction applies its checks. Object property insertion order is stable,
 * so this remains deterministic while the complete map is available to forms.
 */
export function firstGenerateInputError(errors: GenerateInputErrors): string | undefined {
  return Object.values(errors).find((message): message is string => typeof message === "string");
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
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

function captureError(
  errors: GenerateInputErrors,
  field: GenerateInputErrorField,
  validate: () => unknown,
): void {
  if (errors[field]) return;
  try {
    validate();
  } catch (error) {
    errors[field] = error instanceof Error ? error.message : "Invalid generation configuration";
  }
}

function normalizeC2Input(value: string): string {
  let normalized = value.trim();
  if (/^tcp-pivot:\/\//i.test(normalized)) normalized = normalized.replace(/^tcp-pivot:/i, "tcppivot:");
  if (/^namedpipe:\/\//i.test(normalized)) normalized = normalized.replaceAll("\\", "/");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) normalized = `${DEFAULT_C2_SCHEME}://${normalized}`;
  return normalized;
}

function validateFormatTarget(format: ArtifactFormat, os: string, arch: string): void {
  if (format !== "shellcode") return;
  const supported =
    (os === "windows" && (arch === "amd64" || arch === "386")) ||
    (os === "darwin" && arch === "arm64") ||
    (os === "linux" && (arch === "amd64" || arch === "arm64"));
  if (!supported) throw new Error(`Shellcode output is not supported for ${os}/${arch}`);
}
