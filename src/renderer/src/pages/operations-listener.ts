import type {
  ListenerInput,
  StageCompression,
} from "../../../shared/contracts";

export type ListenerKind = ListenerInput["kind"];

export interface ListenerDraft {
  kind: ListenerKind;
  host: string;
  port: number;
  tunnelIp: string;
  tcpCommsPort: number;
  keyExchangePort: number;
  domains: string;
  canaries: boolean;
  enforceOtp: boolean;
  domain: string;
  website: string;
  longPollTimeoutSeconds: number;
  longPollJitterSeconds: number;
  acme: boolean;
  randomizeJarm: boolean;
  certificateToken: string;
  profileName: string;
  compression: StageCompression;
  aesKey: string;
  aesIv: string;
  rc4Key: string;
}

export type ListenerDraftErrors = Partial<Record<keyof ListenerDraft | "form", string>>;

export interface ListenerProtocolDefinition {
  id: ListenerKind;
  label: string;
  shortLabel: string;
  description: string;
}

export const LISTENER_PROTOCOL_BY_KIND = {
  mtls: {
    id: "mtls",
    label: "Mutual TLS",
    shortLabel: "mTLS",
    description: "Authenticated Sliver transport over mutual TLS.",
  },
  wireguard: {
    id: "wireguard",
    label: "WireGuard",
    shortLabel: "WG",
    description: "WireGuard transport with dedicated key exchange and TCP channels.",
  },
  dns: {
    id: "dns",
    label: "DNS",
    shortLabel: "DNS",
    description: "DNS tunneling for one or more authoritative domains.",
  },
  http: {
    id: "http",
    label: "HTTP",
    shortLabel: "HTTP",
    description: "HTTP C2 listener with website and long-poll controls.",
  },
  https: {
    id: "https",
    label: "HTTPS",
    shortLabel: "HTTPS",
    description: "TLS HTTP C2 with ACME, certificate, and JARM controls.",
  },
  stage: {
    id: "stage",
    label: "TCP stage",
    shortLabel: "TCP",
    description: "Generate a profile payload and serve it as a size-prefixed TCP stage.",
  },
} as const satisfies Record<ListenerKind, ListenerProtocolDefinition>;

const LISTENER_PROTOCOL_ORDER = [
  "mtls",
  "wireguard",
  "dns",
  "http",
  "https",
  "stage",
] as const satisfies readonly ListenerKind[];

export const LISTENER_PROTOCOLS: readonly ListenerProtocolDefinition[] = LISTENER_PROTOCOL_ORDER.map(
  (kind) => LISTENER_PROTOCOL_BY_KIND[kind],
);

export const STAGE_COMPRESSION_OPTIONS = [
  { id: "none", label: "None" },
  { id: "zlib", label: "Zlib" },
  { id: "gzip", label: "Gzip" },
  { id: "deflate", label: "Deflate level 9" },
] as const satisfies readonly { id: StageCompression; label: string }[];

export function isListenerKind(value: unknown): value is ListenerKind {
  return typeof value === "string" && Object.hasOwn(LISTENER_PROTOCOL_BY_KIND, value);
}

export function isStageCompression(value: unknown): value is StageCompression {
  return typeof value === "string" && STAGE_COMPRESSION_OPTIONS.some((option) => option.id === value);
}

export function createListenerDraft(kind: ListenerKind = "mtls", profileName = ""): ListenerDraft {
  const defaultPorts: Record<ListenerKind, number> = {
    dns: 53,
    http: 80,
    https: 443,
    mtls: 8888,
    stage: 8443,
    wireguard: 53,
  };

  return {
    kind,
    host: "0.0.0.0",
    port: defaultPorts[kind],
    tunnelIp: "100.64.0.1",
    tcpCommsPort: 8888,
    keyExchangePort: 1337,
    domains: "",
    canaries: true,
    enforceOtp: true,
    domain: "",
    website: "",
    longPollTimeoutSeconds: 1,
    longPollJitterSeconds: 2,
    acme: false,
    randomizeJarm: kind === "https",
    certificateToken: "",
    profileName,
    compression: "none",
    aesKey: "",
    aesIv: "",
    rc4Key: "",
  };
}

export function validateListenerDraft(draft: ListenerDraft): ListenerDraftErrors {
  const errors: ListenerDraftErrors = {};

  if (!draft.host.trim() || containsControlCharacter(draft.host)) {
    errors.host = "Enter a valid bind host or address.";
  }
  if (!isValidPort(draft.port)) {
    errors.port = "Use a whole number from 1 to 65535.";
  }

  switch (draft.kind) {
    case "wireguard": {
      if (!isIpv4Address(draft.tunnelIp.trim())) {
        errors.tunnelIp = "Enter an IPv4 tunnel address, such as 100.64.0.1.";
      }
      if (!isValidPort(draft.tcpCommsPort)) {
        errors.tcpCommsPort = "Use a whole number from 1 to 65535.";
      }
      if (!isValidPort(draft.keyExchangePort)) {
        errors.keyExchangePort = "Use a whole number from 1 to 65535.";
      }
      if (
        isValidPort(draft.tcpCommsPort) &&
        isValidPort(draft.keyExchangePort) &&
        draft.tcpCommsPort === draft.keyExchangePort
      ) {
        errors.keyExchangePort = "Key exchange and TCP comms need different ports.";
      }
      break;
    }
    case "dns": {
      const domains = splitDomains(draft.domains);
      if (domains.length === 0) {
        errors.domains = "Add at least one authoritative domain.";
      } else if (domains.some((domain) => !isDnsName(domain))) {
        errors.domains = "Use comma-separated DNS names, for example corp.example.com.";
      }
      break;
    }
    case "http":
    case "https": {
      if (draft.domain.trim() && !isDnsName(draft.domain)) {
        errors.domain = "Enter a valid domain name or leave this empty.";
      }
      if (!isNonNegativeWholeNumber(draft.longPollTimeoutSeconds)) {
        errors.longPollTimeoutSeconds = "Use a non-negative whole number.";
      }
      if (!isNonNegativeWholeNumber(draft.longPollJitterSeconds)) {
        errors.longPollJitterSeconds = "Use a non-negative whole number.";
      }
      if (draft.kind === "https" && draft.acme && !draft.domain.trim()) {
        errors.domain = "ACME requires a domain name.";
      }
      if (draft.kind === "https" && draft.acme && draft.certificateToken) {
        errors.certificateToken = "Choose ACME or a certificate pair, not both.";
      }
      break;
    }
    case "stage": {
      if (!draft.profileName.trim()) {
        errors.profileName = "Choose an implant profile for the stage payload.";
      }
      const aesBytes = utf8Length(draft.aesKey);
      const ivBytes = utf8Length(draft.aesIv);
      const rc4Bytes = utf8Length(draft.rc4Key);

      if (draft.aesKey && draft.rc4Key) {
        errors.form = "AES and RC4 encryption cannot be enabled together.";
      }
      if (draft.aesKey && aesBytes !== 16 && aesBytes !== 32) {
        errors.aesKey = "AES key must be exactly 16 or 32 UTF-8 bytes.";
      }
      if (draft.aesIv && !draft.aesKey) {
        errors.aesIv = "An AES IV requires an AES key.";
      } else if (draft.aesIv && ivBytes !== 16) {
        errors.aesIv = "AES IV must be exactly 16 UTF-8 bytes.";
      }
      if (draft.rc4Key && (rc4Bytes < 1 || rc4Bytes > 256)) {
        errors.rc4Key = "RC4 key must be between 1 and 256 UTF-8 bytes.";
      }
      break;
    }
    case "mtls":
      break;
  }

  return errors;
}

export function listenerInputFromDraft(draft: ListenerDraft): ListenerInput {
  const host = draft.host.trim();

  switch (draft.kind) {
    case "mtls":
      return { kind: "mtls", host, port: draft.port };
    case "wireguard":
      return {
        kind: "wireguard",
        host,
        port: draft.port,
        tunnelIp: draft.tunnelIp.trim(),
        tcpCommsPort: draft.tcpCommsPort,
        keyExchangePort: draft.keyExchangePort,
      };
    case "dns":
      return {
        kind: "dns",
        host,
        port: draft.port,
        domains: splitDomains(draft.domains).join(", "),
        canaries: draft.canaries,
        enforceOtp: draft.enforceOtp,
      };
    case "http":
    case "https":
      return {
        kind: draft.kind,
        host,
        port: draft.port,
        domain: trimTrailingDot(draft.domain.trim()),
        website: draft.website.trim(),
        enforceOtp: draft.enforceOtp,
        longPollTimeoutSeconds: draft.longPollTimeoutSeconds,
        longPollJitterSeconds: draft.longPollJitterSeconds,
        acme: draft.kind === "https" && draft.acme,
        randomizeJarm: draft.kind === "https" && draft.randomizeJarm,
        certificateToken: draft.kind === "https" ? draft.certificateToken : "",
      };
    case "stage":
      return {
        kind: "stage",
        host,
        port: draft.port,
        profileName: draft.profileName.trim(),
        compression: draft.compression,
        aesKey: draft.aesKey,
        aesIv: draft.aesIv,
        rc4Key: draft.rc4Key,
      };
  }
}

function splitDomains(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((domain) => domain.trim())
    .filter(Boolean);
}

function trimTrailingDot(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function isDnsName(value: string): boolean {
  const normalized = trimTrailingDot(value.trim());
  if (!normalized || normalized.length > 253 || containsControlCharacter(normalized)) return false;
  const labels = normalized.split(".");
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

function isIpv4Address(value: string): boolean {
  const octets = value.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
  );
}

function isValidPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function isNonNegativeWholeNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}
